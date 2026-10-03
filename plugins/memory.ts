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
import { formatAge, projectHash } from "../lib/format.ts";
import { asBool, asInt } from "../lib/config.ts";

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
  lastInjectAt: number;
}
const MAX_SEEN_SESSIONS = 500;
const MAX_SEEN_IDS = 2000;
const SEEN_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_BUDGET_MULT = 3;
const CHARS_RESET_MS = 60 * 60 * 1000;

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
    currentSeen?.set(sessionID, { ids: new Set(ids), at, chars: 0, lastInjectAt: at });
  },
  sweepSeen: (now: number = Date.now()): void => {
    currentSweep?.(now);
  },
};
const SCOPES = ["global", "project", "session"] as const;
type Scope = (typeof SCOPES)[number];
type SortMode = "relevance" | "created" | "importance" | "used";

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
  autoRecallExcludeTags: string[];
  autoRecallMinImportance: number;
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

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function formatRow(row: MemoryRow): string {
  const tags = parseTags(row.tags);
  const tagStr = tags.length > 0 ? ` tags=${tags.join(",")}` : "";
  // ME-10: cap per-row length before budgeting so one huge row cannot eat
  // the whole recall budget (recall/auto-recall budget on these lines).
  return truncateStored(`#${row.id} [${row.scope}] imp=${row.importance} age=${formatAge(row.created_at)} last_used=${formatAge(row.last_used_at)} uses=${row.use_count}${tagStr} ${row.text.replace(/\s+/g, " ").trim()}`, STORE_CAPS.memoryRecallRow);
}

/** Latest user-authored text in a request, joined from its text parts. */
function extractLatestUserText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as Array<{ role?: string; content?: unknown }>) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    // M4: handle content as a plain string (not just array of parts)
    if (typeof m.content === "string") return m.content;
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
    return asInt(raw, fallback);
  };
  // MEM-4: option values go through asBool too, so a string-valued boolean
  // option ("{\"enabled\": \"false\"}") is honored the same way the adjacent
  // num() accepts option strings. Only an unusable option value falls back to
  // the env, and only an unusable env value falls back to the default.
  const bool = (value: unknown, envValue: string | undefined, fallback: boolean): boolean =>
    asBool(value, asBool(envValue, fallback));
  const rawScope = typeof o.scope === "string" ? o.scope : env("OPENCODE_MEMORY_SCOPE");
  const scope: Scope = rawScope === "global" || rawScope === "session" || rawScope === "project" ? rawScope : "project";
  const rawExcludeTags = Array.isArray(o.autoRecallExcludeTags) ? o.autoRecallExcludeTags : [];
  return {
    enabled: bool(o.enabled, env("OPENCODE_MEMORY_ENABLED"), true),
    autoRecall: bool(o.autoRecall, env("OPENCODE_MEMORY_AUTO_RECALL"), true),
    // E107: budgetChars upper bound of 50000.
    budgetChars: Math.min(50000, Math.max(0, Math.trunc(num(o.budgetChars, env("OPENCODE_MEMORY_BUDGET_CHARS"), 1200)))),
    // E108: topK upper bound of 50.
    topK: Math.min(50, Math.max(1, Math.trunc(num(o.topK, env("OPENCODE_MEMORY_TOP_K"), 5)))),
    minScore: num(o.minScore, env("OPENCODE_MEMORY_MIN_SCORE"), 0),
    scope,
    maxEntries: Math.max(0, Math.trunc(num(o.maxEntries, env("OPENCODE_MEMORY_MAX_ENTRIES"), 0))),
    recallAll: bool(o.recallAll, env("OPENCODE_MEMORY_RECALL_ALL"), false),
    log: bool(o.log, env("OPENCODE_MEMORY_LOG"), false),
    // E96: per-tag injection control for auto-recall.
    autoRecallExcludeTags: rawExcludeTags.filter((t): t is string => typeof t === "string"),
    // E97: importance threshold for auto-recall.
    autoRecallMinImportance: Math.min(10, Math.max(0, Math.trunc(num(o.autoRecallMinImportance, env("OPENCODE_MEMORY_AUTO_RECALL_MIN_IMPORTANCE"), 0)))),
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
  if (row.scope === "project") return !!row.project && row.project === project;
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
  if (mode === "any") return toMatchAny(query);
  const quoted = quoteFtsQuery(query);
  return quoted ?? "";
}

