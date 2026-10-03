/**
 * waitForChildText regression test (CR-9).
 *
 *   node tests/verify-wait-child-live.mjs
 *
 * Imports the REAL exported waitForChildText and drives it against the
 * verbatim final message produced by a real free-model run
 * (opencode-go/space-bunny-free), stubbing only the session API.
 *
 * The fixture is a real transcript because the truncation bug this guards
 * against is specifically about real replies: a reviewer that pauses
 * mid-thought looks identical to one that has finished, and the pause case
 * is what the signal ordering exists to handle.
 */
const mod = await import(new URL("../plugins/code-review.ts", import.meta.url));
const { waitForChildText } = mod.__test__;

// Verbatim final_message from a real opencode-go/space-bunny-free run.
const REAL_FINAL = `One sentence of findings: The only bug is that \`avg([])\` divides0 by 0 and returns \`NaN\` instead of erroring or returning a defined empty-set value — the loop and summation itself is correct.

Bugs found: 1

[[REVIEW_DONE]]`;

const assistant = (text) => [{ type: "assistant", content: [{ type: "text", text }] }];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

/** api whose context() replays a scripted timeline of transcripts. */
function scriptedApi(timeline, { status = null } = {}) {
  let i = 0;
  const api = {
    context: async () => {
      const frame = timeline[Math.min(i, timeline.length - 1)];
      i += 1;
      return assistant(frame);
    },
  };
  if (status) api.status = async () => status;
  return api;
}

/* 1. Sentinel in the first frame: immediate return, sentinel stripped. */
{
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi([REAL_FINAL]), "s1", 30_000);
  const ms = Date.now() - t0;
  check("sentinel returns the reply without the sentinel line", out.includes("Bugs found: 1") && !out.includes("[[REVIEW_DONE]]"), `${ms}ms`);
  check("sentinel path does not pay a 4s tick", ms < 1500, `${ms}ms`);
}

/* 2. Growing text, then the sentinel. The partial is a dangling clause so
      looksFinished() is false and only the sentinel can end the wait. */
{
  const partial = "One sentence of findings: the only bug is that `avg([])` divides 0 by";
  const api = scriptedApi([partial, partial, partial, partial, REAL_FINAL]);
  const t0 = Date.now();
  const out = await waitForChildText(api, "s2", 30_000);
  const ms = Date.now() - t0;
  check("completes once the sentinel arrives", out.includes("Bugs found: 1"), `${ms}ms`);
  // The old fixed 4s tick needed 5 polls x 4s = 20s to reach this frame;
  // backoff reaches it in 250+500+1000+2000+4000 = 7.75s.
  check("backoff beats the old fixed 4s tick on the same 5-poll path", ms < 10_000, `${ms}ms vs 20000ms fixed`);
}

/* 3. THE REGRESSION. Text is stable AND ends in a period, which is exactly
      what would have exited under the old ordering (stability was tested
      before status). A busy child must not be taken at its word. */
{
  const paused = "The only bug is that `avg([])` divides 0 by 0 and returns NaN.";
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi([paused], { status: { status: "busy" } }), "s3", 4_000);
  const ms = Date.now() - t0;
  check("busy child is not returned early even when its text looks finished", ms >= 3_800, `waited ${ms}ms`);
  check("busy child still yields its last text at the deadline", out.includes("avg([])"), `${ms}ms`);
}

/* 3b. Same text, no status API: the fallback SHOULD fire. The pair 3/3b
       isolates the host's status as the only difference. */
{
  const same = "The only bug is that `avg([])` divides 0 by 0 and returns NaN.";
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi([same]), "s3b", 10_000);
  const ms = Date.now() - t0;
  check("statusless host exits early on the identical text", ms < 3_000, `${ms}ms`);
  check("statusless exit returns the same text", out === same, JSON.stringify(out));
}

/* 4. Statusless host, unterminated text: a thinking pause looks like this, so
      stability alone must not be enough. */
{
  const t0 = Date.now();
  await waitForChildText(scriptedApi(["chunk chunk chunk chunk chunk"]), "s4", 3_000);
  const ms = Date.now() - t0;
  check("statusless host does not exit on unterminated stable text", ms >= 2_800, `waited ${ms}ms`);
}

/* 5. Statusless host, terminated text: the fallback should fire promptly. */
{
  const finished = "The loop and summation are correct. Bugs found: 1.";
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi([finished]), "s5", 10_000);
  const ms = Date.now() - t0;
  check("statusless host exits on stable, finished-looking text", out.includes("Bugs found: 1"), `${ms}ms`);
  check("fallback fires well before the deadline", ms < 6_000, `${ms}ms`);
}

/* 6. Idle status is honoured without needing the sentinel. */
{
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi(["Still writing the review, not the end"], { status: { status: "idle" } }), "s6", 30_000);
  const ms = Date.now() - t0;
  check("idle status ends the wait", out.includes("Still writing"), `${ms}ms`);
  check("idle status path is quick", ms < 2000, `${ms}ms`);
}

/* 7. Transient context() errors must not crash the wait or exit early. */
{
  let n = 0;
  const api = {
    context: async () => {
      n += 1;
      if (n < 3) throw new Error("transient");
      return assistant(REAL_FINAL);
    },
  };
  const out = await waitForChildText(api, "s7", 30_000);
  check("survives transient context() errors", out.includes("Bugs found: 1"));
}

/* 8. The sentinel outranks a busy status (signals ranked by strength). */
{
  const t0 = Date.now();
  const out = await waitForChildText(scriptedApi([REAL_FINAL], { status: { status: "busy" } }), "s8", 30_000);
  const ms = Date.now() - t0;
  check("sentinel outranks a busy status", out.includes("Bugs found: 1") && ms < 1500, `${ms}ms`);
}

/* 9. No context API at all: empty string, no throw. */
{
  const out = await waitForChildText({}, "s9", 5_000);
  check("missing context API returns an empty string", out === "");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);