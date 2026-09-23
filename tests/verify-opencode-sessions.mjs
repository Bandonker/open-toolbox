/**
 * Regression test for OS-1: hydrate() must not adopt a running session as idle.
 *
 * An adopted session is attached as `running` with the latest outcome text,
 * so `session_result(wait:true)` actually waits instead of resolving
 * immediately with empty text.
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const tools = {};
const ctx = {
  options: {},
  location: { directory: process.cwd() },
  event: { subscribe: () => (async function* () {})() },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => void (tools[t.name] = t) });
      return { dispose: async () => {} };
    },
  },
  session: {
    get: async ({ sessionID }) => ({
      id: sessionID,
      title: "[spawned:abc123] some task",
      parentID: "parent1",
    }),
    context: async () => [
      { type: "assistant", content: [{ type: "text", text: "partial work so far" }] },
    ],
    interrupt: async () => {},
  },
};

await mod.default.setup(ctx);
const result = tools.session_result;
check("session_result tool registered", !!result);
if (result) {
  const nowait = await result.execute({ sessionId: "child1" }, {});
  check("adopted session is not idle", !/status: idle/.test(nowait.content), nowait.content.slice(0, 80));
  check("adopted session attaches partial text", /partial_message:\npartial work so far/.test(nowait.content));

  const t0 = Date.now();
  const waited = await result.execute({ sessionId: "child1", wait: true, timeoutSec: 1 }, {});
  const elapsed = Date.now() - t0;
  check("wait attaches instead of resolving immediately", elapsed >= 500, `${elapsed}ms`);
  check("wait settles as timeout, not idle", /status: timeout/.test(waited.content));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
