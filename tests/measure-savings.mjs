/**
 * Phase 6 — measured token savings.
 *
 * Replays a deterministic synthetic coding session through the real
 * context-pruner `context` hook and reports, per profile, the raw prompt size
 * versus the compiled size the model would actually receive. This is the
 * data-driven counter to "DCP saves more": DCP 3.2.0 cannot load under opencode
 * v2 (see docs/PLUGIN-WATCHLIST.md), so the honest comparison is our own
 * conservative baseline against an aggressive, DCP-shaped configuration.
 *
 *   node tests/measure-savings.mjs
 *   node tests/measure-savings.mjs soak      # longer session
 *
 * Not part of `npm test`: it is a benchmark, not a correctness gate.
 */
import { tmpdir } from "node:os";
import { CHARS_PER_TOKEN, clone, filler, tokens, transcript } from "./lib/synthetic-transcript.mjs";

const LONG = process.argv.includes("soak");
const TURNS = LONG ? 40 : 16;

// ---------------------------------------------------------------- harness
function stubCtx(options) {
  const tools = [];
  const hooks = {};
  const store = new Map();
  return {
    tools,
    hooks,
    ctx: {
      options,
      location: { directory: tmpdir() },
      tool: {
        transform: async (cb) => {
          cb({ add: (t) => tools.push(t) });
          return { dispose: async () => {} };
        },
      },
      session: {
        hook: async (name, cb) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
        generate: async () => ({ text: `Summary: ${filler(500)}` }),
      },
      event: { subscribe: () => () => {} },
      model: { list: () => [{ id: "bench", providerID: "bench", limit: { context: 12000, output: 1024 } }] },
      storage: {
        get: async (key) => (store.has(key) ? clone(store.get(key)) : undefined),
        set: async (key, value) => void store.set(key, value),
        remove: async (key) => void store.delete(key),
        scan: async () => [...store.keys()],
      },
    },
  };
}

const PROFILES = {
  conservative: {},
  // Default floors, but allow the model/auto-summary to compress prose too.
  prose: { compressText: true },
  balanced: { minChars: 500, keepRecent: 4, keepRecentTurns: 1, minReplanTokens: 500, autoSummarizeMaxCalls: 8, compressText: true },
  // Steps 3-5: relax the recency ring-fence under budget pressure and let the
  // nudge fire on tool-call cadence, with prose compression on.
  relaxed: {
    compressText: true,
    minChars: 500,
    keepRecent: 4,
    keepRecentTurns: 1,
    budgetMinChars: 100,
    relaxRecentFloor: 2,
    nudgeCallFrequency: 3,
    autoSummarizeMaxCalls: 8,
  },
  aggressive: {
    minChars: 200,
    keepRecent: 2,
    keepRecentText: 0,
    keepRecentTurns: 0,
    minReplanTokens: 0,
    cacheAware: false,
    autoSummarizeMaxCalls: 0,
    nudgeFrequency: 3,
    nudgeCallFrequency: 3,
    budgetMinChars: 100,
    relaxRecentFloor: 0,
    compressText: true,
  },
  // DCP-shaped: no recency protection of tool output or prose at all.
  dcp: {
    minChars: 200,
    budgetMinChars: 100,
    keepRecent: 0,
    keepRecentText: 0,
    keepRecentTurns: 0,
    minReplanTokens: 0,
    cacheAware: false,
    autoSummarizeMaxCalls: 0,
    nudgeFrequency: 3,
    nudgeCallFrequency: 3,
    relaxRecentFloor: 0,
    compressText: true,
  },
};

