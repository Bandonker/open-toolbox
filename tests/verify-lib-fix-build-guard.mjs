/**
 * LIB-3 regression test for scripts/build-packages.mjs's .ts-import guard.
 *
 *   node tests/verify-lib-fix-build-guard.mjs
 *
 * Importing the build script must NOT run a build (main() is gated on
 * direct invocation); assertNoTsImports must reject dynamic `import(...)`
 * and `require(...)` .ts specifiers anywhere in the emitted output, not
 * just static `from` clauses — while leaving ".ts" strings in data alone.
 */
let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const t0 = Date.now();
const mod = await import(new URL("../scripts/build-packages.mjs", import.meta.url));
const { assertNoTsImports } = mod;

check("LIB-3: build script imports without executing a build",
  typeof assertNoTsImports === "function" && Date.now() - t0 < 5000,
  `import took ${Date.now() - t0}ms`);

const throws = (code) => {
  try {
    assertNoTsImports(code, "test.js");
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
};

check("LIB-3: static from-clause .ts import still rejected",
  throws(`import x from "./memory.ts";`) !== null);
check("LIB-3: dynamic import(\"./x.ts\") is rejected (the LIB-3 escape)",
  throws(`const mod = await import("./memory.ts");`) !== null);
check("LIB-3: bare import(\"./x.ts\") (no await) is rejected",
  throws(`import("./decision-log.ts");`) !== null);
check("LIB-3: require(\"./x.ts\") is rejected",
  throws(`const m = require("./snippet-library.ts");`) !== null);
check("LIB-3: case-insensitive extension matching kept",
  throws(`await import("./Memory.TS");`) !== null);
check("LIB-3: error message names the offending specifier",
  (throws(`await import("./memory.ts");`) ?? "").includes("./memory.ts"));
check("LIB-3: rewritten .js specifiers pass",
  throws(`import { openDatabase } from "./lib/sqlite.js";`) === null);
check("LIB-3: .ts strings in data are NOT false positives",
  throws(`const exts = [".ts", ".tsx"]; scan("index.ts");`) === null);
check("LIB-3: clean code passes",
  throws(`const a = 1; export default a;`) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
