import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";
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
  STORE_CAPS,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { redactSecrets } from "../lib/redact.ts";
import { asBool, envStr } from "../lib/config.ts";

const DB_NAME = "snippet-library.db";
const MAX_BACKUPS = 5;

/* ------------------------------------------------------------------ *
 * SL-4: configuration — the enabled/dir/log options documented in the
 * README were never read; the paths were module-level constants. Same
 * ctx.options + env resolution pattern used by usage-stats/tool-audit.
 * ------------------------------------------------------------------ */

type Config = { enabled: boolean; dir: string; log: boolean };

function resolveConfig(options: unknown): Config {
  const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  return {
    enabled: asBool(o.enabled, asBool(envStr("OPENCODE_SNIPPET_LIBRARY_ENABLED"), true)),
    dir:
      typeof o.dir === "string" && o.dir
        ? o.dir
        : envStr("OPENCODE_SNIPPET_LIBRARY_DIR") ?? join(homedir(), ".opencode-plugins", "snippet-library"),
    log: asBool(o.log, asBool(envStr("OPENCODE_SNIPPET_LIBRARY_LOG"), false)),
  };
}

/**
 * SL-2: content hash (sha1 of title + separator + code) used to dedupe
 * imports — re-importing an export no longer duplicates the library, and
 * identical content saved under different ids collapses to one row.
 */
function snippetHash(title: string, code: string): string {
  return createHash("sha1").update(`${title}\u0000${code}`).digest("hex");
}
/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
// Lazy read (call time, not module load) so toggles take effect without a re-import.
function storeRedactOn(): boolean {
  return process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
}

