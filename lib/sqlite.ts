import { createRequire } from "node:module";
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from "node:fs";

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
      if (/^\s*BEGIN TRANSACTION/i.test(sql)) {
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
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("WITH")) {
    return {
      get(...params: unknown[]) {
        return stmt().get(...params) ?? null;
      },
      all(...params: unknown[]) {
        return stmt().all(...params) as unknown[];
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
      const result = stmt().run(...params) ?? {};
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: result.lastInsertRowid ?? 0,
      };
    },
  };
}

export function openDatabase(path: string): AnyDatabase {
  if (!existsSync(path)) {
    const { mkdirSync: mk } = require("node:fs");
    const { dirname } = require("node:path");
    mk(dirname(path), { recursive: true });
  }
  if (BunSqlite) return openBun(path);
  if (NodeSqlite) return openNode(path);
  throw new Error("No sqlite driver available (need bun:sqlite or node:sqlite).");
}

export function applyPragmas(db: AnyDatabase): void {
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
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const { join } = require("node:path");
  copyFileSync(opts.dbPath, join(opts.backupDir, `${ts}.db`));
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
  const { join } = require("node:path");
  return join(backupDir, files[files.length - 1]);
}

export function isCorruption(err: unknown): boolean {
  const msg = String(err);
  return /corrupt|malformed|disk image|not a database/i.test(msg);
}

/** CR-2: detect lock contention so callers can back off and retry. */
export function isBusy(err: unknown): boolean {
  const msg = String(err);
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
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
export function quoteFtsQuery(query: string): string | null {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
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
    const row = probe.query("PRAGMA integrity_check").get() as { integrity_check?: unknown } | null;
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
  const { join } = require("node:path");
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
    const row = db.query("PRAGMA integrity_check").get() as { integrity_check?: unknown } | null;
    const value = row?.integrity_check;
    return typeof value === "string" && value.toLowerCase() === "ok";
  } catch {
    return false;
  }
}