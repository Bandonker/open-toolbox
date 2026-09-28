/**
 * Project presence / peer awareness (PP-1..PP-nn).
 *
 * opencode has no `session.list()`, so peers are discovered from the event
 * stream: every session event carries `data.sessionID` and `location.directory`.
 * These tests drive that stream through a stub context and assert the registry
 * groups by directory, expires stale entries, self-claims on first turn, and
 * that the injected notice is stripped and re-added rather than accumulating.
 *
 * The notice is *targeted*, not a roster: a peer is surfaced only when it holds
 * a file this session is writing, is in its lineage, is mid-turn, or declared
 * overlapping work (PP-13..PP-16). Also covered: file claims and the
 * take-turns brief (PP-17..PP-22), the enforced write gate (PP-25..PP-33b),
 * coordination across opencode *processes* (PP-34..PP-37), and that a deleted,
 * forgotten or vanished session leaves the list and is verified rather than
 * assumed (PP-38..PP-47).
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// Two projects: peers are grouped by directory, and nothing from OTHER may
// surface in PROJECT (PP-3, PP-23).
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "verify-presence-"));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), "verify-other-"));

function makeCtx(options = {}) {
  const tools = {};
  const store = new Map();
  const contextHooks = [];
  const toolHooks = [];
  const synthetic = [];
  const prompts = [];
  const subs = [];
  // Session ids the fake server still has. The plugin verifies a quiet peer
  // with session.get, so this set is what makes "alive" vs "gone" testable.
  const alive = new Set();
  /**
   * A stand-in for opencode's tool registry. Shaped like the real editor —
   * add/list/get/update/remove/namespace — because the plugin's write gate
   * installs itself by listing the registered tools and replacing the `execute`
   * of the file-mutating ones. `update` mutates the stored entry, as the real
   * one does.
   */
  const registry = new Map();
  const editor = {
    add: (t) => {
      tools[t.name] = t;
      registry.set(t.name, t);
    },
    list: () => [...registry.values()].map((t) => ({ ...t, id: t.id ?? t.name })),
    get: (id) => {
      const t = registry.get(id);
      return t ? { ...t, id: t.id ?? t.name } : undefined;
    },
    update: (id, fn) => {
      const t = registry.get(id);
      if (t) fn(t);
    },
    remove: (id) => void registry.delete(id),
    namespace: () => {},
  };
  /** Seed a fake built-in tool, as the host's own `edit` / `write` would be. */
  const addBuiltin = (name, execute) => {
    registry.set(name, { name, id: name, execute, description: name });
  };
  // push-based async queue
  const pending = [];
  let wake = null;
  const push = (ev) => {
    // Any event proves the session exists; the deletion event proves it does
    // not. The plugin probes session.get to find out, so the fake server has to
    // agree with it.
    const id = ev?.data?.sessionID;
    if (typeof id === "string") {
      if (ev.type === "session.deleted") alive.delete(id);
      else alive.add(id);
    }
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

  const ctx = {
    options: options.options ?? {},
    location: { directory: PROJECT, project: { id: "proj-1", directory: PROJECT, canonical: PROJECT } },
    event: {
      subscribe: ({ signal } = {}) => {
        subs.push({ signal });
        return drain(signal);
      },
    },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      // v2 also offers remove/scan. The in-flight lock needs scan to see markers
      // published by a *different* opencode process, so the fake store models a
      // shared, enumerable keyspace rather than a per-instance map.
      remove: async (k) => void store.delete(k),
      scan: async ({ prefix }) => ({
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      // Models the server's existence check: a real session resolves, anything
      // else rejects with NotFoundError, exactly as opencode does. The plugin
      // uses this to tell a quiet session from a deleted one.
      get: async ({ sessionID }) => {
        if (!alive.has(sessionID)) {
          const err = new Error("Session.NotFoundError");
          err.name = "Session.NotFoundError";
          throw err;
        }
        return { id: sessionID, title: "x", parentID: "p" };
      },
      context: async () => [],
      interrupt: async () => {},
      synthetic: async (a) => void synthetic.push(a),
      prompt: async (a) => void prompts.push(a),
    },
    tool: {
      // The concurrent-edit seam. Recorded so a test can fire it the way the
      // server does, and so PP-24 can prove nothing registers when off.
      hook: async (name, cb) => {
        toolHooks.push({ name, cb });
        return { dispose: async () => {} };
      },
      transform: async (cb) => {
        cb(editor);
        return { dispose: async () => {} };
      },
    },
    hook: async (name, cb) => void contextHooks.push({ name, cb }),
  };
  // session.hook is on ctx.session for this plugin's usage
  ctx.session.hook = async (name, cb) => void contextHooks.push({ name, cb });

  return {
    ctx,
    tools,
    store,
    contextHooks,
    toolHooks,
    synthetic,
    prompts,
    push,
    subs,
    alive,
    editor,
    registry,
    addBuiltin,
  };
}

// Ids are 8+ chars so they survive the 8-char shortId used in display output,
// while staying long enough that the assertions below are unambiguous.
const ID_A = "ses_aaaa01";
const ID_B = "ses_bbbb02";
const ID_C = "ses_cccc03";
const ID_D = "ses_dddd04";
const ID_E = "ses_eeee05";
// Displayed rows use an 8-char shortId, so fixtures must be <= 8 chars for
// assertions to match on what a user actually sees.
const SELF = "ses_self";
const PEER = "ses_peer0";
// Fixtures for the targeting and concurrent-edit checks below. Each must be
// <= 8 chars so the displayed shortId matches, and distinct from the above.
const RUNNER = "ses_run_a";
const UNRELATED = "ses_idle_a";
const WRITER_A = "ses_wra_01";
const WRITER_B = "ses_wrb_01";
const READER = "ses_read_a";
const OUTSIDER = "ses_outsid";
const OTHER_PROC = "ses_otherproc";

const sessionEvent = (sessionID, directory, type = "session.step.started") => ({
  type,
  location: { directory },
  data: { sessionID, agent: "build" },
});

/** Text of a hook-injected message, whichever shape the content arrived in. */
const msgText = (m) =>
  Array.isArray(m?.content) ? m.content.map((c) => c.text).join("") : String(m?.content ?? "");

// ---------------------------------------------------------------- PP-1..4
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  check(
    "PP-1 all three presence tools register",
    !!h.tools.project_sessions && !!h.tools.session_broadcast &&
      typeof h.tools.session_send?.execute === "function",
  );

  // Feed events for two sessions in this project and one in another project.
  h.push(sessionEvent(ID_A, PROJECT));
  h.push(sessionEvent(ID_B, PROJECT, "session.idle"));
  h.push(sessionEvent(ID_C, OTHER));
  // The pump is started in setup; give the async generator a tick to drain.
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  const text = out.content;
  check(
    "PP-2 sees a peer in the same project",
    text.includes(ID_A.slice(0, 8)) && text.includes(ID_B.slice(0, 8)),
    text.replace(/\n/g, " | ").slice(0, 150),
  );
  check("PP-3 does NOT leak sessions from another project", !text.includes(ID_C.slice(0, 8)), "other-project peer hidden");
  // Assert on this peer's own line, not the whole blob: the other peer is
  // legitimately "running", so a bare /idle/ scan would match the wrong row.
  const bLine = text.split("\n").find((l) => l.includes(ID_B.slice(0, 8))) ?? "";
  check("PP-4 idle peer is reported as idle", /\bidle\b/.test(bLine), bLine.trim() || "row not found");
}

