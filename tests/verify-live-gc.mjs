#!/usr/bin/env node
/**
 * Live validation of the context-pruner storageGc caps against a running server.
 *
 * Deliberately NOT part of `npm test`: it mutates the real
 * `~/.config/opencode/context-pruner.jsonc` and needs the running opencode
 * server. It restores the config on the way out, including on failure.
 *
 *   node tests/verify-live-gc.mjs
 *   LIVE_PROVIDER=opencode-go LIVE_MODEL=space-bunny-free node tests/verify-live-gc.mjs
 *
 * Why this exists: `tests/verify-pruner-gc.mjs` proves the eviction *policy*
 * against a fake store. Nothing proved it against opencode's real
 * `ctx.storage`, which is a SQLite `kv` table namespaced per plugin — a
 * different backend with its own scan/remove behaviour. This drives the real
 * plugin until it writes digests, lowers the cap, and checks the real store
 * afterwards.
 *
 * Env:
 *   OPENCODE_LIVE_URL       default http://127.0.0.1:49374
 *   OPENCODE_LIVE_PASSWORD  else ~/.config/opencode/service.json
 *   OPENCODE_DB             default ~/.local/share/opencode/opencode.db
 *   GC_CAP                  cap to test against, default 2
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const base = (process.env.OPENCODE_LIVE_URL ?? "http://127.0.0.1:49374").replace(/\/$/, "");
const dbPath = process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
const cfgPath = join(homedir(), ".config", "opencode", "context-pruner.jsonc");
const cap = Number(process.env.GC_CAP ?? 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const note = (t) => console.log(`NOTE  ${t}`);
const fail = (t) => {
  console.log(`SKIP  ${t}`);
  process.exit(0);
};

function password() {
  if (process.env.OPENCODE_LIVE_PASSWORD) return process.env.OPENCODE_LIVE_PASSWORD;
  const f = join(homedir(), ".config", "opencode", "service.json");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")).password;
}
const auth = (() => {
  const pw = password();
  return pw ? "Basic " + Buffer.from("opencode:" + pw).toString("base64") : null;
})();

/**
 * Count the pruner's cache entries in the real store.
 *
 * Plugin storage is namespaced as `plugin:<utf16-hex of plugin id>:<key>`, so a
 * bare `LIKE 'summary:%'` finds nothing — which is exactly why an earlier
 * attempt to observe these numbers by hand came back empty and looked like "no
 * digests were ever written".
 */
function readStore() {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const decode = (hex) => {
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };
  let summaries = 0;
  let calibration = 0;
  const owners = [];
  for (const row of db.prepare("SELECT key, value, time_created FROM kv WHERE key LIKE 'plugin:%'").all()) {
    const m = row.key.match(/^plugin:([0-9a-f]+):(.*)$/);
    if (!m || !decode(m[1]).includes("context-pruner")) continue;
    if (m[2].startsWith("summary:")) {
      summaries += 1;
      let parsed = {};
      try {
        parsed = JSON.parse(row.value);
      } catch {}
      owners.push({ key: m[2], sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [], ageMs: Date.now() - row.time_created });
    } else if (m[2].startsWith("calibration:")) calibration += 1;
  }
  db.close();
  return { summaries, calibration, owners };
}

async function reachable() {
  if (!auth) return false;
  try {
    const r = await fetch(base + "/app", { headers: { authorization: auth } });
    return r.ok;
  } catch {
    return false;
  }
}
async function reload() {
  await fetch(base + "/api/location/reload", { method: "POST", headers: { authorization: auth } });
}

const before = readStore();
if (!before) fail("opencode.db not found at " + dbPath);
note(`pruner cache before: summary=${before.summaries} calibration=${before.calibration}`);
if (before.summaries < 1) {
  fail(
    `no digests in the real store yet — run tests/verify-live.mjs (soak/recall) first, or drive a few turns by hand`,
  );
}

if (!(await reachable())) fail("opencode live server is not reachable at " + base);

