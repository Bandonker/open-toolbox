/**
 * Batched regressions for the confirmed `opencode-sessions` defects that share a
 * fixture: OS-5, OS-6, OS-7, OS-8, OS-9, OS-13, OS-16, OS-18.
 *
 * Each block spins its own plugin instance against a fake context so the state
 * under test is not polluted by the previous block.
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(options = {}) {
  const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "verify-os-misc-"));
  const tools = {};
  const registry = new Map();
  const created = [];
  const prompts = [];
  const sets = [];
  const removes = [];
  const contextHooks = [];
  const transforms = [];
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
  /** Seed a host tool the way opencode's own `write` / `read` would appear. */
  const addBuiltin = (name, execute) => {
    registry.set(name, { name, id: name, execute, description: name });
    tools[name] = registry.get(name);
  };

  const store = new Map();
  const ctx = {
    options,
    location: { directory: PROJECT, project: { id: "p", directory: PROJECT, canonical: PROJECT } },
    event: { subscribe: ({ signal } = {}) => drain(signal) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v);
        sets.push({ key: k, at: Date.now() });
      },
      remove: async (k) => {
        store.delete(k);
        removes.push(k);
      },
      scan: async ({ prefix }) => ({
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (cb) => {
        transforms.push(cb);
        cb(editor);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb) => void contextHooks.push({ name, cb }),
      get: async ({ sessionID }) => ({ id: sessionID, title: "peer", parentID: undefined }),
      context: async ({ sessionID }) => [
        { type: "assistant", content: [{ type: "text", text: `FINAL ANSWER for ${sessionID}` }] },
      ],
      interrupt: async () => {},
      synthetic: async () => {},
      prompt: async ({ sessionID, text }) => void prompts.push({ sessionID, text }),
      create: async ({ title }) => {
        const id = `ses_child_${created.length + 1}`;
        created.push({ id, title });
        return { id, title };
      },
    },
  };
  return {
    ctx,
    tools,
    editor,
    registry,
    created,
    prompts,
    sets,
    removes,
    contextHooks,
    transforms,
    push,
    addBuiltin,
    PROJECT,
  };
}

const spawnOne = async (h, parentID = "ses_parent_a") => {
  await h.tools.spawn_many.execute({ sessions: [{ prompt: "do the thing" }] }, { sessionID: parentID });
  return h.created[h.created.length - 1].id;
};

const ev = (h, sessionID, type = "session.step.started") => ({
  type,
  location: { directory: h.PROJECT },
  data: { sessionID },
});

// ------------------------------------------- OS-5: session_share summary text
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const child = await spawnOne(h);
  h.push(ev(h, child, "session.idle"));
  await wait(120);

  const share = await h.tools.session_share.execute({ sessionId: child }, { sessionID: "ses_parent_a" });
  // The old expression evaluated `(resultText ?? structured) ? JSON.stringify(structured)…`,
  // so a text-only child produced `JSON.stringify(undefined).slice(...)` — a
  // TypeError out of the tool — and the result text never appeared.
  check(
    "OS-5: session_share carries the child's result text",
    share.content.includes(`FINAL ANSWER for ${child}`),
    share.content.replace(/\n/g, " | ").slice(0, 140),
  );

  // --------------------------------- OS-6: a snapshot is not a fake session
  const snap = await h.tools.session_snapshot.execute({ sessionId: child }, { sessionID: "ses_parent_a" });
  const snapshotId = (snap.content.match(/Snapshot saved: (\S+)/) ?? [])[1] ?? "";
  check("OS-6: session_snapshot returns a snapshot id", snapshotId.startsWith(`snapshot:${child}:`), snapshotId || snap.content.slice(0, 60));

  const listed = await h.tools.list_sessions.execute({ all: true }, { sessionID: "ses_parent_a" });
  check(
    "OS-6: the snapshot never appears as a tracked session",
    !listed.content.includes("snapshot:"),
    listed.content.replace(/\n/g, " | ").slice(0, 140),
  );

  const asSession = await h.tools.session_result.execute({ sessionId: snapshotId }, { sessionID: "ses_parent_a" });
  check(
    "OS-6: the snapshot id is not usable as a session id",
    /Unknown session/.test(asSession.content),
    asSession.content.replace(/\n/g, " | ").slice(0, 100),
  );

  const before = h.created.length;
  const restored = await h.tools.session_restore.execute({ snapshotId }, { sessionID: "ses_parent_a" });
  check(
    "OS-6: a real snapshot still restores",
    h.created.length === before + 1 && /Restored from snapshot/.test(restored.content),
    restored.content.replace(/\n/g, " | ").slice(0, 100),
  );

  const missing = await h.tools.session_restore.execute({ snapshotId: "snapshot:ses_gone:1" }, { sessionID: "ses_parent_a" });
  check(
    "OS-6: a missing snapshot says where snapshots live and lists what is there",
    /in this server's memory/i.test(missing.content) && missing.content.includes(snapshotId),
    missing.content.replace(/\n/g, " | ").slice(0, 160),
  );
}

