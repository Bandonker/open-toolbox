import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  openDatabase,
  applyPragmas,
  maybeBackupDb,
  latestValidBackup,
  checkOpenDb,
  isCorruption,
  parseStringArray,
  quoteFtsQuery,
  dbUnavailable,
  clampLimit,
  copyBackupIntoPlace,
  hasTriggers,
  truncateStored,
  vacuum,
  rebuildFts,
  buildTagFilter,
  STORE_CAPS,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { redactSecrets } from "../lib/redact.ts";
import { formatAge, projectHash } from "../lib/format.ts";
import { asBool } from "../lib/config.ts";

const DB_DIR = join(homedir(), ".opencode-plugins", "decision-log");
const DB_PATH = join(DB_DIR, "decision-log.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;
const DECISION_STATUSES = ["proposed", "accepted", "deprecated", "superseded"] as const;
/** DL-1: appended whenever a read had to fall back to project scoping because
 * the caller carried no sessionID (the old code fell *open* in that case). */
const SCOPED_BY_PROJECT_NOTE =
  "\n(session context unavailable — results are scoped to this project; pass all: true to widen)";
// E150/DL-2: autoProject is resolved per setup() from ctx.options (env
// fallback) and the project tag is now the session's location directory hashed
// like memory.ts does — see setup(). The old module-level `let autoProject =
// true` plus process.cwd() labelled every row with the server's cwd and could
// never be changed, so decision_config reported a fiction.
/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
// DL-7: read the flag lazily (call time, not module load) so runtime
// toggles and tests take effect without a re-import. Default-on, like before.
function storeRedactOn(): boolean {
  return process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
}

function scrubStore(text: string): string {
  return storeRedactOn() ? redactSecrets(text) : text;
}

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    // DL-2: mkdir inside try so a creation failure routes to backup-restore
    // instead of escaping as an unhandled throw.
    try {
      if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
      db = openDatabase(DB_PATH);
      applyPragmas(db);
      initSchema(db);
    } catch (e) {
      try {
        db = tryRestore();
      } catch {
        db = null;
      }
      if (!db) throw e;
    }
  }
  return db;
}

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      title TEXT NOT NULL,
      context TEXT,
      decision TEXT NOT NULL,
      consequences TEXT,
      status TEXT NOT NULL DEFAULT 'accepted',
      superseded_by INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const row = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
    .get() as { name: string } | null;

  const createdFts = !row;
  if (createdFts) {
    database.exec(`
      CREATE VIRTUAL TABLE decisions_fts USING fts5(
        title,
        context,
        decision,
        consequences,
        tags,
        content=decisions,
        content_rowid=id,
        tokenize='porter'
      )
    `);
  }

  // D1: triggers are ensured on every open, not only when the FTS table was
  // just created — a dropped/desynced trigger must not silently stop making
  // new decisions searchable.
  // CR-9: verify all three triggers (ai/ad/au), not just the insert one.
  const hadTriggers = hasTriggers(database, ["decisions_ai", "decisions_ad", "decisions_au"]);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
      INSERT INTO decisions_fts(rowid, title, context, decision, consequences, tags)
      VALUES (new.id, new.title, COALESCE(new.context, ''), new.decision, COALESCE(new.consequences, ''), new.tags);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences, tags)
      VALUES ('delete', old.id, old.title, COALESCE(old.context, ''), old.decision, COALESCE(old.consequences, ''), old.tags);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences, tags)
      VALUES ('delete', old.id, old.title, COALESCE(old.context, ''), old.decision, COALESCE(old.consequences, ''), old.tags);
      INSERT INTO decisions_fts(rowid, title, context, decision, consequences, tags)
      VALUES (new.id, new.title, COALESCE(new.context, ''), new.decision, COALESCE(new.consequences, ''), new.tags);
    END
  `);

  if (createdFts) {
    // Backfill existing rows into the freshly created (empty) index.
    database.exec(`
      INSERT INTO decisions_fts(rowid, title, context, decision, consequences, tags)
      SELECT id, title, COALESCE(context, ''), decision, COALESCE(consequences, ''), tags FROM decisions
    `);
  } else if (!hadTriggers) {
    // The index existed but the sync triggers were missing: rebuild it so
    // past and future rows are consistent again.
    database.exec(`INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')`);
  }
}

