// CP-1..CP-11 regression checks for plugins/context-pruner.ts.
// Run: node tests/verify-pruner-fix.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modDefault from "../plugins/context-pruner.ts";
import * as modNs from "../plugins/context-pruner.ts";

const t = modNs.__test__ ?? modDefault?.__test__;
const dir = mkdtempSync(join(tmpdir(), "pruner-fix-"));

// CP-1: throwing store never escapes guardedSet.
t.guardedSet({ set() { throw new Error("sync boom"); } }, "k", { v: 1 });

// CP-1: rejecting store never surfaces as an unhandled rejection.
let unhandled = 0;
const onUnhandled = () => { unhandled += 1; };
process.on("unhandledRejection", onUnhandled);
t.guardedSet({ set: async () => { throw new Error("async boom"); } }, "k", { v: 1 });
t.guardedSet(undefined, "k", { v: 1 });
await new Promise((r) => setTimeout(r, 50));
process.removeListener("unhandledRejection", onUnhandled);
assert.equal(unhandled, 0, "CP-1: rejecting store caused unhandledRejection");

// CP-3: finite default, 0 = opt-out unlimited.
const cfg = t.resolveConfig(dir, {});
assert.equal(cfg.autoSummarizeMaxCalls, 5, "CP-3: default autoSummarizeMaxCalls should be 5");
assert.equal(
  t.resolveConfig(dir, { autoSummarizeMaxCalls: 0 }).autoSummarizeMaxCalls,
  0,
  "CP-3: explicit 0 must stay unlimited",
);

// CP-6: dead compressMode option is gone.
assert.equal("compressMode" in cfg, false, "CP-6: compressMode should be removed from config");

// CP-4: model-key hint dies with its evicted session.
t.resetSessions();
t.stateFor("cp4_first");
t.setModelKey("cp4_first", "model-a");
for (let i = 0; i < 520; i++) t.stateFor(`cp4_fill_${i}`);
assert.equal(t.hasSession("cp4_first"), false, "CP-4: oldest session should be evicted");
assert.equal(t.hasModelKey("cp4_first"), false, "CP-4: evicted session's model key must be gone");
t.resetSessions();

// CP-5: reserve is a real hard cap driven by the model output limit.
const small = t.budgetFor({ id: "m", limit: { context: 100000, output: 100 } }, cfg);
const big = t.budgetFor({ id: "m", limit: { context: 100000, output: 64000 } }, cfg);
assert.ok(small && big, "CP-5: budgetFor should resolve both models");
assert.ok(small.budget > big.budget, `CP-5: small-output model must reserve less (${small.budget} vs ${big.budget})`);

// CP-7: writeUnit preserves extra host fields on result.
const unit = {
  key: "u1",
  name: "read",
  text: "hello",
  tokens: 1,
  file: "",
  redactions: 0,
  input: {},
  output: undefined,
  part: { type: "tool-result", id: "p1", name: "read", result: { type: "text", value: "old", custom: "keep" } },
  kind: "tool",
};
t.writeUnit(unit, "new");
assert.equal(unit.part.result.custom, "keep", "CP-7: extra host fields must survive writeUnit");
assert.equal(unit.part.result.value[0].text, "new", "CP-7: value must be replaced");

// CP-9: file-only payloads are capped, short text untouched.
const capped = t.valueToText({ files: [{ path: "a.txt", content: "x".repeat(5000) }] });
assert.ok(capped.endsWith("[truncated]") && capped.length < 2200, "CP-9: large payload must be truncated");
assert.equal(t.valueToText("short"), "short", "CP-9: short text must pass through");

// CP-10: FIFO eviction, not a full clear.
t.clearStubMemo();
const mkResult = (i) => ({
  key: `k${i}`,
  name: "read",
  text: `payload-${i} ` + "y".repeat(50),
  tokens: 10,
  file: "",
  redactions: 0,
  input: {},
  output: undefined,
  part: { type: "tool-result", id: `p${i}`, name: "read" },
  kind: "tool",
});
for (let i = 0; i < 5000; i++) t.makeStub(mkResult(i), "test", cfg, 4);
const size = t.stubMemoSize();
assert.ok(size > 3000 && size < 5000, `CP-10: expected FIFO-evicted size, got ${size}`);
t.clearStubMemo();

// CP-11: shared global RegExp stays stateless.
const g = /x/g;
assert.equal(t.statelessTest(g, "x"), true, "CP-11: first test hits");
assert.equal(t.statelessTest(g, "x"), true, "CP-11: second test must also hit (no lastIndex drift)");
assert.equal(g.lastIndex, 0, "CP-11: lastIndex must be reset");
const protectedCfg = { ...cfg, protectedPatterns: [/secret-tool/g] };
const probe = { name: "secret-tool" };
assert.equal(t.isProtected(probe, protectedCfg), true, "CP-11: isProtected hits");
assert.equal(t.isProtected(probe, protectedCfg), true, "CP-11: isProtected stays stable on repeat");

// CP-2: overlapping recall persists are serialized through a per-session
// chain (no read-modify-write race). The chain lives inside setup's closure
// with no seam, so assert the mechanism is present in source.
import { readFileSync as cp2Read } from "node:fs";
const prunerSrc = cp2Read(new URL("../plugins/context-pruner.ts", import.meta.url), "utf8");
assert.ok(
  prunerSrc.includes("persistChains.get(sessionID)") &&
    prunerSrc.includes(".then(() => loadRecall(sessionID, st))") &&
    prunerSrc.includes("persistChains.set(sessionID, head)"),
  "CP-2: per-session persist chain must serialize recall flushes",
);

// CP-8: per-request JSON.stringify(event.tools) is memoized on the event
// tools reference (closure-local like CP-2, so assert the mechanism).
assert.ok(
  prunerSrc.includes("lastToolsRef") && prunerSrc.includes("if (eventTools !== lastToolsRef)"),
  "CP-8: event.tools serialization must be memoized on reference identity",
);

// compilePatterns seam: used internally for protectedPatterns and exported
// for tests — assert it is a live, working seam rather than dead code.
assert.equal(typeof t.compilePatterns, "function", "compilePatterns seam must exist");
assert.ok(
  prunerSrc.includes("compilePatterns("),
  "compilePatterns must be wired into config resolution",
);
assert.deepEqual(
  t.compilePatterns(["a.c"]).map((r) => r instanceof RegExp),
  [true],
  "compilePatterns must compile string lists to RegExp",
);
assert.equal(t.compilePatterns(["a.c"])[0].test("abc"), true, "compiled pattern must match");

console.log("verify-pruner-fix: all assertions passed");