// ------------------------------------- OS-9: export_session cannot write anywhere
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const child = await spawnOne(h);
  h.push(ev(h, child, "session.idle"));
  await wait(120);

  const ok = await h.tools.export_session.execute({ sessionId: child }, { sessionID: "ses_parent_a" });
  const defaultFile = path.join(h.PROJECT, `${child}.json`);
  check(
    "OS-9: the default export lands inside the project",
    /Exported session/.test(ok.content) && fs.existsSync(defaultFile),
    ok.content.slice(0, 120),
  );

  const escape = await h.tools.export_session.execute(
    { sessionId: child, outputPath: "../escape.json" },
    { sessionID: "ses_parent_a" },
  );
  check(
    "OS-9: a relative path that leaves the project is refused",
    /Refused to export/.test(escape.content) && !fs.existsSync(path.join(path.dirname(h.PROJECT), "escape.json")),
    escape.content.slice(0, 120),
  );

  const outside = path.join(os.tmpdir(), `os-fix-outside-${Date.now()}.json`);
  const abs = await h.tools.export_session.execute(
    { sessionId: child, outputPath: outside },
    { sessionID: "ses_parent_a" },
  );
  check(
    "OS-9: an absolute path outside the project is refused",
    /Refused to export/.test(abs.content) && !fs.existsSync(outside),
    abs.content.slice(0, 120),
  );

  // HOME is the classic target of a prompt-injected export.
  const home = await h.tools.export_session.execute(
    { sessionId: child, outputPath: `${os.homedir()}/.opencode-sessions-probe.json` },
    { sessionID: "ses_parent_a" },
  );
  check(
    "OS-9: it will not overwrite anything in the user's home",
    /Refused to export/.test(home.content) && !fs.existsSync(path.join(os.homedir(), ".opencode-sessions-probe.json")),
    home.content.slice(0, 90),
  );

  const original = fs.readFileSync(defaultFile, "utf8");
  const again = await h.tools.export_session.execute(
    { sessionId: child, outputPath: `${child}.json` },
    { sessionID: "ses_parent_a" },
  );
  check(
    "OS-9: an existing file is never clobbered",
    /Exported session/.test(again.content) && fs.readFileSync(defaultFile, "utf8") === original,
    again.content.slice(0, 120),
  );
  check(
    "OS-9: the clash gets a numbered name instead",
    fs.existsSync(path.join(h.PROJECT, `${child}-1.json`)),
    fs.readdirSync(h.PROJECT).join(","),
  );

  const victim = path.join(h.PROJECT, "victim.json");
  fs.writeFileSync(victim, "keep me");
  const link = path.join(h.PROJECT, "link.json");
  try {
    fs.symlinkSync(victim, link);
    const symlink = await h.tools.export_session.execute(
      { sessionId: child, outputPath: "link.json" },
      { sessionID: "ses_parent_a" },
    );
    check(
      "OS-9: a symlink inside the project is not written through",
      /Refused to export/.test(symlink.content) && fs.readFileSync(victim, "utf8") === "keep me",
      symlink.content.slice(0, 110),
    );
  } catch (err) {
    check("OS-9: symlink probe could run", false, String(err));
  }
}

