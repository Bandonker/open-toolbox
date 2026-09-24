// Per-topic savings ledger: context_report shows a topic -> summaries/units/
// tokens-saved table rolled up from tracked summary records (display-only,
// no model calls, pruning decisions unchanged).
// Run: node tests/verify-pruner-ledger.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME first: the plugin resolves its config under homedir() at
// import time, and setup() watchFile()s any config file it finds (an open
// watcher keeps the process alive). verify-plugins.mjs does the same.
const sandbox = join(tmpdir(), "pruner-ledger-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const modNs = await import("../plugins/context-pruner.ts");

const t = modNs.__test__ ?? modDefault?.__test__;
assert.equal(typeof t.topicLedger, "function", "topicLedger seam must exist");
const dir = mkdtempSync(join(tmpdir(), "pruner-ledger-"));
const cfg = t.resolveConfig(dir, {});

const tools = {};
const ctx = {
  options: {},
  location: { directory: dir },
  tool: {
    transform: async (cb) => {
      cb({ add: (tool) => { tools[tool.name] = tool; } });
      return { dispose: async () => {} };
    },
  },
  session: { hook: async () => ({ dispose: async () => {} }) },
};
const cleanup = await modDefault.setup(ctx);

async function report(sessionID) {
  return tools.context_report.execute({ sessionID }, { sessionID });
}

// A session with no summaries shows no ledger section.
t.resetSessions();
t.stateFor("ses_ledger_empty");
const empty = await report("ses_ledger_empty");
assert.ok(!empty.content.includes("savings by topic"), "empty session must not show a ledger section");

// Seed tracked state: two topics, one untitled (falls back to "(general)").
t.resetSessions();
const st = t.stateFor("ses_ledger");
st.ratio = 1;
st.compressible = [
  { key: "a", tokens: 1000 },
  { key: "b", tokens: 800 },
  { key: "c", tokens: 500 },
];
st.summaries = new Map([
  { first: "a", covers: ["a", "b"], hashes: [], text: "x".repeat(360), tokens: 100, topic: "auth", at: 1, prose: false },
  { first: "c", covers: ["c"], hashes: [], text: "y".repeat(360), tokens: 100, topic: "", at: 2, prose: false },
].map((r) => [r.first, r]));

const rows = t.topicLedger(st, cfg);
assert.equal(rows.length, 2, `expected 2 ledger rows, got ${rows.length}`);
assert.deepEqual(
  rows.map((r) => [r.topic, r.summaries, r.units, r.saved]),
  [["auth", 1, 2, 1700], ["(general)", 1, 1, 400]],
  "ledger must roll up summaries, covered units and present-tense savings per topic",
);

const out = await report("ses_ledger");
assert.ok(out.content.includes("savings by topic:"), "report must include the ledger section");
assert.ok(
  out.content.includes("· auth — 1 summaries, 2 units, ~1700 tokens saved"),
  `report must show the auth row: ${out.content}`,
);
assert.ok(
  out.content.includes("· (general) — 1 summaries, 1 units, ~400 tokens saved"),
  `report must show the untitled row: ${out.content}`,
);
// Display-only: the report must not touch pruning decisions.
assert.equal(st.decisions.size, 0, "report must leave prune decisions unchanged");

t.resetSessions();
await cleanup();
console.log("verify-pruner-ledger: all assertions passed");
