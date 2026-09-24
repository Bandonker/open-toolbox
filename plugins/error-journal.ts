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
  checkOpenDb,
  isCorruption,
  parseStringArray,
  quoteFtsQuery,
  dbUnavailable,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { redactSecrets } from "../lib/redact.ts";

const DB_DIR = join(homedir(), ".opencode-plugins", "error-journal");
const DB_PATH = join(DB_DIR, "error-journal.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;
/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
const STORE_REDACT = process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
function scrubStore(text: string): string {
  return STORE_REDACT ? redactSecrets(text) : text;
}

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    if (!existsSync(DB_DIR)) {
      mkdirSync(DB_DIR, { recursive: true });
    }
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
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_text TEXT NOT NULL,
      context TEXT,
      resolution TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  const row = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='errors_fts'")
    .get() as { name: string } | null;

  const createdFts = !row;
  if (createdFts) {
    database.exec(`
      CREATE VIRTUAL TABLE errors_fts USING fts5(
        error_text,
        context,
        resolution,
        tags,
        content=errors,
        content_rowid=id,
        tokenize='porter'
      )
    `);
  }

  // E1: triggers are ensured on every open, not only when the FTS table was
  // just created — a dropped/desynced trigger must not silently stop making
  // new errors searchable.
  const hadTriggers = !!database
    .query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='errors_ai'")
    .get();

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      VALUES (new.id, new.error_text, COALESCE(new.context, ''), COALESCE(new.resolution, ''), new.tags);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_ad AFTER DELETE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, error_text, context, resolution, tags)
      VALUES ('delete', old.id, old.error_text, COALESCE(old.context, ''), COALESCE(old.resolution, ''), old.tags);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, error_text, context, resolution, tags)
      VALUES ('delete', old.id, old.error_text, COALESCE(old.context, ''), COALESCE(old.resolution, ''), old.tags);
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      VALUES (new.id, new.error_text, COALESCE(new.context, ''), COALESCE(new.resolution, ''), new.tags);
    END
  `);

  if (createdFts) {
    // Backfill any existing rows into the freshly created (empty) index.
    database.exec(`
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      SELECT id, error_text, COALESCE(context, ''), COALESCE(resolution, ''), tags FROM errors
    `);
  } else if (!hadTriggers) {
    // The index existed but the sync triggers were missing: rebuild it so
    // past and future rows are consistent again.
    database.exec(`INSERT INTO errors_fts(errors_fts) VALUES('rebuild')`);
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
  // E2: close the failing handle first (an open handle blocks the copy on
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
  // J1: verify the restored copy on its own handle — the pre-copy backup
  // check cannot catch a copy that lands corrupt. Never serve it silently.
  if (!checkOpenDb(restored)) {
    try { restored.close(); } catch { /* ignore */ }
    return null;
  }
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

interface ErrorRow {
  id: number;
  error_text: string;
  context: string | null;
  resolution: string | null;
  tags: string;
  project: string | null;
  created_at: string;
  resolved_at: string | null;
}

function formatError(row: ErrorRow): string {
  const tags = parseStringArray(row.tags);
  let out = `**#${row.id}** — ${row.created_at}`;
  if (row.resolved_at) out += ` (resolved ${row.resolved_at})`;
  out += "\n";
  if (row.project) out += `Project: ${row.project}\n`;
  if (tags.length > 0) out += `Tags: ${tags.join(", ")}\n`;
  out += `\n\`\`\`\n${row.error_text}\n\`\`\`\n`;
  if (row.context) out += `\nContext: ${row.context}\n`;
  if (row.resolution) out += `\nResolution: ${row.resolution}\n`;
  return out;
}

