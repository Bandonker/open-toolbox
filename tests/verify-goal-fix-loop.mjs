/**
 * Regression checks for the goal-plugin fixes GO-2..GO-6, against the real
 * plugin source with a stub context (no opencode server).
 *
 *   GO-2 — `/goal resume` was a silent no-op after a G9 user takeover, because
 *          G9 leaves status "active" and the resume guard rejected any active
 *          goal while telling the user to run exactly this command.
 *   GO-3 — resume extended the deadline by the paused span even when that
 *          deadline was already in the past, so the first turn after resuming a
 *          timed-out goal stopped it again (one turn per resume, forever).
 *   GO-4 — toolCallSigs was the one session map with no eviction and no
 *          cleanup on stop/clear/teardown, leaking duplicate-tool signals into
 *          the next goal for the same session.
 *   GO-5 — lastTurn() reported "context read failed", "no assistant turn yet"
 *          and "assistant message without an id" identically (empty id), and
 *          evaluate() bailed on all three BEFORE failure accounting, so
 *          maxFailures could never trip and the loop stranded the goal "active".
 *   GO-6 — maxTurnMinutes was resolved and reported but enforced nowhere, and
 *          GoalState.notify (E124) was declared and never read.
 *
 *   node tests/verify-goal-fix-loop.mjs
 */
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/goal.ts", import.meta.url));
check("goal exposes a default plugin", mod.default.id === "goal" && typeof mod.default.setup === "function");

/* ------------------------------------------------------------ fake clock */

// GO-6 needs a turn that ran for minutes; real sleeps would not be reasonable.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };
const restoreClock = () => { clockOffset = 0; Date.now = realNow; };

/* --------------------------------------------------------------- harness */

function makeEventStream() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(event) {
      queue.push(event);
      if (wake) { const w = wake; wake = null; w(); }
    },
    close() {
      closed = true;
      if (wake) { const w = wake; wake = null; w(); }
    },
    subscribe() {
      return (async function* () {
        for (;;) {
          if (queue.length > 0) { yield queue.shift(); continue; }
          if (closed) return;
          await new Promise((resolve) => { wake = resolve; });
        }
      })();
    },
  };
}

// Timers stay on the real clock even while Date.now() is offset, so waiting for
// the plugin's async work is unaffected by the fake clock.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 1500) {
  const started = realNow();
  while (realNow() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

async function makeHarness(options = {}) {
  const store = new Map();
  const messages = new Map();
  const tools = {};
  const toolHooks = {};
  const contextHooks = [];
  const commands = {};
  const prompts = [];
  const notes = [];
  const stream = makeEventStream();
  const state = { failContext: false };

  const dispose = await mod.default.setup({
    options,
    location: { directory: process.cwd() },
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value),
      remove: async (key) => void store.delete(key),
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (def) => void (tools[def.name] = def) });
        return { dispose: async () => {} };
      },
      hook: async (name, cb) => {
        toolHooks[name] = cb;
        return { dispose: async () => {} };
      },
      list: async () => Object.keys(tools).map((id) => ({ id })),
    },
    session: {
      hook: async (name, cb) => {
        contextHooks.push(cb);
        return { dispose: async () => {} };
      },
      prompt: async (input) => void prompts.push(input),
      synthetic: async (input) => void notes.push(input),
      context: async ({ sessionID }) => {
        if (state.failContext) throw new Error("storage is down");
        return messages.get(sessionID) ?? [];
      },
    },
    command: {
      transform: async (cb) => {
        cb({ add: (def) => void (commands[def.name] = def) });
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: () => stream.subscribe() },
  });

  const goalOf = async (sessionID) => store.get(`goal.v1.${sessionID}`);
  await sleep(10);
  return {
    store,
    tools,
    toolHooks,
    contextHooks,
    commands,
    prompts,
    notes,
    state,
    goalOf,
    setMessages: (sessionID, list) => messages.set(sessionID, list),
    assistant: (id, text) => ({ id, role: "assistant", content: [{ type: "text", text }] }),
    // G9: only goal-originated turns continue the loop — the user message has
    // to carry the plugin MARK.
    withGoalUser: (sessionID, ...turns) => {
      messages.set(sessionID, [
        { id: `u-${turns.map((t) => t.id ?? "").join("-")}`, role: "user", content: [{ type: "text", text: "[goal-plugin] keep going" }] },
        ...turns,
      ]);
    },
    fire: (type, sessionID) => stream.push({ type, data: { sessionID } }),
    async dispose() {
      stream.close();
      await dispose?.();
    },
  };
}

