/**
 * J1 verification: a restored database is integrity-checked before it is
 * served. A backup that passes the pre-check can still land corrupt (failed
 * copy, concurrent write), and tryRestore used to serve it silently.
 *
 *   node tests/verify-restore-check.mjs
 */
import { rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// ------------------------------------------------------------------ unit: helper
const sqlite = await import(new URL("../lib/sqlite.ts", import.meta.url));
check("J1: checkOpenDb export exists", typeof sqlite.checkOpenDb === "function");

const unitDir = join(tmpdir(), "opencode-toolbox-verify-j1-unit");
rmSync(unitDir, { recursive: true, force: true });
mkdirSync(unitDir, { recursive: true });

try {
  const good = join(unitDir, "good.db");
  const db = sqlite.openDatabase(good);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  check("J1: checkOpenDb true on a healthy open db", sqlite.checkOpenDb(db) === true);
  try { db.close(); } catch {}
} catch (e) {
  check("J1: checkOpenDb true on a healthy open db", false, String(e).slice(0, 160));
}

try {
  check("J1: checkOpenDb false on a broken handle",
    sqlite.checkOpenDb({ query: () => { throw new Error("file is not a database"); } }) === false);
} catch (e) {
  check("J1: checkOpenDb false on a broken handle", false, String(e).slice(0, 160));
}

try {
  const garbage = join(unitDir, "garbage.db");
  writeFileSync(garbage, "this is definitely not a sqlite database file....");
  let opened = null, openThrew = null;
  try { opened = sqlite.openDatabase(garbage); } catch (e) { openThrew = e; }
  if (opened) {
    check("J1: checkOpenDb false on a corrupt file opened lazily", sqlite.checkOpenDb(opened) === false);
    try { opened.close(); } catch {}
  } else {
    check("J1: corrupt file fails fast on open", /not a database|malformed|corrupt/i.test(String(openThrew)), String(openThrew).slice(0, 120));
  }
} catch (e) {
  check("J1: corrupt-file probe", false, String(e).slice(0, 160));
}

// ------------------------------------------------- e2e: restore serves data
const sandbox = join(tmpdir(), "opencode-toolbox-verify-j1-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const tools = {};
await (await import(new URL("../plugins/error-journal.ts", import.meta.url))).default.setup({
  options: {},
  location: { directory: join(sandbox, "proj") },
  tool: { transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); return { dispose: async () => {} }; } },
  session: { hook: async () => ({ dispose: async () => {} }) },
});
const callCtx = { sessionID: "ses_j1", agent: "build", messageID: "m", id: "c", progress: async () => {} };
const out1 = await tools.error_log.execute({ error_text: "j1-canary-entry" }, callCtx);
check("J1: seed entry logged", typeof out1?.content === "string" && /j1-canary-entry|logged|recorded|id/i.test(out1.content), String(out1?.content).slice(0, 120));

const dbDir = join(sandbox, ".opencode-plugins", "error-journal");
const backups = existsSync(join(dbDir, "backups")) ? readdirSync(join(dbDir, "backups")).filter((f) => f.endsWith(".db")) : [];
check("J1: a backup exists before corruption", backups.length > 0, `backups: ${backups.length}`);

// Corrupt the live DB on disk (the parent handle stays open but is unused after this).
writeFileSync(join(dbDir, "error-journal.db"), "garbage-not-a-database".repeat(100));

// Fresh module state in a child: forces open-from-disk -> tryRestore path.
const childSrc = `
process.env.USERPROFILE = ${JSON.stringify(sandbox)};
process.env.HOME = ${JSON.stringify(sandbox)};
const tools = {};
await (await import(${JSON.stringify(new URL("../plugins/error-journal.ts", import.meta.url).href)})).default.setup({
  options: {},
  location: { directory: ${JSON.stringify(join(sandbox, "proj"))} },
  tool: { transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); return { dispose: async () => {} }; } },
  session: { hook: async () => ({ dispose: async () => {} }) },
});
const out = await tools[process.argv[2]].execute(JSON.parse(process.argv[3]), { sessionID: "ses_j1c" });
console.log("CHILD-OUT:" + (typeof out?.content === "string" ? out.content : JSON.stringify(out)));
`;
const childFile = join(unitDir, "j1-child.mjs");
writeFileSync(childFile, childSrc);
const runChild = (toolName, args) => spawnSync(process.execPath, [childFile, toolName, JSON.stringify(args)],
  { encoding: "utf8", timeout: 60000 });

const r1 = runChild("error_list", {});
const r1out = (r1.stdout || "") + (r1.stderr || "");
check("J1: restore serves the pre-corruption entry (verified, not silent)",
  r1.status === 0 && r1out.includes("j1-canary-entry"), `exit=${r1.status} ${r1out.slice(r1out.indexOf("CHILD-OUT"), r1out.indexOf("CHILD-OUT") + 120)}`);

// Negative: corrupt the backups AND the (restored) live DB — must surface
// "Storage unavailable", not throw or serve garbage.
for (const f of readdirSync(join(dbDir, "backups"))) {
  writeFileSync(join(dbDir, "backups", f), "garbage-not-a-database".repeat(100));
}
writeFileSync(join(dbDir, "error-journal.db"), "garbage-not-a-database".repeat(100));
const r2 = runChild("error_list", {});
const r2out = (r2.stdout || "") + (r2.stderr || "");
check("J1: unrestorable store returns Storage unavailable instead of throwing",
  r2.status === 0 && /storage unavailable/i.test(r2out), `exit=${r2.status} ${r2out.slice(0, 160)}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
