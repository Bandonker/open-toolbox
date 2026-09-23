/**
 * M2/M3/M4 verification for the memory plugin.
 *
 * M2: the auto-recall `seen` map must be bounded (cap + TTL), must not grow
 *     forever, and must survive restarts via ctx.storage (no re-injection).
 * M3: auto-recall injection must be capped per session, not just per request.
 * M4: memory_stats must report the database file size.
 *
 *   node tests/verify-memory-seen.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-memory-seen-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX
process.env.OPENCODE_MEMORY_SCOPE = "project";
process.env.OPENCODE_MEMORY_TOP_K = "5";
process.env.OPENCODE_MEMORY_BUDGET_CHARS = "100";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// Shared storage stub across setups (simulates a host restart).
const store = new Map();
const storage = {
  get: async (k) => store.get(k),
  set: async (k, v) => { store.set(k, v); },
};

async function makeInstance() {
  const mod = await import(new URL("../plugins/memory.ts", import.meta.url));
  const tools = {};
  const hooks = {};
  await mod.default.setup({
    options: {},
    location: { directory: join(sandbox, "project") },
    storage,
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  });
  return { tools, hooks };
}

const toolCtx = { sessionID: "ses_seen", agent: "build", messageID: "m", id: "c", progress: async () => {} };
const { tools, hooks } = await makeInstance();
const run = (name, args) => tools[name].execute(args, toolCtx);
const hookRun = (hooksObj, sid, text) => {
  const messages = [{ role: "user", content: [{ type: "text", text }] }];
  hooksObj.context({ messages, system: [], tools: {}, options: {}, sessionID: sid, model: {}, agent: "build" });
  return messages.filter((m) => m.role === "system");
};

// ---------------------------------------------------------- M2: bounded seen
const { __test__ } = await import(new URL("../plugins/memory.ts", import.meta.url));
check("memory exposes __test__ seen helpers",
  typeof tools.memory_remember?.execute === "function" && __test__ !== undefined);

if (__test__) {
  for (let i = 0; i < 600; i++) __test__.injectSeen(`ses_flood_${i}`, [i], Date.now());
  hookRun(hooks, "ses_probe", "nothing matches this xyzzy query");
  check("M2: seen map is capped (no unbounded growth)", __test__.seenSize() <= 500, `size=${__test__.seenSize()}`);

  __test__.injectSeen("ses_ancient", [999], Date.now() - 1000 * 60 * 60 * 24 * 30);
  __test__.sweepSeen(Date.now());
  check("M2: idle sessions expire out of seen", !__test__.hasSeen("ses_ancient"));
} else {
  check("M2: seen map is capped (no unbounded growth)", false, "no __test__ hooks");
  check("M2: idle sessions expire out of seen", false, "no __test__ hooks");
}

// ---------------------------------------------------------- M2: restart persistence
await run("memory_remember", { text: "Persistent zebra fact for restart test" });
const firstHit = hookRun(hooks, "ses_restart", "tell me the zebra fact");
check("M2: first session injects the fragment", firstHit.length === 1);
await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget storage write land

const inst2 = await makeInstance();
const secondHit = hookRun(inst2.hooks, "ses_restart", "tell me the zebra fact");
check("M2: restart does not re-inject already-shown fragments", secondHit.length === 0, `got ${secondHit.length}`);

// ---------------------------------------------------------- M3: per-session budget
for (let i = 0; i < 20; i++) {
  await run("memory_remember", { text: `Budget fact number ${i} alpha beta gamma` });
}
let injectedChars = 0;
for (let turn = 0; turn < 10; turn++) {
  const sys = hookRun(inst2.hooks, "ses_budget", "alpha beta gamma recall please");
  for (const m of sys) injectedChars += (m.content?.[0]?.text ?? "").length;
}
check("M3: per-session injection is capped", injectedChars <= 4 * 100, `${injectedChars} chars injected`);

// ---------------------------------------------------------- M4: db size in stats
const stats = await run("memory_stats", {});
check("M4: memory_stats reports the db file size", /size:/i.test(stats.content), stats.content.split("\n").slice(0, 2).join(" | "));

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
