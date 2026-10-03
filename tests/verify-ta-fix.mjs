/**
 * Regression tests for the tool-audit fixes (CODE-REVIEW-FINDINGS-2026-10-01):
 *
 *   TA-1 — trace_timeline queries started_at (not the nonexistent `time`)
 *          and its status filter enum matches the stored statuses; smoke
 *          test that records a call and calls the tool.
 *   TA-2 — trace_stats duration percentiles respect the sessionId/since
 *          where clause and label the row when filtered.
 *   TA-3/TA-4 — id-less events keep call_id = NULL (no "(no-id)" sentinel),
 *          so the partial unique index no longer drops every call after the
 *          first.
 *   TA-5 — trace_export closes the stream and removes its temp dir on all
 *          paths; the finished export is moved into the plugin dir so the
 *          returned path stays valid.
 *   TA-6 — a call swept out of the pending map is still recorded, with
 *          duration_ms NULL (not a fabricated 0).
 *
 *   node tests/verify-ta-fix.mjs
 */

import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), "opencode-ta-fix");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
// Redirect os.tmpdir() so trace_export's temp dirs land where we can inspect
// them for leaks.
const tmpSandbox = join(root, "tmp");
mkdirSync(tmpSandbox, { recursive: true });
process.env.TMPDIR = tmpSandbox;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const { openDatabase } = await import("../lib/sqlite.ts");
const mod = await import(new URL("../plugins/tool-audit.ts", import.meta.url));

const dir = join(root, "ta");
const tools = [];
const hooks = {};
const ctx = {
  options: { dir, retentionDays: 30, redact: true },
  location: { directory: root },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => tools.push(t) });
    },
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
};
const cleanup = await mod.default.setup(ctx);
const by = Object.fromEntries(tools.map((t) => [t.name, t]));

// Deterministic clock: the hooks only read Date.now(), offset it per scenario.
const realNow = Date.now.bind(Date);
const base = realNow();
let offset = 0;
Date.now = () => base + offset;
const restore = () => {
  Date.now = realNow;
};

