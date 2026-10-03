import { createRequire } from "node:module";
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const BunSqlite: any = (() => {
  try {
    return require("bun:sqlite");
  } catch {
    return null;
  }
})();
const NodeSqlite: any = (() => {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
})();

export type AnyDatabase = any;

// Hoisted regex: the wrapNodeDb exec path is hot, so the BEGIN TRANSACTION
// test must not re-compile a literal on every call.
const BEGIN_TRANSACTION_RE = /^\s*BEGIN TRANSACTION/i;

function openBun(path: string): AnyDatabase {
  const { Database } = BunSqlite;
  return new Database(path);
}

function openNode(path: string): AnyDatabase {
  const { DatabaseSync } = NodeSqlite;
  const db = new DatabaseSync(path);
  return wrapNodeDb(db);
}

function wrapNodeDb(db: any): AnyDatabase {
  return {
    __nodeDb: db,
    exec(sql: string) {
      if (BEGIN_TRANSACTION_RE.test(sql)) {
        db.exec("BEGIN");
        return;
      }
      db.exec(sql);
    },
    query(sql: string) {
      return wrapNodeStmt(db, sql);
    },
    prepare(sql: string) {
      return wrapNodeStmt(db, sql);
    },
    close() {
      db.close();
    },
  };
}

function wrapNodeStmt(db: any, sql: string): any {
  // S2: cache the prepared statement — re-preparing on every call made
  // bulk inserts noticeably slower under node:sqlite than under bun:sqlite.
  let prepared: any = null;
  const stmt = () => (prepared ??= db.prepare(sql));
  // E22: statement failures rethrow with the offending SQL (truncated) so a
  // failed query is diagnosable from the error message alone.
  const sqlErr = (err: unknown): Error =>
    new Error(`SQL failed: ${sql.slice(0, 200)}: ${err instanceof Error ? err.message : String(err)}`);
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("WITH")) {
    return {
      get(...params: unknown[]) {
        try {
          return stmt().get(...params) ?? null;
        } catch (err) {
          throw sqlErr(err);
        }
      },
      all(...params: unknown[]) {
        try {
          return stmt().all(...params) as unknown[];
        } catch (err) {
          throw sqlErr(err);
        }
      },
      iterate(...params: unknown[]) {
        try {
          return stmt().iterate(...params) as IterableIterator<unknown>;
        } catch (err) {
          throw sqlErr(err);
        }
      },
      run() {
        throw new Error("run() called on a read query: " + sql.slice(0, 80));
      },
    };
  }
  // S3: the unreachable LAST_INSERT_ROWID() branch was removed; write
  // statements now pass through the native run() result so UPDATE/DELETE
  // report real `changes` and INSERTs report their real lastInsertRowid.
  return {
    get(...params: unknown[]) {
      throw new Error("get() called on a write statement: " + sql.slice(0, 80));
    },
    all(...params: unknown[]) {
      throw new Error("all() called on a write statement: " + sql.slice(0, 80));
    },
    run(...params: unknown[]) {
      try {
        const result = stmt().run(...params) ?? {};
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: result.lastInsertRowid ?? 0,
        };
      } catch (err) {
        throw sqlErr(err);
      }
    },
  };
}

export function openDatabase(path: string): AnyDatabase {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (BunSqlite) return openBun(path);
  if (NodeSqlite) return openNode(path);
  throw new Error("No sqlite driver available (need bun:sqlite or node:sqlite).");
}

// E13/E24 helpers: pragmas are connection-scoped and idempotent, so applying
// them more than once per handle only costs round-trips. Track handles in a
// WeakSet (dies with the handle) and skip repeats unless explicitly forced.
const pragmaApplied = new WeakSet<object>();

// Hoisted regex: backup timestamps use ISO text; `:` and `.` are invalid in
// Windows filenames. Global flag is safe for String.replace (lastIndex is
// reset by the spec before each replace).
const BACKUP_STAMP_RE = /[:.]/g;

export function applyPragmas(db: AnyDatabase, force = false): void {
  if (!force && pragmaApplied.has(db)) return;
  pragmaApplied.add(db);
  for (const p of [
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=NORMAL",
    "PRAGMA cache_size=-8000",
    "PRAGMA temp_store=MEMORY",
    // CR-2: wait on locked pages instead of failing fast. Concurrent
    // sessions (and the backup checkpoint path) hit SQLITE_BUSY under
    // load; a 5s timeout lets short writers drain without surfacing
    // raw lock errors to tools.
    "PRAGMA busy_timeout=5000",
  ]) {
    try {
      db.exec(p);
    } catch {}
  }
}

