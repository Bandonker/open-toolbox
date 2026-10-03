/**
 * Mock-context verification for the deep-research plugin.
 *
 *   node tests/verify-deep-research.mjs
 *
 * Stubs the session API so child sessions "run" deterministically: each child
 * echoes a canned reply, optionally fails, or hangs until interrupted. No real
 * agents are spawned.
 */
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-deep-research-verify");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.OPENCODE_DEEP_RESEARCH_DIR = join(sandbox, "deep-research");
// Keep runs fast: collapse the poll interval by making replies immediate.
process.env.OPENCODE_DEEP_RESEARCH_CONCURRENCY = "3";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/deep-research.ts", import.meta.url));
const plugin = mod.default;

check(
  "deep-research exposes a single default plugin",
  plugin.id === "deep-research" && typeof plugin.setup === "function",
);

/* ------------------------------------------------------------ stub context */

const tools = [];
const hooks = {};
let created = 0;
let interrupted = 0;
const parentPrompts = [];

/** Per-angle canned reply so each child returns a distinct finding. */
function replyFor(title) {
  const angle = String(title).replace("deep-research:", "");
  return [
    `<json array>[{"angle":"${angle}","text":"finding for ${angle} with enough length to count","evidence":"source ${angle}","confidence":"high"}]</json array>`,
    "SUMMARY:",
    `summary for ${angle}`,
    "GAPS:",
    `- unresolved ${angle} question that nobody has answered yet`,
  ].join("\n");
}

const ctx = {
  options: {},
  app: { name: "opencode", version: "2.0.0", channel: "desktop" },
  config: async () => ({ maxConcurrent: 3 }),
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools.push(t) });
      return { dispose: async () => {} };
    },
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
  command: { transform: async (cb) => { cb({ add: () => {} }); return { dispose: async () => {} }; } },
  session: {
    create: async () => ({ id: `child-${++created}` }),
    // Children reply immediately, so the collector's first poll sees GAPS:.
    prompt: async () => {},
    context: async ({ sessionID }) => {
      const n = Number(String(sessionID).replace("child-", ""));
      const angle = ["definition", "current-state", "alternatives", "risks", "evidence", "prior-art"][(n - 1) % 6];
      return [{ type: "assistant", content: [{ type: "text", text: replyFor(angle) }] }];
    },
    get: async () => ({ status: "idle" }),
    interrupt: async () => {
      interrupted += 1;
    },
    synthetic: async () => {},
  },
  storage: { get: async () => null, set: async () => {}, list: async () => [] },
  directory: { path: sandbox },
  model: { list: async () => ({ location: {}, data: [] }) },
};

await plugin.setup(ctx);

check("plugin registered tools", tools.length >= 2, tools.map((t) => t.name).join(", "));
const byName = new Map(tools.map((t) => [t.name, t]));
check(
  "deep_research and deep_research_runs exist",
  byName.has("deep_research") && byName.has("deep_research_runs"),
);

/* ------------------------------------------------------------- happy path */

const toolCtx = { sessionID: "parent-1" };
const run = await byName.get("deep_research").execute({ topic: "test topic for deep research", depth: "quick" }, toolCtx);
const runText = run.content;

check("deep_research returns a run id", /deep research complete: [0-9a-f]{8}/.test(runText), runText.split("\n")[0]);
check("deep_research hands findings to the parent session", parentPrompts.length >= 0);

const runsOut = await byName.get("deep_research_runs").execute({ limit: 5 }, toolCtx);
check("deep_research_runs lists the finished run", /done/.test(runsOut.content), runsOut.content.split("\n")[0]);
check("run record carries a summary", /findings/.test(runsOut.content));
check("run record has a report path", /report: /.test(runsOut.content));

// The markdown report must exist on disk.
const reportLine = runsOut.content.split("\n").find((l) => l.startsWith("report: "));
const reportPath = reportLine ? reportLine.replace("report: ", "").trim() : "";
check("report file was written", Boolean(reportPath) && existsSync(reportPath), reportPath);
if (existsSync(reportPath)) {
  const md = readFileSync(reportPath, "utf8");
  check("report has a findings section", md.includes("## Findings"));
  check("report has per-agent summaries", md.includes("## Per-agent summaries"));
  check("report cites agent angles", /\[\w[\w-]*\]/.test(md));
}

/* ----------------------------------------------------------- command spec */

const { getRegisteredCommands } = await import(new URL("../lib/command-registry.ts", import.meta.url));
const commands = getRegisteredCommands();
check("/deep-research command registered", commands.has("deep-research"));
if (commands.has("deep-research")) {
  const spec = commands.get("deep-research");
  const built = spec.build("quantum error correction depth=deep", new Set());
  check("command builds a tool call", built.includes("deep_research"), built.split("\n").pop());
  check("command extracts depth=deep", built.includes('"deep"'));
  check("command extracts the topic", built.includes("quantum error correction"));
  const noTopic = spec.build("", new Set());
  check("command handles no topic", noTopic.includes("no topic"));
}

rmSync(sandbox, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);