import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  openDatabase,
  applyPragmas,
  quoteFtsQuery,
  type AnyDatabase,
} from "../lib/sqlite.ts";

/**
 * tool-audit
 *
 * Flight recorder for tool calls. Records every `tool.execute.before/after`
 * pair (tool, args, status, duration, error) into a local SQLite database and
 * exposes it through trace_query / trace_stats / trace_export so you can see
 * what an agent actually ran.
 *
 * v2-only: `tool.hook("execute.before" | "execute.after")` did not exist in v1.
 */

const DEFAULT_DIR = join(homedir(), ".opencode-plugins", "tool-audit");
const DB_NAME = "tool-audit.db";
const AUDIT_TOOLS = ["trace_query", "trace_stats", "trace_export", "trace_sessions"];

type Config = {
  dir: string;
  enabled: boolean;
  redact: boolean;
  maxInputChars: number;
  retentionDays: number;
  ignoreTools: Set<string>;
};

type Pending = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  /** Event id — stored as call_id so redelivered events can't double-record (T2). */
  callId: string;
  input: unknown;
  startedMs: number;
};

let db: AnyDatabase | null = null;
const pending = new Map<string, Pending>();

function resolveConfig(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {};
  const env = (key: string): string | undefined => process.env[key];
  const asList = (value: unknown, envValue?: string): string[] => {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    if (typeof envValue === "string" && envValue.trim()) {
      return envValue.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };
  const num = (value: unknown, envValue: string | undefined, fallback: number): number => {
    const raw = typeof value === "number" || typeof value === "string" ? value : envValue;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (value: unknown, envValue: string | undefined, fallback: boolean): boolean => {
    if (typeof value === "boolean") return value;
    if (typeof envValue === "string") return /^(1|true|yes|on)$/i.test(envValue.trim());
    return fallback;
  };

  return {
    dir:
      typeof o.dir === "string" && o.dir
        ? o.dir
        : env("OPENCODE_TOOL_AUDIT_DIR") || DEFAULT_DIR,
    enabled: bool(o.enabled, env("OPENCODE_TOOL_AUDIT_ENABLED"), true),
    redact: bool(o.redact, env("OPENCODE_TOOL_AUDIT_REDACT"), true),
    maxInputChars: Math.max(
      100,
      Math.trunc(num(o.maxInputChars, env("OPENCODE_TOOL_AUDIT_MAX_INPUT_CHARS"), 2000)),
    ),
    retentionDays: Math.max(
      0,
      Math.trunc(num(o.retentionDays, env("OPENCODE_TOOL_AUDIT_RETENTION_DAYS"), 30)),
    ),
    ignoreTools: new Set([
      "todowrite",
      ...AUDIT_TOOLS,
      ...asList(o.ignoreTools, env("OPENCODE_TOOL_AUDIT_IGNORE")),
    ]),
  };
}

/** Length of a value without serializing unbounded outputs (T11 helper). */
function safeLen(value: unknown, cap: number): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return String(value).length;
  try {
    let n = 0;
    const visit = (node: unknown, depth: number): boolean => {
      if (n > cap || depth > 6) return false;
      if (typeof node === "string") {
        n += node.length;
        return n <= cap;
      }
      if (Array.isArray(node)) {
        for (const item of node) if (!visit(item, depth + 1)) return false;
        return true;
      }
      if (node && typeof node === "object") {
        for (const v of Object.values(node)) if (!visit(v, depth + 1)) return false;
      }
      return true;
    };
    visit(value, 0);
    return n;
  } catch {
    return cap;
  }
}

/** Redact obvious secrets before anything touches disk. */
function redact(text: string): string {
  let out = text;
  const plain = [
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];
  for (const re of plain) out = out.replace(re, "[redacted]");
  out = out.replace(
    /("?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|authorization)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
    "$1[redacted]",
  );
  return out;
}

function serializeInput(input: unknown, cfg: Config): string {
  let text: string;
  try {
    text = JSON.stringify(input, (_key, value) => {
      if (typeof value === "string") {
        // T4: redact BEFORE any slicing — a secret split by a cap could
        // otherwise leak its prefix.
        const safe = cfg.redact ? redact(value) : value;
        return safe.length > 500 ? safe.slice(0, 500) + `…(+${safe.length - 500})` : safe;
      }
      return value;
    });
    if (text === undefined) text = String(input);
  } catch {
    text = String(input);
  }
  if (cfg.redact) text = redact(text);
  if (text.length > cfg.maxInputChars) {
    text = text.slice(0, cfg.maxInputChars) + `…[truncated ${text.length - cfg.maxInputChars}]`;
  }
  return text;
}

function getDb(cfg: Config): AnyDatabase {
  if (!db) {
    db = openDatabase(join(cfg.dir, DB_NAME));
    applyPragmas(db);
    initSchema(db);
  }
  return db;
}

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      agent TEXT,
      message_id TEXT,
      call_id TEXT,
      tool TEXT NOT NULL,
      input TEXT,
      status TEXT,
      error TEXT,
      output_chars INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      started_ms INTEGER NOT NULL,
      duration_ms INTEGER
    )
  `);

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, started_ms)",
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool)");
  // T5: unfiltered time-range scans previously full-scanned the table.
  database.exec("CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_ms)");
  // T2: idempotency — a redelivered execute.after must not double-record.
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_callid ON calls(call_id) WHERE call_id IS NOT NULL",
  );

  const row = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='calls_fts'")
    .get() as { name: string } | null;

  if (!row) {
    database.exec(`
      CREATE VIRTUAL TABLE calls_fts USING fts5(
        tool,
        input,
        error,
        content=calls,
        content_rowid=id,
        tokenize='porter'
      )
    `);

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS calls_ai AFTER INSERT ON calls BEGIN
        INSERT INTO calls_fts(rowid, tool, input, error)
        VALUES (new.id, new.tool, COALESCE(new.input, ''), COALESCE(new.error, ''));
      END
    `);

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS calls_ad AFTER DELETE ON calls BEGIN
        INSERT INTO calls_fts(calls_fts, rowid, tool, input, error)
        VALUES ('delete', old.id, old.tool, COALESCE(old.input, ''), COALESCE(old.error, ''));
      END
    `);

    database.exec(`
      INSERT INTO calls_fts(rowid, tool, input, error)
      SELECT id, tool, COALESCE(input, ''), COALESCE(error, '') FROM calls
    `);
  }
}

function prune(database: AnyDatabase, cfg: Config): void {
  if (cfg.retentionDays <= 0) return;
  const cutoff = Date.now() - cfg.retentionDays * 86_400_000;
  database.prepare("DELETE FROM calls WHERE started_ms < ?").run(cutoff);
}

/** "30m" | "24h" | "7d" | ISO date -> epoch ms cutoff. */
function parseSince(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const s = value.trim();
  const rel = /^(\d+)\s*([mhd])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function fmtDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTime(iso: unknown): string {
  if (typeof iso !== "string") return "?";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

type Filters = { sessionId?: string; tool?: string; status?: string; since?: number };

function whereClause(f: Filters): { sql: string; params: unknown[] } {
  // T1: columns are qualified with `c.` because every consumer aliases
  // `calls c` — the FTS branch joins calls_fts (which has its own `tool`
  // column), and unqualified `tool = ?` was ambiguous at runtime.
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.since !== undefined) {
    parts.push("c.started_ms >= ?");
    params.push(f.since);
  }
  if (f.sessionId) {
    parts.push("c.session_id = ?");
    params.push(f.sessionId);
  }
  if (f.tool) {
    parts.push("c.tool = ?");
    params.push(f.tool);
  }
  if (f.status) {
    parts.push("c.status = ?");
    params.push(f.status);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

type CallRow = {
  id: number;
  session_id: string | null;
  agent: string | null;
  tool: string;
  input: string | null;
  status: string | null;
  error: string | null;
  output_chars: number | null;
  started_at: string;
  duration_ms: number | null;
};

function formatRow(r: CallRow): string {
  const bits = [
    `#${r.id}`,
    fmtTime(r.started_at),
    r.tool,
    r.status ?? "unknown",
    fmtDuration(r.duration_ms),
  ];
  if (r.session_id) bits.push(r.session_id.slice(0, 12));
  // T10: errors are unbounded in the DB — keep the line readable.
  if (r.error) bits.push(`error: ${r.error.slice(0, 200)}`);
  const head = bits.join(" | ");
  return r.input ? `${head}\n    ${r.input}` : head;
}

