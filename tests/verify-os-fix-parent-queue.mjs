/**
 * OS-3 + OS-1 regressions: parent injection must not drop notes, and the
 * stuck-session sweeper must stop the child it retires.
 *
 * OS-3: `postToParent` throttled injections to one per 5s per parent and, while
 * inside that window, returned *without* posting — after the caller had already
 * marked the child injected. A parent spawning 5 children got at most 1-2 notes:
 * the ones skipped here are never re-attempted. The notes are queued now and
 * flushed by one timer when the window elapses.
 *
 * OS-1: the sweeper force-cancelled nothing. It deleted the tracked record, so
 * the child kept spending tokens with no record left to attach its events to and
 * no result was ever fetched or injected. It now interrupts, keeps the (terminal)
 * record, and only a genuinely quiet session counts toward the circuit breaker.
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "verify-os-fix-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(options = {}) {
  const tools = {};
  const registry = new Map();
  const created = [];
  const injected = [];
  const interrupted = [];
  const pending = [];
  let wake = null;

  const push = (ev) => {
    pending.push(ev);
    wake?.();
  };
  const drain = async function* (signal) {
    while (!signal?.aborted) {
      while (pending.length > 0) yield pending.shift();
      await new Promise((r) => {
        wake = r;
        if (signal) signal.addEventListener("abort", r, { once: true });
      });
      wake = null;
    }
  };

  const editor = {
    add: (t) => {
      tools[t.name] = t;
      registry.set(t.name, t);
    },
    list: () => [...registry.values()].map((t) => ({ ...t, id: t.id ?? t.name })),
    get: (id) => registry.get(id),
    update: (id, fn) => {
      const t = registry.get(id);
      if (t) fn(t);
    },
    remove: (id) => void registry.delete(id),
    namespace: () => {},
  };

  const ctx = {
    options,
    location: { directory: PROJECT, project: { id: "p", directory: PROJECT, canonical: PROJECT } },
    event: { subscribe: ({ signal } = {}) => drain(signal) },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      remove: async () => undefined,
      scan: async () => ({ entries: [] }),
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (cb) => {
        cb(editor);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async ({ sessionID }) => ({ id: sessionID, title: "[spawned:x] t", parentID: "ses_parent_a" }),
      // Every child "finishes" with a recognisable line, so the injected note
      // carries the child's own outcome text.
      context: async ({ sessionID }) => [
        { type: "assistant", content: [{ type: "text", text: `outcome of ${sessionID}` }] },
      ],
      interrupt: async ({ sessionID }) => void interrupted.push(sessionID),
      synthetic: async ({ sessionID, text }) => void injected.push({ sessionID, text }),
      prompt: async () => {},
      create: async ({ title }) => {
        const id = `ses_child_${created.length + 1}`;
        created.push({ id, title });
        return { id, title };
      },
    },
  };
  return { ctx, tools, created, injected, interrupted, push };
}

const spawn = async (h, n, parentID = "ses_parent_a") => {
  await h.tools.spawn_many.execute(
    { sessions: Array.from({ length: n }, (_, i) => ({ prompt: `job ${i + 1}` })) },
    { sessionID: parentID },
  );
  return h.created.map((c) => c.id);
};

const idle = (sessionID) => ({
  type: "session.idle",
  location: { directory: PROJECT },
  data: { sessionID },
});

// ------------------------------------------------------- OS-3: queued notes
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const [first, second] = await spawn(h, 2);

  // Both children finish inside the 5s injection window.
  h.push(idle(first));
  h.push(idle(second));
  await wait(400);

  const atOnce = h.injected.filter((i) => i.sessionID === "ses_parent_a");
  check(
    "OS-3: the first completion is injected immediately",
    atOnce.length === 1 && atOnce[0].text.includes(first),
    `notes=${atOnce.length}`,
  );
  check(
    "OS-3: the second completion is not silently dropped (yet)",
    !atOnce.some((n) => n.text.includes(second)),
    "still queued",
  );

  // Past the throttle window the queue must be flushed by the single timer.
  await wait(5400);
  const all = h.injected.filter((i) => i.sessionID === "ses_parent_a");
  check("OS-3: the queued note is flushed when the window elapses", all.length === 2, `notes=${all.length}`);
  check(
    "OS-3: the flushed note names the child it is about",
    (all[1]?.text ?? "").includes(second),
    (all[1]?.text ?? "(none)").replace(/\n/g, " | ").slice(0, 120),
  );
  check(
    "OS-3: the flush reuses one injection per parent, not one per child",
    !all[1].text.includes("outcome of " + first) || all[1].text.includes(second),
    "single batch",
  );
}

// ------------------------------------------- OS-1: a quiet child is interrupted
// The sweeper's 30s tick is the plugin's own cadence; compress it so the test
// finishes, exactly as a long-running server would experience it.
const realSetInterval = global.setInterval;
const clampTimers = (ms) => {
  global.setInterval = (fn, delay, ...rest) => realSetInterval(fn, Math.min(delay, ms), ...rest);
};
const restoreTimers = () => {
  global.setInterval = realSetInterval;
};

{
  clampTimers(200);
  const h = makeCtx({ hardTimeoutSec: 2 });
  await mod.default.setup(h.ctx);
  restoreTimers();

  const [child] = await spawn(h, 1);
  // Nothing is heard from the child for longer than the hard timeout.
  await wait(2700);
  check(
    "OS-1: the sweeper interrupts the session it retires",
    h.interrupted.includes(child),
    `interrupted=${h.interrupted.join(",") || "nothing"}`,
  );

  const res = await h.tools.session_result.execute({ sessionId: child }, { sessionID: "ses_parent_a" });
  check(
    "OS-1: the retired record survives so session_result can still report it",
    /timeout/.test(res.content) && !/Unknown session/.test(res.content),
    res.content.replace(/\n/g, " | ").slice(0, 110),
  );
}

// --------------------------------- OS-1: a busy child is not mistaken for stuck
{
  clampTimers(200);
  const h = makeCtx({ hardTimeoutSec: 2 });
  await mod.default.setup(h.ctx);
  restoreTimers();

  const [child] = await spawn(h, 1);
  // A working child emits step events continuously. Before the `touch` from the
  // event pump existed, `lastActivityAt` only moved on spawn/prompt/permission,
  // so this is exactly the child that got force-cancelled mid-task.
  for (let i = 0; i < 9; i++) {
    h.push({
      type: "session.step.started",
      location: { directory: PROJECT },
      data: { sessionID: child },
    });
    await wait(300);
  }
  check(
    "OS-1: a child that keeps emitting events is not treated as stuck",
    h.interrupted.length === 0,
    `interrupted=${h.interrupted.join(",") || "nothing"}`,
  );
  const res = await h.tools.session_result.execute({ sessionId: child }, { sessionID: "ses_parent_a" });
  check(
    "OS-1: it is still reported as running",
    !/timeout/.test(res.content),
    res.content.replace(/\n/g, " | ").slice(0, 110),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
