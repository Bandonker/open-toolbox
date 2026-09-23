/**
 * H5/H6 verification for secret-shield.
 *
 * H5: collectFindings must not silently skip oversize input — the head of
 *     the text is still scanned and truncation is detectable/reportable.
 * H6: audit.jsonl must rotate instead of growing unbounded.
 *
 *   node tests/verify-shield-limits.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-shield-limits-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const { collectFindings, isScanTruncated, buildAllowList } = await import(new URL("../lib/redact.ts", import.meta.url));
const allow = buildAllowList([]);

// ---------------------------------------------------------- H5: oversize scan
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const big = `deploy key ${AKIA} here\n` + "lorem ipsum dolor sit amet\n".repeat(200000); // ~5MB
check("H5: oversize input still yields head findings",
  collectFindings(big, "test", { entropy: false }, allow).some((f) => f.value.includes("AKIA")),
  `len=${big.length}`);
check("H5: truncation is detectable", typeof isScanTruncated === "function" && isScanTruncated(big) === true);
check("H5: normal input is not flagged truncated",
  typeof isScanTruncated === "function" && isScanTruncated("short text") === false);

// ---------------------------------------------------------- H6: audit rotation
const mod = await import(new URL("../plugins/secret-shield.ts", import.meta.url));
const tools = new Map();
const hooks = {};
await mod.default.setup({
  options: { mode: "observe" },
  location: { directory: sandbox },
  tool: {
    hook: async (name, cb) => { hooks[`tool.${name}`] = cb; return { dispose: async () => {} }; },
    transform: async (cb) => { cb({ add: (t) => tools.set(t.name, t) }); return { dispose: async () => {} }; },
  },
  session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } },
  shell: { hook: async () => ({ dispose: async () => {} }) },
});

const installDir = join(sandbox, ".opencode-plugins", "secret-shield");
mkdirSync(installDir, { recursive: true });
// Pre-grow the audit log past the rotation threshold.
writeFileSync(join(installDir, "audit.jsonl"), "x".repeat(6 * 1024 * 1024));

// Trigger one audited finding through the prompt hook.
await hooks.prompt({ prompt: { text: `key ${AKIA}` } });

const files = readdirSync(installDir);
const rotated = files.filter((f) => f !== "audit.jsonl" && f.startsWith("audit-"));
const current = existsSync(join(installDir, "audit.jsonl"))
  ? readFileSync(join(installDir, "audit.jsonl"), "utf8").length : -1;
check("H6: oversized audit log rotates on write", rotated.length >= 1, files.join(","));
check("H6: current audit log stays bounded", current >= 0 && current < 6 * 1024 * 1024, `size=${current}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
