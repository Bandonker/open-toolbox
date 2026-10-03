/**
 * Regression checks for the memory-plugin fixes:
 *   MEM-1 — pageVisible() must ACCUMULATE across fetch rounds. It used to
 *           reassign `out` from the current round only, so visible rows found
 *           in an earlier round were thrown away whenever later rounds matched
 *           nothing — memory_list reported "No memories stored" (or a truncated
 *           list) whenever visible rows were split across rounds, which is the
 *           normal case because memory.db is shared by every project.
 *   MEM-2 — dispose() has to drop the module-level DB singleton together with
 *           the handle it points at, or the next setup() gets a closed handle
 *           back and every tool answers "Storage unavailable" forever.
 *   MEM-4 — string-valued boolean options ("enabled": "false") were ignored
 *           because bool() only accepted real booleans.
 *
 *   node tests/verify-mem-fix-rounds.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-mem-fix-rounds");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_MEMORY_")) delete process.env[key];
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/memory.ts", import.meta.url));

/** Registers a fresh setup of the plugin for one project directory. */
async function setupFor(directory, options = {}) {
  const tools = {};
  const hooks = {};
  const cleanup = await mod.default.setup({
    options,
    location: { directory },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  });
  const run = (name, args, ctx) => tools[name].execute(args, ctx);
  return { tools, run, hooks, cleanup };
}

const toolCtxFor = (sessionID) => ({ sessionID, agent: "build", messageID: "m", id: "c", progress: async () => {} });
const projA = join(sandbox, "project-a");
const projB = join(sandbox, "project-b");

/* ------------------------------------------------- MEM-1: rounds accumulate */

{
  const b = await setupFor(projB);
  // Oldest row overall: sits at the very END of the created_at DESC ordering.
  await b.run("memory_remember", { text: "BETA deep marker quokka note" }, toolCtxFor("ses_b1"));

  const a = await setupFor(projA);
  for (let i = 0; i < 20; i++) {
    await a.run("memory_remember", { text: `Alpha filler note number ${i} widget` }, toolCtxFor("ses_a1"));
  }
  // Newest row overall: sits FIRST in the ordering.
  await b.run("memory_remember", { text: "ALPHA top marker quokka note" }, toolCtxFor("ses_b2"));

  // limit=2 over-fetches 3 rows per round, so round 1 finds only the newest B
  // row, round 2 finds nothing visible, and round 3 finds the deep B row. The
  // old round-reassigning code returned just the deep row (or nothing at all).
  const listed = await b.run("memory_list", { limit: 2 }, toolCtxFor("ses_b3"));
  check("MEM-1 list is not emptied by a later empty round", !/No memories stored/.test(listed.content), listed.content);
  check("MEM-1 list keeps the row found in the first round", listed.content.includes("ALPHA top marker"), listed.content);
  check("MEM-1 list keeps the row found in the last round", listed.content.includes("BETA deep marker"), listed.content);
  check("MEM-1 list still honors limit", !/Alpha filler/.test(listed.content), listed.content);

  // Same shape for export (id ASC ordering): both B rows must survive paging.
  const exported = await b.run("memory_export", { limit: 2 }, toolCtxFor("ses_b4"));
  check("MEM-1 export accumulates across rounds",
    exported.content.includes("ALPHA top marker") && exported.content.includes("BETA deep marker"),
    exported.content.slice(0, 120));
}

/* ------------------------------------------- MEM-2: teardown heals the shared DB */

