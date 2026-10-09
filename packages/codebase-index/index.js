import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { mkdirSync, existsSync, copyFileSync, readdirSync, readFileSync, statSync, rmSync, chmodSync, realpathSync, watch as watchFs, } from "fs";
import { homedir } from "os";
import { join, relative, sep, extname, isAbsolute } from "path";
import { openDatabase, applyPragmas, isCorruption, latestValidBackup, checkOpenDb, quoteFtsQuery, dbUnavailable, clampLimit, copyBackupIntoPlace, } from "./lib/sqlite.js";
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
    ".tf", ".hcl",
]);
/**
 * CI-5: `extname("Dockerfile")` is `""`, so extensionless well-known files
 * never matched DEFAULT_EXTS (the old ".dockerfile" entry was dead). Match
 * them by lowercase basename instead.
 */
const BASENAME_ALLOW = new Set([
    "dockerfile",
    "makefile",
    "gemfile",
    "rakefile",
    "vagrantfile",
    "jenkinsfile",
    "cmakelists.txt",
]);
/**
 * Directories never indexed.
 *
 * Entries are matched case-insensitively (see walkDir) so the index skips the
 * same directories on a case-sensitive Linux filesystem as it does on Windows.
 * Dot-directories are skipped by default anyway, but the dotted entries here
 * still matter: INDEX_DOT_DIRS=1 opts dot-directories back in and SKIP_DIRS
 * always wins, which is what stops a `venv` or `.mypy_cache` from being
 * indexed on request.
 */
const SKIP_DIRS = new Set([
    // Version control and dependencies
    "node_modules", ".git", ".svn", ".hg", ".bzr",
    "vendor", "bower_components", "deps", "pods",
    // Build and bundle output
    "dist", "build", ".next", ".nuxt", ".output", "out",
    "target", "bin", "obj", "_build", "elm-stuff",
    "cmakefiles", "cmake-build-debug", "cmake-build-release",
    "deriveddata", "release",
    // Caches and coverage
    "coverage", ".nyc_output",
    ".cache", "cache", ".parcel-cache", ".sass-cache",
    ".turbo", ".eslintcache", ".stylelintcache",
    // Python
    "__pycache__", ".venv", "venv", "virtualenv", ".tox", ".eggs",
    "__pypackages__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".hypothesis",
    // JS/TS tooling
    ".pnpm-store", ".yarn", ".parcel-cache", ".serverless", ".webpack",
    // JVM, .NET, Rust, Go, Haskell, Ruby, PHP
    ".gradle", ".idea", ".vscode", ".svelte-kit", ".angular",
    ".terraform", ".terragrunt-cache", ".stack-work", ".bundle",
    ".dart_tool", ".pub-cache", ".flutter-plugins",
    ".ipynb_checkpoints", ".vs",
    ".opencode-memory",
]);
/** Files never indexed: lockfiles plus desktop-environment metadata. */
const SKIP_FILES = new Set([
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
    // OS / file-manager metadata. .DS_Store is macOS, Thumbs.db is Windows and
    // Samba shares, .directory is Linux (Nautilus/Thunar/Dolphin), desktop.ini
    // is Windows. All are noise, and none are source.
    ".ds_store", "thumbs.db", ".directory", "desktop.ini",
]);
/**
 * CI-3: paths that carry credentials rather than source. Indexed content is
 * served back through codebase_search (and can quote config values), so a
 * `.env`, `secrets.yaml`, `token.json`, a mounted `~/.aws`/`~/.ssh` or a CI
 * workflow with an inline secret turns the index into a secret-reading tool
 * — secret-shield never sees these reads, they never pass a shielded tool
 * argument. Fail closed: the denylist wins over the extension allowlist and
 * over INDEX_DOT_DIRS. Matched against the slash-normalized lowercase
 * relative path (all segments).
 */
function isSecretPath(relPath) {
    const segs = relPath.toLowerCase().split(/[\\/]+/).filter(Boolean);
    if (!segs.length)
        return false;
    if (segs.includes(".aws") || segs.includes(".ssh"))
        return true;
    const wi = segs.lastIndexOf("workflows");
    if (wi > 0 && segs[wi - 1] === ".github")
        return true;
    const base = segs[segs.length - 1];
    if (base.startsWith(".env"))
        return true; // .env, .env.local, .env.production…
    if (/secret|credential|token/.test(base))
        return true;
    return false;
}
// E318: configurable chunk size / overlap / max file size via env vars.
const CHUNK_SIZE = Number(process.env.INDEX_CHUNK_SIZE) > 0 ? Number(process.env.INDEX_CHUNK_SIZE) : 50;
const CHUNK_OVERLAP = Number(process.env.INDEX_CHUNK_OVERLAP) > 0 ? Number(process.env.INDEX_CHUNK_OVERLAP) : 10;
const MAX_FILE_SIZE = Number(process.env.INDEX_MAX_FILE_SIZE) > 0 ? Number(process.env.INDEX_MAX_FILE_SIZE) : 512_000;
/**
 * E317: merge env-var extensions and skip lists into the hardcoded sets.
 * INDEX_EXTS: comma-separated extensions (e.g. ".vue,.svelte").
 * INDEX_SKIP_DIRS: comma-separated directory names to skip.
 * INDEX_SKIP_FILES: comma-separated filenames to skip.
 */
function mergeEnvLists() {
    const exts = (process.env.INDEX_EXTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const ext of exts)
        DEFAULT_EXTS.add(ext.startsWith(".") ? ext : `.${ext}`);
    const skipDirs = (process.env.INDEX_SKIP_DIRS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const d of skipDirs)
        SKIP_DIRS.add(d);
    const skipFiles = (process.env.INDEX_SKIP_FILES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const f of skipFiles)
        SKIP_FILES.add(f);
}
mergeEnvLists();
/**
 * I1: canonical root-path form so index and lookup always agree — trailing
 * separators trimmed, backslashes normalized to `/`, and on Windows the path
 * lowercased (drive letters + case-insensitive filesystem). Previously a
 * trailing backslash or different casing silently missed the index.
 */
