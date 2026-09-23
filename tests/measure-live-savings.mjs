#!/usr/bin/env node
/**
 * Phase 6 (real data) — replay a captured live transcript through the real
 * context-pruner `context` hook and report token and dollar savings.
 *
 * Unlike tests/measure-savings.mjs (a deterministic synthetic fixture), this
 * pulls an actual transcript from the running opencode server
 * (`GET /api/session/:id/message`), converts it to the shape the hook receives,
 * and compiles it once per profile. Aggregate sizes only: transcript content is
 * never printed. Deliberately NOT part of `npm test`.
 *
 *   node tests/measure-live-savings.mjs
 *   node tests/measure-live-savings.mjs --tight        # 32k window (budget pressure)
 *   LIVE_SESSION=ses_... node tests/measure-live-savings.mjs
 *
 * Env:
 *   OPENCODE_LIVE_URL        default http://127.0.0.1:49374
 *   OPENCODE_LIVE_PASSWORD   else read from ~/.config/opencode/service.json
 *   LIVE_SESSION             session to capture (else the richest transcript)
 *   LIVE_CONTEXT_LIMIT       model window for budgeting (default 128000)
 *   LIVE_INPUT_PRICE         $ per 1M input tokens (optional, no default)
 *   LIVE_CACHE_READ_PRICE    $ per 1M cache-read tokens (optional, no default)
 *
 * Exits 0 with SKIP when the server is unreachable or no transcript is found.
 */
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.env.OPENCODE_LIVE_URL ?? "http://127.0.0.1:49374").replace(/\/$/, "");
const CHARS_PER_TOKEN = 3.6;
const tight = process.argv.includes("--tight");
const contextLimit = Number(process.env.LIVE_CONTEXT_LIMIT ?? (tight ? 32000 : 128000));

function password() {
  if (process.env.OPENCODE_LIVE_PASSWORD) return process.env.OPENCODE_LIVE_PASSWORD;
  return JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8")).password;
}

