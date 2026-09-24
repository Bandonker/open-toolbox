import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
} from "fs";
import { homedir } from "os";
import { join, relative, sep, extname } from "path";
import {
  openDatabase,
  applyPragmas,
  isCorruption,
  latestValidBackup,
  checkOpenDb,
  quoteFtsQuery,
  dbUnavailable,
  clampLimit,
  copyBackupIntoPlace,
  type AnyDatabase,
} from "../lib/sqlite.ts";
const DB_DIR = join(homedir(), ".opencode-plugins", "codebase-index");
const DB_PATH = join(DB_DIR, "codebase.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;

const DEFAULT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
  ".swift", ".kt", ".rb", ".php",
  ".css", ".scss", ".less", ".sass",
  ".html", ".htm", ".xml", ".json", ".yaml", ".yml", ".toml",
  ".md", ".sql", ".graphql", ".proto",
  ".sh", ".bash", ".zsh",
  ".dockerfile", ".tf", ".hcl",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", ".next", ".nuxt", ".output",
  "coverage", ".nyc_output",
  "vendor", "bower_components",
  ".cache", "cache", ".tox", ".eggs", "__pycache__",
  ".serverless", ".webpack",
  "target", "bin", "obj",
  ".gradle", ".idea", ".vscode",
  ".opencode-memory",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
  ".DS_Store", "Thumbs.db",
]);

const CHUNK_SIZE = 50;
const CHUNK_OVERLAP = 10;
const MAX_FILE_SIZE = 512_000;

/**
 * I1: canonical root-path form so index and lookup always agree — trailing
 * separators trimmed, backslashes normalized to `/`, and on Windows the path
 * lowercased (drive letters + case-insensitive filesystem). Previously a
 * trailing backslash or different casing silently missed the index.
 */
function normalizeRoot(p: string): string {
  let out = p.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (process.platform === "win32" && /^[A-Za-z]:/.test(out)) {
    out = out.toLowerCase();
  }
  return out;
}

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    // DL-2: mkdir inside try; on failure reset the half-open handle and
    // rethrow — callers (writeDb/readDb) route it to backup-restore.
    try {
      if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
      db = openDatabase(DB_PATH);
      applyPragmas(db);
      db.exec("PRAGMA foreign_keys=ON");
      initSchema(db);
    } catch (e) {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      throw e;
    }
  }
  return db;
}

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      file_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      last_indexed_at TEXT
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL
    )
  `);

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_chunks_project ON code_chunks(project_id)"
  );

  // I3: per-file fingerprints so re-indexing can skip unchanged files
  // instead of rebuilding the whole project every run.
  database.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, rel_path)
    )
  `);

  const ftsExists = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='code_chunks_fts'")
    .get() as { name: string } | null;

  if (!ftsExists) {
    database.exec(`
      CREATE VIRTUAL TABLE code_chunks_fts USING fts5(
        content,
        content=code_chunks,
        content_rowid=id,
        tokenize='trigram'
      )
    `);

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END
    `);

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO code_chunks_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
  }

  ensureFtsIndex(database);
}

/**
 * P7 + trigger lifecycle (D1-analog): the FTS index uses the `trigram`
 * tokenizer (porter stemming never matches camelCase/snake_case substrings
 * that matter in code); legacy porter/unicode61 indexes are migrated once —
 * the rebuild is automatic. The sync triggers are (re)ensured on every open
 * so a dropped trigger can't silently stop indexing.
 */
function ensureFtsIndex(database: AnyDatabase): void {
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON code_chunks BEGIN
       INSERT INTO code_chunks_fts(rowid, content) VALUES (new.id, new.content);
     END`,
    `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON code_chunks BEGIN
       INSERT INTO code_chunks_fts(code_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
     END`,
    `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON code_chunks BEGIN
       INSERT INTO code_chunks_fts(code_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
       INSERT INTO code_chunks_fts(rowid, content) VALUES (new.id, new.content);
     END`,
  ];
  try {
    for (const t of triggers) database.exec(t);
  } catch {
    /* fts table missing — nothing to sync */
  }

  // Read the tokenizer setting; tolerate both known _config schemas and
  // bail out (leaving the index untouched) if neither is readable.
  let tokenize = "";
  try {
    const row = database
      .query("SELECT v FROM code_chunks_fts_config WHERE k = 'tokenize'")
      .get() as { v?: unknown } | null;
    tokenize = row ? String(row.v ?? "") : "";
  } catch {
    try {
      const row = database
        .query("SELECT val AS v FROM code_chunks_fts_config WHERE colname = 'tokenize'")
        .get() as { v?: unknown } | null;
      tokenize = row ? String(row.v ?? "") : "";
    } catch {
      return;
    }
  }
  if (tokenize.includes("trigram")) return;

  try {
    database.exec("DROP TRIGGER IF EXISTS chunks_ai");
    database.exec("DROP TRIGGER IF EXISTS chunks_ad");
    database.exec("DROP TRIGGER IF EXISTS chunks_au");
    database.exec("DROP TABLE IF EXISTS code_chunks_fts");
    database.exec(`
      CREATE VIRTUAL TABLE code_chunks_fts USING fts5(
        content,
        content=code_chunks,
        content_rowid=id,
        tokenize='trigram'
      )
    `);
    for (const t of triggers) database.exec(t);
    database.exec("INSERT INTO code_chunks_fts(code_chunks_fts) VALUES('rebuild')");
  } catch {
    /* migration is best effort — the index keeps working either way */
  }
}

