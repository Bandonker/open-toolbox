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
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("WITH")) {
    return {
      get(...params: unknown[]) {
        return db.prepare(sql).get(...params) ?? null;
      },
      all(...params: unknown[]) {
        return db.prepare(sql).all(...params) as unknown[];
      },
      run() {
        throw new Error("run() called on a read query: " + sql.slice(0, 80));
      },
    };
  }
  if (/LAST_INSERT_ROWID\(\)/i.test(sql)) {
    return {
      get() {
        return db.prepare("SELECT last_insert_rowid() as id").get() as unknown;
      },
      all() {
        return [db.prepare("SELECT last_insert_rowid() as id").get()] as unknown[];
      },
      run() {
        throw new Error("run() called on last_insert_rowid query");
      },
    };
  }
  return {
    get(...params: unknown[]) {
      throw new Error("get() called on a write statement: " + sql.slice(0, 80));
    },
    all(...params: unknown[]) {
      throw new Error("all() called on a write statement: " + sql.slice(0, 80));
    },
    run(...params: unknown[]) {
      db.prepare(sql).run(...params);
      let lastInsertRowid: number | bigint = 0;
      try {
        const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
        lastInsertRowid = row.id;
      } catch {}
      return { lastInsertRowid, changes: 0 };
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

export function quoteFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" ");
}
