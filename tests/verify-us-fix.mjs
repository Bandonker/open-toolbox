/**
 * Regression tests for the usage-stats fixes (CODE-REVIEW-FINDINGS-2026-10-01):
 *
 *   US-1 — session baseline is monotonic: a downward-revised cumulative
 *          snapshot must not lower session_state and let the same tokens
 *          be counted twice on the way back up.
 *   US-2 — hook/pump recording failures reach console.error even with
 *          log=false (rate-limited logDbError).
 *   US-3 — stats_sessions no longer fabricates per-session tool counters
 *          (the `daily` join and calls= columns are gone).
 *   US-4 — a model whose cost object carries present-but-zero rates is
 *          priced ($0.00), not "unknown".
 *   US-5 — context tier is selected from input + cacheRead + cacheWrite.
 *   US-6 — "Nd" spans exactly N days; bare YYYY-MM-DD passes through in
 *          any timezone (no local-getter round trip).
 *   US-7 — a tool call outliving the pending sweep TTL is still recorded,
 *          with the duration unknown (averages exclude it).
 *
 *   node tests/verify-us-fix.mjs
 */

import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), "opencode-us-fix");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.OPENCODE_USAGE_STATS_LOG = "0";
process.env.OPENCODE_USAGE_STATS_NO_OPEN = "1";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

const { openDatabase } = await import("../lib/sqlite.ts");
const mod = await import(new URL("../plugins/usage-stats.ts", import.meta.url));

function makeEventStream() {
  const queue = [];
  let wake = null;
  return {
    push(event) {
      queue.push(event);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    subscribe() {
      return (async function* () {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      })();
    },
  };
}

function makeCtx(dir, modelData = []) {
  const tools = [];
  const hooks = {};
  const stream = makeEventStream();
  const ctx = {
    options: { dir, log: false, openOnStart: false, autoRefreshSec: 0 },
    app: { name: "opencode", version: "2.0.0", channel: "desktop" },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) });
        return { dispose: async () => {} };
      },
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    command: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async () => ({ dispose: async () => {} }) },
    model: { list: async () => ({ location: {}, data: modelData }) },
    event: { subscribe: () => stream.subscribe() },
  };
  return { ctx, tools, hooks, stream };
}

// Local day key with the same (host-local) rendering the plugin uses, so the
// export-window assertions hold in any timezone.
function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 * Setup A — US-1, US-2, US-3, US-6, US-7
 * ------------------------------------------------------------------ */

const dirA = join(root, "usA");
const a = makeCtx(dirA);
const cleanupA = await mod.default.setup(a.ctx);
const A = Object.fromEntries(a.tools.map((t) => [t.name, t]));

