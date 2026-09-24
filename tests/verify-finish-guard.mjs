/**
 * finish-guard verification.
 *
 * Simulates the provider `session.hook("http.response")` seam and drives SSE
 * bodies shaped like the ones a gateway emits when it sends content after the
 * finish reason. No opencode server is needed.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), "opencode-toolbox-verify-finish-guard");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_FINISH_GUARD_")) delete process.env[key];
}

const mod = await import("../plugins/finish-guard.ts");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

check("plugin exposes id finish-guard", mod.default?.id === "finish-guard");
check("plugin exposes setup", typeof mod.default?.setup === "function");

const hooks = {};
let disposed = 0;
const ctx = {
  options: {},
  location: { directory: sandbox },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => { disposed += 1; } };
    },
  },
};

const cleanup = await mod.default.setup(ctx);
check("registers an http.response hook", typeof hooks["http.response"] === "function");
check("registers a retry hook", typeof hooks["retry"] === "function");

const encoder = new TextEncoder();

function sse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function dataChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function drive(chunks) {
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: sse(chunks),
  };
  const before = event.response;
  await hooks["http.response"](event);
  const body = await event.response.text();
  return { body, replaced: event.response !== before, event };
}

function payloads(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

// Case 1: reasoning content arrives after the finish_reason chunk. The stream
// must be reordered so nothing follows the finish reason.
{
  const { body } = await drive([
    dataChunk({ id: "a", choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }] }),
    dataChunk({ id: "a", choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }] }),
    dataChunk({ id: "a", choices: [{ index: 0, delta: { reasoning_content: "late thought" } }] }),
    "data: [DONE]\n\n",
  ]);
  const events = payloads(body);
  let finishIndex = -1;
  let lateIndex = -1;
  events.forEach((payload, index) => {
    if (payload === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed?.choices?.[0]?.finish_reason) finishIndex = index;
    if (String(payload).includes("late thought")) lateIndex = index;
  });
  check("late reasoning is still delivered", lateIndex >= 0, body);
  check("finish_reason comes after all content", finishIndex > lateIndex, body);
  check("finish_reason is last before [DONE]", finishIndex === events.length - 2 && events[events.length - 1] === "[DONE]", body);
  check("earlier content is preserved", body.includes("hello") && body.includes(" world"));
}

// Case 2: a compliant stream (finish last) keeps one finish reason and all
// content, and still ends with [DONE].
{
  const { body } = await drive([
    dataChunk({ id: "b", choices: [{ index: 0, delta: { content: "one" } }] }),
    dataChunk({ id: "b", choices: [{ index: 0, delta: { content: "two" } }] }),
    dataChunk({ id: "b", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const events = payloads(body);
  const finishes = events.filter((p) => {
    try {
      return Boolean(JSON.parse(p)?.choices?.[0]?.finish_reason);
    } catch {
      return false;
    }
  });
  check("compliant stream keeps exactly one finish reason", finishes.length === 1, body);
  check("compliant stream keeps its content", body.includes("one") && body.includes("two"));
  check("compliant stream still ends with [DONE]", events[events.length - 1] === "[DONE]", body);
}

// Case 3: a non-SSE response is passed through untouched (same object).
{
  const event = {
    sessionID: "ses_test",
    model: { providerID: "opencode-go", modelID: "x" },
    kind: "title",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
  };
  const before = event.response;
  await hooks["http.response"](event);
  check("non-SSE response is left untouched", event.response === before);
}

// Case 4: no finish reason at all is left alone apart from [DONE] replay.
{
  const { body } = await drive([
    dataChunk({ id: "c", choices: [{ index: 0, delta: { content: "only" } }] }),
  ]);
  check("stream without finish reason is not given one", !body.includes('"finish_reason":"stop"'), body);
  check("stream without finish reason keeps its content", body.includes("only"));
}

// Case 5: malformed streams are retried, bounded by the attempt limit.
{
  const retryEvent = (error, attempt, decision) => ({
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
    error,
    attempt,
    decision,
  });

  const late = retryEvent(
    { type: "AI.Error.InvalidProviderOutput", message: "OpenAI Chat received content after the finish reason" },
    0,
    { retry: false },
  );
  await hooks["retry"](late);
  check("late-content error is retried", late.decision?.retry === true && Number.isFinite(late.decision.delay), JSON.stringify(late.decision));

  const unterminated = retryEvent(
    { type: "AI.Error.InvalidProviderOutput", message: "OpenAI Chat stream ended without a finish reason" },
    0,
    { retry: false },
  );
  await hooks["retry"](unterminated);
  check("unterminated-stream error is retried", unterminated.decision?.retry === true, JSON.stringify(unterminated.decision));

  const exhausted = retryEvent(
    { type: "AI.Error.InvalidProviderOutput", message: "OpenAI Chat received content after the finish reason" },
    3,
    { retry: false },
  );
  await hooks["retry"](exhausted);
  check("retry stops at the attempt limit", exhausted.decision?.retry === false);

  const unrelated = retryEvent({ type: "SomeOtherError", message: "rate limited" }, 0, { retry: false });
  await hooks["retry"](unrelated);
  check("unrelated errors are left to opencode", unrelated.decision?.retry === false);

  const already = retryEvent(
    { type: "AI.Error.InvalidProviderOutput", message: "OpenAI Chat received content after the finish reason" },
    0,
    { retry: true, delay: 10 },
  );
  await hooks["retry"](already);
  check("an existing retry decision is not overridden", already.decision?.delay === 10);
}

// Case 6: disabled via options registers no hook.
{
  const disabledHooks = {};
  await mod.default.setup({
    options: { enabled: false },
    location: { directory: sandbox },
    session: { hook: async (name, cb) => { disabledHooks[name] = cb; return { dispose: async () => {} }; } },
  });
  check("disabled plugin registers no hook", Object.keys(disabledHooks).length === 0);
}

// Case 7: the setup cleanup disposes both registrations.
await cleanup();
check("cleanup disposes the hook registrations", disposed === 2, `disposed=${disposed}`);

const failed = results.filter((r) => !r.ok);
console.log(`\nverify-finish-guard: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const r of failed) console.error(`  FAILED: ${r.name}`);
  process.exit(1);
}
console.log("verify-finish-guard: all assertions passed");
assert.ok(true);
