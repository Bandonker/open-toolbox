// SS-1..SS-8 regression checks for plugins/secret-shield.ts + lib/redact.ts.
// Run: node tests/verify-shield-fix.mjs
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "shield-fix-"));
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL   ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}

const redact = await import(new URL("../lib/redact.ts", import.meta.url));
const { collectFindings, buildAllowList, isScanTruncated, scanGaps, readAllowFile } = redact;
const allow = buildAllowList([]);
const AKIA = "AKIAIOSFODNN7EXAMPLE";

function makeCtx() {
  const hooks = { session: {}, tool: {}, shell: {} };
  const tools = new Map();
  const editor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: () => {},
    add: (t) => tools.set(t.name, t),
    update: () => {},
    remove: (id) => tools.delete(id),
  };
  const ctx = {
    options: undefined,
    session: { hook: async (name, cb) => void (hooks.session[name] = cb) },
    tool: {
      hook: async (name, cb) => void (hooks.tool[name] = cb),
      transform: async (cb) => void cb(editor),
    },
    shell: { hook: async (name, cb) => void (hooks.shell[name] = cb) },
  };
  return { ctx, hooks, tools };
}

const mod = await import(new URL("../plugins/secret-shield.ts", import.meta.url));
async function boot(env) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE_SECRET_SHIELD_")) delete process.env[key];
  }
  Object.assign(process.env, env || {});
  const { ctx, hooks, tools } = makeCtx();
  await mod.default.setup(ctx);
  return { hooks, tools };
}
const ids = { sessionID: "s", agent: "a", messageID: "m", id: "c" };
const toolCtx = { progress: async () => {} };

console.log("SS-5: oversize scan covers head+tail with a skip marker");
{
  const pad = "lorem ipsum dolor sit amet consectetur adipiscing elit\n".repeat(45000);
  const tailSecret = `ghp_${"T".repeat(36)}`;
  const big = `deploy key ${AKIA}\n${pad}${tailSecret} end\n`;
  check("SS-5: oversize input is flagged truncated", isScanTruncated(big) === true);
  const findings = collectFindings(big, "test", { entropy: false }, allow);
  check("SS-5: head secret still found", findings.some((f) => f.value === AKIA));
  check("SS-5: tail secret found via tail window", findings.some((f) => f.value === tailSecret));
  check(
    "SS-5: finding offsets map to the original text",
    findings.every((f) => big.slice(f.start, f.end) === f.value),
  );
  const gaps = scanGaps(big);
  check(
    "SS-5: skip marker reports the unscanned middle",
    gaps.length === 1 && gaps[0][0] > 0 && gaps[0][1] > gaps[0][0],
    JSON.stringify(gaps),
  );
  check("SS-5: no gaps on normal input", scanGaps("short text").length === 0);
}

console.log("SS-7: allow file is cached with mtime refresh");
{
  const allowPath = join(process.cwd(), ".secret-shield-allow");
  rmSync(allowPath, { force: true });
  check("SS-7: missing allow file reads empty", readAllowFile().length === 0);
  try {
    writeFileSync(allowPath, `# comment\n${AKIA}\n`);
    const a1 = readAllowFile();
    check("SS-7: allow file literal is read", a1.includes(AKIA));
    check(
      "SS-7: allowlisted value is suppressed",
      collectFindings(`key ${AKIA}`, "t", { entropy: false }, buildAllowList(a1)).length === 0,
    );
    writeFileSync(allowPath, "OTHER_LITERAL\n");
    utimesSync(allowPath, new Date(), new Date(Date.now() + 60000));
    const a2 = readAllowFile();
    check(
      "SS-7: cache refreshes after mtime change",
      a2.includes("OTHER_LITERAL") && !a2.includes(AKIA),
      JSON.stringify(a2),
    );
    check(
      "SS-7: repeated reads are stable (cached)",
      JSON.stringify(readAllowFile()) === JSON.stringify(a2),
    );
  } finally {
    rmSync(allowPath, { force: true });
  }
}

console.log("SS-1: scrub is cycle-safe and depth-capped");
{
  const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
  const sk = `sk-${"f".repeat(32)}`;
  const cyclic = { note: `token ${sk}`, meta: { n: 1 } };
  cyclic.self = cyclic;
  let threw = null;
  const ev1 = { tool: "read", input: cyclic, ...ids };
  try {
    await hooks.tool["execute.before"](ev1);
  } catch (err) {
    threw = err;
  }
  check("SS-1: circular input does not throw", threw === null, threw && threw.message);
  check("SS-1: secret in circular input still redacted", !ev1.input.note.includes(sk));
  let inner = { text: `deep ${AKIA}` };
  for (let i = 0; i < 60; i++) inner = { nested: inner };
  threw = null;
  const ev2 = { tool: "read", input: { top: `key ${AKIA}`, deep: inner }, ...ids };
  try {
    await hooks.tool["execute.before"](ev2);
  } catch (err) {
    threw = err;
  }
  check("SS-1: 60-deep nesting does not throw", threw === null, threw && threw.message);
  check("SS-1: shallow secret still redacted", !ev2.input.top.includes(AKIA));
}

