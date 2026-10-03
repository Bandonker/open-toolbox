/**
 * Regression tests for the snippet-library fixes (CODE-REVIEW-FINDINGS-2026-10-01):
 *
 *   SL-1 — snippet_search returns the 600-char preview + a snippet_get hint
 *          (not full code); snippet_export is capped (default 100, max 1000)
 *          with a truncated note, and capped exports still re-import.
 *   SL-2 — content-hash column (safe ALTER + backfill + dedup + UNIQUE
 *          index): re-importing an export dedupes instead of duplicating;
 *          incoming ids are preserved; legacy databases migrate cleanly.
 *   SL-3 — the fuzzy fallback applies language/tags filters like the FTS
 *          path and escapes LIKE % and _ metacharacters.
 *   SL-4 — enabled/dir/log options from ctx.options (+ env) are honored:
 *          enabled:false registers nothing, dir relocates the database,
 *          log:true prints activity to stderr.
 *
 *   node tests/verify-sl-fix.mjs
 */

import { rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), "opencode-sl-fix");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.HOME = root;
process.env.USERPROFILE = root;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const { openDatabase } = await import("../lib/sqlite.ts");
const mod = await import(new URL("../plugins/snippet-library.ts", import.meta.url));

async function setupLib(options) {
  const tools = [];
  const ctx = {
    options,
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) });
        return { dispose: async () => {} };
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  return { by: Object.fromEntries(tools.map((t) => [t.name, t])), tools, cleanup };
}

// --- SL-4: enabled:false registers nothing and touches no files -------------
{
  const disabledDir = join(root, "disabled");
  const { tools, cleanup } = await setupLib({ dir: disabledDir, enabled: false });
  check("SL-4 enabled:false registers no tools", tools.length === 0, tools.map((t) => t.name).join(","));
  await cleanup();
  check("SL-4 disabled plugin creates no database", !existsSync(join(disabledDir, "snippet-library.db")));

  const off = await mod.default.setup({ options: {}, tool: { transform: async () => ({ dispose: async () => {} }) } });
  await off();
}

// --- SL-4: dir option + env override ----------------------------------------
{
  const dirOpt = join(root, "byOption");
  const { by, cleanup } = await setupLib({ dir: dirOpt });
  await by.snippet_save.execute({ title: "Opt", code: "const a = 1;" }, {});
  check("SL-4 dir option relocates the database", existsSync(join(dirOpt, "snippet-library.db")));
  check("SL-4 default ~/.opencode-plugins untouched by dir option", !existsSync(join(root, ".opencode-plugins")));
  await cleanup();
}
{
  const dirEnv = join(root, "byEnv");
  process.env.OPENCODE_SNIPPET_LIBRARY_DIR = dirEnv;
  try {
    const { by, cleanup } = await setupLib({});
    await by.snippet_save.execute({ title: "Env", code: "const b = 2;" }, {});
    check("SL-4 OPENCODE_SNIPPET_LIBRARY_DIR honored", existsSync(join(dirEnv, "snippet-library.db")));
    await cleanup();
  } finally {
    delete process.env.OPENCODE_SNIPPET_LIBRARY_DIR;
  }
}

// --- SL-4: log option ---------------------------------------------------------
{
  const dirLog = join(root, "byLog");
  const seen = [];
  const realErr = console.error;
  console.error = (...args) => seen.push(args.join(" "));
  const { by, cleanup } = await setupLib({ dir: dirLog, log: true });
  await by.snippet_save.execute({ title: "Logged", code: "const c = 3;" }, {});
  console.error = realErr;
  check(
    "SL-4 log:true prints activity to stderr",
    seen.some((l) => l.includes("[snippet-library]") && l.includes("saved snippet")),
    seen.join(" | ") || "(nothing captured)",
  );

  const quiet = [];
  console.error = (...args) => quiet.push(args.join(" "));
  const q = await setupLib({ dir: join(root, "quiet") });
  await q.by.snippet_save.execute({ title: "Quiet", code: "const d = 4;" }, {});
  await q.cleanup();
  console.error = realErr;
  check("SL-4 default log:false stays silent", quiet.length === 0, quiet.join(" | "));
  await cleanup();
}

// --- Main library (dir D4): SL-2 + SL-1 + SL-3 -------------------------------
const dirD4 = join(root, "D4");
const lib = await setupLib({ dir: dirD4 });
const { by } = lib;

await by.snippet_save.execute({ title: "Export fix", code: "const zzAlpha = 1;", language: "typescript", tags: ["x"] }, {});
await by.snippet_save.execute({ title: "Second", code: "let zzBeta = 2;", language: "typescript", tags: ["y"] }, {});

// SL-2: export carries hashes.
const exportJson = (await by.snippet_export.execute({}, {})).content;
const exported = JSON.parse(exportJson);
check("SL-2 export rows carry a sha1 content hash", exported.length === 2 && exported.every((r) => /^[0-9a-f]{40}$/.test(r.hash ?? "")));
check("SL-1 uncapped export has no truncated note", !exportJson.includes("truncated"));

// SL-2: re-importing the same export dedupes (was: duplicated the library).
const reimport = (await by.snippet_import.execute({ snippets: exportJson }, {})).content;
check("SL-2 re-import dedupes via hash", /Imported 0 snippet\(s\), skipped 2\./.test(reimport), reimport);
const stats1 = (await by.snippet_stats.execute({}, {})).content;
check("SL-2 library size unchanged after re-import", stats1.includes("Total snippets: 2"), stats1.split("\n")[0]);