function backupDb(): void {
  const now = Date.now();
  if (now - lastBackupTime < 300000) return;
  const database = db;
  if (!database) return;
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(DB_PATH, join(BACKUP_DIR, `${ts}.db`));
    const files = readdirSync(BACKUP_DIR)
      .filter((f: string) => f.endsWith(".db"))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_BACKUPS)) {
      rmSync(join(BACKUP_DIR, f), { force: true });
    }
    lastBackupTime = now;
  } catch {}
}

function getLatestBackup(): string | null {
  // I5/EN53: newest backup that passes an integrity check (previously the newest, blindly).
  return latestValidBackup(BACKUP_DIR);
}

function tryRestore(): boolean {
  if ((tryRestore as any)._active) return false;
  (tryRestore as any)._active = true;
  try {
    const backup = getLatestBackup();
    if (!backup) return false;
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
    // CR-7/CR-8: shared helper — wrapped I/O with context; also drops
    // -wal/-shm/-journal so they cannot be replayed on the restored snapshot.
    copyBackupIntoPlace(DB_PATH, backup);
    getDb();
    // J1: verify the restored copy — open/schema succeed lazily on corrupt
    // files, so a bad restore must be rejected, never served silently.
    if (!db || !checkOpenDb(db)) {
      try { db?.close(); } catch {}
      db = null;
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    (tryRestore as any)._active = false;
  }
}

function writeDb<T>(fn: () => T): T {
  try {
    const result = fn();
    try { backupDb(); } catch {}
    return result;
  } catch (err) {
    if (isCorruption(err) && tryRestore()) {
      try {
        const result = fn();
        try { backupDb(); } catch {}
        return result;
      } catch {}
    }
    // CR-3: never throw storage failures out of tools — every caller uses
    // the result as tool `content`, so surface a readable message instead.
    return dbUnavailable(err) as T;
  }
}

function readDb<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isCorruption(err) && tryRestore()) {
      try {
        return fn();
      } catch (restoreErr) {
        return dbUnavailable(restoreErr) as T;
      }
    }
    // CR-3: never throw storage failures out of tools.
    return dbUnavailable(err) as T;
  }
}

// --- File scanning & chunking ---

function* walkDir(dir: string): Generator<string> {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        yield* walkDir(fullPath);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!DEFAULT_EXTS.has(ext)) continue;
        yield fullPath;
      }
    }
  } catch {}
}

interface Chunk {
  relPath: string;
  absPath: string;
  index: number;
  startLine: number;
  endLine: number;
  content: string;
}

type FsLike = { statSync: typeof statSync; readFileSync: typeof readFileSync };

function chunkFile(absPath: string, rootPath: string, fs: FsLike = { statSync, readFileSync }): Chunk[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = fs.statSync(absPath);
  } catch {
    // CI-1: file vanished or is unreadable between walkDir and read — skip it.
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE || stat.size === 0) return [];

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8") as string;
  } catch {
    // CI-1: locked/unreadable file — skip it instead of aborting the index.
    return [];
  }
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const relPath = relative(rootPath, absPath).split(sep).join("/");
  const chunks: Chunk[] = [];
  const step = CHUNK_SIZE - CHUNK_OVERLAP;

  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + CHUNK_SIZE, lines.length);
    chunks.push({
      relPath,
      absPath,
      index: chunks.length,
      startLine: i + 1,
      endLine: end,
      content: lines.slice(i, end).join("\n"),
    });
    if (end >= lines.length) break;
  }

  return chunks;
}

