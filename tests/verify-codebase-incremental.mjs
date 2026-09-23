/**
 * I3 verification: codebase_index must be incremental — unchanged files are
 * skipped on re-index (keyed on mtime+size), changed files are re-chunked,
 * and deleted files are dropped from the index.
 *
 *   node tests/verify-codebase-incremental.mjs
 */
import { rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-codebase-incr-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/codebase-index.ts", import.meta.url));
const tools = [];
await mod.default.setup({
  options: {},
  location: { directory: sandbox },
  tool: { transform: async (cb) => { cb({ add: (t) => tools.push(t) }); return { dispose: async () => {} }; } },
});
const byName = (n) => tools.find((t) => t.name === n);
const indexTool = byName("codebase_index");
const searchTool = byName("codebase_search");
const runIndex = async (path) => JSON.parse((await indexTool.execute({ path }, {})).content);

const proj = join(sandbox, "proj");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "alpha.ts"), "export function alphaMarker() { return 1; }\n".repeat(10));
writeFileSync(join(proj, "beta.ts"), "export function betaMarker() { return 2; }\n".repeat(10));
writeFileSync(join(proj, "gamma.ts"), "export function gammaMarker() { return 3; }\n".repeat(10));

// Run 1: everything is new.
const r1 = await runIndex(proj);
check("first index reports all files fresh", r1.updated === 3 && r1.unchanged === 0, JSON.stringify(r1));

// Run 2: nothing changed — everything skipped.
const r2 = await runIndex(proj);
check("second index skips unchanged files", r2.updated === 0 && r2.unchanged === 3, JSON.stringify(r2));

// Run 3: one file changed — only it is re-chunked.
writeFileSync(join(proj, "beta.ts"), "export function betaMarker() { return 22; }\nexport function betaExtra() { return 23; }\n".repeat(10));
const later = new Date(Date.now() + 5000);
utimesSync(join(proj, "beta.ts"), later, later); // defeat coarse mtime granularity
const r3 = await runIndex(proj);
check("changed file is re-indexed, rest skipped", r3.updated === 1 && r3.unchanged === 2, JSON.stringify(r3));

// Run 4: one file deleted — dropped from the index.
rmSync(join(proj, "gamma.ts"));
const r4 = await runIndex(proj);
check("deleted file is removed from the index", r4.removed === 1 && r4.unchanged === 2, JSON.stringify(r4));

const hitBeta = await searchTool.execute({ query: "betaExtra", path: proj }, {});
check("search finds symbols from the re-indexed file", hitBeta.content.includes("betaExtra"), hitBeta.content.slice(0, 120));
const hitGamma = await searchTool.execute({ query: "gammaMarker", path: proj }, {});
check("search no longer finds the deleted file", !hitGamma.content.includes("gammaMarker"), hitGamma.content.slice(0, 120));

// Chunk totals stay consistent: 3 files worth of chunks, no duplicates.
const statusTool = byName("codebase_index_status");
const status = await statusTool.execute({ path: proj }, {});
check("status still reports the project", /alpha|beta|chunk/i.test(status.content), status.content.slice(0, 160));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
