/** CR-3: getDb() failures must return error content, not throw out of tools. */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-cr3-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
// Block DB dirs: create a FILE where "<home>/.opencode-plugins" should be,
// so mkdirSync/openDatabase fails with ENOTDIR/EEXIST.
const blocker = join(sandbox, ".opencode-plugins");
writeFileSync(blocker, "blocker");
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const cases = [
  ["../plugins/error-journal.ts", ["error_log", "error_list", "error_search"]],
  ["../plugins/decision-log.ts", ["decision_log", "decision_list"]],
  ["../plugins/snippet-library.ts", ["snippet_save", "snippet_list"]],
  ["../plugins/codebase-index.ts", ["codebase_search"]],
  ["../plugins/memory.ts", ["memory_remember", "memory_recall", "memory_list", "memory_stats"]],
];

for (const [modPath, toolNames] of cases) {
  let mod;
  try {
    mod = await import(new URL(modPath, import.meta.url));
  } catch (e) {
    check(`${modPath} imports without throwing`, false, String(e).slice(0, 200));
    continue;
  }
  const tools = {};
  let setupThrew = null;
  try {
    await mod.default.setup({
      options: {},
      location: { directory: join(sandbox, "proj") },
      tool: { transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); return { dispose: async () => {} }; } },
      session: { hook: async () => ({ dispose: async () => {} }) },
    });
  } catch (e) {
    setupThrew = e;
  }
  check(`${modPath} setup does not throw on DB failure`, setupThrew === null, setupThrew ? String(setupThrew).slice(0, 160) : "");
  if (setupThrew) continue;
  for (const name of toolNames) {
    const tool = tools[name];
    if (!tool) { check(`${modPath}#${name} registered`, false); continue; }
    const args =
      name === "error_log" ? { error_text: "boom" } :
      name === "decision_log" ? { title: "t", decision: "d" } :
      name === "snippet_save" ? { title: "t", code: "c" } :
      name === "memory_remember" ? { text: "hello memory" } :
      name === "error_search" || name === "decision_search" || name === "codebase_search" || name === "memory_recall" ? { query: "x" } : {};
    let threw = null, out = null;
    try {
      out = await tool.execute(args, { sessionID: "ses_cr3", agent: "build", messageID: "m", id: "c", progress: async () => {} });
    } catch (e) { threw = e; }
    const content = typeof out?.content === "string" ? out.content : (typeof out === "string" ? out : "");
    check(
      `${modPath}#${name} returns error content on DB failure`,
      threw === null && /storage unavailable|not available|db|unavailable/i.test(content),
      threw ? `threw: ${String(threw).slice(0, 160)}` : `content: ${String(content).slice(0, 160)}`
    );
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