function indexProject(rootPath: string): {
  files: number; chunks: number; skipped: number;
  updated: number; unchanged: number; removed: number;
} {
  const database = getDb();
  const resolvedPath = normalizeRoot(rootPath);
  const projectName = resolvedPath.split(/[\\/]/).pop() || "unknown";

  // I3: incremental re-index. The project row is reused across runs and each
  // file carries an (mtime, size) fingerprint in `indexed_files`. Unchanged
  // files are skipped; only new/changed files are re-chunked; files missing
  // from disk are dropped. FTS triggers stay enabled so per-row deltas keep
  // the FTS index in sync — no full rebuild.
  database.exec("BEGIN TRANSACTION");
  try {
    let project = database
      .query("SELECT id FROM projects WHERE root_path = ?")
      .get(resolvedPath) as { id: number } | null;
    if (!project) {
      database
        .query("INSERT INTO projects (root_path, name) VALUES (?, ?)")
        .run(resolvedPath, projectName);
      project = {
        id: Number(
          (database.query("SELECT last_insert_rowid() as id").get() as { id: number }).id
        ),
      };
    }
    const projectId = project.id;

    const prevRows = database
      .query("SELECT rel_path, mtime_ms, size_bytes FROM indexed_files WHERE project_id = ?")
      .all(projectId) as Array<{ rel_path: string; mtime_ms: number; size_bytes: number }>;
    const prev = new Map(prevRows.map((r) => [r.rel_path, r]));
    const seen = new Set<string>();

    const insertChunk = database.query(`
      INSERT INTO code_chunks (project_id, file_path, rel_path, chunk_index, start_line, end_line, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteFileChunks = database.query(
      "DELETE FROM code_chunks WHERE project_id = ? AND rel_path = ?"
    );
    const upsertFile = database.query(`
      INSERT INTO indexed_files (project_id, rel_path, mtime_ms, size_bytes, chunk_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, rel_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        chunk_count = excluded.chunk_count
    `);

    let skipped = 0;
    let updated = 0;
    let unchanged = 0;
    let removed = 0;

    for (const filePath of walkDir(resolvedPath)) {
      // Stat first: the (mtime, size) fingerprint decides skip vs re-chunk.
      let fingerprint: { mtimeMs: number; size: number; relPath: string } | null = null;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          skipped++;
          continue;
        }
        fingerprint = {
          mtimeMs: Math.floor(stat.mtimeMs),
          size: stat.size,
          relPath: relative(resolvedPath, filePath).split(sep).join("/"),
        };
      } catch {
        // CI-1: file vanished or is unreadable between walkDir and stat — skip it.
        skipped++;
        continue;
      }
      seen.add(fingerprint.relPath);
      const old = prev.get(fingerprint.relPath);
      if (old && old.mtime_ms === fingerprint.mtimeMs && old.size_bytes === fingerprint.size) {
        unchanged++;
        continue;
      }

      // New or changed file: re-chunk it (CI-1: one bad file never aborts the run).
      let chunks: Chunk[];
      try {
        chunks = chunkFile(filePath, resolvedPath);
      } catch {
        skipped++;
        continue;
      }
      try {
        deleteFileChunks.run(projectId, fingerprint.relPath);
        for (const ch of chunks) {
          insertChunk.run(
            projectId,
            ch.absPath,
            ch.relPath,
            ch.index,
            ch.startLine,
            ch.endLine,
            ch.content
          );
        }
        upsertFile.run(projectId, fingerprint.relPath, fingerprint.mtimeMs, fingerprint.size, chunks.length);
        updated++;
      } catch {
        // A single file's rows failed (e.g. transient write error) —
        // leave it out of the new index rather than failing everything.
        skipped++;
      }
    }

    // Files tracked in the DB but gone from disk leave the index.
    for (const relPath of prev.keys()) {
      if (seen.has(relPath)) continue;
      deleteFileChunks.run(projectId, relPath);
      database
        .query("DELETE FROM indexed_files WHERE project_id = ? AND rel_path = ?")
        .run(projectId, relPath);
      removed++;
    }

    const totals = database
      .query(
        "SELECT COUNT(CASE WHEN chunk_count > 0 THEN 1 END) AS files, COALESCE(SUM(chunk_count), 0) AS chunks FROM indexed_files WHERE project_id = ?"
      )
      .get(projectId) as { files: number; chunks: number };
    const fileCount = Number(totals.files);
    const chunkCount = Number(totals.chunks);

    database.query(`
      UPDATE projects SET file_count = ?, chunk_count = ?, last_indexed_at = datetime('now')
      WHERE id = ?
    `).run(fileCount, chunkCount, projectId);

    database.exec("COMMIT");

    return { files: fileCount, chunks: chunkCount, skipped, updated, unchanged, removed };
  } catch (err) {
    try { database.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

// --- Tools ---

export default Plugin.define({
  id: "codebase-index",
  async setup(ctx) {
    const defaultDirectory = ctx.location.directory;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "codebase_index",
        description:
          "Scan and index a codebase directory for full-text search. Reads source files, splits them into chunks, and builds an FTS5 index. Run this before using codebase_search. Re-runs are incremental: unchanged files are skipped, changed files are re-chunked, deleted files are dropped.",
        input: z.object({
          path: z.string().optional().describe("Root path of the codebase to index (default: current project directory)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { path?: string };
          const out = writeDb(() => {
            const rootPath = args.path || defaultDirectory;
            if (!rootPath || !existsSync(rootPath)) {
              return JSON.stringify({ error: `Path not found: ${rootPath}` });
            }
            const result = indexProject(rootPath);
            return JSON.stringify({
              indexed: true,
              path: normalizeRoot(rootPath),
              files: result.files,
              chunks: result.chunks,
              skipped: result.skipped,
              updated: result.updated,
              unchanged: result.unchanged,
              removed: result.removed,
            });
          });
          return { content: out };
        },
      });

      editor.add({
        name: "codebase_search",
        description:
          "Search indexed code using FTS5 full-text search with BM25 ranking. Finds relevant code by matching function names, comments, variables, and code patterns. Always check the index status first if unsure whether a project has been indexed.",
        input: z.object({
          query: z.string().describe("Search query — natural language or code terms describing what to find"),
          path: z.string().optional().describe("Root path of the indexed project (if omitted, searches all indexed projects)"),
          filter: z.string().optional().describe("Optional path filter — narrows results to files matching a substring or pattern (e.g. 'src/api' or '.ts')"),
          limit: z.number().optional().describe("Maximum results to return (1-50)"),
        }),
        execute: async (input, toolCtx) => {
          const args = input as {
            query: string; path?: string; filter?: string; limit?: number;
          };
          const out = readDb(() => {
          const targetPath = normalizeRoot(args.path || defaultDirectory || "");
          if (targetPath && targetPath.length > 0) {
            const isIndexed = readDb(() => {
              const database = getDb();
              const row = database
                .query("SELECT id FROM projects WHERE root_path = ?")
                .get(targetPath) as { id: number } | null;
              return row !== null;
            });
            if (!isIndexed && existsSync(targetPath)) {
              return `Project at "${targetPath}" is not indexed. Run codebase_index first.`;
            }
          }
          return readDb(() => {
            const database = getDb();
            const ftsQuery = quoteFtsQuery(args.query);
            // I2/S4: an empty/whitespace query must not reach MATCH — an
            // empty MATCH string throws an FTS5 syntax error.
            if (ftsQuery === null) return "No results (empty query).";
            // P7/trigram: terms shorter than 3 chars cannot match a trigram
            // index — tell the caller instead of returning an engine error.
            if (args.query.trim().split(/\s+/).some((t) => t.length < 3)) {
              return "No results — use search terms of at least 3 characters.";
            }
            // Shared clampLimit: trunc + finite guard.
            const limit = clampLimit(args.limit ?? 15, 15, 50);
            const params: unknown[] = [ftsQuery];

            let projectWhere = "";
            if (args.path) {
              projectWhere = "AND p.root_path = ?";
              params.push(targetPath);
            }

            let filterWhere = "";
            if (args.filter) {
              filterWhere = "AND c.rel_path LIKE ?";
              params.push(`%${args.filter}%`);
            }

            params.push(limit);

      const sql = `
        SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, p.root_path, p.name as project, rank
        FROM code_chunks_fts
        JOIN code_chunks c ON c.id = code_chunks_fts.rowid
        JOIN projects p ON c.project_id = p.id
        WHERE code_chunks_fts MATCH ?
          ${projectWhere}
          ${filterWhere}
        ORDER BY rank
        LIMIT ?
      `;

      try {
        const rows = database.query(sql).all(...params) as Array<{
          id: number;
          rel_path: string;
          start_line: number;
          end_line: number;
          content: string;
          root_path: string;
          project: string;
          rank: number;
        }>;

        // I1: JSON-pair keys — a `:` separator broke on Windows drive
        // letters (C:\...), mangling every grouped path.
        const grouped: Record<string, typeof rows> = {};
        for (const r of rows) {
          const key = JSON.stringify([r.root_path, r.rel_path]);
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(r);
        }

        const parts = Object.entries(grouped).flatMap(([key, chunks]) => {
          const [, filePath] = JSON.parse(key) as [string, string];
          const header = `## \`${filePath}\` (${chunks[0].project})`;
          const items = chunks.map(
            (c) =>
              `**Chunk** (lines ${c.start_line}-${c.end_line}, score: ${c.rank.toFixed(2)})\n\`\`\`\n${c.content}\n\`\`\``
          );
          return [header, ...items, "---"];
        });

        return `Found ${rows.length} result${rows.length === 1 ? "" : "s"}:\n\n${parts.slice(0, -1).join("\n\n")}`;
      } catch (err) {
        return JSON.stringify({
          error: `Search failed: ${(err as Error).message}`,
        });
      }
    });
          });
          return { content: out };
        },
      });

      editor.add({
        name: "codebase_index_status",
        description:
          "Show index statistics for a codebase: file count, chunk count, last indexed timestamp, and project info. Use this to check if a project has been indexed before searching.",
        input: z.object({
          path: z.string().optional().describe("Project root path to check (if omitted, shows all indexed projects)"),
        }),
        execute: async (input) => {
          const args = input as { path?: string };
          const out = readDb(() => {
            const database = getDb();

            if (args.path) {
              const resolved = normalizeRoot(args.path);
              const row = database
                .query("SELECT * FROM projects WHERE root_path = ?")
                .get(resolved) as Record<string, unknown> | null;

        if (!row) {
          return JSON.stringify({ indexed: false, path: resolved });
        }

            return JSON.stringify({
              indexed: true,
              path: row.root_path,
              name: row.name,
              files: row.file_count,
              chunks: row.chunk_count,
              last_indexed: row.last_indexed_at,
            });
            }

            const rows = database
              .query("SELECT * FROM projects ORDER BY last_indexed_at DESC")
              .all() as Array<Record<string, unknown>>;

            return JSON.stringify(
              rows.length === 0
                ? { indexed: false, projects: [] }
                : {
                    indexed: true,
                    projects: rows.map((r) => ({
                      path: r.root_path,
                      name: r.name,
                      files: r.file_count,
                      chunks: r.chunk_count,
                      last_indexed: r.last_indexed_at,
                    })),
                  },
              null,
              2
            );
          });
          return { content: out };
        },
      });

      editor.add({
        name: "codebase_delete_index",        description:
          "Delete a project's index from the codebase database. Removes all chunks and FTS entries for the specified path.",
        input: z.object({
          path: z.string().describe("Root path of the project index to delete"),
        }),
        execute: async (input) => {
          const args = input as { path: string };
          const out = writeDb(() => {
            const database = getDb();
            const resolved = normalizeRoot(args.path);
            const project = database
              .query("SELECT id, name FROM projects WHERE root_path = ?")
              .get(resolved) as { id: number; name: string } | null;
            if (!project) {
              return JSON.stringify({ deleted: false, error: "not found", path: resolved });
            }
            // PRAGMA foreign_keys is never enabled (see lib/sqlite.ts), so
            // ON DELETE CASCADE on code_chunks/indexed_files is inert —
            // delete the rows explicitly or re-indexing resurrects orphans.
            database.query("DELETE FROM code_chunks WHERE project_id = ?").run(project.id);
            database.query("DELETE FROM indexed_files WHERE project_id = ?").run(project.id);
            database.query("DELETE FROM projects WHERE id = ?").run(project.id);
            return JSON.stringify({ deleted: true, path: resolved, name: project.name });
          });
          return { content: out };
        },
      });
    });
  },
});

/** Test hooks (CI-1): unit access to chunkFile without a database. */
export const __test__ = { chunkFile };
