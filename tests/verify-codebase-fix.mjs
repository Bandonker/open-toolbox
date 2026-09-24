/**
 * CI-2..CI-12 verification for plugins/codebase-index.ts.
 *
 *   node tests/verify-codebase-fix.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-codebase-fix-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.INDEX_DOT_DIRS;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const BOM = String.fromCharCode(0xFEFF);
const NUL = String.fromCharCode(0);

const mod = await import(new URL("../plugins/codebase-index.ts", import.meta.url));

// CI-8: drive letter lowercased, rest of path untouched.
if (process.platform === "win32") {
  const got = mod.__test__.normalizeRoot("C:\\Users\\TEST\\Proj\\");
  check("normalizeRoot lowercases drive letter only", got === "c:/Users/TEST/Proj", got);
} else {
  check("normalizeRoot trims/keeps case off-win32", mod.__test__.normalizeRoot("C:\\Proj\\") === "C:/Proj");
}
// CI-7 unit: LIKE metacharacters escaped.
check(
  "escapeLike escapes % _ backslash",
  mod.__test__.escapeLike("a%b_c\\d") === "a\\%b\\_c\\\\d",
  mod.__test__.escapeLike("a%b_c\\d"),
);

// CI-9 unit: BOM stripped, null bytes rejected (injectable fs override).
const fakeFs = (content) => ({
  statSync() { return { isFile: () => true, size: content.length, mtimeMs: 1 }; },
  readFileSync() { return content; },
});
const bomChunks = mod.__test__.chunkFile(
  join(sandbox, "bom.ts"), sandbox, fakeFs(BOM + "export const bomMarker = 1;\n"),
);
check(
  "chunkFile strips leading BOM",
  bomChunks.length === 1 && bomChunks[0].content.charCodeAt(0) !== 0xFEFF && bomChunks[0].content.includes("bomMarker"),
  JSON.stringify(bomChunks[0] && bomChunks[0].content.slice(0, 30)),
);
const nulChunks = mod.__test__.chunkFile(
  join(sandbox, "bin.ts"), sandbox, fakeFs("abc" + NUL + "def"),
);
check("chunkFile skips null-byte files", Array.isArray(nulChunks) && nulChunks.length === 0);

// End-to-end setup.
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

// CI-5/CI-9 project: extensionless Dockerfile + normal sources.
const proj = join(sandbox, "proj");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "Dockerfile"), "FROM node:24 # dockerProbeMarkerAlpha\nRUN echo hi\n");
writeFileSync(join(proj, "beta.ts"), "export function betaExtraMarker() { return 1; }\n".repeat(10));
writeFileSync(join(proj, "probe.ts"), "export const probeFileMarker = 2;\n".repeat(10));
writeFileSync(join(proj, "shorty.ts"), "aa bb cc dd shortFallbackMarker\n".repeat(10));

const r1 = await runIndex(proj);
check("Dockerfile indexed alongside sources", r1.indexed === true && r1.files === 4, JSON.stringify(r1));

const hitDocker = await searchTool.execute({ query: "dockerProbeMarkerAlpha", path: proj }, {});
check("extensionless Dockerfile is searchable", hitDocker.content.includes("dockerProbeMarkerAlpha"), hitDocker.content.slice(0, 100));

// CI-6: short token dropped, remainder searched.
const hitShort = await searchTool.execute({ query: "a betaExtraMarker", path: proj }, {});
check("short token no longer rejects whole query", hitShort.content.includes("betaExtraMarker"), hitShort.content.slice(0, 100));

// CI-6: all-short query falls back to LIKE.
const hitLike = await searchTool.execute({ query: "aa bb", path: proj }, {});
check("all-short query falls back to LIKE", hitLike.content.includes("shortFallbackMarker"), hitLike.content.slice(0, 100));

// CI-7: filter underscore is literal — "probe_ts" must NOT match "probe.ts".
const hitFilter = await searchTool.execute({ query: "probeFileMarker", path: proj, filter: "probe_ts" }, {});
check("filter underscore matches literally (no wildcard hit)", hitFilter.content.includes("Found 0 results"), hitFilter.content.slice(0, 100));
const hitFilterOk = await searchTool.execute({ query: "probeFileMarker", path: proj, filter: "probe.ts" }, {});
check("literal filter still matches", hitFilterOk.content.includes("probeFileMarker"), hitFilterOk.content.slice(0, 100));

// CI-2: omitted path searches all indexed projects (no bogus "not indexed").
const hitGlobal = await searchTool.execute({ query: "betaExtraMarker" }, {});
check("global search without path finds indexed content", hitGlobal.content.includes("betaExtraMarker"), hitGlobal.content.slice(0, 120));

// CI-4: deleting every file must not wipe the good index.
rmSync(join(proj, "Dockerfile"));
rmSync(join(proj, "beta.ts"));
rmSync(join(proj, "probe.ts"));
rmSync(join(proj, "shorty.ts"));
const rWipe = await runIndex(proj);
check("empty scan refuses to commit (keeps old counts)", rWipe.files === 4 && typeof rWipe.warning === "string", JSON.stringify(rWipe));
const hitAfterWipe = await searchTool.execute({ query: "betaExtraMarker", path: proj }, {});
check("old index still searchable after refused wipe", hitAfterWipe.content.includes("betaExtraMarker"), hitAfterWipe.content.slice(0, 100));

// CI-10: dot-dir opt-out.
process.env.INDEX_DOT_DIRS = "1";
const projDot = join(sandbox, "dotproj");
mkdirSync(join(projDot, ".config"), { recursive: true });
writeFileSync(join(projDot, ".config", "tool.ts"), "export const dotDirMarkerFile = 1;\n".repeat(10));
const rDot = await runIndex(projDot);
const hitDot = await searchTool.execute({ query: "dotDirMarkerFile", path: projDot }, {});
check("INDEX_DOT_DIRS=1 indexes dot-directories", rDot.files === 1 && hitDot.content.includes("dotDirMarkerFile"), JSON.stringify(rDot));

delete process.env.INDEX_DOT_DIRS;
const projHidden = join(sandbox, "hiddenproj");
mkdirSync(join(projHidden, ".hidden"), { recursive: true });
writeFileSync(join(projHidden, ".hidden", "app.ts"), "export const hiddenDefaultMarker = 1;\n".repeat(10));
const rHidden = await runIndex(projHidden);
const hitHidden = await searchTool.execute({ query: "hiddenDefaultMarker", path: projHidden }, {});
check("dot-directories skipped by default", rHidden.files === 0 && hitHidden.content.includes("Found 0 results"), JSON.stringify(rHidden));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
