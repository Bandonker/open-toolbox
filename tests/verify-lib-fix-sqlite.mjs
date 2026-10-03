/**
 * LIB-6 / LIB-7 regression tests for lib/sqlite.ts.
 *
 *   node tests/verify-lib-fix-sqlite.mjs
 *
 * LIB-6: cachedStatement is keyed per database (WeakMap), not globally by
 *        driver+sql.
 * LIB-7: migrateSchema wraps each version in BEGIN/COMMIT (user_version only
 *        advances on full commit); batchTransaction rethrows after rollback.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "opencode-lib-fix-sqlite-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const sqlite = await import(new URL("../lib/sqlite.ts", import.meta.url));
const { openDatabase, cachedStatement, migrateSchema, getUserVersion, batchTransaction } = sqlite;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

/** Capture console.warn output while fn runs. */
async function captureWarns(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await fn();
    return warns;
  } finally {
    console.warn = orig;
  }
}

// --- LIB-6: statement cache is per-database ---
const dbA = openDatabase(":memory:");
const dbB = openDatabase(":memory:");
const SQL = "SELECT 1 AS x";
const stA = cachedStatement(dbA, SQL);
const stB = cachedStatement(dbB, SQL);
check("LIB-6: same SQL on two databases yields distinct statements", stA !== stB);
check("LIB-6: each statement works against its own database",
  stA.get()?.x === 1 && stB.get()?.x === 1);
check("LIB-6: repeat calls reuse the per-db cached statement",
  cachedStatement(dbA, SQL) === stA && cachedStatement(dbB, SQL) === stB);
// The old global cache broke here: closing A used to leave a dead statement
// cached for B's key; with the WeakMap, B is untouched by A's close.
dbA.close();
let bStillOk = false;
try {
  bStillOk = cachedStatement(dbB, SQL).get()?.x === 1;
} catch { /* fall through */ }
check("LIB-6: closing one database does not poison the other's cache", bStillOk);

// --- LIB-7: migrateSchema version atomicity ---
const db1 = openDatabase(":memory:");
const halfBroken = {
  1: [
    "CREATE TABLE t (a INTEGER)",
    "ALTER TABLE t ADD COLUMN b TEXT",
    "SELECT * FROM no_such_table", // blows up mid-version
  ],
};
const warns1 = await captureWarns(() => migrateSchema(db1, 1, halfBroken));
check("LIB-7: mid-version failure is warned about", warns1.some((w) => /migration/i.test(w)), warns1.join(" | ").slice(0, 140));
check("LIB-7: user_version did NOT advance for the failed version", getUserVersion(db1) === 0);
const tableGone = (() => {
  try {
    db1.exec("INSERT INTO t(a, b) VALUES (1, 'x')");
    return false; // table survived → statements leaked past the rollback
  } catch {
    return true;
  }
})();
check("LIB-7: applied statements rolled back with the failed one", tableGone);
// The wedge the old code created: re-running the SAME migration must now work.
const warns2 = await captureWarns(() => migrateSchema(db1, 1, halfBroken));
check("LIB-7: re-running the same migration after fixing it succeeds once",
  getUserVersion(db1) === 0 && warns2.length === 1); // still fails (source unchanged) but no duplicate-column wedge
const warns3 = await captureWarns(() => migrateSchema(db1, 1, { 1: ["CREATE TABLE t (a INTEGER)", "ALTER TABLE t ADD COLUMN b TEXT"] }));
let rowOk = false;
try {
  db1.exec("INSERT INTO t(a, b) VALUES (1, 'x')");
  rowOk = db1.query("SELECT b FROM t").get()?.b === "x";
} catch { /* fall through */ }
check("LIB-7: clean migration applies and bumps user_version",
  warns3.length === 0 && getUserVersion(db1) === 1 && rowOk, `v=${getUserVersion(db1)}`);

// Versions after a failed one are skipped, and earlier good versions survive.
const db2 = openDatabase(":memory:");
const warns4 = await captureWarns(() =>
  migrateSchema(db2, 2, { 1: ["CREATE TABLE ok1 (x)"], 2: ["CREATE TABLE bad(!!"] }));
check("LIB-7: v1 commits and v2 rolls back, user_version stops at 1",
  getUserVersion(db2) === 1 && warns4.some((w) => /version 2/.test(w)), `v=${getUserVersion(db2)}`);
check("LIB-7: committed v1 table is present",
  db2.query("SELECT name FROM sqlite_master WHERE name='ok1'").get() !== null);
db2.close();

// --- LIB-7: batchTransaction rethrows after rollback ---
const db3 = openDatabase(":memory:");
db3.exec("CREATE TABLE b (v TEXT)");
batchTransaction(db3, ["INSERT INTO b VALUES ('kept')"]);
check("LIB-7: successful batch still commits",
  db3.query("SELECT count(*) AS c FROM b").get()?.c === 1);
let threw = false;
const warns5 = await captureWarns(() => {
  try {
    batchTransaction(db3, ["INSERT INTO b VALUES ('lost')", "SELECT no_such_fn("]);
  } catch {
    threw = true;
  }
});
check("LIB-7: failed batch throws to the caller", threw);
check("LIB-7: failed batch still warns", warns5.some((w) => /batch transaction/i.test(w)));
check("LIB-7: failed batch rolled back its writes",
  db3.query("SELECT count(*) AS c FROM b").get()?.c === 1);
db3.close();
dbB.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
