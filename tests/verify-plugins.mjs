/**
 * Mock-context verification for the plugin pack.
 *
 * Runs the real plugin sources against stub contexts (no opencode server
 * needed) and exercises the parts that matter: command registration and
 * injection, tool-hook recording, redaction, and the trace_* tools.
 *
 *   node tests/verify-plugins.mjs
 */
import assert from "node:assert/strict";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

// The SQLite plugins resolve their database under os.homedir() at import time.
// Point that at a throwaway sandbox so these checks never touch the real
// journals, then clean it up at the end.
const sandbox = join(tmpdir(), "opencode-toolbox-verify-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

/** Stub ctx that captures tools registered through tool.transform. */
function stubCtx(tools, extra = {}) {
  return {
    options: {},
    location: { directory: tmpdir() },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) });
        return { dispose: async () => {} };
      },
    },
    ...extra,
  };
}

const toolCtx = {
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  progress: async () => {},
};

// ---------------------------------------------------------------- command-pack
{
  const mod = await import(new URL("../plugins/command-pack.ts", import.meta.url));
  check(
    "command-pack exposes a default plugin",
    mod.default.id === "command-pack" && typeof mod.default.setup === "function",
  );

  const commands = [];
  const injected = [];
  const disposed = [];
  const toolList = [
    "session_handoff",
    "decision_log",
    "error_log",
    "decision_search",
    "error_search",
    "snippet_search",
    "codebase_index",
    "list_sessions",
  ];
  const ctx = {
    options: {},
    location: { directory: tmpdir() },
    tool: { list: async () => toolList.map((id) => ({ id })) },
    command: {
      transform: async (cb) => {
        cb({ add: (c) => commands.push(c) });
        return { dispose: async () => disposed.push("commands") };
      },
    },
    session: {
      prompt: async (input) => {
        injected.push(input);
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  check("command-pack registers all commands", commands.length === 7, commands.map((c) => "/" + c.name).join(", "));

  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  await byName.decide.execute({
    sessionID: "ses_test",
    prompt: { text: "use sqlite not json" },
    delivery: "queue",
  });
  check("decide injects an instruction naming decision_log", injected.at(-1).text.includes("decision_log"));
  check("decide forwards args", injected.at(-1).text.includes("use sqlite not json"));
  check("decide honours delivery", injected.at(-1).delivery === "queue");

  await byName.trace.execute({ sessionID: "ses_test", prompt: { text: "this session" }, delivery: "steer" });
  check("missing required tool is reported", /needs trace_query/.test(injected.at(-1).text));

  await byName.toolbox.execute({ sessionID: "ses_test", prompt: { text: "" }, delivery: "steer" });
  const inventory = injected.at(-1).text;
  check("toolbox lists installed tools", inventory.includes("decision_log") && !inventory.includes("trace_query"));

  await cleanup();
  check("command-pack cleanup disposes its registration", disposed.length === 1, disposed.join(", "));
}

// ------------------------------------------------------------------ tool-audit
{
  const mod = await import(new URL("../plugins/tool-audit.ts", import.meta.url));
  check(
    "tool-audit exposes a default plugin",
    mod.default.id === "tool-audit" && typeof mod.default.setup === "function",
  );

  const dir = join(tmpdir(), "opencode-tool-audit-verify");
  rmSync(dir, { recursive: true, force: true });

  const tools = [];
  const hooks = {};
  const disposed = [];
  const ctx = {
    options: { dir, retentionDays: 30, redact: true },
    location: { directory: tmpdir() },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) });
      },
      hook: async (name, cb) => {
        hooks[name] = cb;
        return {
          dispose: async () => {
            disposed.push(name);
          },
        };
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  check(
    "tool-audit registers its hooks",
    typeof hooks["execute.before"] === "function" && typeof hooks["execute.after"] === "function",
  );
  check("tool-audit registers 4 tools", tools.length === 4, tools.map((t) => t.name).join(", "));

  const before = (e) => hooks["execute.before"](e);
  const after = (e) => hooks["execute.after"](e);

  // completed call carrying a secret in its args
  await before({
    tool: "read",
    sessionID: "ses_a",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { filePath: "src/x.ts", apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234" },
  });
  await after({
    tool: "read",
    sessionID: "ses_a",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: {},
    status: "completed",
    result: { content: "hello world" },
  });

  // failed call
  await before({
    tool: "bash",
    sessionID: "ses_a",
    agent: "build",
    messageID: "msg_2",
    id: "call_2",
    input: { command: "npm test" },
  });
  await after({
    tool: "bash",
    sessionID: "ses_a",
    agent: "build",
    messageID: "msg_2",
    id: "call_2",
    input: {},
    status: "error",
    error: { message: "exit code 1" },
  });

  // ignored tool
  await before({ tool: "todowrite", sessionID: "ses_a", agent: "build", messageID: "msg_3", id: "call_3", input: {} });
  await after({
    tool: "todowrite",
    sessionID: "ses_a",
    agent: "build",
    messageID: "msg_3",
    id: "call_3",
    input: {},
    status: "completed",
    result: {},
  });

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const q = await byName.trace_query.execute({ limit: 20 }, toolCtx);
  check("trace_query returns recorded calls", q.content.includes("#1") && q.content.includes("read"), q.content.split("\n")[0]);
  check("trace_query shows the failure", q.content.includes("bash") && q.content.includes("exit code 1"));
  check("secret is redacted on disk", !q.content.includes("sk-abcdefghijklmnopqrstuvwxyz1234") && q.content.includes("[redacted]"));
  check("ignored tool is not recorded", !q.content.includes("todowrite"));

  const fts = await byName.trace_query.execute({ query: "filePath" }, toolCtx);
  check("trace_query full-text search works", fts.content.includes("read") && fts.content.includes("src/x.ts"));

  const stats = await byName.trace_stats.execute({}, toolCtx);
  check("trace_stats counts calls and errors", /calls: 2/.test(stats.content) && /errors: 1/.test(stats.content), stats.content.split("\n")[0]);
  check("trace_stats lists per-tool rows", stats.content.includes("- read:") && stats.content.includes("- bash:"));

  const jsonl = await byName.trace_export.execute({ format: "jsonl" }, toolCtx);
  const lines = jsonl.content.trim().split("\n");
  check("trace_export jsonl has one line per call", lines.length === 2 && lines.every((l) => JSON.parse(l).tool), `${lines.length} lines`);

  const md = await byName.trace_export.execute({ format: "markdown" }, toolCtx);
  check("trace_export markdown has a table", md.content.startsWith("| time | tool |") && md.content.includes("| read |"));

  const empty = await byName.trace_query.execute({ sessionId: "ses_nope" }, toolCtx);
  check("empty result is reported", empty.content === "No tool calls matched.");

  check("audit db file was created", existsSync(join(dir, "tool-audit.db")));

  await cleanup();
  check("tool-audit disposes its hook registrations", disposed.length === 2, disposed.join(", "));
  rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------- context-pruner
{
  const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
  check(
    "context-pruner exposes a default plugin",
    mod.default.id === "context-pruner" && typeof mod.default.setup === "function",
  );

  const hooks = {};
  const tools = [];
  const commands = [];
  let subscribed = false;
  let usageHandler = null;
  const ctx = stubCtx(tools, {
    options: { keepRecent: 2, minChars: 1000, keepHeadChars: 100, ignoreTools: ["todowrite"], notify: false },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb) => {
        cb({ add: (definition) => commands.push(definition) });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: (cb) => {
        subscribed = typeof cb === "function";
        usageHandler = cb;
        return () => {};
      },
    },
  });
  await mod.default.setup(ctx);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check("context-pruner hooks the context event", typeof hooks.context === "function");
  check(
    "context-pruner registers its tools",
    tools.length === 5 &&
      Boolean(byName.context_pruner_stats) &&
      Boolean(byName.context_report) &&
      Boolean(byName.context_map) &&
      Boolean(byName.context_pruner_recall) &&
      Boolean(byName.compress),
  );
  check("context-pruner subscribes to usage events", subscribed);
  check(
    "context-pruner registers its commands",
    commands.length === 2 &&
      commands.map((c) => c.name).includes("context") &&
      commands.map((c) => c.name).includes("compress"),
  );

  // The live promise API returns an async iterable from event.subscribe(), not
  // a callback registration — make sure that shape is actually consumed.
  {
    const iterTools = [];
    const iterCtx = stubCtx(iterTools, {
      options: { notify: false },
      event: {
        subscribe: async function* () {
          yield {
            type: "session.usage.updated",
            data: {
              sessionID: "ses_usage",
              cost: 0.01,
              tokens: { input: 1200, output: 10, reasoning: 0, cache: { read: 4000, write: 500 } },
            },
          };
        },
      },
    });
    await mod.default.setup(iterCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const usageReport = await iterTools
      .find((t) => t.name === "context_report")
      .execute({ sessionID: "ses_usage" }, toolCtx);
    check(
      "async-iterable usage events update the ledger",
      /prompt tokens: 1200/.test(usageReport.content) && /cache read: 4000/.test(usageReport.content),
      usageReport.content.split("\n").find((line) => line.includes("prompt tokens")),
    );
  }

  const long = "L".repeat(5000);
  const recent = "R".repeat(5000);
  // Core sends tool-result values as arrays of content parts and iterates
  // them (`value.map(...)` in SessionModelRequest.prepare). A pruned result
  // must keep that array shape or every later request crashes.
  const valText = (v) =>
    typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "";
  const assertSendable = (result, label) => {
    const ok = result && Array.isArray(result.value) && (() => { result.value.map((a) => a); return true; })();
    check(`context-pruner keeps pruned results sendable (${label})`, Boolean(ok));
  };
  const makeMessages = () => [
    { role: "tool", content: [{ type: "tool-result", id: "1", name: "read", result: { type: "text", value: long } }] },
    { role: "tool", content: [{ type: "tool-result", id: "2", name: "bash", result: { type: "error", value: "boom" } }] },
    { role: "tool", content: [{ type: "tool-result", id: "3", name: "todowrite", result: { type: "json", value: { x: "y".repeat(5000) } } }] },
    { role: "tool", content: [{ type: "tool-result", id: "4", name: "read", result: { type: "text", value: recent } }] },
    { role: "tool", content: [{ type: "tool-result", id: "5", name: "read", result: { type: "text", value: recent } }] },
  ];
  const messages = makeMessages();
  hooks.context({ messages, system: [], tools: {}, options: {}, sessionID: "ses_test", model: {}, agent: "build" });

  const first = messages[0].content[0].result;
  check("context-pruner trims an old long result", first.type === "text" && valText(first.value).includes("pruned") && valText(first.value).length < long.length);
  check("context-pruner keeps a preview of the trimmed result", valText(first.value).includes("L".repeat(100)));
  assertSendable(first, "trim");
  check("context-pruner keeps error results", messages[1].content[0].result.value === "boom");
  check("context-pruner honours ignoreTools", messages[2].content[0].result.value.x.length === 5000);
  check("context-pruner leaves recent results untouched", messages[3].content[0].result.value === recent && messages[4].content[0].result.value === recent);

  const stats = await byName.context_pruner_stats.execute({}, toolCtx);
  check("context_pruner_stats reports pruned parts", /tool results pruned: 1\b/.test(stats.content), stats.content.split("\n")[7]);
  check("context_pruner_stats reports saved chars", /characters saved: [1-9]/.test(stats.content));

  const recallMatch = /context_pruner_recall with id \\"([0-9a-f]+)\\"/.exec(JSON.stringify(messages));
  const recalled = recallMatch ? await byName.context_pruner_recall.execute({ id: recallMatch[1] }, toolCtx) : null;
  check(
    "context_pruner_recall returns the full pruned output",
    Boolean(recalled) && recalled.content.includes("LLLL"),
    recalled ? `recalled ${recalled.content.length} chars` : "no recall id found in stub",
  );

  // A UTF-8 BOM (written by many Windows tools, e.g. PowerShell Set-Content
  // -Encoding UTF8) must not silently disable the whole config file.
  {
    const bomTools = [];
    const bomHooks = {};
    const configDir = join(sandbox, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "context-pruner.jsonc");
    writeFileSync(configPath, "\uFEFF" + JSON.stringify({ titleShortCircuit: true, turnProtection: { enabled: true, turns: 3 } }));
    await mod.default.setup(
      stubCtx(bomTools, {
        options: { notify: false },
        session: {
          hook: async (name, cb) => {
            bomHooks[name] = cb;
            return { dispose: async () => {} };
          },
        },
        command: { transform: async () => ({ dispose: async () => {} }) },
        event: { subscribe: () => () => {} },
      }),
    );
    bomHooks.context({ messages: makeMessages(), system: [], tools: {}, options: {}, sessionID: "ses_bom", model: {}, agent: "build" });
    const bomReport = await bomTools.find((t) => t.name === "context_report").execute({ sessionID: "ses_bom" }, toolCtx);
    check(
      "context-pruner reads a BOM-prefixed config file",
      /turnProtection: 3 turns/.test(bomReport.content),
      bomReport.content.split("\n").find((line) => line.startsWith("mode:")) ?? "no mode line",
    );
    rmSync(configPath, { force: true });
  }

  // Epoch stability: replaying the same messages must reproduce an identical
  // prefix and must not widen the prune set without new savings.
  const replay = makeMessages();
  hooks.context({ messages: replay, system: [], tools: {}, options: {}, sessionID: "ses_test", model: {}, agent: "build" });
  check("context-pruner keeps the pruned prefix byte-identical across requests", valText(replay[0].content[0].result.value) === valText(first.value));
  const report = await byName.context_report.execute({ sessionID: "ses_test" }, toolCtx);
  check(
    "context_report summarises the session",
    /epoch: 1\b/.test(report.content) && /active prune decisions: 1\b/.test(report.content),
    report.content.split("\n")[2],
  );
  check(
    "context_report exposes the hook switches",
    /hooks: compaction=on retry=on title=off recall=on/.test(report.content),
    report.content.split("\n").find((line) => line.startsWith("hooks:")),
  );

  // Tier 4: native hooks.
  check(
    "context-pruner registers the tier 4 hooks",
    typeof hooks.compaction === "function" && typeof hooks.retry === "function" && typeof hooks.title === "function",
  );
  const compactionEvent = {
    sessionID: "ses_test",
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Investigating auth" },
          { type: "tool-call", name: "read", input: { filePath: "src/auth.ts" } },
        ],
      },
      ...makeMessages(),
    ],
    system: [],
    tools: {},
    options: {},
    model: {},
    agent: "build",
  };
  hooks.compaction(compactionEvent);
  check(
    "compaction hook writes a checkpoint",
    typeof compactionEvent.result?.summary === "string" &&
      compactionEvent.result.summary.includes("# Context checkpoint") &&
      compactionEvent.result.summary.includes("## Goal") &&
      compactionEvent.result.summary.includes("## Files touched") &&
      compactionEvent.result.summary.includes("src/auth.ts"),
  );
  check(
    "compaction hook returns a full TokenUsage.Info (opencode reads tokens.cache.read)",
    Number.isFinite(compactionEvent.result?.tokens?.input) &&
      Number.isFinite(compactionEvent.result.tokens.cache.read) &&
      Number.isFinite(compactionEvent.result.tokens.cache.write),
  );
  const overflow = { sessionID: "ses_test", error: "prompt is too long: maximum context length exceeded", attempt: 1, decision: undefined };
  hooks.retry(overflow);
  check("retry hook recovers from a context overflow", overflow.decision?.retry === true && overflow.decision?.delay === 250);
  const lmstudioOverflow = {
    sessionID: "ses_test",
    error: 'request (7950 tokens) exceeds the available context size (2048 tokens), try increasing it',
    attempt: 1,
    decision: undefined,
  };
  hooks.retry(lmstudioOverflow);
  check("retry hook recognises LM Studio context-size overflow", lmstudioOverflow.decision?.retry === true, `delay=${lmstudioOverflow.decision?.delay}`);
  const exhausted = { sessionID: "ses_test", error: "maximum context length exceeded", attempt: 3, decision: undefined };
  hooks.retry(exhausted);
  check("retry hook gives up after three attempts", exhausted.decision?.retry === false);
  const unrelated = { sessionID: "ses_test", error: "rate limit exceeded", attempt: 1, decision: undefined };
  hooks.retry(unrelated);
  check("retry hook ignores non-overflow errors", unrelated.decision === undefined);
  const titleEvent = {
    sessionID: "ses_test",
    messages: [{ role: "user", content: [{ type: "text", text: "Fix the login bug please" }] }],
    system: [],
    tools: {},
    options: {},
    model: {},
    agent: "build",
    result: undefined,
  };
  hooks.title(titleEvent);
  check("title hook stays off by default", titleEvent.result === undefined);

  usageHandler({
    type: "session.usage.updated",
    data: { sessionID: "ses_test", tokens: { input: 1000, cache: { read: 40000, write: 5000 } } },
  });
  const cachedReport = await byName.context_report.execute({ sessionID: "ses_test" }, toolCtx);
  check(
    "context_report surfaces cache accounting",
    /cache economics: on/.test(cachedReport.content) && /cache read: 40000/.test(cachedReport.content),
  );

  // Cache economics: a voluntary replan is deferred while a warm cache makes
  // the rewrite premium cost more than the tokens it would free.
  {
    const cacheHooks = {};
    let cacheUsage = null;
    const cacheCtx = stubCtx([], {
      options: { keepRecent: 0, minChars: 10, keepHeadChars: 10, notify: false, cacheAware: true, cacheAmortize: 4 },
      model: {
        list: async () => ({
          data: [
            {
              id: "m",
              providerID: "p",
              limit: { context: 100000, output: 8192 },
              cost: [{ input: 3, cache: { read: 0.3, write: 3.75 } }],
            },
          ],
        }),
      },
      session: {
        hook: async (name, cb) => {
          cacheHooks[name] = cb;
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: (cb) => {
          cacheUsage = cb;
          return () => {};
        },
      },
    });
    await mod.default.setup(cacheCtx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cacheMessages = (count) =>
      [
        {
          type: "tool-result",
          name: "read",
          result: { type: "text", value: "A".repeat(400000) },
          input: { filePath: "big.ts" },
        },
        {
          type: "tool-result",
          name: "read",
          result: { type: "text", value: "B".repeat(20000) },
          input: { filePath: "small.ts" },
        },
      ]
        .slice(0, count)
        .map((part) => ({ role: "user", content: [part] }));
    await cacheHooks.context({ sessionID: "ses_cache", messages: cacheMessages(1), system: [], tools: {}, options: {}, model: { modelID: "m", providerID: "p" }, agent: "build" });
    cacheUsage({ type: "session.usage.updated", data: { sessionID: "ses_cache", tokens: { input: 1000, cache: { read: 40000, write: 5000 } } } });
    await cacheHooks.context({ sessionID: "ses_cache", messages: cacheMessages(2), system: [], tools: {}, options: {}, model: { modelID: "m", providerID: "p" }, agent: "build" });
    const cacheReport = await byName.context_report.execute({ sessionID: "ses_cache" }, toolCtx);
    check(
      "cache-aware epoch defers an unprofitable replan",
      /last replan: deferred/.test(cacheReport.content) && /replan gate: [1-9][0-9]*/.test(cacheReport.content),
      cacheReport.content.split("\n").find((line) => line.includes("last replan")),
    );
    check("async model list resolves the context window", /window: 100000/.test(cacheReport.content), cacheReport.content.split("\n").find((line) => line.includes("window:")));
  }

  // Nudges must stay off while the request is well under the window, even after
  // many tool iterations (DCP's turn/iteration reminders are gated on the limit).
  {
    const nudgeTools = [];
    const nudges = [];
    const nudgeHooks = {};
    const nudgeCtx = stubCtx(nudgeTools, {
      options: { notify: "off", keepRecent: 0, minChars: 10, keepHeadChars: 10 },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000000, output: 8192 } }] },
      session: {
        hook: async (name, cb) => {
          nudgeHooks[name] = cb;
          return { dispose: async () => {} };
        },
        synthetic: async (input) => {
          nudges.push(input);
          return {};
        },
      },
    });
    await mod.default.setup(nudgeCtx);
    const smallMessage = () => [
      { role: "tool", content: [{ type: "tool-result", id: "s1", name: "read", result: { type: "text", value: "S".repeat(200) } }] },
    ];
    for (let i = 0; i < 20; i++) {
      nudgeHooks.context({
        messages: smallMessage(),
        system: [],
        tools: {},
        sessionID: "ses_nudge",
        model: { id: "m", providerID: "p" },
        agent: "build",
      });
    }
    const nudgeTexts = nudges.filter((n) => String(n.text ?? "").includes("compress"));
    check("nudges stay off well below the context limit", nudgeTexts.length === 0, `${nudgeTexts.length} nudge(s)`);
  }

  // Budget-driven pruning when the model window is known.
  {
    const tools2 = [];
    const hooks2 = {};
    const ctx2 = stubCtx(tools2, {
      options: { keepRecent: 0, minChars: 10, keepHeadChars: 10, notify: false },
      session: {
        hook: async (name, cb) => {
          hooks2[name] = cb;
          return { dispose: async () => {} };
        },
      },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    });
    await mod.default.setup(ctx2);
    const big = "A".repeat(20000);
    const msgs = [
      { role: "tool", content: [{ type: "tool-result", id: "a", name: "read", result: { type: "text", value: big } }] },
      { role: "tool", content: [{ type: "tool-result", id: "b", name: "read", result: { type: "text", value: big } }] },
    ];
    hooks2.context({
      messages: msgs,
      system: [],
      tools: {},
      sessionID: "ses_budget",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
    });
    check(
      "context-pruner enforces the token budget",
      [msgs[0], msgs[1]].every((m) => valText(m.content[0].result.value).includes("pruned")),
    );
    [msgs[0], msgs[1]].forEach((m, i) => assertSendable(m.content[0].result, `budget-${i}`));
  }

  // Over-budget pruning may reach below the voluntary minChars floor (DCP is
  // size-agnostic) down to budgetMinChars, but no further.
  {
    const tools4 = [];
    const hooks4 = {};
    const ctx4 = stubCtx(tools4, {
      options: {
        keepRecent: 0,
        keepRecentTurns: 0,
        minChars: 2000,
        keepHeadChars: 10,
        notify: false,
        minReplanTokens: 0,
        purgeErrors: false,
        dedupe: false,
        superseded: false,
        autoSummarize: false,
      },
      session: {
        hook: async (name, cb) => {
          hooks4[name] = cb;
          return { dispose: async () => {} };
        },
      },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    });
    await mod.default.setup(ctx4);
    const msgs4 = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ role: "tool", content: [{ type: "tool-result", id: `mid${n}`, name: "grep", result: { type: "text", value: "B".repeat(600) } }] })),
      { role: "tool", content: [{ type: "tool-result", id: "tiny", name: "grep", result: { type: "text", value: "C".repeat(150) } }] },
    ];
    hooks4.context({
      messages: msgs4,
      system: [],
      tools: {},
      sessionID: "ses_budget_floor",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
    });
    check(
      "context-pruner prunes below minChars when over budget",
      msgs4.slice(0, 6).some((m) => valText(m.content[0].result.value).includes("pruned")),
    );
    check("context-pruner still keeps outputs below budgetMinChars", msgs4[6].content[0].result.value === "C".repeat(150));
  }

  // Over budget, the recency ring-fence is relaxed in stages: everything recent
  // may go, but `relaxRecentFloor` hot outputs stay, and the voluntary floors
  // still apply when there is no budget pressure.
  {
    const toolsR = [];
    const hooksR = {};
    const ctx6 = stubCtx(toolsR, {
      options: {
        keepRecent: 3,
        keepRecentTurns: 0,
        minChars: 10,
        budgetMinChars: 10,
        relaxRecentFloor: 1,
        keepHeadChars: 10,
        notify: false,
        minReplanTokens: 0,
        purgeErrors: false,
        dedupe: false,
        superseded: false,
        autoSummarize: false,
      },
      session: {
        hook: async (name, cb) => {
          hooksR[name] = cb;
          return { dispose: async () => {} };
        },
      },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    });
    await mod.default.setup(ctx6);
    const msgsR = [1, 2, 3, 4, 5].map((n) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `r${n}`, name: "grep", result: { type: "text", value: "E".repeat(4000) } }],
    }));
    hooksR.context({
      messages: msgsR,
      system: [],
      tools: {},
      sessionID: "ses_relax",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
    });
    const prunedR = msgsR.filter((m) => valText(m.content[0].result.value).includes("pruned")).length;
    check("context-pruner relaxes the recency floor when over budget", valText(msgsR[0].content[0].result.value).includes("pruned"), `pruned=${prunedR}`);
    check(
      "context-pruner keeps the newest output even when relaxing",
      prunedR === 4 && msgsR[4].content[0].result.value === "E".repeat(4000),
      `pruned=${prunedR}`,
    );

    // Same messages, no budget pressure: the recency floor must be respected.
    const toolsV = [];
    const hooksV = {};
    const ctx7 = stubCtx(toolsV, {
      options: {
        keepRecent: 3,
        keepRecentTurns: 0,
        minChars: 10,
        relaxRecentFloor: 1,
        keepHeadChars: 10,
        notify: false,
        minReplanTokens: 0,
        purgeErrors: false,
        dedupe: false,
        superseded: false,
        autoSummarize: false,
      },
      session: {
        hook: async (name, cb) => {
          hooksV[name] = cb;
          return { dispose: async () => {} };
        },
      },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000000, output: 100 } }] },
    });
    await mod.default.setup(ctx7);
    const msgsV = [1, 2, 3, 4, 5].map((n) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `v${n}`, name: "grep", result: { type: "text", value: "F".repeat(4000) } }],
    }));
    hooksV.context({
      messages: msgsV,
      system: [],
      tools: {},
      sessionID: "ses_voluntary",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
    });
    check(
      "context-pruner keeps the recency floor without budget pressure",
      msgsV.slice(2).every((m) => m.content[0].result.value === "F".repeat(4000)),
    );
  }

  // Same tool with the same arguments run again: the older call is dropped even
  // when the output changed (DCP's deduplication strategy).
  {
    const toolsD = [];
    const hooksD = {};
    const ctx8 = stubCtx(toolsD, {
      options: {
        keepRecent: 0,
        keepRecentTurns: 0,
        minChars: 10,
        keepHeadChars: 10,
        notify: false,
        minReplanTokens: 0,
        purgeErrors: false,
        protectedTools: ["read"],
        autoSummarize: false,
      },
      session: {
        hook: async (name, cb) => {
          hooksD[name] = cb;
          return { dispose: async () => {} };
        },
      },
      // A roomy window isolates the signature dedupe: without it the request is
      // over budget and every small output is pruned, masking the strategy.
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000000, output: 100 } }] },
    });
    await mod.default.setup(ctx8);
    const msgsD = [
      { role: "tool", content: [{ type: "tool-result", id: "sig1", name: "bash", input: { command: "npm test", cwd: "/x" }, result: { type: "text", value: "OLD-OUTPUT" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "sig2", name: "bash", input: { cwd: "/x", command: "npm test" }, result: { type: "text", value: "NEW-OUTPUT" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "sig3", name: "bash", input: { command: "npm run lint" }, result: { type: "text", value: "LINT-OUTPUT" } }] },
    ];
    hooksD.context({ messages: msgsD, system: [], tools: {}, sessionID: "ses_signature", model: { providerID: "p", modelID: "m" }, agent: "build" });
    check("context-pruner drops an older call with the same arguments", valText(msgsD[0].content[0].result.value).includes("pruned"), valText(msgsD[0].content[0].result.value).slice(0, 60));
    check("context-pruner keeps the newest call with those arguments", msgsD[1].content[0].result.value === "NEW-OUTPUT", msgsD[1].content[0].result.value.slice(0, 40));
    check("context-pruner keeps calls with different arguments", msgsD[2].content[0].result.value === "LINT-OUTPUT", msgsD[2].content[0].result.value.slice(0, 40));
  }

  // The real hook puts arguments on the assistant `tool-call` part, not on the
  // `tool-result`; the plugin must correlate them by id.
  {
    const toolsE = [];
    const hooksE = {};
    const ctx9 = stubCtx(toolsE, {
      options: {
        keepRecent: 0,
        keepRecentTurns: 0,
        minChars: 10,
        keepHeadChars: 10,
        notify: false,
        minReplanTokens: 0,
        purgeErrors: false,
        protectedTools: ["read"],
        autoSummarize: false,
      },
      session: {
        hook: async (name, cb) => {
          hooksE[name] = cb;
          return { dispose: async () => {} };
        },
      },
      model: { list: () => [{ id: "m", providerID: "p", limit: { context: 1000000, output: 100 } }] },
    });
    await mod.default.setup(ctx9);
    const call = (id, input) => ({ role: "assistant", content: [{ type: "tool-call", id, name: "bash", input }] });
    const res = (id, value) => ({ role: "tool", content: [{ type: "tool-result", id, name: "bash", result: { type: "text", value } }] });
    const msgsE = [
      call("sigA", { command: "npm test", cwd: "/x" }),
      res("sigA", "OLD-OUTPUT"),
      call("sigB", { cwd: "/x", command: "npm test" }),
      res("sigB", "NEW-OUTPUT"),
      res("sigC", "LINT-OUTPUT"),
    ];
    hooksE.context({ messages: msgsE, system: [], tools: {}, sessionID: "ses_signature_call", model: { providerID: "p", modelID: "m" }, agent: "build" });
    check("context-pruner correlates tool-call args for signature dedupe", valText(msgsE[1].content[0].result.value).includes("pruned"), valText(msgsE[1].content[0].result.value).slice(0, 60));
    check("context-pruner keeps the newest correlated call", msgsE[3].content[0].result.value === "NEW-OUTPUT", msgsE[3].content[0].result.value.slice(0, 40));
    check("context-pruner does not correlate across different ids", msgsE[4].content[0].result.value === "LINT-OUTPUT", msgsE[4].content[0].result.value.slice(0, 40));
  }

  // Superseded output + model-driven compression.
  {
    const tools3 = [];
    const hooks3 = {};
    const store = new Map();
    const generateArgs = [];
    const ctx3 = stubCtx(tools3, {
      options: {
        keepRecent: 2,
        keepRecentTurns: 0,
        minChars: 10,
        keepHeadChars: 10,
        notify: "off",
        minReplanTokens: 0,
        purgeErrors: false,
      },
      session: {
        hook: async (name, cb) => {
          hooks3[name] = cb;
          return { dispose: async () => {} };
        },
        generate: async (args) => {
          generateArgs.push(args);
          return { data: { text: "SUMMARY-OF-READS" } };
        },
      },
      storage: {
        get: async (k) => store.get(k),
        set: async (k, v) => {
          store.set(k, v);
        },
      },
    });
    await mod.default.setup(ctx3);
    const byName3 = Object.fromEntries(tools3.map((t) => [t.name, t]));
    const big = "B".repeat(4000);
    const makeReads = () => [
      { role: "tool", content: [{ type: "tool-result", id: "r1", name: "read", input: { filePath: "/tmp/a.ts" }, result: { type: "text", value: `${big}OLD-A` } }] },
      { role: "tool", content: [{ type: "tool-result", id: "r2", name: "read", input: { filePath: "/tmp/a.ts" }, result: { type: "text", value: `${big}NEW-A` } }] },
      { role: "tool", content: [{ type: "tool-result", id: "r3", name: "read", input: { filePath: "/tmp/b.ts" }, result: { type: "text", value: `${big}B` } }] },
    ];
    const msgs = makeReads();
    hooks3.context({ messages: msgs, system: [], tools: {}, sessionID: "ses_compress", model: {}, agent: "build" });
    check(
      "context-pruner prunes output superseded by a newer read",
      valText(msgs[0].content[0].result.value).includes("superseded") && msgs[1].content[0].result.value === `${big}NEW-A`,
    );

    const res = await byName3.compress.execute({ last: 3, topic: "files" }, { sessionID: "ses_compress" });
    check("compress summarises the selected range", /Summarised 3 tool result/.test(res.content), res.content);
    check("compress reports the saved tokens", /tokens saved/.test(res.content));
    check(
      "compress uses the calling session's own model (no model override)",
      generateArgs.length === 1 &&
        generateArgs[0].sessionID === "ses_compress" &&
        generateArgs[0].model === undefined &&
        generateArgs[0].providerID === undefined,
    );
    check("compress caches the summary in storage", [...store.keys()].some((k) => String(k).startsWith("summary:")));

    const replay = makeReads();
    hooks3.context({ messages: replay, system: [], tools: {}, sessionID: "ses_compress", model: {}, agent: "build" });
    check("compress replaces the covered range with the summary", valText(replay[0].content[0].result.value).includes("SUMMARY-OF-READS"));
    // The covered range is one run with nothing unrepresented in it, so the
    // span collapses to the digest alone: no pointers, no extra messages.
    check(
      "span collapse folds the rest of the range into the summary",
      replay.length === 1 && valText(replay[0].content[0].result.value).includes("SUMMARY-OF-READS"),
      `messages=${replay.length} value=${valText(replay[0]?.content?.[0]?.result?.value).slice(0, 40)}`,
    );
    check(
      "span collapse leaves no pointer parts behind",
      !JSON.stringify(replay).includes("folded into summary"),
      JSON.stringify(replay).slice(0, 120),
    );
  }

  // Whole-span collapse: a closed run that is fully represented in an applied
  // summary leaves the outgoing request as its digest — message shells, per-unit
  // scaffolding, pointers and the sibling tool-call parts all go. Nothing is
  // written to disk, a tool call never leaves without its result, and a part
  // nothing stands in for blocks its whole run.
  {
    const toolsS = [];
    const hooksS = {};
    await mod.default.setup(
      stubCtx(toolsS, {
        options: {
          notify: "off",
          compressText: true,
          autoSummarize: false,
          minChars: 100,
          keepHeadChars: 0,
          keepRecent: 0,
          keepRecentText: 0,
          keepRecentTurns: 0,
          minReplanTokens: 0,
          purgeErrors: false,
          cacheAware: false,
          proactiveSummarize: false,
          steadyTargetRatio: 0,
        },
        model: { list: () => [{ id: "span", providerID: "p", limit: { context: 100000, output: 100 } }, { id: "tiny", providerID: "p", limit: { context: 300, output: 100 } }] },
        session: {
          hook: async (name, cb) => {
            hooksS[name] = cb;
            return { dispose: async () => {} };
          },
          generate: async () => ({ text: "SUMMARY-OF-SPAN" }),
        },
      }),
    );
    const byS = Object.fromEntries(toolsS.map((t) => [t.name, t]));
    const span = (extra) => [
      { id: "u1", role: "user", content: [{ type: "text", text: `ASK-ONE ${"U".repeat(3000)}` }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: `WORK-ONE ${"W".repeat(3000)}` },
          { type: "tool-call", id: "c1", name: "read", input: { filePath: "/tmp/one.ts" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: `ONE ${"A".repeat(4000)}` } }] },
      {
        id: "a2",
        role: "assistant",
        content: [
          { type: "text", text: `WORK-TWO ${"X".repeat(3000)}` },
          { type: "tool-call", id: "c2", name: "read", input: { filePath: "/tmp/two.ts" } },
        ],
      },
      { id: "t2", role: "tool", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "text", value: `TWO ${"B".repeat(4000)}` } }] },
      ...(extra ? [extra] : []),
      { id: "u2", role: "user", content: [{ type: "text", text: "LIVE-ASK" }] },
      { id: "a3", role: "assistant", content: [{ type: "tool-call", id: "c3", name: "read", input: { filePath: "/tmp/live.ts" } }] },
      { id: "t3", role: "tool", content: [{ type: "tool-result", id: "c3", name: "read", result: { type: "text", value: `LIVE-OUT ${"C".repeat(4000)}` } }] },
    ];
    const ids = (msgs, type) =>
      msgs.flatMap((m) => (m.content ?? []).map((p) => (p.type === type ? p.id : undefined))).filter(Boolean);
    const hook = (sessionID, messages) =>
      hooksS.context({ messages, system: [], tools: {}, sessionID, model: { providerID: "p", modelID: "span" }, agent: "build" });

    hook("ses_span", span());
    const map = await byS.context_map.execute({ sessionID: "ses_span" }, toolCtx);
    check("context_map lists the closed span", /#2 assistant-message/.test(map.content), map.content.split("\n")[2]);
    const res = await byS.compress.execute({ from: 1, to: 5, topic: "closed topic" }, { sessionID: "ses_span" });
    check("compress covers the whole closed span", /Summarised 5/.test(res.content), res.content);

    const replay = span();
    hook("ses_span", replay);
    check("span collapse keeps the digest", JSON.stringify(replay).includes("SUMMARY-OF-SPAN"));
    check(
      "span collapse removes the whole closed run",
      replay.length === 4,
      `messages=${replay.length} ids=${replay.map((m) => m.id).join(",")}`,
    );
    check(
      "span collapse drops the folded pairs together",
      !JSON.stringify(replay).includes("folded into summary") &&
        !ids(replay, "tool-result").includes("c1") &&
        !ids(replay, "tool-result").includes("c2"),
      `results=${ids(replay, "tool-result").join(",")}`,
    );
    check(
      "span collapse never splits a tool call from its result",
      JSON.stringify(ids(replay, "tool-call")) === JSON.stringify(ids(replay, "tool-result")),
      `calls=${ids(replay, "tool-call").join(",")} results=${ids(replay, "tool-result").join(",")}`,
    );
    check(
      "span collapse leaves the live turn alone",
      replay.some((m) => m.id === "u2" && m.content[0].text === "LIVE-ASK") &&
        JSON.stringify(replay).includes("LIVE-OUT"),
      `messages=${replay.length}`,
    );

    // Deterministic: the same transcript compiles to the same request again.
    const replayAgain = span();
    hook("ses_span", replayAgain);
    check(
      "span collapse is idempotent",
      JSON.stringify(replayAgain) === JSON.stringify(replay),
      `messages=${replayAgain.length} vs ${replay.length}`,
    );
    // A tiny result below the compressible floor stays raw, and a raw part
    // blocks its run: the run before it still folds, the message itself does not.
    const tiny = () => ({ id: "tiny", role: "tool", content: [{ type: "tool-result", id: "c9", name: "bash", result: { type: "text", value: "TINY".padEnd(50, "z") } }] });
    hook("ses_span_block", span(tiny()));
    await byS.compress.execute({ from: 1, to: 5, topic: "closed topic" }, { sessionID: "ses_span_block" });
    const replayBlocked = span(tiny());
    hook("ses_span_block", replayBlocked);
    check(
      "an unrepresented part stops the span at its boundary",
      replayBlocked.length === 5 && JSON.stringify(replayBlocked).includes("TINY") && replayBlocked.some((m) => m.id === "tiny"),
      `messages=${replayBlocked.length} ids=${replayBlocked.map((m) => m.id).join(",")}`,
    );

    // Stubs are not summaries: with nothing compressed, no message leaves — even
    // when the window is tight enough that every stale output gets stubbed.
    const stubbed = span();
    hooksS.context({
      messages: stubbed,
      system: [],
      tools: {},
      sessionID: "ses_span_raw",
      model: { providerID: "p", modelID: "tiny" },
      agent: "build",
    });
    check(
      "stubs alone never collapse a span",
      stubbed.length === 8 && stubbed.some((m) => JSON.stringify(m).includes("pruned")),
      `messages=${stubbed.length} stubbed=${stubbed.filter((m) => JSON.stringify(m).includes("pruned")).length}`,
    );

    // collapseRanges:false restores the stubbing behaviour: pointers stay inline.
    const toolsOff = [];
    const hooksOff = {};
    await mod.default.setup(
      stubCtx(toolsOff, {
        options: {
          notify: "off",
          compressText: true,
          autoSummarize: false,
          minChars: 100,
          keepRecent: 0,
          keepRecentText: 0,
          keepRecentTurns: 0,
          minReplanTokens: 0,
          purgeErrors: false,
          cacheAware: false,
          proactiveSummarize: false,
          steadyTargetRatio: 0,
          collapseRanges: false,
        },
        model: { list: () => [{ id: "span", providerID: "p", limit: { context: 100000, output: 100 } }] },
        session: {
          hook: async (name, cb) => {
            hooksOff[name] = cb;
            return { dispose: async () => {} };
          },
          generate: async () => ({ text: "SUMMARY-OF-SPAN" }),
        },
      }),
    );
    const byOff = Object.fromEntries(toolsOff.map((t) => [t.name, t]));
    const offHook = (sessionID, messages) =>
      hooksOff.context({ messages, system: [], tools: {}, sessionID, model: { providerID: "p", modelID: "span" }, agent: "build" });
    offHook("ses_span_off", span());
    await byOff.compress.execute({ from: 1, to: 5, topic: "closed topic" }, { sessionID: "ses_span_off" });
    const replayOff = span();
    offHook("ses_span_off", replayOff);
    check(
      "span collapse can be disabled",
      replayOff.length === 8 && JSON.stringify(replayOff).includes("folded into summary"),
      `messages=${replayOff.length}`,
    );
  }

  // Prose compression: opt-in whole-message compression. DCP's structural edge
  // is that it can compress assistant/user text; with compressText:true the
  // compress tool and autoSummarize can target text parts. The transcript is
  // never mutated, a tool-call never moves, and the part keeps type "text".
  {
    const toolsP = [];
    const hooksP = {};
    const storeP = new Map();
    const generateP = [];
    const ctxP = stubCtx(toolsP, {
      options: {
        keepRecent: 0,
        keepRecentText: 0,
        keepRecentTurns: 0,
        minChars: 10000,
        keepHeadChars: 0,
        notify: "off",
        minReplanTokens: 0,
        autoSummarize: false,
        compressText: true,
        cacheAware: false,
      },
      session: {
        hook: async (name, cb) => {
          hooksP[name] = cb;
          return { dispose: async () => {} };
        },
        generate: async (a) => {
          generateP.push(a);
          return { text: "SUMMARY-OF-PROSE" };
        },
      },
      storage: {
        get: async (k) => storeP.get(k),
        set: async (k, v) => {
          storeP.set(k, v);
        },
      },
    });
    await mod.default.setup(ctxP);
    const byP = Object.fromEntries(toolsP.map((t) => [t.name, t]));
    const makeProse = () => [
      { id: "pu1", role: "user", content: [{ type: "text", text: `USER-ASK ${"U".repeat(300)}` }] },
      {
        id: "pa1",
        role: "assistant",
        content: [
          { type: "text", id: "ptxt1", text: `ASSIST-PROSE ${"P".repeat(600)}` },
          { type: "tool-call", id: "ptc1", name: "read", input: { filePath: "/tmp/p.ts" } },
        ],
      },
      {
        id: "pr1",
        role: "tool",
        content: [{ type: "tool-result", id: "ptc1", name: "read", result: { type: "text", value: `TOOL-OUT ${"T".repeat(600)}` } }],
      },
    ];
    const msgsP = makeProse();
    hooksP.context({ messages: msgsP, system: [], tools: {}, sessionID: "ses_prose", model: {}, agent: "build" });
    const mapP = await byP.context_map.execute({ sessionID: "ses_prose" }, toolCtx);
    check("context_map lists prose as compressible when compressText is on", /user-message/.test(mapP.content) && /assistant-message/.test(mapP.content), mapP.content);

    const resP = await byP.compress.execute({ from: 2, to: 2, topic: "reasoning" }, { sessionID: "ses_prose" });
    check("compress can summarise an assistant text part", /Summarised 1/.test(resP.content), resP.content);
    check("prose summary is generated from the text part", generateP.length === 1 && generateP[0].prompt.includes("ASSIST-PROSE"));

    const replayP = makeProse();
    hooksP.context({ messages: replayP, system: [], tools: {}, sessionID: "ses_prose", model: {}, agent: "build" });
    check(
      "assistant prose is replaced by a prose summary",
      replayP[1].content[0].type === "text" && replayP[1].content[0].text.startsWith("[context prose summary] SUMMARY-OF-PROSE"),
      replayP[1].content[0].text,
    );
    check(
      "the tool-call stays adjacent to its part (no split)",
      replayP[1].content.length === 2 && replayP[1].content[1].type === "tool-call" && replayP[1].content[1].id === "ptc1",
    );
    check("the tool result is untouched by a prose-only summary", replayP[2].content[0].result.value === `TOOL-OUT ${"T".repeat(600)}`);

    const replayP2 = makeProse();
    hooksP.context({ messages: replayP2, system: [], tools: {}, sessionID: "ses_prose", model: {}, agent: "build" });
    check("prose summary application is idempotent", replayP2[1].content[0].text === replayP[1].content[0].text);
    const reportP = await byP.context_report.execute({ sessionID: "ses_prose" }, toolCtx);
    check("context_report distinguishes prose summaries", /1 prose/.test(reportP.content), reportP.content.split("\n").find((l) => l.includes("active summaries")));

    // protectUserMessages keeps user text out even with compressText on.
    const toolsQ = [];
    const hooksQ = {};
    await mod.default.setup(
      stubCtx(toolsQ, {
        options: { notify: "off", compressText: true, protectUserMessages: true, minChars: 10000, keepRecentText: 0, keepRecentTurns: 0 },
        session: {
          hook: async (name, cb) => {
            hooksQ[name] = cb;
            return { dispose: async () => {} };
          },
        },
      }),
    );
    const byQ = Object.fromEntries(toolsQ.map((t) => [t.name, t]));
    hooksQ.context({ messages: makeProse(), system: [], tools: {}, sessionID: "ses_prose_user", model: {}, agent: "build" });
    const mapQ = await byQ.context_map.execute({ sessionID: "ses_prose_user" }, toolCtx);
    check(
      "protectUserMessages keeps user text out of the compressible pool",
      !/user-message/.test(mapQ.content) && /assistant-message/.test(mapQ.content),
      mapQ.content,
    );
  }

  // Automatic prose compression (the DCP uncapped model-driven path): when the
  // request is over budget, autoSummarize may target prose too.
  {
    const toolsA = [];
    const hooksA = {};
    const generateA = [];
    const ctxA = stubCtx(toolsA, {
      options: {
        notify: "off",
        compressText: true,
        autoSummarize: true,
        autoSummarizeMaxCalls: 0,
        autoSummarizeMinTokens: 100,
        minChars: 100,
        keepRecent: 0,
        keepRecentText: 0,
        keepRecentTurns: 0,
        cacheAware: false,
        minReplanTokens: 0,
      },
      session: {
        hook: async (name, cb) => {
          hooksA[name] = cb;
          return { dispose: async () => {} };
        },
        generate: async (a) => {
          generateA.push(a);
          return { text: "SUMMARY-AUTO-PROSE" };
        },
      },
      model: { list: () => [{ id: "m3", providerID: "p3", limit: { context: 1000, output: 100 } }] },
    });
    await mod.default.setup(ctxA);
    const byA = Object.fromEntries(toolsA.map((t) => [t.name, t]));
    const makeProseA = () =>
      [0, 1, 2, 3, 4, 5].map((n) => ({
        id: `pc${n}`,
        role: n % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `${n % 2 === 0 ? "USER" : "ASSIST"} ${"T".repeat(2000)}` }],
      }));
    hooksA.context({ messages: makeProseA(), system: [], tools: {}, sessionID: "ses_prose_auto", model: { providerID: "p3", modelID: "m3" }, agent: "build" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("autoSummarize includes prose when over budget", generateA.length >= 1 && /assistant-message|user-message/.test(generateA[0].prompt));
    const replayA = makeProseA();
    hooksA.context({ messages: replayA, system: [], tools: {}, sessionID: "ses_prose_auto", model: { providerID: "p3", modelID: "m3" }, agent: "build" });
    check(
      "autoSummarize replaces prose with a prose summary",
      replayA[0].content[0].text.startsWith("[context prose summary] SUMMARY-AUTO-PROSE"),
      replayA[0].content[0].text,
    );
  }

  // Proactive steady state: with a wide window the compiler still compacts
  // toward a small steady ceiling instead of waiting for the window to fill.
  {
    const big = "W".repeat(4000);
    const makeWide = () =>
      Array.from({ length: 6 }, (_, i) => ({
        role: "tool",
        content: [{ type: "tool-result", id: `w${i}`, name: "read", input: { filePath: `/tmp/f${i}.ts` }, result: { type: "text", value: `${big}O${i}` } }],
      }));
    const runWide = async (sessionID, options) => {
      const toolsW = [];
      const hooksW = {};
      await mod.default.setup(
        stubCtx(toolsW, {
          options: { notify: "off", minChars: 10, keepHeadChars: 10, keepRecent: 1, keepRecentTurns: 0, minReplanTokens: 0, purgeErrors: false, autoSummarize: false, ...options },
          model: { list: () => [{ id: "wide", providerID: "p", limit: { context: 60000, output: 100 } }] },
          session: { hook: async (n, cb) => { hooksW[n] = cb; return { dispose: async () => {} }; } },
        }),
      );
      const msgs = makeWide();
      hooksW.context({ messages: msgs, system: [], tools: {}, sessionID, model: { providerID: "p", modelID: "wide" }, agent: "build" });
      return msgs;
    };
    const on = await runWide("ses_wide_on", {});
    const prunedOn = on.filter((m) => valText(m.content[0].result.value).includes("pruned")).length;
    check("context-pruner proactively compacts under a wide window", prunedOn >= 1, `pruned=${prunedOn}`);
    check(
      "context-pruner keeps the live turn under proactive compaction",
      valText(on[5].content[0].result.value).endsWith("O5"),
      valText(on[5].content[0].result.value).slice(0, 40),
    );
    const off = await runWide("ses_wide_off", { proactiveSummarize: false });
    const prunedOff = off.filter((m) => valText(m.content[0].result.value).includes("pruned")).length;
    check("proactive compaction can be disabled", prunedOff === 0, `pruned=${prunedOff}`);
  }

  // Proactive summarisation: over the steady ceiling, stale closed units are
  // collapsed into a model summary even though the window is far from full, and
  // the live turn (its user message and tool output) is never summarised.
  {
    const toolsB = [];
    const hooksB = {};
    const generateB = [];
    await mod.default.setup(
      stubCtx(toolsB, {
        options: {
          notify: "off",
          compressText: true,
          autoSummarize: true,
          autoSummarizeMaxCalls: 0,
          autoSummarizeMinTokens: 100,
          minChars: 100,
          keepHeadChars: 10,
          keepRecent: 1,
          keepRecentText: 0,
          keepRecentTurns: 0,
          minReplanTokens: 0,
          purgeErrors: false,
          cacheAware: false,
        },
        model: { list: () => [{ id: "wide", providerID: "p", limit: { context: 60000, output: 100 } }] },
        session: {
          hook: async (n, cb) => {
            hooksB[n] = cb;
            return { dispose: async () => {} };
          },
          generate: async (a) => {
            generateB.push(a);
            return { text: "PROACTIVE-SUM" };
          },
        },
      }),
    );
    const big = "S".repeat(4000);
    const makeB = () => [
      { id: "u0", role: "user", content: [{ type: "text", text: `USER-TOPIC-ONE ${"U".repeat(8000)}` }] },
      ...[0, 1, 2, 3].map((i) => ({
        role: "tool",
        content: [{ type: "tool-result", id: `s${i}`, name: "read", input: { filePath: `/tmp/s${i}.ts` }, result: { type: "text", value: `${big}OUT${i}` } }],
      })),
      { id: "u1", role: "user", content: [{ type: "text", text: `USER-TOPIC-TWO ${"V".repeat(2000)}` }] },
      { role: "tool", content: [{ type: "tool-result", id: "s9", name: "read", input: { filePath: "/tmp/live.ts" }, result: { type: "text", value: `${big}LIVE` } }] },
    ];
    hooksB.context({ messages: makeB(), system: [], tools: {}, sessionID: "ses_proactive", model: { providerID: "p", modelID: "wide" }, agent: "build" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("context-pruner proactively summarises stale output", generateB.length >= 1, `calls=${generateB.length}`);
    const replayB = makeB();
    hooksB.context({ messages: replayB, system: [], tools: {}, sessionID: "ses_proactive", model: { providerID: "p", modelID: "wide" }, agent: "build" });
    check("context-pruner applies the proactive summary", replayB[0].content[0].text.includes("PROACTIVE-SUM"), replayB[0].content[0].text.slice(0, 60));
    // Collapse changes the array shape, so the live turn is located by identity.
    const liveTool = replayB.find((m) =>
      (m.content ?? []).some((p) => p.type === "tool-result" && p.id === "s9"),
    );
    const liveUser = replayB.find((m) => m.id === "u1");
    check(
      "context-pruner never summarises the live turn",
      Boolean(liveTool) && liveTool.content[0].result.value.endsWith("LIVE"),
      liveTool ? liveTool.content[0].result.value.slice(0, 40) : `messages=${replayB.length}`,
    );
    check(
      "context-pruner never summarises the live user message",
      Boolean(liveUser) && liveUser.content[0].text.includes("USER-TOPIC-TWO"),
      liveUser ? liveUser.content[0].text.slice(0, 40) : `messages=${replayB.length}`,
    );
    check(
      "span collapse reduces a summarised transcript to its digest",
      replayB.length < 7 && replayB[0].content.length === 1,
      `messages=${replayB.length} first parts=${replayB[0].content.length}`,
    );
  }

  // Recall persistence: a pruned output is written through to storage and a
  // later plugin instance can still recall it by id.
  {
    const store = new Map();
    const mkHooks = async (tools) => {
      const h = {};
      await mod.default.setup(
        stubCtx(tools, {
          options: { keepRecent: 1, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false },
          session: {
            hook: async (name, cb) => {
              h[name] = cb;
              return { dispose: async () => {} };
            },
          },
          storage: {
            get: async (k) => store.get(k),
            set: async (k, v) => {
              store.set(k, v);
            },
          },
        }),
      );
      return h;
    };

    const sid = "ses_recall_persist";
    const big = "P".repeat(4000);
    const toolsA = [];
    const hooksA = await mkHooks(toolsA);
    const msgsA = [
      { role: "tool", content: [{ type: "tool-result", id: "p1", name: "read", input: { filePath: "/tmp/p.ts" }, result: { type: "text", value: `${big}OLD` } }] },
      { role: "tool", content: [{ type: "tool-result", id: "p2", name: "read", input: { filePath: "/tmp/p.ts" }, result: { type: "text", value: `${big}NEW` } }] },
    ];
    hooksA.context({ messages: msgsA, system: [], tools: {}, sessionID: sid, model: {}, agent: "build" });
    const persistMatch = /context_pruner_recall with id \\"([0-9a-f]+)\\"/.exec(JSON.stringify(msgsA));
    await new Promise((resolve) => setTimeout(resolve, 10));
    check(
      "pruned output is persisted to storage for recall",
      Boolean(persistMatch) && store.has(`recall:${sid}`),
      `keys=${[...store.keys()].join(",")}`,
    );

    // A session whose in-memory cache is empty (fresh process) hydrates recall
    // from storage on first use.
    const sid2 = "ses_recall_hydrate";
    const seeded = "HYDRATED-" + "H".repeat(200);
    store.set(`recall:${sid2}`, [{ id: "deadbeef", tool: "read", text: seeded, chars: seeded.length, at: Date.now() }]);
    const toolsB = [];
    const hooksB = await mkHooks(toolsB);
    hooksB.context({
      messages: [{ role: "tool", content: [{ type: "tool-result", id: "q1", name: "read", input: { filePath: "/tmp/q.ts" }, result: { type: "text", value: "small output" } }] }],
      system: [],
      tools: {},
      sessionID: sid2,
      model: {},
      agent: "build",
    });
    const byB = Object.fromEntries(toolsB.map((t) => [t.name, t]));
    const recalledFromStore = await byB.context_pruner_recall.execute({ id: "deadbeef" }, { sessionID: sid2 });
    check(
      "recall hydrates from storage when the in-memory cache is empty",
      recalledFromStore.content.includes("HYDRATED"),
      `recalled ${recalledFromStore.content.length} chars`,
    );
  }

  // Paths on case-insensitive filesystems must compare equal for superseded
  // detection, while the reason keeps the original path casing.
  {
    const tools4 = [];
    const hooks4 = {};
    await mod.default.setup(
      stubCtx(tools4, {
        options: { keepRecent: 1, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false },
        session: {
          hook: async (name, cb) => {
            hooks4[name] = cb;
            return { dispose: async () => {} };
          },
        },
      }),
    );
    const big = "C".repeat(4000);
    const msgs4 = [
      { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", input: { filePath: "/tmp/A.ts" }, result: { type: "text", value: `${big}OLD` } }] },
      { role: "tool", content: [{ type: "tool-result", id: "c2", name: "read", input: { filePath: "/tmp/a.TS" }, result: { type: "text", value: `${big}NEW` } }] },
    ];
    hooks4.context({ messages: msgs4, system: [], tools: {}, sessionID: "ses_case", model: {}, agent: "build" });
    const value4 = valText(msgs4[0].content[0].result.value);
    const folded = value4.includes("superseded");
    check(
      "superseded compares paths case-insensitively on win32",
      folded === (process.platform === "win32"),
      `folded=${folded} platform=${process.platform}`,
    );
    if (folded) {
      check(
        "superseded reason keeps the original path casing",
        value4.includes("/tmp/A.ts"),
        value4.split("\n")[0].slice(0, 120),
      );
    }
  }

  // Real cache-cost accounting: pruned tokens are valued at the premium of
  // fresh input over cache reads once caching is observed.
  {
    const toolsC = [];
    const hooksC = {};
    let usageC;
    await mod.default.setup(
      stubCtx(toolsC, {
        options: { keepRecent: 2, notify: false },
        model: { list: () => [{ id: "priced", providerID: "prov", cost: [{ input: 3, cache: { read: 0.3, write: 3.75 } }] }] },
        session: {
          hook: async (name, cb) => {
            hooksC[name] = cb;
            return { dispose: async () => {} };
          },
        },
        event: {
          subscribe: (cb) => {
            usageC = cb;
            return () => {};
          },
        },
      }),
    );
    hooksC.context({
      messages: [{ role: "tool", content: [{ type: "tool-result", id: "z1", name: "read", result: { type: "text", value: "Z".repeat(5000) } }] }],
      system: [],
      tools: {},
      options: {},
      sessionID: "ses_cost",
      model: { providerID: "prov", id: "priced" },
      agent: "build",
    });
    usageC({ type: "session.usage.updated", data: { sessionID: "ses_cost", tokens: { input: 1000, cache: { read: 10000, write: 0 } } } });
    const byC = Object.fromEntries(toolsC.map((t) => [t.name, t]));
    const costReport = await byC.context_report.execute({ sessionID: "ses_cost" }, toolCtx);
    check(
      "context_report prices saved tokens net of cache reads",
      /estimated cost saved: \$0\.0000 \(at \$2\.70\/M input − cache read\)/.test(costReport.content),
      costReport.content.split("\n").find((line) => line.includes("estimated cost saved")),
    );
    check(
      "context_report shows cache savings versus input price",
      /cache savings: \$0\.0270 \(10000 cached tokens vs input price\)/.test(costReport.content),
      costReport.content.split("\n").find((line) => line.includes("cache savings")),
    );
  }

  // Config hot reload: editing context-pruner.jsonc must take effect on the
  // running plugin without a plugin-file reload.
  {
    const configDir = join(sandbox, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "context-pruner.jsonc");
    writeFileSync(configPath, JSON.stringify({ titleShortCircuit: false, notify: false }));
    const toolsH = [];
    const hooksH = {};
    const cleanup = await mod.default.setup(
      stubCtx(toolsH, {
        options: { notify: false },
        session: {
          hook: async (name, cb) => {
            hooksH[name] = cb;
            return { dispose: async () => {} };
          },
        },
      }),
    );
    const byH = Object.fromEntries(toolsH.map((t) => [t.name, t]));
    hooksH.context({
      messages: [{ role: "tool", content: [{ type: "tool-result", id: "h1", name: "read", result: { type: "text", value: "hello" } }] }],
      system: [],
      tools: {},
      options: {},
      sessionID: "ses_hotreload",
      model: {},
      agent: "build",
    });
    const beforeReload = await byH.context_report.execute({ sessionID: "ses_hotreload" }, toolCtx);
    check(
      "config hot reload starts from the on-disk config",
      /hooks: .*title=off/.test(beforeReload.content),
      beforeReload.content.split("\n").find((line) => line.startsWith("hooks:")),
    );
    writeFileSync(configPath, JSON.stringify({ titleShortCircuit: true, notify: false }));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const afterReload = await byH.context_report.execute({ sessionID: "ses_hotreload" }, toolCtx);
    check(
      "config edits hot-reload into the running plugin",
      /hooks: .*title=on/.test(afterReload.content),
      afterReload.content.split("\n").find((line) => line.startsWith("hooks:")),
    );
    if (typeof cleanup === "function") await cleanup();
  }

  // Retry polish: a halved recovery target persists until the request fits,
  // and a successful request clears the overflow state.
  {
    const toolsR = [];
    const hooksR = {};
    let usageR;
    await mod.default.setup(
      stubCtx(toolsR, {
        options: { notify: false },
        model: { list: () => [{ id: "bigwin", providerID: "prov", limit: { context: 10000, output: 1000 } }] },
        session: {
          hook: async (name, cb) => {
            hooksR[name] = cb;
            return { dispose: async () => {} };
          },
        },
        event: {
          subscribe: (cb) => {
            usageR = cb;
            return () => {};
          },
        },
      }),
    );
    const byR = Object.fromEntries(toolsR.map((t) => [t.name, t]));
    hooksR.context({
      messages: [{ role: "tool", content: [{ type: "tool-result", id: "w1", name: "read", result: { type: "text", value: "W".repeat(500) } }] }],
      system: [],
      tools: {},
      options: {},
      sessionID: "ses_retry",
      model: { providerID: "prov", id: "bigwin" },
      agent: "build",
    });
    const retryEvt = { sessionID: "ses_retry", error: "maximum context length exceeded", attempt: 1, decision: undefined };
    hooksR.retry(retryEvt);
    check("retry hook asks for a small backoff", retryEvt.decision?.retry === true && retryEvt.decision?.delay === 250, `delay=${retryEvt.decision?.delay}`);
    const retryReport = await byR.context_report.execute({ sessionID: "ses_retry" }, toolCtx);
    check(
      "retry hook sets a halved recovery target",
      /retry state: recover target 4000  attempts 1/.test(retryReport.content),
      retryReport.content.split("\n").find((line) => line.startsWith("retry state:")),
    );
    usageR({ type: "session.usage.updated", data: { sessionID: "ses_retry", tokens: { input: 100, cache: { read: 0, write: 0 } } } });
    const clearedReport = await byR.context_report.execute({ sessionID: "ses_retry" }, toolCtx);
    check(
      "a successful request clears the overflow state",
      /retry state: recover target n\/a  attempts 0/.test(clearedReport.content),
      clearedReport.content.split("\n").find((line) => line.startsWith("retry state:")),
    );
  }

  // Summary integrity: a summary whose source output changed is dropped and
  // its results become eligible again.
  {
    const toolsS = [];
    const hooksS = {};
    const storeS = new Map();
    await mod.default.setup(
      stubCtx(toolsS, {
        options: { keepRecent: 10, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false },
        session: {
          hook: async (name, cb) => {
            hooksS[name] = cb;
            return { dispose: async () => {} };
          },
          generate: async () => ({ data: { text: "SUMMARY-XYZ" } }),
        },
        storage: {
          get: async (k) => storeS.get(k),
          set: async (k, v) => {
            storeS.set(k, v);
          },
        },
      }),
    );
    const byS = Object.fromEntries(toolsS.map((t) => [t.name, t]));
    const bigS = "S".repeat(4000);
    const makeS = (tag) => [
      { role: "tool", content: [{ type: "tool-result", id: "s1", name: "read", input: { filePath: "/tmp/s1.ts" }, result: { type: "text", value: `${bigS}${tag}-A` } }] },
      { role: "tool", content: [{ type: "tool-result", id: "s2", name: "read", input: { filePath: "/tmp/s2.ts" }, result: { type: "text", value: `${bigS}${tag}-B` } }] },
    ];
    const sidS = "ses_integrity";
    const firstS = makeS("ONE");
    hooksS.context({ messages: firstS, system: [], tools: {}, options: {}, sessionID: sidS, model: {}, agent: "build" });
    const compressed = await byS.compress.execute({ last: 2, topic: "files" }, { sessionID: sidS });
    check("summary records the source hashes", /Summarised 2 tool result/.test(compressed.content), compressed.content);
    const sameS = makeS("ONE");
    hooksS.context({ messages: sameS, system: [], tools: {}, options: {}, sessionID: sidS, model: {}, agent: "build" });
    check("an unchanged source keeps its summary", valText(sameS[0].content[0].result.value).includes("SUMMARY-XYZ"));
    const changedS = makeS("TWO");
    hooksS.context({ messages: changedS, system: [], tools: {}, options: {}, sessionID: sidS, model: {}, agent: "build" });
    check(
      "a changed source drops its summary",
      valText(changedS[0].content[0].result.value).includes("TWO-A") && !valText(changedS[0].content[0].result.value).includes("SUMMARY-XYZ"),
      valText(changedS[0].content[0].result.value).slice(0, 60),
    );
    const reportS = await byS.context_report.execute({ sessionID: sidS }, toolCtx);
    check(
      "dropped summary frees the results for re-summarising",
      /active summaries: 0/.test(reportS.content),
      reportS.content.split("\n").find((line) => line.includes("active summaries")),
    );
  }

  // Pruned results are rewritten as text with an array value, the shape core
  // sends (`result.value.map(...)` in SessionModelRequest.prepare). A string
  // value here crashes every later request.
  {
    const toolsJ = [];
    const hooksJ = {};
    await mod.default.setup(
      stubCtx(toolsJ, {
        options: { keepRecent: 1, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false },
        session: {
          hook: async (name, cb) => {
            hooksJ[name] = cb;
            return { dispose: async () => {} };
          },
        },
      }),
    );
    const msgsJ = [
      { role: "tool", content: [{ type: "tool-result", id: "j1", name: "read", result: { type: "json", value: { x: "y".repeat(5000) } } }] },
      { role: "tool", content: [{ type: "tool-result", id: "j2", name: "read", result: { type: "text", value: "recent" } }] },
    ];
    hooksJ.context({ messages: msgsJ, system: [], tools: {}, options: {}, sessionID: "ses_json", model: {}, agent: "build" });
    const jr = msgsJ[0].content[0].result;
    check(
      "a pruned json result is rewritten as sendable text",
      jr.type === "text" && Array.isArray(jr.value) && valText(jr.value).includes("pruned"),
      `type=${jr.type} value=${typeof jr.value}`,
    );
  }

  // Storage GC: summaries per session are capped, oldest evicted first.
  {
    const toolsG = [];
    const hooksG = {};
    const storeG = new Map();
    await mod.default.setup(
      stubCtx(toolsG, {
        options: { keepRecent: 10, keepRecentTurns: 0, minChars: 10, keepHeadChars: 10, notify: "off", minReplanTokens: 0, purgeErrors: false, summaryKeep: 2 },
        session: {
          hook: async (name, cb) => {
            hooksG[name] = cb;
            return { dispose: async () => {} };
          },
          generate: async () => ({ data: { text: "SUM-G" } }),
        },
        storage: {
          get: async (k) => storeG.get(k),
          set: async (k, v) => {
            storeG.set(k, v);
          },
        },
      }),
    );
    const byG = Object.fromEntries(toolsG.map((t) => [t.name, t]));
    const bigG = "G".repeat(3000);
    const msgsG = [1, 2, 3, 4, 5, 6].map((n) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `g${n}`, name: "read", input: { filePath: `/tmp/g${n}.ts` }, result: { type: "text", value: `${bigG}-${n}` } }],
    }));
    const sidG = "ses_gc";
    hooksG.context({ messages: msgsG, system: [], tools: {}, options: {}, sessionID: sidG, model: {}, agent: "build" });
    await byG.compress.execute({ from: "g1", to: "g2", topic: "a" }, { sessionID: sidG });
    await byG.compress.execute({ from: "g3", to: "g4", topic: "b" }, { sessionID: sidG });
    await byG.compress.execute({ from: "g5", to: "g6", topic: "c" }, { sessionID: sidG });
    const storedG = storeG.get(`summaries:${sidG}`);
    check(
      "summary storage is capped per session",
      Array.isArray(storedG) && storedG.length === 2,
      `length=${Array.isArray(storedG) ? storedG.length : "n/a"}`,
    );
    check(
      "summary GC evicts the oldest record",
      Array.isArray(storedG) && !storedG.some((r) => r.covers.includes("t:g1")),
      JSON.stringify(storedG?.map?.((r) => r.covers)),
    );
  }
}

