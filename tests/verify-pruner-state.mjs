/**
 * C18 verification: context-pruner per-session state must evict
 * least-recently-used (not first-inserted), and epoch + compress decisions
 * must survive eviction/restart via the epoch store.
 *
 *   node tests/verify-pruner-state.mjs
 */
let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/context-pruner.ts", import.meta.url));
check("context-pruner exposes a __test__ state seam", mod.__test__ !== undefined);
const t = mod.__test__;
if (!t) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = 1;
} else {
  // ---- LRU eviction: an active session survives past 512 ----
  t.resetSessions();
  t.stateFor("active");
  for (let i = 0; i < 511; i++) t.stateFor(`filler_${i}`);
  check("512 sessions held", t.sessionCount() === 512, `count=${t.sessionCount()}`);
  t.stateFor("active"); // touch: most-recently-used
  t.stateFor("one_more"); // triggers one eviction
  check("C18: active session survives eviction pressure", t.hasSession("active"));
  check("C18: an idle session was evicted instead", !t.hasSession("filler_0") && t.sessionCount() === 512,
    `count=${t.sessionCount()}`);

  // ---- epoch/decisions persist across eviction + restart ----
  const saved = new Map();
  t.setEpochStore({
    load: async (sid) => saved.get(sid),
    save: (sid, snap) => { saved.set(sid, snap); },
  });
  t.resetSessions();
  const s = t.stateFor("persist_me");
  s.epoch = 7;
  s.decisions.set("k1", { key: "k1", reason: "test", origChars: 100, savedChars: 50, savedTokens: 10 });
  for (let i = 0; i < 512; i++) t.stateFor(`evict_${i}`); // forces persist_me out
  check("C18: eviction flushes epoch/decisions to the store",
    saved.get("persist_me")?.epoch === 7 && saved.get("persist_me")?.decisions?.length === 1,
    JSON.stringify(saved.get("persist_me") ?? null));

  t.resetSessions(); // simulate a restart: memory empty, store intact
  const s2 = t.stateFor("persist_me");
  await new Promise((r) => setTimeout(r, 50)); // async load lands
  check("C18: epoch/decisions reload after restart", s2.epoch === 7 && s2.decisions.has("k1"),
    `epoch=${s2.epoch} decisions=${s2.decisions.size}`);
  t.setEpochStore(null);
  t.resetSessions();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
