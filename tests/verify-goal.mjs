/**
 * Mock-context verification for the goal plugin.
 *
 * Runs the real plugin source against a stub context (no opencode server) and
 * exercises the whole loop: setting a goal, context injection, auto-continue on
 * idle, dedupe, stall/budget/interrupt stops, completion and blocking.
 *
 *   node tests/verify-goal.mjs
 */
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/goal.ts", import.meta.url));
check(
  "goal exposes a default plugin",
  mod.default.id === "goal" && typeof mod.default.setup === "function",
);

function makeEventStream() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(event) {
      queue.push(event);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    close() {
      closed = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    subscribe() {
      return (async function* () {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (closed) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      })();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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
      context: async ({ sessionID }) => messages.get(sessionID) ?? [],
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
  const setMessages = (sessionID, list) => messages.set(sessionID, list);
  const assistant = (id, text) => ({ id, role: "assistant", content: [{ type: "text", text }] });
  // G9: auto-continue is gated on goal-originated turns — the last user
  // message must carry the goal MARK, so wrap assistant turns with it.
  const withGoalUser = (sessionID, ...turns) => {
    const uid = `u-for-${turns.map((t) => t.id ?? "").join("-") || "turn"}`;
    setMessages(sessionID, [
      { id: uid, role: "user", content: [{ type: "text", text: "[goal-plugin] keep going" }] },
      ...turns,
    ]);
  };
  const fire = (type, sessionID) => stream.push({ type, data: { sessionID } });

  await sleep(10);
  return {
    options,
    store,
    tools,
    toolHooks,
    contextHooks,
    commands,
    prompts,
    notes,
    goalOf,
    setMessages,
    withGoalUser,
    assistant,
    fire,
    async dispose() {
      stream.close();
      await dispose?.();
    },
  };
}

/* ------------------------------------------------------------ registration */

{
  const h = await makeHarness();
  check(
    "registers the goal tools",
    ["goal_complete", "goal_blocked", "goal_progress"].every(
      (n) => typeof h.tools[n]?.execute === "function",
    ),
  );
  check("registers the context hook", typeof h.contextHooks[0] === "function");
  check("registers the tool hook", typeof h.toolHooks["execute.before"] === "function");
  check("registers the /goal command", typeof h.commands.goal?.execute === "function");
  await h.dispose();
}

/* ---------------------------------------------------- set, kick off, inject */

{
  const h = await makeHarness();
  const S = "ses_a";
  await h.commands.goal.execute({
    sessionID: S,
    prompt: { text: "Ship the widget\n- tests pass\n- no lint warnings" },
  });
  await waitFor(() => h.prompts.length === 1);

  const st = await h.goalOf(S);
  check("setting a goal stores an active goal", st?.status === "active");
  check("objective is parsed from the first line", st?.objective === "Ship the widget", st?.objective);
  check("bullet lines become success criteria", st?.criteria?.length === 2, JSON.stringify(st?.criteria));
  check(
    "kickoff prompt carries the objective",
    h.prompts.length === 1 && h.prompts[0].text.includes("Ship the widget"),
    h.prompts[0]?.text?.slice(0, 80),
  );
  check(
    "kickoff prompt lists the criteria",
    /SUCCESS CRITERIA/.test(h.prompts[0]?.text ?? "") && h.prompts[0].text.includes("tests pass"),
  );
  check(
    "setting a goal confirms to the user",
    h.notes.some((n) => n.text.includes("Goal set")),
  );

  const inject = () => {
    const list = [h.assistant("m0", "working")];
    h.contextHooks[0]({ sessionID: S, messages: list });
    return list;
  };
  const first = inject();
  const marked = first.filter((m) => m.role === "system" && m.content[0].text.includes("[goal-plugin]"));
  check("context hook injects exactly one goal reminder", marked.length === 1, String(marked.length));
  check("reminder states the objective", marked[0]?.content[0].text.includes("Ship the widget"));

  const stale = [h.assistant("m0", "x"), { role: "system", content: [{ type: "text", text: "[goal-plugin]\nold" }] }];
  h.contextHooks[0]({ sessionID: S, messages: stale });
  const afterReplace = stale.filter((m) => m.content[0]?.text?.includes("[goal-plugin]"));
  check("context hook replaces a previous reminder instead of stacking", afterReplace.length === 1, String(afterReplace.length));

  // No goal for other sessions.
  const other = [h.assistant("m0", "x")];
  h.contextHooks[0]({ sessionID: "ses_other", messages: other });
  check("context hook is silent without a goal", other.length === 1);
  await h.dispose();
}

/* --------------------------------------------------------- auto-continue */

{
  const h = await makeHarness();
  const S = "ses_b";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Fix the flaky test" } });
  await waitFor(() => h.prompts.length === 1);

  h.withGoalUser(S, h.assistant("m1", "I looked at the test and will try again."));
  h.fire("session.idle", S);
  check("idle queues a continuation turn", await waitFor(() => h.prompts.length === 2), `prompts=${h.prompts.length}`);
  const cont = h.prompts[1]?.text ?? "";
  check("continuation carries the objective", cont.includes("Fix the flaky test"));
  check("continuation reports the attempt budget", /attempt 1\/\d+/.test(cont), cont.slice(0, 120));
  check("continuation tells the model to call goal_complete", cont.includes("goal_complete"));
  check("one attempt was recorded", (await h.goalOf(S))?.iterations === 1);

  // Duplicate end-of-turn events for the same message must not double-fire.
  h.fire("session.execution.succeeded", S);
  await sleep(40);
  check("duplicate turn-end events are deduped", h.prompts.length === 2, `prompts=${h.prompts.length}`);

  // No continuation when there is no goal.
  h.fire("session.idle", "ses_empty");
  await sleep(40);
  check("idle without a goal does nothing", h.prompts.length === 2);
  await h.dispose();
}

/* ------------------------------------------------- progress + status + complete */

{
  const h = await makeHarness();
  const S = "ses_c";
  const toolCtx = { sessionID: S };
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Make the build green" } });
  await waitFor(() => h.prompts.length === 1);

  const prog = await h.tools.goal_progress.execute({ note: "Fixed the compile error." }, toolCtx);
  check("goal_progress records a milestone", /recorded/i.test(prog.content), prog.content);
  check("milestone is persisted", (await h.goalOf(S))?.progress?.[0]?.text === "Fixed the compile error.");

  await h.commands.goal.execute({ sessionID: S, prompt: { text: "status" } });
  await waitFor(() => h.notes.length >= 2);
  const status = h.notes.find((n) => n.text.includes("Goal (active)"))?.text ?? "";
  check("status shows the objective", status.includes("Make the build green"));
  check("status shows the recorded milestone", status.includes("Fixed the compile error."));

  const refused = await h.tools.goal_complete.execute({ summary: "done" }, toolCtx);
  check(
    "goal_complete refuses without evidence",
    /Refused/.test(refused.content) && (await h.goalOf(S))?.status === "active",
    refused.content,
  );

  const done = await h.tools.goal_complete.execute(
    { summary: "Build is green.", evidence: "bun test -> 42 passed" },
    toolCtx,
  );
  check("goal_complete with evidence completes the goal", (await h.goalOf(S))?.status === "complete", done.content);
  check("evidence is stored", /42 passed/.test((await h.goalOf(S))?.evidence ?? ""));

  h.withGoalUser(S, h.assistant("m9", "All done."));
  h.fire("session.idle", S);
  await sleep(40);
  check("a completed goal is not resumed", h.prompts.length === 1, `prompts=${h.prompts.length}`);
  await h.dispose();
}

/* -------------------------------------------------------------- blocked */

{
  const h = await makeHarness();
  const S = "ses_d";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Deploy to production" } });
  await waitFor(() => h.prompts.length === 1);

  const res = await h.tools.goal_blocked.execute({ reason: "No deploy credentials.", needs: "A token" }, { sessionID: S });
  const st = await h.goalOf(S);
  check("goal_blocked stops the loop", st?.status === "blocked" && /credentials/.test(st.blockedReason ?? ""), res.content);
  h.withGoalUser(S, h.assistant("m1", "blocked"));
  h.fire("session.idle", S);
  await sleep(40);
  check("a blocked goal is not resumed", h.prompts.length === 1);
  await h.dispose();
}

/* ---------------------------------------------------------------- stall */

{
  const h = await makeHarness({ stallLimit: 2 });
  const S = "ses_e";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Keep polishing the report" } });
  await waitFor(() => h.prompts.length === 1);

  for (let i = 0; i < 3; i += 1) {
    h.withGoalUser(S, h.assistant(`m${i}`, "I will continue shortly."));
    h.fire("session.idle", S);
    await sleep(40);
  }
  const st = await h.goalOf(S);
  check("repeated no-op turns stop the loop as stalled", st?.status === "stalled", `status=${st?.status}`);
  check(
    "the stall is explained to the user",
    h.notes.some((n) => n.text.includes("no progress detected")),
  );
  check("no further continuations after stalling", h.prompts.length === 3, `prompts=${h.prompts.length}`);
  await h.dispose();
}

/* --------------------------------------------------------------- budget */

{
  const h = await makeHarness({ maxIterations: 1 });
  const S = "ses_f";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Refactor everything" } });
  await waitFor(() => h.prompts.length === 1);

  h.withGoalUser(S, h.assistant("m1", "step one"));
  h.fire("session.idle", S);
  await waitFor(() => h.prompts.length === 2);
  h.withGoalUser(S, h.assistant("m2", "step two"));
  h.fire("session.idle", S);
  await sleep(40);
  check("the attempt budget stops the loop", (await h.goalOf(S))?.status === "budget");
  check("budget exhaustion is reported", h.notes.some((n) => n.text.includes("attempt budget")));
  check("no continuation past the budget", h.prompts.length === 2, `prompts=${h.prompts.length}`);
  await h.dispose();
}

/* ------------------------------------------------------ pause/resume/interrupt */

{
  const h = await makeHarness();
  const S = "ses_g";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Write the migration" } });
  await waitFor(() => h.prompts.length === 1);

  h.fire("session.execution.interrupted", S);
  await waitFor(() => h.notes.some((n) => n.text.includes("paused")));
  check("an interrupt pauses the goal", (await h.goalOf(S))?.status === "paused");
  check("pause is explained", h.notes.some((n) => n.text.includes("paused")));

  h.withGoalUser(S, h.assistant("m1", "stopped"));
  h.fire("session.idle", S);
  await sleep(40);
  check("a paused goal is not resumed", h.prompts.length === 1, `prompts=${h.prompts.length}`);

  await h.commands.goal.execute({ sessionID: S, prompt: { text: "resume" } });
  await waitFor(() => h.prompts.length === 2);
  check("resume queues another turn", h.prompts.length === 2);

  await h.commands.goal.execute({ sessionID: S, prompt: { text: "clear" } });
  check("clear forgets the goal", (await h.goalOf(S)) === undefined);
  await h.dispose();
}

/* -------------------------------------------------------------- disabled */

{
  const h = await makeHarness({ enabled: false });
  const S = "ses_h";
  await h.commands.goal.execute({ sessionID: S, prompt: { text: "Should not run" } });
  await sleep(40);
  const list = [h.assistant("m1", "x")];
  h.contextHooks[0]({ sessionID: S, messages: list });
  check("disabled: no kickoff prompt", h.prompts.length === 0, `prompts=${h.prompts.length}`);
  check("disabled: no context injection", list.length === 1);
  h.fire("session.idle", S);
  await sleep(40);
  check("disabled: no continuation", h.prompts.length === 0);
  await h.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
