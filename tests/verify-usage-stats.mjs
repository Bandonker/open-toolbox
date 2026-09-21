/**
 * Mock-context verification for the usage-stats plugin.
 *
 *   node tests/verify-usage-stats.mjs
 *
 * Runs the real plugin source against a stub context: a fake tool/command
 * registry, captured execute.before/after hooks, and an event.subscribe async
 * generator we can push fake V2 events into. The SQLite DB is redirected to a
 * throwaway sandbox (env set before import).
 */

import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-usage-stats-verify");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX
process.env.OPENCODE_USAGE_STATS_DIR = join(sandbox, "usage-stats");
process.env.OPENCODE_USAGE_STATS_LOG = "0";
process.env.OPENCODE_USAGE_STATS_NO_OPEN = "1";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

function makeEventStream() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(event) {
      queue.push(event);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    close() {
      closed = true;
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
          if (closed) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      })();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

const mod = await import(new URL("../plugins/usage-stats.ts", import.meta.url));
const plugin = mod.default;

check(
  "usage-stats exposes a single default plugin",
  plugin.id === "usage-stats" && typeof plugin.setup === "function",
);

const tools = [];
const commands = [];
const prompts = [];
const sessionHooks = {};
const hooks = {};
const stream = makeEventStream();

const ctx = {
  options: {},
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
  command: {
    transform: async (cb) => {
      cb({ add: (c) => commands.push(c) });
      return { dispose: async () => {} };
    },
  },
  session: {
    prompt: async (input) => {
      prompts.push(input);
    },
    hook: async (name, cb) => {
      sessionHooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
  model: {
    list: async () => ({
      location: {},
      data: [
        {
          id: "claude-sonnet-4",
          modelID: "claude-sonnet-4",
          providerID: "anthropic",
          cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 1.5 } }],
        },
        {
          id: "tiered",
          modelID: "tiered",
          providerID: "acme",
          cost: [
            { input: 1, output: 1, cache: { read: 0, write: 0 } },
            { tier: { type: "context", size: 1000 }, input: 10, output: 10, cache: { read: 0, write: 0 } },
          ],
        },
        {
          id: "pricey",
          modelID: "pricey",
          providerID: "acme",
          cost: [{ input: 1, output: 4, cache: { read: 0.5, write: 2 } }],
        },
        {
          id: "unpriced",
          modelID: "unpriced",
          providerID: "local",
          cost: [],
        },
      ],
    }),
  },
  event: { subscribe: () => stream.subscribe() },
};

const cleanup = await plugin.setup(ctx);

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const toolCtx = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_x", progress: async () => {} };

check(
  "registers the 5 stats tools",
  ["stats_summary", "stats_tools", "stats_tokens", "stats_heatmap", "stats_dashboard"].every(
    (n) => typeof byName[n]?.execute === "function",
  ),
  tools.map((t) => t.name).join(", "),
);
check("registers the /stats command", commands.length === 1 && commands[0].name === "stats");
check("registers execute.before/after hooks", typeof hooks["execute.before"] === "function" && typeof hooks["execute.after"] === "function");

// --- session events ---------------------------------------------------------
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_1", model: { providerID: "anthropic", id: "claude-sonnet-4" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_1" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_1",
    cost: 0.001,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 7, write: 3 } },
  },
});
await tick();

let summary = (await byName.stats_summary.execute({}, toolCtx)).content;
check(
  "usage.updated records tokens and cost",
  summary.includes("input=100") && summary.includes("output=20") && summary.includes("cost: $0.001000"),
  summary.split("\n")[1],
);
{
  const todayPart = summary.slice(summary.indexOf("today"));
  check(
    "today reports cache tokens, not a silent zero",
    /cache_read=7/.test(todayPart) && /cache_write=3/.test(todayPart),
    todayPart.split("\n")[1],
  );
}

