/**
 * Regression checks for the diff side of the code-review plugin.
 *
 * Covers CR-1 (pinned git diff format), CR-13 (hunk parsing: line numbers,
 * `\ No newline`, binary payloads), CR-14 (untracked files, repo with no
 * commits), CR-3 (context-dependent rules inside a hunk) and CR-2 (stored
 * custom rules applied to a diff review).
 *
 *   node tests/verify-cr-fix-diff.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// The plugin resolves its database under os.homedir() at import time.
const sandbox = join(tmpdir(), "opencode-toolbox-verify-cr-fix-diff-home");
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

/** Init a throwaway repo and return a git runner bound to it. */
function gitSetup(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  return run;
}

// ------------------------------------------- CR-1: pinned git diff format
{
  check(
    "git diff command pins color, pager and prefixes (CR-1)",
    /--no-pager/.test(__test__.GIT_DIFF_COMMAND) &&
      /-c color\.ui=false/.test(__test__.GIT_DIFF_COMMAND) &&
      /--no-ext-diff/.test(__test__.GIT_DIFF_COMMAND) &&
      /--no-textconv/.test(__test__.GIT_DIFF_COMMAND) &&
      /--src-prefix=a\/ --dst-prefix=b\//.test(__test__.GIT_DIFF_COMMAND),
    __test__.GIT_DIFF_COMMAND,
  );

  const repo = join(sandbox, "colorrepo");
  const git = gitSetup(repo);
  git("config", "color.ui", "always"); // the exact repro from the finding
  writeFileSync(join(repo, "a.ts"), "export const keep = 1;\n");
  git("add", "a.ts");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const keep = 1;\nexport const apiKey = 'sk-live-abcdef0123456789';\n");

  const { diff } = __test__.collectWorkingTreeDiff(repo);
  check("a colored git config leaks no ANSI escapes into the diff (CR-1)", !/\u001b\[[0-9;]*m/.test(diff));
  check("the diff still carries the a/ b/ headers we parse (CR-1)", diff.includes("+++ b/a.ts"));
  const findings = __test__.reviewDiff(diff, cfg);
  check(
    "a colored repo produces findings, not a silent 'clean' review (CR-1)",
    findings.some((f) => f.file === "a.ts" && /secret|api/i.test(f.message)),
    findings.map((f) => `${f.ruleId}@${f.line}`).join(","),
  );
}

// ------------------------------------------- CR-14: untracked + no-commit repos
{
  const repo = join(sandbox, "untracked");
  gitSetup(repo); // no commit at all: `git diff HEAD` cannot work here
  writeFileSync(join(repo, "clean.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "danger.ts"), "eval(userInput);\n");
  writeFileSync(join(repo, "notes.txt"), "eval(not a source file);\n");

  const { diff, notes } = __test__.collectWorkingTreeDiff(repo);
  check("untracked files are included in a diff review (CR-14)", diff.includes("+++ b/danger.ts"));
  check("untracked non-source files stay out of the review (CR-14)", !diff.includes("notes.txt"));
  check(
    "a repo with no commits is reviewed instead of throwing (CR-14)",
    notes.some((n) => /no commits/i.test(n)),
    notes.join("; "),
  );
  const findings = __test__.reviewDiff(diff, cfg);
  check(
    "an untracked eval is reported on its real line (CR-14)",
    findings.some((f) => f.file === "danger.ts" && f.line === 1 && /eval/i.test(f.message)),
    findings.map((f) => `${f.file}:${f.line}`).join(","),
  );
}

// ------------------------------------------- CR-13: hunk parsing
{
  const noNewline = [
    "diff --git a/x.ts b/x.ts",
    "index 1111111..2222222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+eval(payload)",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const findings = __test__.reviewDiff(noNewline, cfg);
  check(
    "the '\\ No newline' marker no longer shifts line numbers (CR-13)",
    findings.some((f) => f.file === "x.ts" && f.line === 2 && /eval/i.test(f.message)),
    findings.map((f) => `${f.file}:${f.line}`).join(","),
  );

  const binary = [
    "diff --git a/logo.png b/logo.png",
    "index 3333333..4444444 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  check("a binary file diff produces no scanned code (CR-13)", __test__.parseUnifiedDiff(binary).length === 0);

  const gitBinary = [
    "diff --git a/blob.bin b/blob.bin",
    "index 5555555..6666666 100644",
    "GIT binary patch",
    "literal 42",
    "c$cm1_BJ~A9|0174KN0!B;0",
    "eval(y)",
    "",
  ].join("\n");
  check(
    "GIT binary patch payloads are not scanned as source (CR-13)",
    __test__.reviewDiff(gitBinary, cfg).length === 0,
    JSON.stringify(__test__.reviewDiff(gitBinary, cfg)),
  );

  // A hunk whose added content merely *looks* like a header line.
  const tricky = [
    "--- a/y.ts",
    "+++ b/y.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1;",
    "+++ b/not-a-real-file.ts",
    "",
  ].join("\n");
  const parsed = __test__.parseUnifiedDiff(tricky);
  check(
    "added content beginning with '+++' is treated as code, not a header (CR-13)",
    parsed.length === 1 && parsed[0].path === "y.ts",
    JSON.stringify(parsed.map((f) => f.path)),
  );
}

// ------------------------------------------- CR-3: context inside a hunk
{
  const race = [
    "diff --git a/io.ts b/io.ts",
    "--- a/io.ts",
    "+++ b/io.ts",
    "@@ -10,6 +10,7 @@",
    " function copy(p, q) {",
    "   const tmp = p;",
    "+  const data = fs.readFileSync(tmp);",
    "   fs.writeFileSync(q, data);",
    "   return q;",
    " }",
    "",
  ].join("\n");
  const raceIds = __test__.reviewDiff(race, cfg).map((f) => `${f.ruleId}:${f.line}`);
  check(
    "a rule that reads the next line sees the hunk's context lines (CR-3)",
    raceIds.some((id) => id.startsWith("RACE_CONDITION")),
    raceIds.join(","),
  );

  const fallthrough = [
    "diff --git a/sw.ts b/sw.ts",
    "--- a/sw.ts",
    "+++ b/sw.ts",
    "@@ -1,3 +1,5 @@",
    " switch (kind) {",
    '+  case "a":',
    "+    doA();",
    "   default:",
    "     break;",
    " }",
    "",
  ].join("\n");
  const swIds = __test__.reviewDiff(fallthrough, cfg).map((f) => f.ruleId);
  check(
    "a rule needing 15 lines of look-ahead is skipped, not fed one line (CR-3)",
    !swIds.includes("MISSING_BREAK"),
    swIds.join(","),
  );

  const prepared = __test__.buildRules(cfg);
  const byId = new Map(prepared.map((r) => [r.id, r]));
  check(
    "context needs are declared per rule (CR-3)",
    byId.get("MISSING_AWAIT").contextBefore === 1 &&
      byId.get("MISSING_BREAK").contextAfter === 15 &&
      byId.get("UNUSED_VARIABLE").wholeFile === true &&
      byId.get("EVAL_USAGE").contextBefore === 0 &&
      byId.get("EVAL_USAGE").contextAfter === 0,
    JSON.stringify([...byId.values()].filter((r) => r.contextBefore || r.contextAfter || r.wholeFile).map((r) => r.id)),
  );
}

// ------------------------------------------- CR-2: stored rules apply to diffs
const tools = {};
await mod.default.setup({
  options: {},
  location: { directory: sandbox },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => { tools[t.name] = t; } });
      return { dispose: async () => {} };
    },
  },
});

const run = (name, args) => tools[name].execute(args, { sessionID: "ses_cr", agent: "build", messageID: "m", id: "c", progress: async () => {} });

{
  const diff = [
    "--- a/svc.ts",
    "+++ b/svc.ts",
    "@@ -1,2 +1,3 @@",
    " export function go() {",
    "+  legacyForbiddenCall();",
    "   return 1;",
    " }",
    "",
  ].join("\n");

  const before = await run("code_review_diff", { diff });
  check(
    "a diff review ignores a rule that does not exist yet (CR-2)",
    !/legacyForbiddenCall/.test(before.content),
  );

  const added = await run("code_review_custom_rules", {
    action: "add",
    name: "Forbidden call",
    pattern: "legacyForbiddenCall\\(\\)",
    category: "bugs",
    severity: "high",
    message: "Do not call the legacy helper",
    suggestion: "Use the new API",
  });
  const ruleId = /ID: (\S+)/.exec(added.content)?.[1];
  check("a custom rule can be stored (CR-2)", Boolean(ruleId), added.content);

  const after = await run("code_review_diff", { diff });
  check(
    "a stored custom rule fires inside a diff review (CR-2)",
    /Do not call the legacy helper/.test(after.content) && /svc\.ts/.test(after.content),
    after.content.split("\n").slice(0, 12).join(" | "),
  );

  const fileReview = await run("code_review_file", { path: join(sandbox, "svc.ts") });
  void fileReview;
  const merged = await run("code_review_custom_rules", { action: "list" });
  check("the stored rule is listed for reuse (CR-2)", /Forbidden call/.test(merged.content));

  const removed = await run("code_review_custom_rules", { action: "delete", id: ruleId });
  check("deleting a stored rule reports the row it removed (CR-4)", /deleted/.test(removed.content), removed.content);

  const goneDiff = await run("code_review_diff", { diff });
  check(
    "a deleted custom rule stops firing in diffs (CR-2)",
    !/Do not call the legacy helper/.test(goneDiff.content),
  );

  const ghost = await run("code_review_custom_rules", { action: "delete", id: "no-such-rule" });
  check(
    "deleting a nonexistent rule no longer claims success (CR-4)",
    /nothing deleted|No custom rule/i.test(ghost.content),
    ghost.content,
  );
}

// CR-8: maxFindingsPerFile applies to diffs too
{
  const cappedCfg = __test__.resolveConfig({ maxFindingsPerFile: 2 });
  const many = ["--- a/many.ts", "+++ b/many.ts", "@@ -0,0 +1,6 @@", ...Array.from({ length: 6 }, (_, i) => `+eval(bad${i});`)].join("\n");
  const found = __test__.reviewDiff(many, cappedCfg);
  check(
    "maxFindingsPerFile caps a diff's findings per file (CR-8)",
    found.length === 2 && found.every((f) => f.file === "many.ts"),
    String(found.length),
  );
}

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* the sqlite handle may keep the file alive */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
