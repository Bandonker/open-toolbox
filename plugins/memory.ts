import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { renameSync, statSync } from "fs";
import {
  openDatabase,
  applyPragmas,
  isCorruption,
  quoteFtsQuery,
  dbUnavailable,
  clampLimit,
  truncateStored,
  STORE_CAPS,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { redactSecrets } from "../lib/redact.ts";

/**
 * memory
 *
 * Local-first long-term memory for opencode. No embedding API, no cloud, no
 * network: fragments live in a local SQLite FTS5 database and are recalled
 * with BM25. Store text explicitly with `memory_remember`, or let the
 * `context` hook auto-inject relevant fragments into each request.
 *
 * v2-only: `session.hook("context")` did not exist in v1.
 */

const DB_DIR = join(homedir(), ".opencode-plugins", "memory");
const DB_PATH = join(DB_DIR, "memory.db");

/**
 * M2: the auto-recall `seen` map is keyed by session and must be bounded —
 * an unbounded in-memory map grows for every finished session and a restart
 * re-injects fragments already shown. Entries expire after `SEEN_TTL_MS`
 * idle, the map is capped at `MAX_SEEN_SESSIONS` (oldest-first eviction),
 * per-session id sets are trimmed, and the map is persisted via
 * `ctx.storage` so restarts pick up where they left off.
 * M3: injection is additionally capped per session (`SESSION_BUDGET_MULT`
 * times the per-request budget) so consecutive turns cannot inject
 * unbounded context over a session's lifetime.
 */
interface SeenEntry {
  ids: Set<number>;
  at: number;
  chars: number;
}
const MAX_SEEN_SESSIONS = 500;
const MAX_SEEN_IDS = 2000;
const SEEN_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_BUDGET_MULT = 3;

// Live pointer to the most recently set-up instance's map, for tests.
let currentSeen: Map<string, SeenEntry> | null = null;
let currentSweep: ((now?: number) => void) | null = null;

/** Test seam (mirrors the `__test__` precedent in codebase-index). */
export const __test__ = {
  MAX_SEEN_SESSIONS,
  SEEN_TTL_MS,
  SESSION_BUDGET_MULT,
  seenSize: (): number => currentSeen?.size ?? 0,
  hasSeen: (sessionID: string): boolean => currentSeen?.has(sessionID) ?? false,
  sessionChars: (sessionID: string): number => currentSeen?.get(sessionID)?.chars ?? 0,
  injectSeen: (sessionID: string, ids: number[], at: number = Date.now()): void => {
    currentSeen?.set(sessionID, { ids: new Set(ids), at, chars: 0 });
  },
  sweepSeen: (now: number = Date.now()): void => {
    currentSweep?.(now);
  },
};
const SCOPES = ["global", "project", "session"] as const;
type Scope = (typeof SCOPES)[number];

type Config = {
  enabled: boolean;
  autoRecall: boolean;
  budgetChars: number;
  topK: number;
  minScore: number;
  scope: Scope;
  maxEntries: number;
  recallAll: boolean;
  log: boolean;
};

type MemoryRow = {
  id: number;
  text: string;
  scope: string;
  project?: string | null;
  session_id?: string | null;
  importance: number;
  tags: string;
  created_at: string;
  last_used_at: string;
  use_count: number;
  score?: number;
};

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function projectHash(directory: string): string {
  return createHash("sha1").update(directory).digest("hex").slice(0, 16);
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function ageOf(iso: string): string {
  const then = Date.parse(`${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(then)) return "?";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function formatRow(row: MemoryRow): string {
  const tags = parseTags(row.tags);
  const tagStr = tags.length > 0 ? ` tags=${tags.join(",")}` : "";
  // ME-10: cap per-row length before budgeting so one huge row cannot eat
  // the whole recall budget (recall/auto-recall budget on these lines).
  return truncateStored(`#${row.id} [${row.scope}] imp=${row.importance} age=${ageOf(row.created_at)}${tagStr} ${row.text.replace(/\s+/g, " ").trim()}`, STORE_CAPS.memoryRecallRow);
}

/** Latest user-authored text in a request, joined from its text parts. */
function extractLatestUserText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as Array<{ role?: string; content?: unknown }>) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .map((p) =>
        p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  return "";
}

function resolveConfig(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {};
  const env = (key: string): string | undefined => process.env[key];
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
  const rawScope = typeof o.scope === "string" ? o.scope : env("OPENCODE_MEMORY_SCOPE");
  const scope: Scope = rawScope === "global" || rawScope === "session" || rawScope === "project" ? rawScope : "project";
  return {
    enabled: bool(o.enabled, env("OPENCODE_MEMORY_ENABLED"), true),
    autoRecall: bool(o.autoRecall, env("OPENCODE_MEMORY_AUTO_RECALL"), true),
    budgetChars: Math.max(0, Math.trunc(num(o.budgetChars, env("OPENCODE_MEMORY_BUDGET_CHARS"), 1200))),
    topK: Math.max(1, Math.trunc(num(o.topK, env("OPENCODE_MEMORY_TOP_K"), 5))),
    minScore: num(o.minScore, env("OPENCODE_MEMORY_MIN_SCORE"), 0),
    scope,
    maxEntries: Math.max(0, Math.trunc(num(o.maxEntries, env("OPENCODE_MEMORY_MAX_ENTRIES"), 0))),
    recallAll: bool(o.recallAll, env("OPENCODE_MEMORY_RECALL_ALL"), false),
    log: bool(o.log, env("OPENCODE_MEMORY_LOG"), false),
  };
}

/**
 * M1: scope isolation is enforced at read time. A memory is visible when:
 * global — always; project — only within the same project; session — only
 * within the same session. Widening requires an explicit opt-in
 * (`options.recallAll` / env or the tool's `all: true`).
 */
function visible(
  row: MemoryRow,
  project: string,
  sessionID: string | null,
  all: boolean,
): boolean {
  if (all) return true;
  if (row.scope === "global") return true;
  if (row.scope === "project") return !row.project || row.project === project;
  if (row.scope === "session") return !!sessionID && row.session_id === sessionID;
  return false;
}

let db: AnyDatabase | null = null;

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      project TEXT,
      session_id TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_hash ON memories(hash);
    CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, tags, content=memories, content_rowid=id, tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
  `);
  const rows = database.prepare("SELECT count(*) AS n FROM memories").get() as { n: number } | null;
  if (rows && rows.n > 0) {
    const fts = database.prepare("SELECT count(*) AS n FROM memories_fts").get() as { n: number } | null;
    if (fts && fts.n === 0) database.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  }
}

function openFresh(): AnyDatabase {
  const database = openDatabase(DB_PATH);
  applyPragmas(database);
  initSchema(database);
  return database;
}

function getDb(): AnyDatabase {
  if (db) return db;
  try {
    db = openFresh();
  } catch (err) {
    if (!isCorruption(err)) throw err;
    // Never delete user data: move the unreadable file aside and start clean.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(DB_PATH, `${DB_PATH}.corrupt-${stamp}`);
    } catch {
      /* best effort */
    }
    db = openFresh();
  }
  return db;
}

function toMatch(query: string, mode: "all" | "any"): string {
  const quoted = quoteFtsQuery(query);
  if (!quoted) return "";
  return mode === "any" ? quoted.split(" ").join(" OR ") : quoted;
}

function search(database: AnyDatabase, match: string, limit: number, minScore: number, scope: Scope | null): MemoryRow[] {
  if (!match) return [];
  const params: unknown[] = [match];
  const filter = scope ? "AND m.scope = ?" : "";
  if (scope) params.push(scope);
  params.push(limit);
  const rows = database
    .prepare(
      `SELECT m.*, -bm25(memories_fts) AS score
       FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? ${filter}
       ORDER BY (score + m.importance * 0.05) DESC, m.last_used_at DESC
       LIMIT ?`,
    )
    .all(...params) as MemoryRow[];
  return rows.filter((row) => typeof row.score !== "number" || row.score >= minScore);
}

function prune(database: AnyDatabase, cfg: Config): void {
  if (cfg.maxEntries <= 0) return;
  const current = database.prepare("SELECT count(*) AS n FROM memories").get() as { n: number } | null;
  const total = current?.n ?? 0;
  if (total <= cfg.maxEntries) return;
  database
    .prepare(
      "DELETE FROM memories WHERE id IN (SELECT id FROM memories ORDER BY importance ASC, last_used_at ASC, id ASC LIMIT ?)",
    )
    .run(total - cfg.maxEntries);
}

function remember(
  database: AnyDatabase,
  cfg: Config,
  text: string,
  tags: string[],
  scope: Scope,
  importance: number,
  project: string,
  sessionID: string | null,
): { id: number; created: boolean; useCount: number } {
  const hash = hashText(normalizeText(text));
  const proj = scope === "global" ? null : project;
  const sid = scope === "session" ? sessionID : null;
  const found = database
    .prepare("SELECT id, importance, use_count FROM memories WHERE hash = ? AND scope = ? AND project IS ? AND session_id IS ? LIMIT 1")
    .get(hash, scope, proj, sid) as { id: number; importance: number; use_count: number } | null;
  if (found) {
    database
      .prepare("UPDATE memories SET importance = ?, last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?")
      .run(Math.max(found.importance, importance), found.id);
    return { id: found.id, created: false, useCount: found.use_count + 1 };
  }
  const result = database
    .prepare("INSERT INTO memories (text, hash, scope, project, session_id, importance, tags) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(text.trim(), hash, scope, proj, sid, importance, JSON.stringify(tags));
  const id = Number(result.lastInsertRowid);
  prune(database, cfg);
  return { id, created: true, useCount: 0 };
}

const scopeSchema = z.enum(["global", "project", "session"]);

/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
// Lazy read (call time, not module load) so toggles take effect without a re-import.
function storeRedactOn(): boolean {
  return process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
}
function scrubStore(text: string): string {
  return storeRedactOn() ? redactSecrets(text) : text;
}

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options);
    const project = projectHash(ctx.location?.directory ?? "");
    // CR-3: open lazily per operation so a storage failure surfaces as tool
    // content instead of throwing out of setup().
    let database: AnyDatabase | null = null;
    const requireDb = (): AnyDatabase => (database ??= getDb());
    const log = (msg: string): void => {
      if (cfg.log) console.error(`[memory] ${msg}`);
    };
    const resolveScope = (value: string | undefined): Scope =>
      value === "global" || value === "session" || value === "project" ? value : cfg.scope;
    const resolveImportance = (value: number | undefined): number =>
      typeof value === "number" && Number.isFinite(value) ? Math.min(10, Math.max(0, Math.trunc(value))) : 5;

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_remember",
        description: "Store a durable memory fragment (local SQLite, deduped by normalized content).",
        input: z.object({
          text: z.string().min(1).describe("The memory to store."),
          tags: z.array(z.string()).optional().describe("Optional labels."),
          scope: scopeSchema.optional().describe("global | project (default) | session."),
          importance: z.number().min(0).max(10).optional().describe("0-10; higher ranks first."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const scope = resolveScope(args.scope);
            const importance = resolveImportance(args.importance);
            // ME-5: scrub tags via the existing scrub util; ME-6/CR-4: cap
            // stored text (~20k) with a visible marker.
            const tags = (Array.isArray(args.tags) ? args.tags : []).map((t) => scrubStore(t));
            const result = remember(requireDb(), cfg, truncateStored(scrubStore(args.text), STORE_CAPS.memoryText), tags, scope, importance, project, toolCtx.sessionID ?? null);
            log(result.created ? `remember #${result.id}` : `dedupe #${result.id}`);
            return {
              content: result.created
                ? `Remembered #${result.id} [${scope}] (importance ${importance}).`
                : `Already remembered as #${result.id} [${scope}] — bumped (use_count ${result.useCount}).`,
            };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_recall",
        description: "Search stored memories with local BM25 full-text search. Isolated by default: only global, this project's, and this session's memories are returned.",
        input: z.object({
          query: z.string().min(1).describe("Full-text query."),
          scope: scopeSchema.optional().describe("Restrict to one scope."),
          limit: z.number().int().min(1).max(50).optional().describe("Max results (default config topK)."),
          all: z.boolean().optional().describe("Widen isolation: include memories from other projects/sessions (default false)."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const scope = args.scope ? resolveScope(args.scope) : null;
            const limit = clampLimit(args.limit ?? cfg.topK, cfg.topK, 100);
            const all = args.all === true || cfg.recallAll;
            const sessionID = toolCtx?.sessionID ?? null;
            const rows = search(requireDb(), toMatch(args.query, "all"), Math.max(limit * 3, limit), cfg.minScore, scope)
              .filter((row) => visible(row, project, sessionID, all))
              .slice(0, limit);
            if (rows.length === 0) return { content: "No memories matched." };
            return { content: rows.map(formatRow).join("\n") };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_forget",
        description: "Delete a memory by id or by full-text query match.",
        input: z.object({
          id: z.number().int().positive().optional().describe("Exact memory id."),
          query: z.string().min(1).optional().describe("Delete every FTS match."),
        }),
        execute: async (args) => {
          try {
            const database = requireDb();
            if (typeof args.id === "number") {
              const existing = database.prepare("SELECT id FROM memories WHERE id = ?").get(args.id) as { id: number } | null;
              if (!existing) return { content: `No memory #${args.id}.` };
              database.prepare("DELETE FROM memories WHERE id = ?").run(args.id);
              dropSeenIds([args.id]);
              return { content: `Forgot #${args.id}.` };
            }
            if (typeof args.query === "string") {
              const match = quoteFtsQuery(args.query);
              if (!match) return { content: "Nothing to forget." };
              const rows = database
                .prepare("SELECT m.id FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid WHERE memories_fts MATCH ?")
                .all(match) as Array<{ id: number }>;
              if (rows.length === 0) return { content: "No memories matched." };
              const del = database.prepare("DELETE FROM memories WHERE id = ?");
              for (const row of rows) del.run(row.id);
              dropSeenIds(rows.map((row) => row.id));
              return { content: `Forgot ${rows.length} memor${rows.length === 1 ? "y" : "ies"}.` };
            }
            return { content: "Provide an id or a query." };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_list",
        description: "List the most recent memories, newest first.",
        input: z.object({
          scope: scopeSchema.optional().describe("Restrict to one scope."),
          limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 20)."),
        }),
        execute: async (args) => {
          try {
            const database = requireDb();
            const scope = args.scope ? resolveScope(args.scope) : null;
            // Shared clampLimit: trunc + finite guard before LIMIT.
            const limit = clampLimit(args.limit ?? 20, 20, 100);
            const rows = scope
              ? (database.prepare("SELECT * FROM memories WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(scope, limit) as MemoryRow[])
              : (database.prepare("SELECT * FROM memories ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as MemoryRow[]);
            if (rows.length === 0) return { content: "No memories stored." };
            return { content: rows.map(formatRow).join("\n") };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_stats",
        description: "Show memory totals by scope, the database path, and the active config.",
        input: z.object({}),
        execute: async () => {
          try {
            const database = requireDb();
            const groups = database.prepare("SELECT scope, count(*) AS n FROM memories GROUP BY scope").all() as Array<{ scope: string; n: number }>;
            const total = database.prepare("SELECT count(*) AS n FROM memories").get() as { n: number } | null;
            const byScope = SCOPES.map((s) => `${s}=${groups.find((g) => g.scope === s)?.n ?? 0}`).join(" ");
            // M4: report the database file size alongside the totals.
            let size = "unknown";
            try {
              const bytes = statSync(DB_PATH).size;
              size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
            } catch {
              /* ignore — size stays "unknown" */
            }
            return {
              content: [
                `memories: ${total?.n ?? 0} (${byScope})`,
                `db: ${DB_PATH} (size: ${size})`,
                `config: scope=${cfg.scope} topK=${cfg.topK} budgetChars=${cfg.budgetChars} minScore=${cfg.minScore} autoRecall=${cfg.autoRecall} maxEntries=${cfg.maxEntries === 0 ? "unlimited" : cfg.maxEntries}`,
              ].join("\n"),
            };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });
    });

    const seen = new Map<string, SeenEntry>();
    const seenStoreKey = `memory:seen:${project}`;

    const serializeSeen = (): Record<string, { ids: number[]; at: number; chars: number }> => {
      const obj: Record<string, { ids: number[]; at: number; chars: number }> = {};
      for (const [key, entry] of seen) {
        obj[key] = { ids: [...entry.ids].slice(-MAX_SEEN_IDS), at: entry.at, chars: entry.chars };
      }
      return obj;
    };
    const saveSeen = (): void => {
      try {
        void ctx.storage?.set?.(seenStoreKey, serializeSeen());
      } catch {
        /* ignore — persistence is best-effort */
      }
    };
    const sweepSeen = (now: number = Date.now()): void => {
      for (const [key, entry] of seen) {
        if (now - entry.at > SEEN_TTL_MS) seen.delete(key);
      }
      if (seen.size > MAX_SEEN_SESSIONS) {
        const oldest = [...seen.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [key] of oldest.slice(0, seen.size - MAX_SEEN_SESSIONS)) seen.delete(key);
      }
    };
    const dropSeenIds = (ids: Iterable<number>): void => {
      const gone = new Set(ids);
      if (gone.size === 0) return;
      for (const entry of seen.values()) {
        for (const id of gone) entry.ids.delete(id);
      }
      saveSeen();
    };
    try {
      const raw = await ctx.storage?.get?.(seenStoreKey);
      if (raw && typeof raw === "object") {
        const now = Date.now();
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof key !== "string" || !value || typeof value !== "object") continue;
          const v = value as { ids?: unknown; at?: unknown; chars?: unknown };
          if (!Array.isArray(v.ids) || typeof v.at !== "number" || now - v.at > SEEN_TTL_MS) continue;
          const ids = v.ids.filter((id): id is number => typeof id === "number").slice(-MAX_SEEN_IDS);
          seen.set(key, { ids: new Set(ids), at: v.at, chars: typeof v.chars === "number" ? v.chars : 0 });
        }
        sweepSeen(now);
      }
    } catch {
      /* ignore — start with an empty map */
    }
    currentSeen = seen;
    currentSweep = sweepSeen;

    await ctx.session.hook("context", (event) => {
      try {
        if (!cfg.enabled || !cfg.autoRecall) return;
        const query = extractLatestUserText(event.messages);
        if (!query.trim()) return;
        sweepSeen();
        const recallSessionID = typeof event.sessionID === "string" ? event.sessionID : null;
        const rows = search(requireDb(), toMatch(query, "any"), Math.max(cfg.topK * 4, 8), cfg.minScore, null).filter(
          (row) => visible(row, project, recallSessionID, cfg.recallAll),
        );
        if (rows.length === 0) return;
        // ME-7: single expression for the session key ("" vs null mismatch).
        const key = recallSessionID ?? "";
        const now = Date.now();
        let entry = seen.get(key);
        if (!entry) {
          entry = { ids: new Set<number>(), at: now, chars: 0 };
          seen.set(key, entry);
        }
        entry.at = now;
        sweepSeen(now);
        // M3: cumulative per-session cap on top of the per-request budget.
        if (entry.chars >= cfg.budgetChars * SESSION_BUDGET_MULT) return;
        const used = entry.ids;
        const header = "Relevant memories (local, may be stale):";
        let budget = cfg.budgetChars - header.length - 1;
        const picked: Array<{ id: number; line: string }> = [];
        for (const row of rows) {
          if (used.has(row.id)) continue;
          if (picked.length >= cfg.topK) break;
          let line = formatRow(row);
          const cost = line.length + (picked.length > 0 ? 1 : 0);
          if (cost <= budget) {
            budget -= cost;
          } else if (picked.length === 0 && budget > 0) {
            line = line.slice(0, budget);
            budget = 0;
          } else {
            break;
          }
          picked.push({ id: row.id, line });
        }
        if (picked.length === 0) return;
        for (const p of picked) used.add(p.id);
        if (used.size > MAX_SEEN_IDS) {
          const trimmed = [...used].slice(-MAX_SEEN_IDS);
          used.clear();
          for (const id of trimmed) used.add(id);
        }
        const text = `${header}\n${picked.map((p) => p.line).join("\n")}`;
        entry.chars += text.length;
        saveSeen();
        (event.messages as unknown as Array<{ role: string; content: Array<{ type: string; text: string }> }>).push({
          role: "system",
          content: [{ type: "text", text }],
        });
        log(`auto-recall injected ${picked.length} memory(ies)`);
      } catch (err) {
        if (cfg.log) console.error(`[memory] auto-recall failed: ${String(err)}`);
      }
    });

    // ME-8: dispose the lazy DB handle on teardown (parity with the
    // error-journal dispose pattern).
    return () => {
      try { database?.close(); } catch { /* ignore */ }
      database = null;
    };
  },
});