// SL-1: capped export appends a note and still re-imports into a fresh lib.
const capped = (await by.snippet_export.execute({ limit: 1 }, {})).content;
check("SL-1 capped export reports the truncation", capped.includes("// truncated: exported 1 of 2 snippets"), capped.split("\n").pop());
{
  const fresh = await setupLib({ dir: join(root, "D7") });
  const imp = (await fresh.by.snippet_import.execute({ snippets: capped }, {})).content;
  check("SL-1 capped export re-imports (tolerant JSON parse)", /Imported 1 snippet\(s\)/.test(imp), imp);
  await fresh.cleanup();
}

// SL-2: ids from the export payload are preserved on a fresh machine.
{
  const fresh = await setupLib({ dir: join(root, "D5") });
  const imp = (await fresh.by.snippet_import.execute({ snippets: exportJson }, {})).content;
  check("SL-2 fresh import takes both rows", /Imported 2 snippet\(s\), skipped 0\./.test(imp), imp);
  const got1 = (await fresh.by.snippet_get.execute({ id: 1 }, {})).content;
  const got2 = (await fresh.by.snippet_get.execute({ id: 2 }, {})).content;
  check(
    "SL-2 incoming ids preserved (id1=Export fix, id2=Second)",
    got1.includes("Export fix") && got2.includes("Second") && got1.includes("#1") && got2.includes("#2"),
    `${got1.split("\n")[0]} | ${got2.split("\n")[0]}`,
  );
  await fresh.cleanup();
}

// SL-1: search returns previews + the snippet_get hint, not the full body.
await by.snippet_save.execute(
  {
    title: "Long helper",
    language: "bash",
    code: Array.from({ length: 120 }, (_, i) => `echo zzGamma-line-${i}`).join("\n") + "\n# ZZ_TAIL_MARKER",
  },
  {},
);
{
  const found = (await by.snippet_search.execute({ query: "zzGamma-line-1" }, {})).content;
  check(
    "SL-1 search returns preview + snippet_get hint, not the full code",
    found.includes("Long helper") &&
      found.includes("(use snippet_get") &&
      !found.includes("ZZ_TAIL_MARKER") &&
      found.length < 1500,
    `${found.length} chars`,
  );
  const full = (await by.snippet_get.execute({ id: 3 }, {})).content;
  check("SL-1 snippet_get still returns the full body", full.includes("ZZ_TAIL_MARKER"));
}

// SL-3: fuzzy fallback honors language/tags filters and escapes LIKE wildcards.
await by.snippet_save.execute({ title: "Py helper", code: "def abcdefg():\n    pass", language: "python", tags: ["x"] }, {});
await by.snippet_save.execute({ title: "Ts helper", code: "const abcdefg = 1;", language: "typescript", tags: ["y"] }, {});
{
  const both = (await by.snippet_search.execute({ query: "cdef" }, {})).content;
  check("SL-3 fuzzy fallback fires and finds both helpers unfiltered", both.includes("Py helper") && both.includes("Ts helper"), both.split("\n")[0]);
  const py = (await by.snippet_search.execute({ query: "cdef", language: "python" }, {})).content;
  check("SL-3 fuzzy fallback applies the language filter", py.includes("Py helper") && !py.includes("Ts helper"), py.split("\n")[0]);
  const tagged = (await by.snippet_search.execute({ query: "cdef", tags: ["x"] }, {})).content;
  check("SL-3 fuzzy fallback applies the tags filter", tagged.includes("Py helper") && !tagged.includes("Ts helper"), tagged.split("\n")[0]);
  const pct = (await by.snippet_search.execute({ query: "cdef%" }, {})).content;
  check("SL-3 fuzzy escapes % (no wildcard match)", pct.includes("No snippets found"), pct.split("\n")[0]);
  const us = (await by.snippet_search.execute({ query: "cdef_g" }, {})).content;
  check("SL-3 fuzzy escapes _ (no single-char wildcard match)", us.includes("No snippets found"), us.split("\n")[0]);
}

await lib.cleanup();

// --- SL-2: legacy database (no hash column, duplicate rows) migrates ---------
{
  const dirD6 = join(root, "D6");
  mkdirSync(dirD6, { recursive: true });
  const legacy = openDatabase(join(dirD6, "snippet-library.db"));
  legacy.exec(`
    CREATE TABLE snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      code TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // The exact accident SL-2 prevents: the same snippet imported twice.
  legacy.prepare("INSERT INTO snippets(title, code, tags) VALUES(?, ?, ?)").run("Dup", "same code", "[]");
  legacy.prepare("INSERT INTO snippets(title, code, tags) VALUES(?, ?, ?)").run("Dup", "same code", "[]");
  legacy.close();

  const migrated = await setupLib({ dir: dirD6 });
  const stats = (await migrated.by.snippet_stats.execute({}, {})).content;
  check("SL-2 legacy duplicates collapsed to the lowest id on migration", stats.includes("Total snippets: 1"), stats.split("\n")[0]);
  const got = (await migrated.by.snippet_get.execute({ id: 1 }, {})).content;
  check("SL-2 migration keeps the original row (min id)", got.includes("Dup") && got.includes("same code"));
  const search = (await migrated.by.snippet_search.execute({ query: "same code" }, {})).content;
  check("SL-2 FTS stays consistent after migration dedup", search.includes("Dup"), search.split("\n")[0]);
  const again = (await migrated.by.snippet_import.execute({ snippets: JSON.stringify([{ title: "Dup", code: "same code" }]) }, {})).content;
  check("SL-2 post-migration import hits the unique hash index", /Imported 0 snippet\(s\), skipped 1\./.test(again), again);
  await migrated.cleanup();
}

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
