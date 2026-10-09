/**
 * CODE-REVIEW-FINDINGS-2026-10-01 regression tests for session-export:
 *   SE-1  exports never clobber an existing file (exclusive create) and
 *         land with mode 0600
 *   SE-2  content is clamped BEFORE sanitize; a secret beyond the kept
 *         window (or beyond the detection scan cap) never reaches disk
 *   SE-3  csv is a selectable format (tool arg + config) and `.csv` dest
 *         is treated as a file; renderCSV output round-trips
 *   SE-4  fenced code blocks actually render as highlighted <pre>
 *   SE-5  home-path rewriting fires on `=`, `[`, `:` boundaries too
 *
 *   node tests/verify-se-fix.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_FIX = "/home/se-fix-user";
process.env.HOME = HOME_FIX;
process.env.USERPROFILE = HOME_FIX;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const AWS = "AKIAIOSFODNN7EXAMPLE";
const OPENAI = "sk-abcdefghijklmnopqrstuvwxyz012345";
const NOW = 1700000000000;

const mod = await import(new URL("../plugins/session-export.ts", import.meta.url));

function boot(options, messages, dir) {
  const tools = new Map();
  const setup = mod.default.setup({
    options,
    location: { directory: dir ?? mkdtempSync(join(tmpdir(), "se-fix-loc-")) },
    session: { context: async () => messages },
    tool: { transform: async (cb) => { cb({ add: (t) => tools.set(t.name, t) }); return { dispose: async () => {} }; } },
  });
  return { setup, tool: (n) => tools.get(n) };
}

const toolCtx = { sessionID: "ses_sefix", progress: async () => {} };

// ------------------------------------------------- SE-2: clamp before sanitize
{
  const pad = "p".repeat(100_000);
  const messages = [
    { id: "m1", type: "assistant", time: { created: NOW }, content: [
      { type: "text", text: `head ${AWS} ${pad} deep ${OPENAI} ${pad}` },
    ] },
  ];
  const { tool } = boot({}, messages);
  const md = (await tool("session_export").execute({ inline: true }, toolCtx)).content;
  check("SE-2: kept-window secret is redacted", !md.includes(AWS) && /\[redacted/.test(md), md.slice(md.indexOf("head"), md.indexOf("head") + 60));
  check("SE-2: secret beyond the kept window never ships (clamp ran first)", !md.includes(OPENAI));
  check("SE-2: truncation marker present", md.includes("[truncated"));
  check("SE-2: export stays small (no multi-MB sanitize pass shipped)", md.length < 20_000, `len=${md.length}`);
}

// ------------------------------------------------- SE-1: exclusive write, 0600, no clobber
{
  const messages = [
    { id: "m1", type: "user", time: { created: NOW }, text: `key ${AWS}` },
  ];
  const dir = mkdtempSync(join(tmpdir(), "se-fix-dest-"));
  const { tool } = boot({}, messages, dir);
  const target = join(dir, "custom.md");
  const SENTINEL = "DO-NOT-CLOBBER";
  writeFileSync(target, SENTINEL);

  const res = await tool("session_export").execute({ dest: target }, toolCtx);
  check("SE-1: pre-existing dest file is not clobbered", readFileSync(target, "utf8") === SENTINEL);
  const m = res.content.match(/to (\S+\.md) /);
  check("SE-1: export landed on a different path", !!m && m[1] !== target, res.content.slice(0, 120));
  if (m && existsSync(m[1])) {
    const body = readFileSync(m[1], "utf8");
    check("SE-1: the export file actually contains the rendered content", body.includes("# Session export"), m[1]);
    // writeFileSyncExclusive passes mode 0o600, but `mode` is a POSIX concept:
    // on Windows it is ignored and the file lands with the default 0666. The
    // plugin already comments this (session-export.ts) — Windows privacy comes
    // from the ACL, not the mode bits. Assert the POSIX contract only where
    // the mode bits actually apply.
    const mode = statSync(m[1]).mode & 0o777;
    if (process.platform === "win32") {
      check("SE-1: export file exists and is readable on Windows", typeof body === "string" && body.length > 0);
    } else {
      check("SE-1: export file created with mode 0600", mode === 0o600, mode.toString(8));
    }
  } else {
    check("SE-1: the export file actually contains the rendered content", false, "no path in result");
    check("SE-1: export file created with mode 0600", false, "no file");
  }
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- SE-3: csv round-trip
{
  const messages = [
    { id: "m1", type: "user", time: { created: NOW }, text: "run it" },
    { id: "m2", type: "assistant", time: { created: NOW + 1 }, content: [
      { type: "text", text: "calling bash" },
      { type: "tool", name: "bash", state: { status: "completed", input: { command: "ls -la" }, content: [{ type: "text", text: "a\nb" }] } },
      { type: "tool", name: "webfetch", state: { status: "error", input: { url: "https://x" }, error: { type: "http", message: "boom" } } },
    ] },
  ];
  const { tool } = boot({}, messages);
  const csv = (await tool("session_export").execute({ inline: true, format: "csv" }, toolCtx)).content;
  const lines = csv.trim().split("\n");
  check("SE-3: csv selectable via tool arg (header)", lines[0] === "index,role,tool_name,status,input_length,output_length,error", lines[0]);
  check("SE-3: csv has one row per tool call", lines.length === 3, `lines=${lines.length}`);
  check("SE-3: csv bash row present with output length", /bash,completed,/.test(lines[1] ?? ""), lines[1]);
  check("SE-3: csv error row flagged", /webfetch,error,.*yes/.test(lines[2] ?? ""), lines[2]);

  // config-driven default + .csv dest treated as a FILE
  const dir = mkdtempSync(join(tmpdir(), "se-fix-csv-"));
  // The export dir must be inside the plugin's project dir (SE confinement),
  // so the location and the dest share one root.
  const cfgBoot = boot({ format: "csv" }, messages, dir);
  const destFile = join(dir, "tools.csv");
  const res = await cfgBoot.tool("session_export").execute({ dest: destFile }, toolCtx);
  check("SE-3: format from config option renders csv", existsSync(destFile) && readFileSync(destFile, "utf8").startsWith("index,role"), res.content.slice(0, 120));
  check("SE-3: .csv dest is treated as a file, not a directory", existsSync(destFile) && statSync(destFile).isFile());
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- SE-4: fenced code renders as highlighted <pre>
{
  const messages = [
    { id: "m1", type: "assistant", time: { created: NOW }, content: [
      { type: "text", text: "before\n```js\nconst x = \"y\";\nif (a < b) { }\n```\nafter" },
    ] },
  ];
  const { tool } = boot({}, messages);
  const html = (await tool("session_export").execute({ inline: true, format: "html", redact: false }, toolCtx)).content;
  const body = html.split("<main>")[1] ?? html;
  check("SE-4: fence becomes a <pre> block", body.includes("<pre>"), body.slice(0, 200));
  check("SE-4: highlightCode runs (keyword + string spans)", body.includes("tok-kw") && body.includes("tok-str"));
  check("SE-4: language recorded as a class", body.includes("language-js"), body.slice(body.indexOf("<pre>"), body.indexOf("<pre>") + 60));
  check("SE-4: code content HTML-escaped", body.includes("&lt;"));
  check("SE-4: language tag is not emitted as a stray paragraph", !/<p>js/.test(body));
  check("SE-4: surrounding paragraphs survive", body.includes("<p>before") && body.includes("after</p>"));
}

// ------------------------------------------------- SE-5: home boundary class
{
  // HOME must be LOW entropy — a high-entropy path would be (correctly)
  // swallowed by the SS_ENTROPY rule before the home rewrite could show it.
  const H = "/home/aa";
  process.env.HOME = H;
  process.env.USERPROFILE = H;
  const messages = [
    { id: "m1", type: "user", time: { created: NOW },
      text: `cwd=${H}/app at:${H}/log files:[${H}/src] keep=x${H}/Z/f` },
  ];
  const { tool } = boot({}, messages);
  const md = (await tool("session_export").execute({ inline: true }, toolCtx)).content;
  check("SE-5: cwd=<home> rewritten", md.includes("cwd=~/app"), md.slice(md.indexOf("cwd="), md.indexOf("cwd=") + 40));
  check("SE-5: :<home> rewritten", md.includes("at:~/log"));
  check("SE-5: [<home> rewritten", md.includes("[~/src]"));
  check("SE-5: home preceded by a non-delimiter char NOT rewritten (L104 intact)",
    md.includes("keep=x/home/aa/Z/f"), md.slice(md.indexOf("keep="), md.indexOf("keep=") + 40));
  check("SE-5: no boundary-delimited raw home left in output",
    !md.includes(`cwd=${H}`) && !md.includes(`:${H}`) && !md.includes(`[${H}`));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