export interface BackupOptions {
  dbPath: string;
  backupDir: string;
  maxBackups?: number;
  throttleMs?: number;
  lastBackupTime: () => number;
  setLastBackupTime: (t: number) => void;
}

export function maybeBackupDb(opts: BackupOptions): void {
  const now = Date.now();
  const throttle = opts.throttleMs ?? 300000;
  if (now - opts.lastBackupTime() < throttle) return;
  if (!existsSync(opts.dbPath)) return;
  // S1: WAL checkpoint before copying — commits still living in the -wal
  // file would otherwise be silently missing from the backup, and the
  // tryRestore() paths would then restore stale data. TRUNCATE empties the
  // -wal so the single-file copy is complete. Best effort: fall back to
  // copying whatever is on disk if checkpointing fails.
  let ck: AnyDatabase | null = null;
  try {
    ck = openDatabase(opts.dbPath);
    ck.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* best effort */
  } finally {
    try {
      ck?.close();
    } catch {
      /* ignore */
    }
  }
  mkdirSync(opts.backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(BACKUP_STAMP_RE, "-");
  const backupPath = join(opts.backupDir, `${ts}.db`);
  copyFileSync(opts.dbPath, backupPath);
  // E20: verify the copy landed intact — a partial copy (disk full,
  // interruption) would otherwise leave a corrupt backup that a later
  // restore would trust. Drop it and warn instead; lastBackupTime is
  // deliberately not advanced so the next cycle retries.
  if (!integrityOk(backupPath)) {
    try {
      rmSync(backupPath, { force: true });
    } catch {
      /* best effort */
    }
    console.warn(`open-toolbox: backup failed integrity check and was removed: ${backupPath}`);
    return;
  }
  const backups = readdirSync(opts.backupDir)
    .filter((f: string) => f.endsWith(".db"))
    .sort();
  const max = opts.maxBackups ?? 5;
  while (backups.length > max) {
    rmSync(join(opts.backupDir, backups.shift()!));
  }
  opts.setLastBackupTime(now);
}

export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f: string) => f.endsWith(".db"))
    .sort();
}

export function latestBackup(backupDir: string): string | null {
  const files = listBackups(backupDir);
  if (files.length === 0) return null;
  return join(backupDir, files[files.length - 1]);
}

// Hoisted per-call regexes — these run on every error classification.
const CORRUPTION_RE = /corrupt|malformed|disk image|not a database/i;
const BUSY_RE = /SQLITE_BUSY|database is locked|database table is locked/i;

export function isCorruption(err: unknown): boolean {
  const msg = String(err);
  return CORRUPTION_RE.test(msg);
}

/** CR-2: detect lock contention so callers can back off and retry. */
export function isBusy(err: unknown): boolean {
  const msg = String(err);
  return BUSY_RE.test(msg);
}

/**
 * CR-3: format a storage failure as tool content instead of throwing out of
 * a tool. Missing drivers, ENOTDIR, EACCES, and locked files must surface
 * as a readable message so the session continues.
 */