{
  const first = await setupFor(projB);
  const opened = await first.run("memory_stats", {}, toolCtxFor("ses_stats1"));
  check("MEM-2 stats work before teardown", /memories:/.test(opened.content), opened.content.split("\n")[0]);

  await first.cleanup();

  const second = await setupFor(projB);
  const after = await second.run("memory_stats", {}, toolCtxFor("ses_stats2"));
  check(
    "MEM-2 re-setup after dispose is not stuck on a closed handle",
    /memories:/.test(after.content) && !/Storage unavailable/i.test(after.content),
    after.content.split("\n")[0],
  );
  const wrote = await second.run("memory_remember", { text: "Healed handle write quokka" }, toolCtxFor("ses_stats3"));
  const read = await second.run("memory_recall", { query: "healed handle quokka" }, toolCtxFor("ses_stats3"));
  check(
    "MEM-2 tools write and read after re-setup",
    /Remembered|Already remembered/.test(wrote.content) && read.content.includes("Healed handle"),
    `${wrote.content} | ${read.content.slice(0, 80)}`,
  );
}

/* ------------------------------------- MEM-4: string-valued boolean options */

{
  const off = await setupFor(projB, { enabled: "false", autoRecall: "0" });
  const cfgOff = (await off.run("memory_config", {}, toolCtxFor("ses_cfg1"))).content;
  check("MEM-4 option enabled: \"false\" is honored", /^enabled: false$/m.test(cfgOff), cfgOff.split("\n").find((l) => l.startsWith("enabled")));
  check("MEM-4 option autoRecall: \"0\" is honored", /^autoRecall: false$/m.test(cfgOff), cfgOff.split("\n").find((l) => l.startsWith("autoRecall")));

  await off.run("memory_remember", { text: "String option injection probe quokka", scope: "global", importance: 9 }, toolCtxFor("ses_cfg2"));
  const messages = [{ role: "user", content: [{ type: "text", text: "string option injection probe quokka" }] }];
  off.hooks.context({ messages, system: [], tools: {}, options: {}, sessionID: "ses_cfg_inject_off", model: {}, agent: "build" });
  check("MEM-4 disabled auto-recall injects nothing", messages.filter((m) => m.role === "system").length === 0);

  const on = await setupFor(projB, { enabled: "yes", autoRecall: "on" });
  const cfgOn = (await on.run("memory_config", {}, toolCtxFor("ses_cfg3"))).content;
  check("MEM-4 truthy option strings stay enabled", /^enabled: true$/m.test(cfgOn) && /^autoRecall: true$/m.test(cfgOn), cfgOn);
  const messages2 = [{ role: "user", content: [{ type: "text", text: "string option injection probe quokka" }] }];
  on.hooks.context({ messages: messages2, system: [], tools: {}, options: {}, sessionID: "ses_cfg_inject_on", model: {}, agent: "build" });
  check("MEM-4 enabled option strings still inject", messages2.filter((m) => m.role === "system").length === 1);

  // An unusable option value must still fall through to the environment.
  process.env.OPENCODE_MEMORY_AUTO_RECALL = "false";
  const env = await setupFor(projB, { autoRecall: "not-a-bool" });
  const cfgEnv = (await env.run("memory_config", {}, toolCtxFor("ses_cfg4"))).content;
  check("MEM-4 unusable option value falls back to env", /^autoRecall: false$/m.test(cfgEnv), cfgEnv.split("\n").find((l) => l.startsWith("autoRecall")));
  delete process.env.OPENCODE_MEMORY_AUTO_RECALL;

  // A real boolean still wins over the environment.
  process.env.OPENCODE_MEMORY_ENABLED = "true";
  const boolWins = await setupFor(projB, { enabled: false });
  const cfgBool = (await boolWins.run("memory_config", {}, toolCtxFor("ses_cfg5"))).content;
  check("MEM-4 real boolean option beats env", /^enabled: false$/m.test(cfgBool), cfgBool.split("\n").find((l) => l.startsWith("enabled")));
  delete process.env.OPENCODE_MEMORY_ENABLED;
}

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* the SQLite handle may keep the file alive */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nverify-mem-fix-rounds: ${results.length - failed}/${results.length} checks passed`);
if (failed) for (const r of results.filter((x) => !x.ok)) console.error(`  FAILED: ${r.name}`);
process.exit(failed === 0 ? 0 : 1);
