import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * finish-guard
 *
 * Some OpenAI-compatible providers and local gateways stream a content,
 * reasoning or tool-call delta in a chunk that arrives *after* a chunk which
 * already carried `finish_reason`. opencode's v2 OpenAI-chat driver rejects
 * that as `AI.Error.InvalidProviderOutput: OpenAI Chat received content after
 * the finish reason` and aborts the step, which surfaces as `Failed to drain
 * Session` and can wedge the session.
 *
 * The `session.hook("http.response")` seam exposes the provider `Response`
 * before the driver reads it. This plugin rewrites only SSE
 * (`text/event-stream`) bodies so the finish chunk is held back until the
 * stream ends: every content delta is therefore delivered before the finish
 * reason and a finish chunk closes the stream. Compliant streams are unchanged
 * in effect (their finish chunk is already last), non-SSE bodies are passed
 * through untouched, and any failure here leaves the original response in
 * place.
 *
 * If a provider still aborts a stream mid-flight — an `InvalidProviderOutput`
 * such as "content after the finish reason" or a stream that ends without a
 * finish reason — the `session.hook("retry")` seam asks opencode to retry the
 * request a bounded number of times instead of failing and wedging the session.
 */

type AnyRecord = Record<string, unknown>;

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "") return fallback;
    if (/^(1|true|yes|y|on)$/.test(v)) return true;
    if (/^(0|false|no|n|off)$/.test(v)) return false;
  }
  return fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return fallback;
    n = Number(text);
  } else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isPlainObject(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default Plugin.define({
  id: "finish-guard",
  async setup(ctx) {
    const options = (ctx?.options ?? {}) as AnyRecord;
    const enabled = asBool(options.enabled ?? process.env.OPENCODE_FINISH_GUARD_ENABLED, true);
    const debug = asBool(options.log ?? process.env.OPENCODE_FINISH_GUARD_LOG, false);
    const retry = asBool(options.retry ?? process.env.OPENCODE_FINISH_GUARD_RETRY, true);
    const retryMax = asInt(options.retryMax ?? process.env.OPENCODE_FINISH_GUARD_RETRY_MAX, 3, 0, 10);
    const retryDelayBase = asInt(
      options.retryDelayBase ?? process.env.OPENCODE_FINISH_GUARD_RETRY_DELAY_BASE,
      300,
      1,
      60_000,
    );
    const retryDelayMax = asInt(
      options.retryDelayMax ?? process.env.OPENCODE_FINISH_GUARD_RETRY_DELAY_MAX,
      2000,
      retryDelayBase,
      120_000,
    );
    const log = (message: string): void => {
      if (!debug) return;
      try {
        console.error(`[finish-guard] ${message}`);
      } catch {
        /* logging must never break a request */
      }
    };

    // E58: module-level retry counter — tracks total retries and last retry timestamp.
    const retryMetrics = { retries: 0, lastRetryAt: 0 };
    // A stream that ends with no finish reason was cut off by the gateway
    // mid-generation. That is not a misordering the transform can reorder away,
    // so it is counted and recorded instead — a "died with finish:null and
    // tokens.output:0" turn otherwise leaves no trace at all.
    const truncationMetrics = { truncated: 0, lastTruncatedAt: 0 };

    if (!enabled) return () => {};
    if (typeof ctx?.session?.hook !== "function") return () => {};

    const registrations: Array<{ dispose?: () => unknown }> = [];

    try {
      registrations.push(
        await ctx.session.hook("http.response", (event) => {
          try {
            normaliseResponse(event, log, truncationMetrics);
          } catch (err) {
            log(`response left untouched: ${String(err)}`);
          }
        }),
      );
    } catch (err) {
      log(`http.response hook unavailable; provider streams are not normalised: ${String(err)}`);
    }

    if (retry) {
      try {
        registrations.push(
          await ctx.session.hook("retry", (event) => {
            try {
              applyRetry(event as unknown as AnyRecord, retryMax, retryDelayBase, retryDelayMax, log, retryMetrics);
            } catch (err) {
              log(`retry decision left to opencode: ${String(err)}`);
            }
          }),
        );
      } catch (err) {
        log(`retry hook unavailable; malformed streams are not retried: ${String(err)}`);
      }
    }

    // E61: finish_guard_test tool — runs finishLastTransform on a sample SSE payload.
    try {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "finish_guard_test",
            description:
              "Test the finish-guard SSE transform on a sample payload. Returns the transformed output so users can verify the guard is working.",
            input: z.object({}),
            execute: async () => {
              const sampleSse = [
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                "data: [DONE]",
                "",
              ].join("\n\n");

              const encoder = new TextEncoder();
              const decoder = new TextDecoder();
              const transform = finishLastTransform();
              const writer = transform.writable.getWriter();
              const reader = transform.readable.getReader();

              const chunks = sampleSse.match(/[^\n]+\n\n/g) || [sampleSse];
              for (const chunk of chunks) {
                await writer.write(encoder.encode(chunk));
              }
              await writer.close();

              let result = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                result += decoder.decode(value, { stream: true });
              }
              return { content: result };
            },
          });
        }),
      );
    } catch (err) {
      log(`tool transform unavailable: ${String(err)}`);
    }

    // E58: finish_guard_stats tool — reports retry metrics.
    try {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "finish_guard_stats",
            description:
              "Report finish-guard retry metrics: total retries triggered and the timestamp of the last retry.",
            input: z.object({}),
            execute: async () => {
              return {
                content: JSON.stringify({
                  retries: retryMetrics.retries,
                  lastRetryAt: retryMetrics.lastRetryAt > 0 ? new Date(retryMetrics.lastRetryAt).toISOString() : null,
                  truncated: truncationMetrics.truncated,
                  lastTruncatedAt:
                    truncationMetrics.lastTruncatedAt > 0 ? new Date(truncationMetrics.lastTruncatedAt).toISOString() : null,
                }),
              };
            },
          });
        }),
      );
    } catch (err) {
      log(`tool transform unavailable: ${String(err)}`);
    }

    return async () => {
      for (const registration of registrations) {
        try {
          await registration?.dispose?.();
        } catch {
          /* dispose is best-effort */
        }
      }
    };
  },
});