// ------------------------------------------------ OS-16: peers have two states
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(ev(h, "ses_peer_idle1", "session.idle"));
  h.push(ev(h, "ses_peer_run1", "session.execution.started"));
  await wait(120);

  const bogus = await h.tools.project_sessions.execute({ state: "starting" }, { sessionID: "ses_self_state" });
  check(
    "OS-16: a state a peer can never hold is refused, not silently empty",
    /only ever "running" or "idle"/.test(bogus.content) && /list_sessions/.test(bogus.content),
    bogus.content.replace(/\n/g, " | ").slice(0, 160),
  );

  // Rows are rendered with the 10-character display id, so assertions have to
  // match what a user actually sees.
  const shown = (id) => id.slice(0, 10);
  const idleOnly = await h.tools.project_sessions.execute({ state: "idle" }, { sessionID: "ses_self_state" });
  check(
    "OS-16: the idle filter lists the idle peer and not the running one",
    idleOnly.content.includes(shown("ses_peer_idle1")) && !idleOnly.content.includes(shown("ses_peer_run1")),
    idleOnly.content.replace(/\n/g, " | ").slice(0, 160),
  );

  const running = await h.tools.project_sessions.execute({ state: "RUNNING" }, { sessionID: "ses_self_state" });
  check(
    "OS-16: the filter is case-insensitive",
    running.content.includes(shown("ses_peer_run1")) && !running.content.includes(shown("ses_peer_idle1")),
    running.content.replace(/\n/g, " | ").slice(0, 160),
  );
}

// --------------------------- OS-8: a rate-limited delivery is not a delivery
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(ev(h, "ses_peer_b1", "session.step.started"));
  h.push(ev(h, "ses_peer_b2", "session.step.started"));
  await wait(120);

  const first = await h.tools.session_broadcast.execute({ text: "heads up" }, { sessionID: "ses_self_cast" });
  check("OS-8: the first broadcast reaches both peers", /Broadcast to 2\/2/.test(first.content), first.content.replace(/\n/g, " | ").slice(0, 120));

  const second = await h.tools.session_broadcast.execute({ text: "heads up again" }, { sessionID: "ses_self_cast" });
  check(
    "OS-8: a suppressed repeat reports 0 delivered, not 2/2",
    /Broadcast to 0\/2/.test(second.content) && /Not sent to/.test(second.content),
    second.content.replace(/\n/g, " | ").slice(0, 160),
  );

  const send = await h.tools.session_send.execute(
    { sessionId: "ses_peer_b1", text: "hi there" },
    { sessionID: "ses_self_cast" },
  );
  check(
    "OS-8: session_send says so when the limiter suppressed it",
    /Not sent|Not sent:/.test(send.content) && !/peer session/.test(send.content),
    send.content.replace(/\n/g, " | ").slice(0, 160),
  );
}

