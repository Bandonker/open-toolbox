#!/usr/bin/env node
/**
 * Throwaway diagnostic: where do the compiled tokens actually sit? Prints a
 * breakdown of the compiled prompt by part category (raw / stub / digest /
 * pointer / tool-call scaffolding) plus the plugin's own report.
 *
 *   node tests/_diag-breakdown.mjs [--profile defaults|dcp]
 */
import { tmpdir } from "node:os";
import { CHARS_PER_TOKEN, clone, filler, tokens, transcript } from "./lib/synthetic-transcript.mjs";

const DCP_SHAPED = process.argv.includes("--profile=dcp");
const OPTIONS = DCP_SHAPED
  ? {
      notify: "off",
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
    }
  : { notify: "off" };

const TURNS = 16;
const store = new Map();
const hooks = {};
const tools = [];
const ctx = {
  options: OPTIONS,
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
    get: async (k) => (store.has(k) ? clone(store.get(k)) : undefined),
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
    scan: async () => [...store.keys()],
  },
};
const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
await mod.default.setup(ctx);

const tallies = { raw: 0, stub: 0, digest: 0, pointer: 0, call: 0, other: 0, messages: 0, parts: 0 };
let rawChars = 0;
let compiledChars = 0;
let last = null;
for (let turn = 0; turn < TURNS; turn++) {
  const source = transcript(turn);
  rawChars += JSON.stringify(source).length;
  const live = clone(source);
  hooks.context({ messages: live, system: [], tools: {}, sessionID: "ses_diag", model: { providerID: "bench", modelID: "bench" }, agent: "build" });
  compiledChars += JSON.stringify(live).length;
  tallies.messages += live.length;
  for (const message of live) {
    for (const part of message.content ?? []) {
      const size = JSON.stringify(part).length;
      tallies.parts++;
      if (part.type === "tool-call") {
        tallies.call += size;
        continue;
      }
      const value = typeof part.result?.value === "string" ? part.result.value : String(part.text ?? "");
      if (value.includes("[context prose summary]")) tallies.digest += size;
      else if (value.includes("[context-pruner summary]")) tallies.digest += size;
      else if (value.includes("[context-pruner] output of")) tallies.stub += size;
      else if (value.includes("folded into summary")) tallies.pointer += size;
      else tallies.raw += size;
    }
  }
  last = live;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const report = await byName.context_report.execute({ sessionID: "ses_diag" }, { sessionID: "ses_diag" });
console.log(`profile=${DCP_SHAPED ? "dcp" : "defaults"} raw=${tokens(rawChars)} compiled=${tokens(compiledChars)} saved=${((1 - compiledChars / rawChars) * 100).toFixed(1)}%`);
console.log(`breakdown (tokens): raw=${tokens(tallies.raw)} stub=${tokens(tallies.stub)} digest=${tokens(tallies.digest)} pointer=${tokens(tallies.pointer)} calls=${tokens(tallies.call)}`);
console.log(`parts/request=${(tallies.parts / TURNS).toFixed(1)} messages/request=${(tallies.messages / TURNS).toFixed(1)}`);
console.log(report.content);
process.exit(0);
