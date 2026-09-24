/** Task 1 — SQLite cross-cutting robustness (CR-4, CR-7, CR-8, CR-9 + DL/SN/EJ/ME items). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sandbox = mkdtempSync(join(tmpdir(), "opencode-sqlite-robust-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(name);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

async function setupTools(modPath) {
  const plugin = (await import(modPath)).default;
  const tools = new Map();
  const red = { add: (t) => void tools.set(t.name, t), transformed: tools };
  const ctx = {
    options: {},
    location: { directory: sandbox },
    tool: { transform: async (fn) => { await fn(red); return { dispose: async () => {} }; } },
    session: { hook: async () => ({ dispose: async () => {} }) },
    client: {},
    project: "test-proj",
    directory: sandbox,
  };
  await plugin.setup(ctx);
  return tools;
}

const textOf = (out) =>
  typeof out?.content === "string" ? out.content : JSON.stringify(out?.content ?? out);

// --- shared lib helpers (CR-7) ---
const sqlite = await import("../lib/sqlite.ts");
check("clampLimit: NaN/Infinity fall back to default",
  sqlite.clampLimit(Number.NaN, 10, 50) === 10 && sqlite.clampLimit(Infinity, 10, 50) === 10);
check("clampLimit: truncates fractions, clamps to [1, max]",
  sqlite.clampLimit(2.7, 10, 50) === 2 &&
  sqlite.clampLimit(-5, 10, 50) === 1 &&
  sqlite.clampLimit(0, 10, 50) === 1 &&
  sqlite.clampLimit(9999, 10, 50) === 50);
check("clampLimit: numeric strings coerce, undefined falls back",
  sqlite.clampLimit("12", 10, 50) === 12 && sqlite.clampLimit(undefined, 10, 50) === 10);
check("truncateStored: short text passes through, long text gets a marker",
  sqlite.truncateStored("abc", 10) === "abc" &&
  (() => {
    const t = sqlite.truncateStored("x".repeat(100), 20);
    return t.length === 20 && t.endsWith(" [truncated]");
  })());

// CR-9: all three triggers probed, not just *_ai.
const mem = sqlite.openDatabase(":memory:");
mem.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT); CREATE VIRTUAL TABLE t_fts USING fts5(body);");
check("hasTriggers: false when triggers are missing", sqlite.hasTriggers(mem, ["t_ai", "t_ad", "t_au"]) === false);
mem.exec(`CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO t_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER t_ad AFTER DELETE ON t BEGIN DELETE FROM t_fts WHERE rowid = old.id; END;
CREATE TRIGGER t_au AFTER UPDATE ON t BEGIN UPDATE t_fts SET body = new.body WHERE rowid = new.id; END;`);
check("hasTriggers: true when ai/ad/au all exist", sqlite.hasTriggers(mem, ["t_ai", "t_ad", "t_au"]) === true);
mem.close();

// CR-8: restore I/O failures carry context.
let restoreErr = "";
try {
  sqlite.copyBackupIntoPlace(join(sandbox, "nope.db"), join(sandbox, "missing.db"));
} catch (e) {
  restoreErr = String(e?.message ?? e);
}
check("copyBackupIntoPlace: I/O failure carries context", /Failed to restore backup/.test(restoreErr), restoreErr.slice(0, 120));

// --- decision-log: CR-4 truncation, DL-8 project filter, DL-7 lazy redact ---
const dtools = await setupTools("../plugins/decision-log.ts");
await dtools.get("decision_log").execute({ title: "T".repeat(600), decision: "d", project: "p1" }, { sessionID: "s1" });
const gotTitle = textOf(await dtools.get("decision_get").execute({ id: 1 }, { sessionID: "s1" }));
check("decision title capped at 500 with marker",
  gotTitle.includes(`${"T".repeat(488)} [truncated]`) && !gotTitle.includes("T".repeat(489)),
  gotTitle.slice(0, 80));

await dtools.get("decision_log").execute({ title: "alpha zulu one", decision: "d", project: "proj-a" }, { sessionID: "s1" });
await dtools.get("decision_log").execute({ title: "alpha zulu two", decision: "d", project: "proj-b" }, { sessionID: "s1" });
const projSearch = textOf(await dtools.get("decision_search").execute(
  { query: "alpha zulu", project: "proj-a", all_sessions: true }, { sessionID: "s1" }));
check("decision_search honors the project filter",
  projSearch.includes("alpha zulu one") && !projSearch.includes("alpha zulu two"), projSearch.slice(0, 120));

// DL-7: the redact flag is read lazily — toggling it after import takes effect.
delete process.env.OPENCODE_PLUGINS_STORE_REDACT;
const secretA = `ghp_${"a".repeat(36)}`;
await dtools.get("decision_log").execute({ title: `redact me ${secretA}`, decision: "d", project: "p1" }, { sessionID: "s1" });
const redacted = textOf(await dtools.get("decision_get").execute({ id: 4 }, { sessionID: "s1" }));
check("store redaction defaults on", !redacted.includes(secretA), redacted.slice(0, 120));
process.env.OPENCODE_PLUGINS_STORE_REDACT = "false";
const secretB = `ghp_${"b".repeat(36)}`;
await dtools.get("decision_log").execute({ title: `plain ${secretB}`, decision: "d", project: "p1" }, { sessionID: "s1" });
const plain = textOf(await dtools.get("decision_get").execute({ id: 5 }, { sessionID: "s1" }));
check("store redaction toggle applies without re-import", plain.includes(secretB), plain.slice(0, 120));
delete process.env.OPENCODE_PLUGINS_STORE_REDACT;

// --- snippet-library: SN-4, SN-5, SN-8, CR-4 ---
const stools = await setupTools("../plugins/snippet-library.ts");
await stools.get("snippet_save").execute(
  { title: "x", code: "a```b", language: "js\nevil()", description: "d" }, {});
const snipFull = textOf(await stools.get("snippet_get").execute({ id: 1 }, {}));
check("snippet language info string is sanitized", snipFull.includes("(jsevil)") && !snipFull.includes("evil()"), snipFull.slice(0, 120));
check("snippet triple backticks are escaped", !snipFull.includes("a```b") && snipFull.includes("a`​``b"), snipFull.slice(0, 160));
await stools.get("snippet_save").execute(
  { title: "long", code: `${"L".repeat(2000)}\nline2\nline3\nline4`, language: "txt" }, {});
const snipList = textOf(await stools.get("snippet_list").execute({}, {}));
check("snippet preview is char-capped", !snipList.includes("L".repeat(601)) && snipList.includes("..."), `len=${snipList.length}`);
check("snippet_save discloses verbatim storage",
  (stools.get("snippet_save").description ?? "").includes("verbatim"));
await stools.get("snippet_save").execute({ title: "S".repeat(400), code: "c" }, {});
const snipTitle = textOf(await stools.get("snippet_get").execute({ id: 3 }, {}));
check("snippet title capped at 300 with marker",
  snipTitle.includes(`${"S".repeat(288)} [truncated]`) && !snipTitle.includes("S".repeat(289)));

// --- error-journal: EJ-5, EJ-6, CR-4 ---
const etools = await setupTools("../plugins/error-journal.ts");
check("error_log documents the manual-only journal",
  (etools.get("error_log").description ?? "").includes("Manual-only"));
await etools.get("error_log").execute({ error_text: "boom" }, {});
await etools.get("error_resolve").execute({ id: 1, resolution: "first fix" }, {});
const r2 = textOf(await etools.get("error_resolve").execute({ id: 1, resolution: "second fix" }, {}));
check("error_resolve surfaces the prior resolution",
  r2.includes("prior resolution") && r2.includes("first fix"), r2.slice(0, 160));
await etools.get("error_log").execute({ error_text: "E".repeat(25000) }, {});
const edb = new DatabaseSync(join(sandbox, ".opencode-plugins", "error-journal", "error-journal.db"), { readOnly: true });
const erow = edb.prepare("SELECT error_text FROM errors ORDER BY id DESC LIMIT 1").get();
edb.close();
check("error_text capped at 20k with marker",
  erow.error_text.length === 20000 && erow.error_text.endsWith(" [truncated]"),
  `len=${erow.error_text.length}`);

// --- memory: ME-6/ME-10 caps observable through recall ---
const mtools = await setupTools("../plugins/memory.ts");
await mtools.get("memory_remember").execute({ text: `recallmarker ${"M".repeat(25000)}`, tags: ["t"] }, { sessionID: "s1" });
const rec = textOf(await mtools.get("memory_recall").execute({ query: "recallmarker", limit: 5 }, { sessionID: "s1" }));
const recLines = rec.split("\n").filter((l) => l.includes("recallmarker"));
check("memory recall rows are per-row capped with marker",
  recLines.length > 0 && recLines.every((l) => l.length <= 2000 && l.includes("[truncated]")),
  `lines=${recLines.length} len=${recLines[0]?.length ?? 0}`);

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
