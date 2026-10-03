/**
 * Regression checks for the rule engine of the code-review plugin.
 *
 * Covers CR-10 (unused/shadowed variable false positives), CR-12 (REGEX_DOS
 * never matching), CR-7 (user pattern compilation, validation and scan budget),
 * CR-16 (focusAreas actually filtering) and CR-8 (size guard).
 *
 *   node tests/verify-cr-fix-rules.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-cr-fix-rules-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/code-review.ts", import.meta.url));
const { __test__ } = mod;
const cfg = __test__.resolveConfig({});

const scan = (lines, options = {}) => {
  const found = __test__.reviewLines(lines, "s.ts", __test__.resolveConfig(options));
  return new Set(found.map((f) => f.ruleId));
};

// ------------------------------------------- CR-10: unused variables
{
  const usedOnce = [
    "export function go() {",
    "  const payload = build();",
    "  send(payload);",
    "  return payload.length;",
    "}",
  ];
  check("a variable used once is no longer 'unused' (CR-10)", !scan(usedOnce).has("UNUSED_VARIABLE"));

  const dead = ["export function go() {", "  const neverUsed = build();", "  return 1;", "}"];
  check("a variable never mentioned again is still reported (CR-10)", scan(dead).has("UNUSED_VARIABLE"));
}

// ------------------------------------------- CR-10: shadowed variables
{
  const siblings = [
    "function first() {",
    "  const result = 1;",
    "  return result;",
    "}",
    "function second() {",
    "  const result = 2;",
    "  return result;",
    "}",
  ];
  check(
    "two sibling function-scope declarations are not shadowing (CR-10)",
    !scan(siblings).has("SHADOWED_VARIABLE"),
  );

  const loops = [
    "function run(items) {",
    "  for (let i = 0; i < items.length; i++) { tick(items[i]); }",
    "  for (let i = 0; i < items.length; i++) { tick(items[i]); }",
    "}",
  ];
  check("two separate for-let loops are not shadowing (CR-10)", !scan(loops).has("SHADOWED_VARIABLE"));

  const nested = ["const value = 1;", "function wrap() {", "  const value = 2;", "  return value;", "}"];
  const found = __test__
    .reviewLines(nested, "s.ts", cfg)
    .filter((f) => f.ruleId === "SHADOWED_VARIABLE");
  check(
    "a genuinely nested redeclaration is still reported (CR-10)",
    found.length === 1 && found[0].line === 3,
    JSON.stringify(found.map((f) => f.line)),
  );
}

// ------------------------------------------- CR-12: the ReDoS rule
{
  check("REGEX_DOS matches a real `new RegExp` call (CR-12)", scan(['const re = new RegExp("(a+)+$");']).has("REGEX_DOS"));
  check("REGEX_DOS covers backtick patterns (CR-12)", scan(["const re = new RegExp(`(a+)+b`);"]).has("REGEX_DOS"));
  check("REGEX_DOS leaves a plain pattern alone (CR-12)", !scan(['const re = new RegExp("^abc$");']).has("REGEX_DOS"));
  check("the shared detector flags nested quantifiers (CR-12)", __test__.hasNestedQuantifier("(a+)+$") === true);
  check("the shared detector ignores flat patterns (CR-12)", __test__.hasNestedQuantifier("^[a-z]+$") === false);
}

// ------------------------------------------- CR-7: user patterns
{
  check("an invalid user pattern is rejected, not ignored (CR-7)", __test__.compileUserPattern("[unclosed").ok === false);
  const risky = __test__.compileUserPattern("(a+)+$");
  check("a nested-quantifier pattern is refused at compile time (CR-7)", risky.ok === false);
  check(
    "an over-long pattern is refused (CR-7)",
    __test__.compileUserPattern("a".repeat(600)).ok === false,
  );
  check("an ordinary pattern compiles (CR-7)", __test__.compileUserPattern("TODO:\\s*fixme").ok === true);

  // A ReDoS-shaped custom rule used to block the host for minutes per line.
  const redosCfg = __test__.resolveConfig({
    customRules: [
      {
        id: "redos",
        name: "ReDoS",
        pattern: "(a+)+$",
        category: "style",
        severity: "low",
        message: "nope",
        suggestion: "nope",
        enabled: true,
      },
    ],
  });
  const started = Date.now();
  const risky2 = __test__.reviewLines(["a".repeat(46) + "!", "const a = 1;"], "s.ts", redosCfg);
  const elapsed = Date.now() - started;
  check(
    "a ReDoS custom rule neither hangs nor fires (CR-7)",
    elapsed < 1000 && !risky2.some((f) => f.ruleId === "redos"),
    `${elapsed}ms`,
  );

  // CR-7: only the first MAX_PATTERN_SCAN_CHARS of a line are scanned.
  const needleCfg = __test__.resolveConfig({
    customRules: [
      {
        id: "needle",
        name: "Needle",
        pattern: "needle",
        category: "style",
        severity: "low",
        message: "found needle",
        suggestion: "remove it",
        enabled: true,
      },
    ],
  });
  const near = __test__.reviewLines(["const shortLineNeedle = 1; // needle"], "s.ts", needleCfg);
  const far = __test__.reviewLines(["x".repeat(3000) + "needle"], "s.ts", needleCfg);
  check("a user pattern sees the start of a long line (CR-7)", near.some((f) => f.ruleId === "needle"));
  check("a user pattern is budgeted to the scan window (CR-7)", !far.some((f) => f.ruleId === "needle"));
}

// ------------------------------------------- CR-16: focusAreas filters
{
  const source = [
    "eval(userInput);",
    "const rows = await db.query(sql);",
    "for (let n = 0; n < 10; n++) { const re = new RegExp('x' + n); }",
  ];
  const securityOnly = __test__.resolveConfig({ focusAreas: ["security"] });
  check("focusAreas parses from options (CR-16)", securityOnly.focusAreas.join(",") === "security");

  const fileHits = __test__.reviewLines(source, "s.ts", securityOnly);
  check(
    "focusAreas filters the file review path (CR-16)",
    fileHits.length > 0 && fileHits.every((f) => f.category === "security"),
    [...new Set(fileHits.map((f) => f.category))].join(","),
  );
  check("eval is still reported under a security focus (CR-16)", fileHits.some((f) => f.ruleId === "EVAL_USAGE"));

  const diff = [
    "--- a/s.ts",
    "+++ b/s.ts",
    "@@ -0,0 +1,3 @@",
    "+eval(userInput);",
    "+const rows = await db.query(sql);",
    "+for (let n = 0; n < 10; n++) { const re = new RegExp('x' + n); }",
    "",
  ].join("\n");
  const diffHits = __test__.reviewDiff(diff, securityOnly);
  check(
    "focusAreas filters the diff review path too (CR-16)",
    diffHits.length > 0 && diffHits.every((f) => f.category === "security"),
    [...new Set(diffHits.map((f) => f.category))].join(","),
  );

  const unfocused = __test__.resolveConfig({
    focusAreas: ["security"],
    customRules: [
      {
        id: "perf-rule",
        name: "Perf rule",
        pattern: "RegExp",
        category: "performance",
        severity: "high",
        message: "out of focus",
        suggestion: "-",
        enabled: true,
      },
    ],
  });
  check(
    "a custom rule outside the focus area is skipped (CR-16)",
    !__test__.reviewLines(source, "s.ts", unfocused).some((f) => f.ruleId === "perf-rule"),
  );

  const all = __test__.resolveConfig({});
  check(
    "no focus areas keeps every category (CR-16)",
    new Set(__test__.buildRules(all).map((r) => r.category)).size === 4,
  );
}

// ------------------------------------------- CR-8: size guard
{
  const bigPath = join(sandbox, "huge.json");
  writeFileSync(bigPath, JSON.stringify({ blob: "y".repeat(1024 * 1024 + 64 * 1024) }));
  const skipped = [];
  const hits = __test__.reviewFile(bigPath, cfg, undefined, [], skipped);
  check("an oversized file is skipped, not parsed (CR-8)", hits.length === 0);
  check("the skip is reported with its size (CR-8)", skipped.length === 1 && /MB/.test(skipped[0]), skipped.join("; "));

  const project = join(sandbox, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "bad.ts"), "eval(userInput);\n");
  writeFileSync(join(project, "huge.md"), "z".repeat(1024 * 1024 + 64 * 1024));
  const result = __test__.reviewProject(project, cfg);
  check(
    "a project review reports the files it refused to read (CR-8)",
    (result.skipped ?? []).some((s) => s.includes("huge.md")) && result.findings.some((f) => f.file.endsWith("bad.ts")),
    JSON.stringify(result.skipped),
  );
  const rendered = __test__.formatReviewResult(result, "Project");
  check("the rendered report shows the skipped section (CR-8)", /Skipped/.test(rendered));

  // Regexes are compiled per identifier now, not per declaration×line pair.
  const many = [];
  for (let i = 0; i < 2000; i++) many.push(`  const v${i} = compute(${i});`);
  const t0 = Date.now();
  __test__.reviewLines(many, "bulk.ts", cfg);
  const took = Date.now() - t0;
  check("scanning 2000 declarations stays fast (CR-8)", took < 3000, `${took}ms`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