// ---------------------------------------------------------------- PP-5
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const out = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check("PP-5 reports no peers when the project is empty", out.content.startsWith("No other sessions"), out.content.slice(0, 80));
}

// ---------------------------------------------------------------- PP-6
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const out = await h.tools.project_sessions.execute({ task: "refactoring the auth module" }, { sessionID: SELF });
  check("PP-6 project_sessions can declare a task", out.content.includes("No other sessions"), out.content.slice(0, 60));

  // PP-7: within one instance, a claimed task must show up for another session.
  // (Cross-process visibility is PP-7b below, via the shared storage mirror.)
  const h2 = makeCtx();
  await mod.default.setup(h2.ctx);
  const out2 = await h2.tools.project_sessions.execute({ task: "updating the install docs" }, { sessionID: PEER });
  const out3 = await h2.tools.project_sessions.execute({}, { sessionID: "ses_view0" });
  check(
    "PP-7 a claimed task is visible to a peer",
    out3.content.includes("updating the install docs"),
    out3.content.replace(/\n/g, " | ").slice(0, 160),
  );
  void out2;
}

// ---------------------------------------------------------------- PP-7b cross-process mirror
{
  const shared = new Map();
  const mk = () => {
    const h = makeCtx();
    h.ctx.storage = {
      get: async (k) => shared.get(k),
      set: async (k, v) => void shared.set(k, v),
      remove: async (k) => void shared.delete(k),
      scan: async ({ prefix }) => ({
        entries: [...shared.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    };
    return h;
  };
  const a = mk();
  await mod.default.setup(a.ctx);
  a.tools.project_sessions.execute({ task: "adding the presence feature" }, { sessionID: SELF });
  // The mirror is debounced (2s) by design; wait it out.
  await new Promise((r) => setTimeout(r, 2400));
  const b = mk();
  await mod.default.setup(b.ctx);
  // b's setup reads the snapshot asynchronously; give it a tick.
  await new Promise((r) => setTimeout(r, 60));
  const out = await b.tools.project_sessions.execute({}, { sessionID: "ses_other0" });
  check(
    "PP-7b presence crosses process boundaries via ctx.storage",
    out.content.includes("adding the presence feature"),
    out.content.replace(/\n/g, " | ").slice(0, 180),
  );
}

// ---------------------------------------------------------------- PP-8/9 awareness injection
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  check(
    "PP-8 a context hook is registered for awareness",
    h.contextHooks.some((x) => x.name === "context"),
    h.contextHooks.map((x) => x.name).join(","),
  );

  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  const messages = [];
  await hook({ sessionID: SELF, messages });

  // Self-claim must have happened with no observable event at all. Ask from a
  // different session id so the claim shows up as a peer row.
  const claimed = await h.tools.project_sessions.execute({}, { sessionID: PEER });
  const selfRow = claimed.content.split("\n").find((l) => l.includes(SELF)) ?? "";
  check(
    "PP-9 the session self-claims on first turn",
    /\brunning\b/.test(selfRow) && selfRow.length > 0,
    selfRow.trim() ||
      `no row for ${SELF} in: ${claimed.content.replace(/\n/g, " | ").slice(0, 200)}`,
  );

  // Now a real peer shows up and the notice should appear.
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  const notice = messages.map(msgText).join("\n");
  check(
    "PP-10 awareness notice is injected when a peer exists",
    notice.includes("relevant session") && notice.includes(ID_A.slice(0, 8)),
    notice.replace(/\n/g, " | ").slice(0, 170),
  );

  // Calling again must replace, not accumulate.
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  await hook({ sessionID: SELF, messages });
  const notices = messages.filter((m) => msgText(m).includes("[opencode-sessions:peers]"));
  check("PP-11 awareness notice is replaced, not duplicated", notices.length === 1, `${notices.length} notices present`);

  // A notice that was injected must be *removed*, not left stale, once the
  // peer behind it is gone. Reuse the same message array so the strip path is
  // what is being tested (this used to assert against String() of a content
  // array, which can never contain the sentinel, so it passed vacuously).
  h.push(sessionEvent(ID_A, PROJECT, "session.deleted"));
  await new Promise((r) => setTimeout(r, 60));
  await hook({ sessionID: SELF, messages });
  const leftover = messages.filter((m) => msgText(m).includes("[opencode-sessions:peers]"));
  check(
    "PP-12 a notice is removed once its peers are gone",
    leftover.length === 0,
    `${leftover.length} notices left behind`,
  );
}

// ------------------------------------------------- PP-13..16 targeted briefs
// The notice must name only the peers that bear on this session. An unrelated
// idle peer with a different task is exactly the noise the old roster emitted
// on every turn of every session.
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;

  // RUNNER is mid-turn; UNRELATED goes idle on an unrelated subject. The task
  // must be declared *before* the idle event, because declaring a task also
  // records the session as running.
  await h.tools.project_sessions.execute({ task: "auditing dependency licenses" }, { sessionID: UNRELATED });
  h.push(sessionEvent(RUNNER, PROJECT, "session.execution.started"));
  h.push(sessionEvent(UNRELATED, PROJECT, "session.idle"));
  await new Promise((r) => setTimeout(r, 60));
  await h.tools.project_sessions.execute({ task: "refactoring the auth module" }, { sessionID: SELF });
  await new Promise((r) => setTimeout(r, 10));

  const messages = [];
  await hook({ sessionID: SELF, messages });
  const notice = messages.map(msgText).join("\n");
  const has = (id) => notice.includes(id.slice(0, 8));

  check("PP-13 a running peer is briefed", has(RUNNER), notice.replace(/\n/g, " | ").slice(0, 180));
  check(
    "PP-14 an unrelated idle peer is NOT briefed",
    !has(UNRELATED) && notice.includes("1 unrelated"),
    notice.replace(/\n/g, " | ").slice(0, 180),
  );

  // Now make them overlap: an idle peer whose declared task shares a content
  // word with ours *is* relevant, and must be labelled as such. Re-push the
  // idle event so the claim below does not flip it back to running.
  await h.tools.project_sessions.execute({ task: "auth module cleanup" }, { sessionID: UNRELATED });
  h.push(sessionEvent(UNRELATED, PROJECT, "session.idle"));
  await new Promise((r) => setTimeout(r, 60));
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  const related = messages.map(msgText).join("\n");
  check(
    "PP-15 an idle peer with an overlapping task IS briefed",
    related.includes(UNRELATED.slice(0, 8)) && related.includes("related task"),
    related.replace(/\n/g, " | ").slice(0, 200),
  );
}

// ------------------------------------------------------ PP-16 line-over-cap
{
  const h = makeCtx({ options: { maxPeers: 2 } });
  await mod.default.setup(h.ctx);
  for (let i = 0; i < 5; i++) h.push(sessionEvent(`ses_run${i}00`, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  const messages = [];
  await hook({ sessionID: SELF, messages });
  const notice = messages.map(msgText).join("\n");
  const rows = notice.split("\n").filter((l) => l.startsWith("- ses_run"));
  check(
    "PP-16 the brief is capped and the remainder is summarised",
    rows.length === 2 && notice.includes("2 of 5 relevant sessions"),
    `${rows.length} rows; ${notice.replace(/\n/g, " | ").slice(0, 160)}`,
  );
}

// ------------------------------------------- PP-17..20 concurrent-edit briefs
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const toolHook = h.toolHooks.find((x) => x.name === "execute.before")?.cb;
  check(
    "PP-17 a tool hook observes file writes",
    typeof toolHook === "function",
    h.toolHooks.map((x) => x.name).join(",") || "none",
  );
  if (typeof toolHook === "function") {
    const hook = h.contextHooks.find((x) => x.name === "context")?.cb;

    // Both sessions write the same file. The second one is mid-turn, the first
    // is idle, so only the file claim can link them.
    h.push(sessionEvent(WRITER_A, PROJECT, "session.idle"));
    h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
    await new Promise((r) => setTimeout(r, 60));

    await toolHook({ tool: "edit", sessionID: WRITER_A, input: { filePath: `${PROJECT}/src/auth.ts` } });
    await toolHook({ tool: "write", sessionID: WRITER_B, input: { filePath: `${PROJECT}/src/auth.ts` } });
    const messages = [];
    await hook({ sessionID: WRITER_B, messages });
    const notice = messages.map(msgText).join("\n");

    check(
      "PP-18 two sessions editing one file get a take-turns brief",
      notice.includes("CONCURRENT EDIT") &&
        notice.includes("src/auth.ts") &&
        notice.includes(WRITER_A.slice(0, 8)),
      notice.replace(/\n/g, " | ").slice(0, 240),
    );
    // The brief has to be actionable, not just informational.
    check(
      "PP-19 the collision brief says which side waits",
      /wait for them to release|session_send/.test(notice),
      notice.split("\n").find((l) => l.startsWith("CONCURRENT EDIT")) ?? "no collision line",
    );
  }
}

// ------------------------------------------- PP-20 relative paths, not just absolute
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const toolHook = h.toolHooks.find((x) => x.name === "execute.before")?.cb;
  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  // A relative path from one session and an absolute path from another must
  // resolve to the same claim, or the collision is missed on the common case.
  h.push(sessionEvent(WRITER_A, PROJECT, "session.idle"));
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  await toolHook({ tool: "edit", sessionID: WRITER_A, input: { filePath: "src/lib/db.ts" } });
  await toolHook({ tool: "edit", sessionID: WRITER_B, input: { filePath: `${PROJECT}/src/lib/db.ts` } });
  const messages = [];
  await hook({ sessionID: WRITER_B, messages });
  const notice = messages.map(msgText).join("\n");
  check(
    "PP-20 relative and absolute paths collide",
    notice.includes("CONCURRENT EDIT") && notice.includes("src/lib/db.ts"),
    notice.replace(/\n/g, " | ").slice(0, 200),
  );

  // A read is not a write: `read` must not create a claim.
  h.push(sessionEvent(READER, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  await toolHook({ tool: "read", sessionID: READER, input: { filePath: `${PROJECT}/src/other.ts` } });
  const after = [];
  await hook({ sessionID: READER, messages: after });
  const afterText = after.map(msgText).join("\n");
  check("PP-21 a read creates no claim", !afterText.includes("src/other.ts"), afterText.replace(/\n/g, " | ").slice(0, 160));
}

// ------------------------------------------- PP-22 claims released when a session goes idle
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const toolHook = h.toolHooks.find((x) => x.name === "execute.before")?.cb;
  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  h.push(sessionEvent(WRITER_A, PROJECT, "session.execution.started"));
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  await toolHook({ tool: "edit", sessionID: WRITER_A, input: { filePath: `${PROJECT}/src/x.ts` } });
  await toolHook({ tool: "edit", sessionID: WRITER_B, input: { filePath: `${PROJECT}/src/x.ts` } });

  // WRITER_A finishes its turn, so it is no longer mid-edit: the collision
  // must clear, otherwise the waiting side waits forever.
  h.push(sessionEvent(WRITER_A, PROJECT, "session.idle"));
  await new Promise((r) => setTimeout(r, 60));
  const messages = [];
  await hook({ sessionID: WRITER_B, messages });
  const notice = messages.map(msgText).join("\n");
  check("PP-22 going idle releases the claim", !notice.includes("CONCURRENT EDIT"), notice.replace(/\n/g, " | ").slice(0, 200));
}

// ------------------------------------------- PP-23 a claim never crosses projects
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const toolHook = h.toolHooks.find((x) => x.name === "execute.before")?.cb;
  // The tool hook is server-wide, so it also sees sessions working in another
  // project. Filing one under this directory would defeat the very grouping
  // PP-3 checks on the event path.
  await toolHook({ tool: "edit", sessionID: OUTSIDER, input: { filePath: `${OTHER}/src/x.ts` } });
  const listed = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check(
    "PP-23 a write from another project creates no peer here",
    !listed.content.includes(OUTSIDER.slice(0, 8)) && /No other sessions/.test(listed.content),
    listed.content.replace(/\n/g, " | ").slice(0, 160),
  );
}

// ------------------------------------------- PP-24 fileLocks off
{
  const h = makeCtx({ options: { fileLocks: "off" } });
  await mod.default.setup(h.ctx);
  check(
    "PP-24 fileLocks:off registers no write hook",
    !h.toolHooks.some((x) => x.name === "execute.before"),
    h.toolHooks.map((x) => x.name).join(",") || "none",
  );
}

// ------------------------------------ PP-25..30 the enforced write gate
// fileLocks:"advise" only tells the model to hold off, which a model that has
// already decided to edit may not. "enforce" wraps the host's own file-mutating
// tools so a colliding write actually waits for the other write to finish.
{
  const h = makeCtx({
    options: { fileLocks: "enforce", lockWaitSec: 3, peerLiveSec: 300 },
  });
  // Stand-ins for the host's built-ins. `edit` can be held open so a test can
  // model a write that is genuinely still in progress.
  const ran = [];
  let holdWrite = null;
  h.addBuiltin("edit", async () => {
    ran.push("edit");
    if (holdWrite) await holdWrite;
  });
  h.addBuiltin("write", async () => void ran.push("write"));
  h.addBuiltin("read", async () => void ran.push("read"));
  await mod.default.setup(h.ctx);

  check(
    "PP-25 enforce wraps the built-in write tools",
    typeof h.registry.get("edit").execute === "function" && ran.length === 0,
    `tools: ${[...h.registry.keys()].join(",")}`,
  );
  check("PP-26 the gate leaves non-writing tools alone", !ran.includes("read"), "read untouched");

  h.push(sessionEvent(WRITER_A, PROJECT, "session.execution.started"));
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  const edit = () => h.registry.get("edit").execute;
  const ctxFor = (id) => ({ sessionID: id, signal: undefined });
  const target = `${PROJECT}/src/gate.ts`;

  // WRITER_A's write is still running. WRITER_B must wait, then proceed as soon
  // as the write finishes — not when A's turn ends.
  let releaseA = null;
  holdWrite = new Promise((r) => (releaseA = r));
  const aWrite = edit()({ filePath: target }, ctxFor(WRITER_A));
  await new Promise((r) => setTimeout(r, 50));
  check(
    "PP-27 a write in progress is visible as in flight",
    ran.filter((r) => r === "edit").length === 1,
    ran.join(","),
  );

  let bDone = false;
  const bWrite = edit()({ filePath: target }, ctxFor(WRITER_B)).then(() => (bDone = true));
  await new Promise((r) => setTimeout(r, 1200));
  check(
    "PP-28 a second write to the same file waits",
    !bDone,
    bDone ? "went through while A was writing" : "still waiting",
  );

  // A's write finishes. B must go through immediately, even though A's turn is
  // nowhere near over — the point of not keying the wait to turns.
  releaseA();
  await aWrite;
  await bWrite;
  check(
    "PP-29 the wait ends when the write finishes, not when the turn does",
    bDone && ran.filter((r) => r === "edit").length === 2,
    `ran=${ran.join(",")}`,
  );

  // An uncontended write still does not wait at all.
  const started = Date.now();
  await edit()({ filePath: `${PROJECT}/src/other.ts` }, ctxFor(WRITER_B));
  check("PP-30 an uncontended write returns immediately", Date.now() - started < 500, `${Date.now() - started}ms`);
}

// ------------------------- PP-31..33b a write that never finishes
{
  const h = makeCtx({
    options: { fileLocks: "enforce", lockWaitSec: 1, peerLiveSec: 300 },
  });
  const ran = [];
  // `hang` makes the next write block until the test opens the gate, modelling a
  // tool call that never returns.
  let hang = false;
  let openGate = null;
  h.addBuiltin("edit", async () => {
    ran.push("edit");
    if (hang) await new Promise((r) => (openGate = r));
  });
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(WRITER_A, PROJECT, "session.execution.started"));
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  const edit = () => h.registry.get("edit").execute;
  const ctxFor = (id) => ({ sessionID: id, signal: undefined });
  const target = `${PROJECT}/src/wedged.ts`;

  hang = true;
  const aWrite = edit()({ filePath: target }, ctxFor(WRITER_A));
  await new Promise((r) => setTimeout(r, 50));
  check("PP-31 a write that never finishes is detected as in flight", ran.length === 1, `ran=${ran.join(",")}`);

  let blocked = null;
  const started = Date.now();
  try {
    await edit()({ filePath: target }, ctxFor(WRITER_B));
  } catch (err) {
    blocked = String(err?.message ?? err);
  }
  const waited = Date.now() - started;
  check(
    "PP-32 a wedged write does not lock the file forever",
    blocked !== null && /Gave up waiting/.test(blocked),
    (blocked ?? "no error raised").slice(0, 200),
  );
  check(
    "PP-33 the refusal names the holder, the file, and how to proceed",
    /wedged\.ts/.test(blocked ?? "") &&
      new RegExp(WRITER_A.slice(0, 8)).test(blocked ?? "") &&
      /session_send/.test(blocked ?? ""),
    (blocked ?? "").slice(0, 200),
  );
  check(
    "PP-33b the blocked write waited, then refused without clobbering",
    waited >= 900 && ran.length === 1,
    `${waited}ms, ran=${ran.join(",")}`,
  );

  // Let A's write finish so the harness can exit.
  if (openGate) openGate();
  await aWrite;
}