function normalizeRoot(p) {
    let out = p.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
    // CI-8: only the drive letter is lowercased — the old whole-path
    // toLowerCase() mangled display/storage of case-sensitive segments.
    if (process.platform === "win32" && /^[A-Za-z]:/.test(out)) {
        out = out[0].toLowerCase() + out.slice(1);
    }
    return out;
}
/** CI-7: escape LIKE metacharacters so `filter` matches literally. */
function escapeLike(s) {
    return s.replace(/([%_\\])/g, "\\$1");
}
/** CI-10: dot-directories are skipped by default; opt in with INDEX_DOT_DIRS=1. */
function dotDirsAllowed() {
    const v = (process.env.INDEX_DOT_DIRS ?? "").toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}
/**
 * E324: Parse FTS5 query syntax (AND, OR, NOT, quoted phrases, ^).
 * Returns a normalized FTS5 query string, or null if the query is empty.
 *
 * Supported syntax:
 *   - "exact phrases" — quoted strings match exact phrases
 *   - AND — both terms must match
 *   - OR — either term must match
 *   - NOT — exclude matches
 *   - ^ — prefix match (term must start with the following text)
 *   - (grouping) — parentheses for grouping
 */
function parseFtsQuery(query) {
    const trimmed = query.trim();
    if (!trimmed)
        return null;
    // If the query already contains FTS5 operators, pass it through
    if (/\b(AND|OR|NOT)\b/i.test(trimmed) || trimmed.includes('"') || trimmed.includes("^") || trimmed.includes("(")) {
        return trimmed;
    }
    // Otherwise, treat as a simple space-separated term list
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return null;
    return tokens.join(" ");
}
let db = null;
let lastBackupTime = 0;
/**
 * E316: total on-disk size of the index database — the main file plus the
 * WAL/SHM sidecars when present (WAL mode means committed data can live in
 * the -wal file, so the main file alone under-reports).
 */
