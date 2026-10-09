// Regression checks for the 2026-10-01 context-pruner fixes (CP-1..CP-21).
// Cheap, in-process, no model calls except where a summarise path is driven
// deliberately. Run: node tests/verify-cp-fix.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME BEFORE the plugin is imported: config (and the CP-16 debug dir)
// resolve under homedir() at import/setup time.
const HOME = mkdtempSync(join(tmpdir(), "cp-fix-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.XDG_CONFIG_HOME;

const mod = await import("../plugins/context-pruner.ts");
const plugin = mod.default;
const t = mod.__test__;
const WORK = mkdtempSync(join(tmpdir(), "cp-fix-work-"));

const textOf = (p) => {
  const r = p.result;
  if (typeof r === "string") return r;
  if (typeof r?.value === "string") return r.value;
  if (Array.isArray(r?.value)) return r.value.map((v) => v?.text ?? "").join("");
  return typeof p.text === "string" ? p.text : "";
};
const toolUnit = (i, text) => ({
  key: `t${i}`,
  name: "read",
  text,
  tokens: 10,
  file: "",
  redactions: 0,
  input: { filePath: `f${i}.ts` },
  output: undefined,
  part: { type: "tool-result", id: `p${i}`, name: "read" },
  kind: "tool",
});

// ---------------------------------------------------------------- CP-1
// Two different guards, two different functions:
//  - `protectedFromIndex` is the VOLUNTARY recency ring (keepRecentTurns /
//    turnProtection / purgeErrorTurns). A window wider than the transcript is
//    not a protection, it is everything, so it returns -1 there.
//  - `liveTurnIndex` is the MANDATORY live-turn guard (invariant C2): the
//    newest real user turn, always, regardless of any ring.
assert.equal(t.protectedFromIndex([{ role: "user" }, { role: "tool" }], 1), -1, "CP-1: ring wider than the session protects nothing");
assert.equal(t.protectedFromIndex([{ role: "tool" }, { role: "tool" }], 2), -1, "CP-1: no user message -> no protection");
assert.equal(
  t.protectedFromIndex([{ role: "user" }, { role: "user" }, { role: "user" }], 2),
  1,
  "CP-1: with more turns than the window, protect the last N",
);
assert.equal(t.protectedFromIndex([{ role: "user" }, { role: "user" }], 4), -1, "CP-1: a ring wider than the session does not freeze it");

assert.equal(t.liveTurnIndex([{ role: "user" }, { role: "tool" }]), 0, "CP-1: the single user turn is the live turn");
assert.equal(t.liveTurnIndex([{ role: "tool" }, { role: "tool" }]), -1, "CP-1: no user message -> no live turn");
assert.equal(
  t.liveTurnIndex([{ role: "user" }, { role: "user" }, { role: "tool" }]),
  1,
  "CP-1: the live turn is the NEWEST user turn",
);
// A user message that carries nothing but tool results is the tool channel,
// not a turn: counting it made the C2 guard swallow the whole request, which is
// "never prune", not "never prune the live turn".
assert.equal(
  t.liveTurnIndex([{ role: "user", content: [{ type: "tool-result", name: "read", result: { type: "text", value: "A" } }] }]),
  -1,
  "CP-1: a user message carrying only tool results is not a turn boundary",
);

// The live turn survives a full hook pass even with a SINGLE user message and
// every recency ring disabled — the shape that used to prune the live turn.
{
  const hooks = {};
  const cleanup = await plugin.setup({
    options: { notify: "off", keepRecent: 0, keepRecentTurns: 0, turnProtection: false, minChars: 10, keepHeadChars: 10, minReplanTokens: 0, autoSummarize: false, nudgeEnabled: false, dedupe: false, purgeErrors: false, superseded: false },
    location: { directory: WORK },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; }, synthetic: async () => ({}) },
    event: { subscribe: () => () => {} },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 4000, output: 200 } }] },
    storage: (() => { const s = new Map(); return { get: async (k) => s.get(k), set: async (k, v) => void s.set(k, v), remove: async (k) => void s.delete(k), scan: async () => [...s.keys()] }; })(),
  });
  const msgs = [
    { role: "user", content: [{ type: "text", text: "single user turn" }] },
    ...[0, 1, 2, 3].map((i) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `x${i}`, name: "read", result: { type: "text", value: `LIVE-${i} ` + "z".repeat(4000) } }],
    })),
  ];
  hooks.context({ messages: msgs, system: [], tools: {}, sessionID: "ses_cp1_live", model: { providerID: "p", modelID: "m" }, agent: "build" });
  const stillLive = msgs
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "tool-result")
    .every((p) => textOf(p).startsWith("LIVE-"));
  assert.ok(stillLive, "CP-1: with one user message the whole live turn is never stubbed");
  await cleanup();
  t.resetSessions();
}