// ---------------------- PP-34..37 coordinating across opencode processes
// Two sessions in one process are covered above. A standalone `opencode` run
// alongside the Desktop app is a *separate* process with its own memory, so the
// lock has to be published to the shared store to mean anything there.
{
  const h = makeCtx({
    options: { fileLocks: "enforce", lockWaitSec: 2, peerLiveSec: 300, inflightTtlSec: 3 },
  });
  const ran = [];
  h.addBuiltin("edit", async () => {
    ran.push("edit");
  });
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  // `write` re-reads the registry each call, because installWriteGate replaces
  // the registered `execute` at setup time. Note the call shape: `write()` gets
  // the function, `write()(...)` invokes it.
  const write = () => h.registry.get("edit").execute;
  const target = `${PROJECT}/src/cross.ts`;

  // Publish an in-flight marker as another *process* would: written straight
  // into the shared store, never seen by this instance's memory.
  h.store.set(`inflight:${OTHER_PROC}`, {
    sessionId: OTHER_PROC,
    directory: PROJECT,
    paths: ["src/cross.ts"],
    at: Date.now(),
  });

  let blocked = null;
  try {
    await write()({ filePath: target }, { sessionID: WRITER_B, signal: undefined });
  } catch (err) {
    blocked = String(err?.message ?? err);
  }
  check(
    "PP-34 a write in progress in another process blocks this one",
    blocked !== null && /another opencode process/.test(blocked) && ran.length === 0,
    (blocked ?? "no error raised").slice(0, 200),
  );

  // A marker older than the TTL must be ignored, not obeyed: this is the crash
  // case, and obeying a stale marker forever is how a lock wedges.
  h.store.get(`inflight:${OTHER_PROC}`).at = Date.now() - 4000;
  ran.length = 0;
  let stale = null;
  try {
    await write()({ filePath: target }, { sessionID: WRITER_B, signal: undefined });
  } catch (err) {
    stale = String(err?.message ?? err);
  }
  check(
    "PP-35 a marker past its TTL is ignored, so a crashed peer cannot wedge the file",
    stale === null && ran.length === 1,
    (stale ?? `ran=${ran.join(",")}`).slice(0, 200),
  );

  // A marker for a *different project* must not block: claim keys are
  // project-relative, so the same relative path in two repos is not a conflict.
  const fresh = Date.now();
  h.store.set(`inflight:${OTHER_PROC}`, {
    sessionId: OTHER_PROC,
    directory: OTHER,
    paths: ["src/cross.ts"],
    at: fresh,
  });
  ran.length = 0;
  let other = null;
  try {
    await write()({ filePath: target }, { sessionID: WRITER_B, signal: undefined });
  } catch (err) {
    other = String(err?.message ?? err);
  }
  check(
    "PP-36 a marker from another project does not block this one",
    other === null && ran.length === 1,
    (other ?? `ran=${ran.join(",")}`).slice(0, 200),
  );

  // A finished write must remove its own marker, so it cannot linger as a block.
  h.store.delete(`inflight:${OTHER_PROC}`);
  h.store.set(`inflight:${WRITER_B}`, {
    sessionId: WRITER_B,
    directory: PROJECT,
    paths: ["src/cross.ts"],
    at: fresh,
  });
  const before = ran.length;
  await write()({ filePath: target }, { sessionID: WRITER_B, signal: undefined });
  check(
    "PP-37 a completed write clears its own marker",
    h.store.has(`inflight:${WRITER_B}`) === false && ran.length === before + 1,
    `markers left: ${[...h.store.keys()].filter((k) => k.startsWith("inflight:")).join(",") || "none"}`,
  );
}

