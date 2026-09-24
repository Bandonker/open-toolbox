/**
 * Regression: context-pruner must not inject a synthetic nudge into a request
 * whose transcript carries assistant reasoning. Strict providers reject those
 * turns ("thinking is enabled but reasoning_content is missing") and the
 * session dies, so the nudge is banked instead.
 *
 *   node tests/verify-pruner-reasoning.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-pruner-reasoning");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX
// Ambient pruner env (e.g. a leftover OPENCODE_CONTEXT_PRUNER_ENABLED=false)
// must not leak into the fixture.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_CONTEXT_PRUNER_")) delete process.env[key];
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));

const big = "A".repeat(20000);
const toolResults = [
  { role: "tool", content: [{ type: "tool-result", id: "a", name: "read", result: { type: "text", value: big } }] },
  { role: "tool", content: [{ type: "tool-result", id: "b", name: "read", result: { type: "text", value: big } }] },
];

/** Drive the context hook and return the synthetic nudges it emitted. */
async function drive(sessionID, messages) {
  const nudges = [];
  const hooks = {};
  const ctx = {
    options: {
      enabled: true,
      notify: "off",
      nudgeEnabled: true,
      nudgeFrequency: 1,
      nudgeCallFrequency: 1,
      minContextLimit: 1,
      minReplanTokens: 0,
      keepRecent: 0,
      keepRecentText: 0,
      minChars: 10,
      keepHeadChars: 10,
      dedupe: false,
      superseded: false,
      purgeErrors: false,
      autoSummarize: false,
      proactiveSummarize: false,
      retryOnOverflow: false,
      compactionCheckpoint: false,
    },
    location: { directory: tmpdir() },
    tool: {
      transform: async (cb) => {
        cb({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async (input) => {
        nudges.push(input);
        return {};
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  await hooks.context({
    messages,
    system: [],
    tools: {},
    sessionID,
    model: { id: "m", providerID: "p" },
    agent: "build",
  });
  if (typeof cleanup === "function") await cleanup();
  return nudges.filter((n) => String(n.text ?? "").includes("compress"));
}

// Baseline: no reasoning → the nudge is voiced.
{
  const nudges = await drive("ses_reason_none", toolResults);
  check("nudge fires when the transcript has no reasoning", nudges.length >= 1, `${nudges.length} nudge(s)`);
}

// Real SDK shape: assistant content part `{ type: "reasoning" }`.
{
  const messages = [
    ...toolResults,
    { role: "assistant", content: [{ type: "reasoning", text: "private chain of thought" }] },
  ];
  const nudges = await drive("ses_reason_part", messages);
  check("reasoning content part suppresses the synthetic nudge", nudges.length === 0, `${nudges.length} nudge(s)`);
}

// Legacy top-level field on the message.
{
  const messages = [...toolResults, { role: "assistant", reasoning: "private chain of thought" }];
  const nudges = await drive("ses_reason_top", messages);
  check("top-level reasoning field suppresses the synthetic nudge", nudges.length === 0, `${nudges.length} nudge(s)`);
}

// Alternate `parts` array carrier.
{
  const messages = [
    ...toolResults,
    { role: "assistant", parts: [{ type: "reasoning", reasoning: "private chain of thought" }] },
  ];
  const nudges = await drive("ses_reason_parts", messages);
  check("reasoning part in a `parts` array suppresses the synthetic nudge", nudges.length === 0, `${nudges.length} nudge(s)`);
}

const failed = results.filter((r) => !r.ok);
rmSync(sandbox, { recursive: true, force: true });
if (failed.length > 0) {
  console.error(`\nverify-pruner-reasoning: ${failed.length} assertion(s) failed`);
  process.exit(1);
}
console.log("verify-pruner-reasoning: all assertions passed");
