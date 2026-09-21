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
  quoteFtsQuery,
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

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    db = openDatabase(DB_PATH);
    applyPragmas(db);
    db.exec("PRAGMA foreign_keys=ON");
    initSchema(db);
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

  const ftsExists = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='code_chunks_fts'")
    .get() as { name: string } | null;

  if (!ftsExists) {
    database.exec(`
      CREATE VIRTUAL TABLE code_chunks_fts USING fts5(
        content,
        content=code_chunks,
        content_rowid=id,
        tokenize='porter'
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
}

// --- Backup & recovery ---

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
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR)
    .filter((f: string) => f.endsWith(".db"))
    .sort()
    .reverse();
  return files.length > 0 ? join(BACKUP_DIR, files[0]) : null;
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
    for (const ext of ["", "-wal", "-shm"]) {
      const p = DB_PATH + ext;
      if (existsSync(p)) rmSync(p, { force: true });
    }
    copyFileSync(backup, DB_PATH);
    getDb();
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
    throw err;
  }
}

function readDb<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isCorruption(err) && tryRestore()) {
      return fn();
    }
    throw err;
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

function chunkFile(absPath: string, rootPath: string): Chunk[] {
  const stat = statSync(absPath);
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE || stat.size === 0) return [];

  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const relPath = relative(rootPath, absPath);
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

function indexProject(rootPath: string): { files: number; chunks: number } {
  const database = getDb();
  const resolvedPath = rootPath.replace(/\/$/, "");
  const projectName = resolvedPath.split(sep).pop() || "unknown";

  const deleteStmt = database.query(
    "DELETE FROM code_chunks WHERE project_id = (SELECT id FROM projects WHERE root_path = ?)"
  );
  const deleteProject = database.query(
    "DELETE FROM projects WHERE root_path = ?"
  );

  database.exec("BEGIN TRANSACTION");
  try {
    deleteStmt.run(resolvedPath);
    deleteProject.run(resolvedPath);

    // Disable FTS triggers during bulk insert for performance
    database.exec("DROP TRIGGER IF EXISTS chunks_ai");
    database.exec("DROP TRIGGER IF EXISTS chunks_ad");
    database.exec("DROP TRIGGER IF EXISTS chunks_au");

    const insertProject = database.query(
      "INSERT INTO projects (root_path, name) VALUES (?, ?)"
    );
    insertProject.run(resolvedPath, projectName);
    const projectId = Number(
      (database.query("SELECT last_insert_rowid() as id").get() as { id: number }).id
    );

    const insertChunk = database.query(`
      INSERT INTO code_chunks (project_id, file_path, rel_path, chunk_index, start_line, end_line, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let fileCount = 0;
    let chunkCount = 0;

    for (const filePath of walkDir(resolvedPath)) {
      const chunks = chunkFile(filePath, resolvedPath);
      if (chunks.length === 0) continue;
      fileCount++;

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
        chunkCount++;
      }
    }

    database.query(`
      UPDATE projects SET file_count = ?, chunk_count = ?, last_indexed_at = datetime('now')
      WHERE id = ?
    `).run(fileCount, chunkCount, projectId);

    database.exec("COMMIT");

    // Rebuild FTS index and recreate triggers
    try {
      database.exec("INSERT INTO code_chunks_fts(code_chunks_fts) VALUES('rebuild')");
    } catch {}
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

    return { files: fileCount, chunks: chunkCount };
  } catch (err) {
    try { database.exec("ROLLBACK"); } catch {}
    // Always restore triggers even on failure
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
          "Scan and index a codebase directory for full-text search. Reads source files, splits them into chunks, and builds an FTS5 index. Run this before using codebase_search. Re-runs replace the existing index for that path.",
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
              path: rootPath.replace(/\/$/, ""),
              files: result.files,
              chunks: result.chunks,
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
          const targetPath = (args.path || defaultDirectory || "").replace(/\/$/, "");
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
            // Quote each word individually to handle special chars (hyphens) while allowing multi-word AND matching
            const ftsQuery = quoteFtsQuery(args.query);
            const limit = Math.min(Math.max(args.limit ?? 15, 1), 50);
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

        const grouped: Record<string, typeof rows> = {};
        for (const r of rows) {
          const key = `${r.root_path}:${r.rel_path}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(r);
        }

        const parts = Object.entries(grouped).flatMap(([key, chunks]) => {
          const [root, ...rest] = key.split(":");
          const filePath = rest.join(":");
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
              const resolved = args.path.replace(/\/$/, "");
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
        name: "codebase_delete_index",
        description:
          "Delete a project's index from the codebase database. Removes all chunks and FTS entries for the specified path.",
        input: z.object({
          path: z.string().describe("Root path of the project index to delete"),
        }),
        execute: async (input) => {
          const args = input as { path: string };
          const out = writeDb(() => {
            const database = getDb();
            const resolved = args.path.replace(/\/$/, "");
            const project = database
              .query("SELECT id, name FROM projects WHERE root_path = ?")
              .get(resolved) as { id: number; name: string } | null;
            if (!project) {
              return JSON.stringify({ deleted: false, error: "not found", path: resolved });
            }
            database.query("DELETE FROM projects WHERE id = ?").run(project.id);
            return JSON.stringify({ deleted: true, path: resolved, name: project.name });
          });
          return { content: out };
        },
      });
    });
  },
});
