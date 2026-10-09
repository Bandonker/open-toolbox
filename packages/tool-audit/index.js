import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { statSync, mkdtempSync, createWriteStream, rmSync, mkdirSync, renameSync, copyFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, basename } from "path";
import { openDatabase, applyPragmas, quoteFtsQuery, } from "./lib/sqlite.js";
import { fmtDuration, fmtTime, fmtSize } from "./lib/format.js";
import { asBool, asInt } from "./lib/config.js";
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
function resolveConfig(options) {
    const o = options ?? {};
    const env = (key) => process.env[key];
    const asList = (value, envValue) => {
        if (Array.isArray(value))
            return value.filter((v) => typeof v === "string");
        if (typeof value === "string")
            return value.split(",").map((s) => s.trim()).filter(Boolean);
        if (typeof envValue === "string" && envValue.trim()) {
            return envValue.split(",").map((s) => s.trim()).filter(Boolean);
        }
        return [];
    };
    const num = (value, envValue, fallback) => {
        const raw = typeof value === "number" || typeof value === "string" ? value : envValue;
        return asInt(raw, fallback);
    };
    const bool = (value, envValue, fallback) => {
        if (typeof value === "boolean")
            return value;
        if (typeof envValue === "string")
            return asBool(envValue, fallback);
        return fallback;
    };
    return {
        dir: typeof o.dir === "string" && o.dir
            ? o.dir
            : env("OPENCODE_TOOL_AUDIT_DIR") || DEFAULT_DIR,
        enabled: bool(o.enabled, env("OPENCODE_TOOL_AUDIT_ENABLED"), true),
        redact: bool(o.redact, env("OPENCODE_TOOL_AUDIT_REDACT"), true),
        maxInputChars: Math.max(100, Math.trunc(num(o.maxInputChars, env("OPENCODE_TOOL_AUDIT_MAX_INPUT_CHARS"), 2000))),
        retentionDays: Math.max(0, Math.trunc(num(o.retentionDays, env("OPENCODE_TOOL_AUDIT_RETENTION_DAYS"), 30))),
        ignoreTools: new Set([
            "todowrite",
            // Sibling noisy tools: usage-stats dashboards and session exports would
            // otherwise flood the audit log with their own reads/writes.
            "stats_summary",
            "stats_tokens",
            "stats_heatmap",
            "stats_tools",
            "stats_dashboard",
            "stats_export",
            "session_export",
            "session_export_history",
            ...AUDIT_TOOLS,
            ...asList(o.ignoreTools, env("OPENCODE_TOOL_AUDIT_IGNORE")),
        ]),
    };
}
/** Length of a value without serializing unbounded outputs (T11 helper). */
function safeLen(value, cap) {
    if (typeof value === "string")
        return value.length;
    if (value === null || value === undefined)
        return 0;
    if (typeof value !== "object")
        return String(value).length;
    try {
        let n = 0;
        const visit = (node, depth) => {
            if (n > cap || depth > 6)
                return false;
            if (typeof node === "string") {
                n += node.length;
                return n <= cap;
            }
            if (Array.isArray(node)) {
                for (const item of node)
                    if (!visit(item, depth + 1))
                        return false;
                return true;
            }
            if (node && typeof node === "object") {
                for (const v of Object.values(node))
                    if (!visit(v, depth + 1))
                        return false;
            }
            return true;
        };
        visit(value, 0);
        return n;
    }
    catch {
        return cap;
    }
}
/**
 * TA-8: snapshot hook input at capture time. The event object may be mutated
 * after `execute.before` returns, so storing the reference would record the
 * *final* state (or throw at serialization). Deep-clone, capped and total.
 */