/* --------------------------------------- GO-2: resume after a G9 takeover */

{
  const h = await makeHarness({ stallLimit: 5 });
  const S = "ses_go2";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Ship the quarterly report" } });
  await waitFor(() => h.prompts.length === 1);

  h.setMessages(S, [
    { id: "u1", role: "user", content: [{ type: "text", text: "let me drive this one myself" }] },
    h.assistant("a1", "Sure — stopping here."),
  ]);
  h.fire("session.idle", S);
  await sleep(80);

  const after = await h.goalOf(S);
  check("G9 takeover leaves the goal active (as the note promises)", after?.status === "active", after?.status);
  check("G9 takeover flags the goal as taken over", after?.userTookOver === true);
  check("G9 takeover tells the user to run /goal resume", h.notes.some((n) => /goal resume/.test(n.text)));

  const before = h.prompts.length;
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "resume" } });
  await sleep(80);
  check(
    "GO-2 /goal resume after a takeover queues a turn",
    h.prompts.length === before + 1,
    `prompts ${before} -> ${h.prompts.length}`,
  );
  check("GO-2 resume clears the takeover flag before kicking", (await h.goalOf(S))?.userTookOver === false);
  check("GO-2 resume says so", h.notes.some((n) => /Resumed/.test(n.text)));

  const again = h.prompts.length;
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "resume" } });
  await sleep(80);
  check("GO-2 a second resume of an active goal is still a no-op (H1 kept)", h.prompts.length === again, `prompts=${h.prompts.length}`);
  await h.dispose();
}

/* --------------------------- GO-3: resuming a goal whose deadline lapsed */

{
  const h = await makeHarness({ maxMinutes: 10 });
  const S = "ses_go3";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Migrate the ingest job" } });
  await waitFor(() => h.prompts.length === 1);

  const st = await h.goalOf(S);
  const now = realNow() + clockOffset;
  // Simulate: the goal stopped when the wall-clock budget ran out, and the
  // user resumes right after.
  st.status = "timeout";
  st.stoppedReason = "reached the time budget (10 min).";
  st.deadlineAt = now - 1_000;
  st.updatedAt = now;
  delete st.pausedAt;

  const before = h.prompts.length;
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "resume" } });
  await sleep(80);
  const resumed = await h.goalOf(S);
  check("GO-3 resume restarts a goal stopped by the deadline", resumed?.status === "active", resumed?.status);
  check(
    "GO-3 resume grants a fresh window instead of a deadline in the past",
    resumed.deadlineAt > now + 9 * 60_000,
    `deadline is ${Math.round((resumed.deadlineAt - now) / 1000)}s from now`,
  );
  check("GO-3 resume queues the turn", h.prompts.length === before + 1, `prompts=${h.prompts.length}`);

  // The first turn back must not be stopped again for the time budget.
  h.withGoalUser(S, h.assistant("m9", "continuing the migration work"));
  h.fire("session.idle", S);
  await sleep(100);
  const afterTurn = await h.goalOf(S);
  check(
    "GO-3 the first resumed turn is not instantly timed out again",
    afterTurn?.status === "active" && !/time budget/.test(afterTurn?.stoppedReason ?? ""),
    JSON.stringify({ status: afterTurn?.status, reason: afterTurn?.stoppedReason }),
  );
  check("GO-3 the loop really continued", h.prompts.length === before + 2, `prompts=${h.prompts.length}`);
  await h.dispose();
}

/* ------------------------- GO-3b: a normal pause still only extends G3 */