/**
 * The strict OpenAI-chat driver raises these when a provider stream is
 * malformed: content delivered after the finish reason, or a stream that ends
 * without one. Both are worth a bounded retry — the next stream is normally
 * well-formed.
 */
const RETRY_MATCH = /content after the finish reason|invalidprovideroutput|stream ended without finish_reason|tool call delta is missing id or name/i;

function providerStreamErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isPlainObject(error)) return "";
  const parts: string[] = [];
  for (const key of ["type", "message", "name", "reason", "detail"]) {
    const value = error[key];
    if (typeof value === "string") parts.push(value);
  }
  try {
    parts.push(JSON.stringify(error));
  } catch {
    /* circular errors are matched on their string fields alone */
  }
  return parts.join(" ");
}

function applyRetry(
  event: AnyRecord,
  retryMax: number,
  retryDelayBase: number,
  retryDelayMax: number,
  log: (message: string) => void,
  retryMetrics?: { retries: number; lastRetryAt: number },
): void {
  if (!RETRY_MATCH.test(providerStreamErrorText(event.error))) return;
  const decision = event.decision as { retry?: boolean } | undefined;
  // opencode may already have decided to retry; never shorten an existing one.
  if (decision?.retry === true) return;
  const attempt = typeof event.attempt === "number" && Number.isFinite(event.attempt) ? event.attempt : 0;
  if (attempt >= retryMax) {
    event.decision = { retry: false };
    log(`provider stream error not retried: attempt ${attempt} reached the limit of ${retryMax}`);
    return;
  }
  const delay = Math.min(retryDelayMax, retryDelayBase * Math.max(1, attempt));
  event.decision = { retry: true, delay };
  if (retryMetrics) {
    retryMetrics.retries++;
    retryMetrics.lastRetryAt = Date.now();
  }
  log(`retrying a malformed provider stream (attempt ${attempt + 1} in ${delay}ms)`);
}

