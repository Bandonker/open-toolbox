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

// Single-digest receipts: one turn emits at most one receipt line, and
// async/manual summary notes ride the next turn's digest.
{
  t.resetSessions();
  const notes = [];
  const hooks = {};
  const toolDefs = {};
  const ctx = stubCtx({
    options: {
      ...base,
      notify: "minimal",
      notifyMinTokens: 0,
      autoSummarize: true,
      autoSummarizeMinTokens: 100,
      nudgeEnabled: false,
    },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async (input) => {
        notes.push(input);
        return {};
      },
      generate: async () => ({ text: "DIGEST-SUMMARY" }),
    },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    tool: {
      transform: async (cb) => {
        cb({ add: (def) => { toolDefs[def.name] = def; } });
        return { dispose: async () => {} };
      },
    },
  });
  cleanups.push(await modDefault.setup(ctx));
  const bigDigest = "B".repeat(20000);
  const makeDigestMsgs = () => [1, 2].map((n) => ({
    role: "tool",
    content: [{ type: "tool-result", id: `g${n}`, name: "read", result: { type: "text", value: bigDigest } }],
  }));
  const digestInput = (sessionID) => ({
    messages: makeDigestMsgs(), system: [], tools: {}, sessionID,
    model: { providerID: "p", modelID: "m" }, agent: "build",
  });
  const settle = () => new Promise((r) => setTimeout(r, 100));

  // Auto-summarise completes after the turn flushed: still one receipt.
  hooks.context(digestInput("ses_digest"));
  await settle();
  assert.equal(notes.length, 1, `one turn emits one receipt, got ${notes.length}`);
  assert.ok(notes[0].text.startsWith("[context-pruner]"), "digest keeps the plugin prefix");
  assert.ok(notes[0].text.includes("session total"), "digest keeps the session total");

  // The banked auto-summarise note surfaces on the next turn's digest.
  hooks.context(digestInput("ses_digest"));
  await settle();
  assert.equal(notes.length, 2, `next turn emits one digest, got ${notes.length}`);
  assert.ok(notes[1].text.includes("auto-summarised"), "digest carries the banked auto note");
  assert.ok(notes[1].text.includes("topic:"), "digest keeps the topic element");

  // The compress tool banks its note instead of notifying on its own.
  const beforeCompress = notes.length;
  const compressRes = await toolDefs.compress.execute({ topic: "auth refactor", last: 2 }, { sessionID: "ses_digest" });
  assert.ok(
    /Summarised \d+ tool result/.test(compressRes.content),
    `compress summarises, got: ${compressRes.content}`,
  );
  assert.equal(notes.length, beforeCompress, "compress tool emits no receipt of its own");

  // ...and the next turn carries it in its single digest with the topic.
  hooks.context(digestInput("ses_digest"));
  await settle();
  assert.equal(notes.length, beforeCompress + 1, `compress turn emits one digest, got ${notes.length}`);
  assert.ok(notes[beforeCompress].text.includes("compress:"), "digest carries the banked compress note");
  assert.ok(
    notes[beforeCompress].text.includes("topic: auth refactor"),
    `digest names the compress topic: ${notes[beforeCompress].text}`,
  );
}

t.resetSessions();
for (const cleanup of cleanups) await cleanup();
console.log("verify-pruner-receipts: all assertions passed");
