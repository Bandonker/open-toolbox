import { Plugin } from "@opencode/plugin";
import { asBool, asInt } from "../lib/config.ts";

/**
 * loop-guard
 *
 * Always-on doom-loop breaker for ordinary (non-goal) sessions.
 *
 * Weak models sometimes degenerate into repetition: the same tool call, or the
 * same assistant reply, over and over, until the user aborts. The goal plugin
 * has a stall detector, but it only runs while a `/goal` is active — a normal
 * `build`/`explore`/`general` session has no guard at all.
 *
 * This plugin watches two seams that are always available:
 *
 *   - `tool.hook("execute.before")` sees every tool call. The tool name plus a
 *     stable stringification of its input is the call signature; consecutive
 *     identical signatures are counted per session.
 *   - `session.hook("context")` sees the outgoing message list before every
 *     request. The last assistant message (its text plus any tool calls) is the
 *     reply signature; consecutive identical replies are counted per session.
 *
 * Only *consecutive* repeats count — any different call or reply resets the
 * run, so legitimate re-reads spread across a long session never trip it. When
 * a run reaches `repeatLimit` the model is nudged (a system message injected
 * into the next request telling it to change approach or conclude). If it keeps
 * going to `cancelLimit` the turn is interrupted with `session.interrupt`.
 *
 * State is in-memory and per session; it is not persisted, which is fine for a
 * guard whose only job is to break a loop that is happening right now.
 */

type AnyRecord = Record<string, unknown>;

interface RawPart {
  type?: string;
  text?: string;
  name?: string;
  state?: { input?: unknown };
}

interface RawMessage {
  id?: string;
  role?: string;
  type?: string;
  content?: Array<RawPart>;
}

interface ContextEvent {
  sessionID?: string;
  messages?: RawMessage[];
}

interface ToolEvent {
  sessionID?: string;
  tool?: string;
  args?: unknown;
  input?: unknown;
}

interface Disposable {
  dispose?: () => void | Promise<void>;
}

interface LoopCtx {
  options?: AnyRecord;
  tool?: {
    hook?: (
      name: "execute.before",
      cb: (event: ToolEvent) => void,
    ) => Promise<Disposable>;
  };
  session?: {
    hook?: (
      name: "context",
      cb: (event: ContextEvent) => void,
    ) => Promise<Disposable>;
    synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    interrupt?: (input: { sessionID: string }) => Promise<unknown>;
  };
}

interface LoopConfig {
  enabled: boolean;
  /** Consecutive identical calls/replies before the model is nudged. */
  repeatLimit: number;
  /** Consecutive identical calls/replies before the turn is cancelled. */
  cancelLimit: number;
  /** Post a synthetic note into the session when the guard acts. */
  notify: boolean;
  /** Log guard activity to stderr. */
  log: boolean;
}

type RepeatKind = "tool" | "reply";

interface LoopState {
  lastToolSig: string | null;
  toolRepeat: number;
  toolNudged: boolean;
  toolCancelled: boolean;
  lastReplySig: string | null;
  replyRepeat: number;
  replyNudged: boolean;
  replyCancelled: boolean;
  /** Active corrective text for each detector; re-injected each request until
   * the run breaks, then cleared. */
  toolNudge: string | null;
  replyNudge: string | null;
}

type LoopAction = { kind: "nudge"; count: number } | { kind: "cancel"; count: number } | null;

/* --------------------------------------------------------------- constants */

const MARK = "[loop-guard]";
/** Unique sentinel so the nudge is recognisable in the transcript. */
const SENTINEL = "[loop-guard:nudge:v1]";
/** Session-state cap with oldest-first eviction. */
const MAX_SESSION_STATES = 500;
/** Signature cap: a loop repeats the head, so keep head and tail. */
const SIG_CHARS = 600;

/* ------------------------------------------------------------------ config */

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = asInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

function resolveConfig(options: AnyRecord | undefined): LoopConfig {
  const pick = (key: string, env: string): unknown => options?.[key] ?? process.env[env];
  const repeatLimit = toInt(pick("repeatLimit", "OPENCODE_LOOP_GUARD_REPEAT_LIMIT"), 4, 2, 1000);
  const cancelLimit = toInt(
    pick("cancelLimit", "OPENCODE_LOOP_GUARD_CANCEL_LIMIT"),
    Math.max(8, repeatLimit + 1),
    repeatLimit + 1,
    100000,
  );
  return {
    enabled: asBool(pick("enabled", "OPENCODE_LOOP_GUARD_ENABLED"), true),
    repeatLimit,
    cancelLimit,
    notify: asBool(pick("notify", "OPENCODE_LOOP_GUARD_NOTIFY"), true),
    log: asBool(pick("log", "OPENCODE_LOOP_GUARD_LOG"), false),
  };
}