{
  const h = await makeHarness({ maxMinutes: 10 });
  const S = "ses_go3b";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Refactor the parser module" } });
  await waitFor(() => h.prompts.length === 1);

  const st = await h.goalOf(S);
  const now = realNow() + clockOffset;
  st.status = "paused";
  st.pausedAt = now - 60_000; // paused a minute ago
  st.updatedAt = now - 60_000;
  st.deadlineAt = now + 5 * 60_000; // five minutes of budget were left

  await h.commands.goal.execute({ sessionID: S, prompt: { text: "resume" } });
  await sleep(80);
  const left = (await h.goalOf(S)).deadlineAt - (realNow() + clockOffset);
  check(
    "GO-3 a real pause still extends the deadline by the paused span (G3), not a reset",
    left > 5.5 * 60_000 && left < 9 * 60_000,
    `${Math.round(left / 1000)}s left`,
  );
  await h.dispose();
}

/* ------------------- GO-4: tool-call signals must not cross goal stops */

{
  const h = await makeHarness({ stallLimit: 1 });
  const S = "ses_go4";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Triage the failing suite" } });
  await waitFor(() => h.prompts.length === 1);

  await h.toolHooks["execute.before"]({ sessionID: S, tool: "bash", args: { command: "npm test" } });
  await h.toolHooks["execute.before"]({ sessionID: S, tool: "bash", args: { command: "npm test" } });
  await h.tools.goal_complete.execute({ summary: "suite green", evidence: "npm test: 42 passing" }, { sessionID: S });
  await sleep(60);
  check("the first goal completes", (await h.goalOf(S))?.status === "complete");

  // A new goal in the same session whose first tool call happens to repeat the
  // last call of the finished goal. Stale signatures used to survive the stop
  // and count as an immediate duplicate-tool stall (stallLimit is 1 here).
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Write the release notes now" } });
  await waitFor(() => h.prompts.length === 2);
  await h.toolHooks["execute.before"]({ sessionID: S, tool: "bash", args: { command: "npm test" } });
  h.withGoalUser(S, h.assistant("n1", "release notes drafted"));
  h.fire("session.idle", S);
  await sleep(100);

  const st2 = await h.goalOf(S);
  check(
    "GO-4 a finished goal leaves no tool-call signatures behind",
    st2?.status === "active" && st2?.stallCount === 0,
    JSON.stringify({ status: st2?.status, stall: st2?.stallCount, reason: st2?.stoppedReason }),
  );
  check("GO-4 the new goal keeps looping", h.prompts.length === 3, `prompts=${h.prompts.length}`);

  // /goal clear drops them too.
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "clear" } });
  await sleep(40);
  check("GO-4 /goal clear drops the session scratch state", (await h.goalOf(S)) === undefined);
  await h.dispose();
}

/* --------- GO-5: failures accrue when there is no usable assistant turn */

{
  const h = await makeHarness({ maxFailures: 2 });
  const S = "ses_go5";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Repair the release pipeline" } });
  await waitFor(() => h.prompts.length === 1);

  // No assistant message at all: the read works, there is just no turn yet.
  h.setMessages(S, [{ id: "u1", role: "user", content: [{ type: "text", text: "[goal-plugin] Repair the release pipeline" }] }]);
  h.fire("session.execution.failed", S);
  await sleep(100);
  const mid = await h.goalOf(S);
  check("GO-5 an execution failure accrues with no assistant turn", mid?.failures === 1, JSON.stringify({ failures: mid?.failures, status: mid?.status }));
  check("GO-5 the loop continues after the first failure", h.prompts.length === 2, `prompts=${h.prompts.length}`);

  h.fire("session.execution.failed", S);
  await sleep(100);
  const st = await h.goalOf(S);
  check(
    "GO-5 maxFailures stops the loop even without an assistant id",
    st?.status === "failed" && st?.failures === 2,
    JSON.stringify({ status: st?.status, failures: st?.failures, reason: st?.stoppedReason }),
  );
  check("GO-5 the stop is explained to the user", h.notes.some((n) => /execution errors/i.test(n.text)));
  await h.dispose();
}

/* ------- GO-5: a context read that THROWS still bails without accruing */

{
  const h = await makeHarness({ maxFailures: 1 });
  const S = "ses_go5b";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Investigate the flaky build" } });
  await waitFor(() => h.prompts.length === 1);

  h.state.failContext = true;
  h.fire("session.execution.failed", S);
  await sleep(100);
  const st = await h.goalOf(S);
  check(
    "GO-5 a failed context read does not accrue failures (H2 intent kept)",
    st?.failures === 0 && st?.status === "active",
    JSON.stringify({ failures: st?.failures, status: st?.status }),
  );
  await h.dispose();
}