export function dbUnavailable(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Storage unavailable: ${msg}`;
}

/**
 * CR-1: parse a JSON string-array cell defensively. A single corrupt row
 * must not throw out of a whole-tool read — returns [] instead.
 */
export function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Quote a user query as a safe FTS5 MATCH expression. Every token is quoted,
 * so FTS5 operators in user text cannot change query semantics (tool
 * descriptions that claim "FTS5 syntax" are corrected accordingly).
 *
 * S4: returns null for empty/whitespace-only input — callers must treat null
 * as "no results" instead of passing "" to MATCH, which throws
 * `fts5: syntax error near ""`.
 */
// Hoisted regex: split() clones the pattern internally and replace() resets
// lastIndex, so the `g` flag is safe here.
const FTS_WHITESPACE_RE = /\s+/;
const FTS_QUOTE_RE = /"/g;

export function quoteFtsQuery(query: string): string | null {
  const tokens = query.split(FTS_WHITESPACE_RE).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((w) => `"${w.replace(FTS_QUOTE_RE, '""')}"`).join(" ");
}


/**
 * EN53/J1: check a SQLite file before trusting it. Restore paths used to copy the newest
 * backup blindly, so a corrupt backup could be restored silently and the store stayed broken.
 * Restores are rare, so a full integrity_check is affordable here.
 */
export function integrityOk(path: string): boolean {
  if (!existsSync(path)) return false;
  let probe: AnyDatabase | null = null;
  try {
    probe = openDatabase(path);
    const row = cachedStatement(probe, "PRAGMA integrity_check").get() as { integrity_check?: unknown } | null;
    const value = row?.integrity_check;
    return typeof value === "string" && value.toLowerCase() === "ok";
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

/** EN53/J1: newest backup that passes `PRAGMA integrity_check`, or null when none is valid. */
export function latestValidBackup(backupDir: string): string | null {
  const files = listBackups(backupDir);
  for (let i = files.length - 1; i >= 0; i--) {
    const candidate = join(backupDir, files[i]);
    if (integrityOk(candidate)) return candidate;
  }
  return null;
}

/**
 * J1: verify an already-open handle before serving it. The pre-copy
 * `latestValidBackup` check is not enough — a backup can land corrupt
 * (failed copy, concurrent write), and open/schema calls succeed lazily on
 * such copies. Run `integrity_check` on the restored handle itself so a bad
 * restore is rejected instead of served silently. Restores are rare, so the
 * full check is affordable here.
 */
export function checkOpenDb(db: AnyDatabase): boolean {
  try {
    const row = cachedStatement(db, "PRAGMA integrity_check").get() as { integrity_check?: unknown } | null;
    const value = row?.integrity_check;
    return typeof value === "string" && value.toLowerCase() === "ok";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Cross-cutting robustness helpers (Task 1: CR-4/CR-7/CR-8/CR-9,
 * DL-6/SN-6). Shared by decision-log, snippet-library, error-journal,
 * memory, and codebase-index so the copies cannot drift again.
 * ------------------------------------------------------------------ */

/**
 * CR-4: caps for unbounded text stored into SQLite/FTS. Values that exceed
 * a cap are truncated with a " [truncated]" marker so the loss is visible.
 * Caps: error-journal error_text/context/resolution 20_000 each;
 * decision-log title 500 / bodies 20_000; memory text 20_000; snippets
 * title 300 / code 100_000 / description 5_000; memory recall row 2_000;
 * snippet preview 600.
 */
export const STORE_CAPS = {
  errorField: 20_000,
  decisionTitle: 500,
  decisionBody: 20_000,
  memoryText: 20_000,
  snippetTitle: 300,
  snippetCode: 100_000,
  snippetDescription: 5_000,
  memoryRecallRow: 2_000,
  snippetPreview: 600,
} as const;

const TRUNC_MARKER = " [truncated]";

/** CR-4: truncate over-long stored text, marking the cut visibly. */
export function truncateStored(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNC_MARKER.length)) + TRUNC_MARKER;
}

/**
 * DL-6/SN-6: coerce a user-supplied `limit` into a safe integer for LIMIT.
 * Non-numbers, NaN, and Infinity fall back to `def`; finite values are
 * truncated and clamped into [1, max].
 */
export function clampLimit(value: unknown, def: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** CR-9: true when every named trigger exists (checks ai/ad/au, not just ai). */
export function hasTriggers(database: AnyDatabase, names: string[]): boolean {
  const rows = cachedStatement(
    database,
    "SELECT name FROM sqlite_master WHERE type='trigger'",
  ).all() as Array<{ name?: unknown }>;
  const present = new Set(rows.map((r) => r.name));
  return names.every((n) => present.has(n));
}

/* ------------------------------------------------------------------ *
 * Shared maintenance utilities (E305, E307, E309, E312)
 * ------------------------------------------------------------------ */

/**
 * E305: Reclaim disk space by running VACUUM on the database.
 * Best-effort: logs a warning on failure instead of throwing.
 */
export function vacuum(db: AnyDatabase): void {
  try {
    db.exec("VACUUM");
  } catch (err) {
    console.warn(`open-toolbox: VACUUM failed: ${String(err)}`);
  }
}

/**
 * E305: Rebuild an FTS5 index from its content table.
 * Best-effort: logs a warning on failure instead of throwing.
 */
export function rebuildFts(db: AnyDatabase, tableName: string): void {
  try {
    db.exec(`INSERT INTO ${tableName}(${tableName}) VALUES('rebuild')`);
  } catch (err) {
    console.warn(`open-toolbox: FTS rebuild failed for ${tableName}: ${String(err)}`);
  }
}

/**
 * E307: Build a SQL fragment for filtering rows by tags stored in a JSON array column.
 * Returns a clause (empty string when no tags) and the corresponding params.
 * Uses AND logic: all tags must match.
 */
export function buildTagFilter(tags: string[], column: string): { clause: string; params: unknown[] } {
  if (tags.length === 0) return { clause: "", params: [] };
  const params: unknown[] = [];
  const conditions: string[] = [];
  for (const tag of tags) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`);
    params.push(tag);
  }
  return { clause: ` AND ${conditions.join(" AND ")}`, params };
}

