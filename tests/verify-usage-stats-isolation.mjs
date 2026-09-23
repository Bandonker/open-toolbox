/**
 * Regression test for US-1: two concurrent usage-stats setups must not share
 * module-level db/pricing/pending state. Each setup owns its sqlite handle,
 * pricing maps, dirty flag, session models, and in-flight map, so a call
 * recorded through A's hooks is invisible to B.
 *
 *   node tests/verify-usage-stats-isolation.mjs
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

const mod = await import(new URL("../plugins/usage-stats.ts", import.meta.url));

function makeCtx(dir) {
  const tools = [];
  const hooks = {};
  return {
    ctx: {
      options: { dir, log: false, openOnStart: false, autoRefreshSec: 0, pricingRefreshMin: 0 },
      app: {},
      tool: {
        transform: async (cb) => { cb({ add: (t) => tools.push(t) }); return { dispose: async () => {} }; },
        hook: async (name, cb) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
      },
      session: { hook: async () => ({ dispose: async () => {} }) },
      command: { transform: async () => ({ dispose: async () => {} }) },
      event: { subscribe: () => (async function* () {})() },
    },
    tools,
    hooks,
  };
}

const dirA = join(tmpdir(), "opencode-us1-A");
const dirB = join(tmpdir(), "opencode-us1-B");
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

const a = makeCtx(dirA);
const b = makeCtx(dirB);
const cleanupA = await mod.default.setup(a.ctx);
const cleanupB = await mod.default.setup(b.ctx);

await a.hooks["execute.before"]({ id: "callA", tool: "us-alpha" });
await a.hooks["execute.after"]({ id: "callA", tool: "us-alpha", status: "completed" });

const byA = Object.fromEntries(a.tools.map((t) => [t.name, t]));
const byB = Object.fromEntries(b.tools.map((t) => [t.name, t]));
const qA = await byA.stats_tools.execute({ limit: 20 }, {});
const qB = await byB.stats_tools.execute({ limit: 20 }, {});

check("A sees its own recorded call", qA.content.includes("us-alpha"));
check("B does not leak A's call (per-setup state)", !qB.content.includes("us-alpha"));

await cleanupA();
await cleanupB();
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