function normaliseResponse(
  event: { response: Response },
  log: (message: string) => void,
  metrics?: { truncated: number; lastTruncatedAt: number },
): void {
  const response = event?.response;
  if (!response || typeof response !== "object") return;
  if (!response.body) return;
  // An error or JSON body must reach the driver exactly as the provider sent
  // it; only streaming chat/completions responses carry the ordering bug.
  if (response.ok === false) return;
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (/text\/event-stream/i.test(contentType)) {
    event.response = new Response(response.body.pipeThrough(finishLastTransform(metrics)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    log("held the finish chunk until the end of the stream");
    return;
  }
  // E60: NDJSON (newline-delimited JSON) streaming — same finish-reason
  // reordering as SSE, but each line is a complete JSON object.
  if (/application\/x-ndjson/i.test(contentType)) {
    event.response = new Response(
      response.body.pipeThrough(ndjsonFinishLastTransform(metrics)),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
    log("held the finish chunk until the end of the NDJSON stream");
    return;
  }
  // A body with no content-type at all, or one naming neither known framing.
  // An OpenAI-compatible gateway streaming `stream:true` sends SSE, and the SSE
  // transform writes any non-`data:` line back verbatim — so applying it to a
  // body that turns out to be NDJSON is a no-op, not a corruption. That makes
  // SSE the safe fallback rather than a guess: the alternative is leaving a
  // malformed stream unprotected, which is how the killer chunk survives even
  // with the plugin loaded.
  if (contentType.trim() === "") {
    event.response = new Response(response.body.pipeThrough(finishLastTransform(metrics)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    log("held the finish chunk until the end of the unlabelled stream");
  }
}

/** The SSE field carrying a JSON payload; every other line is passed through. */
const DATA_LINE = /^data:\s?(.*)$/;

/** Append to a bounded list, dropping the oldest entry once it is full. */
function keepTail<T>(list: T[], value: T, max = 24): void {
  list.push(value);
  if (list.length > max) list.shift();
}

/**
 * Record a stream that ended having delivered content but no finish reason.
 * The gateway cut the connection mid-generation, which the driver reports as
 * `finish: null` with no token counts — indistinguishable from a turn that
 * simply died. That shape cannot be repaired (nothing was misordered), so it is
 * logged instead, alongside the payloads immediately before the cut.
 */
function captureTruncatedStream(stream: string[]): void {
  try {
    mkdirSync(dirname(TOOL_CALL_CAPTURE), { recursive: true });
    appendFileSync(
      TOOL_CALL_CAPTURE,
      JSON.stringify({ at: new Date().toISOString(), kind: "truncated-stream", stream }) + "\n",
    );
  } catch {
    /* capture must never break a request */
  }
}

/**
 * FG-2: repair provider streams whose tool call deltas arrive without
 * `id` and/or `function.name`. opencode's strict OpenAI-chat driver
 * aborts the turn with "OpenAI Chat tool call delta is missing id or
 * name" when a tool call never receives both, wedging the session.
 *
 * Some gateways stream the argument fragments of a call without ever
 * repeating the identity on them, and occasionally omit the start
 * delta (the one chunk that carries `id`/`name`) entirely. Both are
 * fixable here: argument fragments for the same (choice, tool-call
 * index) always belong to the same call, so we buffer them until the
 * call's identity is known, then flush one consolidated delta with
 * the full arguments so far. Later fragments pass through untouched
 * because the driver already knows the call by then.
 *
 * If the stream ends and a call still has no `function.name`, the
 * name cannot be invented — the call is emitted as-is (the driver
 * errors, the retry seam retries the request) and the full stream is
 * dumped to the capture file below so the provider's exact shape can
 * be diagnosed.
 */
const TOOL_CALL_CAPTURE =
  process.env.OPENCODE_FINISH_GUARD_CAPTURE ?? "/tmp/opencode/finish-guard-toolcalls.jsonl";

interface PendingToolCall {
  args: string;
  id?: string;
  name?: string;
  flushed: boolean;
}

function captureUnresolvedStream(rawPayload: string, stream: string[]): void {
  try {
    mkdirSync(dirname(TOOL_CALL_CAPTURE), { recursive: true });
    appendFileSync(
      TOOL_CALL_CAPTURE,
      JSON.stringify({ at: new Date().toISOString(), stream }) + "\n",
    );
  } catch {
    /* capture must never break a request */
  }
}

function makeToolCallBuffer() {
  const calls = new Map<string, PendingToolCall>();
  const streamLog: string[] = [];
  let counter = 0;

  const entryFor = (callKey: number, call: PendingToolCall, type: unknown): AnyRecord => ({
    index: callKey,
    id: call.id ?? `call_finishguard_${++counter}`,
    ...(typeof type === "string" && type ? { type } : { type: "function" }),
    function: { name: call.name, arguments: call.args },
  });

  return {
    /** Rewrite one chunk; returns the chunks to emit (0..n). */
    process(parsed: AnyRecord, rawPayload: string): AnyRecord[] {
      const choices = parsed.choices;
      if (!Array.isArray(choices)) return [parsed];
      let sawToolCalls = false;
      const outChoices = choices.map((choice: unknown, choicePosition: number) => {
        if (!isPlainObject(choice)) return choice;
        const delta = (choice as AnyRecord).delta;
        if (!isPlainObject(delta)) return choice;
        const toolCalls = (delta as AnyRecord).tool_calls;
        if (!Array.isArray(toolCalls)) return choice;
        sawToolCalls = true;
        const choiceKey =
          typeof choice.index === "number" && Number.isFinite(choice.index)
            ? choice.index
            : choicePosition;
        const kept: AnyRecord[] = [];
        toolCalls.forEach((tc: unknown, tcPosition: number) => {
          if (!isPlainObject(tc)) {
            kept.push(tc as AnyRecord);
            return;
          }
          const callKey =
            typeof tc.index === "number" && Number.isFinite(tc.index) ? tc.index : tcPosition;
          const key = `${choiceKey}:${callKey}`;
          const fn = isPlainObject(tc.function) ? (tc.function as AnyRecord) : undefined;
          let call = calls.get(key);
          if (!call) {
            call = { args: "", flushed: false };
            calls.set(key, call);
          }
          if (typeof tc.id === "string" && tc.id !== "") call.id = tc.id;
          if (fn && typeof fn.name === "string" && fn.name !== "") call.name = fn.name;
          if (fn && typeof fn.arguments === "string") call.args += fn.arguments;
          if (call.flushed) {
            // The driver already knows this call; fragments pass through.
            kept.push(tc as AnyRecord);
            return;
          }
          if (call.id && call.name) {
            call.flushed = true;
            kept.push(entryFor(callKey, call, tc.type));
          }
          // else: still buffering — hold the fragment until identity is known.
        });
        const newDelta: AnyRecord = { ...delta };
        if (kept.length > 0) newDelta.tool_calls = kept;
        else delete newDelta.tool_calls;
        return { ...choice, delta: newDelta };
      });
      if (!sawToolCalls) return [parsed];
      streamLog.push(rawPayload);
      return [{ ...parsed, choices: outChoices }];
    },

    /** Flush calls that were still buffering when the stream ended. */
    flushRemaining(): AnyRecord[] {
      const chunks: AnyRecord[] = [];
      for (const [key, call] of [...calls.entries()]) {
        if (call.flushed) continue;
        const [choiceKey, callKey] = key.split(":").map(Number);
        if (!call.id || !call.name) {
          captureUnresolvedStream(key, streamLog);
        }
        call.flushed = true;
        chunks.push({
          object: "chat.completion.chunk",
          choices: [
            {
              index: Number.isFinite(choiceKey) ? choiceKey : 0,
              delta: { tool_calls: [entryFor(Number.isFinite(callKey) ? callKey : 0, call, undefined)] },
              finish_reason: null,
            },
          ],
        });
      }
      return chunks;
    },
  };
}

/**
 * A byte-for-byte streaming transform that moves the `finish_reason` chunk to
 * the end of the SSE body. Any chunk that carries a finish reason is re-emitted
 * with the reason stripped (keeping its content and usage in place); a single
 * finish chunk is emitted on flush, just before `[DONE]`.
 */
function finishLastTransform(
  metrics: { truncated: number; lastTruncatedAt: number } = { truncated: 0, lastTruncatedAt: 0 },
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // FG-1: finish reasons are remembered *per choice index*. A single
  // `finishReason` plus a hardcoded `index: 0` flushed one reason for the whole
  // stream, so with n > 1 choices every choice but the one at index 0 lost its
  // finish reason (the SDK then waits forever / errors on the unterminated
  // choices) — and a stream finishing choices at different indexes kept only
  // the last one seen.
  const finishReasons = new Map<number, string>();
  let template: AnyRecord | null = null;
  let sawDone = false;
  // Whether any chunk with real choices arrived. Distinguishes a stream the
  // gateway cut off mid-generation (content but no finish reason) from an
  // empty one, which must be left exactly as it is.
  let sawContent = false;
  // Tail of finished payloads, kept so a truncation can be inspected after the
  // fact instead of being indistinguishable from a turn that simply died.
  const ring: string[] = [];
  const toolBuffer = makeToolCallBuffer();

  const write = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    controller.enqueue(encoder.encode(text));
  };

  const handleLine = (controller: TransformStreamDefaultController<Uint8Array>, raw: string): void => {
    const eol = raw.endsWith("\r") ? "\r\n" : "\n";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = DATA_LINE.exec(line);
    if (!match) {
      write(controller, raw + "\n");
      return;
    }
    const payload = match[1];
    if (payload.trim() === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      write(controller, raw + "\n");
      return;
    }
    if (!isPlainObject(parsed)) {
      write(controller, raw + "\n");
      return;
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      // A chunk with no choices (a trailing usage chunk, say) is not an
      // ordering problem; write it and keep the finish where it was.
      write(controller, raw + "\n");
      return;
    }
    sawContent = true;
    keepTail(ring, payload);
    // FG-2: buffer tool call deltas until their identity is known.
    // `untouched` marks chunks with no tool calls, which keep the
    // provider's original byte layout.
    const emitted = toolBuffer.process(parsed, payload);
    const untouched = emitted.length === 1 && emitted[0] === parsed;
    for (const chunk of emitted) {
      const chunkChoices = chunk.choices;
      if (!Array.isArray(chunkChoices) || chunkChoices.length === 0) {
        write(controller, "data: " + JSON.stringify(chunk) + eol);
        continue;
      }
      let sawFinish = false;
      chunkChoices.forEach((choice: unknown, position: number) => {
        if (!isPlainObject(choice)) return;
        const reason = (choice as AnyRecord).finish_reason;
        if (reason === undefined || reason === null) return;
        sawFinish = true;
        const choiceIndex = (choice as AnyRecord).index;
        const index =
          typeof choiceIndex === "number" && Number.isFinite(choiceIndex)
            ? choiceIndex
            : position;
        finishReasons.set(index, String(reason));
      });
      if (!sawFinish) {
        write(
          controller,
          untouched ? raw + "\n" : "data: " + JSON.stringify(chunk) + eol,
        );
        continue;
      }
      // Hold the finish reason back: strip it here, keep any content/usage
      // in this chunk where it is, and re-emit the finish once the stream
      // ends.
      template = chunk;
      const stripped = {
        ...chunk,
        choices: chunkChoices.map((choice: unknown) =>
          isPlainObject(choice) ? { ...choice, finish_reason: null } : choice,
        ),
      };
      write(controller, "data: " + JSON.stringify(stripped) + eol);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(controller, raw);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        handleLine(controller, buffer);
        buffer = "";
      }
      // FG-2: flush tool calls that were still buffering (their start
      // delta never arrived) *before* the finish reason, so the driver
      // sees the call before the turn terminates.
      for (const chunk of toolBuffer.flushRemaining()) {
        write(controller, "data: " + JSON.stringify(chunk) + "\n\n");
      }
      // FG-1: one synthetic finish entry per index that had one stripped.
      if (template && finishReasons.size > 0) {
        for (const [index, reason] of [...finishReasons.entries()].sort((a, b) => a[0] - b[0])) {
          write(
            controller,
            "data: " +
              JSON.stringify({
                id: template.id,
                object: template.object ?? "chat.completion.chunk",
                created: template.created,
                model: template.model,
                choices: [{ index, delta: {}, finish_reason: reason }],
              }) +
              "\n\n",
          );
        }
      }
      // A stream that delivered content but never a finish reason was cut off
      // by the gateway mid-generation. Left alone, the driver has nothing to
      // terminate on and records finish:null with no token counts, so the turn
      // looks like it died for no reason. Close it cleanly; the truncation is
      // recorded and counted rather than absorbed, because unlike a misordered
      // finish reason it cannot be repaired — only made visible.
      let synthesized = false;
      if (!template && sawContent && finishReasons.size === 0) {
        metrics.truncated += 1;
        metrics.lastTruncatedAt = Date.now();
        captureTruncatedStream(ring);
        synthesized = true;
        write(
          controller,
          "data: " +
            JSON.stringify({
              object: "chat.completion.chunk",
              created: Date.now(),
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\n\n",
        );
      }
      // The sentinel is swallowed above so it cannot precede the finish; replay
      // it here, once the stream is actually finished.
      if (sawDone || synthesized) write(controller, "data: [DONE]\n\n");
    },
  });
}

/**
 * E60: NDJSON (newline-delimited JSON) variant of finishLastTransform.
 * Each line is a complete JSON object; the finish-reason line is held back
 * and re-emitted at the end, just like the SSE transform.
 */
function ndjsonFinishLastTransform(
  metrics: { truncated: number; lastTruncatedAt: number } = { truncated: 0, lastTruncatedAt: 0 },
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // FG-1: per-choice-index finish reasons (see finishLastTransform) — flushing
  // one hardcoded index-0 reason left every other choice unterminated.
  const finishReasons = new Map<number, string>();
  let template: AnyRecord | null = null;
  const toolBuffer = makeToolCallBuffer();
  let sawContent = false;
  const ring: string[] = [];

  const write = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    controller.enqueue(encoder.encode(text));
  };

  const handleLine = (controller: TransformStreamDefaultController<Uint8Array>, raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(controller, line + "\n");
      return;
    }
    if (!isPlainObject(parsed)) {
      write(controller, line + "\n");
      return;
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      write(controller, line + "\n");
      return;
    }
    sawContent = true;
    keepTail(ring, line);
    // FG-2: buffer tool call deltas until their identity is known.
    // `untouched` marks chunks with no tool calls, which keep the
    // provider's original byte layout.
    const emitted = toolBuffer.process(parsed, line);
    const untouched = emitted.length === 1 && emitted[0] === parsed;
    for (const chunk of emitted) {
      const chunkChoices = chunk.choices;
      if (!Array.isArray(chunkChoices) || chunkChoices.length === 0) {
        write(controller, JSON.stringify(chunk) + "\n");
        continue;
      }
      let sawFinish = false;
      chunkChoices.forEach((choice: unknown, position: number) => {
        if (!isPlainObject(choice)) return;
        const reason = (choice as AnyRecord).finish_reason;
        if (reason === undefined || reason === null) return;
        sawFinish = true;
        const choiceIndex = (choice as AnyRecord).index;
        const index =
          typeof choiceIndex === "number" && Number.isFinite(choiceIndex)
            ? choiceIndex
            : position;
        finishReasons.set(index, String(reason));
      });
      if (!sawFinish) {
        write(
          controller,
          untouched ? line + "\n" : JSON.stringify(chunk) + "\n",
        );
        continue;
      }
      template = chunk;
      const stripped = {
        ...chunk,
        choices: chunkChoices.map((choice: unknown) =>
          isPlainObject(choice) ? { ...choice, finish_reason: null } : choice,
        ),
      };
      write(controller, JSON.stringify(stripped) + "\n");
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(controller, raw);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        handleLine(controller, buffer);
        buffer = "";
      }
      // FG-2: flush tool calls that were still buffering (their
      // start delta never arrived) *before* the finish reason,
      // so the driver sees the call before the turn terminates.
      for (const chunk of toolBuffer.flushRemaining()) {
        write(controller, JSON.stringify(chunk) + "\n");
      }
      // FG-1: one synthetic finish line per index that had one stripped.
      if (template && finishReasons.size > 0) {
        for (const [index, reason] of [...finishReasons.entries()].sort((a, b) => a[0] - b[0])) {
          write(
            controller,
            JSON.stringify({
              id: template.id,
              object: template.object ?? "chat.completion.chunk",
              created: template.created,
              model: template.model,
              choices: [{ index, delta: {}, finish_reason: reason }],
            }) + "\n",
          );
        }
      }
      // The stream was cut off mid-generation: content arrived but no finish
      // reason ever did. Close it so the driver terminates instead of recording
      // finish:null with no token counts. See the SSE transform for why this is
      // recorded rather than silently absorbed.
      if (!template && sawContent && finishReasons.size === 0) {
        metrics.truncated += 1;
        metrics.lastTruncatedAt = Date.now();
        captureTruncatedStream(ring);
        write(
          controller,
          JSON.stringify({
            object: "chat.completion.chunk",
            created: Date.now(),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) + "\n",
        );
      }
    },
  });
}