// ------------------------- OS-18: a replayed transform does not stack the gate
{
  // The gate is only installed when locking is set to enforce, exactly as the
  // presence suite configures it.
  const h = makeCtx({ fileLocks: "enforce", lockWaitSec: 2 });
  const wrote = [];
  const original = async (input) => {
    wrote.push(input);
    return "written";
  };
  h.addBuiltin("write", original);
  h.addBuiltin("read", async () => "read");
  await mod.default.setup(h.ctx);

  const gated1 = h.registry.get("write").execute;
  check("OS-18: the write gate wraps a host tool", gated1 !== original && typeof gated1 === "function");
  check("OS-18: a read-only tool is left alone", h.registry.get("read").execute !== undefined);

  // Simulate the host replaying transforms over a persistent registry (reload,
  // or any later pass). Each pass used to wrap the previous wrapper.
  for (let i = 0; i < 3; i++) h.transforms[0](h.editor);
  const gated2 = h.registry.get("write").execute;
  check(
    "OS-18: a second pass recognises its own wrapper and leaves it in place",
    gated2 === gated1,
    gated2 === gated1 ? "stable" : "RE-WRAPPED",
  );

  const before = wrote.length;
  await gated2({ filePath: "src/gated.ts", content: "x" }, { sessionID: "ses_self_gate" });
  check("OS-18: the wrapped tool still runs its inner implementation once", wrote.length === before + 1, `runs=${wrote.length - before}`);
}

// --------------------------------- OS-7: caches are keyed by the asking session
{
  const h = makeCtx({ peerAwareness: true });
  await mod.default.setup(h.ctx);

  // Two workers with unrelated tasks, and one idle peer whose task overlaps
  // only the first of them. An idle peer is only ever briefed on task overlap,
  // so the two notices must differ — which the single-slot notice cache made
  // impossible: whoever computed first answered for everyone.
  await h.tools.project_sessions.execute({ task: "refactoring the auth module" }, { sessionID: "ses_self_aaa" });
  await h.tools.project_sessions.execute({ task: "updating the install docs" }, { sessionID: "ses_self_bbb" });
  await h.tools.project_sessions.execute({ task: "auth module notes" }, { sessionID: "ses_p_one" });
  await h.tools.project_sessions.execute({ task: "install docs refresh" }, { sessionID: "ses_p_two" });
  h.push(ev(h, "ses_p_one", "session.idle"));
  h.push(ev(h, "ses_p_two", "session.idle"));
  await wait(120);

  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  check("OS-7: the awareness hook is registered", typeof hook === "function");
  const msgText = (m) =>
    Array.isArray(m?.content) ? m.content.map((c) => c.text).join("") : String(m?.content ?? "");

  const mA = [{ role: "user", content: [{ type: "text", text: "work" }] }];
  await hook({ sessionID: "ses_self_aaa", messages: mA });
  const textA = mA.map(msgText).join("\n");
  check(
    "OS-7: the first session is briefed on the peer that overlaps *its* task",
    textA.includes("ses_p_one") && !textA.includes("ses_p_two"),
    textA.replace(/\n/g, " | ").slice(0, 200),
  );

  const mB = [{ role: "user", content: [{ type: "text", text: "work" }] }];
  await hook({ sessionID: "ses_self_bbb", messages: mB });
  const textB = mB.map(msgText).join("\n");
  check(
    "OS-7: the second session gets its own brief, not the cached one",
    textB.includes("ses_p_two") && !textB.includes("ses_p_one"),
    textB.replace(/\n/g, " | ").slice(0, 200),
  );
}

// ----------------------- OS-13: cleanup flushes presence without re-arming
{
  const h = makeCtx();
  const cleanup = await mod.default.setup(h.ctx);
  // A peer event arms the 2s mirror debounce.
  h.push(ev(h, "ses_peer_flush", "session.step.started"));
  await wait(80);
  const beforeCleanup = h.sets.length;
  const t0 = Date.now();
  cleanup();
  const flushedAt = Date.now() - t0;
  await wait(300);
  const peerSets = h.sets.filter((s) => s.key.startsWith("presence:v2:"));
  check(
    "OS-13: the pending peer write lands immediately on shutdown",
    peerSets.length > 0 && flushedAt < 500 && h.sets.length > beforeCleanup,
    `sets=${peerSets.length} flush=${flushedAt}ms`,
  );
  const count = h.sets.length;
  await wait(2500);
  check(
    "OS-13: cleanup does not re-arm the mirror timer it just cleared",
    h.sets.length === count,
    `extra writes=${h.sets.length - count}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
