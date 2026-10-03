/**
 * LIB-2 / LIB-4 / LIB-5 regression tests for lib/format.ts and lib/config.ts.
 *
 *   node tests/verify-lib-fix-config-format.mjs
 */
const { formatAge } = await import(new URL("../lib/format.ts", import.meta.url));
const config = await import(new URL("../lib/config.ts", import.meta.url));
const { asInt, tryRequire, envStr } = config;

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

// --- LIB-2: formatAge parses all three stored timestamp forms ---
const hoursAgoIso = (h) => new Date(Date.now() - h * 3600_000).toISOString();
check("LIB-2: Z-suffixed ISO renders an age, not \"?\"",
  formatAge(hoursAgoIso(1)) === "1h", formatAge(hoursAgoIso(1)));
check("LIB-2: fresh toISOString() is seconds-old, not \"?\"",
  /^\d+s$/.test(formatAge(new Date().toISOString())), formatAge(new Date().toISOString()));
const offsetZero = `${hoursAgoIso(2).replace("Z", "")}+00:00`;
check("LIB-2: +00:00 offset-suffixed string parses", formatAge(offsetZero) === "2h", formatAge(offsetZero));
const plusFive = formatAge("2020-01-01T00:00:00+05:00");
const wantDays = Math.floor((Date.now() - Date.parse("2020-01-01T00:00:00+05:00")) / 86_400_000);
check("LIB-2: +HH:MM offset respects the zone", /^\d+d$/.test(plusFive) && Math.abs(Number(plusFive.replace("d", "")) - wantDays) <= 1,
  `${plusFive} want≈${wantDays}d`);
const compactOffset = formatAge("2020-01-01T00:00:00-0300");
const wantDays2 = Math.floor((Date.now() - Date.parse("2020-01-01T00:00:00-0300")) / 86_400_000);
check("LIB-2: compact ±HHMM offset parses", /^\d+d$/.test(compactOffset) && Math.abs(Number(compactOffset.replace("d", "")) - wantDays2) <= 1,
  `${compactOffset} want≈${wantDays2}d`);
const naive = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
check("LIB-2: naive sqlite datetime (no marker) treated as UTC",
  formatAge(naive) === "1h" || formatAge(naive) === "59m", `${formatAge(naive)} (input ${naive})`);
check("LIB-2: invalid input still returns \"?\"",
  formatAge("not a date") === "?" && formatAge("") === "?" && formatAge("   ") === "?");

// --- LIB-4: asInt treats empty/whitespace strings as unset ---
check("LIB-4: empty string falls back (was 0)", asInt("", 7) === 7);
check("LIB-4: whitespace-only string falls back", asInt("   ", 7) === 7);
check("LIB-4: numeric strings still coerce", asInt("8", 7) === 8 && asInt(" 9 ", 7) === 9);
check("LIB-4: real values unchanged", asInt(3.7, 7) === 3 && asInt(null, 7) === 7 && asInt(undefined, 7) === 7 && asInt("abc", 7) === 7);
process.env.OPENCODE_LIB_FIX_EMPTY_TEST = "";
check("LIB-4: envStr policy aligned (empty env is unset)", envStr("OPENCODE_LIB_FIX_EMPTY_TEST") === undefined);
delete process.env.OPENCODE_LIB_FIX_EMPTY_TEST;

// --- LIB-5: tryRequire actually requires ---
const sqliteMod = tryRequire("node:sqlite");
check("LIB-5: tryRequire resolves a real builtin module",
  sqliteMod !== null && typeof sqliteMod.DatabaseSync === "function");
check("LIB-5: tryRequire still returns null for missing modules",
  tryRequire("this-module-does-not-exist-lib5") === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
