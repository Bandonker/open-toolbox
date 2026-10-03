/**
 * Regression checks for the 7 behaviours the CP-1..CP-21 pass broke.
 *
 * Each block reproduces one of the failures and asserts the restored behaviour,
 * so a future pass cannot silently re-break it. Stub contexts only, no model
 * calls except where a summarise path is driven deliberately.
 *
 *   node tests/verify-cp-regress.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME before importing the plugin: config resolves under homedir().
const HOME = mkdtempSync(join(tmpdir(), "cp-regress-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.XDG_CONFIG_HOME;

const mod = await import("../plugins/context-pruner.ts");
const plugin = mod.default;
const t = mod.__test__;

let passed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? `  - ${detail}` : ""}`);
    process.exitCode = 1;
  }
};

function stubCtx(tools, extra = {}) {
  const baseTransform = async (cb) => {
    cb({ add: (t) => tools.push(t) });
    return { dispose: async () => {} };
  };
  return { options: {}, location: { directory: HOME }, ...extra, tool: { transform: baseTransform, ...(extra.tool ?? {}) } };
}
const toolCtx = { sessionID: "ses_test", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} };

/** A rewritten result's `value` becomes an array of text parts (writeUnit). */
const valText = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "");

/** Drive `setup` and return the registered hooks plus a name -> tool map. */
async function boot(tools, options, extra = {}) {
  const hooks = {};
  await plugin.setup(
    stubCtx(tools, {
      options,
      session: {
        hook: async (name, cb) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
        ...(extra.session ?? {}),
      },
      ...(extra.ctx ?? {}),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { hooks, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

const ctxEvent = (sessionID, messages, model = {}) => ({
  sessionID,
  messages,
  system: [],
  tools: {},
  options: {},
  model,
  agent: "build",
});

// ============================================================== 1. replan gate
// A warm cache makes the rewrite premium cost more than the tokens it frees, so
// a voluntary replan with no new savings must be DEFERRED, with a positive gate.
{
  const tools = [];
  let usage = null;
  const { hooks, byName } = await boot(
    tools,
    { keepRecent: 0, minChars: 10, keepHeadChars: 10, notify: false, cacheAware: true, cacheAmortize: 4 },
    {
      ctx: {
        model: {
          list: async () => ({
            data: [{ id: "m", providerID: "p", limit: { context: 100000, output: 8192 }, cost: [{ input: 3, cache: { read: 0.3, write: 3.75 } }] }],
          }),
        },
        event: {
          subscribe: (cb) => {
            usage = cb;
            return () => {};
          },
        },
      },
    },
  );
  const cacheMessages = (count) =>
    [
      { type: "tool-result", name: "read", result: { type: "text", value: "A".repeat(400000) }, input: { filePath: "big.ts" } },
      { type: "tool-result", name: "read", result: { type: "text", value: "B".repeat(20000) }, input: { filePath: "small.ts" } },
    ]
      .slice(0, count)
      .map((part) => ({ role: "user", content: [part] }));
  await hooks.context(ctxEvent("ses_cache", cacheMessages(1), { modelID: "m", providerID: "p" }));
  usage({ type: "session.usage.updated", data: { sessionID: "ses_cache", tokens: { input: 1000, cache: { read: 40000, write: 5000 } } } });
  await hooks.context(ctxEvent("ses_cache", cacheMessages(2), { modelID: "m", providerID: "p" }));
  const report = (await byName.context_report.execute({ sessionID: "ses_cache" }, toolCtx)).content;
  const line = report.split("\n").find((l) => l.includes("last replan")) ?? "";
  ok("cache-aware epoch defers an unprofitable replan", /last replan: deferred/.test(line), line);
  ok("the deferring gate is positive", /replan gate: [1-9][0-9]*/.test(line), line);
  t.resetSessions();
}

// ============================== 2. a stubbed unit stays compressible (CP-10)
// One read was already superseded/stubbed by the automatic pass. The digest has
// to replace that stub, so it must still be counted as a compress target.
{
  const tools = [];
  const store = new Map();
  const generateArgs = [];
  const { hooks, byName } = await boot(
    tools,
    { keepRecent: 2, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false },
    {
      session: {
        generate: async (args) => {
          generateArgs.push(args);
          return { data: { text: "SUMMARY-OF-READS" } };
        },
      },
      ctx: {
        storage: {
          get: async (k) => store.get(k),
          set: async (k, v) => void store.set(k, v),
          remove: async (k) => void store.delete(k),
          scan: async () => [...store.keys()],
        },
      },
    },
  );
  const big = "B".repeat(4000);
  const makeReads = () => [
    { role: "tool", content: [{ type: "tool-result", id: "r1", name: "read", input: { filePath: "/tmp/a.ts" }, result: { type: "text", value: `${big}OLD-A` } }] },
    { role: "tool", content: [{ type: "tool-result", id: "r2", name: "read", input: { filePath: "/tmp/a.ts" }, result: { type: "text", value: `${big}NEW-A` } }] },
    { role: "tool", content: [{ type: "tool-result", id: "r3", name: "read", input: { filePath: "/tmp/b.ts" }, result: { type: "text", value: `${big}B` } }] },
  ];
  const msgs = makeReads();
  await hooks.context(ctxEvent("ses_compress", msgs));
  ok("the automatic pass stubbed the superseded read", valText(msgs[0].content[0].result.value).includes("superseded"));

  const res = await byName.compress.execute({ last: 3, topic: "files" }, { sessionID: "ses_compress" });
  ok("compress summarises the whole range, stub included", /3 tool result\(s\)/.test(res.content), res.content.split("\n")[0]);
  ok("the digest covers the stubbed unit too", /3 tool result\(s\)/.test(res.content) && generateArgs.length === 1, `generates=${generateArgs.length}`);

  const replay = makeReads();
  await hooks.context(ctxEvent("ses_compress", replay));
  ok("the covered range collapses into the digest", replay.length === 1 && valText(replay[0].content[0].result.value).includes("SUMMARY-OF-READS"), `messages=${replay.length}`);
  t.resetSessions();
}

// ============================ 3. compress inside the live turn (CP-18 guard)
// The manual tool is the model naming a range: a single-turn session must still
// be compressible, and the reply says how many units came from the live turn.
{
  const tools = [];
  const store = new Map();
  const generateArgs = [];
  const { hooks, byName } = await boot(
    tools,
    { keepRecent: 0, keepRecentText: 0, keepRecentTurns: 0, minChars: 10000, keepHeadChars: 0, notify: "off", minReplanTokens: 0, autoSummarize: false, compressText: true, cacheAware: false },
    {
      session: {
        generate: async (a) => {
          generateArgs.push(a);
          return { text: "SUMMARY-OF-PROSE" };
        },
      },
      ctx: {
        storage: {
          get: async (k) => store.get(k),
          set: async (k, v) => void store.set(k, v),
          remove: async (k) => void store.delete(k),
          scan: async () => [...store.keys()],
        },
      },
    },
  );
  const makeProse = () => [
    { id: "pu1", role: "user", content: [{ type: "text", text: `USER-ASK ${"U".repeat(300)}` }] },
    {
      id: "pa1",
      role: "assistant",
      content: [
        { type: "text", id: "ptxt1", text: `ASSIST-PROSE ${"P".repeat(600)}` },
        { type: "tool-call", id: "ptc1", name: "read", input: { filePath: "/tmp/p.ts" } },
      ],
    },
    { id: "pr1", role: "tool", content: [{ type: "tool-result", id: "ptc1", name: "read", result: { type: "text", value: `TOOL-OUT ${"T".repeat(600)}` } }] },
  ];
  const msgsP = makeProse();
  await hooks.context(ctxEvent("ses_prose", msgsP));

  const resP = await byName.compress.execute({ from: 2, to: 2, topic: "reasoning" }, { sessionID: "ses_prose" });
  ok("compress can summarise an assistant text part", /1 tool result\(s\)/.test(resP.content), resP.content);
  ok("prose summary is generated from the text part", generateArgs.length === 1 && generateArgs[0].prompt.includes("ASSIST-PROSE"), `generates=${generateArgs.length}`);
  ok("the reply names the live-turn units it folded", /turn in progress/.test(resP.content), resP.content);

  const replayP = makeProse();
  await hooks.context(ctxEvent("ses_prose", replayP));
  ok(
    "assistant prose is replaced by a prose summary",
    replayP[1].content[0].type === "text" && replayP[1].content[0].text.startsWith("[context prose summary] SUMMARY-OF-PROSE"),
    String(replayP[1].content[0].text).slice(0, 60),
  );
  ok("the tool-call stays adjacent to its part", replayP[1].content.length === 2 && replayP[1].content[1].id === "ptc1");
  ok("the tool result is untouched by a prose-only summary", replayP[2].content[0].result.value === `TOOL-OUT ${"T".repeat(600)}`);

  const replayP2 = makeProse();
  await hooks.context(ctxEvent("ses_prose", replayP2));
  ok("prose summary application is idempotent", replayP2[1].content[0].text === replayP[1].content[0].text);

  const reportP = (await byName.context_report.execute({ sessionID: "ses_prose" }, toolCtx)).content;
  ok("context_report distinguishes prose summaries", /1 prose/.test(reportP), reportP.split("\n").find((l) => l.includes("active summaries")) ?? "");
  t.resetSessions();
}

// =============================== 4. summary persistence is deterministic (CP-14)
// The merge-on-write flush must be complete when `compress` returns, and the
// `summaryKeep` cap must evict the OLDEST record — including one that was
// reloaded from storage with its own older `at`.
{
  const tools = [];
  const store = new Map();
  // A record that only exists on disk, stamped well before anything written now.
  store.set("summaries:ses_gc", [
    { first: "t:seed", covers: ["t:seed"], hashes: [1], text: "SEED-DIGEST", tokens: 12, topic: "seed", at: 1 },
  ]);
  const { hooks, byName } = await boot(
    tools,
    { keepRecent: 10, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false, summaryKeep: 2 },
    {
      session: { generate: async () => ({ data: { text: "SUM-G" } }) },
      ctx: {
        storage: {
          get: async (k) => store.get(k),
          set: async (k, v) => void store.set(k, v),
          remove: async (k) => void store.delete(k),
          scan: async () => [...store.keys()],
        },
      },
    },
  );
  const bigG = "G".repeat(3000);
  const msgsG = [1, 2, 3, 4, 5, 6].map((n) => ({
    role: "tool",
    content: [{ type: "tool-result", id: `g${n}`, name: "read", input: { filePath: `/tmp/g${n}.ts` }, result: { type: "text", value: `${bigG}-${n}` } }],
  }));
  const sidG = "ses_gc";
  await hooks.context(ctxEvent(sidG, msgsG));
  await byName.compress.execute({ from: "g1", to: "g2", topic: "a" }, { sessionID: sidG });
  await byName.compress.execute({ from: "g3", to: "g4", topic: "b" }, { sessionID: sidG });
  await byName.compress.execute({ from: "g5", to: "g6", topic: "c" }, { sessionID: sidG });

  const storedG = store.get(`summaries:${sidG}`);
  ok("summary storage is capped per session", Array.isArray(storedG) && storedG.length === 2, `length=${Array.isArray(storedG) ? storedG.length : "n/a"}`);
  ok(
    "summary GC evicts the oldest record",
    Array.isArray(storedG) && !storedG.some((r) => r.covers.includes("t:g1")),
    JSON.stringify(storedG?.map?.((r) => r.covers)),
  );
  ok(
    "a reloaded record keeps its own age when the cap ranks records",
    Array.isArray(storedG) && !storedG.some((r) => r.covers.includes("t:seed")),
    JSON.stringify(storedG?.map?.((r) => r.covers)),
  );
  ok(
    "the persisted record keeps prose / hashes / tokens",
    Array.isArray(storedG) && storedG.every((r) => typeof r.prose === "boolean" && Array.isArray(r.hashes) && r.hashes.length === r.covers.length && Number.isFinite(r.tokens)),
    JSON.stringify(storedG?.map?.((r) => ({ prose: r.prose, hashes: r.hashes?.length, tokens: r.tokens }))),
  );
  t.resetSessions();
}

// ================================== 5. the two turn guards stay independent
// The voluntary ring is inert in a short session; the mandatory live-turn guard
// is not. Collapsing them either way breaks one of the two.
{
  const userText = { role: "user", content: [{ type: "text", text: "go" }] };
  const toolOnly = (id) => ({ role: "user", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value: "A".repeat(500) } }] });

  ok("a ring wider than the session protects nothing", t.protectedFromIndex([userText, { role: "tool" }], 1) === -1);
  ok("a ring inside a longer session protects its last N", t.protectedFromIndex([userText, userText, userText], 2) === 1);
  ok("the live turn is the newest real user turn", t.liveTurnIndex([userText, userText, { role: "tool" }]) === 1);
  ok("a single user turn is still the live turn", t.liveTurnIndex([userText, { role: "tool" }]) === 0);
  ok("a user message carrying only tool results is not a turn", t.liveTurnIndex([toolOnly("x1"), toolOnly("x2")]) === -1);

  // The C2 invariant itself: one user turn, every ring disabled, nothing stubbed.
  const tools = [];
  const { hooks } = await boot(tools, { notify: "off", keepRecent: 0, keepRecentTurns: 0, turnProtection: false, minChars: 10, keepHeadChars: 10, minReplanTokens: 0, autoSummarize: false });
  const msgs = [
    { role: "user", content: [{ type: "text", text: "single user turn" }] },
    ...[0, 1, 2, 3].map((i) => ({ role: "tool", content: [{ type: "tool-result", id: `x${i}`, name: "read", result: { type: "text", value: `LIVE-${i} ` + "z".repeat(4000) } }] })),
  ];
  await hooks.context(ctxEvent("ses_c2", msgs));
  const stillLive = msgs.flatMap((m) => m.content ?? []).filter((p) => p.type === "tool-result").every((p) => String(p.result.value).startsWith("LIVE-"));
  ok("C2: with one user message the whole live turn is never stubbed", stillLive);
  t.resetSessions();
}

rmSync(HOME, { recursive: true, force: true });
console.log(`verify-cp-regress: ${passed} checks passed`);
process.exit(process.exitCode ?? 0);