// --------------------------------------------------------- strip-skills-catalog
{
  const mod = await import(new URL("../plugins/strip-skills-catalog.ts", import.meta.url));
  check(
    "strip-skills-catalog exposes a default plugin",
    mod.default.id === "strip-skills-catalog" && typeof mod.default.setup === "function",
  );

  const hooks = {};
  const ctx = stubCtx([], {
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  });
  await mod.default.setup(ctx);

  const system = [
    {
      type: "text",
      text:
        "Intro line.\n\nSkills provide specialized instructions and workflows for specific tasks.\n" +
        "Use the skill tool to load a skill when a task matches its description.\n" +
        "<available_skills>\n  <skill>alpha</skill>\n</available_skills>\n\nOutro line.",
    },
  ];
  hooks.context({ system, messages: [], tools: {}, options: {}, sessionID: "s", model: {}, agent: "build" });
  const text = system[0].text;
  check("strip-skills-catalog removes the skills block", !text.includes("available_skills") && !text.includes("alpha"));
  check("strip-skills-catalog keeps the surrounding prompt", text.includes("Intro line.") && text.includes("Outro line."));
}

// ---------------------------------------------------------------- decision-log
{
  const mod = await import(new URL("../plugins/decision-log.ts", import.meta.url));
  check(
    "decision-log exposes a default plugin",
    mod.default.id === "decision-log" && typeof mod.default.setup === "function",
  );
  const tools = [];
  await mod.default.setup(stubCtx(tools));
  check("decision-log registers 5 tools", tools.length === 5, tools.map((t) => t.name).join(", "));
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const logged = await by.decision_log.execute(
    { title: "Use SQLite", decision: "store decisions in sqlite", context: "recall needed", tags: ["storage"], status: "accepted" },
    toolCtx,
  );
  check("decision_log inserts and returns an id", /Logged decision #1/.test(logged.content), logged.content);

  const got = await by.decision_get.execute({ id: 1 }, toolCtx);
  check("decision_get returns the decision", got.content.includes("Use SQLite") && got.content.includes("store decisions in sqlite"));

  const found = await by.decision_search.execute({ query: "sqlite" }, toolCtx);
  check("decision_search finds it in this session", found.content.includes("Use SQLite"));

  const scoped = await by.decision_search.execute({ query: "sqlite" }, { ...toolCtx, sessionID: "ses_other" });
  check("decision_search is session-scoped by default", scoped.content === "No decisions found.");

  const listed = await by.decision_list.execute({ tags: ["storage"] }, toolCtx);
  check("decision_list filters by tag", listed.content.includes("Showing 1 of 1"));

  const updated = await by.decision_update.execute({ id: 1, status: "deprecated", consequences: "migrated later" }, toolCtx);
  check("decision_update changes fields", updated.content.includes("Status: deprecated") && updated.content.includes("migrated later"));
}

// --------------------------------------------------------------- error-journal
{
  const mod = await import(new URL("../plugins/error-journal.ts", import.meta.url));
  check(
    "error-journal exposes a default plugin",
    mod.default.id === "error-journal" && typeof mod.default.setup === "function",
  );
  const tools = [];
  await mod.default.setup(stubCtx(tools));
  check("error-journal registers 5 tools", tools.length === 5, tools.map((t) => t.name).join(", "));
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const logged = await by.error_log.execute({ error_text: "TypeError: boom", context: "npm run build", tags: ["typescript"] }, toolCtx);
  check("error_log inserts and returns an id", /Logged error #1/.test(logged.content), logged.content);

  const resolved = await by.error_resolve.execute({ id: 1, resolution: "pin typescript" }, toolCtx);
  check("error_resolve records a resolution", /Resolved error #1/.test(resolved.content));

  const found = await by.error_search.execute({ query: "boom" }, toolCtx);
  check("error_search finds it and shows the resolution", found.content.includes("TypeError: boom") && found.content.includes("pin typescript"));

  const resolvedOnly = await by.error_list.execute({ resolved: true }, toolCtx);
  check("error_list filters by resolved", resolvedOnly.content.includes("TypeError: boom"));

  const deleted = await by.error_delete.execute({ id: 1 }, toolCtx);
  check("error_delete removes it", /Deleted error #1/.test(deleted.content));
  const empty = await by.error_list.execute({}, toolCtx);
  check("error_list is empty after delete", empty.content === "No errors found.");
}

// ------------------------------------------------------------- snippet-library
{
  const mod = await import(new URL("../plugins/snippet-library.ts", import.meta.url));
  check(
    "snippet-library exposes a default plugin",
    mod.default.id === "snippet-library" && typeof mod.default.setup === "function",
  );
  const tools = [];
  await mod.default.setup(stubCtx(tools));
  check("snippet-library registers 5 tools", tools.length === 5, tools.map((t) => t.name).join(", "));
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const saved = await by.snippet_save.execute(
    { title: "Read file", code: "const zzSnippetToken = readFileSync(p);", language: "typescript", tags: ["io"] },
    toolCtx,
  );
  check("snippet_save inserts and returns an id", /Saved snippet #1/.test(saved.content), saved.content);

  const found = await by.snippet_search.execute({ query: "zzSnippetToken", language: "typescript" }, toolCtx);
  check("snippet_search finds the code", found.content.includes("zzSnippetToken"));

  const byLang = await by.snippet_list.execute({ language: "python" }, toolCtx);
  check("snippet_list filters by language", byLang.content === "No snippets found.");

  const got = await by.snippet_get.execute({ id: 1 }, toolCtx);
  check("snippet_get returns full code", got.content.includes("const zzSnippetToken = readFileSync(p);"));

  const deleted = await by.snippet_delete.execute({ id: 1 }, toolCtx);
  check("snippet_delete removes it", /Deleted snippet #1/.test(deleted.content));
}

// -------------------------------------------------------------- codebase-index
{
  const mod = await import(new URL("../plugins/codebase-index.ts", import.meta.url));
  check(
    "codebase-index exposes a default plugin",
    mod.default.id === "codebase-index" && typeof mod.default.setup === "function",
  );
  const tools = [];
  await mod.default.setup(stubCtx(tools));
  check("codebase-index registers 4 tools", tools.length === 4, tools.map((t) => t.name).join(", "));
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const proj = join(tmpdir(), "opencode-codebase-verify");
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "widget.ts"), "export function zzUniqueWidgetToken() { return 42; }\n");

  const indexed = JSON.parse((await by.codebase_index.execute({ path: proj }, toolCtx)).content);
  check("codebase_index indexes a project", indexed.indexed === true && indexed.files >= 1 && indexed.chunks >= 1, JSON.stringify(indexed));

  const status = JSON.parse((await by.codebase_index_status.execute({ path: proj }, toolCtx)).content);
  check("codebase_index_status reports the project", status.indexed === true && status.files >= 1);

  const searched = await by.codebase_search.execute({ query: "zzUniqueWidgetToken", path: proj }, toolCtx);
  check("codebase_search finds the indexed symbol", searched.content.includes("widget.ts") && searched.content.includes("zzUniqueWidgetToken"), searched.content.split("\n")[0]);

  const missing = await by.codebase_search.execute({ query: "zzUniqueWidgetToken", path: sandbox }, toolCtx);
  check("codebase_search reports an existing but unindexed project", /not indexed/.test(missing.content));

  const deleted = JSON.parse((await by.codebase_delete_index.execute({ path: proj }, toolCtx)).content);
  check("codebase_delete_index removes the project", deleted.deleted === true);
  const after = JSON.parse((await by.codebase_index_status.execute({ path: proj }, toolCtx)).content);
  check("codebase_index_status is empty after delete", after.indexed === false);

  rmSync(proj, { recursive: true, force: true });
}

// ------------------------------------------------------------ opencode-sessions
{
  const mod = await import(new URL("../plugins/opencode-sessions.ts", import.meta.url));
  check(
    "opencode-sessions exposes a default plugin",
    mod.default.id === "opencode-sessions" && typeof mod.default.setup === "function",
  );
  const tools = [];
  const ctx = stubCtx(tools, {
    event: {
      // Never yields; cleanup() aborts and the process exits at the end.
      subscribe: async function* () {
        await new Promise(() => {});
      },
    },
  });
  const cleanup = await mod.default.setup(ctx);
  const names = tools.map((t) => t.name).sort();
  check(
    "opencode-sessions registers its 7 tools",
    names.join(",") ===
      "list_sessions,session_cancel,session_handoff,session_permission,session_result,session_send,spawn_session",
    names.join(", "),
  );
  if (typeof cleanup === "function") await cleanup();
  check("opencode-sessions cleanup is callable", true);
}

// ------------------------------------------- context-pruner: XDG config lookup
{
  const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
  const { globalConfigDirs, configCandidatePaths } = mod.__test__;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;

  try {
    // Default Linux/macOS box with XDG_CONFIG_HOME unset: the legacy
    // ~/.config path must still be searched or existing installs break.
    delete process.env.XDG_CONFIG_HOME;
    const base = globalConfigDirs();
    check(
      "config lookup falls back to ~/.config/opencode with XDG_CONFIG_HOME unset",
      base.includes(join(home, ".config", "opencode")),
      base.join(" | "),
    );

    // Relocated XDG_CONFIG_HOME must be honoured, and searched before the
    // legacy path so a moved config actually wins.
    const xdgHome = join(sandbox, "xdg-config");
    process.env.XDG_CONFIG_HOME = xdgHome;
    const withXdg = globalConfigDirs();
    check(
      "config lookup honors XDG_CONFIG_HOME",
      withXdg[0] === join(xdgHome, "opencode"),
      withXdg.join(" | "),
    );
    check(
      "XDG path is searched before the legacy ~/.config path",
      withXdg.indexOf(join(xdgHome, "opencode")) <
        withXdg.indexOf(join(home, ".config", "opencode")),
      withXdg.join(" | "),
    );

    // An empty/whitespace XDG_CONFIG_HOME must not produce a bogus relative
    // path like "opencode/context-pruner.jsonc".
    process.env.XDG_CONFIG_HOME = "   ";
    check(
      "blank XDG_CONFIG_HOME is ignored, not turned into a relative path",
      !globalConfigDirs().some((d) => !isAbsolute(d)),
      globalConfigDirs().join(" | "),
    );

    // Every candidate must be absolute and de-duplicated, or the plugin would
    // resolve config relative to the process cwd.
    process.env.XDG_CONFIG_HOME = xdgHome;
    const cands = configCandidatePaths(undefined);
    check(
      "all config candidates are absolute paths",
      cands.every((c) => isAbsolute(c)),
      cands.filter((c) => !isAbsolute(c)).join(" | "),
    );
    check(
      "config candidates are de-duplicated",
      new Set(cands).size === cands.length,
      cands.join(" | "),
    );
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  }
}

// The SQLite plugins keep their module-level DB handles open, so on Windows the
// sandbox files are still locked here. Leave them for the next run's initial
// rmSync (this process releases the handles on exit).
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* locked by this process's open DB handles; the next run cleans it up */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