function scrubStore(text: string): string {
  return storeRedactOn() ? redactSecrets(text) : text;
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
      hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // SL-2: hash column + unique index on pre-existing databases. Safe ALTER
  // migration (fails silently when the column already exists), then a
  // backfill of sha1(title+code) for legacy rows.
  try {
    database.exec("ALTER TABLE snippets ADD COLUMN hash TEXT");
  } catch {
    /* column already present (fresh db or migrated before) */
  }
  // SL-2: backfill legacy rows with the same formula snippetHash() uses on
  // insert (title/code as stored — already truncated/scrubbed by writers).
  const missing = database
    .prepare("SELECT id, title, code FROM snippets WHERE hash IS NULL OR hash = ''")
    .all() as Array<{ id: number; title: string; code: string }>;
  if (missing.length > 0) {
    const update = database.prepare("UPDATE snippets SET hash = ? WHERE id = ?");
    for (const row of missing) {
      update.run(snippetHash(row.title, row.code), row.id);
    }
    // Duplicate legacy rows (the accidental re-imports SL-2 exists to stop)
    // would block the unique index: keep the lowest id per hash — that is
    // the original save — and drop the later duplicates. The snippets_ad
    // trigger keeps the FTS index consistent for the removed rows.
    database.exec(`
      DELETE FROM snippets
      WHERE hash IS NOT NULL
        AND id NOT IN (SELECT MIN(id) FROM snippets WHERE hash IS NOT NULL GROUP BY hash)
    `);
  }
  try {
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_hash ON snippets(hash) WHERE hash IS NOT NULL");
  } catch {
    /* residual duplicate hashes (shouldn't happen post-dedup): keep serving
       the library without the unique index rather than wedging the db */
  }

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
      title, code, description, language, tags,
      content='snippets', content_rowid='id',
      tokenize='porter'
    )
  `);

  // Ensure triggers exist (rebuild FTS if missing).
  // CR-9: verify all three triggers (ai/ad/au), not just the insert one.
  const hasTrigger = hasTriggers(database, ["snippets_ai", "snippets_ad", "snippets_au"]);
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



interface SnippetRow {
  id: number;
  title: string;
  code: string;
  language: string;
  description: string;
  tags: string;
  /** SL-2: content hash — present on rows written after the migration. */
  hash?: string | null;
  created_at: string;
  updated_at: string;
}

function formatSnippet(row: SnippetRow, full: boolean = false): string {
  const tags = parseStringArray(row.tags);
  const parts: string[] = [];
  // SN-4: sanitize the language info string so a stored value cannot break
  // out of the fence (allow word chars plus common language-name symbols).
  const lang = (row.language || "").replace(/[^\w+#\-.]/g, "").slice(0, 32);
  // SN-4: escape stored triple backticks so code cannot break the fence.
  const safeCode = row.code.replace(/```/g, "`\u200b``");
  let header = `**#${row.id}** ${row.title}`;
  if (lang) header += ` (${lang})`;
  parts.push(header);
  if (row.description) parts.push(`  ${row.description}`);
  if (full) {
    parts.push("");
    parts.push("```" + lang);
    parts.push(safeCode);
    parts.push("```");
  } else {
    // SN-5: cap the preview (~600 chars) as well as 3 lines.
    const preview = truncateStored(safeCode.split("\n").slice(0, 3).join("\n"), STORE_CAPS.snippetPreview);
    const truncated = safeCode.split("\n").length > 3 || safeCode.length > STORE_CAPS.snippetPreview ? "\n  ..." : "";
    parts.push("");
    parts.push("```" + lang);
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
    // SL-4: read the documented options (enabled/dir/log) from ctx.options
    // with env fallbacks; previously they were ignored entirely.
    const cfg = resolveConfig(ctx.options);
    if (!cfg.enabled) return () => {};
    const dbPath = join(cfg.dir, DB_NAME);
    const backupDir = join(cfg.dir, "backups");

    const log = (message: string): void => {
      if (cfg.log) console.error(`[snippet-library] ${message}`);
    };

    let db: AnyDatabase | null = null;
    let lastBackupTime = 0;

    function getDb(): AnyDatabase {
      if (!db) {
        // DL-2: mkdir inside try so a creation failure routes to backup-restore
        // instead of escaping as an unhandled throw.
        try {
          if (!existsSync(cfg.dir)) mkdirSync(cfg.dir, { recursive: true });
          db = openDatabase(dbPath);
          applyPragmas(db);
          initSchema(db);
        } catch (e) {
          db = tryRestore();
          if (!db) {
            log(`db init failed: ${String(e)}`);
            throw e;
          }
        }
      }
      return db;
    }

    function backup(): void {
      maybeBackupDb({
        dbPath,
        backupDir,
        maxBackups: MAX_BACKUPS,
        lastBackupTime: () => lastBackupTime,
        setLastBackupTime: (t) => { lastBackupTime = t; },
      });
    }

    function tryRestore(): AnyDatabase | null {
      const latest = latestValidBackup(backupDir);
      if (!latest) return null;
      // N1: close the failing handle first (an open handle blocks the copy on
      // Windows) and drop stale -wal/-shm so they cannot be replayed on top of
      // the restored snapshot.
      if (db) {
        try { db.close(); } catch { /* ignore */ }
        db = null;
      }
      // CR-8: I/O wrapped with context (copyBackupIntoPlace); it also drops
      // -wal/-shm/-journal so they cannot be replayed on the restored snapshot.
      copyBackupIntoPlace(dbPath, latest);
      const restored = openDatabase(dbPath);
      applyPragmas(restored);
      initSchema(restored);
      // J1: verify the restored copy on its own handle — the pre-copy backup
      // check cannot catch a copy that lands corrupt. Never serve it silently.
      if (!checkOpenDb(restored)) {
        try { restored.close(); } catch { /* ignore */ }
        return null;
      }
      log(`restored ${dbPath} from ${latest}`);
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
            // CR-3: the retried call can fail too — route it to dbUnavailable
            // instead of throwing out of the tool.
            try {
              const result = fn();
              if (isWrite) { try { backup(); } catch {} }
              return result;
            } catch (retryErr) {
              return dbUnavailable(retryErr) as T;
            }
          }
        }
        // CR-3: never throw storage failures out of tools — every caller uses
        // the result as tool `content`, so surface a readable message instead.
        return dbUnavailable(err) as T;
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "snippet_save",
        description:
          "Save a code snippet to the project snippet library. Persists across sessions. Snippet code is stored verbatim (unredacted); title/description are secret-scrubbed. Snippets are immutable by design (no update tool — save a corrected copy instead; use snippet_delete to remove the old one).",
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
            const tags = JSON.stringify(args.tags ?? []);
            // SL-2: hash the exact values being stored (post-truncate/scrub)
            // so save/import/update produce identical hashes for identical
            // content, which is what the unique index dedupes on.
            const title = truncateStored(scrubStore(args.title), STORE_CAPS.snippetTitle);
            const code = truncateStored(args.code, STORE_CAPS.snippetCode);
            const result = database.prepare(
              // P5: title/description are free text; `code` is deliberately
              // left raw — redacting code artifacts would corrupt the very
              // snippets the user asked to store (secret-shield's redact/block
              // mode still covers them when enabled).
              // CR-4: cap unbounded inputs (title 300, code 100k, description 5k).
              "INSERT INTO snippets (title, code, language, description, tags, hash) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(title, code, args.language ?? "", args.description ? truncateStored(scrubStore(args.description), STORE_CAPS.snippetDescription) : "", tags, snippetHash(title, code)) as { lastInsertRowid: number | bigint };
            log(`saved snippet #${result.lastInsertRowid}`);
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
            // SN-6: trunc + finite guard via shared clampLimit.
            const limit = clampLimit(args.limit ?? 10, 10, 50);
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
            if (rows.length === 0) {
              // E57: FTS5 with porter tokenizer requires exact token matches.
              // Fall back to LIKE for fuzzy matching (e.g. "useState" won't match "use-state").
              // SL-3: the fuzzy path must apply the same language/tags filters
              // as the FTS path (previously it ignored them and returned rows
              // the caller had excluded), and LIKE metacharacters in the query
              // must be escaped — an unescaped "%" matched every row.
              const likePattern = `%${args.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
              let fuzzySql = "SELECT * FROM snippets WHERE (title LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')";
              const fuzzyParams: unknown[] = [likePattern, likePattern];
              if (args.language) {
                fuzzySql += " AND language = ?";
                fuzzyParams.push(args.language);
              }
              if (args.tags && args.tags.length > 0) {
                for (const tag of args.tags) {
                  fuzzySql += " AND EXISTS (SELECT 1 FROM json_each(snippets.tags) WHERE value = ?)";
                  fuzzyParams.push(tag);
                }
              }
              fuzzySql += " LIMIT ?";
              fuzzyParams.push(limit);
              const fuzzyRows = database.prepare(fuzzySql).all(...fuzzyParams) as SnippetRow[];
              if (fuzzyRows.length === 0) return "No snippets found matching query.";
              // SL-1: previews, not full code dumps — full bodies come from snippet_get.
              return (
                `Fuzzy results (FTS found no exact matches):\n\n` +
                fuzzyRows.map((r) => formatSnippet(r, false)).join("\n\n---\n\n") +
                "\n\n(use snippet_get <id> for full code)"
              );
            }
            // SL-1: cap search output at the SN-5 preview — returning full
            // code for every hit blew the agent's context budget; snippet_get
            // is the full-body path.
            return (
              rows.map((r) => formatSnippet(r, false)).join("\n\n---\n\n") +
              "\n\n(use snippet_get <id> for full code)"
            );
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
          sortBy: z.enum(["created", "title"]).optional().describe("Sort order (default: created)"),
        }),
        execute: async (input) => {
          const args = input as { language?: string; tags?: string[]; limit?: number; sortBy?: "created" | "title" };
          const out = withRetry(() => {
            const database = getDb();
            // SN-6: trunc + finite guard via shared clampLimit.
            const limit = clampLimit(args.limit ?? 20, 20, 100);

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

            sql += args.sortBy === "title" ? " ORDER BY title COLLATE NOCASE ASC LIMIT ?" : " ORDER BY created_at DESC LIMIT ?";
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
            log(`deleted snippet #${args.id}`);
            return `Deleted snippet #${args.id}: "${existing.title}"`;
          }, true);
          return { content: out };
        },
      });

      editor.add({
        name: "snippet_update",
        description:
          "Update a snippet's title, code, language, description, or tags. The FTS index is rebuilt automatically via the snippets_au trigger.",
        input: z.object({
          id: z.number().describe("Snippet ID to update"),
          title: z.string().optional().describe("New title"),
          code: z.string().optional().describe("New code"),
          language: z.string().optional().describe("New language"),
          description: z.string().optional().describe("New description"),
          tags: z.array(z.string()).optional().describe("New tags (replaces all)"),
        }),
        execute: async (input) => {
          const args = input as {
            id: number; title?: string; code?: string;
            language?: string; description?: string; tags?: string[];
          };
          const out = withRetry(() => {
            const database = getDb();
            const existing = database.prepare("SELECT * FROM snippets WHERE id = ?").get(args.id) as SnippetRow | null;
            if (!existing) return `Snippet #${args.id} not found.`;

            const title = args.title !== undefined ? truncateStored(scrubStore(args.title), STORE_CAPS.snippetTitle) : existing.title;
            const code = args.code !== undefined ? truncateStored(args.code, STORE_CAPS.snippetCode) : existing.code;
            const language = args.language !== undefined ? args.language : existing.language;
            const description = args.description !== undefined ? truncateStored(scrubStore(args.description), STORE_CAPS.snippetDescription) : existing.description;
            const tags = args.tags !== undefined ? JSON.stringify(args.tags) : existing.tags;

            // SL-2: keep the content hash in step with title/code edits.
            database.prepare(
              "UPDATE snippets SET title = ?, code = ?, language = ?, description = ?, tags = ?, hash = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(title, code, language, description, tags, snippetHash(title, code), args.id);
            log(`updated snippet #${args.id}`);
            return `Updated snippet #${args.id}: "${title}"`;
          }, true);
          return { content: out };
        },
      });

      // E55: bulk export — returns snippets as a JSON array
      editor.add({
        name: "snippet_export",
        description:
          "Export snippets as a JSON array for backup or migration to another machine. Capped at 1000 rows (default 100) — a truncated note is appended when more exist.",
        // SL-1: unbounded export put the whole library (code included) into
        // the agent's context in one tool result. Cap it like every other
        // read tool.
        input: z.object({
          limit: z.number().optional().describe("Max snippets (default 100, max 1000)"),
        }),
        execute: async (input) => {
          const args = input as { limit?: number };
          const out = withRetry(() => {
            const database = getDb();
            const limit = clampLimit(args.limit ?? 100, 100, 1000);
            const total = (database.prepare("SELECT COUNT(*) as count FROM snippets").get() as { count: number })
              .count;
            const rows = database
              .prepare("SELECT * FROM snippets ORDER BY id ASC LIMIT ?")
              .all(limit) as SnippetRow[];
            const json = JSON.stringify(rows, null, 2);
            if (rows.length < total) {
              // SL-1: report the truncation; snippet_import tolerates the
              // trailing note so capped exports still round-trip.
              return `${json}\n\n// truncated: exported ${rows.length} of ${total} snippets — raise limit (max 1000) for the rest`;
            }
            return json;
          });
          return { content: out };
        },
      });

      // E55: bulk import — accepts a JSON array, inserts with INSERT OR IGNORE
      editor.add({
        name: "snippet_import",
        description:
          "Import snippets from a JSON array (as produced by snippet_export). Dedupes by content hash, so re-importing an export never duplicates the library; incoming ids are preserved when free.",
        input: z.object({
          snippets: z.string().describe("JSON array of snippet objects"),
        }),
        execute: async (input) => {
          const args = input as { snippets: string };
          const out = withRetry(() => {
            const database = getDb();
            let parsed: unknown;
            try {
              parsed = JSON.parse(args.snippets);
            } catch {
              // SL-1: a capped snippet_export appends a truncation note after
              // the JSON array — re-importing one verbatim must still work,
              // so retry with the outermost array slice.
              const start = args.snippets.indexOf("[");
              const end = args.snippets.lastIndexOf("]");
              if (start === -1 || end <= start) return "Invalid JSON: could not parse the snippets array.";
              try {
                parsed = JSON.parse(args.snippets.slice(start, end + 1));
              } catch {
                return "Invalid JSON: could not parse the snippets array.";
              }
            }
            if (!Array.isArray(parsed)) {
              return "Invalid input: expected a JSON array of snippet objects.";
            }
            let imported = 0;
            let skipped = 0;
            for (const item of parsed) {
              if (typeof item !== "object" || item === null) { skipped++; continue; }
              const s = item as Record<string, unknown>;
              if (typeof s.title !== "string" || typeof s.code !== "string") { skipped++; continue; }
              const language = typeof s.language === "string" ? s.language : "";
              const description = typeof s.description === "string" ? s.description : "";
              const tags = Array.isArray(s.tags) ? JSON.stringify(s.tags) : "[]";
              // SL-2: hash the stored form; OR IGNORE on the unique hash index
              // is the dedupe — previously nothing matched on, so every import
              // duplicated the whole library.
              const title = truncateStored(scrubStore(s.title), STORE_CAPS.snippetTitle);
              const code = truncateStored(s.code, STORE_CAPS.snippetCode);
              const hash = snippetHash(title, code);
              // SL-2: honor the incoming id when the payload carries one, so
              // `#id` references quoted earlier stay meaningful after a
              // migrate → import round trip. An occupied id is skipped.
              const id = typeof s.id === "number" && Number.isInteger(s.id) && s.id > 0 ? s.id : null;
              const result =
                id !== null
                  ? database.prepare(
                      "INSERT OR IGNORE INTO snippets (id, title, code, language, description, tags, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ).run(id, title, code, language, description, tags, hash)
                  : database.prepare(
                      "INSERT OR IGNORE INTO snippets (title, code, language, description, tags, hash) VALUES (?, ?, ?, ?, ?, ?)",
                    ).run(title, code, language, description, tags, hash);
              if (result.changes > 0) imported++; else skipped++;
            }
            log(`imported ${imported} snippet(s), skipped ${skipped}`);
            return `Imported ${imported} snippet(s), skipped ${skipped}.`;
          }, true);
          return { content: out };
        },
      });

      // E56: snippet_stats — returns total count, count by language, most-used tags, and oldest/newest dates
      editor.add({
        name: "snippet_stats",
        description:
          "Report snippet library statistics: total count, count by language, most-used tags, and oldest/newest snippet dates.",
        input: z.object({}),
        execute: async () => {
          const out = withRetry(() => {
            const database = getDb();
            const total = (database.prepare("SELECT COUNT(*) as count FROM snippets").get() as { count: number }).count;
            if (total === 0) return "No snippets in the library.";

            const byLanguage = database.prepare(
              "SELECT language, COUNT(*) as count FROM snippets GROUP BY language ORDER BY count DESC"
            ).all() as Array<{ language: string; count: number }>;

            const tagCounts = new Map<string, number>();
            const allTags = database.prepare("SELECT tags FROM snippets").all() as Array<{ tags: string }>;
            for (const row of allTags) {
              for (const tag of parseStringArray(row.tags)) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
              }
            }
            const topTags = [...tagCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10);

            const oldest = (database.prepare("SELECT created_at FROM snippets ORDER BY created_at ASC LIMIT 1").get() as { created_at: string } | null)?.created_at ?? "n/a";
            const newest = (database.prepare("SELECT created_at FROM snippets ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | null)?.created_at ?? "n/a";

            const lines: string[] = [
              `Total snippets: ${total}`,
              "",
              "By language:",
              ...byLanguage.map((r) => `  ${r.language || "(none)"}: ${r.count}`),
            ];
            if (topTags.length > 0) {
              lines.push("", "Top tags:");
              for (const [tag, count] of topTags) {
                lines.push(`  ${tag}: ${count}`);
              }
            }
            lines.push("", `Oldest: ${oldest}`, `Newest: ${newest}`);
            return lines.join("\n");
          });
          return { content: out };
        },
      });
    });

    log(`dir=${cfg.dir} enabled=${cfg.enabled}`);

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
