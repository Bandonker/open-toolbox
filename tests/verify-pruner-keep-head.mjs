// Verifies keepHeadChars: default 200, option/env overrides, and that pruned
// stubs keep a head of the configured length (token-savings lever: shorter
// stub heads shrink every stubbed tool result in closed turns).
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = mkdtempSync(join(tmpdir(), "pruner-keephead-home-"));
const WORK = mkdtempSync(join(tmpdir(), "pruner-keephead-work-"));

let plugin;
let resolveConfig;

function stubCtx(options = {}, model = { providerID: "t", modelID: "t", limit: { context: 2000, output: 256 } }) {
  const store = new Map();
  const hooks = {};
  const ctx = {
    options,
    location: { directory: WORK },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } },
    event: { subscribe: () => () => {} },
    model: { list: () => [model] },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      remove: async (k) => void store.delete(k),
      scan: async () => [...store.keys()],
    },
  };
  return { ctx, hooks };
}

const HEAD = "H".repeat(200);
const TAIL = "T".repeat(3800);
const BIG = `${HEAD}${TAIL}`; // 4000 chars: first 200 (head) vs the rest (must be dropped)

function toolMsgs(n = 3, prefix = "q") {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  return [
    { role: "user", content: [{ type: "text", text: "Answer concisely." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Working on it." },
        ...ids.flatMap((id, i) => [{ type: "tool-call", callID: id, name: "read", input: { path: `f${i}.ts` } }]),
      ],
    },
    ...ids.map((id, i) => ({
      role: "tool",
      content: [{ type: "tool-result", tool: "read", callID: id, result: { value: `${BIG}#${i}` } }],
    })),
  ];
}

describe("context-pruner keepHeadChars", () => {
  let savedHome;
  let savedProfile;
  let savedEnv;

  before(async () => {
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    savedEnv = process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD;
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
    delete process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD;
    plugin = await import(`file://${REPO}/plugins/context-pruner.ts`);
    resolveConfig = plugin.__test__.resolveConfig;
  });

  after(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    if (savedEnv === undefined) delete process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD;
    else process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD = savedEnv;
  });

  it("defaults to 200 and honors option/env overrides", () => {
    assert.equal(resolveConfig(WORK, {}).keepHeadChars, 200);
    assert.equal(resolveConfig(WORK, { keepHeadChars: 100 }).keepHeadChars, 100);
    process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD = "350";
    assert.equal(resolveConfig(WORK, {}).keepHeadChars, 350);
    process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD = "not-a-number";
    assert.equal(resolveConfig(WORK, {}).keepHeadChars, 200);
    delete process.env.OPENCODE_CONTEXT_PRUNER_KEEP_HEAD;
  });

  it("stub keeps a 200-char head by default", async () => {
    const { ctx, hooks } = stubCtx({ notify: "off", keepRecent: 0, keepRecentTurns: 0, minChars: 200 });
    await plugin.default.setup(ctx);
    const live = toolMsgs(3, "kh");
    hooks.context({
      messages: live, system: [], tools: {}, options: {},
      sessionID: `ses_keephead_${Date.now()}`, model: { providerID: "t", modelID: "t" }, agent: "build",
    });
    const texts = live.flatMap((m) => m.content ?? [])
      .filter((p) => p.type === "tool-result")
      .map((p) => (typeof p.result?.value === "string" ? p.result.value : JSON.stringify(p.result?.value ?? "")));
    const stubs = texts.filter((t) => t.includes("pruned ("));
    assert.ok(stubs.length > 0, "expected at least one pruned stub");
    for (const stub of stubs) {
      assert.ok(stub.includes(HEAD), "stub keeps the 200-char head");
      assert.ok(!stub.includes(TAIL.slice(0, 200)), "stub drops chars past the 200-char head");
    }
    const cleanup = plugin.__test__.resetSessions?.();
    if (typeof cleanup?.then === "function") await cleanup;
  });
});
