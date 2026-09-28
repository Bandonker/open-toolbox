// CP-25..CP-28: validate the storage GC caps over a long run, not just in units.
//
// The caps shipped as guesses (summaryCacheMax=500, calibrationMax=256) covered
// only by unit assertions. This drives the real plugin with a real store through
// more writes than the cap allows and checks the four things the units cannot:
//
//   CP-25  the caps actually hold at their DEFAULTS over a long run, both at
//          startup and on the every-100-writes sweep (the units only ever
//          checked one startup pass with a hand-seeded store).
//   CP-26  the startup sweep does not reclaim a LIVE session's digests, even
//          when the store is over the cap and the live digests are the oldest.
//   CP-27  deleting a session mid-run drops exactly that session's keys and
//          nothing else, while every other session's state survives.
//   CP-28  the GC's own cost at the cap stays inside a budget, so raising
//          summaryCacheMax later cannot quietly make every 100th write pay a
//          full multi-page scan of the whole digest namespace.
//
// Run: node tests/verify-pruner-gc.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Sandbox HOME first: the plugin resolves config under homedir() at import time.
const sandbox = join(tmpdir(), "pruner-gc-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const modDefault = (await import("../plugins/context-pruner.ts")).default;
const modNs = await import("../plugins/context-pruner.ts");
const t = modNs.__test__ ?? modDefault?.__test__;
const dir = mkdtempSync(join(tmpdir(), "pruner-gc-"));

const DEFAULTS = t.resolveConfig(dir, {});
const SUMMARY_MAX = DEFAULTS.summaryCacheMax;
const CALIB_MAX = DEFAULTS.calibrationMax;
assert.equal(SUMMARY_MAX, 500, "summaryCacheMax default is under test");
assert.equal(CALIB_MAX, 256, "calibrationMax default is under test");

function makeStorage(seed = []) {
  const store = new Map(seed.map((e) => (Array.isArray(e) ? e : [e, { seeded: true }])));
  let scans = 0;
  return {
    store,
    scans: () => scans,
    get: async (k) => store.get(k),
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
    scan: async ({ prefix, after } = {}) => {
      scans++;
      const all = [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort();
      const from = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(from, from + 25); // small pages: exercise pagination
      return { entries: page.map((key) => ({ key, value: store.get(key) })), next: from + 25 < all.length ? page[page.length - 1] : undefined };
    },
  };
}

function makeEventStream() {
  const pending = [];
  let wake = null;
  return {
    push(ev) {
      pending.push(ev);
      if (wake) { const r = wake; wake = null; r(); }
    },
    subscribe({ signal } = {}) {
      return (async function* () {
        while (!signal?.aborted) {
          while (pending.length > 0) yield pending.shift();
          await new Promise((r) => { wake = r; if (signal) signal.addEventListener("abort", r, { once: true }); });
          wake = null;
        }
      })();
    },
  };
}

function makeCtx({ storage, events, options = {}, generate, models }) {
  return {
    options,
    location: { directory: dir },
    tool: {
      transform: async (cb) => {
        cb({ add: (def) => { ctxTools.set(def.name, def); return def; } });
        return { dispose: async () => {} };
      },
    },
    storage,
    event: { subscribe: (arg) => events.subscribe(arg) },
    session: {
      hook: async (name, cb) => { hooks.set(name, cb); return { dispose: async () => {} }; },
      synthetic: async () => ({}),
      generate: generate ?? (async () => ({ text: "a summary of the output" })),
      get: async ({ sessionID }) => ({ id: sessionID }),
    },
    model: {
      // `modelKey` prefers the RESOLVED catalog entry over the request ref, so
      // a one-model catalog collapses every ref onto a single calibration key.
      list: () => models ?? [{ id: "model-a", providerID: "prov", limit: { context: 200000, output: 8000 } }],
    },
  };
}
const ctxTools = new Map();
const hooks = new Map();
// The tool result must sit in an EARLIER turn than the newest user message:
// everything at or after the newest user message is the live turn and is never
// compressible, so a trailing user message is what makes #1 a valid target.
const messages = (tag) => [
  { id: `u_${tag}`, role: "user", content: [{ type: "text", text: `work on ${tag}` }] },
  { id: `a_${tag}`, role: "assistant", content: [{ type: "tool-call", id: `c_${tag}`, name: "read", input: { filePath: `src/${tag}.ts` } }] },
  { id: `t_${tag}`, role: "tool", content: [{ type: "tool-result", id: `c_${tag}`, name: "read", result: { type: "text", value: `payload-${tag} ` + "X".repeat(4000) } }] },
  { id: `u2_${tag}`, role: "user", content: [{ type: "text", text: `now do the next thing for ${tag}` }] },
];
const countWith = (store, prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).length;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CP-25
// Drive well past both caps and check they hold at the defaults.
{
  ctxTools.clear();
  hooks.clear();
  const events = makeEventStream();
  const storage = makeStorage();
  const cleanup = await modDefault.setup(makeCtx({ storage, events }));
  await settle();

  const compress = ctxTools.get("compress");
  assert.ok(compress, "the compress tool must be registered");

  // 700 distinct digests: 200 over the summary cap, so the every-100-writes
  // sweep has to run seven times to keep up.
  for (let i = 0; i < 700; i++) {
    const sid = `ses_gc_${i}`;
    await hooks.get("context")({
      sessionID: sid,
      model: { providerID: "prov", id: "model-a" },
      messages: messages(`d${i}`),
      tools: [],
    });
    await compress.execute(
      // The range and topic are tool INPUT; only sessionID is call context.
      // Target the tool result by part id: `from`/`to` are #N in context_map
      // order, and #1 is the leading user text, not the output we want.
      { from: `c_d${i}`, to: `c_d${i}`, topic: `topic-${i}`, reason: "testing the cap" },
      { sessionID: sid },
    );
  }
  await settle(400);

  const summaries = countWith(storage.store, "summary:");
  assert.ok(
    summaries <= SUMMARY_MAX,
    `CP-25: summary digests ${summaries} exceeded the cap ${SUMMARY_MAX} after a long run`,
  );
  // And the cap must be doing real work, not passing because nothing accumulated.
  assert.ok(summaries > SUMMARY_MAX * 0.5, `CP-25: expected the digest cache to fill up, got only ${summaries}`);
  assert.ok(
    storage.scans() > 1,
    `CP-25: the periodic sweep never ran (scans=${storage.scans()}) -- the cap is not being enforced over a long run`,
  );
  console.log(`  (CP-25: after 700 digests -> ${summaries} summary keys held against a cap of ${SUMMARY_MAX}, ${storage.scans()} store scans)`);
  await cleanup();
}

// ---------------------------------------------------------------- CP-25b
// The calibration cap needs its own drive: entries are only written once a
// session has been seen on a *distinct* model and a usage event has revealed a
// real ratio, so the digest loop above never produces one.
{
  ctxTools.clear();
  hooks.clear();
  const events = makeEventStream();
  const storage = makeStorage();
  const ATTEMPT = CALIB_MAX + 120; // deliberately past the cap
  // Each session needs its OWN catalog entry, or every ref resolves to the
  // same model and the whole run writes a single calibration key.
  const catalog = Array.from({ length: ATTEMPT }, (_, i) => ({
    id: `model-${i}`,
    providerID: "prov",
    limit: { context: 200000, output: 8000 },
  }));
  const cleanup = await modDefault.setup(makeCtx({ storage, events, models: catalog }));
  await settle();

  // The usage stream is async: a pushed event is only delivered when the loop
  // gets a turn. Pushing both readings back to back would deliver them after
  // the compiles have already run, and the baseline would zero pendingEstimate
  // with no re-arm in between -- so the delta would find nothing to divide by
  // and no calibration entry would ever be written. Yield after each push.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < ATTEMPT; i++) {
    const sid = `ses_cal_${i}`;
    const model = { providerID: "prov", id: `model-${i}` };
    // The ratio branch needs pendingEstimate > 0 AND a baseline total, but every
    // usage event resets pendingEstimate to 0 at its end. So: compile, take a
    // baseline reading, compile again, then report a delta.
    await hooks.get("context")({ sessionID: sid, model, messages: messages(`c${i}`), tools: [] });
    events.push({ type: "session.usage.updated", data: { sessionID: sid, tokens: { input: 1000, cache: { read: 0, write: 0 } } } });
    await tick();
    await hooks.get("context")({ sessionID: sid, model, messages: messages(`c${i}b`), tools: [] });
    events.push({ type: "session.usage.updated", data: { sessionID: sid, tokens: { input: 9000, cache: { read: 500, write: 100 } } } });
    await tick();
  }
  await settle(400);

  const calibrations = countWith(storage.store, "calibration:");
  assert.ok(calibrations > 0, `CP-25b: no calibration entries were written (${ATTEMPT} distinct models driven)`);
  // The cap is a soft bound, and this is what pins that honestly. gcStorage is
  // driven by a counter (every 100 cache writes) rather than by the size of the
  // namespace, so after a sweep trims to the cap, another batch of writes lands
  // before the next sweep. The guarantee is therefore "cap + at most one batch",
  // NOT "cap" -- asserting <= CALIB_MAX here would have been a test that passes
  // only because the previous run happened to stop on a sweep boundary.
  const GC_BATCH = 100;
  assert.ok(
    calibrations <= CALIB_MAX + GC_BATCH,
    `CP-25b: ${calibrations} calibration entries exceeded the bound ${CALIB_MAX} + one ${GC_BATCH}-write batch after driving ${ATTEMPT} models`,
  );
  // Bounded must also mean bounded: without a working cap this would be ATTEMPT.
  assert.ok(
    calibrations < ATTEMPT * 0.95,
    `CP-25b: calibration cache grew to ${calibrations} of ${ATTEMPT} attempted models -- the cap is not being enforced`,
  );
  // And it must fill to near the cap, so the above cannot pass by staying tiny.
  assert.ok(
    calibrations > CALIB_MAX * 0.8,
    `CP-25b: expected the calibration cache to fill to near its cap, got ${calibrations} of ${CALIB_MAX}`,
  );
  console.log(`  (CP-25b: ${ATTEMPT} distinct models -> ${calibrations} calibration keys; cap ${CALIB_MAX} + up to one ${GC_BATCH}-write batch)`);
  await cleanup();
}

// ---------------------------------------------------------------- CP-26
// The startup sweep must not reclaim a live session's digests, even when the
// live digests are the oldest and the store is over the cap.
{
  ctxTools.clear();
  hooks.clear();
  const events = makeEventStream();
  const LIVE = "ses_gc_live";
  const seed = [];
  // The live session's digests are the OLDEST, so a naive oldest-first cap
  // would evict them first.
  for (let i = 0; i < 40; i++) {
    seed.push([`summary:live-${i}`, { text: `live digest ${i}`, topic: "auto", version: 1, at: 1000 + i, sessions: [LIVE] }]);
  }
  // Noise: unattributed digests (left to the count cap by CP-18) that are newer.
  for (let i = 0; i < SUMMARY_MAX + 50; i++) {
    seed.push([`summary:noise-${i}`, { text: `noise ${i}`, topic: "auto", version: 1, at: 900000 + i }]);
  }
  const storage = makeStorage(seed);
  const cleanup = await modDefault.setup(makeCtx({ storage, events }));
  await settle(300);

  const liveLeft = [...storage.store.keys()].filter((k) => k.startsWith("summary:live-"));
  assert.equal(
    liveLeft.length,
    40,
    `CP-26: the count cap evicted ${40 - liveLeft.length} of the live session's 40 digests; eviction must be oldest-first among unreferenced entries only`,
  );
  assert.ok(
    [...storage.store.keys()].filter((k) => k.startsWith("summary:noise-")).length <= SUMMARY_MAX,
    "CP-26: the count cap must still bound the unreferenced digests",
  );
  console.log(`  (CP-26: 40 live digests survived a store seeded with ${seed.length} entries, ${countWith(storage.store, "summary:")} digests kept)`);
  await cleanup();
}

// ---------------------------------------------------------------- CP-27
// Deleting a session mid-run drops exactly its keys, and only its keys.
{
  ctxTools.clear();
  hooks.clear();
  const events = makeEventStream();
  const storage = makeStorage();
  const cleanup = await modDefault.setup(makeCtx({ storage, events }));
  await settle();

  const survivors = [];
  for (let i = 0; i < 6; i++) {
    const sid = `ses_del_${i}`;
    await hooks.get("context")({ sessionID: sid, model: { providerID: "prov", id: "model-a" }, messages: messages(`s${i}`), tools: [] });
    await ctxTools.get("compress").execute(
      { from: `c_s${i}`, to: `c_s${i}`, topic: `t${i}`, reason: "test" },
      { sessionID: sid },
    );
    survivors.push(sid);
  }
  await settle(300);

  const DOOMED = "ses_del_2";
  for (const sid of survivors) {
    assert.ok(storage.store.has(`epoch:${sid}`) || storage.store.has(`recall:${sid}`) || storage.store.has(`summaries:${sid}`),
      `CP-27: ${sid} should have per-session state before the delete`);
  }
  // A digest owned by BOTH the doomed session and a survivor: deleting one
  // owner must not reclaim it, which is the whole point of the owners record.
  const KEEPER = survivors.find((s) => s !== DOOMED);
  storage.store.set("summary:shared_keep", { text: "shared digest", topic: "t", version: 1, at: Date.now(), sessions: [DOOMED, KEEPER] });
  await settle(50);
  // Snapshot key -> value: ownership has to be read from the state BEFORE the
  // delete, since a reclaimed digest is no longer in the store to ask.
  const before = new Map([...storage.store.entries()].map(([k, v]) => [k, v]));

  events.push({ type: "session.deleted", data: { sessionID: DOOMED } });
  await settle(300);

  for (const key of [`epoch:${DOOMED}`, `recall:${DOOMED}`, `summaries:${DOOMED}`]) {
    assert.equal(storage.store.has(key), false, `CP-27: ${key} survived the delete`);
  }
  for (const [key, value] of before) {
    if (key.includes(DOOMED)) continue;
    // Digest keys are content hashes, so a digest owned only by the deleted
    // session cannot be recognised from its key -- check its recorded owners.
    if (Array.isArray(value?.sessions) && value.sessions.includes(DOOMED)) continue; // CP-18 reclaims it legitimately
    assert.equal(storage.store.has(key), true, `CP-27: deleting ${DOOMED} wrongly dropped ${key}`);
  }
  // And the point of the ownership record: a digest shared with a surviving
  // session must NOT be reclaimed when the other owner is deleted.
  assert.equal(
    storage.store.has("summary:shared_keep"),
    true,
    "CP-27: a digest also owned by a surviving session must survive another owner's deletion",
  );
  // The in-memory session must be gone too, not just the persisted keys.
  assert.equal(t.hasSession(DOOMED), false, "CP-27: the deleted session must be evicted from memory as well");
  for (const sid of survivors) {
    if (sid !== DOOMED) assert.equal(t.hasSession(sid), true, `CP-27: ${sid} must survive another session's delete`);
  }
  console.log(`  (CP-27: deleted ${DOOMED}; ${countWith(storage.store, "epoch:")} epoch / ${countWith(storage.store, "recall:")} recall keys remain for the other sessions)`);
  await cleanup();
  t.resetSessions();
}

// ---------------------------------------------------------------- CP-28
// The GC's own cost at the cap. Every 100 writes it pages the whole digest
// namespace; that price scales with the cap, so the cap is budgeted here.
{
  ctxTools.clear();
  hooks.clear();
  const events = makeEventStream();
  const seed = [];
  for (let i = 0; i < SUMMARY_MAX; i++) {
    seed.push([`summary:fill-${i}`, { text: `digest ${i} ` + "d".repeat(500), topic: "auto", version: 1, at: 1000 + i }]);
  }
  for (let i = 0; i < CALIB_MAX; i++) {
    seed.push([`calibration:prov/model-${i}`, { r: 1 + i / 1000, updatedAt: 1000 + i }]);
  }
  const storage = makeStorage(seed);
  const t0 = performance.now();
  const cleanup = await modDefault.setup(makeCtx({ storage, events }));
  // The sweep is fire-and-forget, so time it by watching for the scans to stop:
  // measuring a fixed sleep would just measure the sleep.
  let last = -1;
  let stable = 0;
  let elapsed = 0;
  while (stable < 6) {
    await new Promise((r) => setTimeout(r, 5));
    elapsed = performance.now() - t0;
    if (storage.scans() === last) stable += 1;
    else { stable = 0; last = storage.scans(); }
  }
  assert.equal(countWith(storage.store, "summary:"), SUMMARY_MAX, "CP-28: a store exactly at the cap must not be trimmed");
  // Generous: this is 20+ paged scans over both namespaces in a test double.
  // The budget exists to catch a scan that stops paginating, not to police CPU.
  assert.ok(
    elapsed < 500,
    `CP-28: the startup sweep took ${elapsed.toFixed(0)} ms for a store at the cap (${SUMMARY_MAX} digests, ${CALIB_MAX} calibrations); budget is 500 ms`,
  );
  assert.ok(storage.scans() >= 20, `CP-28: expected a paged scan of both namespaces, got ${storage.scans()} scan calls`);
  console.log(`  (CP-28: sweep of a full store took ${elapsed.toFixed(0)} ms over ${storage.scans()} paged scans)`);
  await cleanup();
}

console.log("verify-pruner-gc: all assertions passed");