try {
  // --- TA-1: smoke — record a call, trace_timeline must show it -------------
  offset = 0;
  await hooks["execute.before"]({ tool: "ta-read", sessionID: "sesA", agent: "build", messageID: "m1", id: "c1", input: { path: "a.ts" } });
  offset = 150;
  await hooks["execute.after"]({ tool: "ta-read", sessionID: "sesA", agent: "build", messageID: "m1", id: "c1", input: {}, status: "completed", result: { content: "ok" } });

  const tl = await by.trace_timeline.execute({ tool: "ta-read" }, {});
  check(
    "TA-1 trace_timeline works and lists the recorded call",
    tl.content.startsWith("Call history for 'ta-read'") &&
      !tl.content.startsWith("trace_timeline failed") &&
      tl.content.includes("completed") &&
      tl.content.includes("150ms"),
    tl.content.split("\n").slice(0, 2).join(" | "),
  );
  const tlErr = await by.trace_timeline.execute({ tool: "ta-read", status: "error" }, {});
  check("TA-1 status enum 'error' filters correctly", tlErr.content.includes("No calls found"), tlErr.content);
  const tlOk = await by.trace_timeline.execute({ tool: "ta-read", status: "completed" }, {});
  check("TA-1 status enum 'completed' (the stored value) matches", tlOk.content.includes("ta-read"));

  // --- TA-6: swept pending entry → recorded with NULL duration --------------
  await hooks["execute.before"]({ tool: "ta-orphan", sessionID: "sesC", agent: "build", messageID: "m9", id: "c9", input: {} });
  offset = 61 * 60_000; // past the raised sweep TTL
  // Any before() triggers the (gate-limited) sweep.
  await hooks["execute.before"]({ tool: "ta-prime", sessionID: "sesC", agent: "build", messageID: "m10", id: "c10", input: {} });
  await hooks["execute.after"]({ tool: "ta-orphan", sessionID: "sesC", agent: "build", messageID: "m9", id: "c9", input: {}, status: "completed", result: { content: "done" } });

  {
    const db = openDatabase(join(dir, "tool-audit.db"));
    const row = db.prepare("SELECT duration_ms, call_id FROM calls WHERE call_id = 'c9'").get();
    db.close();
    check(
      "TA-6 swept call is still recorded with duration_ms NULL (not 0)",
      row !== null && row.duration_ms === null,
      JSON.stringify(row),
    );
  }

  // --- TA-3/TA-4: id-less events each get a row with call_id NULL ------------
  await hooks["execute.after"]({ tool: "ta-noid", sessionID: "sesD", agent: "build", messageID: "m2", input: {}, status: "completed", result: { content: "one" } });
  await hooks["execute.after"]({ tool: "ta-noid", sessionID: "sesD", agent: "build", messageID: "m3", input: {}, status: "completed", result: { content: "two" } });
  {
    const db = openDatabase(join(dir, "tool-audit.db"));
    const rows = db.prepare("SELECT call_id FROM calls WHERE tool = 'ta-noid'").all();
    db.close();
    check(
      "TA-3/TA-4 both id-less calls recorded with call_id NULL (no sentinel collision)",
      rows.length === 2 && rows.every((r) => r.call_id === null),
      JSON.stringify(rows),
    );
  }

  // --- TA-2: percentiles respect the filter; filtered row is labeled ---------
  // Same tool in two sessions: 5x100ms calls in sesA, 1x5000ms call in sesB.
  // Unfiltered ta-mix p50 = 100ms; filtered to sesB it must be 5.0s. The old
  // code computed percentiles from the whole table, so the filtered row would
  // wrongly show 100ms.
  let clock = 70 * 60_000;
  for (let i = 1; i <= 5; i++) {
    const id = `f${i}`;
    await hooks["execute.before"]({ tool: "ta-mix", sessionID: "sesA", agent: "build", messageID: "m4", id, input: {} });
    clock += 100;
    offset = clock;
    await hooks["execute.after"]({ tool: "ta-mix", sessionID: "sesA", agent: "build", messageID: "m4", id, input: {}, status: "completed", result: {} });
    clock += 100;
    offset = clock;
  }
  await hooks["execute.before"]({ tool: "ta-mix", sessionID: "sesB", agent: "build", messageID: "m5", id: "c5", input: {} });
  offset = clock + 5_000;
  await hooks["execute.after"]({ tool: "ta-mix", sessionID: "sesB", agent: "build", messageID: "m5", id: "c5", input: {}, status: "completed", result: {} });

  const statsB = await by.trace_stats.execute({ sessionId: "sesB" }, {});
  const bLine = statsB.content.split("\n").find((l) => l.includes("ta-mix")) ?? "";
  check(
    "TA-2 filtered percentiles computed from the filtered rows only (p50=5.0s)",
    bLine.includes("p50=5.0s"),
    bLine,
  );
  check(
    "TA-2 filtered report labels the filter on the per-tool row",
    statsB.content.includes("per tool (filtered: session=sesB)"),
    statsB.content.split("\n").find((l) => l.includes("per tool")) ?? "",
  );
  const statsAll = await by.trace_stats.execute({}, {});
  const allLine = statsAll.content.split("\n").find((l) => l.includes("ta-mix")) ?? "";
  check(
    "TA-2 unfiltered p50 reflects all six durations (100ms), filtered one did not",
    allLine.includes("p50=100ms") && statsAll.content.includes("per tool (calls |"),
    allLine,
  );

  // --- TA-5: export lifecycle -------------------------------------------------
  restore();
  const jsonl = await by.trace_export.execute({ format: "jsonl" }, {});
  const m = /Exported (\d+) row\(s\) to (.+)$/.exec(jsonl.content);
  check("TA-5 export reports rows", m !== null && Number(m[1]) >= 5, jsonl.content);
  check(
    "TA-5 exported file lives under the plugin dir and exists",
    m !== null && m[2].startsWith(join(dir, "exports")) && existsSync(m[2]),
    m ? m[2] : jsonl.content,
  );
  check(
    "TA-5 exported content has the recorded call",
    m !== null && readFileSync(m[2], "utf8").includes("ta-read"),
  );
  check(
    "TA-5 no trace-export temp dirs left behind after success",
    readdirSync(tmpSandbox).filter((n) => n.startsWith("trace-export-")).length === 0,
    readdirSync(tmpSandbox).join(","),
  );
  const none = await by.trace_export.execute({ tool: "nothing-matches" }, {});
  check("TA-5 zero-match export reports No tool calls matched.", none.content === "No tool calls matched.");
  check(
    "TA-5 no trace-export temp dirs left behind after zero-match",
    readdirSync(tmpSandbox).filter((n) => n.startsWith("trace-export-")).length === 0,
    readdirSync(tmpSandbox).join(","),
  );
} finally {
  restore();
}

await cleanup();
rmSync(root, { recursive: true, force: true });

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
