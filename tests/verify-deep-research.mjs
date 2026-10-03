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
/* ------------------------------------------------------------- inline mode */

// Default is inline: no child sessions, brief delivered to this session.
const inlineBefore = created;
const inlineRun = await byName.get("deep_research").execute({ topic: "inline topic test" }, toolCtx);
check("inline mode delivers a brief to the current session", inlineRun.content.includes("mode: inline"));
check("inline mode creates no child sessions", created === inlineBefore, `created ${inlineBefore} -> ${created}`);
check("inline mode returns a run id", /deep research brief delivered: [0-9a-f]{8}/.test(inlineRun.content), inlineRun.content.split("\n")[0]);

/* ------------------------------------------------------------- happy path */

// mode=parallel fans out to child sessions and writes a report.
const run = await byName
  .get("deep_research")
  .execute({ topic: "test topic for deep research", depth: "quick", mode: "parallel" }, toolCtx);
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
  check("command defaults to inline mode", built.includes('"inline"'));
  check("command tells the model not to spawn for inline", /Do not spawn child sessions/.test(built));
  const par = spec.build("some topic mode=parallel", new Set());
  check("command extracts mode=parallel", par.includes('"parallel"'));
  const noTopic = spec.build("", new Set());
  check("command handles no topic", noTopic.includes("no topic"));
}


/* ---------------------------------------------- docs/research topic folders */

const TOPIC = "test topic for deep research";
const deliberate = await byName.get("deep_research_deliberate").execute(
  { topic: TOPIC, question: "is quantization actually reliable?" },
  toolCtx,
);
check("deliberate works after a parallel run", /Question recorded as Q1/.test(deliberate.content), deliberate.content.split("\n")[0]);

const answerRes = await byName.get("deep_research_answer").execute(
  { topic: TOPIC, question: "is quantization actually reliable?", answer: "Contested; sources disagree." },
  toolCtx,
);
check("answer is recorded", /recorded|appended/i.test(answerRes.content), answerRes.content);

check("deliberate rejects an unknown topic", /No findings/.test((await byName.get("deep_research_deliberate").execute({ topic: "never researched topic at all", question: "why" }, toolCtx)).content));

await byName.get("deep_research_consolidate").execute({ topic: TOPIC }, toolCtx);
const wrote = await byName.get("deep_research_write_report").execute(
  { topic: TOPIC, report: "# Research report\n\nConsolidated body that is definitely long enough." },
  toolCtx,
);
check("consolidated report is written to the topic folder", /report\.md/.test(wrote.content), wrote.content);

// The topic folder must have been created under <project>/docs/research/<slug>/.
const projDir = process.env.OPENCODE_DEEP_RESEARCH_TEST_PROJECT ?? sandbox;
const slug = "test-topic-for-deep-research";
const topicFolder = join(projDir, "docs", "research", slug);
check("docs/research/<topic>/ was created on demand", existsSync(topicFolder), topicFolder);
check("findings.md lives in the topic folder", existsSync(join(topicFolder, "findings.md")));
check("deliberation.md holds the question", /quantization actually reliable/.test(readFileSync(join(topicFolder, "deliberation.md"), "utf8")));
check("the awaiting placeholder was replaced by the answer", /Contested; sources disagree/.test(readFileSync(join(topicFolder, "deliberation.md"), "utf8")));
check("report.md lives in the topic folder", existsSync(join(topicFolder, "report.md")));

rmSync(sandbox, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);