const auth = "Basic " + Buffer.from(`opencode:${password()}`).toString("base64");
async function api(path) {
  const res = await fetch(base + path, { headers: { authorization: auth } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------- hook harness
const clone = (value) => JSON.parse(JSON.stringify(value));
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function stubCtx(options) {
  const hooks = {};
  const store = new Map();
  return {
    hooks,
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
        generate: async () => ({ text: "Summary: ".padEnd(500, "x") }),
      },
      event: { subscribe: () => () => {} },
      model: { list: () => [{ id: "live", providerID: "live", limit: { context: contextLimit, output: 1024 } }] },
      storage: {
        get: async (key) => (store.has(key) ? clone(store.get(key)) : undefined),
        set: async (key, value) => void store.set(key, value),
        remove: async (key) => void store.delete(key),
        scan: async () => [...store.keys()],
      },
    },
  };
}

// Mirrors tests/measure-savings.mjs so the real-data numbers are comparable.
const PROFILES = {
  conservative: {},
  prose: { compressText: true },
  balanced: { minChars: 500, keepRecent: 4, keepRecentTurns: 1, minReplanTokens: 500, autoSummarizeMaxCalls: 8, compressText: true },
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

/**
 * Convert an API transcript into the shape the `context` hook receives. The
 * real hook splits each session tool part into an assistant `tool-call` (which
 * carries `state.input`) and a `tool`-role `tool-result` (which never carries
 * `input`), so mirror that. Reasoning parts are dropped: the plugin never
 * touches them and providers do not resend them as prompt text.
 */
function toHookMessages(raw) {
  const out = [];
  for (const message of raw) {
    const type = String(message.type ?? message.role ?? "");
    const role = type === "assistant" || type === "user" ? type : message.role;
    const content = [];
    const results = [];
    for (const part of message.content ?? []) {
      if (part.type === "tool") {
        const st = part.state ?? {};
        const id = part.id ?? part.toolCallId;
        const name = part.name ?? part.tool;
        content.push({ type: "tool-call", id, name, input: st.input });
        const blocks = Array.isArray(st.content) ? st.content : [];
        const value = blocks.map((b) => (typeof b?.text === "string" ? b.text : JSON.stringify(b))).join("\n");
        results.push({
          type: "tool-result",
          id,
          name,
          result:
            st.status === "error"
              ? { type: "error", value: value || String(st.error ?? "") }
              : { type: "text", value },
        });
      } else if (part.type === "text") {
        content.push({ type: "text", id: part.id, text: part.text });
      }
    }
    if (content.length > 0) out.push({ id: message.id, role, type, content });
    if (results.length > 0) out.push({ id: `${message.id ?? "msg"}_tool`, role: "tool", type: "tool", content: results });
  }
  return out;
}

function prunableShare(messages) {
  let toolChars = 0;
  let textChars = 0;
  for (const m of messages) {
    for (const p of m.content ?? []) {
      const size = JSON.stringify(p).length;
      if (p.type === "tool-result" || p.type === "tool-call") toolChars += size;
      else textChars += size;
    }
  }
  const total = toolChars + textChars;
  return {
    toolSharePct: ((toolChars / total) * 100).toFixed(1),
    textSharePct: ((textChars / total) * 100).toFixed(1),
  };
}

async function measure(profile, options, source) {
  const { ctx, hooks } = stubCtx({ notify: false, ...options });
  const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
  await mod.default.setup(ctx);
  const rawChars = JSON.stringify(source).length;
  const sessionID = `ses_live_bench_${profile}_${Date.now()}`;
  // A real session rebuilds the transcript from disk on every request. Replay a
  // few turns so queued summaries are applied and the compile converges.
  let compiled = clone(source);
  for (let turn = 0; turn < 4; turn++) {
    compiled = clone(source);
    hooks.context({
      messages: compiled,
      system: [],
      tools: {},
      options: {},
      sessionID,
      model: { providerID: "live", modelID: "live" },
      agent: "build",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const compiledChars = JSON.stringify(compiled).length;
  // Tool-call parts are never rewritten, so their bytes survive in every request.
  const callPartChars = new Map();
  for (const m of source) {
    for (const p of m.content ?? []) {
      if (p?.type === "tool-call") callPartChars.set(p.id, JSON.stringify(p).length);
    }
  }
  let pruned = 0;
  let ondiskCeilingChars = 0;
  for (const m of compiled) {
    for (const p of m.content ?? []) {
      if (p?.type !== "tool-result" || typeof p.result?.value !== "string" || !p.result.value.includes("output of")) continue;
      pruned++;
      // What an on-disk delete could still remove: the stub it left behind plus
      // the sibling tool-call it cannot drop without splitting the pair.
      ondiskCeilingChars += JSON.stringify(p).length + (callPartChars.get(p.id) ?? 0);
    }
  }
  return {
    profile,
    rawTokens: tokens(rawChars),
    compiledTokens: tokens(compiledChars),
    savedTokens: tokens(rawChars) - tokens(compiledChars),
    savedPct: ((1 - compiledChars / rawChars) * 100).toFixed(1),
    ondiskCeilingTokens: tokens(ondiskCeilingChars),
    ondiskCeilingPct: ((ondiskCeilingChars / compiledChars) * 100).toFixed(1),
    pruned,
  };
}

// ---------------------------------------------------------------- main
let sessions;
try {
  sessions = (await api("/api/session")).json?.data ?? [];
} catch {
  console.log("SKIP  opencode live server is not reachable at " + base);
  process.exit(0);
}
let chosen = process.env.LIVE_SESSION ? { id: process.env.LIVE_SESSION } : null;
if (!chosen) {
  let best = null;
  for (const s of sessions) {
    const res = await api(`/api/session/${s.id}/message`);
    const arr = Array.isArray(res.json?.data) ? res.json.data : [];
    if (arr.length === 0) continue;
    const hook = toHookMessages(arr);
    const chars = JSON.stringify(hook).length;
    if (!best || chars > best.chars) best = { id: s.id, chars, session: s };
  }
  chosen = best;
}

if (!chosen) {
  console.log("SKIP  no transcript with content found on the live server");
  process.exit(0);
}

const res = await api(`/api/session/${chosen.id}/message`);
const raw = Array.isArray(res.json?.data) ? res.json.data : [];
const source = toHookMessages(raw);
if (source.length === 0) {
  console.log(`SKIP  session ${chosen.id} has no prunable tool/text content`);
  process.exit(0);
}

const shares = prunableShare(source);
console.log(`context-pruner real-transcript benchmark — session ${chosen.id}`);
console.log(`messages=${source.length} window=${contextLimit}${tight ? " (tight)" : ""} tool/text mix=${shares.toolSharePct}%/${shares.textSharePct}%\n`);

const rows = [];
for (const [profile, options] of Object.entries(PROFILES)) {
  rows.push(await measure(profile, options, source));
}

console.log("profile        raw tok   compiled   saved    saved%   pruned");
for (const row of rows) {
  console.log(
    `${row.profile.padEnd(14)} ${String(row.rawTokens).padStart(7)} ${String(row.compiledTokens).padStart(10)} ` +
      `${String(row.savedTokens).padStart(7)} ${String(`${row.savedPct}%`).padStart(8)} ${String(row.pruned).padStart(7)}`,
  );
}

const baseline = rows.find((r) => r.profile === "conservative");
const best = rows.reduce((a, b) => (b.savedTokens > a.savedTokens ? b : a));
console.log(
  `\nconservative vs ${best.profile}: +${best.savedTokens - baseline.savedTokens} tokens removed ` +
    `(${(best.savedPct - baseline.savedPct).toFixed(1)} percentage points).`,
);

const ceiling = rows.find((r) => r.profile === "dcp") ?? best;
console.log(
  `on-disk ceiling: the payload those stubs replace is already absent from the outgoing request. ` +
    `Deleting each pruned pair on disk instead (stub + its tool-call) could remove at most ` +
    `${ceiling.ondiskCeilingTokens} more tokens per request on the widest profile ` +
    `(${ceiling.ondiskCeilingPct}% of that compiled prompt).`,
);

const inputPrice = Number(process.env.LIVE_INPUT_PRICE ?? 0);
const cachePrice = Number(process.env.LIVE_CACHE_READ_PRICE ?? 0);
if (inputPrice > 0 || cachePrice > 0) {
  console.log(`\n$ per compiled request (prices per 1M tokens: input ${inputPrice}, cache-read ${cachePrice}):`);
  console.log("profile        raw $     compiled  saved $   saved $ cached");
  for (const row of rows) {
    const rawDollars = (row.rawTokens * inputPrice) / 1e6;
    const compiledDollars = (row.compiledTokens * inputPrice) / 1e6;
    const savedCached = (row.savedTokens * cachePrice) / 1e6;
    console.log(
      `${row.profile.padEnd(14)} ${`$${rawDollars.toFixed(5)}`.padStart(9)} ${`$${compiledDollars.toFixed(5)}`.padStart(9)} ` +
        `${`$${(rawDollars - compiledDollars).toFixed(5)}`.padStart(9)} ${`$${savedCached.toFixed(5)}`.padStart(14)}`,
    );
  }
} else {
  console.log("\nSet LIVE_INPUT_PRICE and/or LIVE_CACHE_READ_PRICE ($ per 1M tokens) to price the savings.");
}

const recorded = sessions.find((s) => s.id === chosen.id);
if (recorded?.tokens) {
  console.log(
    `\nsession accounting (all turns): input=${recorded.tokens.input ?? 0} cache.read=${recorded.tokens.cache?.read ?? 0} ` +
      `output=${recorded.tokens.output ?? 0} recorded cost=${recorded.cost ?? 0}`,
  );
}

// Config hot-reload leaves a watchFile open; the benchmark is done, exit cleanly.
process.exit(0);