async function measure(profile, options) {
  const { ctx, hooks } = stubCtx({ notify: false, ...options });
  const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
  await mod.default.setup(ctx);
  const sessionID = `ses_bench_${profile}_${Date.now()}`;

  let rawChars = 0;
  let compiledChars = 0;
  let prunedResults = 0;
  let toolChars = 0;
  let proseChars = 0;
  let ondiskCeilingChars = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const raw = transcript(turn);
    rawChars += JSON.stringify(raw).length;
    const callPartChars = new Map();
    for (const message of raw) {
      for (const part of message.content ?? []) {
        const size = JSON.stringify(part).length;
        if (part?.type === "tool-result") toolChars += size;
        else proseChars += size;
        if (part?.type === "tool-call") callPartChars.set(part.id, size);
      }
    }
    const live = clone(raw);
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
    for (const message of live) {
      for (const part of message.content ?? []) {
        const value = part?.result?.value;
        if (part?.type === "tool-result" && typeof value === "string" && value.includes("output of")) {
          prunedResults++;
          ondiskCeilingChars += JSON.stringify(part).length + (callPartChars.get(part.id) ?? 0);
        }
      }
    }
    // Let a queued summary finish so it can be applied on a later turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    profile,
    rawTokens: tokens(rawChars),
    compiledTokens: tokens(compiledChars),
    savedTokens: tokens(rawChars) - tokens(compiledChars),
    savedPct: ((1 - compiledChars / rawChars) * 100).toFixed(1),
    ondiskCeilingTokens: tokens(ondiskCeilingChars),
    ondiskCeilingPct: ((ondiskCeilingChars / compiledChars) * 100).toFixed(1),
    prunedResults,
    toolSharePct: ((toolChars / rawChars) * 100).toFixed(1),
    proseSharePct: ((proseChars / rawChars) * 100).toFixed(1),
  };
}

const rows = [];
for (const [profile, options] of Object.entries(PROFILES)) {
  rows.push(await measure(profile, options));
}

console.log(`context-pruner savings benchmark — ${TURNS} turns, ${LONG ? "soak" : "standard"}\n`);
console.log("profile        raw tok   compiled   saved    saved%   pruned");
for (const row of rows) {
  console.log(
    `${row.profile.padEnd(14)} ${String(row.rawTokens).padStart(7)} ${String(row.compiledTokens).padStart(10)} ` +
      `${String(row.savedTokens).padStart(7)} ${String(`${row.savedPct}%`).padStart(8)} ${String(row.prunedResults).padStart(7)}`,
  );
}

const base = rows.find((r) => r.profile === "conservative");
const prose = rows.find((r) => r.profile === "prose");
const relaxed = rows.find((r) => r.profile === "relaxed");
const best = rows.reduce((a, b) => (b.savedTokens > a.savedTokens ? b : a));
console.log(
  `\nconservative vs ${best.profile}: +${best.savedTokens - base.savedTokens} tokens removed ` +
    `(${(best.savedPct - base.savedPct).toFixed(1)} percentage points).`,
);
if (prose) {
  console.log(
    `prose compression alone: +${prose.savedTokens - base.savedTokens} tokens removed ` +
      `(${(prose.savedPct - base.savedPct).toFixed(1)} pp) with every other default unchanged.`,
  );
}
if (relaxed && prose) {
  console.log(
    `recency relaxation + nudge cadence on top of prose: +${relaxed.savedTokens - prose.savedTokens} tokens ` +
      `(${(relaxed.savedPct - prose.savedPct).toFixed(1)} pp).`,
  );
}
console.log(
  `raw mix: tool output is ${base.toolSharePct}% of the raw prompt (auto-pruned), ` +
    `user/assistant prose is ${base.proseSharePct}% (compressed only when compressText is on).`,
);
const dcpRow = rows.find((r) => r.profile === "dcp") ?? best;
console.log(
  `on-disk ceiling: every pruned payload is already absent from the outgoing request; deleting each pruned pair ` +
    `on disk instead (its stub + tool-call) could remove at most ${dcpRow.ondiskCeilingTokens} more tokens ` +
    `(${dcpRow.ondiskCeilingPct}% of the compiled prompt).`,
);

// Config hot-reload leaves a watchFile open; the benchmark is done, exit cleanly.
process.exit(0);
