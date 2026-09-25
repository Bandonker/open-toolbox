// Verifies the per-request cap on proactive summarisation (maxAutoSummaries):
// at most N stale units per model call (largest first, live turn untouched),
// repeat requests reuse the summary cache without re-spending the session
// model-call budget, and 0 = unlimited.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "pruner-autocap-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const mod = await import("../plugins/context-pruner.ts");
const t = mod.__test__;
t.resetSessions();

const dir = await mkdtemp(join(tmpdir(), "pruner-autocap-work-"));

// --- resolveConfig wiring -------------------------------------------------
assert.equal(t.resolveConfig(dir, {}).maxAutoSummaries, 12, "default is 12");
assert.equal(t.resolveConfig(dir, { maxAutoSummaries: 0 }).maxAutoSummaries, 0, "0 = unlimited");
assert.equal(t.resolveConfig(dir, { maxAutoSummaries: 10 }).maxAutoSummaries, 10, "explicit value");
assert.equal(t.resolveConfig(dir, { maxAutoSummaries: -5 }).maxAutoSummaries, 0, "clamped to min 0");
process.env.OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES = "7";
assert.equal(t.resolveConfig(dir, {}).maxAutoSummaries, 7, "env override");
delete process.env.OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES;

// --- behaviour -------------------------------------------------------------
const BIG = "C".repeat(4000);
function toolMsgs(tag, n) {
  const msgs = Array.from({ length: n }, (_, i) => ({
    role: "tool",
    content: [{
      type: "tool-result",
      id: `${tag}${i}`,
      name: "read",
      input: { filePath: `/tmp/${tag}${i}.ts` },
      result: { type: "text", value: `U${tag}${i}-${BIG}` },
    }],
  }));
  msgs.push({ role: "user", content: [{ type: "text", text: "LIVE-TURN-MARKER please continue" }] });
  return msgs;
}
function msgText(m) {
  return (Array.isArray(m.content) ? m.content : []).map((p) => {
    if (typeof p.text === "string") return p.text;
    const r = p.result;
    if (r && typeof r.value === "string") return r.value;
    if (typeof r === "string") return r;
    return "";
  }).join("\n");
}
const headings = (prompt) => (String(prompt).match(/### /g) ?? []).length;
// Shared plugin storage (c.storage): the persistent summary cache lives here,
// so a later session can hit a range summarised by an earlier one.
const sharedStore = new Map();
const sharedStorage = {
  get: async (k) => sharedStore.get(k),
  set: (k, v) => { sharedStore.set(k, v); },
};

async function drive(sessionID, options, msgs) {
  const calls = [];
  const hooks = {};
  const cleanup = await mod.default.setup({
    options: {
      notify: "off",
      autoSummarize: true,
      proactiveSummarize: true,
      steadyTargetRatio: 0.1,
      steadyTargetMinTokens: 500,
      autoSummarizeMinTokens: 100,
      minReplanTokens: 0,
      ...options,
    },
    location: { directory: dir },
    storage: sharedStorage,
    tool: { transform: async (cb) => { await cb({ add: () => {} }); return { dispose: async () => {} }; } },
    model: { list: () => [{ id: "cap", providerID: "p", limit: { context: 20000, output: 100 } }] },
    session: {
      hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; },
      generate: async (arg) => { calls.push(arg?.prompt ?? arg?.text ?? String(arg)); return { text: `SUMMARY for ${sessionID}` }; },
    },
  });
  const event = (messages) => ({
    messages, system: [], tools: {},
    sessionID, model: { providerID: "p", modelID: "cap" }, agent: "build",
  });
  const flush = () => new Promise((r) => setTimeout(r, 250));
  return { calls, hooks, cleanup, event, flush };
}

// Default cap: 8 stale units -> one model call covering the full need (6 units).
// The default 12 must not bind normal need (lesson: default 3 throttled the
// benchmark workload and cost ~30pp of savings).
{
  const msgs = toolMsgs("a", 8);
  const h = await drive("ses_cap_a", {}, msgs);
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.equal(h.calls.length, 1, "one proactive model call");
  const covered = headings(h.calls[0]);
  assert.ok(covered > 3 && covered <= 12, `default covers the need without binding (got ${covered})`);
  assert.ok(!String(h.calls[0]).includes("LIVE-TURN-MARKER"), "live turn never sent to the model");
  // Repeat request: any further call only covers new units (continued
  // progress, never a duplicate).
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.ok(h.calls.length <= 2, "repeat request covers new units only");
  for (const call of h.calls) assert.ok(!String(call).includes("LIVE-TURN-MARKER"), "live turn never sent");
  assert.ok(msgText(msgs[msgs.length - 1]).includes("LIVE-TURN-MARKER"), "live turn untouched");
  assert.ok(!msgText(msgs[msgs.length - 1]).includes("SUMMARY"), "live turn never summarised");
  await h.cleanup();
}

// Cache reuse: identical content in a new session is a cache hit (free);
// the untouched budget still covers a later novel range.
{
  const msgs = toolMsgs("a", 8); // same ids + text as session A
  const h = await drive("ses_cap_b", { autoSummarizeMaxCalls: 1 }, msgs);
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.equal(h.calls.length, 0, "cache hit costs no model call");
  msgs.splice(8, 0, ...toolMsgs("b", 3).slice(0, 3)); // novel units before the live turn
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.equal(h.calls.length, 1, "budget survived the cache hit and covers the novel range");
  assert.ok(String(h.calls[0]).includes("Ub"), "novel units summarised");
  await h.cleanup();
}

// Explicit small cap still binds: covers exactly 3 of 8 stale units.
{
  const msgs = toolMsgs("d", 8);
  const h = await drive("ses_cap_d", { maxAutoSummaries: 3 }, msgs);
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.equal(h.calls.length, 1, "one proactive model call");
  assert.equal(headings(h.calls[0]), 3, "explicit cap covers 3 units");
  assert.ok(!String(h.calls[0]).includes("LIVE-TURN-MARKER"), "live turn never sent to the model");
  await h.cleanup();
}

// 0 = unlimited: covers the full need, same as the default 12.
{
  const msgs = toolMsgs("c", 8);
  const h = await drive("ses_cap_c", { maxAutoSummaries: 0 }, msgs);
  h.hooks.context(h.event(msgs));
  await h.flush();
  assert.equal(h.calls.length, 1, "one proactive model call");
  assert.ok(headings(h.calls[0]) > 3, `unlimited covers the full need (got ${headings(h.calls[0])})`);
  assert.ok(!String(h.calls[0]).includes("LIVE-TURN-MARKER"), "live turn never sent to the model");
  await h.cleanup();
}

await rm(dir, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });
console.log("verify-pruner-auto-cap: ok");
