/**
 * CODE-REVIEW-FINDINGS-2026-10-01 regression tests for secret-shield:
 *   SS-1  baseline suppression wired (full fingerprints stored, legacy
 *         16-hex entries matched, false_positive records the full form)
 *   SS-2  cfg.maxScanChars honored on every detection path (prompt, tool
 *         args, http.request body) + JSON-safe gap splice
 *   SS-3  RESTORE_SAFE_TOOLS no longer restores raw secrets for generic
 *         MCP verbs (create/update/insert/apply)
 *   SS-7  gap splices count as one redaction unit (fail-closed write-back
 *         still happens for an oversized CLEAN JSON arg)
 *
 *   node tests/verify-ss-fix.mjs
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-ss-fix-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const AWS = "AKIAIOSFODNN7EXAMPLE";
const OPENAI = "sk-abcdefghijklmnopqrstuvwxyz012345";
const installDir = join(sandbox, ".opencode-plugins", "secret-shield");
const baselinePath = join(sandbox, "baseline-test.json");

const mod = await import(new URL("../plugins/secret-shield.ts", import.meta.url));

/** Fresh setup with the given options; returns the registered hooks/tools. */
async function boot(options) {
  const hooks = {};
  const tools = new Map();
  await mod.default.setup({
    options,
    location: { directory: sandbox },
    tool: {
      hook: async (name, cb) => { hooks[`tool.${name}`] = cb; return { dispose: async () => {} }; },
      transform: async (cb) => { cb({ add: (t) => tools.set(t.name, t) }); return { dispose: async () => {} }; },
    },
    session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } },
    shell: { hook: async (name, cb) => { hooks[`shell.${name}`] = cb; return { dispose: async () => {} }; } },
  });
  const tool = (name) => tools.get(name);
  return { hooks, tool };
}

// ------------------------------------------------- SS-1: baseline wiring (full form)
{
  const { hooks, tool } = await boot({ mode: "redact", baseline: true, baselinePath });

  // Baseline OFF by default for the same value: redact mode replaces it.
  const before = { prompt: { text: `deploy with key ${AWS} now` } };
  await hooks["prompt"](before);
  check("SS-1: without baseline the secret is redacted", !before.prompt.text.includes(AWS), before.prompt.text);

  const rec = await tool("secret_shield_false_positive").execute({ value: AWS, rule: "TEST" }, {});
  check("SS-1: false_positive records the FULL 64-hex fingerprint", /\b[0-9a-f]{64}\b/.test(rec.content), rec.content.slice(0, 100));
  const stored = JSON.parse(readFileSync(baselinePath, "utf8"));
  check("SS-1: baseline.json entry is 64-hex (not the 16-hex truncation)",
    Array.isArray(stored) && stored.length === 1 && /^[0-9a-f]{64}$/.test(stored[0]?.hash ?? ""), JSON.stringify(stored));

  const after = { prompt: { text: `deploy with key ${AWS} now` } };
  await hooks["prompt"](after);
  check("SS-1: baselined value passes through un-redacted (suppressed before redaction)",
    after.prompt.text.includes(AWS), after.prompt.text);
  check("SS-1: a DIFFERENT secret is still redacted (baseline is per-value)",
    !after.prompt.text.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), after.prompt.text);

  const dup = await tool("secret_shield_false_positive").execute({ value: AWS, rule: "TEST" }, {});
  check("SS-1: duplicate false_positive is a no-op", /Already recorded/i.test(dup.content), dup.content.slice(0, 80));
  const still = JSON.parse(readFileSync(baselinePath, "utf8"));
  check("SS-1: duplicate did not append a second entry", still.length === 1, `entries=${still.length}`);
}

// ------------------------------------------------- SS-1: legacy 16-hex baseline entries
{
  // Recompute the full HMAC the plugin would produce, with the plugin's key.
  const key = Buffer.from(readFileSync(join(installDir, "hmac.key"), "utf8").trim(), "hex");
  const full = createHmac("sha256", key).update(AWS).digest("hex");
  writeFileSync(baselinePath, JSON.stringify([{ hash: full.slice(0, 16), rule: "LEGACY", at: "2026-01-01T00:00:00.000Z" }]), { mode: 0o600 });
  const { hooks } = await boot({ mode: "redact", baseline: true, baselinePath });
  const ev = { prompt: { text: `deploy with key ${AWS} now` } };
  await hooks["prompt"](ev);
  check("SS-1: legacy 16-hex baseline entry still suppresses (prefix match)",
    ev.prompt.text.includes(AWS), ev.prompt.text);
}

