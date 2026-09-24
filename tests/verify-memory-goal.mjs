// Task 2 — memory isolation (ME-1/ME-2/ME-9) and goal robustness (GO-*).
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const sandbox = join(tmpdir(), "opencode-verify-memgoal-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.OPENCODE_MEMORY_SCOPE;

const memory = (await import("../plugins/memory.ts")).default;

async function setupMemory(projectDir) {
  const tools = {};
  const noopHook = async () => ({ dispose: async () => {} });
  await memory.setup({
    options: {},
    // project is setup-level (derived from the project directory).
    location: { directory: projectDir },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose: async () => {} };
      },
    },
    session: { hook: noopHook },
  });
  return tools;
}

const dirA = join(sandbox, "projA");
const dirB = join(sandbox, "projB");
const toolsA = await setupMemory(dirA);
const toolsB = await setupMemory(dirB);
const tools = toolsA;
const ctxA = (sessionID = "ses_a") => ({ sessionID });
const ctxB = (sessionID = "ses_b") => ({ sessionID });

// ME-1: scoped forget(query) must not wipe another project's memories.
await toolsA.memory_remember.execute({ text: "Quokka alpha project note", scope: "project" }, ctxA());
const forgetOther = await toolsB.memory_forget.execute({ query: "quokka", scope: "project" }, ctxB());
check("ME-1 scoped query-forget from another project removes 0", /Forgot 0|No memories matched/i.test(forgetOther.content), forgetOther.content);
const stillThere = await toolsA.memory_recall.execute({ query: "quokka" }, ctxA());
check("ME-1 victim project memory survives", /Quokka alpha/i.test(stillThere.content), stillThere.content);

// ME-1 id path still respects visibility: B cannot delete A's id.
const listed = await toolsA.memory_list.execute({ all: true, limit: 50 }, ctxA());
const idMatch = /#(\d+)[^\n]*Quokka alpha/.exec(listed.content);
check("ME-1 test setup found victim id", !!idMatch, listed.content.slice(0, 200));
if (idMatch) {
  const denied = await toolsB.memory_forget.execute({ id: Number(idMatch[1]) }, ctxB());
  check("ME-1 cross-project forget(id) denied", /No memory/i.test(denied.content), denied.content);
}

// ME-2: list without all:true hides other projects; all:true shows them.
const listB = await toolsB.memory_list.execute({}, ctxB());
check("ME-2 default list hides other-project memories", !/Quokka alpha/i.test(listB.content), listB.content.slice(0, 300));
const listBAll = await toolsB.memory_list.execute({ all: true }, ctxB());
check("ME-2 list all:true shows other-project memories", /Quokka alpha/i.test(listBAll.content), listBAll.content.slice(0, 300));

// ME-9: recall must not under-fill when other-project memories dominate FTS.
for (let i = 0; i < 8; i++) {
  await toolsB.memory_remember.execute({ text: `Zebra herd decoy note number ${i}`, scope: "project" }, ctxB());
}
await toolsA.memory_remember.execute({ text: "Zebra keeper first note", scope: "project" }, ctxA());
await toolsA.memory_remember.execute({ text: "Zebra keeper second note", scope: "project" }, ctxA());
const recall = await toolsA.memory_recall.execute({ query: "zebra", limit: 2 }, ctxA());
check(
  "ME-9 recall fills limit despite restrictive isolation",
  /keeper first/i.test(recall.content) && /keeper second/i.test(recall.content),
  recall.content.slice(0, 400),
);

// ---- goal robustness (GO-*) ----
const goal = (await import("../plugins/goal.ts")).default;

function makeClient(over = {}) {
  const tools = {};
  const cmds = {};
  const sessionHooks = [];
  const store = new Map(Object.entries(over.preset ?? {}));
  const notes = [];
  const client = {
    options: { model: "m", ...(over.options ?? {}) },
    cwd: "/tmp",
    project: { id: "p", name: "p", vcs: "git" },
    log: { info() {}, error() {}, warn() {}, debug() {} },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        if (over.throwOnSet) throw new Error("disk full");
        store.set(k, v);
      },
      remove: async (k) => { store.delete(k); },
      del: async (k) => { store.delete(k); },
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => { tools[t.name] = t; } });
        return { dispose() {} };
      },
    },
    session: {
      hook: async (name, cb) => { sessionHooks.push(cb); return { dispose() {} }; },
      synthetic: async ({ text }) => { notes.push(text); },
    },
    event: { subscribe: async () => ({ dispose() {} }) },
    command: {
      transform: async (cb) => {
        cb({ add: (c) => { cmds[c.name] = c; } });
        return { dispose() {} };
      },
    },
  };
  return { client, tools, cmds, sessionHooks, store, notes };
}

async function setupGoal(over = {}) {
  const c = makeClient(over);
  await goal.setup({ options: {}, location: { directory: "/tmp/gx" }, ...c.client });
  return c;
}

