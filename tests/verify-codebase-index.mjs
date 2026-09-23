import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-codebase-home");
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
check("codebase-index exposes __test__.chunkFile", typeof mod.__test__?.chunkFile === "function");

// CI-1: a file that vanishes/locks between walk and read must not throw.
try {
  const out = mod.__test__.chunkFile(join(sandbox, "no-such-file.ts"), sandbox);
  check("chunkFile returns [] for missing file", Array.isArray(out) && out.length === 0);
} catch (err) {
  check("chunkFile returns [] for missing file", false, String(err));
}

// CI-1: throwing fs still yields [] (injectable fs override).
try {
  const throwing = { statSync() { throw new Error("EACCES"); }, readFileSync() { throw new Error("EACCES"); } };
  const out = mod.__test__.chunkFile(join(sandbox, "locked.ts"), sandbox, throwing);
  check("chunkFile returns [] on fs error", Array.isArray(out) && out.length === 0);
} catch (err) {
  check("chunkFile returns [] on fs error", false, String(err));
}

// Behavior: indexing a project with good files still works end to end.
const tools = [];
await mod.default.setup({
  options: {},
  location: { directory: sandbox },
  tool: { transform: async (cb) => { cb({ add: (t) => tools.push(t) }); return { dispose: async () => {} }; } },
});
const indexTool = tools.find((t) => t.name === "codebase_index");
const proj = join(sandbox, "proj");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "good.ts"), "export const a = 1;\n".repeat(20));
const res = JSON.parse((await indexTool.execute({ path: proj }, {})).content);
check("codebase_index succeeds", res.indexed === true, JSON.stringify(res));
check("codebase_index counts files", res.files === 1, JSON.stringify(res));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
