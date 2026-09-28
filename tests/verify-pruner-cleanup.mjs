// CP-16/CP-17: deleting a session must not leave context-pruner's per-session
// keys behind, and the non-session caches must stay bounded.
//   CP-16  `session.deleted` forgets the session; a startup sweep reclaims keys
//          for sessions deleted while closed (no event replay exists).
//   CP-17  `summary:<hash>` and `calibration:<model>` are capped by count,
//          oldest first, at startup and opportunistically after writes.
// Run: node tests/verify-pruner-cleanup.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME first: the plugin resolves config under homedir() at import time.
const sandbox = join(tmpdir(), "pruner-cleanup-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const modNs = await import("../plugins/context-pruner.ts");
const t = modNs.__test__ ?? modDefault?.__test__;
const dir = mkdtempSync(join(tmpdir(), "pruner-cleanup-"));

const LIVE = "ses_cleanup_live";
const DEAD = "ses_cleanup_dead";
const keysFor = (sid) => [`epoch:${sid}`, `recall:${sid}`, `summaries:${sid}`];

// Storage double with the full StorageDomain surface: get/set/remove/scan.
// Seeds are either a bare key (value {seeded:true}) or a [key, value] pair.
function makeStorage(seedEntries) {
  const store = new Map(seedEntries.map((e) => (Array.isArray(e) ? e : [e, { seeded: true }])));
  return {
    store,
    get: async (k) => store.get(k),
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
    scan: async ({ prefix, after } = {}) => {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort();
      const from = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(from, from + 2); // exercise pagination
      const next = from + 2 < all.length ? page[page.length - 1] : undefined;
      return { entries: page.map((key) => ({ key, value: store.get(key) })), next };
    },
  };
}

// Event pump: yields whatever is pushed, waits otherwise.
function makeEventStream() {
  const pending = [];
  let wake = null;
  return {
    push(ev) {
      pending.push(ev);
      if (wake) {
        const r = wake;
        wake = null;
        r();
      }
    },
    subscribe({ signal } = {}) {
      return (async function* () {
        while (!signal?.aborted) {
          while (pending.length > 0) yield pending.shift();
          await new Promise((r) => {
            wake = r;
            if (signal) signal.addEventListener("abort", r, { once: true });
          });
          wake = null;
        }
      })();
    },
  };
}

function makeCtx({ storage, events, options = {} }) {
  return {
    options,
    location: { directory: dir },
    tool: {
      transform: async (cb) => {
        cb({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    storage,
    event: { subscribe: (arg) => events.subscribe(arg) },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      synthetic: async () => ({}),
      // Liveness probe: LIVE resolves, everything else is gone.
      get: async ({ sessionID }) => {
        if (sessionID === LIVE) return { id: sessionID, title: "live" };
        throw new Error(`session not found: ${sessionID}`);
      },
    },
    model: { list: () => [] },
  };
}

// ---------------------------------------------------------------- CP-16
{
  const events = makeEventStream();
  const storage = makeStorage([
    ...keysFor(LIVE),
    ...keysFor(DEAD),
    "calibration:provider/model", // not session-scoped: must always survive
    ["summary:live-digest", { text: "live digest", topic: "auto", version: 1, at: 1, sessions: [LIVE] }],
    ["summary:dead-digest", { text: "dead digest", topic: "auto", version: 1, at: 2, sessions: [DEAD] }],
    ["summary:shared-digest", { text: "shared", topic: "auto", version: 1, at: 3, sessions: [LIVE, DEAD] }],
    ["summary:legacy-digest", { text: "legacy", topic: "auto", version: 1, at: 4 }], // untagged
  ]);
  const cleanup = await modDefault.setup(makeCtx({ storage, events }));
  await new Promise((r) => setTimeout(r, 120)); // startup sweep is fire-and-forget

  for (const key of keysFor(DEAD)) {
    assert.equal(storage.store.has(key), false, `startup sweep must reclaim ${key}`);
  }
  for (const key of keysFor(LIVE)) {
    assert.equal(storage.store.has(key), true, `startup sweep must keep live ${key}`);
  }
  assert.equal(storage.store.has("calibration:provider/model"), true, "sweep must not touch non-session keys");

  // CP-18: digests are reclaimed by ownership, not only by the count cap.
  assert.equal(storage.store.has("summary:dead-digest"), false, "sweep must reclaim a digest owned only by a dead session");
  assert.equal(storage.store.has("summary:live-digest"), true, "sweep must keep a digest owned by a live session");
  assert.equal(storage.store.has("summary:shared-digest"), true, "digest shared with a live session must survive");
  assert.equal(storage.store.has("summary:legacy-digest"), true, "untagged legacy digest is left to the count cap");

  // A live `session.deleted` event forgets the session immediately.
  events.push({ type: "session.deleted", data: { sessionID: LIVE } });
  await new Promise((r) => setTimeout(r, 60));
  for (const key of keysFor(LIVE)) {
    assert.equal(storage.store.has(key), false, `session.deleted must reclaim ${key}`);
  }
  assert.equal(storage.store.has("summary:live-digest"), false, "deleting the owner must reclaim its digest");
  assert.equal(storage.store.has("summary:shared-digest"), false, "digest with no live owner left must be reclaimed");
  assert.equal(storage.store.has("summary:legacy-digest"), true, "untagged digest is never reclaimed by session deletion");
  await cleanup();
}

// ---------------------------------------------------------------- CP-17 caps
{
  const events = makeEventStream();
  const storage = makeStorage([
    ["summary:a", { text: "digest a", topic: "auto", version: 1, at: 1 }],
    ["summary:b", { text: "digest b", topic: "auto", version: 1, at: 2 }],
    ["summary:c", { text: "digest c", topic: "auto", version: 1, at: 3 }],
    ["calibration:p/m1", { r: 1.1, updatedAt: 1 }],
    ["calibration:p/m2", { r: 1.2, updatedAt: 2 }],
  ]);
  const cleanup = await modDefault.setup(
    makeCtx({ storage, events, options: { storageGc: true, summaryCacheMax: 2, calibrationMax: 1 } }),
  );
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(storage.store.has("summary:a"), false, "oldest summary beyond the cap must be dropped");
  assert.equal(storage.store.has("summary:b"), true, "summary within the cap must survive");
  assert.equal(storage.store.has("summary:c"), true, "newest summary must survive");
  assert.equal(storage.store.has("calibration:p/m1"), false, "oldest calibration beyond the cap must be dropped");
  assert.equal(storage.store.has("calibration:p/m2"), true, "newest calibration must survive");
  await cleanup();
}

// ---------------------------------------------------------------- CP-17 disabled
{
  const events = makeEventStream();
  const storage = makeStorage([
    ["summary:a", { at: 1 }],
    ["summary:b", { at: 2 }],
    ["summary:c", { at: 3 }],
  ]);
  const cleanup = await modDefault.setup(
    makeCtx({ storage, events, options: { storageGc: false, summaryCacheMax: 1 } }),
  );
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(storage.store.size, 3, "storageGc:false must leave the cache untouched");
  await cleanup();
}

// ---------------------------------------------------------------- defaults + guardedRemove
const defaults = t.resolveConfig(dir, {});
assert.equal(defaults.storageGc, true, "storageGc defaults on");
assert.equal(defaults.summaryCacheMax, 500, "summaryCacheMax default");
assert.equal(defaults.calibrationMax, 256, "calibrationMax default");
assert.equal(t.resolveConfig(dir, { summaryCacheMax: 0 }).summaryCacheMax, 0, "0 = unlimited must be preserved");

// CP-18: owner extraction ignores non-session ids and de-duplicates.
assert.deepEqual(t.digestOwners({ sessions: ["ses_a", "ses_a", "unknown", ""] }), ["ses_a"], "only real session ids count");
assert.deepEqual(t.digestOwners({ sessions: "ses_a" }), [], "a non-array sessions field is not attributable");
assert.deepEqual(t.digestOwners({}), [], "an untagged entry has no owners");

let unhandled = 0;
const onUnhandled = () => {
  unhandled += 1;
};
process.on("unhandledRejection", onUnhandled);
t.guardedRemove(undefined, "k");
t.guardedRemove({ remove: async () => { throw new Error("async boom"); } }, "k");
t.guardedRemove({ remove: () => { throw new Error("sync boom"); } }, "k");
await new Promise((r) => setTimeout(r, 60));
process.removeListener("unhandledRejection", onUnhandled);
assert.equal(unhandled, 0, "guardedRemove must never surface an unhandled rejection");

console.log("verify-pruner-cleanup: all assertions passed");
