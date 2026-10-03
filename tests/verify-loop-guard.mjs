/**
 * loop-guard verification.
 *
 * Drives the plugin's two real seams — `tool.hook("execute.before")` and
 * `session.hook("context")` — against a stub context. No opencode server is
 * needed.
 *
 *   node tests/verify-loop-guard.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-loop-guard");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_LOOP_GUARD_")) delete process.env[key];
}

const mod = await import("../plugins/loop-guard.ts");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

check("plugin exposes id loop-guard", mod.default?.id === "loop-guard");
check("plugin exposes setup", typeof mod.default?.setup === "function");

/* -------------------------------------------------------------- harness */

function makeCtx(options = {}) {
  const hooks = {};
  const notes = [];
  const interrupts = [];
  const disposals = [];
  const ctx = {
    options,
    location: { directory: sandbox },
    tool: {
      hook: async (name, cb) => {
        hooks[`tool:${name}`] = cb;
        return { dispose: async () => { disposals.push(`tool:${name}`); } };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks[`session:${name}`] = cb;
        return { dispose: async () => { disposals.push(`session:${name}`); } };
      },
      synthetic: async (input) => { notes.push(input); },
      interrupt: async (input) => { interrupts.push(input); },
    },
  };
  return { ctx, hooks, notes, interrupts, disposals };
}

const call = (hooks, sessionID, name, input) =>
  hooks["tool:execute.before"]({ sessionID, tool: name, input });
const request = (hooks, sessionID, messages) =>
  hooks["session:context"]({ sessionID, messages });

const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const assistantTurn = (text, name, input) => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "tool", name, state: { input } }],
});
const hasInjectedNudge = (messages) =>
  messages.some(
    (m) => m.role === "system" && m.content?.[0]?.text?.includes("loop-guard:nudge"),
  );

/* ---------------------------------------------- tool-call repeat stream */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  const cleanup = await mod.default.setup(ctx);
  const sid = "ses_tool";
  const input = { file: "main.tscn" };

  call(hooks, sid, "read", input); // 1
  call(hooks, sid, "read", input); // 2
  check("no nudge below the repeat threshold", notes.length === 0 && interrupts.length === 0);

  call(hooks, sid, "read", input); // 3 -> nudge
  check("nudge at the repeat threshold", notes.length === 1, JSON.stringify(notes));

  const messages = [];
  request(hooks, sid, messages);
  check("nudge is injected as a system message", hasInjectedNudge(messages));

  // The run has not broken yet, so the correction stays in context — but it is
  // replaced, not duplicated.
  request(hooks, sid, messages);
  const nudges = messages.filter(
    (m) => m.role === "system" && m.content?.[0]?.text?.includes("loop-guard:nudge"),
  );
  check("nudge persists but is not duplicated", nudges.length === 1, JSON.stringify(messages));

  call(hooks, sid, "read", input); // 4
  call(hooks, sid, "read", input); // 5
  check("no cancel before the cancel threshold", interrupts.length === 0);

  call(hooks, sid, "read", input); // 6 -> cancel
  check(
    "cancel at the cancel threshold",
    interrupts.length === 1 && interrupts[0].sessionID === sid,
    JSON.stringify(interrupts),
  );

  await cleanup();
}

/* ------------------------------------ interleaved calls never trip it */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_interleaved";
  for (let i = 0; i < 12; i += 1) {
    call(hooks, sid, i % 2 === 0 ? "read" : "glob",
      i % 2 === 0 ? { file: "main.tscn" } : { pattern: "scripts/*.gd" });
  }
  check(
    "interleaved A/B calls never trip the guard",
    notes.length === 0 && interrupts.length === 0,
    JSON.stringify({ notes, interrupts }),
  );
}

/* --------------------------------------- a different call resets the run */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_reset";
  call(hooks, sid, "read", { file: "a" }); // 1
  call(hooks, sid, "read", { file: "a" }); // 2
  call(hooks, sid, "read", { file: "b" }); // different -> reset
  call(hooks, sid, "read", { file: "a" }); // 1
  call(hooks, sid, "read", { file: "a" }); // 2
  check(
    "a different call resets the run",
    notes.length === 0 && interrupts.length === 0,
    JSON.stringify({ notes, interrupts }),
  );
}