// second cumulative update: larger values, only the delta is added
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_1",
    cost: 0.002,
    tokens: { input: 150, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await tick();
summary = (await byName.stats_summary.execute({}, toolCtx)).content;
check(
  "cumulative update counts only the delta, not the sum",
  summary.includes("input=150") && summary.includes("output=30") && !summary.includes("input=250"),
  summary.split("\n")[1],
);

// identical cumulative update: adds nothing
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_1",
    cost: 0.002,
    tokens: { input: 150, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await tick();
const tokensAfterRepeat = (await byName.stats_tokens.execute({}, toolCtx)).content;
check(
  "repeated identical cumulative update adds nothing",
  tokensAfterRepeat.includes("anthropic/claude-sonnet-4: tokens=190"),
  tokensAfterRepeat.split("\n").find((l) => l.includes("claude")),
);

// background one-off (title)
stream.push({
  type: "session.usage.recorded",
  data: {
    sessionID: "ses_1",
    source: "title",
    cost: 0.00001,
    tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await tick();
summary = (await byName.stats_summary.execute({}, toolCtx)).content;
check(
  "usage.recorded is counted separately as background",
  summary.includes("background: tokens=10") && summary.includes("title=10"),
  summary.split("\n")[5],
);

// --- tool hooks -------------------------------------------------------------
hooks["execute.before"]({ id: "c1", tool: "read", sessionID: "ses_1", agent: "build", messageID: "m1", input: {} });
hooks["execute.after"]({ id: "c1", tool: "read", status: "completed", result: {} });
hooks["execute.before"]({ id: "c2", tool: "bash", sessionID: "ses_1", agent: "build", messageID: "m1", input: {} });
hooks["execute.after"]({ id: "c2", tool: "bash", status: "error", error: {} });

const toolsText = (await byName.stats_tools.execute({}, toolCtx)).content;
check(
  "tool hooks count a successful call",
  /read: calls=1 ok=1 failed=0 avg=\d+ms max=\d+ms/.test(toolsText),
  toolsText.split("\n")[1],
);
check(
  "tool hooks count an errored call",
  /bash: calls=1 ok=0 failed=1 avg=\d+ms max=\d+ms/.test(toolsText),
  toolsText.split("\n")[2],
);
summary = (await byName.stats_summary.execute({}, toolCtx)).content;
check("summary reports tool calls and success rate", summary.includes("tool calls: 2 (ok 1, failed 1, 50.0% success)"));
check("summary counts sessions", summary.includes("sessions: 1"));

// --- pricing: list-price costs computed from the model price list -----------
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_pricey", model: { providerID: "acme", id: "pricey" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_pricey" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_pricey",
    cost: 0,
    // 2000*1 + (500 output + 100 reasoning)*4 + 2000*0.5 + 300*2 = 6000 => $0.006
    tokens: { input: 2000, output: 500, reasoning: 100, cache: { read: 2000, write: 300 } },
  },
});
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_tiered", model: { providerID: "acme", id: "tiered" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_tiered" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_tiered",
    cost: 0,
    // input 2000 >= tier size 1000, so the 10/10 tier applies: 2000*10 + 500*10 = 25000 => $0.025
    tokens: { input: 2000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_unpriced", model: { providerID: "local", id: "unpriced" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_unpriced" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_unpriced",
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await tick();

summary = (await byName.stats_summary.execute({}, toolCtx)).content;
check(
  "summary reports reported and list-price totals",
  summary.includes("cost: $0.002000") && summary.includes("cost (list price): $0.031218"),
  summary.split("\n").slice(1, 4).join(" | "),
);
check("summary notes how many models lack pricing", /unknown models: 1 /.test(summary));

// --- other tools ------------------------------------------------------------
const tokensText = (await byName.stats_tokens.execute({ days: 7 }, toolCtx)).content;
check("stats_tokens returns per-day and per-model text", tokensText.includes("Token usage by day (last 7 days)") && tokensText.includes("By model:"));

const heatmap = (await byName.stats_heatmap.execute({ weeks: 26 }, toolCtx)).content;
check(
  "stats_heatmap returns a heatmap with a legend",
  heatmap.includes("Usage heatmap (last 26 weeks, metric=tokens)") && heatmap.includes("Legend:") && heatmap.includes("█"),
  heatmap.split("\n")[0],
);

const dash = (await byName.stats_dashboard.execute({}, toolCtx)).content;
const dashPath = join(process.env.OPENCODE_USAGE_STATS_DIR, "dashboard.html");
check("stats_dashboard returns the path and size", dash.includes(`dashboard: ${dashPath}`) && /bytes: \d+/.test(dash));
check("stats_dashboard wrote the HTML file", existsSync(dashPath));
const html = existsSync(dashPath) ? readFileSync(dashPath, "utf8") : "";
check(
  "dashboard HTML has heatmap/bar-chart/background markers",
  html.includes("<!-- heatmap -->") && html.includes("<!-- bar-chart -->") && html.includes("<!-- background -->"),
);
check("dashboard HTML shows lifetime totals", html.includes("190") && html.includes("anthropic/claude-sonnet-4"));
check("dashboard HTML is self-contained (no script/CDN)", !html.includes("<script") && !html.includes("http://") && !html.includes("https://"));
check(
  "dashboard shows reported vs list-price KPI cards",
  html.includes("Cost (reported)") && html.includes("Cost (list price)"),
);
check(
  "dashboard model table lists provider and $-per-M rates",
  /<td class="num">acme<\/td>/.test(html) && html.includes('<td class="num">$10</td>'),
);
check(
  "dashboard shows exact list-price cost for priced models",
  html.includes("$0.006000") && html.includes("$0.025000"),
);
check(
  "unpriced model renders an em dash, not $0",
  /local\/unpriced<\/td><td class="num">local<\/td><td class="num">—<\/td><td class="num">—<\/td><td class="num">15<\/td><td class="num">\$0\.000000<\/td><td class="num">—<\/td><td class="num">1<\/td>/.test(
    html,
  ),
);
check(
  "dashboard HTML advertises auto-refresh by default",
  html.includes('<meta http-equiv="refresh" content="20"'),
);

// --- model attribution via http.request -------------------------------------
check("registers an http.request hook", typeof sessionHooks["http.request"] === "function");
if (typeof sessionHooks["http.request"] === "function") {
  sessionHooks["http.request"]({
    sessionID: "ses_http",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    agent: "build",
    kind: "primary",
    request: {},
  });
  stream.push({ type: "session.created", data: { sessionID: "ses_http" } });
  stream.push({
    type: "session.usage.updated",
    data: {
      sessionID: "ses_http",
      cost: 0,
      tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  await tick();
  await byName.stats_dashboard.execute({}, toolCtx);
  const htmlAttr = readFileSync(dashPath, "utf8");
  check(
    "http.request attributes a session's model (no model.selected event)",
    /anthropic\/claude-sonnet-4<\/td><td class="num">anthropic<\/td><td class="num">\$1<\/td><td class="num">\$2<\/td>/.test(
      htmlAttr,
    ),
    (htmlAttr.match(/anthropic\/claude-sonnet-4<\/td>[\s\S]{0,150}/) || [""])[0].replace(/\s+/g, " ").slice(0, 140),
  );
}

// --- auto-refresh disabled --------------------------------------------------
const tools2 = [];
const ctx2 = {
  options: { autoRefreshSec: 0 },
  app: ctx.app,
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools2.push(t) });
      return { dispose: async () => {} };
    },
    hook: async () => ({ dispose: async () => {} }),
  },
  command: { transform: async () => ({ dispose: async () => {} }) },
  session: { prompt: async () => {}, hook: async () => ({ dispose: async () => {} }) },
  model: ctx.model,
  event: { subscribe: () => stream.subscribe() },
};
const cleanup2 = await plugin.setup(ctx2);
const byName2 = Object.fromEntries(tools2.map((t) => [t.name, t]));
await byName2.stats_dashboard.execute({}, toolCtx);
const html2 = readFileSync(dashPath, "utf8");
check("autoRefreshSec=0 omits the refresh meta", !html2.includes('<meta http-equiv="refresh"'));
check(
  "dashboard stays self-contained with refresh off",
  !html2.includes("<script") && !html2.includes("http://") && !html2.includes("https://"),
);
if (typeof cleanup2 === "function") await cleanup2();

// --- auto-refresh tick ------------------------------------------------------
const tools3 = [];
const ctx3 = {
  options: { autoRefreshSec: 1 },
  app: ctx.app,
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools3.push(t) });
      return { dispose: async () => {} };
    },
    hook: async () => ({ dispose: async () => {} }),
  },
  command: { transform: async () => ({ dispose: async () => {} }) },
  session: { prompt: async () => {}, hook: async () => ({ dispose: async () => {} }) },
  model: ctx.model,
  event: { subscribe: () => stream.subscribe() },
};
const cleanup3 = await plugin.setup(ctx3);
rmSync(dashPath, { force: true });
stream.push({ type: "session.created", data: { sessionID: "ses_tick" } });
await new Promise((resolve) => setTimeout(resolve, 1300));
check("auto-refresh timer regenerates the dashboard without a tool call", existsSync(dashPath));
if (typeof cleanup3 === "function") await cleanup3();

