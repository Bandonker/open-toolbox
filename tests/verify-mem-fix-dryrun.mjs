/**
 * Regression check for MEM-5: memory_forget's dry run deleted nothing, so the
 * batching loop re-queried and re-counted the SAME first 500 rows every round.
 * With limit > 500 it reported "would forget 600" for ~500 stored memories, and
 * the preview repeated rows. The dry run now pages with OFFSET and remembers
 * ids, so it counts min(limit, distinct visible matches) exactly. The live
 * (deleting) path must still delete correctly.
 *
 *   node tests/verify-mem-fix-dryrun.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-mem-fix-dryrun");
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
  await mod.default.setup({
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
  const runFor = (sessionID) => (name, args = {}) => tools[name].execute(args, {
    sessionID,
    agent: "build",
    messageID: "m",
    id: "c",
    progress: async () => {},
  });
  return { run: runFor("ses_dryrun"), runForeign: runFor("ses_other_project") };
}

const TOTAL = 520; // deliberately above the 500-row batch size
const FOREIGN = 30; // rows the caller must not see or count

const here = await setupFor(join(sandbox, "project-a"));

// 520 globally visible rows that all match the query.
for (let i = 1; i <= TOTAL; i++) {
  await here.run("memory_remember", { text: `Quokka dryrun needle item ${i}`, scope: "global" });
}
// 30 rows owned by a different project: matching, but not visible to the caller.
const elsewhere = await setupFor(join(sandbox, "project-b"));
for (let i = 1; i <= FOREIGN; i++) {
  await elsewhere.run("memory_remember", { text: `Quokka dryrun foreign item ${i}` });
}

const count = (content) => Number(/would forget (\d+)/.exec(content)?.[1] ?? content.match(/Forgot (\d+)/)?.[1]);

// The headline regression: exactly the distinct matches, never a multiple of 500.
const wide = await here.run("memory_forget", { query: "quokka dryrun needle", limit: 600, dryRun: true });
check("MEM-5 dry run counts distinct matches, not pages", count(wide.content) === TOTAL, `got ${count(wide.content)} for ${TOTAL} rows`);
check("MEM-5 dry run does not re-count the first batch", !/\b(1000|1040|600)\b/.test(wide.content.split("\n")[0]), wide.content.split("\n")[0]);
check("MEM-5 dry run hides other projects' matches", !/foreign item/.test(wide.content), wide.content.slice(0, 120));

// The preview is capped at `limit` lines.
const narrow = await here.run("memory_forget", { query: "quokka dryrun needle", limit: 3, dryRun: true });
const previewLines = narrow.content.split("\n").slice(1).filter(Boolean).length;
check("MEM-5 small limit caps the count", count(narrow.content) === 3, narrow.content.split("\n")[0]);
check("MEM-5 small limit caps the preview", previewLines === 3, `preview lines=${previewLines}`);

// A dry run must not delete anything.
const afterDry = await here.run("memory_stats", {});
check("MEM-5 dry run deletes nothing", new RegExp(`memories: ${TOTAL + FOREIGN} `).test(afterDry.content), afterDry.content.split("\n")[0]);

// The live path still deletes exactly what it reports, across the batch boundary.
const real = await here.run("memory_forget", { query: "quokka dryrun needle", limit: 600 });
check("MEM-5 live delete removes every distinct match", count(real.content) === TOTAL, real.content);
const afterDelete = await here.run("memory_forget", { query: "quokka dryrun needle", limit: 600, dryRun: true });
check("MEM-5 nothing left after the live delete", /No memories matched/.test(afterDelete.content), afterDelete.content);
const survivors = await here.run("memory_stats", {});
check("MEM-5 live delete left the foreign rows alone", new RegExp(`memories: ${FOREIGN} `).test(survivors.content), survivors.content.split("\n")[0]);

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nverify-mem-fix-dryrun: ${results.length - failed}/${results.length} checks passed`);
if (failed) for (const r of results.filter((x) => !x.ok)) console.error(`  FAILED: ${r.name}`);
process.exit(failed === 0 ? 0 : 1);