// The goal command reports via session notes; return notes added by the call.
const runCmd = async (c, sessionID, text) => {
  const before = c.notes.length;
  await c.cmds.goal.execute({ sessionID, prompt: { text } });
  return c.notes.slice(before).join("\n");
};
const SID = "goal-test-session";

// GO-12: tool descriptions state the session-scoped no-op.
{
  const c = await setupGoal();
  for (const name of ["goal_complete", "goal_blocked", "goal_progress"]) {
    check(`GO-12 ${name} description states session-scoped no-op`, (c.tools[name]?.description ?? "").startsWith("Session-scoped"), c.tools[name]?.description);
  }
}

// GO-10: maxMinutes 0 means no wall-clock deadline.
{
  const c = await setupGoal({ options: { maxMinutes: 0 } });
  const created = await runCmd(c, SID, "Build a widget");
  check("GO-10 new-goal note reports no deadline", /no wall-clock deadline/i.test(created), created);
  const status = await runCmd(c, SID, "status");
  check("GO-10 status reports no deadline", /no wall-clock deadline/i.test(status), status);
}

// GO-9: resume removes pausedAt instead of assigning undefined.
{
  const c = await setupGoal();
  await runCmd(c, SID, "Build a widget");
  await runCmd(c, SID, "pause");
  await runCmd(c, SID, "resume");
  const stored = c.store.get("goal.v1." + SID);
  check("GO-9 resumed state has no pausedAt key", stored && !("pausedAt" in stored), JSON.stringify(stored));
  check("GO-9 resumed state is active", stored?.status === "active", JSON.stringify(stored));
}

// GO-4: numeric lastHandledMessageID from storage normalises to string.
{
  const seed = await setupGoal();
  await runCmd(seed, SID, "Build a widget");
  const raw = seed.store.get("goal.v1." + SID);
  raw.lastHandledMessageID = 12345;
  const c = await setupGoal({ preset: { ["goal.v1." + SID]: raw } });
  const status = await runCmd(c, SID, "status");
  check("GO-4 numeric lastHandledMessageID loads and works", /Build a widget/.test(status), status);
  check("GO-4 stored id normalised to string", c.store.get("goal.v1." + SID)?.lastHandledMessageID === "12345", JSON.stringify(c.store.get("goal.v1." + SID)));
}

// GO-6: only the unique sentinel is stripped; plain MARK mentions survive.
{
  const c = await setupGoal();
  await runCmd(c, SID, "Build a widget");
  const hook = c.sessionHooks[0];
  const userText = "I love [goal] setting, keep it up";
  const legacy = { role: "system", content: [{ type: "text", text: "[goal-plugin]\nACTIVE GOAL stale" }] };
  const msgs = [
    { role: "user", content: [{ type: "text", text: userText }] },
    legacy,
  ];
  await hook({ type: "context", sessionID: SID, messages: msgs });
  check("GO-6 legacy injected head stripped", !msgs.includes(legacy), JSON.stringify(msgs).slice(0, 300));
  check("GO-6 user text mentioning [goal] survives", msgs.some((m) => JSON.stringify(m).includes(userText)), JSON.stringify(msgs).slice(0, 300));
  const reminders = msgs.filter((m) => JSON.stringify(m).includes("[goal-plugin:reminder:v1]"));
  check("GO-6 exactly one sentinel reminder injected", reminders.length === 1, String(reminders.length));
  await hook({ type: "context", sessionID: SID, messages: msgs });
  const after = msgs.filter((m) => JSON.stringify(m).includes("[goal-plugin:reminder:v1]"));
  check("GO-6 re-inject does not duplicate reminders", after.length === 1, String(after.length));
  check("GO-6 user text still present after re-inject", msgs.some((m) => JSON.stringify(m).includes(userText)), JSON.stringify(msgs).slice(0, 300));
}

// GO-8: non-text parts do not crash hooks.
{
  const c = await setupGoal();
  await runCmd(c, SID, "Build a widget");
  const hook = c.sessionHooks[0];
  const msgs = [
    { role: "system", content: [{ type: "image", data: "abc" }] },
    { role: "user", content: "plain string content" },
  ];
  let threw = false;
  try {
    await hook({ type: "context", sessionID: SID, messages: msgs });
  } catch {
    threw = true;
  }
  check("GO-8 non-text parts do not throw", !threw, "");
}

// GO-7: persist failures are loud, not silent.
{
  const errors = [];
  const orig = console.error;
  console.error = (...a) => { errors.push(a.join(" ")); };
  let c;
  try {
    c = await setupGoal({ throwOnSet: true });
    await runCmd(c, SID, "Build a widget");
  } finally {
    console.error = orig;
  }
  check("GO-7 persist failure logged via console.error", errors.some((e) => /failed to persist goal/.test(e)), errors.join(" | ").slice(0, 300));
  check("GO-7 persist failure surfaced in session note", c.notes.some((n) => /failed to persist goal/i.test(n)), c.notes.join(" | ").slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
