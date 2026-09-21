/**
 * Mock-context verification for the secret-shield plugin.
 *
 *   node tests/verify-secret-shield.mjs
 *
 * Runs the real plugin source against a stub context (no opencode server) and
 * exercises detection, allowlisting, the redact/block modes, every hook and the
 * secret_shield_* tools. A temp sandbox is used as $HOME so the audit log and
 * HMAC key never touch the real profile.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "secret-shield-"));
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const mod = await import(new URL("../plugins/secret-shield.ts", import.meta.url));
const plugin = mod.default;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL   ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

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

async function boot(env) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE_SECRET_SHIELD_")) delete process.env[key];
  }
  Object.assign(process.env, env || {});
  const { ctx, hooks, tools } = makeCtx();
  await plugin.setup(ctx);
  return { hooks, tools };
}

const toolCtx = { progress: async () => {} };
const readTool = (tools, name, args = {}) => tools.get(name).execute(args, toolCtx);

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GH_TOKEN = `ghp_${"A".repeat(36)}`;
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PW = "Sup3rSecretValue!";

try {
  console.log("detection");
  {
    const { tools } = await boot({});
    const text = [`aws=${AWS_KEY}`, `gh=${GH_TOKEN}`, JWT, `password=${PW}`].join("\n");
    const out = (await readTool(tools, "secret_shield_scan", { text })).content;
    check("scan detects an AWS access key id", out.includes("AWS_ACCESS_KEY_ID"), out);
    check("scan detects a GitHub ghp token", out.includes("GITHUB_GHP"), out);
    check("scan detects a JWT", out.includes("JWT"), out);
    check("scan detects a password= assignment", out.includes("GENERIC_PASSWORD"), out);
    check("scan withholds the AWS key value", !out.includes(AWS_KEY));
    check("scan withholds the GitHub token value", !out.includes(GH_TOKEN));
    check("scan withholds the JWT value", !out.includes(JWT));
    check("scan withholds the password value", !out.includes(PW));
  }

  console.log("entropy");
  {
    const { tools } = await boot({});
    const blob = randomBytes(30).toString("base64"); // 40 chars, high entropy
    const hit = await readTool(tools, "secret_shield_scan", { text: blob });
    check("entropy flags a random 40-char base64 blob", hit.content.includes("SS_ENTROPY"), hit.content);
    const stop = `example${randomBytes(20).toString("hex")}`;
    const miss = await readTool(tools, "secret_shield_scan", { text: stop });
    check("entropy skips a stopword token", !miss.content.includes("SS_ENTROPY"), miss.content);
  }

  console.log("allowlist");
  {
    const literal = `ghp_${"L".repeat(36)}`;
    const regex = `ghp_${"R".repeat(36)}`;
    const { tools } = await boot({ OPENCODE_SECRET_SHIELD_ALLOW: `${literal},/^ghp_R+/` });
    const out = (await readTool(tools, "secret_shield_scan", { text: `${literal}\n${regex}` })).content;
    check("allowlist literal suppresses a match", !out.includes("GITHUB_GHP"), out);
    check("allowlist regex suppresses a match", !out.includes("GITHUB_GHP"), out);
  }

  console.log("redact mode");
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const sk = `sk-${"b".repeat(32)}`;
    const body = JSON.stringify({ messages: [{ role: "user", content: `token ${sk}` }] });
    const request = new Request("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const event = { kind: "title", request, sessionID: "s", agent: "a" };
    await hooks.session["http.request"](event);
    const outText = await event.request.text();
    check("http.request redacts the outbound body", !outText.includes(sk), outText);
    check(
      "http.request emits a hardened placeholder",
      /\[SS:[0-9a-f]+:OPENAI_API_KEY-\d+\]/.test(outText),
      outText,
    );
  }
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const sk = `sk-${"c".repeat(32)}`;
    const event = { prompt: { text: `please use ${sk}` }, sessionID: "s", messageID: "m" };
    await hooks.session.prompt(event);
    check("prompt redaction clears the durable prompt", !event.prompt.text.includes(sk), event.prompt.text);
    check("prompt redaction leaves a placeholder", event.prompt.text.includes("[SS:"), event.prompt.text);
  }
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const original = `ghp_${"Z".repeat(36)}`;
    const event = {
      command: "printenv",
      cwd: ".",
      timeout: 0,
      shell: "bash",
      env: { GITHUB_TOKEN: original, PATH: "/usr/bin" },
    };
    await hooks.shell["create.before"](event);
    check(
      "shell.hook scrubs a secret-looking env value",
      event.env.GITHUB_TOKEN !== original && event.env.GITHUB_TOKEN.startsWith("[SS:"),
      event.env.GITHUB_TOKEN,
    );
    check("shell.hook leaves unrelated env values alone", event.env.PATH === "/usr/bin");
  }
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const noisy = "a3f9c2e1b7d4f6089a1c2e3f4b5d6a7c8e9f0a1b";
    const event = {
      command: "printenv",
      cwd: ".",
      timeout: 0,
      shell: "bash",
      env: {
        Path: noisy, // non-secret key, entropy-only -> must be ignored
        COPILOT_SKILLS_DIRS: noisy, // non-secret key -> ignored
        RUNTIME_CONTROLLER_KEY: noisy, // secret-looking key -> scrubbed
        PATH: `ghp_${"Q".repeat(36)}`, // critical key + real secret -> audited, never clobbered
      },
    };
    await hooks.shell["create.before"](event);
    check(
      "shell.hook ignores entropy-only hits on ordinary vars",
      event.env.Path === noisy && event.env.COPILOT_SKILLS_DIRS === noisy,
    );
    check(
      "shell.hook scrubs a secret-looking key even without a pattern hit",
      event.env.RUNTIME_CONTROLLER_KEY.startsWith("[SS:"),
      event.env.RUNTIME_CONTROLLER_KEY,
    );
    check(
      "shell.hook never clobbers a critical env var (PATH)",
      event.env.PATH.startsWith("ghp_"),
      event.env.PATH.slice(0, 12) + "...",
    );
  }
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const sk = `sk-${"d".repeat(32)}`;
    const event = {
      tool: "bash",
      input: { command: `echo ${sk}` },
      sessionID: "s",
      agent: "a",
      messageID: "m",
      id: "c",
    };
    await hooks.tool["execute.before"](event);
    check("execute.before redacts secrets in input", !event.input.command.includes(sk), event.input.command);
    check("execute.before leaves a placeholder", event.input.command.includes("[SS:"), event.input.command);
  }
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "redact" });
    const sk = `sk-${"e".repeat(32)}`;
    const event = {
      tool: "bash",
      status: "completed",
      result: { content: `out ${sk}` },
      sessionID: "s",
      agent: "a",
      messageID: "m",
      id: "c",
      input: {},
    };
    await hooks.tool["execute.after"](event);
    check("execute.after redacts tool output", !event.result.content.includes(sk), event.result.content);
  }

  console.log("audit log");
  {
    const auditPath = join(sandbox, ".opencode-plugins", "secret-shield", "audit.jsonl");
    check("audit log file was written", existsSync(auditPath));
    const content = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
    check("audit log stores an HMAC hash", /"valueHash":"[0-9a-f]{64}"/.test(content));
    check("audit log never stores the secret value", !content.includes(`sk-${"b".repeat(32)}`));
    let valid = content.trim().length > 0;
    try {
      for (const line of content.split("\n").filter(Boolean)) JSON.parse(line);
    } catch {
      valid = false;
    }
    check("audit log is valid JSONL", valid);
  }

  console.log("block mode");
  {
    const { hooks } = await boot({ OPENCODE_SECRET_SHIELD_MODE: "block" });
    const attempt = async (p) => {
      try {
        await hooks.tool["execute.before"]({
          tool: "read",
          input: { filePath: p },
          sessionID: "s",
          agent: "a",
          messageID: "m",
          id: "c",
        });
        return null;
      } catch (err) {
        return err;
      }
    };
    const denied = await attempt(join(sandbox, ".env"));
    check(
      "block mode denies a .env read",
      denied instanceof Error && /protected secret file/.test(denied.message),
      denied && denied.message,
    );
    check("block mode allows .env.example", (await attempt(join(sandbox, ".env.example"))) === null);
    check("block mode denies an id_rsa read", (await attempt("/home/u/.ssh/id_rsa")) instanceof Error);
  }

  console.log("tools");
  {
    const { tools } = await boot({});
    const names = [...tools.keys()].sort();
    const expected = [
      "secret_shield_keys",
      "secret_shield_scan",
      "secret_shield_shape",
      "secret_shield_stats",
    ];
    check("all four tools are registered", expected.every((n) => names.includes(n)), names.join(","));
    const stats = (await readTool(tools, "secret_shield_stats")).content;
    check(
      "secret_shield_stats returns a string report",
      typeof stats === "string" && stats.includes("mode:") && stats.includes("rules:"),
      stats,
    );
    const envPath = join(sandbox, "sample.env");
    writeFileSync(envPath, "SECRET_KEY=abcdef1234567890\nPLAIN=value\n# comment\n");
    const shape = (await readTool(tools, "secret_shield_shape", { path: envPath })).content;
    check(
      "secret_shield_shape returns names/lengths but no values",
      shape.includes("SECRET_KEY") && shape.includes("len=") && !shape.includes("abcdef1234567890"),
      shape,
    );
    const keys = (await readTool(tools, "secret_shield_keys", { path: envPath })).content;
    check(
      "secret_shield_keys lists names only",
      keys.includes("SECRET_KEY") && !keys.includes("abcdef1234567890"),
      keys,
    );
  }
} catch (err) {
  failed += 1;
  console.log(`FAIL   unexpected exception — ${err && err.stack ? err.stack : String(err)}`);
} finally {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

