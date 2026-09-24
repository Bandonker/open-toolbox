// Hybrid-design checks: collapseStubs default, throttled inline receipts
// with per-session saved total + summary topic.
// Run: node tests/verify-pruner-receipts.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME first: the plugin resolves its config under homedir() at
// import time, and setup() watchFile()s any config file it finds (an open
// watcher keeps the process alive). verify-plugins.mjs does the same.
const sandbox = join(tmpdir(), "pruner-receipts-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const modNs = await import("../plugins/context-pruner.ts");

const t = modNs.__test__ ?? modDefault?.__test__;
const dir = mkdtempSync(join(tmpdir(), "pruner-receipts-"));

// New-option defaults and parsing.
const cfg = t.resolveConfig(dir, {});
assert.equal(cfg.collapseStubs, true, "collapseStubs should default to true");
assert.equal(cfg.notifyMinTokens, 500, "notifyMinTokens should default to 500");
assert.equal(cfg.notifyOnTopic, true, "notifyOnTopic should default to true");
assert.equal(
  t.resolveConfig(dir, { notifyMinTokens: 0 }).notifyMinTokens,
  0,
  "explicit 0 must stay (every prune reports)",
);
assert.equal(
  t.resolveConfig(dir, { notifyOnTopic: false }).notifyOnTopic,
  false,
  "explicit false must stay",
);

// latestTopic seam: newest summary wins, empty when none.
assert.equal(typeof t.latestTopic, "function", "latestTopic seam must exist");
assert.equal(t.latestTopic({ summaries: new Map() }), "", "no summaries -> empty topic");
assert.equal(
  t.latestTopic({
    summaries: new Map([
      ["a", { topic: "old", at: 1 }],
      ["b", { topic: "auth refactor", at: 2 }],
    ]),
  }),
  "auth refactor",
  "newest summary topic wins",
);

// Drive the real context hook with a stub session and capture receipts.
const cleanups = [];
function stubCtx(extra = {}) {
  return {
    options: {},
    location: { directory: dir },
    tool: {
      transform: async (cb) => {
        cb({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    ...extra,
  };
}

async function drive(sessionID, options) {
  t.resetSessions();
  const notes = [];
  const hooks = {};
  const ctx = stubCtx({
    options,
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async (input) => {
        notes.push(input);
        return {};
      },
    },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
  });
  cleanups.push(await modDefault.setup(ctx));
  const big = "A".repeat(20000);
  const messages = [1, 2].map((n) => ({
    role: "tool",
    content: [{ type: "tool-result", id: `r${n}`, name: "read", result: { type: "text", value: big } }],
  }));
  hooks.context({
    messages,
    system: [],
    tools: {},
    sessionID,
    model: { providerID: "p", modelID: "m" },
    agent: "build",
  });
  await new Promise((r) => setTimeout(r, 20));
  return notes;
}

const base = {
  keepRecent: 0,
  keepRecentTurns: 0,
  minChars: 10,
  keepHeadChars: 10,
  notify: "minimal",
  notifyType: "chat",
  minReplanTokens: 0,
  purgeErrors: false,
  dedupe: false,
  superseded: false,
  autoSummarize: false,
};

// A big prune far above the floor reports with the session total.
const loud = await drive("ses_receipt_loud", base);
assert.ok(loud.length >= 1, `expected a receipt for a large prune, got ${loud.length}`);
assert.ok(
  loud[0].text.includes("session total"),
  `receipt must carry the session total: ${loud[0].text}`,
);
assert.ok(
  loud[0].text.startsWith("[context-pruner]"),
  `receipt keeps the plugin prefix: ${loud[0].text}`,
);

// Below an extreme floor the same prune stays quiet.
const quiet = await drive("ses_receipt_quiet", { ...base, notifyMinTokens: 10_000_000 });
assert.equal(quiet.length, 0, `expected no receipt below the floor, got ${quiet.length}`);

t.resetSessions();
for (const cleanup of cleanups) await cleanup();
console.log("verify-pruner-receipts: all assertions passed");
