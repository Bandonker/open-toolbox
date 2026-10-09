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
const tools = {};
const ctx = {
  options: {},
  location: { directory: sandbox },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => { disposed += 1; } };
    },
  },
  tool: {
    transform: async (cb) => {
      cb({ add: (def) => {
        tools[def.name] = def;
        return { dispose: async () => { delete tools[def.name]; } };
      } });
      return { dispose: async () => {} };
    },
  },
};

const cleanup = await mod.default.setup(ctx);
check("registers an http.response hook", typeof hooks["http.response"] === "function");
check("registers a retry hook", typeof hooks["retry"] === "function");

const encoder = new TextEncoder();

function sse(chunks, contentType = "text/event-stream") {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": contentType } });
}

/**
 * A body that delivers every chunk and then kills the socket mid-stream: the
 * next pull errors instead of closing. That is the shape that leaves a turn
 * with finish:null, because flush() never runs on an errored stream.
 */
function sseThenDie(chunks, contentType = "text/event-stream") {
  let next = 0;
  let died = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (died) return;
      if (next < chunks.length) {
        controller.enqueue(encoder.encode(chunks[next++]));
        return;
      }
      died = true;
      controller.error(new Error("terminated"));
    },
  });
  return new Response(stream, { headers: { "content-type": contentType } });
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