function backup(): void {
  maybeBackupDb({
    dbPath: DB_PATH,
    backupDir: BACKUP_DIR,
    maxBackups: MAX_BACKUPS,
    lastBackupTime: () => lastBackupTime,
    setLastBackupTime: (t) => { lastBackupTime = t; },
  });
}

function tryRestore(): AnyDatabase | null {
  const latest = latestValidBackup(BACKUP_DIR);
  if (!latest) return null;
  // D2: close the failing handle first (an open handle blocks the copy on
  // Windows) and drop stale -wal/-shm so they cannot be replayed on top of
  // the restored snapshot.
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  // CR-8: I/O wrapped with context (copyBackupIntoPlace); it also drops
  // -wal/-shm/-journal so they cannot be replayed on the restored snapshot.
  try {
    copyBackupIntoPlace(DB_PATH, latest);
  } catch {
    return null;
  }
  let restored: AnyDatabase;
  try {
    restored = openDatabase(DB_PATH);
    applyPragmas(restored);
    initSchema(restored);
  } catch {
    return null;
  }
  // J1: verify the restored copy on its own handle — the pre-copy backup
  // check cannot catch a copy that lands corrupt. Never serve it silently.
  try {
    if (!checkOpenDb(restored)) {
      try { restored.close(); } catch { /* ignore */ }
      return null;
    }
  } catch {
    try { restored.close(); } catch { /* ignore */ }
    return null;
  }
  return restored;
}

function withRetry<T>(fn: () => T, isWrite = false): T | string {
  try {
    const result = fn();
    if (isWrite) { try { backup(); } catch {} }
    return result;
  } catch (err) {
    if (isCorruption(err)) {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      try {
        db = tryRestore();
      } catch {
        db = null;
      }
      if (db) {
        // CR-3: the retried call can fail too — route it to dbUnavailable
        // instead of throwing out of the tool.
        try {
          const result = fn();
          if (isWrite) { try { backup(); } catch {} }
          return result;
        } catch (retryErr) {
          return dbUnavailable(retryErr);
        }
      }
      // CR-3/J1: the store is corrupt and no valid backup could be restored.
      // Surface the underlying failure through the canonical dbUnavailable
      // message ("Storage unavailable: …") instead of a bare string, so the
      // cause reaches the caller and the restore path stays consistent.
      return dbUnavailable(err);
    }
    // CR-3: never throw storage failures out of tools — every caller uses
    // the result as tool `content`, so surface a readable message instead.
    return dbUnavailable(err);
  }
}

interface DecisionRow {
  id: number;
  session_id: string | null;
  title: string;
  context: string | null;
  decision: string;
  consequences: string | null;
  status: string;
  superseded_by: number | null;
  tags: string;
  project: string | null;
  created_at: string;
  updated_at: string;
}

function formatDecision(row: DecisionRow): string {
  const tags = parseStringArray(row.tags);
  const lines: string[] = [];
  lines.push(`**#${row.id} — ${row.title}**`);
  lines.push(`Status: ${row.status}`);
  if (row.project) lines.push(`Project: ${row.project}`);
  if (row.session_id) lines.push(`Session: ${row.session_id}`);
  if (row.context) lines.push(`Context: ${row.context}`);
  lines.push(`Decision: ${row.decision}`);
  if (row.consequences) lines.push(`Consequences: ${row.consequences}`);
  if (row.superseded_by) lines.push(`Superseded by: #${row.superseded_by}`);
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push(`Created: ${row.created_at} (${formatAge(row.created_at)}) | Updated: ${row.updated_at}`);
  return lines.join("\n");
}

