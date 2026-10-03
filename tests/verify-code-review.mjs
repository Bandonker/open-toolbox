/**
 * Mock-context verification for the code-review plugin.
 *
 * Runs the real plugin source against a stub context (no opencode server) and
 * exercises file review, diff review, history, search, and stats against a
 * throwaway SQLite database.
 *
 *   node tests/verify-code-review.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin resolves its database under os.homedir() at import time. Point
// that at a throwaway sandbox so this never touches the real code-review DB.
const sandbox = join(tmpdir(), "opencode-toolbox-verify-code-review-home");
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
check("code-review exposes a default plugin", mod.default.id === "code-review" && typeof mod.default.setup === "function");

const tools = {};
const toolCtx = { sessionID: "ses_cr", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} };

await mod.default.setup({
  options: {},
  location: { directory: join(sandbox, "project") },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => { tools[t.name] = t; } });
      return { dispose: async () => {} };
    },
  },
});

const expectedTools = ["code_review_file", "code_review_diff", "code_review_history", "code_review_get", "code_review_search", "code_review_stats", "code_review_config", "code_review_trends", "code_review_fix", "code_review_custom_rules"];
check("registers all code-review tools", expectedTools.every((n) => typeof tools[n]?.execute === "function"));

const run = (name, args) => tools[name].execute(args, toolCtx);
const idOf = (content) => Number(/#(\d+)/.exec(content ?? "")?.[1]);

// ------------------------------------------------------- review a file
const testFile = join(sandbox, "test.ts");
writeFileSync(testFile, [
  "export function hello(name: string) {",
  "  console.log('Hello, ' + name);",
  "  // TODO: add proper logging",
  "  const x: any = name;",
  "  eval(x);",
  "  return x;",
  "}",
].join("\n"));

const fileReview = await run("code_review_file", { path: testFile });
const fileId = idOf(fileReview.content);
check("code_review_file inserts and returns an id", Number.isInteger(fileId) && fileId > 0 && /Reviewed/.test(fileReview.content), fileReview.content);
check("code_review_file detects issues", /finding/i.test(fileReview.content), fileReview.content);

// ------------------------------------------------------- review a diff
const diffContent = [
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,5 @@",
  "+ const password = 'hardcoded123';",
  "+ element.innerHTML = userInput;",
  "+ // FIXME: sanitize input",
  "  export function login() {",
  "    // TODO: implement",
  "  }",
].join("\n");

const diffReview = await run("code_review_diff", { diff: diffContent });
const diffId = idOf(diffReview.content);
check("code_review_diff inserts and returns an id", Number.isInteger(diffId) && diffId > 0 && /Reviewed/.test(diffReview.content), diffReview.content);
check("code_review_diff detects issues", /finding/i.test(diffReview.content), diffReview.content);

// ------------------------------------------------------- history
const history = await run("code_review_history", {});
check("code_review_history returns reviews", history.content.includes(`#${fileId}`) && history.content.includes(`#${diffId}`), history.content);

const historyFiltered = await run("code_review_history", { severity: "high" });
check("code_review_history filters by severity", historyFiltered.content.length > 0, historyFiltered.content.slice(0, 100));

// ------------------------------------------------------- get by id
const got = await run("code_review_get", { id: fileId });
check("code_review_get returns the review", got.content.includes(`#${fileId}`) && /test\.ts/.test(got.content), got.content);

const notFound = await run("code_review_get", { id: 99999 });
check("code_review_get returns not found for missing id", /not found/i.test(notFound.content), notFound.content);

// ------------------------------------------------------- search
const search = await run("code_review_search", { query: "console.log" });
check("code_review_search finds reviews by content", search.content.includes(`#${fileId}`), search.content);

const searchEmpty = await run("code_review_search", { query: "nonexistentterm" });
check("code_review_search returns empty for no matches", /No reviews found/.test(searchEmpty.content), searchEmpty.content);

// ------------------------------------------------------- stats
const stats = await run("code_review_stats", {});
check("code_review_stats returns a string with totals", typeof stats.content === "string" && /findings/.test(stats.content), stats.content.split("\n")[0]);
check("code_review_stats shows severity breakdown", /By Severity/.test(stats.content), stats.content);

// ------------------------------------------------------- config
const config = await run("code_review_config", {});
check("code_review_config returns db path", typeof config.content === "string" && /db:/.test(config.content), config.content.split("\n")[0]);

// ------------------------------------------------------- trends
const trends = await run("code_review_trends", {});
check("code_review_trends returns trend data", typeof trends.content === "string" && /Trend/.test(trends.content), trends.content.split("\n")[0]);

// ------------------------------------------------------- fix
const fix = await run("code_review_fix", { reviewId: fileId });
check("code_review_fix returns auto-fixes", typeof fix.content === "string" && /Auto-Fixes/.test(fix.content), fix.content.split("\n")[0]);

// ------------------------------------------------------- custom rules
const customRule = await run("code_review_custom_rules", {
  action: "add",
  name: "Test Rule",
  pattern: "TODO",
  category: "style",
  severity: "low",
  message: "Found TODO",
  suggestion: "Remove TODO",
});
check("code_review_custom_rules adds a rule", /added/.test(customRule.content), customRule.content);

const listRules = await run("code_review_custom_rules", { action: "list" });
check("code_review_custom_rules lists rules", /Test Rule/.test(listRules.content), listRules.content);

// CR-2: a rule saved through the tool must actually be applied by later reviews
// (it used to be stored and listed, then never read by the scanner again).
const ruleTarget = join(sandbox, "rule-target.ts");
writeFileSync(ruleTarget, ["export function go() {", "  FIXME();", "  return 1;", "}", ""].join("\n"));
const beforeRule = await run("code_review_file", { path: ruleTarget });
check("an unstored pattern cannot match a review (CR-2)", !/FIXME must go/.test(beforeRule.content));

await run("code_review_custom_rules", {
  action: "add",
  name: "No FIXME",
  pattern: "FIXME\\(\\)",
  category: "style",
  severity: "medium",
  message: "FIXME must go",
  suggestion: "Fix it instead of marking it",
});
const afterRule = await run("code_review_file", { path: ruleTarget });
check("a stored custom rule fires in later file reviews (CR-2)", /FIXME must go/.test(afterRule.content), afterRule.content.split("\n").slice(0, 6).join(" | "));

// CR-7: an invalid pattern is refused up front instead of silently never matching.
const badRule = await run("code_review_custom_rules", {
  action: "add",
  name: "Broken",
  pattern: "(unclosed",
  category: "style",
  severity: "medium",
});
check("an invalid custom-rule pattern is rejected (CR-7)", /Rejected/.test(badRule.content), badRule.content);

// formatAge guard: history rows are keyed by review id, so the assertion holds
// whatever lib/format.ts renders for the age column.
const historyRows = history.content.split("\n").filter((l) => /^\s+#\d+/.test(l));
check(
  "history rows are id-anchored, independent of formatAge (CR-15)",
  historyRows.length >= 2 && historyRows.every((l) => /#\d+.*files, \d+ findings/.test(l)),
  historyRows.join(" | "),
);

// Best effort: the SQLite handle stays open, so a locked file may survive rm.
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