// --- price override ---------------------------------------------------------
const tools4 = [];
const ctx4 = {
  options: {
    autoRefreshSec: 0,
    prices: { "local/override-model": { input: 1, output: 0, cache: { read: 0, write: 0 } } },
  },
  app: ctx.app,
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools4.push(t) });
      return { dispose: async () => {} };
    },
    hook: async () => ({ dispose: async () => {} }),
  },
  command: { transform: async () => ({ dispose: async () => {} }) },
  session: { prompt: async () => {}, hook: async () => ({ dispose: async () => {} }) },
  model: ctx.model,
  event: { subscribe: () => stream.subscribe() },
};
const cleanup4 = await plugin.setup(ctx4);
const byName4 = Object.fromEntries(tools4.map((t) => [t.name, t]));
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_override", model: { providerID: "local", id: "override-model" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_override" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_override",
    cost: 0,
    tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await tick();
await byName4.stats_dashboard.execute({}, toolCtx);
const html4 = readFileSync(dashPath, "utf8");
check(
  "price override prices an otherwise-unknown model",
  /local\/override-model<\/td><td class="num">local<\/td><td class="num">\$1<\/td><td class="num">\$0<\/td><td class="num">1000<\/td><td class="num">\$0\.000000<\/td><td class="num">\$0\.001000<\/td>/.test(
    html4,
  ),
  (html4.match(/local\/override-model<\/td>[\s\S]{0,180}/) || [""])[0].replace(/\s+/g, " ").slice(0, 170),
);
if (typeof cleanup4 === "function") await cleanup4();

