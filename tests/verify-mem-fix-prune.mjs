/**
 * Regression checks for MEM-3: the maxEntries write-side budget was counted and
 * enforced over the WHOLE shared memory.db, so a burst of writes in one project
 * evicted the oldest / lowest-importance rows of every other project on the
 * machine. Victims and the count are now scoped to the writing project's own
 * rows plus the shared global rows — for the automatic prune and for
 * memory_prune alike.
 *
 *   node tests/verify-mem-fix-prune.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-mem-fix-prune");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_MEMORY_")) delete process.env[key];
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/memory.ts", import.meta.url));

async function setupFor(directory, options = {}) {
  const tools = {};
  const cleanup = await mod.default.setup({
    options,
    location: { directory },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose: async () => {} };
      },
    },
    session: { hook: async () => ({ dispose: async () => {} }) },
  });
  const ctx = { sessionID: "ses_prune", agent: "build", messageID: "m", id: "c", progress: async () => {} };
  const run = (name, args = {}) => tools[name].execute(args, ctx);
  return { tools, run, ctx, cleanup };
}

const projA = join(sandbox, "project-a");
const projB = join(sandbox, "project-b");

// Project B writes FIRST, so its rows are the globally oldest and the first
// victims of the old unscoped "evict the oldest N rows" query.
const b = await setupFor(projB, { maxEntries: 0 });
for (let i = 1; i <= 3; i++) {
  await b.run("memory_remember", { text: `Bravo keepme row ${i} hammerhead` });
}
await b.run("memory_remember", { text: "Shared global note hammerhead", scope: "global" });

// Project A now writes enough rows to blow through maxEntries: the automatic
// prune threshold is maxEntries + max(10, 10%) = 12, so it fires part-way
// through this loop.
const a = await setupFor(projA, { maxEntries: 2 });
for (let i = 0; i < 13; i++) {
  await a.run("memory_remember", { text: `Alpha churn row ${i} maracas` });
}

const bListed = await b.run("memory_list", { limit: 50, all: true });
check(
  "MEM-3 another project's writes did not evict this project's rows",
  ["Bravo keepme row 1", "Bravo keepme row 2", "Bravo keepme row 3"].every((t) => bListed.content.includes(t)),
  bListed.content.slice(0, 200),
);

// Global rows ARE candidates of the pool (documented semantics), so the shared
// row written by B can be pruned by A's budget — it must not be silently
// invisible to the accounting.
const globalGone = !(await b.run("memory_recall", { query: "shared global note hammerhead" })).content.includes("Shared global note");
check("MEM-3 shared global rows participate in the pool", globalGone, await JSON.stringify((await b.run("memory_recall", { query: "shared global note hammerhead" })).content));

// The surviving Alpha rows are the newest ones: the budget drew down A's own
// pool, oldest first.
const aListed = await a.run("memory_list", { limit: 50 });
check("MEM-3 the writing project's own pool was trimmed", aListed.content.includes("Alpha churn row 12"), aListed.content.slice(0, 200));
check("MEM-3 trimming removed the oldest of the writing project", !/Alpha churn row 0/.test(aListed.content), aListed.content.slice(0, 200));

// memory_prune must report the per-project pool and must never pick a victim
// that belongs to another project.
const dry = await a.run("memory_prune", { dryRun: true });
check("MEM-3 memory_prune reports the scoped pool", /this project \+ global pool|for this project/.test(dry.content), dry.content.split("\n")[0]);
check("MEM-3 memory_prune never targets another project's rows", !/Bravo keepme/.test(dry.content), dry.content.slice(0, 200));

// A project with headroom reports headroom, not the shared file's totals.
const roomy = await setupFor(projB, { maxEntries: 500 });
const roomyPrune = await roomy.run("memory_prune", { dryRun: true });
check(
  "MEM-3 memory_prune counts only this project (+ global)",
  /No pruning needed \((\d+)\/500/.test(roomyPrune.content) && Number(/No pruning needed \((\d+)\//.exec(roomyPrune.content)?.[1]) < 20,
  roomyPrune.content.split("\n")[0],
);

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nverify-mem-fix-prune: ${results.length - failed}/${results.length} checks passed`);
if (failed) for (const r of results.filter((x) => !x.ok)) console.error(`  FAILED: ${r.name}`);
process.exit(failed === 0 ? 0 : 1);