/* ------------------------------------------------------------------- utils */

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Stable stringify: object keys are sorted (recursively) so two inputs that
 * differ only by key order produce the same signature. Cycles and exotic
 * values degrade to a placeholder instead of throwing.
 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "undefined") return "[undefined]";
      if (typeof v === "function") return "[function]";
      if (typeof v === "bigint") return String(v);
      return v;
    }
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? "undefined";
  } catch {
    return String(value);
  }
}

function toolSignature(tool: string, input: unknown): string {
  return `${tool}:${stableStringify(input)}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncateSig(text: string): string {
  if (text.length <= SIG_CHARS) return text;
  return `${text.slice(0, SIG_CHARS / 2)}~${text.slice(-SIG_CHARS / 2)}`;
}

function isRole(message: RawMessage | undefined, role: string): boolean {
  return message?.role === role || message?.type === role;
}

function messageText(message: RawMessage | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Fingerprint of an assistant message: its text and reasoning plus its tool
 * calls (name + input). Only the parts that a degenerate loop repeats, so a
 * legitimate follow-up that reads a different file is a different signature.
 */
function replySignature(message: RawMessage | undefined): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const pieces: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      pieces.push(`t:${normalizeText(part.text)}`);
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      pieces.push(`r:${normalizeText(part.text)}`);
    } else if (part.type === "tool") {
      pieces.push(`c:${String(part.name ?? "tool")}:${stableStringify(part.state?.input)}`);
    }
  }
  return truncateSig(pieces.join("\u0001") || "(empty)");
}

/**
 * Signature of the latest assistant turn: the preceding user message plus the
 * assistant reply. Including the user side means the same short reply to two
 * *different* user requests is not a repeat, while the real loop (one user
 * request, an unchanging assistant reply) still matches.
 */
function turnSignature(messages: RawMessage[]): string | null {
  let aiIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRole(messages[i], "assistant")) {
      aiIdx = i;
      break;
    }
  }
  if (aiIdx < 0) return null;
  let userText = "";
  for (let i = aiIdx - 1; i >= 0; i--) {
    if (isRole(messages[i], "user")) {
      userText = normalizeText(messageText(messages[i]));
      break;
    }
  }
  return truncateSig(`u:${userText}\u0001a:${replySignature(messages[aiIdx])}`);
}

/* ------------------------------------------------------------- detection */

/**
 * Update the consecutive-repeat counter for `kind` and return the action to
 * take, if any. A different signature always restarts the run, so only truly
 * consecutive repeats accumulate. `cancel` resets the run so a session that
 * resumes the same loop after an interrupt is cancelled again, not ignored.
 */
function observe(
  state: LoopState,
  kind: RepeatKind,
  sig: string,
  cfg: LoopConfig,
): LoopAction {
  if (kind === "tool") {
    if (sig === state.lastToolSig) {
      state.toolRepeat += 1;
    } else {
      // A different call means the loop broke; drop both corrections.
      state.lastToolSig = sig;
      state.toolRepeat = 1;
      state.toolNudged = false;
      state.toolCancelled = false;
      state.toolNudge = null;
      state.replyNudge = null;
    }
    const count = state.toolRepeat;
    if (count >= cfg.cancelLimit && !state.toolCancelled) {
      state.toolCancelled = true;
      state.toolRepeat = 0;
      state.lastToolSig = null;
      state.toolNudged = false;
      state.toolNudge = null;
      state.replyNudge = null;
      return { kind: "cancel", count };
    }
    if (count >= cfg.repeatLimit && !state.toolNudged) {
      state.toolNudged = true;
      state.toolNudge = nudgeText("tool", count);
      return { kind: "nudge", count };
    }
    return null;
  }

  if (sig === state.lastReplySig) {
    state.replyRepeat += 1;
  } else {
    state.lastReplySig = sig;
    state.replyRepeat = 1;
    state.replyNudged = false;
    state.replyCancelled = false;
    state.toolNudge = null;
    state.replyNudge = null;
  }
  const count = state.replyRepeat;
  if (count >= cfg.cancelLimit && !state.replyCancelled) {
    state.replyCancelled = true;
    state.replyRepeat = 0;
    state.lastReplySig = null;
    state.replyNudged = false;
    state.toolNudge = null;
    state.replyNudge = null;
    return { kind: "cancel", count };
  }
  if (count >= cfg.repeatLimit && !state.replyNudged) {
    state.replyNudged = true;
    state.replyNudge = nudgeText("reply", count);
    return { kind: "nudge", count };
  }
  return null;
}

function nudgeText(kind: RepeatKind, count: number): string {
  const what =
    kind === "tool"
      ? `the same tool call ${count} times in a row`
      : `the same reply ${count} times in a row`;
  return [
    SENTINEL,
    MARK,
    `You have repeated ${what}. This is a loop: repeating it will not make progress.`,
    "Stop now and change approach. Use a different tool or different inputs, act on the output you already have, or conclude with a summary and what is still unresolved.",
    "Do not repeat the previous action.",
  ].join("\n");
}

function cancelNote(kind: RepeatKind, count: number): string {
  const what =
    kind === "tool"
      ? `${count} identical tool calls in a row`
      : `${count} identical replies in a row`;
  return `${MARK} Cancelled this turn after ${what}. The model was stuck repeating itself. Send a new instruction to continue.`;
}

/* ---------------------------------------------------------------- plugin */

export default Plugin.define({
  id: "loop-guard",
  async setup(c) {
    const ctx = c as unknown as LoopCtx;
    const cfg = resolveConfig(ctx.options);
    if (!cfg.enabled) return () => {};

    const log = (message: string): void => {
      if (!cfg.log) return;
      try {
        console.error(`[loop-guard] ${message}`);
      } catch {
        /* logging must never break a turn */
      }
    };

    const states = new Map<string, LoopState>();
    const getState = (sessionID: string): LoopState => {
      let state = states.get(sessionID);
      if (state) return state;
      if (states.size >= MAX_SESSION_STATES) {
        const oldest = states.keys().next();
        if (!oldest.done) states.delete(oldest.value);
      }
      state = {
        lastToolSig: null,
        toolRepeat: 0,
        toolNudged: false,
        toolCancelled: false,
        lastReplySig: null,
        replyRepeat: 0,
        replyNudged: false,
        replyCancelled: false,
        toolNudge: null,
        replyNudge: null,
      };
      states.set(sessionID, state);
      return state;
    };

    const note = async (sessionID: string, text: string): Promise<void> => {
      if (!cfg.notify) return;
      try {
        await ctx.session?.synthetic?.({ sessionID, text });
      } catch (err) {
        log(`failed to post note to ${sessionID}: ${describeError(err)}`);
      }
    };

    const cancel = (sessionID: string, kind: RepeatKind, count: number): void => {
      log(`cancelling ${sessionID}: ${count} identical ${kind} ${kind === "tool" ? "calls" : "replies"}`);
      try {
        void Promise.resolve(ctx.session?.interrupt?.({ sessionID })).catch((err) =>
          log(`interrupt failed for ${sessionID}: ${describeError(err)}`),
        );
      } catch (err) {
        log(`interrupt threw for ${sessionID}: ${describeError(err)}`);
      }
      void note(sessionID, cancelNote(kind, count));
    };

    const registrations: Disposable[] = [];

    // Tool-call detector: fires for every call, before it executes.
    if (typeof ctx.tool?.hook === "function") {
      try {
        registrations.push(
          await ctx.tool.hook("execute.before", (event) => {
            const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
            if (!sessionID) return;
            const tool = typeof event?.tool === "string" ? event.tool : "tool";
            const input = event?.args ?? event?.input;
            const state = getState(sessionID);
            const action = observe(state, "tool", toolSignature(tool, input), cfg);
            if (!action) return;
            if (action.kind === "nudge") {
              // observe() stored the corrective text on the state; the context
              // hook injects it into every request until the run breaks.
              log(`${sessionID}: same tool call ${action.count}x in a row; nudging`);
              void note(
                sessionID,
                `${MARK} Repetition detected: the same tool call ran ${action.count} times in a row. Telling the model to change approach.`,
              );
            } else {
              cancel(sessionID, "tool", action.count);
            }
          }),
        );
      } catch (err) {
        log(`tool hook unavailable: ${describeError(err)}`);
      }
    }

    // Reply detector: fires before each request; also injects any nudge the
    // tool detector queued between requests.
    if (typeof ctx.session?.hook === "function") {
      try {
        registrations.push(
          await ctx.session.hook("context", (event) => {
            const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
            if (!sessionID) return;
            const messages = Array.isArray(event?.messages) ? event.messages : [];
            // Drop a nudge from a previous request so repeated firings do not
            // pile up in the transcript (mirrors goal's reminder hygiene).
            for (let i = messages.length - 1; i >= 0; i--) {
              if (isRole(messages[i], "system") && messageText(messages[i]).includes(SENTINEL)) {
                messages.splice(i, 1);
              }
            }
            const state = getState(sessionID);
            const turnSig = turnSignature(messages);
            if (turnSig) {
              const action = observe(state, "reply", turnSig, cfg);
              if (action?.kind === "nudge") {
                log(`${sessionID}: same reply ${action.count}x in a row; nudging`);
                void note(
                  sessionID,
                  `${MARK} Repetition detected: the same reply appeared ${action.count} times in a row. Telling the model to change approach.`,
                );
              } else if (action?.kind === "cancel") {
                cancel(sessionID, "reply", action.count);
              }
            }
            const corrective = state.toolNudge ?? state.replyNudge;
            if (corrective) {
              messages.push({ role: "system", content: [{ type: "text", text: corrective }] });
            }
          }),
        );
      } catch (err) {
        log(`context hook unavailable: ${describeError(err)}`);
      }
    }

    return async () => {
      for (const registration of registrations) {
        try {
          await registration?.dispose?.();
        } catch {
          /* best effort */
        }
      }
    };
  },
});
