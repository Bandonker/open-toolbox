/**
 * Regression checks for the decision-log / error-journal fixes.
 *
 *   DL-1 / EJ-1 — the delete-by-id paths loaded nothing and deleted whatever id
 *                 they were handed, while search/list were session-scoped: any
 *                 session that guessed an id destroyed rows it could never
 *                 list. A missing toolCtx.sessionID also made the read-side
 *                 scope check fall OPEN to every session. Deletes now require a
 *                 matching session/project unless the caller passes an explicit
 *                 widening flag, and reads fall closed to the project (stated in
 *                 the output).
 *   DL-2 / EJ-2 — autoProject labelled every row with the SERVER PROCESS cwd
 *                 (memory.ts uses the hashed session location) and the flag was
 *                 a hardcoded `let`, so *_config reported a value that could
 *                 never change.
 *   EJ-3        — the dedupe fingerprint was a 32-bit djb2 hash (collision
 *                 prone, and legacy rows carried '' or a value the new write
 *                 path can never produce). It is SHA-1 now, with a migration
 *                 backfill.
 *
 *   node tests/verify-dl-ej-fix.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-dl-ej-fix");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox; // both plugins resolve their DB under homedir()
delete process.env.OPENCODE_DECISION_LOG_AUTO_PROJECT;
delete process.env.OPENCODE_ERROR_JOURNAL_AUTO_PROJECT;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  - " + detail : ""}`);
}

const { openDatabase } = await import("../lib/sqlite.ts");
const { projectHash } = await import("../lib/format.ts");

const dirA = join(sandbox, "project-a");
const dirB = join(sandbox, "project-b");
const hashA = projectHash(dirA);
const hashB = projectHash(dirB);

/* ------------------------------------------------ EJ-3: seed a pre-SHA-1 DB */
// Created BEFORE the plugin ever opens it, so the migration path is exercised:
// a table without the hash column, i.e. an error journal from before E168.
const ejDir = join(sandbox, ".opencode-plugins", "error-journal");
mkdirSync(ejDir, { recursive: true });
{
  const legacy = openDatabase(join(ejDir, "error-journal.db"));
  legacy.exec(`
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_text TEXT NOT NULL,
      context TEXT,
      resolution TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      assignee TEXT,
      related INTEGER,
      stack_trace TEXT,
      code TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const ins = legacy.prepare("INSERT INTO errors (error_text, tags, project) VALUES (?, '[]', ?)");
  ins.run("TypeError: legacy boom at boot", hashA);
  ins.run("TypeError: another old failure", hashA);
  legacy.close();
}

const decMod = await import("../plugins/decision-log.ts");
const errMod = await import("../plugins/error-journal.ts");
const reader = openDatabase(join(ejDir, "error-journal.db"));

async function setup(plugin, directory, options = {}) {
  const tools = {};
  await plugin.default.setup({
    options,
    location: { directory },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose: async () => {} };
      },
    },
  });
  return {
    tools,
    run: (name, args = {}, ctx = {}) => tools[name].execute(args, {
      sessionID: "ses_home",
      agent: "build",
      messageID: "m",
      id: "c",
      progress: async () => {},
      ...ctx,
    }),
  };
}

const idOf = (content) => Number(/#(\d+)/.exec(String(content))?.[1]);
const idOfRes = (res) => idOf(res?.content);

/* ---------------------------------------------------------- EJ-3: backfill */

const ea = await setup(errMod, dirA); // first tool call opens + migrates the DB

const redis = await ea.run("error_log", { error_text: "TypeError: legacy boom at boot" });
check(
  "EJ-3 a pre-SHA-1 row is matched after the backfill",
  /already logged \(occurrence 2\)/.test(redis.content),
  redis.content,
);
const boomRows = reader.prepare("SELECT count(*) AS n FROM errors WHERE error_text LIKE '%legacy boom%'").get();
check("EJ-3 backfill did not leave a duplicate behind", boomRows.n === 1, `rows=${boomRows.n}`);

const hashes = reader.prepare("SELECT id, hash FROM errors ORDER BY id").all();
check(
  "EJ-3 every migrated row carries a 40-hex SHA-1 fingerprint",
  hashes.length === 2 && hashes.every((h) => /^[0-9a-f]{40}$/.test(h.hash ?? "")),
  JSON.stringify(hashes.map((h) => h.hash)),
);
const expected = createHash("sha1").update("typeerror: legacy boom at boot").digest("hex");
check("EJ-3 the fingerprint is SHA-1 of the normalized text", hashes[0]?.hash === expected, `${hashes[0]?.hash} vs ${expected}`);

await ea.run("error_log", { error_text: "ReferenceError: fresh fingerprint probe" });
const again = await ea.run("error_log", { error_text: "ReferenceError: fresh fingerprint probe" });
check("EJ-3 the SHA-1 write path still dedupes identical text", /occurrence 2/.test(again.content), again.content);

/* --------------------------------------------------- EJ-2: project + config */

const freshId = idOfRes(await ea.run("error_log", { error_text: "RangeError: project tag probe" }));
const rowProject = reader.prepare("SELECT project FROM errors WHERE id = ?").get(freshId)?.project;
check("EJ-2 rows are tagged with the hashed session directory, not the cwd", rowProject === hashA, `project=${rowProject}`);

const eCfg = (await ea.run("error_config", {})).content;
check(
  "EJ-2 error_config reports the value actually in force",
  /autoProject: true/.test(eCfg) && eCfg.includes(`project: ${hashA}`),
  eCfg.replace(/\n/g, " | "),
);
check("EJ-2 error_config no longer implies the server cwd", !eCfg.includes(process.cwd()), eCfg.replace(/\n/g, " | "));

const eOff = await setup(errMod, dirA, { autoProject: false });
const eOffCfg = (await eOff.run("error_config", {})).content;
check("EJ-2 autoProject:false option is wired and reported", /autoProject: false/.test(eOffCfg) && /unscoped/.test(eOffCfg), eOffCfg.replace(/\n/g, " | "));
process.env.OPENCODE_ERROR_JOURNAL_AUTO_PROJECT = "false";
const eOffEnv = await setup(errMod, dirA);
check("EJ-2 autoProject env var is wired", /autoProject: false/.test((await eOffEnv.run("error_config", {})).content));
delete process.env.OPENCODE_ERROR_JOURNAL_AUTO_PROJECT;

/* ------------------------------------------------------------ EJ-1: deletes */

const eb = await setup(errMod, dirB);
const foreignErr = idOfRes(await ea.run("error_log", { error_text: "SyntaxError: cross project delete probe" }));
const refused = await eb.run("error_delete", { id: foreignErr });
check("EJ-1 error_delete refuses another project's row by id", /Refused/.test(refused.content), refused.content);
check(
  "EJ-1 the refused row survives",
  reader.prepare("SELECT count(*) AS n FROM errors WHERE id = ?").get(foreignErr).n === 1,
);
const widened = await eb.run("error_delete", { id: foreignErr, all: true });
check("EJ-1 all: true is the explicit widening flag", /Deleted error/.test(widened.content), widened.content);

const tagged = idOfRes(await ea.run("error_log", { error_text: "Error: bulk delete probe", tags: ["sweep"] }));
const bulk = await eb.run("error_delete", { tag: "sweep", confirm: true });
check("EJ-1 bulk delete is scoped to this project", /Deleted 0 error\(s\)/.test(bulk.content) && /this project only/.test(bulk.content), bulk.content);
check("EJ-1 bulk delete left the other project's row", reader.prepare("SELECT count(*) AS n FROM errors WHERE id = ?").get(tagged).n === 1);
const bulkAll = await eb.run("error_delete", { tag: "sweep", confirm: true, all: true });
check("EJ-1 bulk delete widens with all: true", /Deleted 1 error\(s\)/.test(bulkAll.content), bulkAll.content);
check("EJ-1 the wrong-project explicit filter still needs the flag", /Refused/.test((await eb.run("error_delete", { project: hashA, confirm: true })).content));

/* ------------------------------------------------- DL-2: project + config */

const da = await setup(decMod, dirA);
const alpha = idOfRes(await da.run("decision_log", { title: "Alpha sqlite choice", decision: "use sqlite for the journal" }));
const dCfg = (await da.run("decision_config", {})).content;
check(
  "DL-2 decision_config reports the hashed session directory",
  /autoProject: true/.test(dCfg) && dCfg.includes(`project: ${hashA}`),
  dCfg.replace(/\n/g, " | "),
);
check("DL-2 decision_config no longer implies the server cwd", !dCfg.includes(process.cwd()), dCfg.replace(/\n/g, " | "));
const shown = await da.run("decision_search", { query: "sqlite journal" });
check("DL-2 rows are stamped with the session project", shown.content.includes(`Project: ${hashA}`), shown.content.slice(0, 160));

const dOff = await setup(decMod, dirA, { autoProject: false });
await dOff.run("decision_log", { title: "Delta unscoped choice", decision: "no project tag on this row" });
const dOffCfg = (await dOff.run("decision_config", {})).content;
check("DL-2 autoProject:false option is wired and reported", /autoProject: false/.test(dOffCfg) && /unscoped/.test(dOffCfg), dOffCfg.replace(/\n/g, " | "));
process.env.OPENCODE_DECISION_LOG_AUTO_PROJECT = "false";
const dOffEnv = await setup(decMod, dirA);
check("DL-2 autoProject env var is wired", /autoProject: false/.test((await dOffEnv.run("decision_config", {})).content));
delete process.env.OPENCODE_DECISION_LOG_AUTO_PROJECT;

/* ------------------------------------------------------- DL-1: read scoping */

const db = await setup(decMod, dirB);
await da.run("decision_log", { title: "Alpha scoped read", decision: "alpha project only" });
await db.run("decision_log", { title: "Bravo scoped read", decision: "bravo project only" }, { sessionID: undefined });

const searchNoSession = await db.run("decision_search", { query: "scoped read" }, { sessionID: undefined });
check("DL-1 a missing sessionID does not fall open across projects", !/Alpha scoped read/.test(searchNoSession.content), searchNoSession.content.slice(0, 160));
check("DL-1 project fallback still finds this project's rows", /Bravo scoped read/.test(searchNoSession.content), searchNoSession.content.slice(0, 160));
check("DL-1 the fallback scope is stated in the output", /scoped to this project/.test(searchNoSession.content), searchNoSession.content);

const listNoSession = await db.run("decision_list", {}, { sessionID: undefined });
check("DL-1 decision_list falls closed too", !/Alpha scoped read/.test(listNoSession.content) && /Bravo scoped read/.test(listNoSession.content), listNoSession.content.slice(0, 160));

const exportNoSession = await db.run("decision_export", { format: "markdown" }, { sessionID: undefined });
check("DL-1 decision_export falls closed too", !/Alpha scoped read/.test(exportNoSession.content) && /Bravo scoped read/.test(exportNoSession.content), exportNoSession.content.slice(0, 160));

const allWiden = await db.run("decision_search", { query: "scoped read", all: true });
check("DL-1 all: true still widens the read", /Alpha scoped read/.test(allWiden.content), allWiden.content.slice(0, 160));

const knownSession = await db.run("decision_search", { query: "scoped read" }, { sessionID: "ses_nobody" });
check(
  "DL-1 exact session scoping is unchanged when a session is known",
  /No decisions found\./.test(knownSession.content) && !/scoped to this project/.test(knownSession.content),
  knownSession.content,
);

/* ------------------------------------------------------ DL-1: delete scoping */

const crossSession = idOfRes(await da.run("decision_log", { title: "Alpha cross session row", decision: "delete guard target" }));
const dRefused = await db.run("decision_delete", { id: crossSession, confirm: true }, { sessionID: "ses_intruder" });
check("DL-1 decision_delete refuses another session/project's row", /Refused/.test(dRefused.content), dRefused.content);
check("DL-1 the refused decision still exists", (await da.run("decision_get", { id: crossSession })).content.includes("Alpha cross session row"));

const sameSessionRow = idOfRes(await da.run("decision_log", { title: "Alpha same session row", decision: "session escape hatch" }));
const dSame = await db.run("decision_delete", { id: sameSessionRow, confirm: true }, { sessionID: "ses_home" });
check("DL-1 a matching session_id may delete its own row", /Deleted decision/.test(dSame.content), dSame.content);

const widenRow = idOfRes(await da.run("decision_log", { title: "Alpha widening row", decision: "explicit widening" }));
const dWiden = await db.run("decision_delete", { id: widenRow, confirm: true, all: true });
check("DL-1 all: true widens the delete past session/project", /Deleted decision/.test(dWiden.content), dWiden.content);

const ownRow = idOfRes(await db.run("decision_log", { title: "Bravo own row", decision: "same project delete" }));
check("DL-1 same-project deletes work without the flag", /Deleted decision/.test((await db.run("decision_delete", { id: ownRow, confirm: true })).content));
check("DL-1 a missing id still reports not found", /not found/.test((await db.run("decision_delete", { id: 999999, confirm: true })).content));

reader.close();
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nverify-dl-ej-fix: ${results.length - failed}/${results.length} checks passed`);
if (failed) for (const r of results.filter((x) => !x.ok)) console.error(`  FAILED: ${r.name}`);
process.exit(failed === 0 ? 0 : 1);
