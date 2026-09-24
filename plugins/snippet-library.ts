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

const DB_DIR = join(homedir(), ".opencode-plugins", "snippet-library");
const DB_PATH = join(DB_DIR, "snippet-library.db");
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
    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      code TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
      title, code, description, language, tags,
      content='snippets', content_rowid='id',
      tokenize='porter'
    )
  `);

  // Ensure triggers exist (rebuild FTS if missing)
  const hasTrigger = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='snippets_ai'"
  ).get();
  if (!hasTrigger) {
    database.exec("INSERT INTO snippets_fts(snippets_fts) VALUES('rebuild')");
  }

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS snippets_ai AFTER INSERT ON snippets BEGIN
      INSERT INTO snippets_fts(rowid, title, code, description, language, tags) VALUES (new.id, new.title, new.code, new.description, new.language, new.tags);
    END
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS snippets_ad AFTER DELETE ON snippets BEGIN
      INSERT INTO snippets_fts(snippets_fts, rowid, title, code, description, language, tags) VALUES('delete', old.id, old.title, old.code, old.description, old.language, old.tags);
    END
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS snippets_au AFTER UPDATE ON snippets BEGIN
      INSERT INTO snippets_fts(snippets_fts, rowid, title, code, description, language, tags) VALUES('delete', old.id, old.title, old.code, old.description, old.language, old.tags);
      INSERT INTO snippets_fts(rowid, title, code, description, language, tags) VALUES (new.id, new.title, new.code, new.description, new.language, new.tags);
    END
  `);
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
  // N1: close the failing handle first (an open handle blocks the copy on
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