/* ------------------------------------------------------------------ *
 * Pattern documentation (E309, E312)
 * ------------------------------------------------------------------ */

/**
 * E309: DRY RUN PATTERN
 * ---------------------
 * For tools that modify data, provide a `dryRun` flag that shows what would
 * happen without actually doing it. The pattern is:
 *
 * 1. Accept `dryRun: z.boolean().optional()` in the input schema.
 * 2. If dryRun is true, compute what would happen and return a description
 *    prefixed with "Dry run — ".
 * 3. If dryRun is false or absent, perform the actual operation.
 *
 * See error_delete in error-journal.ts for a reference implementation.
 */

/**
 * E312: BACKUP/RESTORE PATTERN
 * ----------------------------
 * All plugins that use SQLite should follow this pattern for backup and restore:
 *
 * 1. BACKUP: Use `maybeBackupDb()` from lib/sqlite.ts with a throttle (e.g. 5 min).
 *    - WAL checkpoint (TRUNCATE) is done before copying.
 *    - Integrity is verified after copy; corrupt backups are removed.
 *    - Old backups are pruned to maxBackups (default 5).
 *
 * 2. RESTORE: On corruption detection:
 *    a. Close the current db handle.
 *    b. Call `latestValidBackup()` to find the newest valid backup.
 *    c. Use `copyBackupIntoPlace()` to restore it (also drops -wal/-shm).
 *    d. Re-open and verify with `checkOpenDb()`.
 *    e. If verification fails, return null and surface an error.
 *
 * 3. RETRY: After restore, retry the operation once. If it fails again, return
 *    `dbUnavailable(err)` instead of throwing.
 *
 * See decision-log.ts and error-journal.ts for reference implementations.
 */

/**
 * CR-8: replace a corrupt db file with a backup copy. Filesystem I/O is
 * wrapped so failures surface with context instead of a bare fs error.
 */
export function copyBackupIntoPlace(dbPath: string, latest: string): void {
  // Best-effort sidecar cleanup: a sibling process may still hold the db
  // open (Windows locks the -wal), and a locked sidecar must not fail the
  // restore — this matches the historical per-file ignore behavior.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch { /* ignore */ }
  }
  try {
    copyFileSync(latest, dbPath);
  } catch (err) {
    throw new Error(
      `Failed to restore backup ${latest} to ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * E13-E24: Query timeout, retry, migrations, FTS5 snippet, DB size,
 * slow query logging, read-only mode, transaction batching, statement
 * cache, WAL checkpoint scheduling.
 * ------------------------------------------------------------------ */

/**
 * E13: Set a query timeout on the database (milliseconds).
 * Best-effort: logs a warning on failure instead of throwing.
 */
export function setQueryTimeout(db: AnyDatabase, timeoutMs: number): void {
  try {
    db.exec(`PRAGMA query_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
  } catch (err) {
    console.warn(`open-toolbox: failed to set query timeout: ${String(err)}`);
  }
}

/**
 * E14: Retry a database operation with exponential backoff.
 * Best-effort: returns the result of the last attempt.
 */
