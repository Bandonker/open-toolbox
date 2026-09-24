/**
 * Q1 verification: /toolbox shows which plugin provides each tool, and the
 * "plugin not installed" note names the providing plugin (not just the tool).
 *
 *   node tests/verify-toolbox-providers.mjs
 */
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/command-pack.ts", import.meta.url));
const commands = [];
const injected = [];
// error_* tools deliberately absent: error-journal "not installed".
const toolList = ["session_handoff", "decision_log", "decision_search", "error_search", "snippet_search", "codebase_index", "list_sessions"];
const ctx = {
  options: {},
  location: { directory: tmpdir() },
  tool: { list: async () => toolList.map((id) => ({ id })) },
  command: {
    transform: async (cb) => {
      cb({ add: (c) => commands.push(c) });
      return { dispose: async () => {} };
    },
  },
  session: { prompt: async (input) => { injected.push(input); } },
};
await mod.default.setup(ctx);
const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

await byName.toolbox.execute({ sessionID: "ses_q1", prompt: { text: "" }, delivery: "steer" });
const inventory = injected.at(-1).text;
check("Q1: toolbox names the provider plugin per tool",
  inventory.includes("decision_log") && /decision_log[^\n]*decision-log/.test(inventory), "decision_log line");
check("Q1: providers shown for several plugins",
  /codebase_index[^\n]*codebase-index/.test(inventory) && /session_handoff[^\n]*opencode-sessions/.test(inventory));
check("Q1: missing tools stay absent", !inventory.includes("trace_query"));

await byName.journal.execute({ sessionID: "ses_q1", prompt: { text: "boom" }, delivery: "steer" });
check("Q1: missing-plugin note names the providing plugin",
  /error_log[^\n]*error-journal/.test(injected.at(-1).text) && /not installed/.test(injected.at(-1).text),
  injected.at(-1).text.split("\n")[0]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
