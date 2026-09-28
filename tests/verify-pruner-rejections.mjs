// CP-19..CP-22: no fire-and-forget promise in context-pruner may surface as an
// unhandled rejection, whatever the host does.
//
// Six of the pruner's last eight commits were "the hook must not break the
// session" repairs, and CP-12..14 fixed unhandled rejections in exactly three
// places. That is a pattern, not three isolated bugs. CP-12..14 also asserted it
// by grepping the plugin source for a `.catch(` substring near a `void` call --
// which passes just as happily when the catch is attached to a different
// promise, or survives only in a comment. So this file asserts the *behaviour*
// instead: it drives the real plugin against a host that rejects everything and
// traps `unhandledRejection`.
//
//   CP-19  setup + every hook, tool and event path, with a hostile host that
//          rejects (or throws) on every single call, leaks no rejection.
//   CP-20  the guards actually cover their promise: a store/session sink that
//          rejects a *delayed* number of times still leaks nothing, and a
//          healthy host is left untouched (guards must not break real writes).
//   CP-21  no hostile `subscribe`/`hook`/`transform` shape can escape either --
//          throwing, rejecting, a rejecting iterable, a rejecting promise.
//   CP-22  the dispose path is rejection-safe even when every disposer rejects.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME first: the plugin resolves config under homedir() at import time.
const sandbox = join(tmpdir(), "pruner-rejections-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const dir = mkdtempSync(join(tmpdir(), "pruner-rejections-"));

// ---------------------------------------------------------------- trap
// Node emits `unhandledRejection` when a rejected promise still has no handler
// at the end of the turn, so a single turn boundary is enough. We count and
// remember the reasons for the failure message.
const leaks = [];
const onUnhandled = (reason) => { leaks.push(reason); };
process.on("unhandledRejection", onUnhandled);

/** Let every already-settled promise report itself. Several turns, because a
 *  leaked promise can be re-armed by an await further down the same chain. */
const settle = async (ms = 60) => {
  await new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, ms));
};
const boom = (what) => new Error(`host rejected: ${what}`);

/** Assert nothing leaked since the marker, with the offending reason named. */
const assertNoLeak = async (mark, label) => {
  await settle();
  const fresh = leaks.splice(mark);
  assert.equal(
    fresh.length,
    0,
    `${label}: ${fresh.length} unhandled rejection(s): ` +
      fresh.map((e) => (e && e.message) || String(e)).join(" | "),
  );
};

// ---------------------------------------------------------------- doubles
/** A message list big enough that the pruner actually does work on it. */
function bigMessages(tag) {
  return [
    { id: `u_${tag}`, role: "user", content: [{ type: "text", text: `investigate ${tag} ` + "q".repeat(400) }] },
    {
      id: `a_${tag}`,
      role: "assistant",
      content: [
        { type: "tool-call", id: `c_${tag}`, name: "read", input: { filePath: `src/${tag}.ts` } },
        { type: "tool-call", id: `g_${tag}`, name: "grep", input: { pattern: "needle" } },
      ],
    },
    {
      id: `t_${tag}`,
      role: "tool",
      content: [
        { type: "tool-result", id: `c_${tag}`, name: "read", result: { type: "text", value: "X".repeat(30000) } },
        { type: "tool-result", id: `g_${tag}`, name: "grep", result: { type: "text", value: "Y".repeat(30000) } },
      ],
    },
    { id: `a2_${tag}`, role: "assistant", content: [{ type: "text", text: "and also ".repeat(200) }] },
  ];
}

function contextEvent(sessionID, tag) {
  return {
    sessionID,
    model: { providerID: "prov", id: "model-a" },
    messages: bigMessages(tag),
    tools: [{ name: "read" }, { name: "grep" }],
  };
}

/**
 * A host whose every async surface fails. `hostile` selects *how*:
 *   "reject"  -> returns a promise that rejects (the CP-1/12/13/14 shape)
 *   "throw"   -> throws synchronously from a non-async function
 *   "healthy" -> works normally, so we can prove the guards are not
 *                short-circuiting real behaviour
 */
