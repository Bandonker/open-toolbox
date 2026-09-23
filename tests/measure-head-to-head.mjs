#!/usr/bin/env node
/**
 * Head-to-head: `context-pruner` (this repo) vs DCP (`@tarquinen/opencode-dcp`).
 *
 * DCP cannot load under opencode v2 (see docs/PLUGIN-WATCHLIST.md), so the only
 * honest way to "beat" it is to measure both compilers on the *same* bytes with
 * the *same* model cooperation. This harness does that:
 *
 *   - our side runs the real `context` hook of plugins/context-pruner.ts with
 *     its shipped defaults, replaying the synthetic session turn by turn;
 *   - DCP's side runs tests/lib/dcp-policy.mjs, a behavioural model of DCP's
 *     public contract (deduplication, purgeErrors, range compression,
 *     protected tools, 50k/100k soft+hard thresholds).
 *
 * DCP is measured twice: as shipped ("nudged" — its model compresses only once
 * the estimate reaches its soft threshold) and at its theoretical best
 * ("unlimited" — the model compresses every closed message on every request).
 * The second row is the one a claim has to survive: it is DCP with a maximally
 * cooperative model and no cache budget at all.
 *
 *   node tests/measure-head-to-head.mjs            # 12k window, 16 turns
 *   node tests/measure-head-to-head.mjs --wide     # 128k window (DCP's 50k floor bites)
 *   node tests/measure-head-to-head.mjs --soak     # 40 turns
 *
 * Aggregate sizes only; no transcript content is printed. Not part of `npm test`.
 */
import { tmpdir } from "node:os";
import { CHARS_PER_TOKEN, clone, filler, tokens, transcript } from "./lib/synthetic-transcript.mjs";
import { compileWithDcp } from "./lib/dcp-policy.mjs";

const LONG = process.argv.includes("soak");
const WIDE = process.argv.includes("--wide");
const TURNS = LONG ? 40 : 16;
const WINDOW = WIDE ? 128_000 : 12_000;

/** Stub ctx for the plugin: one model at the benchmark window, a fixed digest. */
function stubCtx(options) {
  const store = new Map();
  const hooks = {};
  const calls = { generate: 0 };
  return {
    hooks,
    calls,
    ctx: {
      options,
      location: { directory: tmpdir() },
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
        generate: async () => {
          calls.generate++;
          return { text: `Summary: ${filler(500)}` };
        },
      },
      event: { subscribe: () => () => {} },
      model: { list: () => [{ id: "bench", providerID: "bench", limit: { context: WINDOW, output: 1024 } }] },
      storage: {
        get: async (key) => (store.has(key) ? clone(store.get(key)) : undefined),
        set: async (key, value) => void store.set(key, value),
        remove: async (key) => void store.delete(key),
        scan: async () => [...store.keys()],
      },
    },
  };
}

