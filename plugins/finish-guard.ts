import { Plugin } from "@opencode/plugin";

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
    const log = (message: string): void => {
      if (!debug) return;
      try {
        console.error(`[finish-guard] ${message}`);
      } catch {
        /* logging must never break a request */
      }
    };

    if (!enabled) return () => {};
    if (typeof ctx?.session?.hook !== "function") return () => {};

    const registrations: Array<{ dispose?: () => unknown }> = [];

    try {
      registrations.push(
        await ctx.session.hook("http.response", (event) => {
          try {
            normaliseResponse(event, log);
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
              applyRetry(event as unknown as AnyRecord, retryMax, log);
            } catch (err) {
              log(`retry decision left to opencode: ${String(err)}`);
            }
          }),
        );
      } catch (err) {
        log(`retry hook unavailable; malformed streams are not retried: ${String(err)}`);
      }
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
const RETRY_MATCH = /content after the finish reason|invalidprovideroutput|stream ended without finish_reason/i;

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

function applyRetry(event: AnyRecord, retryMax: number, log: (message: string) => void): void {
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
  const delay = Math.min(2000, 300 * Math.max(1, attempt));
  event.decision = { retry: true, delay };
  log(`retrying a malformed provider stream (attempt ${attempt + 1} in ${delay}ms)`);
}

function normaliseResponse(event: { response: Response }, log: (message: string) => void): void {
  const response = event?.response;
  if (!response || typeof response !== "object") return;
  if (!response.body) return;
  // An error or JSON body must reach the driver exactly as the provider sent
  // it; only streaming chat/completions responses carry the ordering bug.
  if (response.ok === false) return;
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/text\/event-stream/i.test(contentType)) return;

  event.response = new Response(response.body.pipeThrough(finishLastTransform()), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  log("held the finish chunk until the end of the stream");
}

/** The SSE field carrying a JSON payload; every other line is passed through. */
const DATA_LINE = /^data:\s?(.*)$/;

/**
 * A byte-for-byte streaming transform that moves the `finish_reason` chunk to
 * the end of the SSE body. Any chunk that carries a finish reason is re-emitted
 * with the reason stripped (keeping its content and usage in place); a single
 * finish chunk is emitted on flush, just before `[DONE]`.
 */
function finishLastTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let finishReason: string | null = null;
  let template: AnyRecord | null = null;
  let sawDone = false;

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
      write(controller, raw + "\n");
      return;
    }
    let sawFinish = false;
    for (const choice of choices) {
      if (!isPlainObject(choice)) continue;
      const reason = choice.finish_reason;
      if (reason !== undefined && reason !== null) {
        sawFinish = true;
        finishReason = String(reason);
      }
    }
    if (!sawFinish) {
      write(controller, raw + "\n");
      return;
    }
    // Hold the finish reason back: strip it here, keep any content/usage in
    // this chunk where it is, and re-emit the finish once the stream ends.
    template = parsed;
    const stripped = {
      ...parsed,
      choices: choices.map((choice) =>
        isPlainObject(choice) ? { ...choice, finish_reason: null } : choice,
      ),
    };
    write(controller, "data: " + JSON.stringify(stripped) + eol);
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
      if (template && finishReason) {
        write(
          controller,
          "data: " +
            JSON.stringify({
              id: template.id,
              object: template.object ?? "chat.completion.chunk",
              created: template.created,
              model: template.model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }) +
            "\n\n",
        );
      }
      if (sawDone) write(controller, "data: [DONE]\n\n");
    },
  });
}