console.log("SS-2: count-gated input assignment");
{
  const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
  const sk = `sk-${"g".repeat(32)}`;
  const ev = { tool: "bash", input: { command: `echo ${sk}` }, ...ids };
  await hooks.tool["execute.before"](ev);
  check(
    "SS-2: redaction still applied through the hook",
    !ev.input.command.includes(sk) && ev.input.command.includes("[SS:"),
    ev.input.command,
  );
  const clean = { tool: "bash", input: { command: "echo hello" }, ...ids };
  await hooks.tool["execute.before"](clean);
  check("SS-2: clean input passes through untouched", clean.input.command === "echo hello");
}

console.log("SS-3: originals map is capped");
{
  const { hooks, tools } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
  for (let i = 0; i < 5100; i++) {
    const tok = `ghp_${"A".repeat(34)}${String(i).padStart(2, "0")}`;
    await hooks.session.prompt({ prompt: { text: `use ${tok}` }, ...ids });
  }
  const stats = await tools.get("secret_shield_stats").execute({}, toolCtx);
  const m = stats.content.match(/originals: (\d+)/);
  check("SS-3: stats exposes the originals count", m !== null, stats.content.slice(0, 200));
  check("SS-3: originals capped at 5000 (FIFO)", m !== null && Number(m[1]) === 5000, m && m[0]);
}

console.log("SS-4: execute.after scrubs nested result structures");
{
  const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
  const sk = `sk-${"h".repeat(32)}`;
  const ev = {
    tool: "bash",
    status: "completed",
    result: {
      content: [{ type: "text", text: `out ${sk}` }],
      output: { nested: { deep: `leak ${sk}` } },
      extra: { list: [`x ${sk}`] },
    },
    input: {},
    ...ids,
  };
  await hooks.tool["execute.after"](ev);
  const dumped = JSON.stringify(ev.result);
  check("SS-4: nested result fully scrubbed", !dumped.includes(sk), dumped.slice(0, 200));
}

console.log("SS-6: http redaction preserves request properties");
{
  const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
  const sk = `sk-${"j".repeat(32)}`;
  const body = JSON.stringify({ messages: [{ content: `token ${sk}` }] });
  const req = new Request("https://api.example.com/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "follow",
    credentials: "same-origin",
    cache: "no-store",
    mode: "cors",
    keepalive: true,
  });
  const ev = { kind: "title", request: req, sessionID: "s", agent: "a" };
  await hooks.session["http.request"](ev);
  const out = await ev.request.text();
  check("SS-6: http body redacted", !out.includes(sk), out.slice(0, 200));
  check("SS-6: redirect preserved", ev.request.redirect === "follow", ev.request.redirect);
  check("SS-6: credentials preserved", ev.request.credentials === "same-origin", ev.request.credentials);
  check("SS-6: cache preserved", ev.request.cache === "no-store", ev.request.cache);
  check("SS-6: mode preserved", ev.request.mode === "cors", ev.request.mode);
  check(
    "SS-6: content-length rebuilt",
    ev.request.headers.get("content-length") === String(Buffer.byteLength(out, "utf8")),
  );
}

console.log("SS-8: block mode denies shell one-liners over protected files");
{
  const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "block" });
  const attempt = async (input, tool = "bash") => {
    try {
      await hooks.tool["execute.before"]({ tool, input, ...ids });
      return null;
    } catch (err) {
      return err;
    }
  };
  const denied = await attempt({ command: "cat .env" });
  check(
    "SS-8: shell one-liner reading .env is denied",
    denied instanceof Error && /\[secret-shield\]/.test(denied.message),
    denied && denied.message,
  );
  check(
    "SS-8: script form with a protected path is denied",
    (await attempt({ script: "cat config/.env && echo done" })) instanceof Error,
  );
  check("SS-8: benign one-liner passes", (await attempt({ command: "echo hello" })) === null);
  check("SS-8: .env.example one-liner passes", (await attempt({ command: "cat .env.example" })) === null);
  check("SS-8: path-based denial unchanged", (await attempt({ filePath: ".env" }, "read")) instanceof Error);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