// ---------------------------------------------------------------- CP-2
// The recency ring counts TOOL outputs only.
{
  const mixed = [
    toolUnit(0, "a".repeat(500)),
    { ...toolUnit(1, "b".repeat(500)), kind: "text", key: "p1", name: "assistant-message" },
    toolUnit(2, "c".repeat(500)),
    toolUnit(3, "d".repeat(500)),
  ];
  // Mirrors candidateResults' recency ring: filter to TOOL outputs FIRST, then
  // take the last `keepRecent` of THAT list. Measuring the slice against the
  // mixed list length let one prose part shrink the ring below keepRecent.
  const tools = mixed.filter((r) => r.kind === "tool");
  const ring = new Set(tools.slice(Math.max(0, tools.length - 2)).map((r) => r.key));
  assert.deepEqual([...ring], ["t2", "t3"], "CP-2: keepRecent 2 protects 2 TOOL outputs, not 1 tool + 1 prose");
}

// ---------------------------------------------------------------- CP-5
// Custom strategies merge into the OUTER decision map.
{
  t.resetSessions();
  const hooks = {};
  const marker = { key: "t0", reason: "custom-strategy", origChars: 500, savedChars: 400, savedTokens: 90 };
  const cleanup = await plugin.setup({
    options: {
      notify: "off",
      keepRecent: 0,
      keepRecentTurns: 0,
      minChars: 10,
      keepHeadChars: 10,
      minReplanTokens: 0,
      autoSummarize: false,
      nudgeEnabled: false,
      dedupe: false,
      purgeErrors: false,
      superseded: false,
      customStrategies: [{ id: "cp5", apply: (results) => new Map([[results[0].key, { ...marker }]]) }],
    },
    location: { directory: WORK },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; }, synthetic: async () => ({}) },
    event: { subscribe: () => () => {} },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 4000, output: 200 } }] },
    storage: (() => { const s = new Map(); return { get: async (k) => s.get(k), set: async (k, v) => void s.set(k, v), remove: async (k) => void s.delete(k), scan: async () => [...s.keys()] }; })(),
  });
  const msgs = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...[0, 1, 2].map((i) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: `U${i} ` + "q".repeat(2000) } }],
    })),
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ];
  hooks.context({ messages: msgs, system: [], tools: {}, sessionID: "ses_cp5_merge", model: { providerID: "p", modelID: "m" }, agent: "build" });
  const texts = msgs.flatMap((m) => m.content ?? []).map(textOf);
  assert.ok(
    texts.some((x) => x.includes("custom-strategy")),
    "CP-5: a custom strategy's decision is applied, not discarded",
  );
  await cleanup();
  t.resetSessions();
}

// ---------------------------------------------------------------- CP-7
// Recall text is capped at WRITE time, so a huge read cannot bloat the store.
{
  t.resetSessions();
  const store = new Map();
  const hooks = {};
  const cleanup = await plugin.setup({
    options: { notify: "off", keepRecent: 0, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, minReplanTokens: 0, autoSummarize: false, nudgeEnabled: false, dedupe: false, purgeErrors: false, superseded: false, recall: true, recallKeep: 5, recallMaxChars: 500 },
    location: { directory: WORK },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; }, synthetic: async () => ({}) },
    event: { subscribe: () => () => {} },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 4000, output: 200 } }] },
    storage: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v), remove: async (k) => void store.delete(k), scan: async () => [...store.keys()] },
  });
  const huge = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "tool", content: [{ type: "tool-result", id: "h1", name: "read", result: { type: "text", value: "H".repeat(400000) } }] },
    { role: "tool", content: [{ type: "tool-result", id: "h2", name: "read", result: { type: "text", value: "I".repeat(400000) } }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ];
  hooks.context({ messages: huge, system: [], tools: {}, sessionID: "ses_cp7_recall", model: { providerID: "p", modelID: "m" }, agent: "build" });
  await new Promise((r) => setTimeout(r, 120));
  const stored = store.get("recall:ses_cp7_recall");
  assert.ok(Array.isArray(stored) && stored.length > 0, "CP-7: recall entries were persisted");
  // The write cap is derived from the EFFECTIVE recallMaxChars. Config clamps
  // that option to a floor of 1000 (`asInt(..., 200000, 1000, ...)`), so the
  // 500 requested above resolves to 1000 and the bound is 1000 x factor (+ room
  // for the truncation marker). Bounding against the requested value instead
  // made this assertion unreachable.
  const effectiveMax = t.resolveConfig(WORK, { recallMaxChars: 500 }).recallMaxChars;
  const storeBound = effectiveMax * 2 + 200;
  for (const entry of stored) {
    assert.ok(entry.text.length <= storeBound, `CP-7: stored recall text is capped at recallMaxChars x factor (got ${entry.text.length}, bound ${storeBound})`);
    assert.ok(entry.chars > entry.text.length, "CP-7: chars keeps the ORIGINAL size for the read-side notice");
  }
  await cleanup();
  t.resetSessions();
}