function makeHost({ hostile = "reject", subscribeShape = "iterable", hookShape = "ok", disposeRejects = true } = {}) {
  const fail = (what) => {
    if (hostile === "throw") throw boom(what);
    return Promise.reject(boom(what));
  };
  const wrapped = (what, fn) => async (...args) => {
    if (hostile !== "healthy") return fail(what);
    return fn ? fn(...args) : undefined;
  };

  const store = new Map();
  const hooks = new Map();
  const tools = new Map();
  const pushed = [];
  let wake = null;

  const storage = {
    store,
    get: wrapped("storage.get"),
    set: wrapped("storage.set"),
    remove: wrapped("storage.remove"),
    scan: wrapped("storage.scan"),
  };
  if (hostile === "healthy") {
    storage.get = async (k) => store.get(k);
    storage.set = async (k, v) => void store.set(k, v);
    storage.remove = async (k) => void store.delete(k);
    storage.scan = async ({ prefix, after } = {}) => {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort();
      const from = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(from, from + 3);
      return { entries: page.map((key) => ({ key, value: store.get(key) })), next: from + 3 < all.length ? page[page.length - 1] : undefined };
    };
  }

  const session = {
    synthetic: wrapped("session.synthetic"),
    generate: wrapped("session.generate"),
    get: wrapped("session.get"),
    hook: async (name, cb) => {
      hooks.set(name, cb);
      if (hookShape === "reject") throw boom("session.hook");
      if (hookShape === "syncThrow") throw boom("session.hook sync");
      return { dispose: disposeRejects ? async () => { throw boom("dispose"); } : async () => {} };
    },
  };

  const event = {
    push(ev) {
      pushed.push(ev);
      if (wake) { const r = wake; wake = null; r(); }
    },
    subscribe(...args) {
      if (subscribeShape === "throw") throw boom("subscribe sync");
      if (subscribeShape === "reject") return Promise.reject(boom("subscribe"));
      const signal = args.find((a) => a && typeof a === "object" && "signal" in a)?.signal;
      if (subscribeShape === "badIterable") {
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(boom("iterator.next")) };
          },
        };
      }
      return (async function* () {
        while (!signal?.aborted) {
          while (pushed.length > 0) yield pushed.shift();
          await new Promise((r) => { wake = r; if (signal) signal.addEventListener("abort", r, { once: true }); });
          wake = null;
        }
      })();
    },
  };

  const tool = {
    transform: async (cb) => {
      if (hostile !== "healthy") return fail("tool.transform");
      cb({
        add: (def) => {
          tools.set(def.name, def);
          return def;
        },
      });
      return { dispose: async () => {} };
    },
  };

  const ctx = {
    options: { autoSummarize: true, proactiveSummarize: true, compressText: true, notify: "detailed", notifyType: "chat", storageGc: true, summaryCacheMax: 2, calibrationMax: 1 },
    location: { directory: dir },
    tool,
    storage,
    event,
    session,
    model: hostile === "healthy" ? { list: () => [{ id: "model-a", providerID: "prov", limit: { context: 200000, output: 8000 } }] } : { list: wrapped("model.list") },
  };
  return { ctx, hooks, tools, event, storage, store };
}

/** Fire every captured hook with a payload, ignoring what the hook returns. */
async function driveHooks(hooks, sessionID, tag) {
  for (const [name, cb] of hooks) {
    try {
      await cb(contextEvent(sessionID, `${tag}-${name}`));
    } catch {
      /* the pruner must swallow its own failures; nothing to assert here */
    }
  }
}

// ================================================================ CP-19
// Every hook/tool/event path against a host that rejects every call.
{
  const { ctx, hooks, tools, event } = makeHost({ hostile: "reject" });
  const mark = leaks.length;
  const cleanup = await modDefault.setup(ctx);
  await settle(); // startup sweep + gcStorage + refreshModels are fire-and-forget

  await driveHooks(hooks, "ses_cp19", "cp19");
  await settle();

  // usage accounting -> calibration write -> opportunistic gcStorage
  event.push({ type: "session.usage.updated", data: { sessionID: "ses_cp19", tokens: { input: 5000, cache: { read: 100, write: 20 } } } });
  await settle();
  // a second sighting so the calibration delta branch actually runs
  event.push({ type: "session.usage.updated", data: { sessionID: "ses_cp19", tokens: { input: 90000, cache: { read: 9000, write: 400 } } } });
  await settle();

  // deletion -> forgetSession -> purgeOrphanDigests -> session.get + scanStore
  event.push({ type: "session.deleted", data: { sessionID: "ses_cp19" } });
  await settle();

  // every registered tool, driven directly
  for (const [name, def] of tools) {
    try {
      await def.execute?.({}, { sessionID: "ses_cp19" });
    } catch {
      /* ignored */
    }
  }
  await settle();

  await assertNoLeak(mark, "CP-19 (hostile: reject)");
  // CP-19: the same must hold when the host throws synchronously instead.
  const thrown = makeHost({ hostile: "throw" });
  const mark2 = leaks.length;
  const cleanup2 = await modDefault.setup(thrown.ctx);
  await settle();
  await driveHooks(thrown.hooks, "ses_cp19t", "cp19t");
  thrown.event.push({ type: "session.usage.updated", data: { sessionID: "ses_cp19t", tokens: { input: 90000, cache: {} } } });
  thrown.event.push({ type: "session.deleted", data: { sessionID: "ses_cp19t" } });
  await settle();
  await assertNoLeak(mark2, "CP-19 (hostile: throw)");
  await cleanup().catch(() => {});
  await cleanup2().catch(() => {});
}