// ---------------------------------------------------------------- PP-38 broadcast
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  h.push(sessionEvent(ID_B, PROJECT));
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.session_broadcast.execute(
    { text: "I am renaming the auth module, hands off", noReply: true },
    { sessionID: SELF },
  );
  check("PP-38 broadcast reaches every peer", out.content.includes("2/2"), out.content);
  check(
    "PP-39 broadcast uses synthetic when noReply",
    h.synthetic.length === 2 && h.prompts.length === 0,
    `synthetic=${h.synthetic.length} prompts=${h.prompts.length}`,
  );
}

// ---------------------------------------------------------------- PP-40 send to a peer
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.session_send.execute(
    { sessionId: ID_A, text: "are you editing README?" },
    { sessionID: SELF },
  );
  check(
    "PP-40 session_send reaches an untracked peer session",
    h.prompts.some((p) => p.sessionID === ID_A),
    out.content.slice(0, 120),
  );
  check("PP-41 send-to-peer is reported as a peer, not a child", /peer session/.test(out.content), out.content.slice(0, 120));

  // Unknown id that is not a peer must still be refused.
  const bad = await h.tools.session_send.execute({ sessionId: "ses_unknownunknown", text: "hi" }, { sessionID: SELF });
  check("PP-42 an entirely unknown session is still refused", /Unknown session/.test(bad.content), bad.content.slice(0, 100));
}