/** T9 helpers: on-disk size of the audit store. */
function dbSizeOf(cfg: Config): number | null {
  try {
    return statSync(join(cfg.dir, DB_NAME)).size;
  } catch {
    return null;
  }
}

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default Plugin.define({
  id: "tool-audit",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);

    if (cfg.enabled) {
      try {
        prune(getDb(cfg), cfg);
      } catch (err) {
        console.error(`[tool-audit] db init/prune failed: ${String(err)}`);
      }
    }

    // T3: keep pruning on a schedule — previously it only ran at startup,
    // so long-lived servers never enforced retention.
    const pruneTimer = setInterval(() => {
      try {
        if (cfg.enabled) prune(getDb(cfg), cfg);
      } catch {
        /* best effort */
      }
    }, 3_600_000);
    pruneTimer.unref?.();

    const record = (entry: Pending, status: string, error: string | undefined, outputChars: number | undefined, endedMs: number): void => {
      try {
        getDb(cfg)
          .prepare(
            `INSERT OR IGNORE INTO calls
               (session_id, agent, message_id, call_id, tool, input, status, error, output_chars, started_at, ended_at, started_ms, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.sessionID || null,
            entry.agent || null,
            entry.messageID || null,
            // T2/T7: record the event id so a redelivered execute.after is
            // ignored by the partial unique index; empty ids stay NULL.
            entry.callId || null,
            entry.tool,
            serializeInput(entry.input, cfg),
            status,
            error ? redact(error).slice(0, cfg.maxInputChars) : null,
            outputChars ?? null,
            new Date(entry.startedMs).toISOString(),
            new Date(endedMs).toISOString(),
            entry.startedMs,
            endedMs - entry.startedMs,
          );
      } catch (err) {
        console.error(`[tool-audit] failed to record ${entry.tool}: ${String(err)}`);
      }
    };

    const outputChars = (result: unknown): number | undefined => {
      // T11: never JSON.stringify unbounded outputs on the hook path.
      const MAX_OUTPUT_SCAN = 1_000_000;
      try {
        const r = result as { content?: unknown; output?: unknown };
        const content = r?.content;
        if (typeof content === "string") return content.length;
        if (Array.isArray(content)) {
          let n = 0;
          for (const part of content) {
            const text = (part as { text?: unknown })?.text;
            if (typeof text !== "string") continue;
            n += text.length;
            if (n > MAX_OUTPUT_SCAN) return n;
          }
          return n;
        }
        if (typeof r?.output === "string") return r.output.length;
        if (r?.output !== undefined) {
          // Object outputs still need a size — serialize only small ones;
          // above the cap, record the cap instead of stringifying megabytes.
          const probe = safeLen(r.output, MAX_OUTPUT_SCAN);
          return probe > MAX_OUTPUT_SCAN ? MAX_OUTPUT_SCAN : probe;
        }
        return undefined;
      } catch {
        return undefined;
      }
    };

    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    if (cfg.enabled) {
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => {
          if (cfg.ignoreTools.has(event.tool)) return;
          // T7: normalize the event id — "undefined" must never become a
          // call_id (it would collide across every id-less event).
          const callId = String(event.id ?? "");
          pending.set(callId, {
            tool: event.tool,
            sessionID: String(event.sessionID ?? ""),
            agent: String(event.agent ?? ""),
            messageID: String(event.messageID ?? ""),
            callId,
            input: event.input,
            startedMs: Date.now(),
          });
        }),
      );

      registrations.push(
        await ctx.tool.hook("execute.after", (event) => {
          if (cfg.ignoreTools.has(event.tool)) return;
          const key = String(event.id ?? "");
          const entry: Pending = pending.get(key) ?? {
            tool: event.tool,
            sessionID: String(event.sessionID ?? ""),
            agent: String(event.agent ?? ""),
            messageID: String(event.messageID ?? ""),
            callId: key,
            input: event.input,
            startedMs: Date.now(),
          };
          pending.delete(key);
          const endedMs = Date.now();
          if (event.status === "error") {
            const message = String(
              (event.error as { message?: string })?.message ?? event.error ?? "unknown error",
            );
            record(entry, "error", message, undefined, endedMs);
          } else {
            record(entry, "completed", undefined, outputChars(event.result), endedMs);
          }
        }),
      );
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "trace_query",
        description:
          "Query the local tool-call audit log: which tools ran, with what arguments, their status and duration. Full-text search over tool names, arguments and errors.",
        input: z.object({
          query: z.string().optional().describe("Full-text search over tool, arguments and errors"),
          sessionId: z.string().optional().describe("Only calls from this session id"),
          tool: z.string().optional().describe("Only calls of this tool"),
          status: z.enum(["completed", "error"]).optional().describe("Only calls with this status"),
          since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
          limit: z.number().optional().describe("Max rows (default 20, max 200)"),
        }),
        execute: async (input) => {
          const args = input as {
            query?: string;
            sessionId?: string;
            tool?: string;
            status?: string;
            since?: string;
            limit?: number;
          };
          try {
            const database = getDb(cfg);
            const filters: Filters = {
              sessionId: args.sessionId,
              tool: args.tool,
              status: args.status,
              since: parseSince(args.since),
            };
            const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 200);
            const where = whereClause(filters);

            let rows: CallRow[];
            // S4/T1: an empty/whitespace query must not reach MATCH ("" throws
            // an FTS5 syntax error); filters work standalone now because all
            // whereClause columns are qualified with the `c.` alias.
            const q = args.query && args.query.trim() ? quoteFtsQuery(args.query) : null;
            if (q) {
              rows = database
                .query(
                  `SELECT c.* FROM calls_fts f
                   JOIN calls c ON c.id = f.rowid
                   WHERE calls_fts MATCH ?${where.sql}
                   ORDER BY c.started_ms DESC LIMIT ?`,
                )
                .all(q, ...where.params, limit) as CallRow[];
            } else {
              rows = database
                .query(
                  `SELECT * FROM calls c WHERE 1=1${where.sql} ORDER BY c.started_ms DESC LIMIT ?`,
                )
                .all(...where.params, limit) as CallRow[];
            }

            if (rows.length === 0) return { content: "No tool calls matched." };
            return {
              content: `${rows.length} call(s):\n\n${rows.map(formatRow).join("\n")}`,
            };
          } catch (err) {
            return { content: `trace_query failed: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "trace_stats",
        description:
          "Summarise the tool-call audit log: totals, per-tool counts, failures and the slowest calls.",
        input: z.object({
          sessionId: z.string().optional().describe("Only calls from this session id"),
          since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
        }),
        execute: async (input) => {
          const args = input as { sessionId?: string; since?: string };
          try {
            const database = getDb(cfg);
            const where = whereClause({
              sessionId: args.sessionId,
              since: parseSince(args.since),
            });

            const totals = database
              .query(
                `SELECT COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        COUNT(DISTINCT session_id) AS sessions,
                        COUNT(DISTINCT tool) AS tools,
                        MIN(started_ms) AS first_ms,
                        MAX(started_ms) AS last_ms
                 FROM calls c WHERE 1=1${where.sql}`,
              )
              .get(...where.params) as {
              calls: number;
              errors: number | null;
              sessions: number;
              tools: number;
              first_ms: number | null;
              last_ms: number | null;
            };

            if (!totals || !totals.calls) return { content: "No tool calls recorded yet." };

            const perTool = database
              .query(
                `SELECT tool,
                        COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        AVG(duration_ms) AS avg_ms,
                        MAX(duration_ms) AS max_ms
                 FROM calls c WHERE 1=1${where.sql}
                 GROUP BY tool ORDER BY calls DESC LIMIT 15`,
              )
              .all(...where.params) as Array<{
              tool: string;
              calls: number;
              errors: number | null;
              avg_ms: number | null;
              max_ms: number | null;
            }>;

            const slowest = database
              .query(
                `SELECT tool, status, duration_ms, session_id, started_at, error
                 FROM calls c WHERE 1=1${where.sql}
                 ORDER BY duration_ms DESC LIMIT 5`,
              )
              .all(...where.params) as Array<{
              tool: string;
              status: string | null;
              duration_ms: number | null;
              session_id: string | null;
              started_at: string;
              error: string | null;
            }>;

            const lines = [
              `calls: ${totals.calls} | errors: ${totals.errors ?? 0} | sessions: ${totals.sessions} | tools: ${totals.tools}`,
              totals.first_ms && totals.last_ms
                ? `window: ${fmtTime(new Date(totals.first_ms).toISOString())} -> ${fmtTime(new Date(totals.last_ms).toISOString())}`
                : "",
              // T9: show where the data lives and how big the store is.
              `store: ${join(cfg.dir, DB_NAME)} | rows: ${totals.calls} | size: ${fmtSize(dbSizeOf(cfg))} | oldest: ${totals.first_ms ? fmtTime(new Date(totals.first_ms).toISOString()) : "n/a"}`,
              "",
              "per tool (calls | errors | avg | max):",
              ...perTool.map(
                (r) =>
                  `- ${r.tool}: ${r.calls} | ${r.errors ?? 0} | ${fmtDuration(r.avg_ms)} | ${fmtDuration(r.max_ms)}`,
              ),
              "",
              "slowest:",
              ...slowest.map(
                (r) =>
                  `- ${r.tool} ${fmtDuration(r.duration_ms)} (${r.status ?? "?"}) ${fmtTime(r.started_at)}${r.error ? ` — ${r.error}` : ""}`,
              ),
            ].filter((l) => l !== "");

            return { content: lines.join("\n") };
          } catch (err) {
            return { content: `trace_stats failed: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "trace_sessions",
        description:
          "Per-session rollup of the audit log: tool calls, errors, distinct tools and last activity per session id.",
        input: z.object({
          since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
          limit: z.number().optional().describe("Max sessions (default 20, max 100)"),
        }),
        execute: async (input) => {
          const args = input as { since?: string; limit?: number };
          try {
            const database = getDb(cfg);
            const where = whereClause({ since: parseSince(args.since) });
            const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100);
            const rows = database
              .query(
                `SELECT session_id,
                        COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        COUNT(DISTINCT tool) AS tools,
                        MAX(started_ms) AS last_ms
                 FROM calls c WHERE 1=1${where.sql}
                 GROUP BY session_id ORDER BY last_ms DESC LIMIT ?`,
              )
              .all(...where.params, limit) as Array<{
              session_id: string | null;
              calls: number;
              errors: number | null;
              tools: number;
              last_ms: number;
            }>;
            if (rows.length === 0) return { content: "No tool calls recorded yet." };
            const lines = rows.map(
              (r) =>
                `- ${r.session_id ?? "(unknown)"}: calls=${r.calls} errors=${r.errors ?? 0} tools=${r.tools} last=${fmtTime(new Date(r.last_ms).toISOString())}`,
            );
            return { content: `${rows.length} session(s):\n${lines.join("\n")}` };
          } catch (err) {
            return { content: `trace_sessions failed: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "trace_export",
        description:
          "Export audit-log rows as JSONL or a Markdown table, e.g. to attach to a bug report or save to a file.",
        input: z.object({
          sessionId: z.string().optional().describe("Only calls from this session id"),
          tool: z.string().optional().describe("Only calls of this tool"),
          status: z.enum(["completed", "error"]).optional().describe("Only calls with this status"),
          since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
          format: z.enum(["jsonl", "markdown"]).optional().describe("Output format (default jsonl)"),
          limit: z.number().optional().describe("Max rows (default 200, max 1000)"),
        }),
        execute: async (input) => {
          const args = input as {
            sessionId?: string;
            tool?: string;
            status?: string;
            since?: string;
            format?: "jsonl" | "markdown";
            limit?: number;
          };
          try {
            const database = getDb(cfg);
            const where = whereClause({
              sessionId: args.sessionId,
              tool: args.tool,
              status: args.status,
              since: parseSince(args.since),
            });
            const limit = Math.min(Math.max(Math.trunc(args.limit ?? 200), 1), 1000);
            const rows = database
              .query(`SELECT * FROM calls c WHERE 1=1${where.sql} ORDER BY c.started_ms ASC LIMIT ?`)
              .all(...where.params, limit) as CallRow[];

            if (rows.length === 0) return { content: "No tool calls matched." };

            if ((args.format ?? "jsonl") === "markdown") {
              const head =
                "| time | tool | status | duration_ms | session | error | input |\n| --- | --- | --- | --- | --- | --- | --- |";
              const body = rows.map((r) =>
                [
                  fmtTime(r.started_at),
                  r.tool,
                  r.status ?? "",
                  r.duration_ms ?? "",
                  (r.session_id ?? "").slice(0, 12),
                  // T6: newlines in stored values must not break the table.
                  (r.error ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 120),
                  (r.input ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200),
                ].join(" | "),
              );
              return { content: [head, ...body.map((b) => `| ${b} |`)].join("\n") };
            }

            const jsonl = rows
              .map((r) =>
                JSON.stringify({
                  time: r.started_at,
                  tool: r.tool,
                  status: r.status,
                  duration_ms: r.duration_ms,
                  session: r.session_id,
                  agent: r.agent,
                  error: r.error,
                  input: r.input,
                  output_chars: r.output_chars,
                }),
              )
              .join("\n");
            return { content: jsonl };
          } catch (err) {
            return { content: `trace_export failed: ${String(err)}` };
          }
        },
      });
    });

    console.error(
      `[tool-audit] enabled=${cfg.enabled} dir=${cfg.dir} retentionDays=${cfg.retentionDays} redact=${cfg.redact}`,
    );

    return async () => {
      clearInterval(pruneTimer);
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch {
          /* ignore */
        }
      }
      pending.clear();
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        db = null;
      }
    };
  },
});
