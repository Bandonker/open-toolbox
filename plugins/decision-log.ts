import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { mkdirSync, existsSync, copyFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  openDatabase,
  applyPragmas,
  maybeBackupDb,
  latestValidBackup,
  isCorruption,
  parseStringArray,
  quoteFtsQuery,
  dbUnavailable,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { redactSecrets } from "../lib/redact.ts";

const DB_DIR = join(homedir(), ".opencode-plugins", "decision-log");
const DB_PATH = join(DB_DIR, "decision-log.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;
const DECISION_STATUSES = ["proposed", "accepted", "deprecated", "superseded"] as const;
/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
const STORE_REDACT = process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
function scrubStore(text: string): string {
  return STORE_REDACT ? redactSecrets(text) : text;
}

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    try {
      db = openDatabase(DB_PATH);
      applyPragmas(db);
      initSchema(db);
    } catch (e) {
      db = tryRestore();
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
  const hadTriggers = !!database
    .query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='decisions_ai'")
    .get();

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
  for (const suffix of ["-wal", "-shm"]) {
    try { rmSync(DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
  copyFileSync(latest, DB_PATH);
  const restored = openDatabase(DB_PATH);
  applyPragmas(restored);
  initSchema(restored);
  return restored;
}

function withRetry<T>(fn: () => T, isWrite = false): T {
  try {
    const result = fn();
    if (isWrite) { try { backup(); } catch {} }
    return result;
  } catch (err) {
    if (isCorruption(err)) {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      db = tryRestore();
      if (db) {
        const result = fn();
        if (isWrite) { try { backup(); } catch {} }
        return result;
      }
    }
    // CR-3: never throw storage failures out of tools — every caller uses
    // the result as tool `content`, so surface a readable message instead.
    return dbUnavailable(err) as T;
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
  if (row.context) lines.push(`Context: ${row.context}`);
  lines.push(`Decision: ${row.decision}`);
  if (row.consequences) lines.push(`Consequences: ${row.consequences}`);
  if (row.superseded_by) lines.push(`Superseded by: #${row.superseded_by}`);
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push(`Created: ${row.created_at} | Updated: ${row.updated_at}`);
  return lines.join("\n");
}

export default Plugin.define({
  id: "decision-log",
  async setup(ctx) {
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
          const args = input as {
            title: string; decision: string; context?: string;
            consequences?: string; status?: string; tags?: string[]; project?: string;
          };
          const out = withRetry(() => {
            const database = getDb();
            const status = args.status || "accepted";
            const tags = JSON.stringify(args.tags || []);
            const stmt = database.prepare(
              "INSERT INTO decisions (session_id, title, context, decision, consequences, status, tags, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            );
            const result = stmt.run(
              toolCtx.sessionID || null,
              scrubStore(args.title),
              args.context ? scrubStore(args.context) : null,
              scrubStore(args.decision),
              args.consequences ? scrubStore(args.consequences) : null,
              status,
              tags,
              args.project || null
            ) as { lastInsertRowid: number | bigint };
            return `Logged decision #${result.lastInsertRowid}: "${args.title}" [${status}]`;
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
          const args = input as { id: number };
          const out = withRetry(() => {
            const database = getDb();
            const row = database.prepare("SELECT * FROM decisions WHERE id = ?").get(args.id) as DecisionRow | null;
            if (!row) return `Decision #${args.id} not found.`;
            return formatDecision(row);
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
          all_sessions: z.boolean().optional().describe("Search across all sessions (default: false, current session only)"),
          limit: z.number().optional().describe("Max results (default: 10)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { query: string; all_sessions?: boolean; limit?: number };
          const out = withRetry(() => {
            const database = getDb();
            const q = quoteFtsQuery(args.query);
            if (q === null) return "No decisions found. (empty query)";
            const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
            let sql = `SELECT d.* FROM decisions d
                 JOIN decisions_fts f ON d.id = f.rowid
                 WHERE decisions_fts MATCH ?`;
            const params: unknown[] = [q];

            if (!args.all_sessions && toolCtx.sessionID) {
              sql += " AND d.session_id = ?";
              params.push(toolCtx.sessionID);
            }

            sql += " ORDER BY rank LIMIT ?";
            params.push(limit);

            const rows = database.prepare(sql).all(...params) as DecisionRow[];

            if (rows.length === 0) return "No decisions found.";
            return rows.map(formatDecision).join("\n\n---\n\n");
          });
          return { content: out };
        },
      }),

      editor.add({
        name: "decision_list",
        description:
          "List decisions from the current session, optionally filtered by status, tags, or project. Use all_sessions to see decisions from other sessions.",
        input: z.object({
          status: z.string().optional().describe("Filter by status: proposed, accepted, deprecated, superseded"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          project: z.string().optional().describe("Filter by project name"),
          all_sessions: z.boolean().optional().describe("Show decisions from all sessions (default: false)"),
          limit: z.number().optional().describe("Max results (default: 20)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as {
            status?: string; tags?: string[]; project?: string;
            all_sessions?: boolean; limit?: number;
          };
          const out = withRetry(() => {
            const database = getDb();
            const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
            let where = "WHERE 1=1";
            const params: unknown[] = [];

            if (!args.all_sessions && toolCtx.sessionID) {
              where += " AND session_id = ?";
              params.push(toolCtx.sessionID);
            }

            if (args.status) {
              where += " AND status = ?";
              params.push(args.status);
            }
            if (args.project) {
              where += " AND project = ?";
              params.push(args.project);
            }
            if (args.tags && args.tags.length > 0) {
              for (const tag of args.tags) {
                // D3: exact tag match against the JSON array — substring LIKE
                // matching produced false positives (e.g. "api" matching "api-v2").
                where += " AND EXISTS (SELECT 1 FROM json_each(decisions.tags) WHERE value = ?)";
                params.push(tag);
              }
            }

            const rows = database.prepare(
              `SELECT *, COUNT(*) OVER() as _total FROM decisions ${where} ORDER BY created_at DESC LIMIT ?`
            ).all(...params, limit) as (DecisionRow & { _total: number })[];

            if (rows.length === 0) return "No decisions found.";

            const total = rows[0]._total;
            const header = `Showing ${rows.length} of ${total} matching decisions:\n\n`;
            return header + rows.map(formatDecision).join("\n\n---\n\n");
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
          project: z.string().optional().describe("Update project"),
        }),
        execute: async (input) => {
          const args = input as {
            id: number; title?: string; context?: string; decision?: string;
            consequences?: string; status?: string; superseded_by?: number;
            tags?: string[]; project?: string;
          };
          const out = withRetry(() => {
            const database = getDb();
            const existing = database.prepare("SELECT * FROM decisions WHERE id = ?").get(args.id) as DecisionRow | null;
            if (!existing) return `Decision #${args.id} not found.`;

            const updates: string[] = [];
            const params: unknown[] = [];

            if (args.title !== undefined) { updates.push("title = ?"); params.push(scrubStore(args.title)); }
            if (args.context !== undefined) { updates.push("context = ?"); params.push(scrubStore(args.context)); }
            if (args.decision !== undefined) { updates.push("decision = ?"); params.push(scrubStore(args.decision)); }
            if (args.consequences !== undefined) { updates.push("consequences = ?"); params.push(scrubStore(args.consequences)); }
            if (args.status !== undefined) { updates.push("status = ?"); params.push(args.status); }
            if (args.superseded_by !== undefined) { updates.push("superseded_by = ?"); params.push(args.superseded_by); }
            if (args.tags !== undefined) { updates.push("tags = ?"); params.push(JSON.stringify(args.tags)); }
            if (args.project !== undefined) { updates.push("project = ?"); params.push(args.project); }

            if (updates.length === 0) return "No fields to update.";

            updates.push("updated_at = datetime('now')");
            params.push(args.id);

            database.prepare(`UPDATE decisions SET ${updates.join(", ")} WHERE id = ?`).run(...params);

            const updated = database.prepare("SELECT * FROM decisions WHERE id = ?").get(args.id) as DecisionRow;
            return `Updated decision #${args.id}:\n\n${formatDecision(updated)}`;
          }, true);
          return { content: out };
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
