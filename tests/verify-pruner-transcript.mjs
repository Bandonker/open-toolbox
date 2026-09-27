// CP-15: the context hook rewrites messages in place (host contract), but it
// must never mutate the stored message objects. Without a request-local clone
// the host re-serialises `event.messages` after the hook and a folded assistant
// reply persists to the transcript as a bare "[context-pruner] folded into
// summary" pointer (observed in session ses_f290706ddffec2II).
// Run: node tests/verify-pruner-transcript.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Sandbox HOME first: the plugin resolves config under homedir() at import time
// and setup() watchFile()s any config it finds.
const sandbox = join(tmpdir(), "pruner-transcript-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const modNs = await import("../plugins/context-pruner.ts");
const t = modNs.__test__ ?? modDefault?.__test__;
const dir = mkdtempSync(join(tmpdir(), "pruner-transcript-"));

// cloneForRequest: nested arrays/objects are copied, mutating the copy leaves
// the source untouched, and the clone is not the same reference.
{
  const src = { role: "assistant", content: [{ type: "text", text: "hello" }], meta: { n: 1 } };
  const copy = t.cloneForRequest(src);
  assert.notEqual(copy, src, "clone must be a new object");
  assert.notEqual(copy.content, src.content, "nested array must be copied");
  assert.notEqual(copy.content[0], src.content[0], "nested part must be copied");
  copy.content[0].text = "changed";
  copy.meta.n = 2;
  assert.equal(src.content[0].text, "hello", "mutating the clone must not touch the source text");
  assert.equal(src.meta.n, 1, "mutating the clone must not touch nested metadata");
}

// Drive the real context hook and assert the pre-existing message objects are
// left byte-for-byte intact even though the compiled request is rewritten.
{
  t.resetSessions();
  const hooks = {};
  const ctx = {
    options: {
      keepRecent: 0,
      keepRecentText: 0,
      keepRecentTurns: 0,
      minChars: 10,
      keepHeadChars: 10,
      minReplanTokens: 0,
      purgeErrors: false,
      dedupe: false,
      superseded: false,
      autoSummarize: false,
      notify: "off",
    },
    location: { directory: dir },
    tool: {
      transform: async (cb) => {
        cb({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async () => ({}),
    },
    model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
  };
  const cleanup = await modDefault.setup(ctx);

  const big = "P".repeat(20000);
  const messages = [
    { role: "assistant", content: [{ type: "text", text: big }] },
    { role: "tool", content: [{ type: "tool-result", id: "r1", name: "read", result: { type: "text", value: big } }] },
    { role: "tool", content: [{ type: "tool-result", id: "r2", name: "read", result: { type: "text", value: big } }] },
  ];
  // Snapshot the objects as the host holds them before the hook runs.
  const refs = messages.slice();
  const before = refs.map((m) => structuredClone(m));

  hooks.context({
    messages,
    system: [],
    tools: {},
    sessionID: "ses_transcript_leak",
    model: { providerID: "p", modelID: "m" },
    agent: "build",
  });
  await new Promise((r) => setTimeout(r, 20));

  // The compiled request (the array the host reads) was rewritten...
  const wire = JSON.stringify(messages);
  assert.ok(
    wire.includes("[context-pruner]"),
    `expected the request to be rewritten, got: ${wire.slice(0, 120)}`,
  );
  // ...but the stored message objects the host serialises to disk did not move.
  for (let i = 0; i < refs.length; i++) {
    assert.deepEqual(
      structuredClone(refs[i]),
      before[i],
      `stored message ${i} was mutated by the context hook — it would leak to the transcript`,
    );
  }

  t.resetSessions();
  await cleanup();
}

// CP-24: the per-request deep copy has a measured cost, and it is small.
//
// Measured against the real hook (medians, fresh messages per request, Node 24):
//   150 msgs / 0.34 MB -> 0.081 ms   600 msgs / 1.36 MB -> 0.335 ms
//  1500 msgs / 3.41 MB -> 0.853 ms   while the whole context hook costs
//  14-95 ms on those same sessions, i.e. the clone is <=1% of the request. A
//  targeted copy-on-write measured 5.8-8.6x cheaper, but that would trade a
//  0.7 ms saving on a ~90 ms hook for a rewrite that has to enumerate every
//  mutation site to stay transcript-safe. Not worth it: this stays the simple
//  structural copy, and the budget below is what actually keeps it honest --
// it fails if a future change makes the copy super-linear in payload size.
{
  class HostPayload {
    constructor() {
      this.blob = "z".repeat(1000);
    }
  }
  const inst = new HostPayload();
  const withInstance = { role: "tool", content: [{ type: "tool-result", id: "i", name: "read", result: inst }] };
  const copied = t.cloneForRequest(withInstance);
  assert.equal(
    copied.content[0].result,
    inst,
    "CP-24: a non-plain object must be shared by reference (that is what keeps the copy off host-owned payloads)",
  );

  // A long session: 500 tool calls, 6000 chars of output each.
  const long = [];
  for (let i = 0; i < 500; i++) {
    const id = `call_${i}`;
    long.push({ id: `a${i}`, role: "assistant", content: [{ type: "tool-call", id, name: "read", input: { filePath: `src/f${i}.ts` } }] });
    long.push({
      id: `t${i}`,
      role: "tool",
      content: [{ type: "tool-result", id, name: "read", result: { type: "text", value: "X".repeat(6000), metadata: { lines: 6000 } } }],
    });
  }
  const bytes = JSON.stringify(long).length;
  let sink = 0;
  const times = [];
  for (let trial = 0; trial < 5; trial++) {
    const t0 = performance.now();
    for (let i = 0; i < long.length; i++) long[i] = t.cloneForRequest(long[i]);
    const ms = performance.now() - t0;
    sink += long[0].content.length;
    if (trial > 0) times.push(ms); // drop the first, JIT-warm trial
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const mb = bytes / 1e6;
  // 20 ms/MB is ~80x the measured 0.25 ms/MB: loose enough not to flake on a
  // loaded machine, tight enough to catch a super-linear or unbounded copy.
  assert.ok(
    median < 20 * mb,
    `CP-24: cloneForRequest cost ${median.toFixed(3)} ms for ${mb.toFixed(2)} MB is over the 20 ms/MB budget (${(median / mb).toFixed(1)} ms/MB)`,
  );
  assert.ok(sink > 0, "sink keeps the measured work from being optimised away");
  console.log(`  (CP-24: ${long.length} msgs / ${mb.toFixed(2)} MB cloned in ${median.toFixed(3)} ms = ${(median / mb).toFixed(2)} ms/MB)`);
}

console.log("verify-pruner-transcript: all assertions passed");