// ---------------------------------------------------------------- CP-12
// LFU eviction uses recorded hits and breaks ties deterministically.
{
  t.resetSessions();
  const st = t.stateFor("ses_cp12");
  st.recall.set("old-cold", { tool: "read", text: "a", chars: 1, at: 1 });
  st.recall.set("old-hot", { tool: "read", text: "b", chars: 1, at: 2, hits: 5 });
  st.recall.set("new-cold", { tool: "read", text: "c", chars: 1, at: 3 });
  t.evictRecall(st, 2, "lfu");
  assert.ok(!st.recall.has("old-cold"), "CP-12: the never-read entry goes first");
  assert.ok(st.recall.has("old-hot"), "CP-12: a hot entry survives an older cold one");
  st.recall.set("another-cold", { tool: "read", text: "d", chars: 1, at: 4 });
  t.evictRecall(st, 2, "lfu");
  assert.ok(!st.recall.has("new-cold"), "CP-12: equal scores evict the OLDER entry, not the Map order winner");
  t.resetSessions();
}

// ---------------------------------------------------------------- CP-16
// Debug logs land in globalConfigDirs()[0] and old files are pruned.
{
  const cfg = t.resolveConfig(WORK, { debug: true });
  assert.equal(cfg.debug, true, "CP-16: debug enabled for this block");
  // CP-16: the plugin's own ordering decides dirs[0] — on darwin it is
  // ~/Library/Application Support/opencode, with ~/.config kept only as the
  // legacy fallback. Assert against globalConfigDirs()[0] rather than a
  // hardcoded Linux path, so the check covers what the code actually does.
  const dirs = t.globalConfigDirs();
  assert.equal(
    dirs[0],
    process.platform === "darwin"
      ? join(HOME, "Library", "Application Support", "opencode")
      : join(HOME, ".config", "opencode"),
    "CP-16: the debug dir reuses the first config dir",
  );
  const logDir = join(dirs[0], "logs", "context-pruner");
  mkdirSync(logDir, { recursive: true });
  const oldFile = join(logDir, "2000-01-01.log");
  writeFileSync(oldFile, "stale\n");
  utimesSync(oldFile, new Date(Date.now() - 30 * 864e5), new Date(Date.now() - 30 * 864e5));
  const hooks = {};
  const cleanup = await plugin.setup({
    options: { notify: "off", debug: true, autoSummarize: false, nudgeEnabled: false },
    location: { directory: WORK },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; }, synthetic: async () => ({}) },
    event: { subscribe: () => () => {} },
    model: { list: () => [] },
    storage: (() => { const s = new Map(); return { get: async (k) => s.get(k), set: async (k, v) => void s.set(k, v), remove: async (k) => void s.delete(k), scan: async () => [...s.keys()] }; })(),
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!readdirSync(logDir).includes("2000-01-01.log"), "CP-16: debug logs older than a week are pruned");
  assert.ok(readdirSync(logDir).some((n) => n.endsWith(".log")), "CP-16: debug writes land in the config-dir logs folder");
  await cleanup();
}

// ---------------------------------------------------------------- CP-21
// Nested options arrive from ctx.options as an object OR a JSON string.
{
  const viaObject = t.resolveConfig(WORK, { turnProtection: { enabled: true, turns: 9 }, manualMode: { enabled: true, automaticStrategies: false } });
  assert.equal(viaObject.turnProtection.enabled, true, "CP-21: turnProtection from ctx.options");
  assert.equal(viaObject.turnProtection.turns, 9, "CP-21: turnProtection.turns from ctx.options");
  assert.equal(viaObject.manualMode.enabled, true, "CP-21: manualMode object from ctx.options");
  assert.equal(viaObject.manualMode.automaticStrategies, false, "CP-21: manualMode.automaticStrategies from ctx.options");

  const viaJson = t.resolveConfig(WORK, { turnProtection: '{"enabled":true,"turns":7}', strategies: '{"deduplication":{"enabled":false}}' });
  assert.equal(viaJson.turnProtection.enabled, true, "CP-21: turnProtection as a JSON string");
  assert.equal(viaJson.turnProtection.turns, 7, "CP-21: turnProtection.turns as a JSON string");
  assert.equal(viaJson.dedupe, false, "CP-21: strategies.deduplication from ctx.options");

  process.env.OPENCODE_CONTEXT_PRUNER_TURN_PROTECTION = '{"enabled":true,"turns":6}';
  assert.equal(t.resolveConfig(WORK, {}).turnProtection.turns, 6, "CP-21: turnProtection from the environment");
  delete process.env.OPENCODE_CONTEXT_PRUNER_TURN_PROTECTION;
  assert.equal(t.resolveConfig(WORK, {}).turnProtection.enabled, false, "CP-21: default stays off");
}

rmSync(WORK, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log("verify-cp-fix: all assertions passed");