/**
 * M1: build an OR-joined FTS5 MATCH expression at the token level.
 * `quoteFtsQuery` returns a space-separated string of quoted tokens, but
 * splitting that string on spaces to insert OR would break any token that
 * contains internal spaces (e.g. from a quoted phrase). This function
 * splits the raw query first, quotes each token individually, then joins
 * with OR — avoiding the string-splitting pitfall entirely.
 */
function toMatchAny(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * ME-9: fetch-more loop for isolation-filtered reads. `visible()` can reject
 * rows after SQL LIMIT applied, so a single over-fetch under-fills under a
 * restrictive scope. Fetch progressively larger windows (up to 4 rounds)
 * until `limit` visible rows are filled or the fetch stops growing
 * (exhausted), then slice.
 *
 * M2: the fetch function receives an `offset` parameter so each round
 * fetches *new* rows. Without OFFSET, a deterministic query returns the
 * same rows every time, and if all are filtered out by visible() the loop
 * would spin forever re-fetching the same data.
 * MEM-1: rounds ACCUMULATE. `out` used to be reassigned from the current
 * round only, so a later round that matched nothing (or matched less) threw
 * away every visible row found earlier — memory_list/recall/export reported
 * "No memories stored" or a truncated list whenever visible rows were split
 * across rounds, which is common because memory.db is shared across projects.
 */
function pageVisible(
  fetch: (n: number, offset: number) => MemoryRow[],
  limit: number,
  project: string,
  sessionID: string | null,
  all: boolean,
): MemoryRow[] {
  let want = limit * 3;
  let offset = 0;
  let out: MemoryRow[] = [];
  for (let round = 0; round < 4; round++) {
    const got = fetch(want, offset);
    // E103: early-exit on zero growth — if fetch returns 0 rows, no more
    // data exists and further rounds would spin unnecessarily.
    if (got.length === 0) return out;
    out = out.concat(got.filter((r) => visible(r, project, sessionID, all))).slice(0, limit);
    if (out.length >= limit || got.length < want) return out;
    offset += got.length;
    want = Math.min(want * 2 + 1, 500);
  }
  return out;
}

interface SearchFilters {
  createdAfter?: string;
  createdBefore?: string;
  project?: string;
  session?: string;
}

function search(database: AnyDatabase, match: string, limit: number, minScore: number, scope: Scope | null, sort: SortMode = "relevance", offset: number = 0, filters?: SearchFilters): MemoryRow[] {
  if (!match) return [];
  const params: unknown[] = [match];
  let filter = scope ? "AND m.scope = ?" : "";
  if (scope) params.push(scope);
  // E89: date range filter.
  if (filters?.createdAfter) { filter += " AND m.created_at >= ?"; params.push(filters.createdAfter); }
  if (filters?.createdBefore) { filter += " AND m.created_at <= ?"; params.push(filters.createdBefore); }
  // E105: project filter.
  if (filters?.project) { filter += " AND m.project = ?"; params.push(filters.project); }
  // E106: session filter.
  if (filters?.session) { filter += " AND m.session_id = ?"; params.push(filters.session); }
  params.push(limit, offset);
  const orderBy =
    sort === "created" ? "m.created_at DESC, m.id DESC"
    : sort === "importance" ? "m.importance DESC, m.created_at DESC"
    : sort === "used" ? "m.use_count DESC, m.last_used_at DESC"
    : "(score + m.importance * 0.05) DESC, m.last_used_at DESC";
  // M5: wrap in try-catch to handle any FTS5 syntax errors gracefully
  let rows: MemoryRow[];
  try {
    rows = database
      .prepare(
        `SELECT m.*, -bm25(memories_fts, 1.0, 2.0) AS score
         FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? ${filter}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params) as MemoryRow[];
  } catch {
    return [];
  }
  return rows.filter((row) => typeof row.score !== "number" || row.score >= minScore);
}

/**
 * MEM-3: the pool a project's writes draw down is its own rows plus the
 * shared global rows. memory.db is one file shared by every project, so the
 * old unscoped count/victim query let a burst of inserts in project A evict
 * the oldest/lowest-importance rows of *every* project — the write-side twin
 * of the M3 read-isolation fix. Both the automatic prune (per insert/import)
 * and memory_prune use this predicate, so maxEntries is enforced per project
 * scope rather than pool-wide.
 */
function scopedMemoriesWhere(): string {
  return "WHERE (project = ? OR scope = 'global')";
}

function prune(database: AnyDatabase, cfg: Config, project: string): void {
  if (cfg.maxEntries <= 0) return;
  const where = scopedMemoriesWhere();
  const current = database
    .prepare(`SELECT count(*) AS n FROM memories ${where}`)
    .get(project) as { n: number } | null;
  const total = current?.n ?? 0;
  // M6: only prune when the table exceeds the limit by a threshold (10% or
  // at least 10 entries) to avoid running a DELETE on every single insert.
  const threshold = cfg.maxEntries + Math.max(10, Math.floor(cfg.maxEntries * 0.1));
  if (total <= threshold) return;
  database
    .prepare(
      `DELETE FROM memories WHERE id IN (SELECT id FROM memories ${where} ORDER BY importance ASC, last_used_at ASC, id ASC LIMIT ?)`,
    )
    .run(project, total - cfg.maxEntries);
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
  prune(database, cfg, project);
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
          tags: z.array(z.string()).optional().describe("Filter to memories containing all these tags."),
          minImportance: z.number().min(0).max(10).optional().describe("Minimum importance threshold."),
          sort: z.enum(["relevance", "created", "importance", "used"]).optional().describe("Sort order (default relevance)."),
          // E89: date range filter.
          createdAfter: z.string().optional().describe("Only memories created on/after this ISO date."),
          createdBefore: z.string().optional().describe("Only memories created on/before this ISO date."),
          // E105: project filter.
          project: z.string().optional().describe("Filter by project hash."),
          // E106: session filter.
          session: z.string().optional().describe("Filter by session id."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const scope = args.scope ? resolveScope(args.scope) : null;
            const limit = clampLimit(args.limit ?? cfg.topK, cfg.topK, 100);
            const all = args.all === true || cfg.recallAll;
            const sessionID = toolCtx?.sessionID ?? null;
            const sort = args.sort ?? "relevance";
            const minImportance = args.minImportance ?? 0;
            const requiredTags = Array.isArray(args.tags) ? args.tags : [];
            const filters: SearchFilters = {
              createdAfter: args.createdAfter,
              createdBefore: args.createdBefore,
              project: args.project,
              session: args.session,
            };
            let rows = pageVisible(
              (n, offset) => search(requireDb(), toMatch(args.query, "all"), n, cfg.minScore, scope, sort, offset, filters),
              limit,
              project,
              sessionID,
              all,
            );
            if (requiredTags.length > 0) {
              rows = rows.filter((row) => {
                const rowTags = parseTags(row.tags);
                return requiredTags.every((t) => rowTags.includes(t));
              });
            }
            if (minImportance > 0) {
              rows = rows.filter((row) => row.importance >= minImportance);
            }
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
          all: z.boolean().optional().describe("Allow deleting memories from other projects/sessions (default false)."),
          // E94: limit for query-based delete.
          limit: z.number().int().positive().optional().describe("Max matches to delete (default 50)."),
          // E95: dryRun for both id and query paths.
          dryRun: z.boolean().optional().describe("If true, only show what would be deleted."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const database = requireDb();
            // ME-1: every delete path is filtered through visible() so one
            // project/session cannot wipe global or sibling-project memories.
            const sessionID = toolCtx?.sessionID ?? null;
            // recallAll deliberately does not widen forget: deletion stays explicit per call.
            const all = (args as { all?: boolean }).all === true;
            if (typeof args.id === "number") {
              const existing = database.prepare("SELECT * FROM memories WHERE id = ?").get(args.id) as MemoryRow | null;
              if (!existing || !visible(existing, project, sessionID, all)) return { content: `No memory #${args.id}.` };
              // E95: dryRun for id-based delete.
              if (args.dryRun === true) {
                return { content: `Dry run — would forget #${args.id}: ${formatRow(existing)}` };
              }
              database.prepare("DELETE FROM memories WHERE id = ?").run(args.id);
              dropSeenIds([args.id]);
              return { content: `Forgot #${args.id}.` };
            }
            if (typeof args.query === "string") {
              const match = quoteFtsQuery(args.query);
              if (!match) return { content: "Nothing to forget." };
              // M7: delete in batches to avoid loading thousands of rows into memory.
              // M8: wrap in try-catch to handle FTS5 syntax errors gracefully.
              // E94: limit caps the number of deleted rows.
              // E95: dryRun previews without deleting.
              try {
                const BATCH = 500;
                const limit = args.limit ?? 50;
                const select = database.prepare(
                  "SELECT m.* FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? LIMIT ? OFFSET ?",
                );
                // E95/MEM-5: dry run deletes nothing, so re-querying the same
                // first BATCH rows every round counted each match again — with
                // limit > 500 it reported "would forget 600" for ~500 stored
                // rows. Page with OFFSET and remember ids so every distinct
                // visible match is counted exactly once, capped at `limit`.
                if (args.dryRun === true) {
                  const counted = new Set<number>();
                  const preview: string[] = [];
                  let offset = 0;
                  outer: for (;;) {
                    const fetched = select.all(match, BATCH, offset) as MemoryRow[];
                    if (fetched.length === 0) break;
                    for (const row of fetched) {
                      if (counted.has(row.id) || !visible(row, project, sessionID, all)) continue;
                      counted.add(row.id);
                      // The preview is capped at `limit` lines so a wide dry run
                      // cannot build a megabyte-long tool response.
                      if (preview.length < limit) preview.push(formatRow(row));
                      if (counted.size >= limit) break outer;
                    }
                    if (fetched.length < BATCH) break;
                    offset += fetched.length;
                  }
                  if (counted.size === 0) return { content: "No memories matched." };
                  return {
                    content: `Dry run — would forget ${counted.size} memor${counted.size === 1 ? "y" : "ies"}:\n${preview.join("\n")}`,
                  };
                }
                // M7: delete in batches to avoid loading thousands of rows into memory.
                let deleted = 0;
                for (;;) {
                  // MEM-5: the live path deletes as it goes, so OFFSET 0 keeps
                  // returning fresh rows and the loop terminates correctly.
                  const rows = (select.all(match, BATCH, 0) as MemoryRow[]).filter((row) => visible(row, project, sessionID, all));
                  if (rows.length === 0) break;
                  const batch = rows.slice(0, Math.max(0, limit - deleted));
                  const del = database.prepare("DELETE FROM memories WHERE id = ?");
                  for (const row of batch) del.run(row.id);
                  dropSeenIds(batch.map((row) => row.id));
                  deleted += batch.length;
                  if (deleted >= limit || rows.length < BATCH) break;
                }
                if (deleted === 0) return { content: "No memories matched." };
                return { content: `Forgot ${deleted} memor${deleted === 1 ? "y" : "ies"}.` };
              } catch (err) {
                return { content: `Forget failed: ${err instanceof Error ? err.message : String(err)}` };
              }
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
          all: z.boolean().optional().describe("Include memories from other projects/sessions (default false)."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const database = requireDb();
            const scope = args.scope ? resolveScope(args.scope) : null;
            // Shared clampLimit: trunc + finite guard before LIMIT.
            const limit = clampLimit(args.limit ?? 20, 20, 100);
            // ME-2: apply visible() so cross-session memories do not leak;
            // ME-9: over-fetch in a fetch-more loop so the filter still
            // fills `limit` under restrictive isolation.
            const sessionID = toolCtx?.sessionID ?? null;
            // recallAll deliberately does not widen list: broadening stays explicit per call.
            const all = args.all === true;
            const rows = pageVisible(
              (n, offset) => {
                const fetched = scope
                  ? (database.prepare("SELECT * FROM memories WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(scope, n, offset) as MemoryRow[])
                  : (database.prepare("SELECT * FROM memories ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(n, offset) as MemoryRow[]);
                return fetched;
              },
              limit,
              project,
              sessionID,
              all,
            );
            if (rows.length === 0) return { content: "No memories stored." };
            return { content: rows.map(formatRow).join("\n") };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_stats",
        description: "Show memory totals by scope, tags, projects, use stats, and the active config.",
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
            // E91: top tags (parse JSON, count).
            const tagRows = database.prepare("SELECT tags FROM memories").all() as Array<{ tags: string }>;
            const tagCounts = new Map<string, number>();
            for (const row of tagRows) {
              for (const tag of parseTags(row.tags)) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
              }
            }
            const topTags = [...tagCounts.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .slice(0, 10);
            // E91: top projects.
            const projectRows = database.prepare(
              "SELECT project, count(*) AS n FROM memories WHERE project IS NOT NULL GROUP BY project ORDER BY n DESC LIMIT 10"
            ).all() as Array<{ project: string; n: number }>;
            // E91: average importance.
            const avgImp = database.prepare("SELECT avg(importance) AS a FROM memories").get() as { a: number | null } | null;
            // E91: oldest/newest memory dates.
            const oldest = database.prepare("SELECT min(created_at) AS d FROM memories").get() as { d: string | null } | null;
            const newest = database.prepare("SELECT max(created_at) AS d FROM memories").get() as { d: string | null } | null;
            // E92: use_count statistics.
            const useStats = database.prepare("SELECT sum(use_count) AS s, avg(use_count) AS a FROM memories").get() as { s: number | null; a: number | null } | null;
            const topUsed = database.prepare(
              "SELECT id, text, use_count FROM memories ORDER BY use_count DESC LIMIT 5"
            ).all() as Array<{ id: number; text: string; use_count: number }>;
            // E109: seen map stats.
            let seenEntries = 0;
            for (const entry of currentSeen?.values() ?? []) {
              seenEntries += entry.ids.size;
            }
            const lines = [
              `memories: ${total?.n ?? 0} (${byScope})`,
              `db: ${DB_PATH} (size: ${size})`,
              `config: scope=${cfg.scope} topK=${cfg.topK} budgetChars=${cfg.budgetChars} minScore=${cfg.minScore} autoRecall=${cfg.autoRecall} maxEntries=${cfg.maxEntries === 0 ? "unlimited" : cfg.maxEntries}`,
            ];
            if (topTags.length > 0) {
              lines.push(`top tags: ${topTags.map(([t, n]) => `${t}=${n}`).join(" ")}`);
            }
            if (projectRows.length > 0) {
              lines.push(`top projects: ${projectRows.map((p) => `${p.project}=${p.n}`).join(" ")}`);
            }
            lines.push(`avg importance: ${avgImp?.a != null ? avgImp.a.toFixed(1) : "?"}`);
            lines.push(`oldest: ${oldest?.d ?? "?"} | newest: ${newest?.d ?? "?"}`);
            lines.push(`use_count: total=${useStats?.s ?? 0} avg=${useStats?.a != null ? useStats.a.toFixed(1) : "?"}`);
            if (topUsed.length > 0) {
              lines.push(`most used: ${topUsed.map((m) => `#${m.id}(${m.use_count})`).join(" ")}`);
            }
            lines.push(`seenSessions=${currentSeen?.size ?? 0} seenEntries=${seenEntries}`);
            return { content: lines.join("\n") };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_update",
        description: "Update an existing memory's text, importance, tags, or scope. Bumps last_used_at.",
        input: z.object({
          id: z.number().int().positive().describe("Memory id to update."),
          text: z.string().min(1).optional().describe("New text (recomputes hash, checks duplicates)."),
          importance: z.number().min(0).max(10).optional().describe("New importance 0-10."),
          tags: z.array(z.string()).optional().describe("New tags (replaces existing)."),
          scope: scopeSchema.optional().describe("New scope."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const database = requireDb();
            const sessionID = toolCtx?.sessionID ?? null;
            const existing = database.prepare("SELECT * FROM memories WHERE id = ?").get(args.id) as MemoryRow | null;
            if (!existing || !visible(existing, project, sessionID, false)) {
              return { content: `No memory #${args.id}.` };
            }
            const newText = args.text !== undefined ? truncateStored(scrubStore(args.text), STORE_CAPS.memoryText) : existing.text;
            const newImportance = args.importance !== undefined ? resolveImportance(args.importance) : existing.importance;
            const newTags = args.tags !== undefined ? (Array.isArray(args.tags) ? args.tags : []).map((t) => scrubStore(t)) : parseTags(existing.tags);
            const newScope = args.scope !== undefined ? resolveScope(args.scope) : (existing.scope as Scope);
            const proj = newScope === "global" ? null : project;
            const sid = newScope === "session" ? sessionID : null;
            if (args.text !== undefined) {
              const newHash = hashText(normalizeText(newText));
              const dup = database
                .prepare("SELECT id FROM memories WHERE hash = ? AND scope = ? AND project IS ? AND session_id IS ? AND id != ? LIMIT 1")
                .get(newHash, newScope, proj, sid, args.id) as { id: number } | null;
              if (dup) {
                return { content: `Duplicate of #${dup.id} — not updated.` };
              }
              database
                .prepare("UPDATE memories SET text = ?, hash = ?, scope = ?, project = ?, session_id = ?, importance = ?, tags = ?, last_used_at = datetime('now') WHERE id = ?")
                .run(newText, newHash, newScope, proj, sid, newImportance, JSON.stringify(newTags), args.id);
            } else {
              database
                .prepare("UPDATE memories SET scope = ?, project = ?, session_id = ?, importance = ?, tags = ?, last_used_at = datetime('now') WHERE id = ?")
                .run(newScope, proj, sid, newImportance, JSON.stringify(newTags), args.id);
            }
            return { content: `Updated #${args.id}.` };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_export",
        description: "Export memories as JSON or Markdown for backup, migration, or sharing.",
        input: z.object({
          format: z.enum(["json", "markdown"]).optional().describe("Export format (default json)."),
          scope: scopeSchema.optional().describe("Restrict to one scope."),
          all: z.boolean().optional().describe("Include memories from other projects/sessions (default false)."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const database = requireDb();
            const sessionID = toolCtx?.sessionID ?? null;
            const all = args.all === true;
            const scope = args.scope ? resolveScope(args.scope) : null;
            const format = args.format ?? "json";
            const rows = pageVisible(
              (n, offset) => {
                const fetched = scope
                  ? (database.prepare("SELECT * FROM memories WHERE scope = ? ORDER BY id ASC LIMIT ? OFFSET ?").all(scope, n, offset) as MemoryRow[])
                  : (database.prepare("SELECT * FROM memories ORDER BY id ASC LIMIT ? OFFSET ?").all(n, offset) as MemoryRow[]);
                return fetched;
              },
              1000,
              project,
              sessionID,
              all,
            );
            if (rows.length === 0) return { content: "No memories to export." };
            if (format === "markdown") {
              const lines = rows.map((row) => {
                const tags = parseTags(row.tags);
                const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
                return `- **#${row.id}** [${row.scope}] imp=${row.importance}${tagStr}: ${row.text.replace(/\s+/g, " ").trim()}`;
              });
              return { content: lines.join("\n") };
            }
            const data = rows.map((row) => ({
              id: row.id,
              text: row.text,
              scope: row.scope,
              project: row.project,
              session_id: row.session_id,
              importance: row.importance,
              tags: parseTags(row.tags),
              created_at: row.created_at,
              last_used_at: row.last_used_at,
              use_count: row.use_count,
            }));
            return { content: JSON.stringify(data, null, 2) };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_tags",
        description: "List all tags and their frequency across memories.",
        input: z.object({}),
        execute: async () => {
          try {
            const database = requireDb();
            const rows = database.prepare("SELECT tags FROM memories").all() as Array<{ tags: string }>;
            const counts = new Map<string, number>();
            for (const row of rows) {
              for (const tag of parseTags(row.tags)) {
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
              }
            }
            if (counts.size === 0) return { content: "No tags found." };
            const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            return { content: sorted.map(([tag, n]) => `${tag}: ${n}`).join("\n") };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "memory_prune",
        description: "Manually trigger pruning of low-importance, least-recently-used memories when maxEntries is set. Only this project's rows (plus shared global ones) are candidates.",
        input: z.object({
          dryRun: z.boolean().optional().describe("If true (default), only show what would be deleted without deleting."),
        }),
        execute: async (args) => {
          try {
            const database = requireDb();
            if (cfg.maxEntries <= 0) {
              return { content: "Pruning is disabled (maxEntries is 0/unlimited)." };
            }
            // MEM-3: count and victims are scoped to this project (+ global),
            // so pruning here can never silently destroy another project's
            // memories in the shared database.
            const where = scopedMemoriesWhere();
            const current = database
              .prepare(`SELECT count(*) AS n FROM memories ${where}`)
              .get(project) as { n: number } | null;
            const total = current?.n ?? 0;
            if (total <= cfg.maxEntries) {
              return { content: `No pruning needed (${total}/${cfg.maxEntries} for this project).` };
            }
            const toDelete = total - cfg.maxEntries;
            const victims = database
              .prepare(`SELECT id, text, importance, last_used_at FROM memories ${where} ORDER BY importance ASC, last_used_at ASC, id ASC LIMIT ?`)
              .all(project, toDelete) as Array<{ id: number; text: string; importance: number; last_used_at: string }>;
            if (args.dryRun !== false) {
              const lines = victims.map((v) => `#${v.id} imp=${v.importance} last_used=${formatAge(v.last_used_at)} ${v.text.replace(/\s+/g, " ").trim().slice(0, 80)}`);
              return { content: `Dry run — would delete ${toDelete} memor${toDelete === 1 ? "y" : "ies"} (this project + global pool, ${total}/${cfg.maxEntries}):\n${lines.join("\n")}` };
            }
            const del = database.prepare("DELETE FROM memories WHERE id = ?");
            for (const v of victims) del.run(v.id);
            dropSeenIds(victims.map((v) => v.id));
            return { content: `Pruned ${toDelete} memor${toDelete === 1 ? "y" : "ies"} from this project (now ${total - toDelete}/${cfg.maxEntries}).` };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      // E83: bulk import tool.
      editor.add({
        name: "memory_import",
        description: "Bulk-import memories from a JSON array. Dedupes against existing entries.",
        input: z.object({
          memories: z.array(z.object({
            text: z.string().min(1),
            scope: scopeSchema.optional(),
            importance: z.number().min(0).max(10).optional(),
            tags: z.array(z.string()).optional(),
          })).describe("Array of memory objects to import."),
          mode: z.enum(["skip", "replace"]).optional().describe("skip (default) keeps existing duplicates; replace updates them."),
        }),
        execute: async (args, toolCtx) => {
          try {
            const database = requireDb();
            const sessionID = toolCtx?.sessionID ?? null;
            const mode = args.mode ?? "skip";
            let inserted = 0;
            let skipped = 0;
            let replaced = 0;
            for (const item of args.memories) {
              const scope = resolveScope(item.scope);
              const importance = resolveImportance(item.importance);
              const tags = (Array.isArray(item.tags) ? item.tags : []).map((t) => scrubStore(t));
              const text = truncateStored(scrubStore(item.text), STORE_CAPS.memoryText);
              const hash = hashText(normalizeText(text));
              const proj = scope === "global" ? null : project;
              const sid = scope === "session" ? sessionID : null;
              const found = database
                .prepare("SELECT id, importance, use_count FROM memories WHERE hash = ? AND scope = ? AND project IS ? AND session_id IS ? LIMIT 1")
                .get(hash, scope, proj, sid) as { id: number; importance: number; use_count: number } | null;
              if (found) {
                if (mode === "replace") {
                  database
                    .prepare("UPDATE memories SET text = ?, importance = ?, tags = ?, last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?")
                    .run(text, Math.max(found.importance, importance), JSON.stringify(tags), found.id);
                  replaced += 1;
                } else {
                  skipped += 1;
                }
                continue;
              }
              database
                .prepare("INSERT INTO memories (text, hash, scope, project, session_id, importance, tags) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .run(text, hash, scope, proj, sid, importance, JSON.stringify(tags));
              inserted += 1;
            }
            prune(database, cfg, project);
            return { content: `Imported ${inserted} new, replaced ${replaced}, skipped ${skipped} duplicates.` };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      // E86: bulk clear tool.
      editor.add({
        name: "memory_clear",
        description: "Bulk-delete memories by scope, tag, or project. Requires explicit confirmation.",
        input: z.object({
          scope: scopeSchema.optional().describe("Only delete memories in this scope."),
          tag: z.string().optional().describe("Only delete memories with this tag."),
          project: z.string().optional().describe("Only delete memories from this project hash."),
          all: z.boolean().optional().describe("Include memories from other projects/sessions (default false)."),
          confirm: z.boolean().optional().describe("Must be true to actually delete."),
        }),
        execute: async (args, toolCtx) => {
          try {
            if (args.confirm !== true) {
              return { content: "Clear not confirmed. Pass confirm: true to delete." };
            }
            const database = requireDb();
            const sessionID = toolCtx?.sessionID ?? null;
            const all = args.all === true;
            const conditions: string[] = [];
            const params: unknown[] = [];
            if (args.scope) {
              conditions.push("scope = ?");
              params.push(args.scope);
            }
            if (args.tag) {
              conditions.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)");
              params.push(args.tag);
            }
            if (args.project) {
              conditions.push("project = ?");
              params.push(args.project);
            }
            if (conditions.length === 0) {
              return { content: "No filter provided — specify scope, tag, or project." };
            }
            const where = `WHERE ${conditions.join(" AND ")}`;
            const rows = database.prepare(`SELECT * FROM memories ${where}`).all(...params) as MemoryRow[];
            const visibleRows = rows.filter((row) => visible(row, project, sessionID, all));
            if (visibleRows.length === 0) return { content: "No memories matched." };
            const del = database.prepare("DELETE FROM memories WHERE id = ?");
            for (const row of visibleRows) del.run(row.id);
            dropSeenIds(visibleRows.map((row) => row.id));
            return { content: `Cleared ${visibleRows.length} memor${visibleRows.length === 1 ? "y" : "ies"}.` };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      // E93: config tool.
      editor.add({
        name: "memory_config",
        description: "Show the resolved memory plugin configuration.",
        input: z.object({}),
        execute: async () => {
          return {
            content: [
              `enabled: ${cfg.enabled}`,
              `autoRecall: ${cfg.autoRecall}`,
              `budgetChars: ${cfg.budgetChars}`,
              `topK: ${cfg.topK}`,
              `minScore: ${cfg.minScore}`,
              `scope: ${cfg.scope}`,
              `maxEntries: ${cfg.maxEntries === 0 ? "unlimited" : cfg.maxEntries}`,
              `recallAll: ${cfg.recallAll}`,
              `log: ${cfg.log}`,
              `autoRecallExcludeTags: [${cfg.autoRecallExcludeTags.join(", ")}]`,
              `autoRecallMinImportance: ${cfg.autoRecallMinImportance}`,
            ].join("\n"),
          };
        },
      });

      // E101: vacuum tool.
      editor.add({
        name: "memory_vacuum",
        description: "Reclaim disk space by running VACUUM on the memory database.",
        input: z.object({}),
        execute: async () => {
          try {
            const database = requireDb();
            let before = "unknown";
            try {
              const bytes = statSync(DB_PATH).size;
              before = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
            } catch { /* ignore */ }
            database.exec("VACUUM");
            let after = "unknown";
            try {
              const bytes = statSync(DB_PATH).size;
              after = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
            } catch { /* ignore */ }
            return { content: `Vacuumed. Size before: ${before}, after: ${after}.` };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      // E102: rebuild FTS tool.
      editor.add({
        name: "memory_rebuild_fts",
        description: "Rebuild the FTS index from the memories table.",
        input: z.object({}),
        execute: async () => {
          try {
            const database = requireDb();
            database.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
            return { content: "FTS index rebuilt." };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });
    });

    const seen = new Map<string, SeenEntry>();
    const seenStoreKey = `memory:seen:${project}`;

    const serializeSeen = (): Record<string, { ids: number[]; at: number; chars: number; lastInjectAt: number }> => {
      const obj: Record<string, { ids: number[]; at: number; chars: number; lastInjectAt: number }> = {};
      for (const [key, entry] of seen) {
        obj[key] = { ids: [...entry.ids].slice(-MAX_SEEN_IDS), at: entry.at, chars: entry.chars, lastInjectAt: entry.lastInjectAt };
      }
      return obj;
    };
    const saveSeen = (): void => {
      try {
        void ctx.storage?.set?.(seenStoreKey, serializeSeen());
      } catch (err) {
        console.error(`[memory] failed to persist seen map: ${err instanceof Error ? err.message : String(err)}`);
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
          const v = value as { ids?: unknown; at?: unknown; chars?: unknown; lastInjectAt?: unknown };
          if (!Array.isArray(v.ids) || typeof v.at !== "number" || now - v.at > SEEN_TTL_MS) continue;
          const ids = v.ids.filter((id): id is number => typeof id === "number").slice(-MAX_SEEN_IDS);
          seen.set(key, { ids: new Set(ids), at: v.at, chars: typeof v.chars === "number" ? v.chars : 0, lastInjectAt: typeof v.lastInjectAt === "number" ? v.lastInjectAt : v.at });
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
        // E96: filter out memories with excluded tags.
        if (cfg.autoRecallExcludeTags.length > 0) {
          const excluded = new Set(cfg.autoRecallExcludeTags);
          for (let i = rows.length - 1; i >= 0; i--) {
            const rowTags = parseTags(rows[i].tags);
            if (rowTags.some((t) => excluded.has(t))) rows.splice(i, 1);
          }
        }
        // E97: filter by minimum importance.
        if (cfg.autoRecallMinImportance > 0) {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].importance < cfg.autoRecallMinImportance) rows.splice(i, 1);
          }
        }
        if (rows.length === 0) return;
        // ME-7: single expression for the session key ("" vs null mismatch).
        const key = recallSessionID ?? "";
        const now = Date.now();
        let entry = seen.get(key);
        if (!entry) {
          entry = { ids: new Set<number>(), at: now, chars: 0, lastInjectAt: now };
          seen.set(key, entry);
        }
        entry.at = now;
        // M10: reset chars after a sliding window of inactivity so a session
        // that hit the budget can inject again after an idle period.
        if (now - entry.lastInjectAt > CHARS_RESET_MS) entry.chars = 0;
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
        entry.lastInjectAt = now;
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
      // MEM-2: the module-level singleton has to go with the handle it points
      // at. decision-log/error-journal null theirs here; memory.ts left `db`
      // set, so the next setup() (hot reload, or a second project's setup
      // after this one tore down — the multi-setup scenario of M62) got a
      // closed handle back from getDb(), every query threw, and all tools
      // answered "Storage unavailable" forever.
      if (database && db === database) db = null;
      database = null;
      currentSeen = null;
      currentSweep = null;
    };
  },
});


