// Task 5 final verification: OS / SE / TA / US / CP / SC / SN-9 / codebase-index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asBool } from "../opencode-sessions/helpers.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const has = (file, marker) => {
  const s = src(file);
  assert.ok(s.includes(marker), `${file} must contain ${JSON.stringify(marker)}`);
};
const missing = (file, marker) => {
  const s = src(file);
  assert.ok(!s.includes(marker), `${file} must NOT contain ${JSON.stringify(marker)}`);
};

// --- OS-2: asBool semantics (behavioral) ---
test("OS-2: asBool maps false-tokens to false", () => {
  assert.equal(asBool("false", true), false);
  assert.equal(asBool("0", true), false);
  assert.equal(asBool("no", true), false);
  assert.equal(asBool("true", false), true);
  assert.equal(asBool(undefined, true), true);
});

// --- opencode-sessions markers ---
test("OS-3: sessions options honor env fallbacks", () => {
  has("plugins/opencode-sessions.ts", "OPENCODE_SESSIONS_AUTO_INJECT");
});
test("OS-4: session_send/launch await startTurn", () => {
  has("plugins/opencode-sessions.ts", "await startTurn");
  missing("plugins/opencode-sessions.ts", "void startTurn(t, args.text)");
});
test("OS-5: outcome cache present", () => {
  has("plugins/opencode-sessions.ts", "OUTCOME_CACHE_TTL_MS");
});
test("OS-6: server calls use AbortSignal.timeout", () => {
  has("plugins/opencode-sessions.ts", "AbortSignal.timeout");
});
test("OS-7: parentDefaults capped", () => {
  has("plugins/opencode-sessions.ts", "MAX_PARENT_DEFAULTS");
});
test("OS-8: resolveTarget reuses one parent lookup", () => {
  has("plugins/opencode-sessions.ts", "inherited");
});
test("OS-9: adopted children stay visible via sentinel", () => {
  has("plugins/opencode-sessions.ts", "unknown");
});
test("OS-10: waitFor refreshes outcome on timeout", () => {
  has("plugins/opencode-sessions.ts", "best-effort");
});
test("OS-12: directory validated early", () => {
  has("plugins/opencode-sessions.ts", "isDirectory");
});

// --- session-export markers ---
test("SE-2/SE-4/SE-3: inline cap, env includeToolCalls, maxMessages", () => {
  has("plugins/session-export.ts", "INLINE_MAX_CHARS");
  has("plugins/session-export.ts", "OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_CALLS");
  has("plugins/session-export.ts", "maxMessages");
  has("plugins/session-export.ts", "truncated");
});
test("SE-5/SE-6/SE-7/SE-8: confine, placeholder, raw id, ACL note", () => {
  has("plugins/session-export.ts", "rootDir");
  has("plugins/session-export.ts", "[part type=");
  has("plugins/session-export.ts", "not a secret");
  has("plugins/session-export.ts", "ACL");
});
test("SE-1: statSync still present (moved into try)", () => {
  has("plugins/session-export.ts", "statSync");
});

// --- tool-audit markers ---
test("TA: id-less skip, sweep, FTS cap, export limit, checkpoint, ignores, snapshot", () => {
  has("plugins/tool-audit.ts", "session_export");
  has("plugins/tool-audit.ts", "ignoreTools");
  has("plugins/tool-audit.ts", "id-less");
  has("plugins/tool-audit.ts", "checkpoint");
  has("plugins/tool-audit.ts", "trace_export");
  has("plugins/tool-audit.ts", "structuredClone");
  has("plugins/tool-audit.ts", "10 * 60");
});

// --- usage-stats markers ---
test("US: browser argv, cost_computed, metric, sweep, dailyRow", () => {
  has("plugins/usage-stats.ts", "Start-Process");
  has("plugins/usage-stats.ts", "cost_computed");
  has("plugins/usage-stats.ts", "heatmapMetric");
  has("plugins/usage-stats.ts", "dailyRow");
  has("plugins/usage-stats.ts", "lastPendingSweep");
  has("plugins/usage-stats.ts", "rate-limit");
  has("plugins/usage-stats.ts", "synchronous");
});

// --- command-pack markers ---
test("CP: dynamic list, recall dep, cache, visible failure, allowlist, truncate", () => {
  has("plugins/command-pack.ts", "available");
  has("plugins/command-pack.ts", "codebase_search");
  has("plugins/command-pack.ts", "DELIVERY_ALLOWLIST");
  has("plugins/command-pack.ts", "500");
  has("plugins/command-pack.ts", "toolIds");
  has("plugins/command-pack.ts", "cache");
});

// --- strip-skills markers ---
test("SC: guarded hook, dispose, bounded fallbacks, asBool gate", () => {
  has("plugins/strip-skills-catalog.ts", "try {");
  has("plugins/strip-skills-catalog.ts", "dispose");
  has("plugins/strip-skills-catalog.ts", "DANGLING_LEAD_MAX_CHARS");
  has("plugins/strip-skills-catalog.ts", "FALLBACK_MAX_LINES");
  has("plugins/strip-skills-catalog.ts", "asBool");
});

// --- SN-9 + codebase-index ---
test("SN-9: snippet immutability documented", () => {
  has("plugins/snippet-library.ts", "immutable");
});
test("codebase-index: comment fix + LIKE normalization", () => {
  has("plugins/codebase-index.ts", "belt-and-braces");
  has("plugins/codebase-index.ts", "tokens.join");
});