export async function retryDb<T>(
  fn: () => T | Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 100, maxDelayMs = 5000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * E15: Run a schema migration if the target version is newer than current.
 * Best-effort: logs a warning on failure instead of throwing.
 * LIB-7: each version runs inside BEGIN/COMMIT with the `user_version` bump
 * in the same transaction — a mid-version failure rolls the whole version
 * back instead of leaving applied statements behind that would re-run (and
 * wedge, e.g. duplicate ALTER TABLE ADD COLUMN) on the next open.
 */
export function migrateSchema(
  db: AnyDatabase,
  targetVersion: number,
  migrations: Record<number, string[]>,
): void {
  try {
    const current = getUserVersion(db);
    if (current >= targetVersion) return;
    for (let v = current + 1; v <= targetVersion; v++) {
      const stmts = migrations[v];
      if (!stmts || stmts.length === 0) {
        db.exec(`PRAGMA user_version = ${v}`);
        continue;
      }
      try {
        db.exec("BEGIN");
        for (const sql of stmts) {
          db.exec(sql);
        }
        db.exec(`PRAGMA user_version = ${v}`);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch { /* ignore */ }
        console.warn(`open-toolbox: schema migration to version ${v} failed (rolled back, later versions skipped): ${String(err)}`);
        return;
      }
    }
  } catch (err) {
    console.warn(`open-toolbox: schema migration failed: ${String(err)}`);
  }
}

/**
 * E15: Get the current schema version from the database.
 */
export function getUserVersion(db: AnyDatabase): number {
  try {
    const row = cachedStatement(db, "PRAGMA user_version").get() as { user_version?: unknown } | null;
    return typeof row?.user_version === "number" ? row.user_version : 0;
  } catch {
    return 0;
  }
}

/**
 * E16: Generate an FTS5 snippet for a search result.
 * Returns a string with the match highlighted using <mark> tags.
 */
export function ftsSnippet(
  db: AnyDatabase,
  tableName: string,
  column: string,
  rowid: number,
  opts: { before?: string; after?: string; maxTokens?: number } = {},
): string {
  const { before = "<mark>", after = "</mark>", maxTokens = 32 } = opts;
  try {
    const row = cachedStatement(
      db,
      `SELECT snippet(${tableName}, ${column}, '${before}', '${after}', '…', ${maxTokens}) AS s FROM ${tableName} WHERE rowid = ?`,
    ).get(rowid) as { s?: unknown } | null;
    return typeof row?.s === "string" ? row.s : "";
  } catch {
    return "";
  }
}

/**
 * E17: Get the database file size in bytes.
 * Returns 0 if the file doesn't exist or can't be read.
 */
export function dbSizeBytes(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

/**
 * E18: Log slow queries to stderr.
 * Returns a function that wraps a query and logs if it exceeds the threshold.
 */
export function slowQueryLogger(thresholdMs: number): (sql: string, durationMs: number) => void {
  return (sql: string, durationMs: number) => {
    if (durationMs > thresholdMs) {
      console.warn(`open-toolbox: slow query (${durationMs.toFixed(1)}ms): ${sql.slice(0, 200)}`);
    }
  };
}

/**
 * E19: Set the database to read-only mode.
 * Best-effort: logs a warning on failure instead of throwing.
 */
export function setReadOnly(db: AnyDatabase, readOnly: boolean): void {
  try {
    db.exec(`PRAGMA query_only = ${readOnly ? 1 : 0}`);
  } catch (err) {
    console.warn(`open-toolbox: failed to set read-only mode: ${String(err)}`);
  }
}

/**
 * E21: Execute a batch of SQL statements in a single transaction.
 * LIB-7: failures roll back, warn, and RETHROW — silently returning after a
 * rollback made callers believe writes landed. No caller may depend on the
 * old swallow-and-continue behavior.
 */
export function batchTransaction(db: AnyDatabase, statements: string[]): void {
  try {
    db.exec("BEGIN TRANSACTION");
    for (const sql of statements) {
      db.exec(sql);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch { /* ignore */ }
    console.warn(`open-toolbox: batch transaction failed: ${String(err)}`);
    throw err;
  }
}

/**
 * E23: Prepared statement cache.
 * LIB-6: keyed per database handle in a WeakMap — the old global
 * `"node"|"bun" + sql` key could hand a statement prepared against DB A to
 * DB B with the same SQL, and never dropped statements for closed DBs.
 * A WeakMap lets each cache die with its handle.
 */
const stmtCaches = new WeakMap<object, Map<string, any>>();
const STMT_CACHE_MAX = 128;

export function cachedStatement(db: AnyDatabase, sql: string): any {
  let cache = stmtCaches.get(db);
  if (!cache) {
    cache = new Map<string, any>();
    stmtCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    // Bound the cache: dynamic SQL (e.g. ftsSnippet) can mint unbounded
    // distinct strings, so evict the oldest entry once we hit the cap.
    // Simple FIFO via Map insertion order — no hit-based reordering, so
    // the hot statements stay until they age out.
    if (cache.size >= STMT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

/**
 * E24: Schedule periodic WAL checkpoints.
 * Returns a function to stop the scheduler.
 */
export function scheduleWalCheckpoint(
  db: AnyDatabase,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch { /* ignore */ }
  }, intervalMs);
  return () => clearInterval(timer);
}