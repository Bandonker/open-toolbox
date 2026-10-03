/**
 * Regression checks for storage, paths, model reporting and child waits in the
 * code-review plugin.
 *
 * Covers CR-4 (write/read results checked, no phantom success), CR-5 (ESM
 * backups), CR-6 (paths resolved/keyed against the project dir), CR-9 (direct
 * mode waits for a finished child), CR-15 (latest/previous by id), CR-17 (real
 * cost for a pinned model) and CR-11/CR-16 dead code that must stay deleted.
 *
 *   node tests/verify-cr-fix-store.mjs
 */
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-cr-fix-store-home");
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

// A project dir that is NOT the process cwd: relative arguments must resolve
// against the project, which is exactly what CR-6 broke.
const project = join(sandbox, "project");
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "src", "a.ts"), ["eval(userInput);", "const apiKey = 'sk-live-abcdefghij012345';"].join("\n"));
process.chdir(sandbox);

const tools = {};
await mod.default.setup({
  options: {},
  location: { directory: project },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => { tools[t.name] = t; } });
      return { dispose: async () => {} };
    },
  },
});
const run = (name, args) =>
  tools[name].execute(args, { sessionID: "ses_store", agent: "build", messageID: "m", id: "c", progress: async () => {} });

// ------------------------------------------- CR-6: paths
{
  check("resolveTarget joins a relative path to the project (CR-6)", __test__.resolveTarget(project, "src/a.ts") === join(project, "src", "a.ts"));
  check("resolveTarget leaves absolute paths alone (CR-6)", __test__.resolveTarget(project, "/tmp/x.ts") === "/tmp/x.ts");
  check("toStoredPath relativizes inside the project (CR-6)", __test__.toStoredPath(project, join(project, "src", "a.ts")) === "src/a.ts");
  check("toStoredPath keeps paths outside the project absolute (CR-6)", __test__.toStoredPath(project, "/etc/passwd") === "/etc/passwd");
  check("toStoredPath leaves already-relative diff paths alone (CR-6)", __test__.toStoredPath(project, "src/auth.ts") === "src/auth.ts");

  const relative = await run("code_review_file", { path: "src/a.ts" });
  check(
    "a relative file argument is reviewed, not 'File not found' (CR-6)",
    /Reviewed/.test(relative.content) && /eval/i.test(relative.content),
    relative.content.split("\n")[0],
  );
  const reviewId = Number(/#(\d+)/.exec(relative.content)?.[1]);
  check("the relative review is stored with an id (CR-4)", Number.isInteger(reviewId) && reviewId > 0, relative.content.split("\n")[0]);
  const stored = await __test__.loadReviewFindings(reviewId);
  check(
    "its findings are stored relative to the project (CR-6)",
    stored.length > 0 && stored.every((f) => f.file === "src/a.ts"),
    JSON.stringify(stored.map((f) => f.file)),
  );

  const outside = await run("code_review_project", { path: "." });
  check(
    "a project review keys its findings the same way (CR-6)",
    /Reviewed/.test(outside.content) && !/### Skipped/.test(outside.content),
    outside.content.split("\n")[0],
  );
}

// ------------------------------------------- CR-4: store outcome is reported
{
  const outcome = await __test__.storeReview(
    {
      findings: [
        {
          file: "src/a.ts",
          line: 1,
          severity: "high",
          category: "security",
          message: "manual probe",
          suggestion: "-",
          confidence: 0.9,
          ruleId: "PROBE",
        },
      ],
      filesReviewed: 1,
      durationMs: 0,
    },
    __test__.reviewSummary({ findings: [], filesReviewed: 1, durationMs: 0 }),
  );
  check(
    "storeReview yields an id and no error on success (CR-4)",
    outcome.reviewId !== null && !outcome.error && outcome.reviewId > 0,
    JSON.stringify(outcome),
  );
  const missing = await __test__.loadReviewFindings(9_999_999);
  check("reading an unknown review is an empty list, not a string (CR-4)", Array.isArray(missing) && missing.length === 0);
}

// ------------------------------------------- CR-15: latest/previous by id
{
  // Two reviews inside one frozen millisecond: `ORDER BY created_at DESC`
  // cannot order them, `ORDER BY id DESC` can.
  const RealDate = Date;
  const frozen = new RealDate("2026-10-01T00:00:00.000Z").getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen);
      else super(...args);
    }
    static now() {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate;
  const probe = { findings: [], filesReviewed: 1, durationMs: 0 };
  const first = await __test__.storeReview(probe, "tie A");
  const second = await __test__.storeReview(probe, "tie B");
  globalThis.Date = RealDate;

  const history = await run("code_review_history", { limit: 10 });
  const order = [...history.content.matchAll(/#(\d+)\s/g)].map((m) => Number(m[1]));
  check(
    "tied timestamps cannot flip the history order (CR-15)",
    order.indexOf(second.reviewId) === 0 && order.indexOf(first.reviewId) === 1,
    JSON.stringify(order),
  );

  const trends = await run("code_review_trends", {});
  check(
    "the trend compares two different reviews, not one against itself (CR-15)",
    /Trend/.test(trends.content) && !/0 → 0/.test(trends.content),
    trends.content.split("\n").slice(0, 3).join(" | "),
  );
}

// ------------------------------------------- CR-5: backups really happen
{
  const backupDir = join(sandbox, ".opencode-plugins", "code-review", "backups");
  const files = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith(".db")) : [];
  check("a database backup is produced by the first write (CR-5)", files.length >= 1, JSON.stringify(files));
}

// ------------------------------------------- CR-17: pinned model cost
{
  const modelList = [
    { providerID: "opencode-go", modelID: "free-go", cost: { input: 0, output: 0 } },
    { providerID: "acme", modelID: "smart", cost: { input: 3, output: 15 } },
  ];
  const modelCtx = { model: { list: async () => ({ data: modelList }) } };

  const auto = await __test__.resolveAgentModels(modelCtx, cfg);
  check(
    "an auto-selected free model is still described as free (CR-17)",
    /free model opencode-go\/free-go \(cost \$0\)/.test(auto.note),
    auto.note,
  );

  const pinnedPaid = await __test__.resolveAgentModels(modelCtx, __test__.resolveConfig({ fixModel: "acme/smart" }));
  check(
    "a pinned paid model reports its real fetched cost (CR-17)",
    /pinned model acme\/smart/.test(pinnedPaid.note) && /\$3\/\$15/.test(pinnedPaid.note) && !/cost \$0/.test(pinnedPaid.note),
    pinnedPaid.note,
  );

  const unknown = await __test__.resolveAgentModels(modelCtx, __test__.resolveConfig({ fixModel: "acme/ghost" }));
  check(
    "an unverifiable pinned model says so instead of claiming free (CR-17)",
    /pinned model acme\/ghost \(cost not verified\)/.test(unknown.note),
    unknown.note,
  );
}

// ------------------------------------------- CR-9: waiting for a child
{
  let polls = 0;
  const growing = {
    context: async () => {
      polls++;
      const n = Math.min(polls, 5);
      return [{ type: "assistant", content: [{ type: "text", text: `chunk `.repeat(n) }] }];
    },
  };
  const text = await __test__.waitForChildText(growing, "ses_child", 4000, 10);
  check(
    "one unchanged snapshot no longer ends the wait (CR-9)",
    text === "chunk chunk chunk chunk chunk",
    `${JSON.stringify(text)} after ${polls} polls`,
  );

  const started = Date.now();
  const idleApi = {
    context: async () => [{ type: "assistant", content: [{ type: "text", text: "final report" }] }],
    status: async () => ({ type: "idle" }),
  };
  const idleText = await __test__.waitForChildText(idleApi, "ses_child", 60000, 10);
  check(
    "an idle child ends the wait at once with its full text (CR-9)",
    idleText === "final report" && Date.now() - started < 5000,
    `${idleText} in ${Date.now() - started}ms`,
  );

  const sentinel = {
    context: async () => [{ type: "assistant", content: [{ type: "text", text: `done reading\n[[REVIEW_DONE]]` }] }],
  };
  const clean = await __test__.waitForChildText(sentinel, "ses_child", 4000, 10);
  check("the reviewer sentinel still short-circuits (CR-9)", clean === "done reading", JSON.stringify(clean));

  let n = 0;
  const forever = {
    context: async () => {
      n++;
      return [{ type: "assistant", content: [{ type: "text", text: `grow ${n}` }] }];
    },
  };
  const deadlineStart = Date.now();
  const partial = await __test__.waitForChildText(forever, "ses_child", 150, 10);
  check(
    "the deadline is honored and the last text is returned (CR-9)",
    Date.now() - deadlineStart < 2000 && /^grow \d+$/.test(partial),
    `${partial} in ${Date.now() - deadlineStart}ms`,
  );

  check(
    "childLooksIdle understands the shapes a host may return (CR-9)",
    __test__.childLooksIdle({ status: "idle" }) && __test__.childLooksIdle("completed") && !__test__.childLooksIdle({ type: "busy" }),
  );
}

// ------------------------------------------- CR-11 / CR-16: dead code stays gone
{
  const src = readFileSync(new URL("../plugins/code-review.ts", import.meta.url), "utf-8");
  // Comments deliberately name the dead code they removed, so grep the code only.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  check("no dynamic .ts imports remain in the plugin (CR-11)", !/import\(\s*["'`]\.{1,2}\/[^"'`]*\.ts["'`]\s*\)/.test(code));
  check("no reach-through into peer plugins remains (CR-11)", !/integrateWith|__test__\.(remember|save)|await import\(/.test(code));
  // CR-11: the one-shot "not wired" console.debug was removed along with the
  // reach-through it announced. The guarantee is now structural — the plugin
  // must contain no peer-integration call sites at all — asserted by the two
  // checks above rather than by a magic string inside a debug message.
  check("the peer-integration notice is gone (CR-11)", !/not wired/.test(code));
  check("the dead fix_tracking schema is gone (CR-16)", !/CREATE TABLE IF NOT EXISTS fix_tracking/.test(code));
  check("every statement stays parameterized (SQL)", !/query\(\s*[`"'][^`"']*`\s*\+\s*/.test(code));
}

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* the sqlite handle may keep the file alive */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