interface SnippetRow {
  id: number;
  title: string;
  code: string;
  language: string;
  description: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function formatSnippet(row: SnippetRow, full: boolean = false): string {
  const tags = parseStringArray(row.tags);
  const parts: string[] = [];
  let header = `**#${row.id}** ${row.title}`;
  if (row.language) header += ` (${row.language})`;
  parts.push(header);
  if (row.description) parts.push(`  ${row.description}`);
  if (full) {
    parts.push("");
    parts.push("```" + row.language);
    parts.push(row.code);
    parts.push("```");
  } else {
    const preview = row.code.split("\n").slice(0, 3).join("\n");
    const truncated = row.code.split("\n").length > 3 ? "\n  ..." : "";
    parts.push("");
    parts.push("```" + row.language);
    parts.push(preview + truncated);
    parts.push("```");
  }
  if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
  parts.push(`Created: ${row.created_at}`);
  return parts.join("\n");
}

export default Plugin.define({
  id: "snippet-library",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "snippet_save",
        description:
          "Save a code snippet to the project snippet library. Persists across sessions.",
        input: z.object({
          title: z.string().describe("Short descriptive title"),
          code: z.string().describe("The code snippet"),
          language: z.string().optional().describe("Programming language (e.g. python, typescript, bash)"),
          description: z.string().optional().describe("What the snippet does"),
          tags: z.array(z.string()).optional().describe("Categorization tags"),
        }),
        execute: async (input) => {
          const args = input as {
            title: string; code: string; language?: string;
            description?: string; tags?: string[];
          };
          const out = withRetry(() => {
            const database = getDb();
            const tags = JSON.stringify(args.tags || []);
            const result = database.prepare(
              "INSERT INTO snippets (title, code, language, description, tags) VALUES (?, ?, ?, ?, ?)"
              // P5: title/description are free text; `code` is deliberately
              // left raw — redacting code artifacts would corrupt the very
              // snippets the user asked to store (secret-shield's redact/block
              // mode still covers them when enabled).
            ).run(scrubStore(args.title), args.code, args.language || "", args.description ? scrubStore(args.description) : "", tags) as { lastInsertRowid: number | bigint };
            return `Saved snippet #${result.lastInsertRowid}: "${args.title}"`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "snippet_search",
        description:
          "Search snippets using full-text search across title, code, description, and language.",
        input: z.object({
          query: z.string().describe("Search query"),
          language: z.string().optional().describe("Filter by language"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          limit: z.number().optional().describe("Max results (default 10)"),
        }),
        execute: async (input) => {
          const args = input as {
            query: string; language?: string; tags?: string[]; limit?: number;
          };
          const out = withRetry(() => {
            const database = getDb();
            const limit = Math.min(Math.max(args.limit || 10, 1), 50);
            const q = quoteFtsQuery(args.query);
            if (q === null) return "No snippets found matching query.";
            let sql = `SELECT s.* FROM snippets s JOIN snippets_fts f ON s.id = f.rowid WHERE snippets_fts MATCH ?`;
            const params: unknown[] = [q];
            if (args.language) {
              sql += " AND s.language = ?";
              params.push(args.language);
            }
            if (args.tags && args.tags.length > 0) {
              for (const tag of args.tags) {
                // N2: exact tag match against the JSON array — substring LIKE
                // produced false positives (e.g. "api" matching "api-v2").
                sql += " AND EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = ?)";
                params.push(tag);
              }
            }
            sql += " ORDER BY rank LIMIT ?";
            params.push(limit);
            const rows = database.prepare(sql).all(...params) as SnippetRow[];
            if (rows.length === 0) return "No snippets found matching query.";
            return rows.map((r) => formatSnippet(r, true)).join("\n\n---\n\n");
          });
          return { content: out };
        },
      });

      editor.add({
        name: "snippet_list",
        description:
          "List snippets, optionally filtered by language or tags.",
        input: z.object({
          language: z.string().optional().describe("Filter by language"),
          tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
          limit: z.number().optional().describe("Max results (default 20)"),
        }),
        execute: async (input) => {
          const args = input as { language?: string; tags?: string[]; limit?: number };
          const out = withRetry(() => {
            const database = getDb();
            const limit = Math.min(Math.max(args.limit || 20, 1), 100);

            let sql = "SELECT * FROM snippets WHERE 1=1";
            const params: unknown[] = [];

            if (args.language) {
              sql += " AND language = ?";
              params.push(args.language);
            }
            if (args.tags && args.tags.length > 0) {
              for (const tag of args.tags) {
                // N2: exact tag match against the JSON array — substring LIKE
                // produced false positives (e.g. "api" matching "api-v2").
                sql += " AND EXISTS (SELECT 1 FROM json_each(snippets.tags) WHERE value = ?)";
                params.push(tag);
              }
            }

            sql += " ORDER BY created_at DESC LIMIT ?";
            params.push(limit);

            const rows = database.prepare(sql).all(...params) as SnippetRow[];
            if (rows.length === 0) return "No snippets found.";
            return rows.map((r) => formatSnippet(r, false)).join("\n\n---\n\n");
          });
          return { content: out };
        },
      });

      editor.add({
        name: "snippet_get",
        description:
          "Get a snippet by ID with full code.",
        input: z.object({
          id: z.number().describe("Snippet ID"),
        }),
        execute: async (input) => {
          const args = input as { id: number };
          const out = withRetry(() => {
            const database = getDb();
            const row = database.prepare("SELECT * FROM snippets WHERE id = ?").get(args.id) as SnippetRow | null;
            if (!row) return `Snippet #${args.id} not found.`;
            return formatSnippet(row, true);
          });
          return { content: out };
        },
      });

      editor.add({
        name: "snippet_delete",
        description:
          "Delete a snippet by ID.",
        input: z.object({
          id: z.number().describe("Snippet ID to delete"),
        }),
        execute: async (input) => {
          const args = input as { id: number };
          const out = withRetry(() => {
            const database = getDb();
            const existing = database.prepare("SELECT * FROM snippets WHERE id = ?").get(args.id) as SnippetRow | null;
            if (!existing) return `Snippet #${args.id} not found.`;

            database.prepare("DELETE FROM snippets WHERE id = ?").run(args.id);
            return `Deleted snippet #${args.id}: "${existing.title}"`;
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