/* --------------- GO-6: maxTurnMinutes is enforced, notify is honored */

{
  const h = await makeHarness({ maxTurnMinutes: 1, maxMinutes: 180 });
  const S = "ses_go6";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Rewrite the auth middleware" } });
  await waitFor(() => h.prompts.length === 1);

  advance(2 * 60_000); // the goal's own turn ran for two minutes
  h.withGoalUser(S, h.assistant("t1", "still chewing on the middleware"));
  h.fire("session.idle", S);
  await sleep(120);

  const st = await h.goalOf(S);
  check(
    "GO-6 a turn over maxTurnMinutes stops the loop",
    st?.status === "timeout" && /maxTurnMinutes/.test(st?.stoppedReason ?? ""),
    JSON.stringify({ status: st?.status, reason: st?.stoppedReason }),
  );
  check("GO-6 no continuation is queued after the turn timeout", h.prompts.length === 1, `prompts=${h.prompts.length}`);
  check("GO-6 the turn timeout is explained to the user", h.notes.some((n) => /maxTurnMinutes/.test(n.text)));
  restoreClock();
  await h.dispose();
}

{
  // Control: the same elapsed turn under the default 30-minute budget keeps
  // going, so the stop is the budget and not the fake clock.
  const h = await makeHarness({ maxMinutes: 180 });
  const S = "ses_go6ctl";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Rewrite the auth middleware" } });
  await waitFor(() => h.prompts.length === 1);
  advance(2 * 60_000);
  h.withGoalUser(S, h.assistant("t1", "still chewing on the middleware"));
  h.fire("session.idle", S);
  await sleep(120);
  const st = await h.goalOf(S);
  check("GO-6 an under-budget turn still continues the loop", st?.status === "active" && h.prompts.length === 2, JSON.stringify({ status: st?.status, prompts: h.prompts.length }));
  restoreClock();
  await h.dispose();
}

{
  // GO-6: GoalState.notify (E124) is read now — a goal carrying notify:false
  // gets no plugin chatter, while the loop still stops.
  const h = await makeHarness({ maxIterations: 1, notify: true });
  const S = "ses_go6n";
  const base = {
    sessionID: S,
    objective: "Quiet goal that must stop without notes",
    criteria: [],
    status: "active",
    createdAt: realNow(),
    updatedAt: realNow(),
    startedAt: realNow(),
    deadlineAt: null,
    maxIterations: 1,
    iterations: 1,
    failures: 0,
    stallCount: 0,
    lastSignature: "",
    lastHandledMessageID: "",
    progress: [],
    notify: false,
  };
  h.store.set(`goal.v1.${S}`, base);
  h.withGoalUser(S, h.assistant("q1", "one more pass"));
  h.fire("session.idle", S);
  await sleep(120);
  const st = await h.goalOf(S);
  check("E124 the goal still stops (budget)", st?.status === "budget", st?.status);
  check("GO-6 notify:false on the goal suppresses the stop note", h.notes.filter((n) => /goal-plugin/i.test(n.text)).length === 0, JSON.stringify(h.notes.map((n) => n.text.slice(0, 40))));
  await h.dispose();

  const loud = await makeHarness({ maxIterations: 1, notify: true });
  const L = "ses_go6l";
  await loud.commands.goal.execute({ sessionID: L, prompt: { text: "Loud goal that should announce its stop" } });
  await waitFor(() => loud.prompts.length === 1);
  loud.withGoalUser(L, loud.assistant("q1", "one more pass"));
  loud.fire("session.idle", L);
  await sleep(120);
  // The budget stop lands on the turn AFTER the budget is used up.
  loud.withGoalUser(L, loud.assistant("q2", "another pass"));
  loud.fire("session.idle", L);
  await sleep(120);
  check("E124 a goal without the flag still notes", loud.notes.some((n) => /stopped/i.test(n.text)), JSON.stringify(loud.notes.map((n) => n.text.slice(0, 40))));
  await loud.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