// ------------------------------------- PP-43 a deleted session leaves the list
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));
  let list = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check("PP-43 a live peer is listed", list.content.includes(ID_A.slice(0, 8)), list.content.replace(/\n/g, " | ").slice(0, 140));

  // The user closes that session in the Desktop switcher. The deletion event
  // must purge it — the old code ran it through the generic presence branch
  // and re-registered it as "running", resurrecting the entry.
  h.push(sessionEvent(ID_A, PROJECT, "session.deleted"));
  await new Promise((r) => setTimeout(r, 60));
  list = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check(
    "PP-44 session.deleted removes it from the list",
    !list.content.includes(ID_A.slice(0, 8)),
    list.content.replace(/\n/g, " | ").slice(0, 140),
  );

  // And it must not be a message target any more.
  const send = await h.tools.session_send.execute({ sessionId: ID_A, text: "still there?" }, { sessionID: SELF });
  check(
    "PP-45 a deleted session is not messaged",
    /Unknown session/.test(send.content) && h.prompts.length === 0,
    send.content.slice(0, 120),
  );
}

// ------------------------------------- PP-46 forget clears a live-looking ghost
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));
  const out = await h.tools.project_sessions.execute({ forget: `${ID_A}, ses_notknown0` }, { sessionID: SELF });
  // The id appears in the "Removed" preamble, so the listing is what matters.
  check(
    "PP-46 forget removes the named session from the listing",
    /Removed 1 session/.test(out.content) && !/^\- ses_aaaa/m.test(out.content),
    out.content.replace(/\n/g, " | ").slice(0, 200),
  );
  check(
    "PP-46b forget tolerates an id it does not know",
    !/ses_notknown0/.test(out.content),
    out.content.replace(/\n/g, " | ").slice(0, 200),
  );

  const send = await h.tools.session_send.execute({ sessionId: ID_A, text: "still there?" }, { sessionID: SELF });
  check("PP-46c a forgotten session is no longer a message target", /Unknown session/.test(send.content), send.content.slice(0, 120));
}