// --- models.dev object-shaped cost (flat cache_read/cache_write) ------------
const tools5 = [];
const ctx5 = {
  options: { autoRefreshSec: 0 },
  app: ctx.app,
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools5.push(t) });
      return { dispose: async () => {} };
    },
    hook: async () => ({ dispose: async () => {} }),
  },
  command: { transform: async () => ({ dispose: async () => {} }) },
  session: { prompt: async () => {}, hook: async () => ({ dispose: async () => {} }) },
  model: {
    list: async () => ({
      location: {},
      data: [
        {
          id: "objmodel",
          modelID: "objmodel",
          providerID: "acme",
          // The shape the on-disk models cache actually uses.
          cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1.5 },
        },
      ],
    }),
  },
  event: { subscribe: () => stream.subscribe() },
};
const cleanup5 = await plugin.setup(ctx5);
const byName5 = Object.fromEntries(tools5.map((t) => [t.name, t]));
stream.push({
  type: "session.model.selected",
  data: { sessionID: "ses_obj", model: { providerID: "acme", id: "objmodel" } },
});
stream.push({ type: "session.created", data: { sessionID: "ses_obj" } });
stream.push({
  type: "session.usage.updated",
  data: {
    sessionID: "ses_obj",
    cost: 0,
    tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 2000, write: 1000 } },
  },
});
await tick();
await byName5.stats_dashboard.execute({}, toolCtx);
const html5 = readFileSync(dashPath, "utf8");
check(
  "models.dev object-shaped cost (flat cache_read/write) is priced",
  /acme\/objmodel<\/td>[\s\S]{0,220}\$0\.003500/.test(html5),
  (html5.match(/acme\/objmodel<\/td>[\s\S]{0,180}/) || [""])[0].replace(/\s+/g, " ").slice(0, 170),
);
if (typeof cleanup5 === "function") await cleanup5();

// --- command (must be model-free) -------------------------------------------
const dashBefore = readFileSync(dashPath, "utf8").length;
await commands[0].execute({ sessionID: "ses_1", prompt: { text: "focus on cost" }, delivery: undefined });
check(
  "/stats command never prompts the model (zero tokens)",
  prompts.length === 0,
  `prompts injected: ${prompts.length}`,
);
check(
  "/stats command refreshes the dashboard server-side",
  existsSync(dashPath) && readFileSync(dashPath, "utf8").length >= dashBefore,
);

if (typeof cleanup === "function") await cleanup();
stream.close();

// The SQLite plugin keeps a DB handle; on Windows the sandbox may stay locked.
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* locked by an open DB handle; cleaned up on the next run */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
