/**
 * Mock-context verification for the code-review agent-fix flow.
 *
 * Exercises model selection (free first, cheapest fallback), the agent brief,
 * the /code-review and /deep-code-review commands, and review persistence —
 * all against a stub context with no opencode server.
 *
 *   node tests/verify-code-review-agents.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-code-review-agents-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/code-review.ts", import.meta.url));
const { __test__ } = mod;
check("code-review exposes __test__ hooks", typeof __test__?.pickFreeModel === "function");

// ------------------------------------------------------- expanded static rules
{
  const cfg0 = __test__.resolveConfig({});
  const sample = [
    'const fn = new Function("return 1");',
    "pickle.loads(payload)",
    "if (x = 5) { work(); }",
    "const last = arr[arr.length];",
    'setTimeout("doThing()", 100);',
    "const o = { a: 1, a: 2 };",
    "// const removed = 1;",
    "const t = JSON.parse(JSON.stringify(obj));",
    "debugger;",
    "const z = a === a;",
    "parseInt(n);",
  ];
  const found = __test__.reviewLines(sample, "sample.ts", cfg0);
  const ids = new Set(found.map((f) => f.ruleId));
  for (const want of [
    "FUNCTION_CONSTRUCTOR",
    "UNSAFE_DESERIALIZE",
    "ASSIGNMENT_IN_CONDITION",
    "OFF_BY_ONE_LENGTH_INDEX",
    "SETTIMEOUT_STRING",
    "DUPLICATE_OBJECT_KEY",
    "COMMENTED_OUT_CODE",
    "JSON_DEEP_CLONE",
    "DEBUGGER_STATEMENT",
    "SELF_COMPARISON",
    "PARSEINT_NO_RADIX",
  ]) {
    check(`new rule fires: ${want}`, ids.has(want));
  }
}

// ------------------------------------------------------- model selection
const modelList = [
  { providerID: "opencode", modelID: "free-a", cost: { input: 0, output: 0 } },
  { providerID: "opencode-go", modelID: "free-go", cost: { input: 0, output: 0 } },
  { providerID: "opencode-go", modelID: "expensive", cost: { input: 3, output: 15 } },
  { providerID: "mio", modelID: "cheap", cost: { input: 0.01, output: 0.02 } },
  { providerID: "opencode-go", modelID: "mid", cost: { input: 0.1, output: 0.5 } },
];
const modelCtx = { model: { list: async () => ({ data: modelList }) } };
const models = await __test__.listAvailableModels(modelCtx);
check("listAvailableModels parses all entries", models.length === 5, String(models.length));

const free = __test__.pickFreeModel(models);
check(
  "pickFreeModel prefers the opencode-go free model",
  free?.providerID === "opencode-go" && free?.modelID === "free-go",
  JSON.stringify(free),
);

const cheap = __test__.pickCheapestModel(models);
check("pickCheapestModel picks the lowest combined price", cheap?.modelID === "cheap", JSON.stringify(cheap));

const cfg = __test__.resolveConfig({});
const resolved = await __test__.resolveAgentModels(modelCtx, cfg);
check("resolveAgentModels yields a free fix model", resolved.fixModel === "opencode-go/free-go", resolved.fixModel);
check("resolveAgentModels yields a free review model", resolved.reviewModel === "opencode-go/free-go", resolved.reviewModel);
check("resolveAgentModels reports free availability", resolved.freeAvailable === true);

const paidOnlyCtx = {
  model: { list: async () => ({ data: [modelList[2], modelList[3], modelList[4]] }) },
};
const paidResolved = await __test__.resolveAgentModels(paidOnlyCtx, cfg);
check(
  "no free model: fixModel empty, cheapest surfaced",
  paidResolved.fixModel === "" && paidResolved.cheapest?.model === "mio/cheap",
  JSON.stringify(paidResolved.cheapest),
);

const unknownCostCtx = { model: { list: async () => ({ data: [{ providerID: "local", modelID: "mystery" }] }) } };
const unknownResolved = await __test__.resolveAgentModels(unknownCostCtx, cfg);
check(
  "unknown pricing is not misread as free",
  unknownResolved.fixModel === "" && unknownResolved.cheapest === undefined && unknownResolved.needsApproval === true,
  JSON.stringify(unknownResolved),
);

// ------------------------------------------------------- brief building
const finding = {
  file: "src/x.ts",
  line: 3,
  severity: "high",
  category: "security",
  message: "SQL injection via string interpolation",
  suggestion: "Use a parameterized query",
  confidence: 0.9,
  ruleId: "SQL_INJECTION",
};

const freeBrief = __test__.buildAgentTaskBrief({
  mode: "targeted",
  targetLabel: "src/x.ts",
  targetPath: "src/x.ts",
  reviewId: 7,
  findings: [finding],
  cfg,
  model: resolved,
  canSpawn: true,
  needFallbackReview: true,
});
check("brief names the free model", freeBrief.includes("opencode-go/free-go"), "");
check("brief leads with a single FIRST ACTION", /FIRST ACTION/.test(freeBrief) && freeBrief.indexOf("FIRST ACTION") < freeBrief.indexOf("Model policy"), "");
check("brief instructs spawn_session", freeBrief.includes("spawn_session"));
check("brief embeds the finding", freeBrief.includes("SQL injection via string interpolation"));
check("brief has a fallback reviewer step", /reviewer child/i.test(freeBrief));
check("brief asks for verification", /Verify and report/i.test(freeBrief));

const paidBrief = __test__.buildAgentTaskBrief({
  mode: "targeted",
  targetLabel: "src/x.ts",
  targetPath: "src/x.ts",
  reviewId: null,
  findings: [],
  cfg,
  model: paidResolved,
  canSpawn: true,
  needFallbackReview: false,
});
check("no free model: brief tells the agent to ask the user", /ask the user/i.test(paidBrief));
check("no free model: brief names the cheapest model", paidBrief.includes("mio/cheap"));

const unknownBrief = __test__.buildAgentTaskBrief({
  mode: "targeted",
  targetLabel: "src/x.ts",
  targetPath: "src/x.ts",
  reviewId: null,
  findings: [],
  cfg,
  model: unknownResolved,
  canSpawn: true,
  needFallbackReview: false,
});
check(
  "unknown pricing: brief asks the user and says pricing is unpublished",
  /ask the user/i.test(unknownBrief) && /pricing was not published/i.test(unknownBrief),
);

// CR-17: pinning a paid fix model must not be reported as a free one.
{
  const pinnedCfg = __test__.resolveConfig({ fixModel: "opencode-go/expensive" });
  const pinnedModels = await __test__.resolveAgentModels(modelCtx, pinnedCfg);
  const pinnedBrief = __test__.buildAgentTaskBrief({
    mode: "targeted",
    targetLabel: "src/x.ts",
    targetPath: "src/x.ts",
    reviewId: 7,
    findings: [finding],
    cfg: pinnedCfg,
    model: pinnedModels,
    canSpawn: true,
    needFallbackReview: false,
  });
  check(
    "a pinned paid model is priced, never called free (CR-17)",
    /pinned model opencode-go\/expensive/.test(pinnedBrief) &&
      /\$3\/\$15/.test(pinnedBrief) &&
      !/cost \$0/.test(pinnedBrief),
    pinnedModels.note,
  );

  const ghostCfg = __test__.resolveConfig({ fixModel: "acme/ghost" });
  const ghostModels = await __test__.resolveAgentModels(modelCtx, ghostCfg);
  check("an unverifiable pinned model is flagged (CR-17)", /cost not verified/.test(ghostModels.note), ghostModels.note);
}

const noSpawnBrief = __test__.buildAgentTaskBrief({
  mode: "targeted",
  targetLabel: "src/x.ts",
  targetPath: "src/x.ts",
  reviewId: null,
  findings: [finding],
  cfg,
  model: resolved,
  canSpawn: false,
  needFallbackReview: false,
});
check("missing spawn_session: brief falls back to inline fixes", /NOT available/.test(noSpawnBrief));

const deepBrief = __test__.buildAgentTaskBrief({
  mode: "deep",
  targetLabel: sandbox,
  targetPath: sandbox,
  reviewId: null,
  findings: [],
  cfg,
  model: resolved,
  canSpawn: true,
  needFallbackReview: false,
});
check(
  "deep brief spawns a deep reviewer and hunts every bug",
  /DEEP CODEBASE REVIEW/.test(deepBrief) && /deep-review child/i.test(deepBrief) && /every REAL bug/i.test(deepBrief),
);

// ------------------------------------------------------- injection flow
const calls = { notes: [], prompts: [] };
const fakeCtx = {
  tool: { list: async () => [{ id: "spawn_session" }] },
  model: modelCtx.model,
  session: {},
};
const callbacks = {
  note: async (text) => { calls.notes.push(text); },
  say: async (text) => { calls.prompts.push(text); },
};

await __test__.injectAgentFixFlow(
  fakeCtx,
  cfg,
  "ses_x",
  { mode: "targeted", targetLabel: "t", targetPath: "t", reviewId: 1, findings: [finding] },
  callbacks,
);
check("injectAgentFixFlow posts a status note", calls.notes.length === 1, calls.notes[0] ?? "");
check("injectAgentFixFlow injects one brief", calls.prompts.length === 1 && calls.prompts[0].includes("spawn_session"));

const before = calls.prompts.length;
await __test__.injectAgentFixFlow(
  fakeCtx,
  __test__.resolveConfig({ enableLlmFallback: false }),
  "ses_x",
  { mode: "targeted", targetLabel: "t", targetPath: "t", reviewId: null, findings: [] },
  callbacks,
);
check("no findings and no fallback: nothing injected", calls.prompts.length === before);

// ------------------------------------------------------- spawnMode config
check("spawnMode defaults to agent", cfg.spawnMode === "agent", cfg.spawnMode);
check("directReviewTimeoutSec defaults to 300", cfg.directReviewTimeoutSec === 300, String(cfg.directReviewTimeoutSec));
check("spawnMode direct parses", __test__.resolveConfig({ spawnMode: "direct" }).spawnMode === "direct");
check(
  "directReviewTimeoutSec clamps to at least 30",
  __test__.resolveConfig({ directReviewTimeoutSec: 5 }).directReviewTimeoutSec >= 30,
);

check(
  "parseModelRef splits provider/model",
  JSON.stringify(__test__.parseModelRef("opencode-go/free-go")) ===
    JSON.stringify({ providerID: "opencode-go", modelID: "free-go" }),
);
check("parseModelRef rejects a bare id", __test__.parseModelRef("free-go") === null);

// ------------------------------------------------------- direct spawn mode
const f1 = { ...finding, file: "a.ts" };
const f2 = { ...finding, file: "b.ts" };
const freeModels = [{ providerID: "opencode-go", modelID: "free-go", cost: { input: 0, output: 0 } }];

function makeDirectCtx(data) {
  const created = [];
  const prompts = [];
  const ctx = {
    model: { list: async () => ({ data }) },
    session: {
      create: async (input) => {
        const id = `child_${created.length + 1}`;
        created.push({ id, input });
        return { id };
      },
      prompt: async (input) => { prompts.push(input); },
      context: async () => [
        { type: "assistant", content: [{ type: "text", text: `Found 2 bugs.\n${"[[REVIEW_DONE]]"}` }] },
      ],
    },
  };
  return { ctx, created, prompts };
}

check("groupFindingsByFile groups by file", __test__.groupFindingsByFile([f1, f2, { ...f1 }], 6).length === 2);
check(
  "groupFindingsByFile merges beyond the cap",
  (() => { const g = __test__.groupFindingsByFile([f1, f2, { ...f1, file: "c.ts" }, { ...f1, file: "d.ts" }], 2); return g.length === 2 && g.flat().length === 4; })(),
);

const d1 = makeDirectCtx(freeModels);
const n1 = [];
await __test__.runDirectSpawn(
  d1.ctx, cfg,
  { mode: "targeted", targetLabel: "t", targetPath: sandbox, reviewId: 1, findings: [f1, f2] },
  false,
  { note: async (t) => { n1.push(t); }, say: async () => {} },
);
check("direct: one fixer per file", d1.created.length === 2, String(d1.created.length));
check(
  "direct: children get the free model",
  d1.created.every((c) => c.input.model.providerID === "opencode-go" && c.input.model.id === "free-go"),
);
check("direct: each fixer is prompted", d1.prompts.length === 2);
check("direct: status note reports the spawns", /spawnMode=direct: spawned 2/.test(n1.join("")));

const d2 = makeDirectCtx([{ providerID: "x", modelID: "paid", cost: { input: 1, output: 2 } }]);
const n2 = [];
await __test__.runDirectSpawn(
  d2.ctx, cfg,
  { mode: "targeted", targetLabel: "t", targetPath: sandbox, reviewId: 1, findings: [f1] },
  false,
  { note: async (t) => { n2.push(t); }, say: async () => {} },
);
check("direct: no free model spawns nothing and tells the user", d2.created.length === 0 && /no free model/i.test(n2.join("")));

const d3 = makeDirectCtx(freeModels);
const n3 = [];
await __test__.runDirectSpawn(
  d3.ctx, cfg,
  { mode: "deep", targetLabel: sandbox, targetPath: sandbox, reviewId: null, findings: [] },
  false,
  { note: async (t) => { n3.push(t); }, say: async () => {} },
);
check("direct deep: spawns reviewer + fixer", d3.created.length === 2, String(d3.created.length));
check("direct deep: first child is the reviewer", /reviewer/.test(d3.created[0]?.input.title ?? ""));
check(
  "direct deep: fixer receives the reviewer report (sentinel stripped)",
  d3.prompts.some((p) => /Found 2 bugs/.test(p.text) && !/\[\[REVIEW_DONE\]\]/.test(p.text)),
  d3.prompts.map((p) => p.text.slice(0, 40)).join(" | "),
);

const cfgDirect = __test__.resolveConfig({ spawnMode: "direct", enableLlmFallback: false });

// CR-9: a reviewer child that never prints the sentinel must still be read to
// the end — its report is what the fixer child receives.
{
  const seen = [];
  let reads = 0;
  const idleCtx = {
    model: { list: async () => ({ data: freeModels }) },
    session: {
      create: async () => ({ id: `idle_${seen.length + 1}` }),
      prompt: async (input) => { seen.push(input.text); },
      context: async () => {
        reads++;
        return [{ type: "assistant", content: [{ type: "text", text: "Found 5 bugs in the queue worker." }] }];
      },
      // The host reports the child idle from the second read onward.
      status: async () => (reads > 1 ? { type: "idle" } : { type: "busy" }),
    },
  };
  const idleNotes = [];
  const started = Date.now();
  await __test__.runDirectSpawn(
    idleCtx, cfg,
    { mode: "deep", targetLabel: sandbox, targetPath: sandbox, reviewId: null, findings: [] },
    false,
    { note: async (t) => { idleNotes.push(t); }, say: async () => {} },
  );
  check(
    "deep direct mode forwards the full reviewer report without a sentinel (CR-9)",
    seen.some((t) => /Found 5 bugs in the queue worker\./.test(t)) && Date.now() - started < 30000,
    `${seen.length} prompts in ${Date.now() - started}ms`,
  );
}

const d4 = makeDirectCtx(freeModels);
let said = 0;
await __test__.injectAgentFixFlow(
  d4.ctx, cfgDirect, "ses_direct",
  { mode: "targeted", targetLabel: "t", targetPath: sandbox, reviewId: 1, findings: [f1] },
  { note: async () => {}, say: async () => { said++; } },
);
check("inject dispatches direct mode without an agent brief", said === 0 && d4.created.length === 1, String(d4.created.length));

// ------------------------------------------------------- command registration
const tools = {};
const commands = {};
const noteCalls = [];
const promptCalls = [];

await mod.default.setup({
  options: {},
  location: { directory: sandbox },
  tool: {
    transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); return { dispose: async () => {} }; },
    list: async () => [{ id: "spawn_session" }],
  },
  model: modelCtx.model,
  session: {
    synthetic: async (i) => { noteCalls.push(i); },
    prompt: async (i) => { promptCalls.push(i); },
  },
  command: {
    transform: async (cb) => { cb({ add: (c) => { commands[c.name] = c; } }); return { dispose: async () => {} }; },
  },
});

check("registers /code-review command", typeof commands["code-review"]?.execute === "function");
check("registers /deep-code-review command", typeof commands["deep-code-review"]?.execute === "function");

// /code-review file persists and injects a fix brief
const badFile = join(sandbox, "bad.ts");
writeFileSync(badFile, ["export function run(name: string) {", "  const x: any = name;", "  eval(x);", "  return x;", "}"].join("\n"));
await commands["code-review"].execute({ sessionID: "ses_cmd", prompt: { text: `file ${badFile}` } });

const noteText = noteCalls.map((n) => n.text).join("\n");
const idMatch = /#(\d+)\s+Reviewed/.exec(noteText);
check("file review persists and shows a review id", Boolean(idMatch), noteText.split("\n")[0] ?? "");
check("file review auto-injects a fix brief", promptCalls.some((c) => c.sessionID === "ses_cmd" && /spawn_session/.test(c.text)));

if (idMatch) {
  const stored = await __test__.loadReviewFindings(Number(idMatch[1]));
  check("findings are persisted for the review", stored.length > 0, String(stored.length));
}

// /deep-code-review injects a deep brief
promptCalls.length = 0;
await commands["deep-code-review"].execute({ sessionID: "ses_deep", prompt: { text: sandbox } });
check(
  "deep command injects a deep agent brief",
  promptCalls.some((c) => c.sessionID === "ses_deep" && /DEEP CODEBASE REVIEW/.test(c.text)),
);

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