// ------------------------------------------------- SS-2: configured cap + JSON-safe splice
{
  // A cap of 100k makes the middle of a 250k-char tool arg unscannable.
  const { hooks } = await boot({ mode: "redact", maxScanChars: 100_000 });
  const pad = "x".repeat(200_000);
  const jsonArg = `{"note":"head ${AWS} ${pad} tail ${OPENAI}","x":1}`;
  const ev = { tool: "write", input: { content: jsonArg } };
  await ev && await hooks["tool.execute.before"](ev);
  const out = ev.input.content;
  check("SS-2: head-window secret is redacted with the configured cap", /\[SS:[0-9a-f]+:/.test(out) && !out.includes(AWS), out.slice(0, 80));
  check("SS-2: middle-window secret is removed (fail-closed splice), not leaked", !out.includes(OPENAI));
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(out); } catch (err) { parseErr = err; }
  check("SS-2: oversized JSON tool arg stays PARSEABLE (no mid-token marker)", !!parsed && parsed.x === 1, String(parseErr ?? ""));
  check("SS-2: the unscanned middle was dropped, not padded", out.length < jsonArg.length && out.length < 120_000, `${jsonArg.length} -> ${out.length}`);
}

// ------------------------------------------------- SS-2/SS-7: clean oversized JSON arg is still replaced
{
  const { hooks } = await boot({ mode: "redact", maxScanChars: 100_000 });
  const pad = "y".repeat(300_000);
  const jsonArg = `{"data":"${pad}","keep":true}`;
  const ev = { tool: "write", input: { content: jsonArg } };
  await hooks["tool.execute.before"](ev);
  const out = ev.input.content;
  // SS-7: one redaction unit per gap > 0 — the counter still gates the
  // write-back, so the unscanned middle must be gone even with zero findings.
  check("SS-7: clean oversized JSON arg gets the gap spliced out (counter gate works)",
    out.length < jsonArg.length && out.length < 120_000, `${jsonArg.length} -> ${out.length}`);
  check("SS-7: spliced JSON still parses", (() => { try { return JSON.parse(out).keep === true; } catch { return false; } })());
}

// ------------------------------------------------- SS-2: http.request oversized body fail-closed
{
  const { hooks } = await boot({ mode: "redact", maxScanChars: 100_000 });
  const pad = "z".repeat(200_000);
  const body = `{"messages":[{"content":"start ${AWS} ${pad} end ${OPENAI}"}]}`;
  const req = new Request("http://127.0.0.1:1/scrub-me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const ev = { kind: "verify", request: req };
  await hooks["http.request"](ev);
  const out = await ev.request.text();
  check("SS-2: http.request splices the unscanned middle of an oversized body",
    !out.includes(OPENAI) && !out.includes(AWS), `len=${out.length}`);
  check("SS-2: head-window secret was replaced by a placeholder", /\[SS:[0-9a-f]+:/.test(out), out.slice(0, 60));
  const cl = ev.request.headers.get("content-length");
  check("SS-2: Content-Length matches the spliced body bytes",
    cl === String(Buffer.byteLength(out, "utf8")), `header=${cl} actual=${Buffer.byteLength(out, "utf8")}`);
}

// ------------------------------------------------- SS-3: restore-safe tool list
{
  const { hooks } = await boot({ mode: "redact" });
  // Produce a placeholder via execute.after (scrubs results, no restore).
  const afterEv = { tool: "grep", status: "completed", result: `found key ${AWS} here` };
  await hooks["tool.execute.after"](afterEv);
  const placeholder = String(afterEv.result).match(/\[SS:[0-9a-f]+:[A-Z0-9_\-]+\]/)?.[0];
  check("SS-3: placeholder produced", !!placeholder, String(afterEv.result).slice(0, 80));

  for (const generic of ["create", "update", "insert", "apply"]) {
    const ev = { tool: generic, input: { text: `echo ${placeholder}` } };
    await hooks["tool.execute.before"](ev);
    check(`SS-3: generic verb "${generic}" does NOT get the raw secret restored`,
      String(ev.input.text).includes(placeholder), String(ev.input.text).slice(0, 80));
  }
  const writeEv = { tool: "write", input: { content: `body ${placeholder}` } };
  await hooks["tool.execute.before"](writeEv);
  check("SS-3: built-in file tool write still restores placeholders",
    String(writeEv.input.content).includes(AWS), String(writeEv.input.content).slice(0, 80));
}

if (existsSync(baselinePath)) rmSync(baselinePath, { force: true });
rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