function dbSizeBytes() {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            total += statSync(`${DB_PATH}${suffix}`).size;
        }
        catch {
            // Sidecar absent (e.g. after a checkpoint) — skip it.
        }
    }
    return total;
}
function getDb() {
    if (!db) {
        // DL-2: mkdir inside try; on failure reset the half-open handle and
        // rethrow — callers (writeDb/readDb) route it to backup-restore.
        try {
            if (!existsSync(DB_DIR))
                mkdirSync(DB_DIR, { recursive: true });
            db = openDatabase(DB_PATH);
            // CI-3: indexed content is served back through codebase_search and can
            // quote anything a repo contains — keep the DB owner-only (SQLite
            // creates it world/group-readable by default). Best effort: a platform
            // without chmod must not fail the open.
            try {
                chmodSync(DB_PATH, 0o600);
            }
            catch { /* best effort */ }
            applyPragmas(db);
            db.exec("PRAGMA foreign_keys=ON");
            initSchema(db);
        }
        catch (e) {
            try {
                db?.close();
            }
            catch { /* ignore */ }
            db = null;
            throw e;
        }
    }
    return db;
}
function initSchema(database) {
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
    database.exec("CREATE INDEX IF NOT EXISTS idx_chunks_project ON code_chunks(project_id)");
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
        .get();
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
function ensureFtsIndex(database) {
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
        for (const t of triggers)
            database.exec(t);
    }
    catch {
        /* fts table missing — nothing to sync */
    }
    // Read the tokenizer setting; tolerate both known _config schemas and
    // bail out (leaving the index untouched) if neither is readable.
    let tokenize = "";
    try {
        const row = database
            .query("SELECT v FROM code_chunks_fts_config WHERE k = 'tokenize'")
            .get();
        tokenize = row ? String(row.v ?? "") : "";
    }
    catch {
        try {
            const row = database
                .query("SELECT val AS v FROM code_chunks_fts_config WHERE colname = 'tokenize'")
                .get();
            tokenize = row ? String(row.v ?? "") : "";
        }
        catch {
            return;
        }
    }
    if (tokenize.includes("trigram"))
        return;
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
        for (const t of triggers)
            database.exec(t);
        database.exec("INSERT INTO code_chunks_fts(code_chunks_fts) VALUES('rebuild')");
    }
    catch {
        /* migration is best effort — the index keeps working either way */
    }
}
function backupDb() {
    const now = Date.now();
    if (now - lastBackupTime < 300000)
        return;
    const database = db;
    if (!database)
        return;
    try {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        if (!existsSync(BACKUP_DIR))
            mkdirSync(BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        copyFileSync(DB_PATH, join(BACKUP_DIR, `${ts}.db`));
        const files = readdirSync(BACKUP_DIR)
            .filter((f) => f.endsWith(".db"))
            .sort()
            .reverse();
        for (const f of files.slice(MAX_BACKUPS)) {
            rmSync(join(BACKUP_DIR, f), { force: true });
        }
        lastBackupTime = now;
    }
    catch { }
}
function getLatestBackup() {
    // I5/EN53: newest backup that passes an integrity check (previously the newest, blindly).
    return latestValidBackup(BACKUP_DIR);
}
/**
 * CI-11: promise-join restore — concurrent callers await the same in-flight
 * restore instead of colliding on the old sync `_active` flag.
 */
let restorePromise = null;
function tryRestoreAsync() {
    if (restorePromise)
        return restorePromise;
    restorePromise = (async () => {
        try {
            const backup = getLatestBackup();
            if (!backup)
                return false;
            if (db) {
                try {
                    db.close();
                }
                catch { }
                db = null;
            }
            // CR-7/CR-8: shared helper — wrapped I/O with context; also drops
            // -wal/-shm/-journal so they cannot be replayed on the restored snapshot.
            copyBackupIntoPlace(DB_PATH, backup);
            getDb();
            // J1: verify the restored copy — open/schema succeed lazily on corrupt
            // files, so a bad restore must be rejected, never served silently.
            if (!db || !checkOpenDb(db)) {
                try {
                    db?.close();
                }
                catch { }
                db = null;
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    })();
    const inFlight = restorePromise;
    const clear = () => { if (restorePromise === inFlight)
        restorePromise = null; };
    inFlight.then(clear, clear);
    return inFlight;
}
/**
 * CI-3: single-writer promise mutex — index (which drops triggers and
 * rebuilds FTS) and search never interleave within this process, so a
 * concurrent search cannot hit a half-rebuilt FTS table.
 */
let dbMutex = Promise.resolve();
async function withDbMutex(fn) {
    const prev = dbMutex;
    let release;
    dbMutex = new Promise((res) => { release = res; });
    await prev;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
async function writeDb(fn) {
    return withDbMutex(async () => {
        try {
            const result = await fn();
            try {
                backupDb();
            }
            catch { }
            return result;
        }
        catch (err) {
            if (isCorruption(err) && await tryRestoreAsync()) {
                try {
                    const result = await fn();
                    try {
                        backupDb();
                    }
                    catch { }
                    return result;
                }
                catch (retryErr) {
                    return dbUnavailable(retryErr);
                }
            }
            // CR-3: never throw storage failures out of tools — every caller uses
            // the result as tool `content`, so surface a readable message instead.
            return dbUnavailable(err);
        }
    });
}
async function readDb(fn) {
    return withDbMutex(async () => {
        try {
            return await fn();
        }
        catch (err) {
            if (isCorruption(err) && await tryRestoreAsync()) {
                try {
                    return await fn();
                }
                catch (restoreErr) {
                    return dbUnavailable(restoreErr);
                }
            }
            // CR-3: never throw storage failures out of tools.
            return dbUnavailable(err);
        }
    });
}
function* walkDir(root, dir = root, scope) {
    let ctx;
    if (scope) {
        ctx = scope;
    }
    else {
        ctx = { seen: new Set(), realRoot: null };
        try {
            ctx.realRoot = realpathSync(root);
            ctx.seen.add(ctx.realRoot);
        }
        catch {
            /* root unresolvable — containment degrades to allow, cycle guard still works per-link */
        }
    }
    const withinRoot = (real) => {
        if (ctx.realRoot === null)
            return true;
        const rel = relative(ctx.realRoot, real);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    };
    const relOf = (fullPath) => {
        try {
            return relative(root, fullPath).split(sep).join("/");
        }
        catch {
            return fullPath;
        }
    };
    const indexableFile = (fullPath, name) => {
        if (isSecretPath(relOf(fullPath)))
            return false;
        if (SKIP_FILES.has(name.toLowerCase()))
            return false;
        const ext = extname(name).toLowerCase();
        // CI-5: extensionless well-known files via basename allowlist.
        if (!DEFAULT_EXTS.has(ext) && (ext !== "" || !BASENAME_ALLOW.has(name.toLowerCase())))
            return false;
        return true;
    };
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name.toLowerCase()))
                    continue;
                // CI-10: dot-directories are skipped by default; INDEX_DOT_DIRS=1
                // opts in (SKIP_DIRS such as .git still always skipped). CI-3: the
                // secret denylist still wins.
                if (entry.name.startsWith(".") && !dotDirsAllowed())
                    continue;
                if (isSecretPath(relOf(fullPath)))
                    continue;
                let real = null;
                try {
                    real = realpathSync(fullPath);
                }
                catch {
                    continue;
                }
                if (real && (ctx.seen.has(real) || !withinRoot(real)))
                    continue;
                if (real)
                    ctx.seen.add(real);
                yield* walkDir(root, fullPath, ctx);
            }
            else if (entry.isFile()) {
                if (!indexableFile(fullPath, entry.name))
                    continue;
                yield fullPath;
            }
            else {
                // L77: symlinks — Dirent.isFile() and isDirectory() both return false
                // for symlinks, so fall back to statSync which follows the link.
                // CI-3/CI-4: the resolved target must stay inside the indexed root,
                // and symlinked directories join the visited set.
                try {
                    const st = statSync(fullPath);
                    const real = realpathSync(fullPath);
                    if (!withinRoot(real))
                        continue;
                    if (st.isFile()) {
                        if (!indexableFile(fullPath, entry.name))
                            continue;
                        yield fullPath;
                    }
                    else if (st.isDirectory()) {
                        if (SKIP_DIRS.has(entry.name.toLowerCase()))
                            continue;
                        if (entry.name.startsWith(".") && !dotDirsAllowed())
                            continue;
                        if (isSecretPath(relOf(fullPath)) || ctx.seen.has(real))
                            continue;
                        ctx.seen.add(real);
                        yield* walkDir(root, fullPath, ctx);
                    }
                }
                catch {
                    // broken symlink or vanished — skip
                }
            }
        }
    }
    catch { }
}
function chunkFile(absPath, rootPath, fs = { statSync, readFileSync }) {
    let stat;
    try {
        stat = fs.statSync(absPath);
    }
    catch {
        // CI-1: file vanished or is unreadable between walkDir and read — skip it.
        return [];
    }
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE || stat.size === 0)
        return [];
    let content;
    try {
        content = fs.readFileSync(absPath, "utf-8");
    }
    catch {
        // CI-1: locked/unreadable file — skip it instead of aborting the index.
        return [];
    }
    // CI-9: binary-as-text guard + BOM strip (BOM would otherwise be indexed).
    if (content.includes("\0"))
        return [];
    // L79: strip multiple leading BOMs (e.g. files saved with double BOM).
    content = content.replace(/^(\uFEFF)+/, "");
    const lines = content.split("\n");
    // L78: defensive — content.split always returns at least one element,
    // and the stat.size === 0 guard above already filters empty files.
    // This is a safety net in case the code is refactored later.
    const relPath = relative(rootPath, absPath).split(sep).join("/");
    const chunks = [];
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
        if (end >= lines.length)
            break;
    }
    return chunks;
}
function indexProject(rootPath, opts) {
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
            .get(resolvedPath);
        if (!project) {
            database
                .query("INSERT INTO projects (root_path, name) VALUES (?, ?)")
                .run(resolvedPath, projectName);
            project = {
                id: Number(database.query("SELECT last_insert_rowid() as id").get().id),
            };
        }
        const projectId = project.id;
        const oldCounts = database
            .query("SELECT file_count, chunk_count FROM projects WHERE id = ?")
            .get(projectId);
        const prevRows = database
            .query("SELECT rel_path, mtime_ms, size_bytes FROM indexed_files WHERE project_id = ?")
            .all(projectId);
        const prev = new Map(prevRows.map((r) => [r.rel_path, r]));
        const seen = new Set();
        const insertChunk = database.query(`
      INSERT INTO code_chunks (project_id, file_path, rel_path, chunk_index, start_line, end_line, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        const deleteFileChunks = database.query("DELETE FROM code_chunks WHERE project_id = ? AND rel_path = ?");
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
        let done = 0;
        const total = [...walkDir(resolvedPath)].length;
        for (const filePath of walkDir(resolvedPath)) {
            // Stat first: the (mtime, size) fingerprint decides skip vs re-chunk.
            let fingerprint = null;
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
            }
            catch {
                // CI-1: file vanished or is unreadable between walkDir and stat — skip it.
                skipped++;
                continue;
            }
            seen.add(fingerprint.relPath);
            const old = prev.get(fingerprint.relPath);
            // E313: `force` skips the incremental fingerprint check and re-chunks
            // every file, even when mtime/size are unchanged.
            if (!opts?.force && old && old.mtime_ms === fingerprint.mtimeMs && old.size_bytes === fingerprint.size) {
                unchanged++;
                done++;
                opts?.onProgress?.(done, total, fingerprint.relPath);
                continue;
            }
            // New or changed file: re-chunk it (CI-1: one bad file never aborts the run).
            let chunks;
            try {
                chunks = chunkFile(filePath, resolvedPath);
            }
            catch {
                skipped++;
                continue;
            }
            try {
                deleteFileChunks.run(projectId, fingerprint.relPath);
                for (const ch of chunks) {
                    insertChunk.run(projectId, ch.absPath, ch.relPath, ch.index, ch.startLine, ch.endLine, ch.content);
                }
                upsertFile.run(projectId, fingerprint.relPath, fingerprint.mtimeMs, fingerprint.size, chunks.length);
                updated++;
            }
            catch {
                // A single file's rows failed (e.g. transient write error) —
                // leave it out of the new index rather than failing everything.
                skipped++;
            }
            done++;
            opts?.onProgress?.(done, total, fingerprint.relPath);
        }
        // Files tracked in the DB but gone from disk leave the index.
        for (const relPath of prev.keys()) {
            if (seen.has(relPath))
                continue;
            deleteFileChunks.run(projectId, relPath);
            database
                .query("DELETE FROM indexed_files WHERE project_id = ? AND rel_path = ?")
                .run(projectId, relPath);
            removed++;
        }
        const totals = database
            .query("SELECT COUNT(CASE WHEN chunk_count > 0 THEN 1 END) AS files, COALESCE(SUM(chunk_count), 0) AS chunks FROM indexed_files WHERE project_id = ?")
            .get(projectId);
        const fileCount = Number(totals.files);
        const chunkCount = Number(totals.chunks);
        // CI-4: a scan that finds zero files (e.g. the root was deleted between
        // the existsSync check and the walk) must not commit an empty index over
        // a good one — roll back and keep the previous index instead.
        if (fileCount === 0 && prev.size > 0) {
            database.exec("ROLLBACK");
            return {
                files: Number(oldCounts?.file_count ?? 0),
                chunks: Number(oldCounts?.chunk_count ?? 0),
                skipped,
                updated: 0,
                unchanged: 0,
                removed: 0,
                emptySkipped: true,
                forced: opts?.force === true,
            };
        }
        database.query(`
      UPDATE projects SET file_count = ?, chunk_count = ?, last_indexed_at = datetime('now')
      WHERE id = ?
    `).run(fileCount, chunkCount, projectId);
        database.exec("COMMIT");
        return { files: fileCount, chunks: chunkCount, skipped, updated, unchanged, removed, forced: opts?.force === true };
    }
    catch (err) {
        try {
            database.exec("ROLLBACK");
        }
        catch { }
        throw err;
    }
}
// --- File watching (E319, CI-1/CI-2) ---
/**
 * CI-2: one watcher per normalized root, kept in a MODULE-scoped Map so a
 * repeated `codebase_index {watch:true}` REPLACES the previous watcher
 * instead of leaking a new recursive fs.watch per call (N watchers × M
 * directories ⇒ inotify exhaustion), and every watcher is closed when the
 * setup that created it is torn down.
 */
const watchers = new Map();
/**
 * CI-1: same filter semantics as walkDir applied to a watcher-supplied
 * path — SKIP_DIRS / dot-dir rules / SKIP_FILES / the CI-3 secret denylist
 * / the extension+basename allowlist. The old watcher applied none of them
 * and indexed whatever the OS reported.
 */
function isPathIndexable(rootResolved, fullPath) {
    const rel = relative(rootResolved, fullPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        return false;
    const segs = rel.split(sep);
    const base = segs[segs.length - 1];
    for (const d of segs.slice(0, -1)) {
        if (SKIP_DIRS.has(d.toLowerCase()))
            return false;
        if (d.startsWith(".") && !dotDirsAllowed())
            return false;
    }
    if (SKIP_FILES.has(base.toLowerCase()))
        return false;
    if (isSecretPath(segs.join("/")))
        return false;
    const ext = extname(base).toLowerCase();
    if (!DEFAULT_EXTS.has(ext) && (ext !== "" || !BASENAME_ALLOW.has(base.toLowerCase())))
        return false;
    return true;
}
/**
 * CI-1: the per-file delta path indexProject uses — fingerprint check,
 * re-chunk, scoped delete+insert+upsert — applied to ONE file of ONE
 * project. The old watcher queried by rel_path alone with a hardcoded
 * project_id = 1: a shared relative path (README.md in two projects) made
 * one project's change DELETE every project's chunks and re-attribute the
 * rows to project 1. Every statement below carries project_id. Caller runs
 * this inside writeDb (withDbMutex serialization + corruption retry).
 */
function applyWatchEvent(rootResolved, fullPath) {
    const database = getDb();
    const project = database
        .query("SELECT id FROM projects WHERE root_path = ?")
        .get(rootResolved);
    if (!project)
        return; // this root was never indexed — nothing to keep in sync
    const projectId = Number(project.id);
    const relPath = relative(rootResolved, fullPath).split(sep).join("/");
    if (!relPath || relPath.startsWith("..") || isAbsolute(relPath))
        return;
    let stat = null;
    try {
        const s = statSync(fullPath);
        if (s.isFile() && s.size > 0 && s.size <= MAX_FILE_SIZE && isPathIndexable(rootResolved, fullPath)) {
            stat = s;
        }
    }
    catch {
        stat = null;
    }
    const removable = stat === null;
    database.exec("BEGIN TRANSACTION");
    try {
        if (removable) {
            // Vanished (or no longer indexable) — drop only THIS project's rows.
            database.query("DELETE FROM code_chunks WHERE project_id = ? AND rel_path = ?").run(projectId, relPath);
            database.query("DELETE FROM indexed_files WHERE project_id = ? AND rel_path = ?").run(projectId, relPath);
            database.exec("COMMIT");
            return;
        }
        const good = stat;
        const mtimeMs = Math.floor(good.mtimeMs);
        const prev = database
            .query("SELECT mtime_ms, size_bytes FROM indexed_files WHERE project_id = ? AND rel_path = ?")
            .get(projectId, relPath);
        if (!(prev && prev.mtime_ms === mtimeMs && prev.size_bytes === good.size)) {
            const chunks = chunkFile(fullPath, rootResolved);
            database.query("DELETE FROM code_chunks WHERE project_id = ? AND rel_path = ?").run(projectId, relPath);
            const insertChunk = database.query("INSERT INTO code_chunks (project_id, file_path, rel_path, chunk_index, start_line, end_line, content) VALUES (?, ?, ?, ?, ?, ?, ?)");
            for (const ch of chunks) {
                insertChunk.run(projectId, ch.absPath, ch.relPath, ch.index, ch.startLine, ch.endLine, ch.content);
            }
            database
                .query("INSERT INTO indexed_files (project_id, rel_path, mtime_ms, size_bytes, chunk_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, rel_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, chunk_count = excluded.chunk_count")
                .run(projectId, relPath, mtimeMs, good.size, chunks.length);
            const totals = database
                .query("SELECT COUNT(CASE WHEN chunk_count > 0 THEN 1 END) AS files, COALESCE(SUM(chunk_count), 0) AS chunks FROM indexed_files WHERE project_id = ?")
                .get(projectId);
            database
                .query("UPDATE projects SET file_count = ?, chunk_count = ?, last_indexed_at = datetime('now') WHERE id = ?")
                .run(Number(totals.files), Number(totals.chunks), projectId);
        }
        database.exec("COMMIT");
    }
    catch (err) {
        try {
            database.exec("ROLLBACK");
        }
        catch { /* ignore */ }
        throw err;
    }
}
/** Apply one watcher event through the write mutex (watcher + tests entry point). */
async function watchFileSync(rootResolved, fullPath) {
    await writeDb(() => {
        applyWatchEvent(rootResolved, fullPath);
        return "";
    });
}
function startWatcher(rootResolved, owned) {
    const previous = watchers.get(rootResolved);
    if (previous) {
        try {
            previous.close();
        }
        catch { /* already closed */ }
        watchers.delete(rootResolved);
    }
    const watcher = watchFs(rootResolved, { recursive: true }, (_event, filename) => {
        if (!filename)
            return;
        const full = join(rootResolved, String(filename));
        // CI-1: route through watchFileSync (writeDb ⇒ withDbMutex). writeDb
        // never rejects; the tool contract is "never throw out of a hook".
        void watchFileSync(rootResolved, full);
    });
    try {
        watcher.on("error", () => {
            try {
                watcher.close();
            }
            catch { /* ignore */ }
            if (watchers.get(rootResolved) === watcher)
                watchers.delete(rootResolved);
            owned.delete(rootResolved);
        });
    }
    catch { /* older runtimes without on() */ }
    watcher.unref?.();
    watchers.set(rootResolved, watcher);
    owned.add(rootResolved);
}
// --- Tools ---
export default Plugin.define({
    id: "codebase-index",
    async setup(ctx) {
        const defaultDirectory = ctx.location.directory;
        // CI-2: roots this setup started watchers for; the disposer below closes
        // exactly these when the host tears the plugin down.
        const ownedWatchers = new Set();
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "codebase_index",
                description: "Scan and index a codebase directory for full-text search. Reads source files, splits them into chunks, and builds an FTS5 index. Run this before using codebase_search. Re-runs are incremental: unchanged files are skipped, changed files are re-chunked, deleted files are dropped.",
                input: z.object({
                    path: z.string().optional().describe("Root path of the codebase to index (default: current project directory)"),
                    force: z.boolean().optional().describe("Re-index every file, skipping the incremental fingerprint check"),
                    watch: z.boolean().optional().describe("Watch for file changes and auto-reindex (E319)."),
                }),
                execute: async (input, toolCtx) => {
                    const args = input;
                    // CI-3: writeDb/readDb are async and mutex-guarded — callers await.
                    const out = await writeDb(() => {
                        const rootPath = args.path || defaultDirectory;
                        if (!rootPath || !existsSync(rootPath)) {
                            return JSON.stringify({ error: `Path not found: ${rootPath}` });
                        }
                        // E322: progress callback — reports every 10 files via console.error.
                        const onProgress = (done, total, file) => {
                            if (done % 10 === 0 || done === total) {
                                console.error(`[codebase-index] progress: ${done}/${total} files (${file})`);
                            }
                        };
                        const result = indexProject(rootPath, { force: args.force === true, onProgress });
                        return JSON.stringify({
                            indexed: true,
                            path: normalizeRoot(rootPath),
                            files: result.files,
                            chunks: result.chunks,
                            skipped: result.skipped,
                            updated: result.updated,
                            unchanged: result.unchanged,
                            removed: result.removed,
                            // E313: surface a forced re-index so it is distinguishable from
                            // an incremental run.
                            ...(result.forced ? { forced: true } : {}),
                            // CI-4: surface the refused empty commit so it is not silent.
                            ...(result.emptySkipped
                                ? { warning: "No indexable files found — kept the previous index." }
                                : {}),
                        });
                    });
                    // E319: file-watching auto-reindex. CI-2: keyed by normalized root
                    // in the module Map — replace-previous, never one new watcher per
                    // call — and closed again by the setup disposer below.
                    if (args.watch) {
                        const rootPath = args.path || defaultDirectory;
                        if (rootPath && existsSync(rootPath)) {
                            startWatcher(normalizeRoot(rootPath), ownedWatchers);
                        }
                    }
                    return { content: out };
                },
            });
            editor.add({
                name: "codebase_search",
                description: "Search indexed code using FTS5 full-text search with BM25 ranking. Finds relevant code by matching function names, comments, variables, and code patterns. Always check the index status first if unsure whether a project has been indexed.",
                input: z.object({
                    query: z.string().describe("Search query — natural language or code terms describing what to find"),
                    path: z.string().optional().describe("Root path of the indexed project (if omitted, searches all indexed projects)"),
                    filter: z.string().optional().describe("Optional path filter — narrows results to files matching a substring or pattern (e.g. 'src/api' or '.ts')"),
                    ext: z.string().optional().describe("Optional file-extension filter — narrows results to files ending in this extension (e.g. 'ts')"),
                    limit: z.number().optional().describe("Maximum results to return (1-50)"),
                    offset: z.number().int().min(0).optional().describe("Skip this many results (pagination)"),
                }),
                execute: async (input, toolCtx) => {
                    const args = input;
                    const out = await readDb(() => {
                        const database = getDb();
                        // CI-2: the indexed check applies only when a path is explicitly
                        // given. An omitted path searches all indexed projects — the old
                        // fallback to defaultDirectory produced a wrong "not indexed"
                        // error for the global search mode.
                        let projectWhere = "";
                        const scopeParams = [];
                        if (args.path) {
                            const targetPath = normalizeRoot(args.path);
                            const row = database
                                .query("SELECT id FROM projects WHERE root_path = ?")
                                .get(targetPath);
                            if (!row && existsSync(targetPath)) {
                                return `Project at "${targetPath}" is not indexed. Run codebase_index first.`;
                            }
                            projectWhere = "AND p.root_path = ?";
                            scopeParams.push(targetPath);
                        }
                        // E324: parse FTS5 query syntax (AND, OR, NOT, quoted phrases, ^)
                        const parsedQuery = parseFtsQuery(args.query);
                        if (parsedQuery === null)
                            return "No results (empty query).";
                        const tokens = parsedQuery.split(/\s+/).filter(Boolean);
                        // I2/S4: an empty/whitespace query must not reach MATCH — an
                        // empty MATCH string throws an FTS5 syntax error.
                        if (tokens.length === 0)
                            return "No results (empty query).";
                        // Shared clampLimit: trunc + finite guard.
                        const limit = clampLimit(args.limit ?? 15, 15, 50);
                        // E314: offset for pagination — non-finite/negative values fall
                        // back to 0 (the first page).
                        const offset = typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.trunc(args.offset) : 0;
                        // CI-7: filter is a literal substring — escape LIKE wildcards.
                        let filterWhere = "";
                        const filterParams = [];
                        if (args.filter) {
                            filterWhere = "AND c.rel_path LIKE ? ESCAPE '\\'";
                            filterParams.push(`%${escapeLike(args.filter)}%`);
                        }
                        // E323: ext is a suffix match on rel_path — a leading dot is
                        // tolerated (".ts" and "ts" behave the same).
                        let extWhere = "";
                        const extParams = [];
                        if (args.ext) {
                            const ext = args.ext.replace(/^\./, "").trim();
                            if (ext) {
                                extWhere = "AND c.rel_path LIKE ? ESCAPE '\\'";
                                extParams.push(`%.${escapeLike(ext)}`);
                            }
                        }
                        let rows;
                        try {
                            // CI-6: trigram needs 3+ chars — drop short tokens and search
                            // the remainder instead of rejecting the whole query; when
                            // every token is short, fall back to a LIKE scan.
                            const long = tokens.filter((t) => t.length >= 3);
                            if (long.length > 0) {
                                const ftsQuery = quoteFtsQuery(long.join(" "));
                                if (ftsQuery === null)
                                    return "No results (empty query).";
                                // E315: snippet() marks the matched terms with <mark> tags so
                                // the result shows WHERE in the chunk the match occurred.
                                // 128 tokens: the trigram tokenizer counts trigrams (not words),
                                // so a small count truncates long matches mid-token; 128 covers
                                // the match position in typical chunks.
                                rows = database.query(`
                  SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content,
                         snippet(code_chunks_fts, 0, '<mark>', '</mark>', '…', 128) AS snippet,
                         p.root_path, p.name as project, rank
                  FROM code_chunks_fts
                  JOIN code_chunks c ON c.id = code_chunks_fts.rowid
                  JOIN projects p ON c.project_id = p.id
                  WHERE code_chunks_fts MATCH ?
                    ${projectWhere}
                    ${filterWhere}
                    ${extWhere}
                  ORDER BY rank
                  LIMIT ? OFFSET ?
                `).all(ftsQuery, ...scopeParams, ...filterParams, ...extParams, limit, offset);
                            }
                            else {
                                rows = database.query(`
                  SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, p.root_path, p.name as project, 0 AS rank
                  FROM code_chunks c
                  JOIN projects p ON c.project_id = p.id
                  WHERE c.content LIKE ? ESCAPE '\\'
                    ${projectWhere}
                    ${filterWhere}
                    ${extWhere}
                  ORDER BY c.file_path, c.start_line
                  LIMIT ? OFFSET ?
                `).all(`%${escapeLike(tokens.join(" "))}%`, ...scopeParams, ...filterParams, ...extParams, limit, offset);
                            }
                        }
                        catch (err) {
                            return JSON.stringify({
                                error: `Search failed: ${err.message}`,
                            });
                        }
                        // CI-12: nested-Map grouping — no JSON.stringify/parse churn per group.
                        const grouped = new Map();
                        for (const r of rows) {
                            let byFile = grouped.get(r.root_path);
                            if (!byFile) {
                                byFile = new Map();
                                grouped.set(r.root_path, byFile);
                            }
                            const list = byFile.get(r.rel_path);
                            if (list)
                                list.push(r);
                            else
                                byFile.set(r.rel_path, [r]);
                        }
                        // L80: build without trailing separator instead of slicing it off.
                        const sections = [];
                        for (const byFile of grouped.values()) {
                            for (const [filePath, chunks] of byFile) {
                                const lines = [`## \`${filePath}\` (${chunks[0].project})`];
                                for (const c of chunks) {
                                    // E315: the FTS path returns a snippet with <mark> tags
                                    // around the matched terms — show it instead of the full
                                    // chunk so the match location is visible. The LIKE fallback
                                    // has no snippet, so it keeps the fenced full content.
                                    if (c.snippet) {
                                        lines.push(`**Chunk** (lines ${c.start_line}-${c.end_line}, score: ${c.rank.toFixed(2)})\n${c.snippet}`);
                                    }
                                    else {
                                        lines.push(`**Chunk** (lines ${c.start_line}-${c.end_line}, score: ${c.rank.toFixed(2)})\n\`\`\`\n${c.content}\n\`\`\``);
                                    }
                                }
                                lines.push("---");
                                sections.push(lines.join("\n"));
                            }
                        }
                        return `Found ${rows.length} result${rows.length === 1 ? "" : "s"}:\n\n${sections.join("\n\n")}`;
                    });
                    return { content: out };
                },
            });
            editor.add({
                name: "codebase_index_status",
                description: "Show index statistics for a codebase: file count, chunk count, last indexed timestamp, and project info. Use this to check if a project has been indexed before searching.",
                input: z.object({
                    path: z.string().optional().describe("Project root path to check (if omitted, shows all indexed projects)"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = await readDb(() => {
                        const database = getDb();
                        if (args.path) {
                            const resolved = normalizeRoot(args.path);
                            const row = database
                                .query("SELECT * FROM projects WHERE root_path = ?")
                                .get(resolved);
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
                                dbSizeBytes: dbSizeBytes(),
                            });
                        }
                        const rows = database
                            .query("SELECT * FROM projects ORDER BY last_indexed_at DESC")
                            .all();
                        return JSON.stringify(rows.length === 0
                            ? { indexed: false, projects: [], dbSizeBytes: dbSizeBytes() }
                            : {
                                indexed: true,
                                projects: rows.map((r) => ({
                                    path: r.root_path,
                                    name: r.name,
                                    files: r.file_count,
                                    chunks: r.chunk_count,
                                    last_indexed: r.last_indexed_at,
                                })),
                                dbSizeBytes: dbSizeBytes(),
                            }, null, 2);
                    });
                    return { content: out };
                },
            });
            editor.add({
                name: "codebase_delete_index",
                description: "Delete a project's index from the codebase database. Removes all chunks and FTS entries for the specified path.",
                input: z.object({
                    path: z.string().describe("Root path of the project index to delete"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = await writeDb(() => {
                        const database = getDb();
                        const resolved = normalizeRoot(args.path);
                        const project = database
                            .query("SELECT id, name FROM projects WHERE root_path = ?")
                            .get(resolved);
                        if (!project) {
                            return JSON.stringify({ deleted: false, error: "not found", path: resolved });
                        }
                        // Foreign keys are enabled for this database (PRAGMA foreign_keys=ON
                        // in getDb above) and the schema declares ON DELETE CASCADE, so
                        // deleting the project row cascades to code_chunks/indexed_files.
                        // The explicit deletes below are belt-and-braces for older DB
                        // files created before the PRAGMA was added.
                        database.exec("BEGIN TRANSACTION");
                        try {
                            database.query("DELETE FROM code_chunks WHERE project_id = ?").run(project.id);
                            database.query("DELETE FROM indexed_files WHERE project_id = ?").run(project.id);
                            database.query("DELETE FROM projects WHERE id = ?").run(project.id);
                            database.exec("COMMIT");
                        }
                        catch (err) {
                            try {
                                database.exec("ROLLBACK");
                            }
                            catch { }
                            throw err;
                        }
                        return JSON.stringify({ deleted: true, path: resolved, name: project.name });
                    });
                    return { content: out };
                },
            });
            // E320: index health check — integrity_check, FTS trigger existence,
            // orphaned row count.
            editor.add({
                name: "codebase_index_health",
                description: "Check the health of the codebase index: runs PRAGMA integrity_check, verifies FTS triggers exist, and counts orphaned rows.",
                input: z.object({}),
                execute: async () => {
                    const out = await readDb(() => {
                        const database = getDb();
                        const integrity = database.query("PRAGMA integrity_check").get();
                        const triggers = database
                            .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'chunks_%'")
                            .all();
                        const expectedTriggers = ["chunks_ai", "chunks_ad", "chunks_au"];
                        const missingTriggers = expectedTriggers.filter((t) => !triggers.some((r) => r.name === t));
                        // Orphaned chunks: rows in code_chunks whose project_id has no
                        // matching projects row.
                        const orphanedChunks = database
                            .query("SELECT COUNT(*) as n FROM code_chunks c LEFT JOIN projects p ON c.project_id = p.id WHERE p.id IS NULL")
                            .get();
                        const orphanedFiles = database
                            .query("SELECT COUNT(*) as n FROM indexed_files f LEFT JOIN projects p ON f.project_id = p.id WHERE p.id IS NULL")
                            .get();
                        return JSON.stringify({
                            integrity: integrity?.integrity_check ?? "unknown",
                            triggers: triggers.map((t) => t.name),
                            missingTriggers,
                            orphanedChunks: orphanedChunks?.n ?? 0,
                            orphanedFiles: orphanedFiles?.n ?? 0,
                            healthy: integrity?.integrity_check === "ok" && missingTriggers.length === 0 && (orphanedChunks?.n ?? 0) === 0 && (orphanedFiles?.n ?? 0) === 0,
                        });
                    });
                    return { content: out };
                },
            });
            // E321: diff index vs disk — walk the directory, compare against
            // indexed_files, return three lists: added, modified, removed.
            editor.add({
                name: "codebase_index_diff",
                description: "Compare the on-disk files against the index. Returns three lists: files on disk but not in the index (added), files in both but with different mtime/size (modified), and files in the index but not on disk (removed).",
                input: z.object({
                    path: z.string().optional().describe("Root path of the codebase (default: current project directory)"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = await readDb(() => {
                        const rootPath = args.path || defaultDirectory;
                        if (!rootPath || !existsSync(rootPath)) {
                            return JSON.stringify({ error: `Path not found: ${rootPath}` });
                        }
                        const database = getDb();
                        const resolved = normalizeRoot(rootPath);
                        const project = database
                            .query("SELECT id FROM projects WHERE root_path = ?")
                            .get(resolved);
                        if (!project) {
                            return JSON.stringify({ error: "Project not indexed", path: resolved });
                        }
                        const indexed = database
                            .query("SELECT rel_path, mtime_ms, size_bytes FROM indexed_files WHERE project_id = ?")
                            .all(project.id);
                        const indexedMap = new Map(indexed.map((r) => [r.rel_path, r]));
                        const diskFiles = new Map();
                        for (const filePath of walkDir(resolved)) {
                            try {
                                const stat = statSync(filePath);
                                if (!stat.isFile())
                                    continue;
                                const rel = relative(resolved, filePath).split(sep).join("/");
                                diskFiles.set(rel, { mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
                            }
                            catch {
                                // skip unreadable files
                            }
                        }
                        const added = [];
                        const modified = [];
                        for (const [rel, stat] of diskFiles) {
                            const row = indexedMap.get(rel);
                            if (!row)
                                added.push(rel);
                            else if (row.mtime_ms !== stat.mtimeMs || row.size_bytes !== stat.size)
                                modified.push(rel);
                        }
                        const removed = [];
                        for (const rel of indexedMap.keys()) {
                            if (!diskFiles.has(rel))
                                removed.push(rel);
                        }
                        return JSON.stringify({ added, modified, removed });
                    });
                    return { content: out };
                },
            });
        });
        // CI-2: watchers used to be "alive for the process lifetime" — one leaked
        // recursive fs.watch per watch:true call, never closed. Close everything
        // this setup started when the host disposes the plugin.
        return async () => {
            for (const root of ownedWatchers) {
                const watcher = watchers.get(root);
                try {
                    watcher?.close();
                }
                catch {
                    /* already closed */
                }
                if (watcher && watchers.get(root) === watcher)
                    watchers.delete(root);
            }
            ownedWatchers.clear();
        };
    },
});
/** Test hooks: unit access without a database. */
export const __test__ = {
    chunkFile,
    normalizeRoot,
    escapeLike,
    walkDir,
    SKIP_DIRS,
    SKIP_FILES,
    isSecretPath,
    isPathIndexable,
    watchFileSync,
    watchers,
};