// --- US-1: monotonic session baseline --------------------------------------
a.stream.push({ type: "session.created", data: { sessionID: "ses_mono" } });
a.stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_mono", model: { providerID: "acme", id: "mono" } },
});
// cumulative snapshot #1: input 1000, cost 0.01 → +1000 counted
a.stream.push({
  type: "session.usage.updated",
  data: { sessionID: "ses_mono", cost: 0.01, tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
});
// snapshot #2 (revert/out-of-order): LOWER cumulative 800, cost 0.005 —
// the old code set the baseline to 800 here.
a.stream.push({
  type: "session.usage.updated",
  data: { sessionID: "ses_mono", cost: 0.005, tokens: { input: 800, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
});
// snapshot #3: climbs back to 1100 — with the monotonic baseline only +100
// tokens / +$0.01 count; the old baseline double-counted 300 tokens ($0.015).
a.stream.push({
  type: "session.usage.updated",
  data: { sessionID: "ses_mono", cost: 0.02, tokens: { input: 1100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
});
await tick();

let summary = (await A.stats_summary.execute({}, {})).content;
check(
  "US-1 downward-revised snapshot does not double-count tokens",
  summary.includes("input=1100") && !summary.includes("input=1300"),
  summary.split("\n")[1],
);
check(
  "US-1 downward-revised snapshot does not double-count cost",
  summary.includes("cost: $0.020000") && !summary.includes("0.025"),
  summary.split("\n").find((l) => l.includes("cost")) ?? "",
);

// --- US-3: stats_sessions has no fabricated tool counters -------------------
const sessions = (await A.stats_sessions.execute({}, {})).content;
check("US-3 stats_sessions lists the session", sessions.includes("ses_mono"), sessions.split("\n")[1]);
check(
  "US-3 stats_sessions drops the per-session tool columns",
  !sessions.includes("calls=") && !sessions.includes("ok,") && !sessions.includes("failed"),
  sessions.split("\n")[1],
);

// US-7: long-running call recorded with unknown duration -----------------
const realNow = Date.now.bind(Date);
const base = realNow();
let offset = 0;
try {
  Date.now = () => base + offset;
  a.hooks["execute.before"]({ id: "slow1", tool: "slow-tool", sessionID: "ses_mono", agent: "build", messageID: "m1", input: {} });
  // Jump 11 minutes ahead and trigger a sweep with an unrelated call.
  offset = 11 * 60_000 + 5_000;
  a.hooks["execute.before"]({ id: "tick1", tool: "tick-tool", sessionID: "ses_mono", agent: "build", messageID: "m1", input: {} });
  // Late execute.after for the swept call: recorded, duration unknown.
  a.hooks["execute.after"]({ id: "slow1", tool: "slow-tool", status: "completed", result: {} });
  // A normal call on the same tool, lasting exactly 2s (so the average has
  // one timed sample: avg must be 2000ms, not 2000/2=1000ms with the unknown
  // one counted).
  a.hooks["execute.before"]({ id: "fast1", tool: "slow-tool", sessionID: "ses_mono", agent: "build", messageID: "m1", input: {} });
  offset = 11 * 60_000 + 7_000;
  a.hooks["execute.after"]({ id: "fast1", tool: "slow-tool", status: "completed", result: {} });
} finally {
  Date.now = realNow;
}

const toolsText = (await A.stats_tools.execute({}, {})).content;
check(
  "US-7 swept long call still recorded (calls=2) with average over timed calls only",
  /slow-tool: calls=2 ok=2 failed=0 avg=2000ms max=2000ms/.test(toolsText),
  toolsText.split("\n").find((l) => l.includes("slow-tool")) ?? toolsText.split("\n")[1],
);
check(
  "US-7 unknown-duration call did not drag the average to 1000ms",
  !/slow-tool: .*avg=1000ms/.test(toolsText),
);

// --- US-6: export windows ----------------------------------------------------
{
  // Seed older daily rows on a second connection (WAL allows it).
  const db = openDatabase(join(dirA, "stats.db"));
  for (const offset of [1, 2, 6]) {
    db.prepare("INSERT OR REPLACE INTO daily(day, input) VALUES(?, 10)").run(localDay(-offset));
  }
  db.close();
}
{
  const oneDay = JSON.parse((await A.stats_export.execute({ format: "json", table: "daily", since: "1d" }, {})).content);
  check(
    'US-6 "1d" spans exactly today',
    oneDay.length === 1 && oneDay[0].day === localDay(0),
    JSON.stringify(oneDay.map((r) => r.day)),
  );
  const threeDays = JSON.parse((await A.stats_export.execute({ format: "json", table: "daily", since: "3d" }, {})).content);
  check(
    'US-6 "3d" spans exactly 3 days inclusive (no day -6)',
    threeDays.length === 3 && threeDays[0].day === localDay(-2) && threeDays[2].day === localDay(0),
    JSON.stringify(threeDays.map((r) => r.day)),
  );
  const sevenDays = JSON.parse((await A.stats_export.execute({ format: "json", table: "daily", since: "7d" }, {})).content);
  check('US-6 "7d" includes the day -6 row', sevenDays.length === 4 && sevenDays[0].day === localDay(-6));
  const bare = JSON.parse(
    (await A.stats_export.execute({ format: "json", table: "daily", since: localDay(-2), to: localDay(0) }, {})).content,
  );
  check(
    "US-6 bare YYYY-MM-DD since/to pass through unchanged (no timezone shift)",
    bare.length === 3 && bare[0].day === localDay(-2) && bare[2].day === localDay(0),
    JSON.stringify(bare.map((r) => r.day)),
  );
  const impossible = (await A.stats_export.execute({ format: "json", table: "daily", since: "2026-02-30" }, {})).content;
  check(
    "US-6 impossible date is rejected (filter dropped, all rows exported)",
    JSON.parse(impossible).length === 4,
  );
}

// --- US-2: hook failures surface with log=false ------------------------------
{
  // Break the recording path: drop tool_totals underneath the plugin.
  const db = openDatabase(join(dirA, "stats.db"));
  db.exec("DROP TABLE tool_totals");
  db.close();
  const seen = [];
  const realErr = console.error;
  console.error = (...args) => seen.push(args.join(" "));
  a.hooks["execute.before"]({ id: "boom", tool: "boom-tool", sessionID: "ses_mono", agent: "build", messageID: "m1", input: {} });
  await a.hooks["execute.after"]({ id: "boom", tool: "boom-tool", status: "completed", result: {} });
  console.error = realErr;
  check(
    "US-2 hook recording failure logged despite log=false",
    seen.some((l) => l.includes("[usage-stats]") && l.includes("execute.after failed")),
    seen.join(" | ") || "(no stderr captured)",
  );
}

await cleanupA();

/* ------------------------------------------------------------------ *
 * Setup B — US-4, US-5 (own dir, own pricing)
 * ------------------------------------------------------------------ */

const dirB = join(root, "usB");
const b = makeCtx(dirB, [
  {
    // models.dev cache shape with explicit zero rates: a free model.
    id: "free",
    modelID: "free",
    providerID: "free",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  {
    id: "tiered2",
    modelID: "tiered2",
    providerID: "acme",
    cost: [
      { input: 1, output: 1, cache: { read: 0, write: 0 } },
      { tier: { type: "context", size: 1000 }, input: 10, output: 10, cache: { read: 0, write: 0 } },
    ],
  },
]);
const cleanupB = await mod.default.setup(b.ctx);
const B = Object.fromEntries(b.tools.map((t) => [t.name, t]));

// US-4: free model priced at $0.00.
b.stream.push({ type: "session.created", data: { sessionID: "ses_free" } });
b.stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_free", model: { providerID: "free", id: "free" } },
});
b.stream.push({
  type: "session.usage.updated",
  data: { sessionID: "ses_free", cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
});
// US-5: tier must be picked from input + cacheRead + cacheWrite = 2100 ≥ 1000
// → 10/10 rates → (100*10 + 0 + 2000*0)/1e6 = $0.001. The old input-only
// basis used 100 and charged $0.0001.
b.stream.push({ type: "session.created", data: { sessionID: "ses_t5" } });
b.stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_t5", model: { providerID: "acme", id: "tiered2" } },
});
b.stream.push({
  type: "session.usage.updated",
  data: { sessionID: "ses_t5", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 2000, write: 0 } } },
});
await tick();

const summaryB = (await B.stats_summary.execute({}, {})).content;
const lifetimeB = summaryB.slice(0, summaryB.indexOf("Usage stats — today"));
check(
  "US-4 free (zero-rate) model is priced: zero cost computed, list price not —",
  lifetimeB.includes("cost (list price): $0.001000") &&
    !lifetimeB.includes("cost (list price): —") &&
    lifetimeB.includes("cost: $0.000000"),
  lifetimeB.split("\n").find((l) => l.includes("list price")) ?? "",
);
check("US-4 free model not counted as an unknown-price model", /unknown models: 0/.test(summaryB), summaryB);

const dashB = (await B.stats_dashboard.execute({}, {})).content;
check("US-4/US-5 dashboard rendered", dashB.includes("dashboard:"));
const htmlB = readFileSync(join(dirB, "dashboard.html"), "utf8");
check(
  "US-5 cached turn charged the high-context tier ($0.001000, not $0.000100)",
  htmlB.includes('title="$0.001000"') && !htmlB.includes('title="$0.000100"'),
);
check(
  "US-4 free model renders $0 rate cells (no em-dash row for it)",
  /free<\/td>[\s\S]{0,80}?>\$0<\/td>/.test(htmlB) && htmlB.includes("free/free"),
);

await cleanupB();
rmSync(root, { recursive: true, force: true });

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