export default Plugin.define({
  id: "error-journal",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "error_log",
        description:
          "Log a new error to the journal. Record the error message/stack, what was happening, and optional tags/project for categorization.",
        input: z.object({
          error_text: z.string().describe("The error message or stack trace"),
          context: z.string().optional().describe("What was happening when the error occurred (file, command, action)"),
          tags: z.array(z.string()).optional().describe("Tags for categorization (e.g. ['typescript', 'build'])"),
          project: z.string().optional().describe("Project path or name"),
        }),
        execute: async (input) => {
          const args = input as {
            error_text: string; context?: string; tags?: string[]; project?: string;
          };
          try {
            const out = withRetry(() => {
              const database = getDb();
              const tagsJson = JSON.stringify(args.tags || []);
              const stmt = database.prepare(
                "INSERT INTO errors (error_text, context, tags, project) VALUES (?, ?, ?, ?)"
              );
              const result = stmt.run(
                scrubStore(args.error_text),
                args.context ? scrubStore(args.context) : null,
                tagsJson,
                args.project || null
              ) as { lastInsertRowid: number | bigint };
              return `Logged error #${result.lastInsertRowid}`;
            }, true);
            return { content: out };
          } catch (err) {
            return { content: dbUnavailable(err) };
          }
        },
      });

      editor.add({
        name: "error_resolve",
        description:
          "Add a resolution to a logged error. Records how the error was fixed for future reference.",
        input: z.object({
          id: z.number().describe("Error ID to resolve"),
          resolution: z.string().describe("How the error was fixed"),
        }),
        execute: async (input) => {
          const args = input as { id: number; resolution: string };
          const out = withRetry(() => {
            const database = getDb();
            const row = database
              .query("SELECT id FROM errors WHERE id = ?")
              .get(args.id) as { id: number } | null;
            if (!row) return `Error #${args.id} not found`;
            database
              .prepare("UPDATE errors SET resolution = ?, resolved_at = datetime('now') WHERE id = ?")
              .run(scrubStore(args.resolution), args.id);
            return `Resolved error #${args.id}`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "error_search",
        description:
          "Search the error journal using full-text search. Matches against error text, context, resolution, and tags. Use this when a similar error appears to find past resolutions.",
        input: z.object({
          query: z.string().describe("Search query"),
          limit: z.number().optional().describe("Max results (default: 10)"),
        }),
        execute: async (input) => {
          const args = input as { query: string; limit?: number };
          const out = withRetry(() => {
            const database = getDb();
            const q = quoteFtsQuery(args.query);
            if (q === null) return "No errors found. (empty query)";
            const limit = Math.min(Math.max(args.limit || 10, 1), 50);
            const rows = database
              .query(
                `SELECT e.* FROM errors e
                 JOIN errors_fts f ON f.rowid = e.id
                 WHERE errors_fts MATCH ?
                 ORDER BY rank
                 LIMIT ?`
              )
              .all(q, limit) as ErrorRow[];
            if (rows.length === 0) return "No matching errors found.";
            return rows.map(formatError).join("\n---\n\n");
          });
          return { content: out };
        },
      });

      editor.add({
        name: "error_list",
        description:
          "List recent errors, optionally filtered by project, tags, or resolved status.",
        input: z.object({
          project: z.string().optional().describe("Filter by project path/name"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          resolved: z.boolean().optional().describe("Filter: true = resolved only, false = unresolved only, omit = all"),
          limit: z.number().optional().describe("Max results (default: 20)"),
        }),
        execute: async (input) => {
          const args = input as {
            project?: string; tags?: string[]; resolved?: boolean; limit?: number;
          };
          const out = withRetry(() => {
            const database = getDb();
            const conditions: string[] = [];
            const params: unknown[] = [];

            if (args.project) {
              conditions.push("project = ?");
              params.push(args.project);
            }
            if (args.resolved === true) {
              conditions.push("resolution IS NOT NULL");
            } else if (args.resolved === false) {
              conditions.push("resolution IS NULL");
            }
            if (args.tags && args.tags.length > 0) {
              for (const tag of args.tags) {
                // E3: exact tag match against the JSON array — substring LIKE
                // produced false positives (e.g. "api" matching "api-v2").
                conditions.push("EXISTS (SELECT 1 FROM json_each(errors.tags) WHERE value = ?)");
                params.push(tag);
              }
            }

            const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
            const limit = Math.min(Math.max(args.limit || 20, 1), 100);

            const rows = database
              .query(`SELECT * FROM errors ${where} ORDER BY created_at DESC LIMIT ?`)
              .all(...params, limit) as ErrorRow[];

            if (rows.length === 0) return "No errors found.";
            return rows.map(formatError).join("\n---\n\n");
          });
          return { content: out };
        },
      });

      editor.add({
        name: "error_delete",
        description: "Delete an error entry by ID.",
        input: z.object({
          id: z.number().describe("Error ID to delete"),
        }),
        execute: async (input) => {
          const args = input as { id: number };
          const out = withRetry(() => {
            const database = getDb();
            const row = database
              .query("SELECT id FROM errors WHERE id = ?")
              .get(args.id) as { id: number } | null;
            if (!row) return `Error #${args.id} not found`;
            database.prepare("DELETE FROM errors WHERE id = ?").run(args.id);
            return `Deleted error #${args.id}`;
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