/** The {index, reason} of every chunk that still carries a finish reason. */
function finishEntries(body) {
  const out = [];
  for (const payload of payloads(body)) {
    if (payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    for (const choice of choices) {
      if (choice && typeof choice === "object" && choice.finish_reason) {
        out.push({ index: choice.index, reason: choice.finish_reason });
      }
    }
  }
  return out;
}

/** Per-event shape classification, so ordering can be asserted. */
function eventKinds(body) {
  return payloads(body).map((payload) => {
    if (payload === "[DONE]") return "done";
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return "other";
    }
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    const finish = choices.some((c) => c && typeof c === "object" && c.finish_reason);
    const delta = choices.some(
      (c) => c && typeof c === "object" && c.delta && Object.keys(c.delta).length > 0,
    );
    return finish ? "finish" : delta ? "delta" : "other";
  });
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

// Case 2b (FG-1): n > 1 choices. The transform used to remember ONE finish
// reason and flush it as `index: 0`, so every other choice lost its own finish
// reason (and the wrong choice got one). Each stripped index must be flushed.
{
  const { body } = await drive([
    dataChunk({ id: "m", choices: [{ index: 0, delta: { content: "a0" } }, { index: 1, delta: { content: "b0" } }] }),
    dataChunk({ id: "m", choices: [{ index: 0, delta: { content: "a1" }, finish_reason: "stop" }] }),
    dataChunk({ id: "m", choices: [{ index: 1, delta: { content: "b1" }, finish_reason: "tool_calls" }] }),
    dataChunk({ id: "m", choices: [{ index: 0, delta: { reasoning_content: "late thought" } }] }),
    "data: [DONE]\n\n",
  ]);
  check("FG-1 multi-choice keeps every choice's content", ["a0", "a1", "b0", "b1"].every((t) => body.includes(t)), body);
  const entries = finishEntries(body);
  check(
    "FG-1 one finish entry is emitted per stripped choice index",
    JSON.stringify(entries) === JSON.stringify([{ index: 0, reason: "stop" }, { index: 1, reason: "tool_calls" }]),
    JSON.stringify(entries),
  );
  const kinds = eventKinds(body);
  const lastFinish = kinds.lastIndexOf("finish");
  const lastDelta = kinds.lastIndexOf("delta");
  check("FG-1 multi-choice finishes come after all content", lastFinish > lastDelta, JSON.stringify(kinds));
  check(
    "FG-1 the finish entries are the last events before [DONE]",
    kinds.slice(lastFinish).every((k, i) => (i === kinds.slice(lastFinish).length - 1 ? k === "done" : k === "finish")),
    JSON.stringify(kinds),
  );
}

// Case 2c (FG-1): only the choice at index 1 ever carried a finish reason. It
// must be flushed as index 1 — the old hardcoded index terminated the wrong
// choice and left the real one unterminated.
{
  const { body } = await drive([
    dataChunk({ id: "n", choices: [{ index: 0, delta: { content: "a0" } }, { index: 1, delta: { content: "b0" } }] }),
    dataChunk({ id: "n", choices: [{ index: 1, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const entries = finishEntries(body);
  check("FG-1 a lone index-1 finish keeps its index", JSON.stringify(entries) === JSON.stringify([{ index: 1, reason: "tool_calls" }]), JSON.stringify(entries));
  check("FG-1 no phantom finish is invented for index 0", body.includes('"a0"') && body.includes('"b0"'), body);
}

// Case 2d (FG-2): the gateway streams tool call argument fragments
// that carry neither `id` nor `function.name`, and the start delta
// (the chunk that carries them) arrives late. The fragments must be
// buffered and flushed as one consolidated delta with the identity,
// before the finish reason.
{
  const { body } = await drive([
    dataChunk({ id: "t", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, function: { arguments: '{"command": ' } }] } }] }),
    dataChunk({ id: "t", choices: [{ index: 0, delta: { content: null, tool_calls: [{ index: 0, function: { arguments: '"ls"' } }] } }] }),
    dataChunk({ id: "t", choices: [{ index: 0, delta: { content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: " }" } }] } }] }),
    dataChunk({ id: "t", choices: [{ index: 0, delta: { content: null, tool_calls: [{ index: 0, function: { arguments: "" } }] } }] }),
    dataChunk({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const events = payloads(body).filter((p) => p !== "[DONE]").map((p) => {
    try { return JSON.parse(p); } catch { return null; }
  }).filter(Boolean);
  const toolChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls);
  check("FG-2 the first tool_calls chunk carries id and name",
    toolChunks.length > 0 && toolChunks[0].choices[0].delta.tool_calls[0].id === "call_1" &&
    toolChunks[0].choices[0].delta.tool_calls[0].function.name === "shell",
    JSON.stringify(toolChunks));
  check("FG-2 buffered arguments are consolidated into the flushed delta",
    toolChunks[0].choices[0].delta.tool_calls[0].function.arguments === '{"command": "ls" }',
    JSON.stringify(toolChunks));
  const finishIdx = events.findIndex((e) => e.choices?.[0]?.finish_reason);
  const lastToolIdx = events.length - 1 - [...events].reverse().findIndex((e) => e.choices?.[0]?.delta?.tool_calls);
  check("FG-2 tool call is flushed before the finish reason", finishIdx > lastToolIdx, JSON.stringify(events));
}

// Case 2e (FG-2): the start delta never arrives at all — every
// fragment lacks `id` and `function.name`. The buffered call is
// flushed before the finish reason with a synthesised id so the
// driver at least sees a well-formed call.
{
  const { body } = await drive([
    dataChunk({ id: "u", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }),
    dataChunk({ id: "u", choices: [{ index: 0, delta: { content: null, tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }),
    dataChunk({ id: "u", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const events = payloads(body).filter((p) => p !== "[DONE]").map((p) => {
    try { return JSON.parse(p); } catch { return null; }
  }).filter(Boolean);
  const toolChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls);
  check("FG-2 a call with no start delta is still flushed before finish",
    toolChunks.length === 1 &&
    toolChunks[0].choices[0].delta.tool_calls[0].function.arguments === '{"a":1}' &&
    typeof toolChunks[0].choices[0].delta.tool_calls[0].id === "string",
    JSON.stringify(toolChunks));
  const finishIdx = events.findIndex((e) => e.choices?.[0]?.finish_reason);
  const toolIdx = events.findIndex((e) => e.choices?.[0]?.delta?.tool_calls);
  check("FG-2 flushed call precedes the finish reason", toolIdx >= 0 && finishIdx > toolIdx, JSON.stringify(events));
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

// Case 3b: a body with no content-type at all. An OpenAI-compatible gateway
// streaming `stream:true` sends SSE, and the SSE transform writes any non-`data:`
// line back verbatim, so it is safe as a fallback even if the body turns out to
// be NDJSON — the alternative is leaving a malformed stream unprotected, which
// is how the killer chunk survives even with the plugin loaded.
{
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "openai-compatible", modelID: "x" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: sse([
      dataChunk({ id: "u", choices: [{ index: 0, delta: { content: "late" }, finish_reason: "stop" }] }),
      dataChunk({ id: "u", choices: [{ index: 0, delta: { reasoning_content: " killer" } }] }),
      "data: [DONE]\n\n",
    ], ""),
  };
  delete event.response.headers.get;
  await hooks["http.response"](event);
  const body = await event.response.text();
  check("unlabelled SSE stream is still normalised", body.includes("late") && body.includes("killer"), body);
  check("the finish reason still lands after the content",
    body.lastIndexOf('"finish_reason"') > body.indexOf("killer"), body);
}

// Case 3c: an NDJSON body left unlabelled is passed through unchanged — the SSE
// fallback is a no-op on it, not a corruption.
{
  const ndjson = [
    `${JSON.stringify({ id: "n", choices: [{ index: 0, delta: { content: "nd" }, finish_reason: "stop" }] })}\n`,
    `${JSON.stringify({ id: "n", choices: [{ index: 0, delta: { content: " after" } }] })}\n`,
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of ndjson) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "openai-compatible", modelID: "x" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: new Response(stream, { headers: { "content-type": "" } }),
  };
  delete event.response.headers.get;
  await hooks["http.response"](event);
  const body = await event.response.text();
  check("unlabelled NDJSON body is not rewritten", body === ndjson.join(""), body);
}

// Case 4: a stream the gateway cut off mid-generation — content arrives but
// no finish reason and no [DONE] ever does. The driver would otherwise be left
// with nothing to terminate on and records finish:null with no token counts,
// which is what a turn that "died with no visible error" looks like in the
// session log. Close it. The truncation is not silently absorbed: it is counted
// in finish_guard_stats and recorded in the capture file, so a gateway that
// keeps truncating stays diagnosable.
{
  const { body } = await drive([
    dataChunk({ id: "c", choices: [{ index: 0, delta: { content: "only" } }] }),
  ]);
  const events = payloads(body).filter((p) => p !== "[DONE]").map((p) => {
    try { return JSON.parse(p); } catch { return null; }
  }).filter(Boolean);
  const finishes = events.filter((e) => e.choices?.[0]?.finish_reason);
  check("truncated stream is closed with a finish reason",
    finishes.length === 1 && finishes[0].choices[0].finish_reason === "stop",
    JSON.stringify(events));
  check("truncated stream ends with [DONE]", body.trimEnd().endsWith("[DONE]"), body);
  check("truncated stream keeps its content", events.some((e) => e.choices?.[0]?.delta?.content === "only"), body);
  check("the invented finish follows the content",
    events.findIndex((e) => e.choices?.[0]?.delta?.content === "only") <
    events.findIndex((e) => e.choices?.[0]?.finish_reason),
    JSON.stringify(events));
  check("the truncation is counted in the stats tool",
    (await tools.finish_guard_stats.execute({})).content.includes('"truncated":1'),
    JSON.stringify(await tools.finish_guard_stats.execute({})));
}

// Case 4b: the socket dies mid-stream. flush() never runs on an errored
// stream, so the truncation synthesis would be skipped unless the upstream error
// is converted to a clean end first — otherwise the driver sees finish:null with
// no token counts and the death is indistinguishable from a turn that simply
// died.
{
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "openai-compatible", modelID: "x" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: sseThenDie([dataChunk({ id: "e", choices: [{ index: 0, delta: { role: "assistant", content: "mid-sentence ans" } }] })]),
  };
  await hooks["http.response"](event);
  let body = "";
  let threw = false;
  try {
    body = await event.response.text();
  } catch {
    threw = true;
  }
  check("a socket that dies mid-stream is not rejected", !threw, threw ? "the body threw" : body);
  check("a socket that dies mid-stream is terminated",
    !threw && /"finish_reason":"stop"/.test(body), body);
  check("a socket that dies mid-stream keeps what arrived",
    !threw && body.includes("mid-sentence ans"), body);
  check("a mid-stream death is counted in the stats tool",
    (await tools.finish_guard_stats.execute({})).content.includes('"truncated":2'),
    "expected truncated=2 across case 4 and 4b");
}

// Case 4c: the NDJSON transform terminates the same way on a mid-stream death.
{
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "openai-compatible", modelID: "x" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: sseThenDie(
      [`${JSON.stringify({ id: "n2", choices: [{ index: 0, delta: { content: "cut off" } }] })}` + "\n"],
      "application/x-ndjson",
    ),
  };
  await hooks["http.response"](event);
  let body = "";
  let threw = false;
  try { body = await event.response.text(); } catch { threw = true; }
  check("NDJSON mid-stream death is terminated", !threw && /"finish_reason":"stop"/.test(body), threw ? "threw" : body);
  check("NDJSON mid-stream death keeps what arrived", !threw && body.includes("cut off"), body);
}

// Case 4d: a body that never sends anything is left as it is — an empty stream
// is not a truncation, and inventing a finish for it would be wrong.
{
  const empty = new ReadableStream({
    start(controller) { controller.close(); },
  });
  const event = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "openai-compatible", modelID: "x" },
    kind: "primary",
    request: new Request("http://127.0.0.1:17321/chat/completions"),
    response: new Response(empty, { headers: { "content-type": "text/event-stream" } }),
  };
  await hooks["http.response"](event);
  const body = await event.response.text();
  check("an empty stream is not given a finish reason", !body.includes("finish_reason") && body === "", JSON.stringify(body));
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