/* ------------------------------- equivalent inputs match by stable key order */

{
  const { ctx, hooks, notes } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_keyorder";
  call(hooks, sid, "read", { file: "a", offset: 1 });
  call(hooks, sid, "read", { offset: 1, file: "a" });
  call(hooks, sid, "read", { file: "a", offset: 1 });
  check("key order does not defeat the call signature", notes.length === 1, JSON.stringify(notes));
}

/* ----------------------------------- repeated identical assistant replies */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_reply";
  const same = () => [
    assistantTurn("Let me look at the main scene and its script to find the failure.", "read", {
      file: "main.tscn",
    }),
  ];

  request(hooks, sid, same()); // 1
  request(hooks, sid, same()); // 2
  check("no reply nudge below the repeat threshold", notes.length === 0 && interrupts.length === 0);

  const third = same();
  request(hooks, sid, third); // 3 -> nudge
  check("reply nudge at the repeat threshold", notes.length === 1, JSON.stringify(notes));
  check("reply nudge is injected into the request", hasInjectedNudge(third));

  request(hooks, sid, same()); // 4
  request(hooks, sid, same()); // 5
  request(hooks, sid, same()); // 6 -> cancel
  check("reply cancel at the cancel threshold", interrupts.length === 1, JSON.stringify(interrupts));
}

/* ---------------------------------- interleaved replies never trip it */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_reply_ab";
  request(hooks, sid, [assistantText("A")]);
  request(hooks, sid, [assistantText("B")]);
  request(hooks, sid, [assistantText("A")]);
  request(hooks, sid, [assistantText("B")]);
  check(
    "interleaved A/B replies never trip the guard",
    notes.length === 0 && interrupts.length === 0,
    JSON.stringify({ notes, interrupts }),
  );
}

/* ---------------- identical replies to different prompts are not a loop ---- */

{
  const { ctx, hooks, notes, interrupts } = makeCtx({ repeatLimit: 3, cancelLimit: 6 });
  await mod.default.setup(ctx);
  const sid = "ses_distinct_users";
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  request(hooks, sid, [user("do x"), assistantText("Done.")]);
  request(hooks, sid, [user("do y"), assistantText("Done.")]);
  request(hooks, sid, [user("do z"), assistantText("Done.")]);
  request(hooks, sid, [user("do w"), assistantText("Done.")]);
  check(
    "identical replies to different prompts never trip the guard",
    notes.length === 0 && interrupts.length === 0,
    JSON.stringify({ notes, interrupts }),
  );
}

/* ------------------------------------------------------- default threshold */

{
  const { ctx, hooks, notes } = makeCtx({});
  await mod.default.setup(ctx);
  const sid = "ses_defaults";
  const input = { file: "main.tscn" };
  for (let i = 0; i < 3; i += 1) call(hooks, sid, "read", input);
  check("default repeatLimit is 4 (no nudge at 3)", notes.length === 0, JSON.stringify(notes));
  call(hooks, sid, "read", input); // 4
  check("default repeatLimit nudges at 4", notes.length === 1, JSON.stringify(notes));
}

/* ------------------------------------------------------- disabled / cleanup */

{
  const { ctx, hooks } = makeCtx({ enabled: false });
  await mod.default.setup(ctx);
  check("disabled plugin registers no hooks", Object.keys(hooks).length === 0);
}

{
  const { ctx, hooks, disposals } = makeCtx({});
  const cleanup = await mod.default.setup(ctx);
  check(
    "registers the tool and context hooks",
    typeof hooks["tool:execute.before"] === "function" &&
      typeof hooks["session:context"] === "function",
  );
  await cleanup();
  check("cleanup disposes both registrations", disposals.length === 2, disposals.join(", "));
}

/* -------------------------------------------------------------- summary */

const failed = results.filter((r) => !r.ok);
console.log(`\nverify-loop-guard: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const r of failed) console.error(`  FAILED: ${r.name}`);
  process.exit(1);
}
console.log("verify-loop-guard: all assertions passed");
assert.ok(true);