export default Plugin.define({
  id: "decision-log",
  async setup(ctx) {
    // E150/DL-2: real configuration for the project tag. Options win, then the
    // environment, then the default; the tag itself is the *session's* location
    // directory hashed exactly like memory.ts tags rows, so one server serving
    // several projects no longer labels every row with the same process cwd.
    const autoProject = asBool(
      ctx.options?.autoProject ?? process.env.OPENCODE_DECISION_LOG_AUTO_PROJECT,
      true,
    );
    const autoScope = autoProject
      ? projectHash(ctx.location?.directory ?? process.cwd())
      : null;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "decision_log",
        description:
          "Record a new architectural or design decision. Use this when the user makes a choice, answers a question with a preference, or when a significant technical decision is made during the session.",
        input: z.object({
          title: z.string().describe("Short title summarizing the decision"),
          decision: z.string().describe("What was decided"),
          context: z.string().optional().describe("Why this question came up — the situation or problem"),
          consequences: z.string().optional().describe("Expected effects, tradeoffs, or implications"),
          status: z.enum(DECISION_STATUSES).optional().describe("Decision status: proposed, accepted (default), deprecated, superseded"),
          tags: z.array(z.string()).optional().describe("Categorization tags"),
          project: z.string().optional().describe("Project this decision applies to"),
        }),
        execute: async (input, toolCtx) => {
          const out = withRetry(() => {
            const database = getDb();
            const status = input.status || "accepted";
            const tags = JSON.stringify(input.tags || []);
            // E150/DL-2: caller-provided project wins; otherwise tag with the
            // hashed session location directory (autoScope), never the cwd.
            const project = input.project || autoScope;
            const stmt = database.prepare(
              "INSERT INTO decisions (session_id, title, context, decision, consequences, status, tags, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            );
            const result = stmt.run(
              toolCtx.sessionID || null,
              // CR-4: cap unbounded inputs into DB/FTS (title 500, bodies 20k).
              truncateStored(scrubStore(input.title), STORE_CAPS.decisionTitle),
              input.context ? truncateStored(scrubStore(input.context), STORE_CAPS.decisionBody) : null,
              truncateStored(scrubStore(input.decision), STORE_CAPS.decisionBody),
              input.consequences ? truncateStored(scrubStore(input.consequences), STORE_CAPS.decisionBody) : null,
              status,
              tags,
              project
            ) as { lastInsertRowid: number | bigint };
            return `Logged decision #${result.lastInsertRowid}: "${input.title}" [${status}]`;
          }, true);
          return { content: out };
        },
      });

      // E135: bulk import tool.
      editor.add({
        name: "decision_import",
        description: "Bulk-import decisions from a JSON array.",
        input: z.object({
          decisions: z.array(z.object({
            title: z.string(),
            decision: z.string(),
            context: z.string().optional(),
            consequences: z.string().optional(),
            status: z.enum(DECISION_STATUSES).optional(),
            tags: z.array(z.string()).optional(),
            project: z.string().optional(),
          })).describe("Array of decision objects to import."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { decisions: Array<{ title: string; decision: string; context?: string; consequences?: string; status?: string; tags?: string[]; project?: string }> };
          const out = withRetry(() => {
            const database = getDb();
            let imported = 0;
            for (const item of args.decisions) {
              const status = item.status || "accepted";
              const tags = JSON.stringify(item.tags || []);
              database.prepare(
                "INSERT INTO decisions (session_id, title, context, decision, consequences, status, tags, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
              ).run(
                toolCtx.sessionID || null,
                truncateStored(scrubStore(item.title), STORE_CAPS.decisionTitle),
                item.context ? truncateStored(scrubStore(item.context), STORE_CAPS.decisionBody) : null,
                truncateStored(scrubStore(item.decision), STORE_CAPS.decisionBody),
                item.consequences ? truncateStored(scrubStore(item.consequences), STORE_CAPS.decisionBody) : null,
                status,
                tags,
                item.project || null
              );
              imported += 1;
            }
            return `Imported ${imported} decision(s)`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "decision_get",
        description: "Get a specific decision by its ID.",
        input: z.object({
          id: z.number().describe("Decision ID"),
        }),
        execute: async (input) => {
          const args = input;
          const out = withRetry(() => {
            const database = getDb();
            const row = database.prepare("SELECT * FROM decisions WHERE id = ?").get(args.id) as DecisionRow | null;
            if (!row) return `Decision #${args.id} not found.`;
            // E149: fetch related decisions.
            let result = formatDecision(row);
            if (row.superseded_by) {
              const sup = database
                .prepare("SELECT * FROM decisions WHERE id = ?")
                .get(row.superseded_by) as DecisionRow | null;
              if (sup) result += `\n\nSuperseded by: ${formatDecision(sup)}`;
            }
            const supers = database
              .prepare("SELECT * FROM decisions WHERE superseded_by = ?")
              .all(args.id) as DecisionRow[];
            if (supers.length > 0) {
              result += `\n\nSupersedes:\n${supers.map(formatDecision).join("\n---\n")}`;
            }
            return result;
          });
          return { content: out };
        },
      });

      editor.add({
        name: "decision_search",
        description:
          "Search decisions using full-text search. Scoped to current session by default. Matches against title, context, decision, consequences, and tags.",
        input: z.object({
          query: z.string().describe("Search query (words are matched literally; FTS5 operators are not interpreted)"),
          all: z.boolean().optional().describe("Search across all sessions (default: false, current session only)"),
          project: z.string().optional().describe("Filter by project (parity with decision_list)"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          limit: z.number().optional().describe("Max results (default: 10)"),
          // E138: status filter.
          status: z.enum(DECISION_STATUSES).optional().describe("Filter by status"),
          // E139: date range filter.
          createdAfter: z.string().optional().describe("Only decisions created on/after this ISO date."),
          createdBefore: z.string().optional().describe("Only decisions created on/before this ISO date."),
          // E152: sort option.
          sort: z.enum(["relevance", "created", "updated"]).optional().describe("Sort order (default: relevance)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input;
          const out = withRetry(() => {
            const database = getDb();
            const q = quoteFtsQuery(args.query);
            if (!q) return "No decisions found. (empty query)";
            // DL-6: trunc + finite guard via shared clampLimit.
            const limit = clampLimit(args.limit ?? 10, 10, 50);
            let sql = `SELECT d.* FROM decisions d
                 JOIN decisions_fts f ON d.id = f.rowid
                 WHERE decisions_fts MATCH ?`;
            const params: unknown[] = [q];
            // DL-1: set when a missing toolCtx.sessionID forced project scoping.
            let scopeNote = "";

            if (!args.all) {
              // DL-1: the scope check used to be `if (!args.all &&
              // toolCtx.sessionID)`, so a call without a sessionID fell open to
              // every session's rows. No session to scope by now scopes by this
              // project — and the output says so.
              if (toolCtx.sessionID) {
                sql += " AND d.session_id = ?";
                params.push(toolCtx.sessionID);
              } else {
                sql += " AND d.project = ?";
                params.push(autoScope ?? "");
                scopeNote = SCOPED_BY_PROJECT_NOTE;
              }
            }

            // DL-8: project filter parity with decision_list.
            if (args.project) {
              sql += " AND d.project = ?";
              params.push(args.project);
            }

            // E137: tag filter parity with decision_list.
            const tagFilter = buildTagFilter(args.tags ?? [], "d.tags");
            if (tagFilter.clause) {
              sql += tagFilter.clause;
              params.push(...tagFilter.params);
            }

            // E138: status filter.
            if (args.status) {
              sql += " AND d.status = ?";
              params.push(args.status);
            }

            // E139: date range filter.
            if (args.createdAfter) {
              sql += " AND d.created_at >= ?";
              params.push(args.createdAfter);
            }
            if (args.createdBefore) {
              sql += " AND d.created_at <= ?";
              params.push(args.createdBefore);
            }

            // E152: sort option.
            if (args.sort === "created") {
              sql += " ORDER BY d.created_at DESC, d.id DESC";
            } else if (args.sort === "updated") {
              sql += " ORDER BY d.updated_at DESC, d.id DESC";
            } else {
              // E151: weighted bm25 — title 2x, tags 0.5x.
              sql += " ORDER BY bm25(decisions_fts, 2.0, 1.0, 1.0, 1.0, 0.5)";
            }
            sql += " LIMIT ?";
            params.push(limit);

            const rows = database.prepare(sql).all(...params) as DecisionRow[];

            if (rows.length === 0) return `No decisions found.${scopeNote}`;
            return rows.map(formatDecision).join("\n\n---\n\n") + scopeNote;
          });
          return { content: out };
        },
      }),

      editor.add({
        name: "decision_list",
        description:
          "List decisions from the current session, optionally filtered by status, tags, or project. Use all to see decisions from other sessions.",
        input: z.object({
          status: z.enum(DECISION_STATUSES).optional().describe("Filter by status: proposed, accepted, deprecated, superseded"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          project: z.string().optional().describe("Filter by project name"),
          all: z.boolean().optional().describe("Show decisions from all sessions (default: false)"),
          sort: z.enum(["created", "updated", "status"]).optional().describe("Sort order (default: created)"),
          limit: z.number().optional().describe("Max results (default: 20)"),
          // E141: FTS query filter.
          query: z.string().optional().describe("Full-text search query"),
          // E148: superseded filter.
          superseded: z.boolean().optional().describe("Filter: true = superseded only, false = non-superseded only"),
        }),
        execute: async (input, toolCtx) => {
          const args = input;
          const out = withRetry(() => {
            const database = getDb();
            // DL-6: trunc + finite guard via shared clampLimit.
            const limit = clampLimit(args.limit ?? 20, 20, 100);
            let where = "WHERE 1=1";
            const params: unknown[] = [];
            // DL-1: see decision_search — no sessionID scopes by project now.
            let scopeNote = "";

            if (!args.all) {
              if (toolCtx.sessionID) {
                where += " AND session_id = ?";
                params.push(toolCtx.sessionID);
              } else {
                where += " AND project = ?";
                params.push(autoScope ?? "");
                scopeNote = SCOPED_BY_PROJECT_NOTE;
              }
            }
            if (args.status) {
              where += " AND status = ?";
              params.push(args.status);
            }
            if (args.project) {
              where += " AND project = ?";
              params.push(args.project);
            }
            // D3: exact tag match against the JSON array — substring LIKE
            // matching produced false positives (e.g. "api" matching "api-v2").
            const tagFilter = buildTagFilter(args.tags ?? [], "decisions.tags");
            if (tagFilter.clause) {
              where += tagFilter.clause;
              params.push(...tagFilter.params);
            }

            // E141: FTS query filter.
            if (args.query) {
              const q = quoteFtsQuery(args.query);
              if (q) {
                where += " AND id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)";
                params.push(q);
              }
            }

            // E148: superseded filter.
            if (args.superseded === true) {
              where += " AND superseded_by IS NOT NULL";
            } else if (args.superseded === false) {
              where += " AND superseded_by IS NULL";
            }

            // E140: sort option.
            const orderBy = args.sort === "updated"
              ? "updated_at DESC"
              : args.sort === "status"
                ? "status ASC, created_at DESC"
                : "created_at DESC";

            const rows = database.prepare(
              `SELECT *, COUNT(*) OVER() as _total FROM decisions ${where} ORDER BY ${orderBy} LIMIT ?`
            ).all(...params, limit);

            if (rows.length === 0) return `No decisions found.${scopeNote}`;

            const total = rows[0]._total;
            const header = `Showing ${rows.length} of ${total} matching decisions:\n\n`;
            return header + rows.map(formatDecision).join("\n\n---\n\n") + scopeNote;
          });
          return { content: out };
        },
      });

      editor.add({
        name: "decision_update",
        description:
          "Update an existing decision. Change status (e.g., deprecate or supersede), edit fields, or add consequences learned later.",
        input: z.object({
          id: z.number().describe("Decision ID to update"),
          title: z.string().optional().describe("New title"),
          context: z.string().optional().describe("Updated context"),
          decision: z.string().optional().describe("Updated decision text"),
          consequences: z.string().optional().describe("Updated consequences"),
          status: z.enum(DECISION_STATUSES).optional().describe("New status: proposed, accepted, deprecated, superseded"),
          superseded_by: z.number().optional().describe("ID of the decision that supersedes this one"),
          tags: z.array(z.string()).optional().describe("Replace tags"),
          addTags: z.array(z.string()).optional().describe("Add tags (merged with existing)"),
          removeTags: z.array(z.string()).optional().describe("Remove tags"),
          project: z.string().optional().describe("Update project"),
        }),
        execute: async (input) => {
          const out = withRetry(() => {
            const database = getDb();
            const existing = database.prepare("SELECT * FROM decisions WHERE id = ?").get(input.id) as DecisionRow | null;
            if (!existing) return `Decision #${input.id} not found.`;

            if (input.superseded_by !== undefined) {
              // E144: reject self-supersede.
              if (input.superseded_by === input.id) {
                return "A decision cannot supersede itself.";
              }
              const sup = database
                .query("SELECT id FROM decisions WHERE id = ?")
                .get(input.superseded_by) as { id: number } | null;
              if (!sup) return `Superseded decision #${input.superseded_by} not found`;
              // E145: walk the supersede chain to detect cycles.
              let current: number | null = input.superseded_by;
              const visited = new Set<number>([input.id]);
              while (current !== null) {
                if (visited.has(current)) {
                  return "Supersede cycle detected.";
                }
                visited.add(current);
                const row = database
                  .query("SELECT superseded_by FROM decisions WHERE id = ?")
                  .get(current) as { superseded_by: number | null } | null;
                current = row?.superseded_by ?? null;
              }
            }

            const updates: string[] = [];
            const params: unknown[] = [];

            // CR-4: cap unbounded inputs into DB/FTS (title 500, bodies 20k).
            if (input.title !== undefined) { updates.push("title = ?"); params.push(truncateStored(scrubStore(input.title), STORE_CAPS.decisionTitle)); }
            if (input.context !== undefined) { updates.push("context = ?"); params.push(truncateStored(scrubStore(input.context), STORE_CAPS.decisionBody)); }
            if (input.decision !== undefined) { updates.push("decision = ?"); params.push(truncateStored(scrubStore(input.decision), STORE_CAPS.decisionBody)); }
            if (input.consequences !== undefined) { updates.push("consequences = ?"); params.push(truncateStored(scrubStore(input.consequences), STORE_CAPS.decisionBody)); }
            if (input.status !== undefined) { updates.push("status = ?"); params.push(input.status); }
            if (input.superseded_by !== undefined) { updates.push("superseded_by = ?"); params.push(input.superseded_by); }
            if (input.tags !== undefined) { updates.push("tags = ?"); params.push(JSON.stringify(input.tags)); }
            if (input.addTags !== undefined || input.removeTags !== undefined) {
              const currentTags = parseStringArray(existing.tags);
              let newTags = currentTags;
              if (input.addTags) {
                newTags = [...new Set([...newTags, ...input.addTags])];
              }
              if (input.removeTags) {
                newTags = newTags.filter(t => !input.removeTags!.includes(t));
              }
              updates.push("tags = ?");
              params.push(JSON.stringify(newTags));
            }
            if (input.project !== undefined) { updates.push("project = ?"); params.push(input.project); }

            if (updates.length === 0) return "No fields to update.";

            updates.push("updated_at = datetime('now')");
            params.push(input.id);

            database.prepare(`UPDATE decisions SET ${updates.join(", ")} WHERE id = ?`).run(...params);

            const updated = database.prepare("SELECT * FROM decisions WHERE id = ?").get(input.id) as DecisionRow;
            return `Updated decision #${input.id}:\n\n${formatDecision(updated)}`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "decision_delete",
        description:
          "Delete a decision by ID. Only rows belonging to this session or this project can be deleted; pass all: true to widen past that scope.",
        input: z.object({
          id: z.number().describe("Decision ID to delete"),
          confirm: z.boolean().optional().describe("Confirm deletion (required for safety)"),
          // DL-1: explicit widening flag, mirroring memory_forget's `all`.
          all: z.boolean().optional().describe("Widen the delete to rows outside this session/project (default: false)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { id: number; confirm?: boolean; all?: boolean };
          const out = withRetry(() => {
            const database = getDb();
            // DL-1: load the row first and gate it on the same isolation
            // search/list apply. Before this, the id path deleted whatever id it
            // was handed with no session/project check at all, so any session
            // that guessed an id could destroy another project's decisions.
            const row = database
              .prepare("SELECT id, session_id, project FROM decisions WHERE id = ?")
              .get(args.id) as { id: number; session_id: string | null; project: string | null } | null;
            if (!row) return `Decision #${args.id} not found`;
            if (args.all !== true) {
              const sameSession = !!toolCtx.sessionID && row.session_id === toolCtx.sessionID;
              const sameProject = !!autoScope && row.project === autoScope;
              if (!sameSession && !sameProject) {
                return `Refused: decision #${args.id} belongs to another session/project (${row.project ?? "unscoped"}). Pass all: true to delete it anyway.`;
              }
            }
            if (!args.confirm) return `Deletion not confirmed. Pass confirm: true to delete decision #${args.id}.`;
            database.prepare("DELETE FROM decisions WHERE id = ?").run(args.id);
            return `Deleted decision #${args.id}`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "decision_export",
        description: "Export decisions to JSON or Markdown format.",
        input: z.object({
          format: z.enum(["json", "markdown"]).optional().describe("Export format (default: json)"),
          status: z.string().optional().describe("Filter by status"),
          project: z.string().optional().describe("Filter by project"),
          all: z.boolean().optional().describe("Include decisions from all sessions (default: false)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { format?: string; status?: string; project?: string; all?: boolean };
          const out = withRetry(() => {
            const database = getDb();
            let where = "WHERE 1=1";
            const params: unknown[] = [];
            // DL-1: exports honored no session scope at all when the caller had
            // no sessionID — every project's decisions ended up in the file.
            let scopeNote = "";

            if (!args.all) {
              if (toolCtx.sessionID) {
                where += " AND session_id = ?";
                params.push(toolCtx.sessionID);
              } else {
                where += " AND project = ?";
                params.push(autoScope ?? "");
                scopeNote = SCOPED_BY_PROJECT_NOTE;
              }
            }
            if (args.status) {
              where += " AND status = ?";
              params.push(args.status);
            }
            if (args.project) {
              where += " AND project = ?";
              params.push(args.project);
            }

            const rows = database.prepare(`SELECT * FROM decisions ${where} ORDER BY created_at DESC`).all(...params) as DecisionRow[];

            // DL-1: state the fallback scope in the result. JSON is emitted as
            // before with the note appended after the payload, so a reader of a
            // silently-narrowed export can tell why rows are missing.
            if (rows.length === 0) return `No decisions found.${scopeNote}`;

            const format = args.format || "json";
            if (format === "json") {
              return JSON.stringify(rows, null, 2) + scopeNote;
            } else {
              const md = rows.map(row => {
                const tags = parseStringArray(row.tags);
                const lines: string[] = [];
                lines.push(`## #${row.id} — ${row.title}`);
                lines.push(`- **Status:** ${row.status}`);
                if (row.project) lines.push(`- **Project:** ${row.project}`);
                if (row.session_id) lines.push(`- **Session:** ${row.session_id}`);
                if (tags.length > 0) lines.push(`- **Tags:** ${tags.join(", ")}`);
                lines.push(`- **Created:** ${row.created_at}`);
                lines.push(`- **Updated:** ${row.updated_at}`);
                if (row.context) lines.push(`\n**Context:** ${row.context}`);
                lines.push(`\n**Decision:** ${row.decision}`);
                if (row.consequences) lines.push(`\n**Consequences:** ${row.consequences}`);
                if (row.superseded_by) lines.push(`\n**Superseded by:** #${row.superseded_by}`);
                return lines.join("\n");
              });
              return md.join("\n\n---\n\n") + scopeNote;
            }
          });
          return { content: out };
        },
      });

      editor.add({
        name: "decision_stats",
        description: "Get aggregate statistics about logged decisions.",
        input: z.object({}),
        execute: async () => {
          const out = withRetry(() => {
            const database = getDb();

            // Counts by status
            const statusRows = database.prepare("SELECT status, COUNT(*) as count FROM decisions GROUP BY status").all() as { status: string; count: number }[];

            // Top tags
            const tagRows = database.prepare(`
              SELECT value as tag, COUNT(*) as count
              FROM decisions, json_each(decisions.tags)
              GROUP BY value
              ORDER BY count DESC
              LIMIT 10
            `).all() as { tag: string; count: number }[];

            // Top projects
            const projectRows = database.prepare(`
              SELECT project, COUNT(*) as count
              FROM decisions
              WHERE project IS NOT NULL
              GROUP BY project
              ORDER BY count DESC
              LIMIT 10
            `).all() as { project: string; count: number }[];

            // Decisions per month
            const monthRows = database.prepare(`
              SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
              FROM decisions
              GROUP BY month
              ORDER BY month DESC
              LIMIT 12
            `).all() as { month: string; count: number }[];

            // Total count
            const totalRow = database.prepare("SELECT COUNT(*) as count FROM decisions").get() as { count: number };

            const lines: string[] = [];
            lines.push(`**Decision Statistics**`);
            lines.push(`Total decisions: ${totalRow.count}`);
            lines.push("");
            lines.push(`**By Status:**`);
            for (const r of statusRows) lines.push(`  ${r.status}: ${r.count}`);
            lines.push("");
            lines.push(`**Top Tags:**`);
            for (const r of tagRows) lines.push(`  ${r.tag}: ${r.count}`);
            lines.push("");
            lines.push(`**Top Projects:**`);
            for (const r of projectRows) lines.push(`  ${r.project}: ${r.count}`);
            lines.push("");
            lines.push(`**Decisions per Month:**`);
            for (const r of monthRows) lines.push(`  ${r.month}: ${r.count}`);

            return lines.join("\n");
          });
          return { content: out };
        },
      });

      // E153: vacuum tool.
      editor.add({
        name: "decision_vacuum",
        description: "Reclaim disk space by running VACUUM.",
        input: z.object({}),
        execute: async () => {
          const out = withRetry(() => {
            const database = getDb();
            vacuum(database);
            return "Vacuumed.";
          });
          return { content: out };
        },
      });

      // E154: rebuild FTS tool.
      editor.add({
        name: "decision_rebuild_fts",
        description: "Rebuild the FTS index.",
        input: z.object({}),
        execute: async () => {
          const out = withRetry(() => {
            const database = getDb();
            rebuildFts(database, "decisions_fts");
            return "FTS index rebuilt.";
          });
          return { content: out };
        },
      });

      // E155: config tool.
      editor.add({
        name: "decision_config",
        description: "Show the current decision-log configuration.",
        input: z.object({}),
        execute: async () => {
          return {
            content: [
              `db: ${DB_PATH}`,
              `backupDir: ${BACKUP_DIR}`,
              `maxBackups: ${MAX_BACKUPS}`,
              // DL-2: report the value actually in force for this session
              // (options/env), and the project tag rows get stamped with.
              `autoProject: ${autoProject}`,
              `project: ${autoScope ?? "(none — rows are unscoped)"}`,
            ].join("\n"),
          };
        },
      });
    });

    return () => {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      db = null;
    };
  },
});