function snapshotInput(value) {
    if (value === null || value === undefined)
        return value;
    try {
        if (typeof structuredClone === "function")
            return structuredClone(value);
    }
    catch {
        // Fall through to the JSON copy below.
    }
    try {
        return JSON.parse(JSON.stringify(value) ?? "null");
    }
    catch {
        return String(value).slice(0, 4000);
    }
}
/** Redact obvious secrets before anything touches disk. */
function redact(text) {
    let out = text;
    const plain = [
        /\bsk-[A-Za-z0-9_-]{16,}/g,
        /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
        /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
        /\bAKIA[0-9A-Z]{16}\b/g,
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    ];
    for (const re of plain)
        out = out.replace(re, "[redacted]");
    out = out.replace(/("?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|authorization)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi, "$1[redacted]");
    return out;
}
function serializeInput(input, cfg) {
    let text;
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
        if (text === undefined)
            text = String(input);
    }
    catch {
        text = String(input);
    }
    if (cfg.redact)
        text = redact(text);
    if (text.length > cfg.maxInputChars) {
        text = text.slice(0, cfg.maxInputChars) + `…[truncated ${text.length - cfg.maxInputChars}]`;
    }
    return text;
}
function initSchema(database) {
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
    database.exec("CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, started_ms)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool)");
    // T5: unfiltered time-range scans previously full-scanned the table.
    database.exec("CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_ms)");
    // T2: idempotency — a redelivered execute.after must not double-record.
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_callid ON calls(call_id) WHERE call_id IS NOT NULL");
    const row = database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='calls_fts'")
        .get();
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
function prune(database, cfg) {
    if (cfg.retentionDays <= 0)
        return;
    const cutoff = Date.now() - cfg.retentionDays * 86_400_000;
    const result = database.prepare("DELETE FROM calls WHERE started_ms < ?").run(cutoff);
    // Reclaim space after bulk deletes; WAL checkpoint keeps readers unblocked.
    if (typeof result?.changes === "number" && result.changes > 0) {
        try {
            database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        catch {
            // Checkpoint is best-effort (e.g. non-WAL journals) — deletes already landed.
        }
    }
}
/** "30m" | "24h" | "7d" | ISO date -> epoch ms cutoff. */
function parseSince(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
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
/** Escape a value for CSV output per RFC 4180. */
function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}
function whereClause(f) {
    // T1: columns are qualified with `c.` because every consumer aliases
    // `calls c` — the FTS branch joins calls_fts (which has its own `tool`
    // column), and unqualified `tool = ?` was ambiguous at runtime.
    const parts = [];
    const params = [];
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
function formatRow(r) {
    const bits = [
        `#${r.id}`,
        fmtTime(r.started_at),
        r.tool,
        r.status ?? "unknown",
        fmtDuration(r.duration_ms),
    ];
    if (r.session_id)
        bits.push(r.session_id.slice(0, 12));
    // T10: errors are unbounded in the DB — keep the line readable.
    if (r.error)
        bits.push(`error: ${r.error.slice(0, 200)}`);
    const head = bits.join(" | ");
    return r.input ? `${head}\n    ${r.input}` : head;
}
/** T9 helpers: on-disk size of the audit store. */
function dbSizeOf(cfg) {
    try {
        return statSync(join(cfg.dir, DB_NAME)).size;
    }
    catch {
        return null;
    }
}
export default Plugin.define({
    id: "tool-audit",
    async setup(ctx) {
        const cfg = resolveConfig(ctx.options);
        // TA-1: per-setup state. These used to be module-level, so two
        // concurrent setups shared one sqlite handle (opened for whichever
        // dir came first) and one in-flight map — each setup owns its own.
        let db = null;
        const pending = new Map();
        const getDb = (config) => {
            if (!db) {
                db = openDatabase(join(config.dir, DB_NAME));
                applyPragmas(db);
                initSchema(db);
            }
            return db;
        };
        if (cfg.enabled) {
            try {
                prune(getDb(cfg), cfg);
            }
            catch (err) {
                console.error(`[tool-audit] db init/prune failed: ${String(err)}`);
            }
        }
        // T3: keep pruning on a schedule — previously it only ran at startup,
        // so long-lived servers never enforced retention.
        const pruneTimer = setInterval(() => {
            try {
                if (cfg.enabled)
                    prune(getDb(cfg), cfg);
            }
            catch {
                /* best effort */
            }
        }, 3_600_000);
        pruneTimer.unref?.();
        const record = (entry, status, error, outputChars, endedMs, 
        // TA-6: null when the pending entry was swept (call longer than the
        // sweep TTL) or execute.before was lost — duration_ms is stored NULL so
        // AVG/percentiles exclude the call instead of a fabricated 0 dragging
        // them down.
        durationMs = endedMs - entry.startedMs) => {
            try {
                getDb(cfg)
                    .prepare(`INSERT OR IGNORE INTO calls
               (session_id, agent, message_id, call_id, tool, input, status, error, output_chars, started_at, ended_at, started_ms, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(entry.sessionID || null, entry.agent || null, entry.messageID || null, 
                // T2/T7: record the event id so a redelivered execute.after is
                // ignored by the partial unique index; TA-3/TA-4: id-less events
                // stay NULL — the partial index ignores NULLs, so every one of
                // them is recorded.
                entry.callId || null, entry.tool, serializeInput(entry.input, cfg), status, error ? redact(error).slice(0, cfg.maxInputChars) : null, outputChars ?? null, new Date(entry.startedMs).toISOString(), new Date(endedMs).toISOString(), entry.startedMs, durationMs);
            }
            catch (err) {
                console.error(`[tool-audit] failed to record ${entry.tool}: ${String(err)}`);
            }
        };
        const outputChars = (result) => {
            // T11: never JSON.stringify unbounded outputs on the hook path.
            const MAX_OUTPUT_SCAN = 1_000_000;
            try {
                const r = result;
                const content = r?.content;
                if (typeof content === "string")
                    return content.length;
                if (Array.isArray(content)) {
                    let n = 0;
                    for (const part of content) {
                        const text = part?.text;
                        if (typeof text !== "string")
                            continue;
                        n += text.length;
                        if (n > MAX_OUTPUT_SCAN)
                            return n;
                    }
                    return n;
                }
                if (typeof r?.output === "string")
                    return r.output.length;
                if (r?.output !== undefined) {
                    // Object outputs still need a size — serialize only small ones;
                    // above the cap, record the cap instead of stringifying megabytes.
                    const probe = safeLen(r.output, MAX_OUTPUT_SCAN);
                    return probe > MAX_OUTPUT_SCAN ? MAX_OUTPUT_SCAN : probe;
                }
                return undefined;
            }
            catch {
                return undefined;
            }
        };
        const registrations = [];
        // TA-3/TA-6: sweep stale pending entries (at most once per 10 min) so a
        // missed execute.after can never grow the map without bound. The TTL is
        // generous (1h): a call that finishes within it still reports a real
        // duration; anything swept is recorded by the after-hook fallback with
        // duration_ms NULL rather than dropped or zeroed (TA-6).
        let lastPendingSweep = 0;
        const sweepPending = (now) => {
            if (now - lastPendingSweep < 10 * 60_000)
                return;
            lastPendingSweep = now;
            for (const [key, entry] of pending) {
                if (now - entry.startedMs > 60 * 60_000)
                    pending.delete(key);
            }
        };
        if (cfg.enabled) {
            registrations.push(await ctx.tool.hook("execute.before", (event) => {
                if (cfg.ignoreTools.has(event.tool))
                    return;
                sweepPending(Date.now());
                // TA-2: id-less events share no key — skipping them here keeps them
                // from colliding on "" (the after-hook still records a fallback entry).
                if (event.id === undefined || event.id === null)
                    return;
                // T7: normalize the event id — "undefined" must never become a
                // call_id (it would collide across every id-less event).
                const callId = String(event.id);
                pending.set(callId, {
                    tool: event.tool,
                    sessionID: String(event.sessionID ?? ""),
                    agent: String(event.agent ?? ""),
                    messageID: String(event.messageID ?? ""),
                    callId,
                    // TA-8: snapshot the input — the event object may be mutated after the hook.
                    input: snapshotInput(event.input),
                    startedMs: Date.now(),
                });
            }));
            registrations.push(await ctx.tool.hook("execute.after", (event) => {
                if (cfg.ignoreTools.has(event.tool))
                    return;
                // TA-3/TA-4: an id-less event keeps call_id = NULL instead of the
                // old "(no-id)" sentinel — the sentinel collided with itself under
                // the partial unique index, so INSERT OR IGNORE dropped every
                // id-less call after the first. NULL ids are simply left out of the
                // index, and idempotency (T2) still applies to every real id.
                const callId = event.id === undefined || event.id === null ? null : String(event.id);
                const endedMs = Date.now();
                const entry = callId === null ? undefined : pending.get(callId);
                if (callId !== null)
                    pending.delete(callId);
                if (entry === undefined) {
                    // TA-6: no pending entry — the call outlived the sweep TTL or its
                    // execute.before was lost. Still record the call (fallback row),
                    // but with duration_ms NULL rather than a fabricated 0.
                    const synthesized = {
                        tool: event.tool,
                        sessionID: String(event.sessionID ?? ""),
                        agent: String(event.agent ?? ""),
                        messageID: String(event.messageID ?? ""),
                        callId,
                        input: event.input,
                        startedMs: endedMs,
                    };
                    if (event.status === "error") {
                        const message = String(event.error?.message ?? event.error ?? "unknown error");
                        record(synthesized, "error", message, undefined, endedMs, null);
                    }
                    else {
                        record(synthesized, "completed", undefined, outputChars(event.result), endedMs, null);
                    }
                    return;
                }
                if (event.status === "error") {
                    const message = String(event.error?.message ?? event.error ?? "unknown error");
                    record(entry, "error", message, undefined, endedMs);
                }
                else {
                    record(entry, "completed", undefined, outputChars(event.result), endedMs);
                }
            }));
        }
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "trace_query",
                description: "Query the local tool-call audit log: which tools ran, with what arguments, their status and duration. Full-text search over tool names, arguments and errors.",
                input: z.object({
                    query: z.string().optional().describe("Full-text search over tool, arguments and errors"),
                    sessionId: z.string().optional().describe("Only calls from this session id"),
                    tool: z.string().optional().describe("Only calls of this tool"),
                    status: z.enum(["completed", "error"]).optional().describe("Only calls with this status"),
                    since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
                    limit: z.number().optional().describe("Max rows (default 20, max 200)"),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        const database = getDb(cfg);
                        const filters = {
                            sessionId: args.sessionId,
                            tool: args.tool,
                            status: args.status,
                            since: parseSince(args.since),
                        };
                        const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 200);
                        const where = whereClause(filters);
                        let rows;
                        // S4/T1: an empty/whitespace query must not reach MATCH ("" throws
                        // an FTS5 syntax error); filters work standalone now because all
                        // whereClause columns are qualified with the `c.` alias.
                        // TA-4: cap the FTS query — an unbounded MATCH string is a
                        // pathological-query vector (and quoteFtsQuery cost grows with it).
                        const rawQuery = (args.query ?? "").trim().split(/\s+/).slice(0, 20).join(" ");
                        const q = rawQuery ? quoteFtsQuery(rawQuery) : null;
                        if (q) {
                            rows = database
                                .query(`SELECT c.* FROM calls_fts f
                   JOIN calls c ON c.id = f.rowid
                   WHERE calls_fts MATCH ?${where.sql}
                   ORDER BY c.started_ms DESC LIMIT ?`)
                                .all(q, ...where.params, limit);
                        }
                        else {
                            rows = database
                                .query(`SELECT * FROM calls c WHERE 1=1${where.sql} ORDER BY c.started_ms DESC LIMIT ?`)
                                .all(...where.params, limit);
                        }
                        if (rows.length === 0)
                            return { content: "No tool calls matched." };
                        return {
                            content: `${rows.length} call(s):\n\n${rows.map(formatRow).join("\n")}`,
                        };
                    }
                    catch (err) {
                        return { content: `trace_query failed: ${String(err)}` };
                    }
                },
            });
            editor.add({
                name: "trace_stats",
                description: "Summarise the tool-call audit log: totals, per-tool counts, failures and the slowest calls.",
                input: z.object({
                    sessionId: z.string().optional().describe("Only calls from this session id"),
                    since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        const database = getDb(cfg);
                        const where = whereClause({
                            sessionId: args.sessionId,
                            since: parseSince(args.since),
                        });
                        const totals = database
                            .query(`SELECT COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        COUNT(DISTINCT session_id) AS sessions,
                        COUNT(DISTINCT tool) AS tools,
                        MIN(started_ms) AS first_ms,
                        MAX(started_ms) AS last_ms
                 FROM calls c WHERE 1=1${where.sql}`)
                            .get(...where.params);
                        if (!totals || !totals.calls)
                            return { content: "No tool calls recorded yet." };
                        const perTool = database
                            .query(`SELECT tool,
                        COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        AVG(duration_ms) AS avg_ms,
                        MAX(duration_ms) AS max_ms
                 FROM calls c WHERE 1=1${where.sql}
                 GROUP BY tool ORDER BY calls DESC LIMIT 15`)
                            .all(...where.params);
                        // E49: duration percentiles per tool (P50/P95/P99).
                        // TA-2: the percentile query must carry the same where clause and
                        // params as every other query in this report — previously it read
                        // the whole table, so a session/time-filtered report showed
                        // percentiles computed from unfiltered data.
                        const filterBits = [];
                        if (args.sessionId)
                            filterBits.push(`session=${args.sessionId}`);
                        if (args.since)
                            filterBits.push(`since=${args.since}`);
                        const filterLabel = filterBits.length ? ` (filtered: ${filterBits.join(" ")})` : "";
                        const durationRows = database
                            .query(`SELECT tool, duration_ms FROM calls c WHERE duration_ms IS NOT NULL${where.sql}`)
                            .all(...where.params);
                        const durationsByTool = new Map();
                        for (const r of durationRows) {
                            const arr = durationsByTool.get(r.tool) ?? [];
                            arr.push(r.duration_ms);
                            durationsByTool.set(r.tool, arr);
                        }
                        const percentile = (sorted, p) => {
                            if (sorted.length === 0)
                                return 0;
                            const idx = Math.ceil((p / 100) * sorted.length) - 1;
                            return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
                        };
                        const percentilesByTool = new Map();
                        for (const [tool, durs] of durationsByTool) {
                            durs.sort((a, b) => a - b);
                            percentilesByTool.set(tool, {
                                p50: percentile(durs, 50),
                                p95: percentile(durs, 95),
                                p99: percentile(durs, 99),
                            });
                        }
                        const slowest = database
                            .query(`SELECT tool, status, duration_ms, session_id, started_at, error
                 FROM calls c WHERE 1=1${where.sql}
                 ORDER BY duration_ms DESC LIMIT 5`)
                            .all(...where.params);
                        const lines = [
                            `calls: ${totals.calls} | errors: ${totals.errors ?? 0} | sessions: ${totals.sessions} | tools: ${totals.tools}`,
                            totals.first_ms && totals.last_ms
                                ? `window: ${fmtTime(new Date(totals.first_ms).toISOString())} -> ${fmtTime(new Date(totals.last_ms).toISOString())}`
                                : "",
                            // T9: show where the data lives and how big the store is.
                            `store: ${join(cfg.dir, DB_NAME)} | rows: ${totals.calls} | size: ${fmtSize(dbSizeOf(cfg))} | oldest: ${totals.first_ms ? fmtTime(new Date(totals.first_ms).toISOString()) : "n/a"}`,
                            "",
                            `per tool${filterLabel} (calls | errors | avg | max | p50 | p95 | p99):`,
                            ...perTool.map((r) => {
                                const p = percentilesByTool.get(r.tool);
                                return `- ${r.tool}: ${r.calls} | ${r.errors ?? 0} | ${fmtDuration(r.avg_ms)} | ${fmtDuration(r.max_ms)} | p50=${fmtDuration(p?.p50)} p95=${fmtDuration(p?.p95)} p99=${fmtDuration(p?.p99)}`;
                            }),
                            "",
                            "slowest:",
                            ...slowest.map((r) => `- ${r.tool} ${fmtDuration(r.duration_ms)} (${r.status ?? "?"}) ${fmtTime(r.started_at)}${r.error ? ` — ${r.error}` : ""}`),
                        ].filter((l) => l !== "");
                        return { content: lines.join("\n") };
                    }
                    catch (err) {
                        return { content: `trace_stats failed: ${String(err)}` };
                    }
                },
            });
            editor.add({
                name: "trace_sessions",
                description: "Per-session rollup of the audit log: tool calls, errors, distinct tools and last activity per session id.",
                input: z.object({
                    since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
                    limit: z.number().optional().describe("Max sessions (default 20, max 100)"),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        const database = getDb(cfg);
                        const where = whereClause({ since: parseSince(args.since) });
                        const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100);
                        const rows = database
                            .query(`SELECT session_id,
                        COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                        COUNT(DISTINCT tool) AS tools,
                        MAX(started_ms) AS last_ms
                 FROM calls c WHERE 1=1${where.sql}
                 GROUP BY session_id ORDER BY last_ms DESC LIMIT ?`)
                            .all(...where.params, limit);
                        if (rows.length === 0)
                            return { content: "No tool calls recorded yet." };
                        const lines = rows.map((r) => `- ${r.session_id ?? "(unknown)"}: calls=${r.calls} errors=${r.errors ?? 0} tools=${r.tools} last=${fmtTime(new Date(r.last_ms).toISOString())}`);
                        return { content: `${rows.length} session(s):\n${lines.join("\n")}` };
                    }
                    catch (err) {
                        return { content: `trace_sessions failed: ${String(err)}` };
                    }
                },
            });
            editor.add({
                name: "trace_export",
                description: "Export audit-log rows as JSONL or a Markdown table, e.g. to attach to a bug report or save to a file.",
                input: z.object({
                    sessionId: z.string().optional().describe("Only calls from this session id"),
                    tool: z.string().optional().describe("Only calls of this tool"),
                    status: z.enum(["completed", "error"]).optional().describe("Only calls with this status"),
                    since: z.string().optional().describe('Time window: "30m", "24h", "7d" or an ISO date'),
                    format: z.enum(["jsonl", "markdown", "csv"]).optional().describe("Output format (default jsonl)"),
                    limit: z.number().optional().describe("Max rows (default 50, max 1000)"),
                }),
                execute: async (input) => {
                    const args = input;
                    // TA-5: every path — success, zero rows, mid-write failure — must
                    // close the stream and remove the temp dir. Previously any throw
                    // leaked an open write stream and a temp directory per failure.
                    let writeStream = null;
                    let tmpDir = null;
                    try {
                        const database = getDb(cfg);
                        const where = whereClause({
                            sessionId: args.sessionId,
                            tool: args.tool,
                            status: args.status,
                            since: parseSince(args.since),
                        });
                        const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 1000);
                        const format = args.format ?? "jsonl";
                        // E50: stream rows via .iterate() and write incrementally to a temp
                        // file instead of loading all rows into memory with .all().
                        tmpDir = mkdtempSync(join(tmpdir(), "trace-export-"));
                        const tmpFile = join(tmpDir, `trace-export-${Date.now()}.${format}`);
                        writeStream = createWriteStream(tmpFile, "utf8");
                        let count = 0;
                        if (format === "markdown") {
                            writeStream.write("| time | tool | status | duration_ms | session | error | input |\n| --- | --- | --- | --- | --- | --- | --- |\n");
                        }
                        else if (format === "csv") {
                            writeStream.write("id,started_at,tool,status,duration_ms,session_id,error,input,output_chars\n");
                        }
                        const iter = database
                            .query(`SELECT * FROM calls c WHERE 1=1${where.sql} ORDER BY c.started_ms ASC LIMIT ?`)
                            .iterate(...where.params, limit);
                        for (const r of iter) {
                            count++;
                            if (format === "markdown") {
                                writeStream.write(`| ${[
                                    fmtTime(r.started_at),
                                    r.tool,
                                    r.status ?? "",
                                    r.duration_ms ?? "",
                                    (r.session_id ?? "").slice(0, 12),
                                    (r.error ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 120),
                                    (r.input ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200),
                                ].join(" | ")} |\n`);
                            }
                            else if (format === "csv") {
                                writeStream.write(`${[
                                    r.id,
                                    fmtTime(r.started_at),
                                    r.tool,
                                    r.status ?? "",
                                    r.duration_ms ?? "",
                                    (r.session_id ?? "").slice(0, 12),
                                    (r.error ?? "").slice(0, 2000),
                                    (r.input ?? "").slice(0, 2000),
                                    r.output_chars ?? "",
                                ].map(csvEscape).join(",")}\n`);
                            }
                            else {
                                writeStream.write(JSON.stringify({
                                    time: r.started_at,
                                    tool: r.tool,
                                    status: r.status,
                                    duration_ms: r.duration_ms,
                                    session: r.session_id,
                                    agent: r.agent,
                                    error: r.error && r.error.length > 2000 ? `${r.error.slice(0, 2000)}…[truncated]` : r.error,
                                    input: r.input,
                                    output_chars: r.output_chars,
                                }) + "\n");
                            }
                        }
                        writeStream.end();
                        await new Promise((resolve, reject) => {
                            writeStream.on("finish", resolve);
                            writeStream.on("error", reject);
                        });
                        if (count === 0) {
                            return { content: "No tool calls matched." };
                        }
                        // TA-5: move the finished file out of the temp dir into the
                        // plugin's data dir so the returned path stays valid, letting the
                        // finally block remove the temp dir on every path.
                        const exportDir = join(cfg.dir, "exports");
                        mkdirSync(exportDir, { recursive: true });
                        const finalPath = join(exportDir, basename(tmpFile));
                        try {
                            renameSync(tmpFile, finalPath);
                        }
                        catch {
                            // Cross-device temp dirs (tmpfs → home): copy instead of rename.
                            copyFileSync(tmpFile, finalPath);
                        }
                        return { content: `Exported ${count} row(s) to ${finalPath}` };
                    }
                    catch (err) {
                        return { content: `trace_export failed: ${String(err)}` };
                    }
                    finally {
                        try {
                            writeStream?.destroy();
                        }
                        catch {
                            /* already closed */
                        }
                        if (tmpDir) {
                            try {
                                rmSync(tmpDir, { force: true, recursive: true });
                            }
                            catch {
                                /* best effort */
                            }
                        }
                    }
                },
            });
            // E48 — trace_timeline
            editor.add({
                name: "trace_timeline",
                description: "Full call history for a single tool, newest first.",
                input: z.object({
                    tool: z.string().min(1).describe("Tool name"),
                    // TA-1: the stored statuses are "completed"/"error" — the old
                    // ["ok","error"] enum filtered every completed call out of results.
                    status: z.enum(["completed", "error"]).optional().describe("Filter by status"),
                    since: z.string().optional().describe('Start time (ISO or "1h" style)'),
                    limit: z.number().int().positive().max(500).optional().describe("Max rows (default 50)"),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        const db = getDb(cfg);
                        const sinceMs = parseSince(args.since);
                        const limit = args.limit ?? 50;
                        // TA-1: the calls table has started_at/started_ms, not `time` —
                        // the old query threw `no such column: time` on every call.
                        let sql = "SELECT id, started_at, session_id, agent, tool, status, duration_ms FROM calls WHERE tool = ?";
                        const params = [args.tool];
                        if (args.status) {
                            sql += " AND status = ?";
                            params.push(args.status);
                        }
                        if (sinceMs !== undefined) {
                            sql += " AND started_ms >= ?";
                            params.push(sinceMs);
                        }
                        sql += " ORDER BY started_ms DESC LIMIT ?";
                        params.push(limit);
                        const rows = db.prepare(sql).all(...params);
                        if (rows.length === 0)
                            return { content: `No calls found for tool '${args.tool}'.` };
                        const lines = [`Call history for '${args.tool}' (${rows.length} calls)`];
                        for (const r of rows) {
                            lines.push(`  ${fmtTime(r.started_at)} ${r.status} ${fmtDuration(r.duration_ms)} session=${r.session_id} agent=${r.agent}`);
                        }
                        return { content: lines.join("\n") };
                    }
                    catch (err) {
                        return { content: `trace_timeline failed: ${String(err)}` };
                    }
                },
            });
            // E52 — trace_config
            editor.add({
                name: "trace_config",
                description: "View or update tool-audit configuration at runtime.",
                input: z.object({
                    ignoreTools: z.array(z.string()).optional().describe("Replace the ignore list"),
                    addIgnoreTools: z.array(z.string()).optional().describe("Add tools to the ignore list"),
                    removeIgnoreTools: z.array(z.string()).optional().describe("Remove tools from the ignore list"),
                    redact: z.boolean().optional().describe("Enable/disable redaction"),
                    maxInputChars: z.number().optional().describe("Max input characters to store (min 100)"),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        if (args.ignoreTools) {
                            cfg.ignoreTools = new Set(args.ignoreTools);
                        }
                        if (args.addIgnoreTools) {
                            for (const t of args.addIgnoreTools)
                                cfg.ignoreTools.add(t);
                        }
                        if (args.removeIgnoreTools) {
                            for (const t of args.removeIgnoreTools)
                                cfg.ignoreTools.delete(t);
                        }
                        if (args.redact !== undefined)
                            cfg.redact = args.redact;
                        if (args.maxInputChars !== undefined)
                            cfg.maxInputChars = Math.max(100, args.maxInputChars);
                        return {
                            content: [
                                `tool-audit config:`,
                                `  ignoreTools: ${[...cfg.ignoreTools].join(", ")}`,
                                `  redact: ${cfg.redact}`,
                                `  maxInputChars: ${cfg.maxInputChars}`,
                                `  retentionDays: ${cfg.retentionDays}`,
                                `  dir: ${cfg.dir}`,
                            ].join("\n"),
                        };
                    }
                    catch (err) {
                        return { content: `trace_config failed: ${String(err)}` };
                    }
                },
            });
            // E51 — trace_redact_verify
            editor.add({
                name: "trace_redact_verify",
                description: "Verify redaction is working by running it on a sample string.",
                input: z.object({
                    sample: z.string().optional().describe("Sample text to redact (default: built-in test string)"),
                }),
                execute: async (input) => {
                    const args = input;
                    try {
                        const before = args.sample ??
                            "sk-abc123def456 api_key=xyz789 token=secret123 password=hunter2 email=test@example.com";
                        const after = redact(before);
                        return {
                            content: [
                                `Redaction verification`,
                                ``,
                                `  before: ${before}`,
                                `  after:  ${after}`,
                                ``,
                                after === before ? `  WARNING: redaction had no effect` : `  OK: redaction applied`,
                            ].join("\n"),
                        };
                    }
                    catch (err) {
                        return { content: `trace_redact_verify failed: ${String(err)}` };
                    }
                },
            });
        });
        console.error(`[tool-audit] enabled=${cfg.enabled} dir=${cfg.dir} retentionDays=${cfg.retentionDays} redact=${cfg.redact}`);
        return async () => {
            clearInterval(pruneTimer);
            for (const registration of registrations) {
                try {
                    await registration.dispose();
                }
                catch {
                    /* ignore */
                }
            }
            pending.clear();
            if (db) {
                try {
                    db.close();
                }
                catch {
                    /* ignore */
                }
                db = null;
            }
        };
    },
});
