/**
 * Regression test for TA-1: two concurrent tool-audit setups must not share
 * module-level db/pending state. Each setup owns its sqlite handle and
 * in-flight map, so a call recorded through A's hooks is invisible to B.
 *
 *   node tests/verify-tool-audit-isolation.mjs
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/tool-audit.ts", import.meta.url));

function makeCtx(dir) {
  const tools = [];
  const hooks = {};
  return {
    ctx: {
      options: { dir, retentionDays: 30, redact: true },
      location: { directory: tmpdir() },
      tool: {
        transform: async (cb) => { cb({ add: (t) => tools.push(t) }); },
        hook: async (name, cb) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
      },
    },
    tools,
    hooks,
  };
}

const dirA = join(tmpdir(), "opencode-ta1-A");
const dirB = join(tmpdir(), "opencode-ta1-B");
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

const a = makeCtx(dirA);
const b = makeCtx(dirB);
const cleanupA = await mod.default.setup(a.ctx);
const cleanupB = await mod.default.setup(b.ctx);

await a.hooks["execute.before"]({ tool: "alpha-tool", sessionID: "sesA", agent: "build", messageID: "m1", id: "callA", input: {} });
await a.hooks["execute.after"]({ tool: "alpha-tool", sessionID: "sesA", agent: "build", messageID: "m1", id: "callA", input: {}, status: "completed", result: { content: "ok" } });

const byA = Object.fromEntries(a.tools.map((t) => [t.name, t]));
const byB = Object.fromEntries(b.tools.map((t) => [t.name, t]));
const qA = await byA.trace_query.execute({ limit: 20 }, {});
const qB = await byB.trace_query.execute({ limit: 20 }, {});
check("A sees its own recorded call", qA.content.includes("alpha-tool"));
check("B does not leak A's call", !qB.content.includes("alpha-tool"), JSON.stringify(qB.content).slice(0, 80));

await cleanupA();
await cleanupB();
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