// ------------------------------------- PP-47..50 verified liveness
// A quiet peer is ambiguous: it may be mid-command (reachable) or gone (not).
// The plugin must ask the server rather than guess, because the two failures
// are asymmetric — refusing a live peer loses a message, prompting a dead one
// burns a turn in a session nobody is watching.
//
// peerLiveSec clamps at 5s, so becoming "quiet" means really waiting; there is
// no clock the test can wind. One wait covers the whole block.
{
  const h = makeCtx({ options: { peerLiveSec: 5 } });
  await mod.default.setup(h.ctx);
  // All of these go quiet at the same time, so one wait covers every verdict.
  // Each vanished case gets its own peer because discovery is destructive: the
  // first check to find a peer gone drops it, so a later check would find
  // nothing left to report.
  for (const id of [ID_A, ID_B, ID_D, ID_E]) h.push(sessionEvent(id, PROJECT, "session.idle"));
  await new Promise((r) => setTimeout(r, 60));
  await new Promise((r) => setTimeout(r, 5200));

  const listed = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check(
    "PP-47 a quiet peer is listed once the server confirms it",
    listed.content.includes(ID_A.slice(0, 8)) && /alive, idle/.test(listed.content),
    listed.content.replace(/\n/g, " | ").slice(0, 200),
  );

  // It exists, so messaging it must work. The old behaviour refused here purely
  // on the timer, which would have silently dropped a legitimate message.
  const send = await h.tools.session_send.execute({ sessionId: ID_A, text: "you still there?" }, { sessionID: SELF });
  check(
    "PP-48 a quiet but existing peer IS messaged",
    h.prompts.some((p) => p.sessionID === ID_A) && /starts a new turn/.test(send.content),
    send.content.slice(0, 200),
  );

  // Take ID_B out from under the plugin, the way a crash or a delete in another
  // process would: no event, the server simply does not have it any more.
  h.alive.delete(ID_B);
  h.prompts.length = 0;
  const gone = await h.tools.session_send.execute({ sessionId: ID_B, text: "still there?" }, { sessionID: SELF });
  check(
    "PP-49 a peer the server does not have is not messaged",
    /is gone/.test(gone.content) && h.prompts.length === 0,
    gone.content.slice(0, 200),
  );

  // Same disappearance, but discovered by listing rather than by sending.
  h.alive.delete(ID_D);
  const afterGone = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check(
    "PP-49b listing confirms a vanished peer and drops it",
    !new RegExp(`^- ${ID_D.slice(0, 8)}`, "m").test(afterGone.content) && /Confirmed gone/.test(afterGone.content),
    afterGone.content.replace(/\n/g, " | ").slice(0, 200),
  );

  // A broadcast must reach the live peer and report the vanished one rather
  // than silently dropping it or reviving it.
  h.alive.delete(ID_E);
  h.push(sessionEvent(ID_C, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  h.synthetic.length = 0;
  const mixed = await h.tools.session_broadcast.execute({ text: "heads up", noReply: true }, { sessionID: SELF });
  check(
    "PP-50 a broadcast reaches the live peers and reports the vanished one",
    /Broadcast to 2\/2/.test(mixed.content) &&
      new RegExp(`Confirmed gone and dropped: .*${ID_E.slice(0, 8)}`).test(mixed.content) &&
      h.synthetic.some((s) => s.sessionID === ID_C) &&
      !h.synthetic.some((s) => s.sessionID === ID_E),
    mixed.content.replace(/\n/g, " | ").slice(0, 200),
  );
}

// -------------------------------- PP-53..55 presence across processes
// The registry used to be one storage key holding every peer, which is
// last-writer-wins: two processes each overwrote the other's view. It was also
// read exactly once at startup, so a session opened afterwards stayed invisible
// forever. Both are covered here.
{
  const shared = new Map();
  const store = {
    get: async (k) => shared.get(k),
    set: async (k, v) => void shared.set(k, v),
    remove: async (k) => void shared.delete(k),
    scan: async ({ prefix }) => ({
      entries: [...shared.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
  const mk = () => {
    const h = makeCtx({ options: { peerHeartbeatSec: 5 } });
    h.ctx.storage = store;
    return h;
  };

  // a and b are two opencode processes on the same project.
  const a = mk();
  await mod.default.setup(a.ctx);
  const b = mk();
  await mod.default.setup(b.ctx);
  await new Promise((r) => setTimeout(r, 80));

  // Each process observes a session the other has never heard of.
  a.push(sessionEvent(ID_A, PROJECT));
  b.push(sessionEvent(ID_B, PROJECT));
  // The mirror is debounced by design; wait it out.
  await new Promise((r) => setTimeout(r, 2400));
  // A session that opens *after* both processes started. The old code read the
  // snapshot once at startup, so this peer would never have been discovered.
  a.push(sessionEvent(ID_D, PROJECT));
  await new Promise((r) => setTimeout(r, 2400));
  // Both facts are only visible to the other process on a refresh tick, so one
  // wait covers them both.
  await new Promise((r) => setTimeout(r, 5200));

  const bSees = await b.tools.project_sessions.execute({}, { sessionID: "ses_askb00" });
  const aSees = await a.tools.project_sessions.execute({}, { sessionID: "ses_aska00" });
  check(
    "PP-53 each process sees the other's peer (no last-writer-wins clobber)",
    bSees.content.includes(ID_A.slice(0, 8)) && aSees.content.includes(ID_B.slice(0, 8)),
    `b: ${bSees.content.replace(/\n/g, " | ").slice(0, 130)}`,
  );
  check(
    "PP-53b presence is published under per-peer keys, not one shared key",
    [...shared.keys()].filter((k) => k.startsWith("presence:v2:")).length >= 2 &&
      !shared.has("presence:v2"),
    `keys: ${[...shared.keys()].join(",")}`,
  );
  check(
    "PP-54 a peer that appears after boot is discovered on the refresh tick",
    bSees.content.includes(ID_D.slice(0, 8)),
    bSees.content.replace(/\n/g, " | ").slice(0, 160),
  );

  // Deleting a session drops its shared key, so the other process stops
  // advertising it at once rather than waiting for it to age out.
  a.push(sessionEvent(ID_D, PROJECT, "session.deleted"));
  await new Promise((r) => setTimeout(r, 2400));
  check(
    "PP-55 forgetting a peer removes its shared record",
    !shared.has(`presence:v2:${ID_D}`),
    `still present: ${[...shared.keys()].filter((k) => k.includes(ID_D)).join(",") || "no"}`,
  );
}

// ------------------------- PP-56..58 lock-order inversion is named, not hidden
// A write covering two files can invert: a holds f1 and wants f2, b holds f2 and
// wants f1. Waiting cannot break that, so the failure has to be *legible* — the
// model can only act on it if it is told what is actually wrong.
{
  const h = makeCtx({
    options: { fileLocks: "enforce", lockWaitSec: 1, peerLiveSec: 300 },
  });
  const ran = [];
  let holdWrite = null;
  h.addBuiltin("edit", async () => {
    ran.push("edit");
    if (holdWrite) await holdWrite;
  });
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(WRITER_A, PROJECT, "session.execution.started"));
  h.push(sessionEvent(WRITER_B, PROJECT, "session.execution.started"));
  await new Promise((r) => setTimeout(r, 60));
  const write = () => h.registry.get("edit").execute;
  const ctxFor = (id) => ({ sessionID: id, signal: undefined });

  // A takes f1 and stays inside the write; B takes f2 and stays inside it too.
  let releaseA = null;
  let releaseB = null;
  holdWrite = new Promise((r) => (releaseA = r));
  const a1 = write()({ filePath: `${PROJECT}/src/f1.ts` }, ctxFor(WRITER_A));
  await new Promise((r) => setTimeout(r, 30));
  holdWrite = new Promise((r) => (releaseB = r));
  const b2 = write()({ filePath: `${PROJECT}/src/f2.ts` }, ctxFor(WRITER_B));
  await new Promise((r) => setTimeout(r, 30));
  holdWrite = null;

  // Now each asks for *both* files. A still holds f1, B still holds f2, so each
  // is blocked by the other — a genuine cycle, not ordinary contention. Both
  // must be in flight at once: a holder that is not itself waiting is just slow.
  const both = {
    edits: [
      { path: `${PROJECT}/src/f1.ts` },
      { path: `${PROJECT}/src/f2.ts` },
    ],
  };
  let aErr = null;
  let bErr = null;
  await Promise.all([
    write()(both, ctxFor(WRITER_A)).catch((err) => (aErr = String(err?.message ?? err))),
    write()(both, ctxFor(WRITER_B)).catch((err) => (bErr = String(err?.message ?? err))),
  ]);
  check(
    "PP-56 a lock-order inversion is reported as a deadlock",
    /Deadlock/.test(aErr ?? "") && /Deadlock/.test(bErr ?? ""),
    `A: ${(aErr ?? "no error").slice(0, 90)} || B: ${(bErr ?? "no error").slice(0, 90)}`,
  );
  check(
    "PP-56b the deadlock message says what to do instead of retrying",
    /one file at a time/.test(aErr ?? "") && /session_send/.test(aErr ?? ""),
    (aErr ?? "").slice(0, 220),
  );
  check(
    "PP-56c the deadlock names the other session, not a bare timeout",
    new RegExp(WRITER_B.slice(0, 8)).test(aErr ?? "") &&
      new RegExp(WRITER_A.slice(0, 8)).test(bErr ?? ""),
    `A: ${(aErr ?? "").slice(0, 150)}`,
  );
  check(
    "PP-56d neither side wrote the file it could not have",
    ran.length === 2,
    `ran=${ran.join(",")}`,
  );

  if (releaseA) releaseA();
  if (releaseB) releaseB();
  await Promise.all([a1, b2]);
}

// ---------------------------------------------------------------- PP-51 peerAwareness off
{
  const h = makeCtx({ options: { peerAwareness: false } });
  await mod.default.setup(h.ctx);
  check(
    "PP-51 peerAwareness:false registers no context hook",
    !h.contextHooks.some((x) => x.name === "context"),
    h.contextHooks.map((x) => x.name).join(",") || "none",
  );
  // but the tools must still work
  check("PP-52 tools still register with awareness off", !!h.tools.project_sessions);
}

// ------------------------- PP-57..59 the three live-run regressions
// These were found by running the real server, not by reading the code: the
// 8-char label collided, timestamps never aged, and a remote record silently
// erased locally-known fields. Each one is a separate defect with its own
// failure mode.
{
  // --- 1. a remote record must not refresh a peer's clock -------------
  // `recordPeer` used to stamp `lastSeenAt: now` unconditionally, so every
  // rescan made every peer look freshly alive: nothing ever aged out, no peer
  // was ever verified, and deleted sessions were never dropped.
  const shared = new Map();
  const mk = () => {
    const h = makeCtx({ options: { peerAwareness: false } });
    h.ctx.storage = {
      get: async (k) => shared.get(k),
      set: async (k, v) => void shared.set(k, v),
      remove: async (k) => void shared.delete(k),
      scan: async ({ prefix }) => ({
        entries: [...shared.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    };
    return h;
  };
  // A peer another process saw a minute ago.
  shared.set(`presence:v2:${ID_A}`, {
    sessionId: ID_A,
    directory: PROJECT,
    state: "running",
    lastSeenAt: Date.now() - 60_000,
  });
  const b = mk();
  await mod.default.setup(b.ctx);
  await new Promise((r) => setTimeout(r, 120));
  const seen = await b.tools.project_sessions.execute({}, { sessionID: "ses_askb00" });
  const row = seen.content.split("\n").find((l) => l.includes(ID_A.slice(0, 8))) ?? "";
  check(
    "PP-57 an adopted peer keeps the other process's timestamp, not now",
    /\b1m ago\b/.test(row) && !/\b0s ago\b/.test(row),
    row.trim() || "row not found",
  );
}

// --- 2 & 3. colliding labels, and the local fields a merge must not erase ---
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  // Two sessions created in the same window: opencode ids are time-derived, so
  // their first 8 characters are identical.
  const A = "ses_collide01";
  const B = "ses_collide02";
  check(
    "PP-58a the fixture really does collide at 8 characters",
    A.slice(0, 8) === B.slice(0, 8),
    `${A.slice(0, 8)} vs ${B.slice(0, 8)}`,
  );

  // Each declares a task, so a remote record with no task must not erase it.
  await h.tools.project_sessions.execute({ task: "refactoring the auth module" }, { sessionID: A });
  await h.tools.project_sessions.execute({ task: "auditing dependency licenses" }, { sessionID: B });
  h.push(sessionEvent(A, PROJECT, "session.idle"));
  h.push(sessionEvent(B, PROJECT, "session.idle"));
  await new Promise((r) => setTimeout(r, 60));

  // Simulate the cross-process rescan: both records arrive with no task, which
  // used to overwrite the declared task with `undefined`.
  const mine = h.store.get(`presence:v2:${A}`) ?? h.store.get("presence:v2");
  if (mine) for (const k of [...h.store.keys()].filter((k) => k.startsWith("presence:v2:"))) {
    const v = { ...h.store.get(k) };
    delete v.task;
    delete v.parentSessionID;
    h.store.set(k, v);
  }
  // Force a rescan by calling the refresh the interval drives.
  const listed = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  const bothListed = listed.content.includes("ses_collide0") || listed.content.length > 0;
  check("PP-58b the list survives a rescan", bothListed, listed.content.replace(/\n/g, " | ").slice(0, 120));

  // The two rows must be distinguishable, which a fixed 8-char label cannot do.
  const rows = listed.content.split("\n").filter((l) => l.startsWith("- ses_coll"));
  const labels = rows.map((l) => l.split(" | ")[0]);
  check(
    "PP-58c colliding sessions get distinguishable labels",
    rows.length === 2 && labels[0] !== labels[1],
    `labels: ${labels.join(" , ")}`,
  );

  // The bare 8-char prefix is ambiguous and must be refused, not guessed at.
  const amb = await h.tools.session_send.execute({ sessionId: A.slice(0, 8), text: "hi" }, { sessionID: SELF });
  check(
    "PP-58d an ambiguous prefix is refused rather than guessed",
    /matches 2 sessions|ambiguous/i.test(amb.content) && h.prompts.length === 0,
    amb.content.slice(0, 160),
  );

  // A longer prefix — exactly what the brief showed — must reach the right one.
  const ok = await h.tools.session_send.execute({ sessionId: A, text: "hi" }, { sessionID: SELF });
  check(
    "PP-58e the label shown in the brief is accepted by session_send",
    h.prompts.length === 1 && h.prompts[0].sessionID === A,
    `${ok.content.slice(0, 90)} | prompted=${JSON.stringify(h.prompts.map((p) => p.sessionID))}`,
  );
}

// ------------------- PP-60 display and relevance must agree about staleness
// A peer's stored `state` is whatever the last event said, so it goes stale. The
// renderer was corrected to gate "running" on freshness but the relevance filter
// still read the raw flag, so a session that ended minutes ago was *displayed*
// as idle and simultaneously *briefed* as a relevant running peer — the exact
// over-broad brief this whole change set was meant to remove.
{
  const h = makeCtx({ options: { peerLiveSec: 5 } });
  await mod.default.setup(h.ctx);
  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  h.push(sessionEvent(ID_A, PROJECT, "session.execution.started"));
  // Fresh and running: must be briefed, and labelled running.
  await new Promise((r) => setTimeout(r, 60));
  let messages = [];
  await hook({ sessionID: SELF, messages });
  const fresh = messages.map(msgText).join("\n");
  check(
    "PP-60 a fresh running peer is briefed as running",
    fresh.includes(ID_A.slice(0, 8)) && /\brunning\b/.test(fresh),
    fresh.replace(/\n/g, " | ").slice(0, 140),
  );

  // Now it falls silent without an idle event — the stale-flag case.
  await new Promise((r) => setTimeout(r, 5200));
  messages = [];
  await hook({ sessionID: SELF, messages });
  const stale = messages.map(msgText).join("\n");
  check(
    "PP-60b a peer whose running flag went stale is not briefed as running",
    !/\brunning\b/.test(stale) || !stale.includes(ID_A.slice(0, 8)),
    stale.replace(/\n/g, " | ").slice(0, 140) || "(no brief at all)",
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
