/**
 * Mock-context verification for the session-export plugin.
 *
 * Runs the real plugin source against a stub context (no opencode server) and
 * exercises rendering, filtering, redaction and file output.
 *
 *   node tests/verify-session-export.mjs
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the home directory so the redaction rewrite check is deterministic.
const FAKE_HOME = "C:\\Users\\verify-user";
process.env.USERPROFILE = FAKE_HOME; // Windows
process.env.HOME = FAKE_HOME; // POSIX

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// ------------------------------------------------------------- fixtures

const TOKEN = "sk-abcdef0123456789ABCDEF";
const USER_PATH = "C:\\Users\\verify-user\\project\\api.ts";
const NOW = 1700000000000;

const messages = [
  {
    id: "msg_user",
    type: "user",
    time: { created: NOW },
    text: `Please review ${USER_PATH} and note the key ${TOKEN}.`,
  },
  {
    id: "msg_asst",
    type: "assistant",
    time: { created: NOW + 1, completed: NOW + 2 },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    cost: 0.0123,
    tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
    content: [
      { type: "text", text: "I will check the file." },
      { type: "reasoning", text: "Private reasoning about ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345." },
      {
        type: "tool",
        id: "call_1",
        name: "bash",
        state: { status: "completed", input: { command: "cat C:\\Users\\verify-user\\project\\api.ts" }, content: [{ type: "text", text: "file1\nfile2" }] },
        time: { created: NOW + 1 },
      },
      {
        type: "tool",
        id: "call_2",
        name: "webfetch",
        state: { status: "error", input: { url: "https://example.com" }, error: { type: "http", message: "request failed" } },
        time: { created: NOW + 2 },
      },
    ],
  },
  { id: "msg_sys", type: "system", time: { created: NOW + 2 }, text: "System context note." },
  {
    id: "msg_comp",
    type: "compaction",
    time: { created: NOW + 3 },
    status: "completed",
    reason: "auto",
    summary: "Earlier context was compacted.",
    recent: "recent tail",
  },
];

function stubCtx() {
  const tools = [];
  return {
    tools,
    ctx: {
      options: {},
      location: { directory: tmpdir() },
      session: { context: async () => messages },
      tool: {
        transform: async (cb) => {
          cb({ add: (t) => tools.push(t) });
          return { dispose: async () => {} };
        },
      },
    },
  };
}

const toolCtx = {
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  progress: async () => {},
};

// --------------------------------------------------------------- setup

const mod = await import(new URL("../plugins/session-export.ts", import.meta.url));

const instance = stubCtx();
await mod.default.setup(instance.ctx);
const by = Object.fromEntries(instance.tools.map((t) => [t.name, t]));

check("registers session_export", typeof by.session_export?.execute === "function");
check("registers session_export_info", typeof by.session_export_info?.execute === "function");

const fresh = stubCtx();
await mod.default.setup(fresh.ctx);
const freshInfo = Object.fromEntries(fresh.tools.map((t) => [t.name, t]));
const info0 = (await freshInfo.session_export_info.execute({}, toolCtx)).content;
check(
  "info reports config + no exports yet",
  info0.includes("default export dir") && info0.includes("no exports yet") && info0.includes("redact: true"),
  info0,
);

// --------------------------------------------------------- rendering

const md = (await by.session_export.execute({ inline: true }, toolCtx)).content;
check("markdown has header", md.includes("# Session export") && md.includes("ses_test"), md.split("\n")[0]);
check("markdown header has counts + model", md.includes("Messages: 4") && md.includes("anthropic/claude-sonnet-4"));
check("markdown has user text", md.includes("Please review"));
check("markdown excludes reasoning by default", !md.includes("Private reasoning"));
check("markdown has tool calls", md.includes("tool: bash") && md.includes("tool: webfetch"));

const js = (await by.session_export.execute({ inline: true, format: "json" }, toolCtx)).content;
const parsed = JSON.parse(js);
check("json parses with right message count", Array.isArray(parsed.messages) && parsed.messages.length === 4, `got ${parsed.messages?.length}`);
check("json meta counts messages + tool calls", parsed.meta.messageCount === 4 && parsed.meta.toolCalls === 2, JSON.stringify(parsed.meta));
check("json excludes reasoning by default", !JSON.stringify(parsed).includes("Private reasoning"));

const jl = (await by.session_export.execute({ inline: true, format: "jsonl" }, toolCtx)).content;
const jlLines = jl.split("\n").filter((l) => l.trim());
check("jsonl has one line per message", jlLines.length === 4, `got ${jlLines.length}`);
check(
  "jsonl lines are valid json",
  jlLines.every((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  }),
);

const txt = (await by.session_export.execute({ inline: true, format: "text" }, toolCtx)).content;
check("text format renders plain", txt.includes("SESSION EXPORT") && txt.includes("Please review") && !txt.includes("##"));

// ----------------------------------------------------------- filtering

const withR = (await by.session_export.execute({ inline: true, format: "json", includeReasoning: true }, toolCtx)).content;
check("includeReasoning includes reasoning", withR.includes("Private reasoning"));
check("reasoning secret is redacted", !withR.includes("ghp_") && withR.includes("[redacted github token]"));

const rolesOnly = (await by.session_export.execute({ inline: true, format: "json", roles: ["user"] }, toolCtx)).content;
check("roles allowlist filters messages", JSON.parse(rolesOnly).messages.length === 1 && JSON.parse(rolesOnly).messages[0].role === "user");

const toolsOnly = (await by.session_export.execute({ inline: true, format: "markdown", tools: ["bash"] }, toolCtx)).content;
check("tools allowlist keeps bash", toolsOnly.includes("tool: bash"));
check("tools allowlist drops webfetch", !toolsOnly.includes("webfetch"));

const noTools = (await by.session_export.execute({ inline: true, format: "markdown", includeToolCalls: false }, toolCtx)).content;
check("includeToolCalls:false drops tool parts", !noTools.includes("tool: bash") && noTools.includes("Please review"));

const noResults = (await by.session_export.execute({ inline: true, format: "markdown", includeToolResults: false }, toolCtx)).content;
check(
  "includeToolResults:false keeps call but drops output",
  noResults.includes("tool: bash") && !noResults.includes("output:") && !noResults.includes("request failed"),
);

const trunc = (await by.session_export.execute({ inline: true, format: "markdown", maxCharsPerPart: 5 }, toolCtx)).content;
check("maxCharsPerPart truncates with a marker", trunc.includes("[truncated"));

// ----------------------------------------------------------- redaction

const redacted = (await by.session_export.execute({ inline: true, format: "markdown" }, toolCtx)).content;
check("redacts sk- token", !redacted.includes(TOKEN) && redacted.includes("[redacted api key]"));
check("rewrites home dir to ~", !redacted.includes(FAKE_HOME) && redacted.includes("~\\project\\api.ts"));
check("rewrites home dir in tool input", !redacted.includes("verify-user"));

const raw = (await by.session_export.execute({ inline: true, format: "markdown", redact: false }, toolCtx)).content;
check("redact:false keeps raw content", raw.includes(TOKEN) && raw.includes(FAKE_HOME));

// -------------------------------------------------------- file output

const dir1 = mkdtempSync(join(tmpdir(), "sx-one-"));
const first = await by.session_export.execute({ dest: dir1, format: "markdown" }, toolCtx);
const afterFirst = readdirSync(dir1);
check("dest writes a file", afterFirst.length === 1 && first.content.includes("Exported 4 message(s) as markdown"), first.content);
check(
  "written file has rendered content",
  afterFirst.length === 1 && readFileSync(join(dir1, afterFirst[0]), "utf8").includes("# Session export"),
);

const second = await by.session_export.execute({ dest: dir1, format: "markdown" }, toolCtx);
const afterSecond = readdirSync(dir1);
check("second export does not overwrite", afterSecond.length === 2, afterSecond.join(", "));
check("second export returns a different path", first.content !== second.content);

const fileDir = mkdtempSync(join(tmpdir(), "sx-file-"));
const filePath = join(fileDir, "custom.md");
await by.session_export.execute({ dest: filePath, format: "markdown" }, toolCtx);
check("dest as explicit file path", existsSync(filePath));
await by.session_export.execute({ dest: filePath, format: "markdown" }, toolCtx);
check("explicit file collision appends -2", existsSync(join(fileDir, "custom-2.md")));

const dir3 = mkdtempSync(join(tmpdir(), "sx-inline-"));
const inline = await by.session_export.execute({ inline: true, dest: dir3 }, toolCtx);
check(
  "inline:true returns text without writing",
  typeof inline.content === "string" && inline.content.includes("Please review") && readdirSync(dir3).length === 0,
);

// -------------------------------------------------------------- info

const info = (await by.session_export_info.execute({}, toolCtx)).content;
check("info returns a string", typeof info === "string" && info.length > 0);
check("info reports the last export", info.includes("last export:") && info.includes("markdown") && info.includes(".md"), info);

// ------------------------------------------------------------- cleanup

for (const dir of [dir1, fileDir, dir3]) rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
