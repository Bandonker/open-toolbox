/**
 * LIB-1 / LIB-8 / LIB-9 regression tests for lib/redact.ts.
 *
 *   node tests/verify-lib-fix-redact.mjs
 *
 * LIB-1: the HEROKU_API_KEY rule must be context-gated (label prefix before
 * the UUID) and the keyword prefilter must be word-boundary aware; the
 * BEARER_TOKEN capture class is widened with #_$*: (that rule only).
 * LIB-8: isScanTruncated/scanGaps accept an optional maxScan parameter.
 * LIB-9: line/column are computed only when includeLocation is set.
 */
const redact = await import(new URL("../lib/redact.ts", import.meta.url));
const { redactSecrets, collectFindings, isScanTruncated, scanGaps, buildAllowList } = redact;

// Real signature is collectFindings(text, location, opts, allow) — match how
// plugins call it. Entropy on so the benign-shape allowlist is exercised too.
const scan = (text, opts = {}) =>
  collectFindings(text, "test", { entropy: true, ...opts }, buildAllowList([]));

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const UUID = "3f2a1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c";

// --- LIB-1: benign UUIDs survive ---
const keyboardText = `Restart the keyboard. Request ${UUID} timed out after 30s.`;
const kbOut = redactSecrets(keyboardText);
check("LIB-1: UUID next to \"keyboard\" is NOT redacted", kbOut.includes(UUID), kbOut.slice(0, 120));

const gateOpen = `secret sauce: request ${UUID} failed`;
check("LIB-1: UUID survives even with the keyword gate open",
  redactSecrets(gateOpen).includes(UUID), redactSecrets(gateOpen).slice(0, 120));

const monkey = `monkey keys on a keyword: ${UUID}`;
check("LIB-1: monkey/keys/keyword do not redact a bare UUID",
  redactSecrets(monkey).includes(UUID), redactSecrets(monkey).slice(0, 140));

// --- LIB-1: real Heroku assignments are still redacted ---
const heroku = `HEROKU_API_KEY=${UUID}`;
const herokuOut = redactSecrets(heroku);
check("LIB-1: HEROKU_API_KEY=uuid IS redacted", !herokuOut.includes(UUID), herokuOut);
check("LIB-1: redaction keeps the label and names the rule",
  herokuOut.includes("HEROKU_API_KEY=") && herokuOut.includes("[redacted HEROKU_API_KEY]"), herokuOut);

const herokuLower = `heroku_api_key = "${UUID}"`;
const hlOut = redactSecrets(herokuLower);
check("LIB-1: lowercase quoted assignment is redacted too", !hlOut.includes(UUID), hlOut);

const apiKeyUuid = `api_key: ${UUID}`;
check("LIB-1: api_key: uuid assignment is redacted",
  !redactSecrets(apiKeyUuid).includes(UUID), redactSecrets(apiKeyUuid));

const findingsForHeroku = scan(herokuLower);
check("LIB-1: finding value is just the UUID, not the label",
  findingsForHeroku.some((f) => f.rule === "HEROKU_API_KEY" && f.value === UUID),
  JSON.stringify(findingsForHeroku.map((f) => `${f.rule}=${f.value}`)));

// --- LIB-1: prefilter boundary + existing rules unimpaired ---
const pwFindings = scan(`db config\n  password = "hunter2supersecret"\n`);
check("LIB-1: GENERIC_PASSWORD still detected (prefilter passes on word edges)",
  pwFindings.some((f) => f.rule === "GENERIC_PASSWORD"), JSON.stringify(pwFindings.map((f) => f.rule)));

const bearerExotic = "Authorization: Bearer abcdefgh#ijklmnop$qrst*uvwx:yz0123";
const bearerFindings = scan(bearerExotic);
const bearer = bearerFindings.find((f) => f.rule === "BEARER_TOKEN");
check("LIB-1: bearer token with #_$*: is captured whole (widened class)",
  bearer?.value === "abcdefgh#ijklmnop$qrst*uvwx:yz0123",
  JSON.stringify(bearerFindings.map((f) => `${f.rule}=${f.value}`)));

// --- LIB-8: configurable scan cap ---
const mid = "a".repeat(5000);
check("LIB-8: default cap unchanged (5000 chars not truncated)", isScanTruncated(mid) === false);
check("LIB-8: explicit smaller cap reports truncation", isScanTruncated(mid, 1000) === true);
check("LIB-8: explicit larger cap reports no truncation", isScanTruncated(mid, 100000) === false);
const gaps = scanGaps(mid, 1000);
check("LIB-8: scanGaps honors maxScan",
  gaps.length === 1 && gaps[0][0] === 500 && gaps[0][1] === 4500, JSON.stringify(gaps));
check("LIB-8: scanGaps default stays backward compatible", scanGaps(mid).length === 0);

// --- LIB-9: location only when requested, and correct when it is ---
const locText = `line one\npassword = "secretvalue1234567890"\nthird\nand another secret_token: tokensecret99 here`;
const offLoc = scan(locText);
check("LIB-9: no line/column when includeLocation is off",
  offLoc.length > 0 && offLoc.every((f) => f.line === undefined && f.column === undefined),
  JSON.stringify(offLoc.map((f) => [f.rule, f.line, f.column])));
const onLoc = scan(locText, { includeLocation: true });
check("LIB-9: findings have line/column when includeLocation is on",
  onLoc.length > 0 && onLoc.every((f) => Number.isInteger(f.line) && Number.isInteger(f.column)),
  JSON.stringify(onLoc.map((f) => [f.rule, f.line, f.column])));
const expected = (text, needle) => {
  const idx = text.indexOf(needle);
  const before = text.slice(0, idx);
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") === -1 ? -1 : before.lastIndexOf("\n")) };
};
const pw = onLoc.find((f) => f.rule === "GENERIC_PASSWORD");
const wantPw = expected(locText, "secretvalue1234567890");
check("LIB-9: line/column match the original slice-based semantics",
  pw?.line === wantPw.line && pw?.column === wantPw.column,
  `got=${pw?.line}:${pw?.column} want=${wantPw.line}:${wantPw.column}`);
// "secret_token:" is matched by the token branch of the GENERIC alternation.
const st = onLoc.find((f) => f.rule === "GENERIC_TOKEN");
const wantSt = expected(locText, "tokensecret99");
check("LIB-9: later-line finding also located correctly",
  st?.line === wantSt.line && st?.column === wantSt.column,
  `got=${st?.line}:${st?.column} want=${wantSt.line}:${wantSt.column}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