const backup = cfgPath + ".gctest.bak";
const hasCfg = existsSync(cfgPath);
if (hasCfg) copyFileSync(cfgPath, backup);
let restored = false;
/** Idempotent: the exit handler and the `finally` both call this. */
const restore = () => {
  if (restored) return;
  restored = true;
  try {
    if (hasCfg && existsSync(backup)) {
      copyFileSync(backup, cfgPath);
      unlinkSync(backup);
    }
  } catch (e) {
    console.log(`WARN  could not restore ${cfgPath}: ${e.message}`);
  }
};
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(1);
});

try {
  // Two things have to change, not one. Lowering the cap alone is not enough:
  // a digest is only written when the pruner actually summarises something, and
  // with a wide window and a high steadyTargetRatio it never needs to — so the
  // cache simply sits there and the check would pass without evicting
  // anything. `steadyTargetRatio` low forces proactive summarising, which is
  // what writes the digests the cap then has to bound.
  if (hasCfg) {
    const src = readFileSync(cfgPath, "utf8").replace(
      /\}\s*$/,
      `,\n  "summaryCacheMax": ${cap},\n  "calibrationMax": ${cap},\n  "steadyTargetRatio": 0.02\n}\n`,
    );
    writeFileSync(cfgPath, src);
  }
  await reload();
  // Summarising costs a model call per digest, so allow real time for a few.
  const deadline = Date.now() + Number(process.env.GC_SETTLE_MS ?? 120000);
  let before2 = readStore();
  while (Date.now() < deadline && before2.summaries <= cap) {
    await sleep(10000);
    before2 = readStore();
    if (before2.summaries > cap) break;
  }
  note(`digests written under a low steadyTargetRatio: ${before2.summaries}`);

  // Now that there is something above the cap, lower it and let startup sweep.
  if (hasCfg) {
    const src = readFileSync(cfgPath, "utf8").replace(
      /\}\s*$/,
      `,\n  "summaryCacheMax": ${cap},\n  "calibrationMax": ${cap}\n}\n`,
    );
    writeFileSync(cfgPath, src);
  }
  await reload();
  await sleep(8000);

  const written = before2;
  const after = readStore();
  note(`pruner cache after cap=${cap}: summary=${after.summaries} calibration=${after.calibration}`);

  check(
    "the digest cap holds against the real ctx.storage",
    after.summaries <= cap,
    `summary=${after.summaries} cap=${cap}`,
  );
  check(
    "the calibration cap holds against the real ctx.storage",
    after.calibration <= cap,
    `calibration=${after.calibration} cap=${cap}`,
  );
  // If the cache was already at or below the cap, nothing was actually evicted
  // and these checks would pass without proving anything. Say so rather than
  // reporting a green run that tested nothing.
  const evictionExercised = written.summaries > cap;
  note(
    evictionExercised
      ? `eviction exercised: ${written.summaries} -> ${after.summaries} entries`
      : `INCONCLUSIVE: cache already at/below the cap (${written.summaries} <= ${cap}), so no eviction ran. ` +
        `Run tests/verify-live.mjs (soak/recall) to write more digests first.`,
  );
  // The policy bug the local test found: evicting purely oldest-first threw
  // away digests still owned by a live session, so the next compress re-spent
  // a model call. Live ownership must survive; only unreferenced entries go.
  const liveOwned = after.owners.filter((o) => o.sessions.length > 0);
  check(
    "entries owned by a live session survive eviction",
    !evictionExercised || liveOwned.length === after.owners.length,
    after.owners.map((o) => `${o.key}(${o.sessions.length} owner(s))`).join(" ") || "cache empty",
  );
  check(
    "the cache is not merely emptied to satisfy the cap",
    !evictionExercised || (after.summaries > 0 && after.summaries <= cap),
    `summary=${after.summaries}`,
  );
  check(
    "eviction was actually exercised (not a vacuous pass)",
    evictionExercised,
    evictionExercised ? `${written.summaries} -> ${after.summaries}` : "cache was already within the cap",
  );
} finally {
  restore();
  await reload();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live cap checks passed`);
process.exit(failed === 0 ? 0 : 1);