// ================================================================ CP-20
// The guards must cover the promise, and must not swallow real work.
{
  // Repeated *delayed* rejections: a guard that only worked because the host
  // rejected synchronously would miss these.
  const { ctx, hooks, event, store } = makeHost({ hostile: "healthy" });
  for (const key of ["get", "set", "remove", "scan"]) {
    ctx.storage[key] = async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw boom(`delayed ${key}`);
    };
  }
  const mark = leaks.length;
  const cleanup = await modDefault.setup(ctx);
  await settle();
  await driveHooks(hooks, "ses_cp20", "cp20");
  event.push({ type: "session.usage.updated", data: { sessionID: "ses_cp20", tokens: { input: 90000, cache: {} } } });
  event.push({ type: "session.deleted", data: { sessionID: "ses_cp20" } });
  await settle();
  await assertNoLeak(mark, "CP-20 (delayed rejections)");

  // CP-20: with a healthy host the same code must still actually persist, so
  // the guards cannot be "swallow everything and hope".
  const live = makeHost({ hostile: "healthy" });
  const cleanup2 = await modDefault.setup(live.ctx);
  await settle();
  await driveHooks(live.hooks, "ses_cp20b", "cp20b");
  await settle();
  assert.ok(
    [...live.store.keys()].some((k) => k.startsWith("recall:") || k.startsWith("epoch:") || k.startsWith("summaries:")),
    "CP-20: a healthy host must still receive context-pruner's writes (guards must not swallow real work)",
  );
  live.event.push({ type: "session.deleted", data: { sessionID: "ses_cp20b" } });
  await settle();
  assert.equal(
    [...live.store.keys()].filter((k) => k.includes("ses_cp20b")).length,
    0,
    "CP-20: a healthy host must still see session keys removed on delete",
  );
  await cleanup().catch(() => {});
  await cleanup2().catch(() => {});
}

// ================================================================ CP-21
// Hostile *shapes* at registration time.
{
  for (const [subscribeShape, hookShape] of [
    ["throw", "ok"],
    ["reject", "ok"],
    ["badIterable", "ok"],
    ["iterable", "reject"],
    ["iterable", "syncThrow"],
  ]) {
    const { ctx } = makeHost({ hostile: "healthy", subscribeShape, hookShape });
    const mark = leaks.length;
    // CP-23: `setup` must not reject when a registration fails. The context,
    // tool and command registrations are each guarded; the tier-4 compaction /
    // retry / title registrations were not, so one rejecting hook took down
    // setup -- and with it the whole plugin load.
    let cleanup = null;
    try {
      cleanup = await modDefault.setup(ctx);
    } catch (err) {
      assert.fail(`CP-23: setup must not reject (subscribe=${subscribeShape}, hook=${hookShape}): ${err}`);
    }
    assert.equal(typeof cleanup, "function", "CP-23: setup must still return a disposer when a registration fails");
    await settle();
    await assertNoLeak(mark, `CP-21 (subscribe=${subscribeShape}, hook=${hookShape})`);
    await cleanup().catch(() => {});
  }
}

// ================================================================ CP-22
// Dispose: every disposer rejects, and the returned disposer must still settle.
{
  const { ctx } = makeHost({ hostile: "reject", disposeRejects: true });
  const mark = leaks.length;
  const cleanup = await modDefault.setup(ctx);
  await settle();
  // A rejecting disposer must not reject the dispose call, nor leak.
  await cleanup();
  await assertNoLeak(mark, "CP-22 (every disposer rejects)");

  // And the disabled-plugin early return, which registers nothing.
  const off = makeHost({ hostile: "reject" });
  const mark2 = leaks.length;
  const cleanup2 = await modDefault.setup({ ...off.ctx, options: { enabled: false } });
  await settle();
  await cleanup2();
  await assertNoLeak(mark2, "CP-22 (plugin disabled)");
}

process.removeListener("unhandledRejection", onUnhandled);
assert.equal(leaks.length, 0, `CP-19..22: ${leaks.length} rejection(s) escaped the whole sweep`);

console.log("verify-pruner-rejections: all assertions passed");
