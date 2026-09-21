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
import { join } from "node:path";

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
  check("tool-audit registers 3 tools", tools.length === 3, tools.map((t) => t.name).join(", "));

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
  const ctx = stubCtx(tools, {
    options: { keepRecent: 2, minChars: 1000, keepHeadChars: 100, ignoreTools: ["todowrite"] },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  });
  await mod.default.setup(ctx);
  check("context-pruner hooks the context event", typeof hooks.context === "function");
  check("context-pruner registers its stats tool", tools.length === 1 && tools[0].name === "context_pruner_stats");

  const long = "L".repeat(5000);
  const recent = "R".repeat(5000);
  const messages = [
    { role: "tool", content: [{ type: "tool-result", id: "1", name: "read", result: { type: "text", value: long } }] },
    { role: "tool", content: [{ type: "tool-result", id: "2", name: "bash", result: { type: "error", value: "boom" } }] },
    { role: "tool", content: [{ type: "tool-result", id: "3", name: "todowrite", result: { type: "json", value: { x: "y".repeat(5000) } } }] },
    { role: "tool", content: [{ type: "tool-result", id: "4", name: "read", result: { type: "text", value: recent } }] },
    { role: "tool", content: [{ type: "tool-result", id: "5", name: "read", result: { type: "text", value: recent } }] },
  ];
  hooks.context({ messages, system: [], tools: {}, options: {}, sessionID: "ses_test", model: {}, agent: "build" });

  const first = messages[0].content[0].result;
  check("context-pruner trims an old long result", first.type === "text" && first.value.includes("pruned") && first.value.length < long.length);
  check("context-pruner keeps a preview of the trimmed result", first.value.includes("L".repeat(100)));
  check("context-pruner keeps error results", messages[1].content[0].result.value === "boom");
  check("context-pruner honours ignoreTools", messages[2].content[0].result.value.x.length === 5000);
  check("context-pruner leaves recent results untouched", messages[3].content[0].result.value === recent && messages[4].content[0].result.value === recent);

  const stats = await tools[0].execute({}, toolCtx);
  check("context_pruner_stats reports pruned parts", /tool results pruned: 1\b/.test(stats.content), stats.content.split("\n")[7]);
  check("context_pruner_stats reports saved chars", /characters saved: [1-9]/.test(stats.content));
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