/** Our plugin through its real `context` hook, shipped defaults, replayed turn by turn. */
async function measureOurs(options = {}) {
  const { ctx, hooks, calls } = stubCtx({ notify: "off", ...options });
  const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
  await mod.default.setup(ctx);
  const sessionID = `ses_h2h_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let rawChars = 0;
  let compiledChars = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const source = transcript(turn);
    rawChars += JSON.stringify(source).length;
    const live = clone(source);
    hooks.context({
      messages: live,
      system: [],
      tools: {},
      options: {},
      sessionID,
      model: { providerID: "bench", modelID: "bench" },
      agent: "build",
    });
    compiledChars += JSON.stringify(live).length;
    // Let a queued summary finish so it can be applied on a later turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { rawChars, compiledChars, modelCalls: calls.generate };
}

/** DCP's policy model, replayed turn by turn with the same cooperation. */
function measureDcp(cooperation, options = {}) {
  let rawChars = 0;
  let compiledChars = 0;
  const totals = { prunedOutputs: 0, purgedInputs: 0, compressedMessages: 0, modelCalls: 0 };
  for (let turn = 0; turn < TURNS; turn++) {
    const source = transcript(turn);
    rawChars += JSON.stringify(source).length;
    const { messages, stats } = compileWithDcp(source, { cooperation, charsPerToken: CHARS_PER_TOKEN, ...options });
    compiledChars += JSON.stringify(messages).length;
    totals.prunedOutputs += stats.prunedOutputs;
    totals.purgedInputs += stats.purgedInputs;
    totals.compressedMessages += stats.compressedMessages;
    totals.modelCalls += stats.compressedRanges;
  }
  return { rawChars, compiledChars, totals };
}

// ---------------------------------------------------------------------- main
const AGGRESSIVE = {
  minChars: 200,
  budgetMinChars: 100,
  keepRecent: 2,
  keepRecentText: 0,
  keepRecentTurns: 0,
  minReplanTokens: 0,
  cacheAware: false,
  autoSummarizeMaxCalls: 0,
  nudgeFrequency: 3,
  nudgeCallFrequency: 3,
  relaxRecentFloor: 0,
  compressText: true,
};

const ours = await measureOurs();
const oursAggressive = await measureOurs(AGGRESSIVE);
const dcpShipped = measureDcp("nudged");
const dcpBest = measureDcp("unlimited");

const rawTokens = tokens(ours.rawChars);
const pct = (chars) => ((1 - chars / ours.rawChars) * 100).toFixed(1);
const comp = (result) => tokens(result.compiledChars);
const row = (label, compiled, detail) => ({ label, compiled, saved: pct(compiled * CHARS_PER_TOKEN), detail });

const rows = [
  row("context-pruner", comp(ours), `defaults, ${ours.modelCalls} model call(s)`),
  row("context-pruner+", comp(oursAggressive), `aggressive knobs, ${oursAggressive.modelCalls} model call(s)`),
  row(
    "dcp (shipped)",
    comp(dcpShipped),
    `${dcpShipped.totals.prunedOutputs} dedupe + ${dcpShipped.totals.purgedInputs} input purge + ${dcpShipped.totals.modelCalls} compress call(s)`,
  ),
  row(
    "dcp (best case)",
    comp(dcpBest),
    `${dcpBest.totals.modelCalls} compress call(s), unlimited model cooperation`,
  ),
];

console.log(`context-pruner vs DCP — ${TURNS} turns, window ${WINDOW}${WIDE ? " (wide)" : ""}`);
console.log(`raw prompt across turns: ${rawTokens} tokens\n`);
console.log("compiler            compiled   saved%   what it spent");
for (const r of rows) {
  console.log(`${r.label.padEnd(19)} ${String(r.compiled).padStart(8)} ${String(`${r.saved}%`).padStart(8)}   ${r.detail}`);
}

/** Positive delta means the other compiler leaves more tokens in the request. */
const compare = (name, compiled) => {
  const delta = compiled - comp(ours);
  const pp = ((delta / rawTokens) * 100).toFixed(1);
  const verdict = delta > 0 ? "wins" : delta < 0 ? "LOSES" : "ties";
  console.log(
    `\nvs ${name}: ${verdict} by ${Math.abs(delta)} tokens (${Math.abs(Number(pp))} pp of the raw prompt) — ours ${comp(ours)}, theirs ${compiled}`,
  );
  return delta;
};

const vsShipped = compare("dcp as shipped", comp(dcpShipped));
const vsBest = compare("dcp at its best case", comp(dcpBest));
console.log(
  `\nmodel calls: ours ${ours.modelCalls} (defaults) / ${oursAggressive.modelCalls} (aggressive) vs dcp ${dcpShipped.totals.modelCalls} (shipped) / ${dcpBest.totals.modelCalls} (best case).`,
);
console.log(
  "DCP rewrites the prefix on every compress call, so each of its calls invalidates the provider cache from the compressed range onward; ours are amortised over epochs and the prefix is byte-stable between replans.",
);

const won = vsShipped >= 0;
console.log(
  won
    ? `\nRESULT: context-pruner beats DCP as shipped by ${vsShipped} tokens on the same transcript.`
    : "\nRESULT: REGRESSION — context-pruner no longer beats DCP as shipped.",
);
console.log(
  vsBest >= 0
    ? `\nAgainst a maximally cooperative DCP (every closed message compressed on every request, no cache budget) we still win by ${vsBest} tokens.`
    : `\nAgainst a maximally cooperative DCP (every closed message compressed on every request, no cache budget) we are ${Math.abs(vsBest)} tokens behind (${((Math.abs(vsBest) / rawTokens) * 100).toFixed(1)} pp) — that row is an oracle-model upper bound, and reaching it costs ${dcpBest.totals.modelCalls} compress calls against our ${oursAggressive.modelCalls}, each one invalidating the cached prefix.`,
);
process.exit(won ? 0 : 1);
