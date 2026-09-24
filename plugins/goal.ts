import { Plugin } from "@opencode/plugin";
import { z } from "zod";

/**
 * goal
 *
 * Set an objective for a session and keep the model working until it is
 * actually reached. v1 had no way for a plugin to notice that a turn had ended
 * or to queue the next one; v2 exposes both (`event.subscribe` +
 * `session.prompt`), which is what makes an autonomous goal loop possible.
 *
 * How it works
 *   - `/goal <objective>` stores a goal for the current session and starts a
 *     normal turn. The objective is re-injected into every request
 *     (`session.hook("context")`) so it survives long turns and compaction.
 *   - When a turn ends (`session.idle` / `session.execution.succeeded`) the
 *     plugin checks the last message and the budget. If the goal is not done it
 *     queues a continuation prompt carrying the objective and remaining budget,
 *     and the model keeps going.
 *   - The loop only stops on an explicit model signal (`goal_complete` /
 *     `goal_blocked`), a user interrupt, a stall (turns that run no tools and
 *     repeat themselves), a failure streak, or the iteration/time budget.
 *
 * State lives in plugin storage keyed by session, so a goal survives a plugin
 * reload and can be resumed.
 */

/* ------------------------------------------------------------------ types */

interface RawMessage {
  id?: string;
  role?: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ContextEvent {
  sessionID?: string;
  messages?: RawMessage[];
}

interface ToolEvent {
  sessionID?: string;
  tool?: string;
}

interface EventEnvelope {
  type?: string;
  data?: Record<string, unknown>;
}

interface Disposable {
  dispose?: () => void | Promise<void>;
}

interface GoalCtx {
  options?: Record<string, unknown>;
  storage?: {
    get?: (key: string) => Promise<unknown>;
    set?: (key: string, value: unknown) => Promise<void>;
    remove?: (key: string) => Promise<void>;
  };
  event?: {
    subscribe?: (opts: { signal: AbortSignal }) => AsyncIterable<EventEnvelope>;
  };
  tool?: {
    transform?: (cb: (editor: { add: (def: AnyToolDef) => void }) => void) => Promise<Disposable>;
    hook?: (name: "execute.before", cb: (event: ToolEvent) => void) => Promise<Disposable>;
  };
  session?: {
    hook?: (name: "context", cb: (event: ContextEvent) => void) => Promise<Disposable>;
    prompt?: (input: { sessionID: string; text: string; delivery?: unknown }) => Promise<unknown>;
    synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<RawMessage[]>;
  };
  command?: {
    transform?: (
      cb: (editor: { add: (def: AnyCommandDef) => void }) => void,
    ) => Promise<Disposable>;
  };
}

// The tool/command editors are typed through zod elsewhere; the plugin only
// needs the structural shape here.
type AnyToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: never, toolCtx: { sessionID?: string }) => Promise<{ content: string }>;
};
type AnyCommandDef = {
  name: string;
  description: string;
  execute: (input: {
    sessionID: string;
    prompt?: { text?: string };
    delivery?: unknown;
  }) => Promise<void>;
};

type GoalStatus =
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "failed"
  | "timeout"
  | "budget"
  | "stalled";

interface ProgressNote {
  at: number;
  text: string;
}

interface GoalState {
  sessionID: string;
  objective: string;
  criteria: string[];
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  deadlineAt: number | null;
  maxIterations: number;
  iterations: number;
  failures: number;
  stallCount: number;
  lastSignature: string;
  lastHandledMessageID: number | string;
  /** When the last handled message was recorded (G12 unknown-id dedupe). */
  lastHandledAt?: number;
  /** Ring of recent reply signatures so A/B/A/B alternation counts as a stall (G10). */
  recentSignatures?: string[];
  /** Paused timestamp so resume can extend the wall-clock budget (G3). */
  pausedAt?: number;
  /** Set once when a user-initiated (non-goal) turn suppressed the auto-kick (G9). */
  userTookOver?: boolean;
  progress: ProgressNote[];
  lastSummary?: string;
  evidence?: string;
  blockedReason?: string;
  stoppedReason?: string;
}

interface GoalConfig {
  enabled: boolean;
  maxIterations: number;
  maxMinutes: number;
  stallLimit: number;
  maxFailures: number;
  requireEvidence: boolean;
  maxInjectChars: number;
  notify: boolean;
  log: boolean;
}

/* --------------------------------------------------------------- constants */

const STORE_PREFIX = "goal.v1.";
const MARK = "[goal-plugin]";
/** GO-6: unique sentinel marking reminders this plugin injected, so the
 * context hook only strips its own output — never user/system text that
 * merely mentions the plugin. */
const REMINDER_SENTINEL = "[goal-plugin:reminder:v1]";
const MAX_PROGRESS = 20;
const HELP = [
  "goal — keep working until an objective is reached.",
  "",
  "  /goal <objective>        set the goal and start working",
  "  /goal set <objective>    same, when the objective starts with a keyword",
  "  /goal status             show status, budget and recent progress",
  "  /goal pause              stop auto-continuing (the current turn finishes)",
  "  /goal resume             resume an auto-continuing goal",
  "  /goal done               mark the goal complete yourself",
  "  /goal clear              forget the goal",
  "",
  "Tip: follow the objective with '- ' lines to list success criteria, e.g.",
  "  /goal Ship the login fix",
  "  - the failing test passes",
  "  - no new type errors",
].join("\n");
const NO_GOAL = "[goal-plugin] No goal is set for this session. Use `/goal <objective>` to set one.";

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "active",
  paused: "paused",
  complete: "complete",
  blocked: "blocked",
  failed: "stopped (repeated errors)",
  timeout: "stopped (time budget reached)",
  budget: "stopped (attempt budget reached)",
  stalled: "stopped (no progress detected)",
};

/* ----------------------------------------------------------------- config */

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function resolveConfig(options: Record<string, unknown> | undefined): GoalConfig {
  const pick = (key: string, env: string): unknown => options?.[key] ?? process.env[env];
  return {
    enabled: toBool(pick("enabled", "OPENCODE_GOAL_ENABLED"), true),
    maxIterations: toInt(pick("maxIterations", "OPENCODE_GOAL_MAX_ITERATIONS"), 30, 1, 100000),
    // GO-10: 0 = no wall-clock deadline (deadlineAt stays null).
    maxMinutes: toInt(pick("maxMinutes", "OPENCODE_GOAL_MAX_MINUTES"), 180, 0, 100000),
    stallLimit: toInt(pick("stallLimit", "OPENCODE_GOAL_STALL_LIMIT"), 3, 1, 1000),
    maxFailures: toInt(pick("maxFailures", "OPENCODE_GOAL_MAX_FAILURES"), 3, 1, 1000),
    requireEvidence: toBool(pick("requireEvidence", "OPENCODE_GOAL_REQUIRE_EVIDENCE"), true),
    maxInjectChars: toInt(pick("maxInjectChars", "OPENCODE_GOAL_MAX_INJECT_CHARS"), 1600, 200, 20000),
    notify: toBool(pick("notify", "OPENCODE_GOAL_NOTIFY"), true),
    log: toBool(pick("log", "OPENCODE_GOAL_LOG"), false),
  };
}

/* ------------------------------------------------------------------ utils */

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function textOf(message: RawMessage | undefined): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .map((p) => {
      if (p?.type === "text" && typeof p.text === "string") return p.text;
      // GO-8: non-text parts (image/tool/file) fall back to a capped
      // stringify so the turn is never an "empty signature" stall
      // false-positive just because it carried no text.
      if (p && typeof p === "object") {
        try {
          return `[part type=${String(p.type ?? "unknown")}: ${truncate(JSON.stringify(p), 200)}]`;
        } catch {
          return `[part type=${String(p.type ?? "unknown")}: unstringifiable]`;
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** A stable fingerprint of an assistant turn, used to detect stalls. */
function signature(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "(empty)";
  if (normalized.length <= 600) return normalized;
  return `${normalized.slice(0, 300)}~${normalized.slice(-300)}`;
}

/** Split `/goal` arguments into an objective and optional success criteria. */
function parseGoalText(text: string): { objective: string; criteria: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const objective: string[] = [];
  const criteria: string[] = [];
  for (const line of lines) {
    const bullet = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet && bullet[1]) criteria.push(bullet[1].trim());
    else objective.push(line);
  }
  const head = objective.join(" ").trim();
  if (!head && criteria.length > 0) return { objective: criteria.join("; "), criteria: [] };
  return { objective: head, criteria };
}

const VERBS = new Set(["help", "status", "pause", "resume", "done", "clear", "set"]);

function parseCommand(raw: string): { verb: string; arg: string } {
  const text = raw.trim();
  if (!text) return { verb: "help", arg: "" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const head = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();
  if (head === "set") return { verb: "set", arg: rest };
  if (VERBS.has(head)) return { verb: head, arg: rest };
  return { verb: "set", arg: text };
}

/* --------------------------------------------------------------- rendering */

function buildPrompt(
  st: GoalState,
  cfg: GoalConfig,
  opts: { kickoff: boolean; note?: string },
): string {
  const now = Date.now();
  const remaining = Math.max(0, st.maxIterations - st.iterations);
  const elapsedMin = Math.max(0, Math.round((now - st.startedAt) / 60000));
  const budgetMin = st.deadlineAt
    ? Math.max(0, Math.round((st.deadlineAt - now) / 60000))
    : cfg.maxMinutes;
  const lines: string[] = [
    opts.kickoff
      ? `${MARK} Goal set. Begin working on it now.`
      : `${MARK} Continue toward the goal (attempt ${st.iterations}/${st.maxIterations}, ${remaining} left, ${elapsedMin} min elapsed, about ${budgetMin} min of wall-clock budget remaining).`,
  ];
  if (opts.note) lines.push(opts.note);
  lines.push("", `OBJECTIVE\n${st.objective}`);
  if (st.criteria.length > 0) {
    lines.push(
      "",
      `SUCCESS CRITERIA\n${st.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    );
  }
  if (st.progress.length > 0) {
    lines.push(
      "",
      `PROGRESS SO FAR\n${st.progress
        .slice(-5)
        .map((p) => `- ${p.text}`)
        .join("\n")}`,
    );
  }
  lines.push(
    "",
    "Work autonomously until the objective and every criterion is achieved and verified.",
    "Do not repeat work that is already done; take the single next concrete step.",
    "- When it is genuinely done, call `goal_complete` with a summary and concrete evidence (the exact checks you ran and their observed results).",
    "- If you cannot proceed, call `goal_blocked` with the reason and what you need from me.",
    "- Otherwise call `goal_progress` to record each milestone, then keep going.",
    "A turn that ends without one of those calls will be resumed automatically, so never stop mid-task.",
  );
  return lines.join("\n");
}

function buildReminder(st: GoalState, cfg: GoalConfig): string {
  const remaining = Math.max(0, st.maxIterations - st.iterations);
  const lines = [
    "ACTIVE GOAL — keep working until it is reached.",
    `Objective: ${st.objective}`,
  ];
  if (st.criteria.length > 0) lines.push(`Success criteria: ${st.criteria.join(" | ")}`);
  lines.push(`Budget: attempt ${st.iterations}/${st.maxIterations} (${remaining} left).`);
  if (st.progress.length > 0) {
    lines.push(`Latest milestone: ${st.progress[st.progress.length - 1].text}`);
  }
  lines.push(
    "Finish by calling `goal_complete` with evidence, or `goal_blocked` if stuck; use `goal_progress` for milestones.",
  );
  return truncate(lines.join("\n"), cfg.maxInjectChars);
}

function statusText(st: GoalState, cfg: GoalConfig): string {
  const now = Date.now();
  const remaining = Math.max(0, st.maxIterations - st.iterations);
  const elapsedMin = Math.max(0, Math.round((now - st.startedAt) / 60000));
  const budgetMin = st.deadlineAt
    ? Math.max(0, Math.round((st.deadlineAt - now) / 60000))
    : cfg.maxMinutes > 0
      ? Math.max(0, cfg.maxMinutes - elapsedMin)
      : null;
  const lines = [`${MARK} Goal (${STATUS_LABEL[st.status]})`, `Objective: ${st.objective}`];
  if (st.criteria.length > 0) {
    lines.push(`Success criteria:\n${st.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`);
  }
  lines.push(
    `Attempts: ${st.iterations}/${st.maxIterations} (${remaining} left) · ${elapsedMin} min elapsed · ${budgetMin === null ? "no wall-clock deadline" : `~${budgetMin} min budget left`}`,
  );
  if (st.progress.length > 0) {
    lines.push(
      `Recent progress:\n${st.progress
        .slice(-3)
        .map((p) => `  - ${p.text}`)
        .join("\n")}`,
    );
  }
  if (st.lastSummary) lines.push(`Last summary: ${st.lastSummary}`);
  if (st.evidence) lines.push(`Evidence: ${truncate(st.evidence, 500)}`);
  if (st.blockedReason) lines.push(`Blocked: ${st.blockedReason}`);
  if (st.stoppedReason) lines.push(`Stopped: ${st.stoppedReason}`);
  return lines.join("\n");
}

/* ---------------------------------------------------------------- plugin */

export default Plugin.define({
  id: "goal",
  async setup(ctx) {
    const c = ctx as unknown as GoalCtx;
    if (
      !c.storage?.get ||
      !c.storage?.set ||
      !c.storage?.remove ||
      !c.session ||
      !c.event?.subscribe
    ) {
      console.error("[goal] required plugin APIs are unavailable; the goal loop is disabled.");
      return;
    }

    const cfg = resolveConfig(c.options);
    const live = new Map<string, GoalState>();
    // G6: in-flight loads are joined by concurrent callers instead of
    // silently returning undefined (which used to make commands no-op).
    const loading = new Map<string, Promise<GoalState | undefined>>();
    const inFlight = new Set<string>();
    const toolActivity = new Set<string>();
    /** GO-3/CR-5: session-keyed state is capped with oldest-first (FIFO)
     * eviction so a long-lived process cannot grow it without bound.
     * Related entries are evicted together to avoid half-state. */
    const MAX_SESSION_STATES = 500;
    const evictSessionStateIfFull = (): void => {
      while (live.size >= MAX_SESSION_STATES) {
        const oldest = live.keys().next();
        if (oldest.done) break;
        const sid = oldest.value as string;
        live.delete(sid);
        loading.delete(sid);
        inFlight.delete(sid);
        toolActivity.delete(sid);
      }
      while (loading.size > MAX_SESSION_STATES) {
        const oldest = loading.keys().next();
        if (oldest.done) break;
        loading.delete(oldest.value as string);
      }
      while (toolActivity.size > MAX_SESSION_STATES) {
        const oldest = toolActivity.values().next();
        if (oldest.done) break;
        toolActivity.delete(oldest.value);
      }
    };
    const disposers: Array<() => void | Promise<void>> = [];
    const track = (registration: Disposable | undefined): void => {
      if (registration && typeof registration.dispose === "function") {
        disposers.push(() => registration.dispose?.());
      }
    };

    const log = (message: string): void => {
      if (cfg.log) console.error(`[goal] ${message}`);
    };

    const note = async (sessionID: string, text: string): Promise<void> => {
      if (!cfg.notify) return;
      try {
        await c.session?.synthetic?.({ sessionID, text });
      } catch (err) {
        log(`failed to post note to ${sessionID}: ${describeError(err)}`);
      }
    };

    const save = async (st: GoalState): Promise<void> => {
      evictSessionStateIfFull();
      live.set(st.sessionID, st);
      try {
        await c.storage?.set?.(STORE_PREFIX + st.sessionID, st);
      } catch (err) {
        // GO-7: persistence loss must never be silent — the goal would look
        // set and vanish on reload. Always error, and surface it in the note
        // when notifications are on.
        const message = `failed to persist goal for ${st.sessionID}: ${describeError(err)}`;
        console.error(`[goal] ${message}`);
        if (cfg.notify) {
          try {
            await c.session?.synthetic?.({ sessionID: st.sessionID, text: `[goal-plugin] Warning: ${message}` });
          } catch {
            /* note is best-effort */
          }
        }
      }
    };

    const load = async (sessionID: string): Promise<GoalState | undefined> => {
      const cached = live.get(sessionID);
      if (cached) return cached;
      const inflight = loading.get(sessionID);
      if (inflight) return inflight;
      const read = (async () => {
        try {
          const raw = (await c.storage?.get?.(STORE_PREFIX + sessionID)) as GoalState | undefined;
          if (raw && typeof raw === "object" && typeof raw.objective === "string" && raw.status) {
            // GO-4: lastHandledMessageID compared both by value and by type
            // (dedupe/evaluate). Normalise to a string on load so a stored
            // number can never disagree with a string message id.
            raw.lastHandledMessageID =
              typeof raw.lastHandledMessageID === "string"
                ? raw.lastHandledMessageID
                : typeof raw.lastHandledMessageID === "number"
                  ? String(raw.lastHandledMessageID)
                  : "";
            evictSessionStateIfFull();
            live.set(sessionID, raw);
            return raw;
          }
          return undefined;
        } catch (err) {
          log(`failed to read goal for ${sessionID}: ${describeError(err)}`);
          return undefined;
        }
      })();
      loading.set(sessionID, read);
      try {
        return await read;
      } finally {
        loading.delete(sessionID);
      }
    };

    const clear = async (sessionID: string): Promise<void> => {
      live.delete(sessionID);
      try {
        await c.storage?.remove?.(STORE_PREFIX + sessionID);
      } catch (err) {
        log(`failed to clear goal for ${sessionID}: ${describeError(err)}`);
      }
    };

    const newGoal = (sessionID: string, objective: string, criteria: string[]): GoalState => {
      const now = Date.now();
      return {
        sessionID,
        objective,
        criteria,
        status: "active",
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        // GO-10: maxMinutes 0 means no wall-clock deadline.
        deadlineAt: cfg.maxMinutes > 0 ? now + cfg.maxMinutes * 60_000 : null,
        maxIterations: cfg.maxIterations,
        iterations: 0,
        failures: 0,
        stallCount: 0,
        lastSignature: "",
        lastHandledMessageID: "",
        progress: [],
      };
    };

    const kick = async (st: GoalState, noteText: string, kickoff: boolean): Promise<void> => {
      // G2: re-validate identity/status — queued events must not resurrect a
      // goal that was cleared, replaced, or paused in the meantime.
      if (live.get(st.sessionID) !== st || st.status !== "active") return;
      try {
        await c.session?.prompt?.({
          sessionID: st.sessionID,
          text: buildPrompt(st, cfg, { kickoff, note: noteText }),
        });
      } catch (err) {
        // G7: a queue failure (provider down, session gone) counts toward the
        // failure budget instead of silently stalling the loop.
        log(`failed to queue continuation for ${st.sessionID}: ${describeError(err)}`);
        st.failures += 1;
        st.updatedAt = Date.now();
        await save(st);
        if (st.failures >= cfg.maxFailures) {
          await stop(st, "failed", `${st.failures} consecutive continuation-queue errors.`);
        }
      }
    };

    const stop = async (st: GoalState, status: GoalStatus, reason: string): Promise<void> => {
      st.status = status;
      st.stoppedReason = reason;
      st.updatedAt = Date.now();
      await save(st);
      await note(
        st.sessionID,
        `${MARK} Goal ${STATUS_LABEL[status]}: ${reason}\nObjective: ${st.objective}\nAttempts: ${st.iterations}/${st.maxIterations}. Use \`/goal resume\` to continue or \`/goal clear\` to forget it.`,
      );
      log(`goal for ${st.sessionID} stopped: ${status} (${reason})`);
    };

    /** Latest assistant turn plus the user message that prompted it. */
    const lastTurn = async (
      sessionID: string,
    ): Promise<{ id: string; text: string; userText: string }> => {
      try {
        const messages = (await c.session?.context?.({ sessionID })) ?? [];
        let aiIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m?.role === "assistant" || m?.type === "assistant") {
            aiIdx = i;
            break;
          }
        }
        let userText = "";
        for (let i = aiIdx >= 0 ? aiIdx - 1 : messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "user") {
            userText = textOf(messages[i]);
            break;
          }
        }
        if (aiIdx < 0) return { id: "", text: "", userText };
        return { id: String(messages[aiIdx].id ?? ""), text: textOf(messages[aiIdx]), userText };
      } catch (err) {
        log(`session.context failed for ${sessionID}: ${describeError(err)}`);
      }
      return { id: "", text: "", userText: "" };
    };

    const evaluate = async (sessionID: string, failed: boolean): Promise<void> => {
      if (!cfg.enabled || inFlight.has(sessionID)) return;
      inFlight.add(sessionID);
      const toolsRan = toolActivity.delete(sessionID);
      try {
        const st = await load(sessionID);
        if (!st || st.status !== "active") return;

        const now = Date.now();
        if (st.iterations >= st.maxIterations) {
          await stop(st, "budget", `reached the attempt budget (${st.maxIterations}).`);
          return;
        }
        if (st.deadlineAt && now >= st.deadlineAt) {
          await stop(st, "timeout", `reached the time budget (${cfg.maxMinutes} min).`);
          return;
        }

        const last = await lastTurn(sessionID);

        // G1: failure accounting runs BEFORE the dedup early-return so a
        // duplicate idle/failed pair can never swallow failures (which used
        // to let maxFailures never accrue and the loop stall silently).
        if (failed) {
          st.failures += 1;
          st.updatedAt = now;
          await save(st);
          if (st.failures >= cfg.maxFailures) {
            await stop(st, "failed", `${st.failures} consecutive execution errors.`);
            return;
          }
        }

        // G12: an empty assistant id (session.context errors) is an unknown
        // turn — dedupe it briefly by time instead of double-counting the
        // paired idle/succeeded events.
        const knownID = last.id !== "";
        if (knownID) {
          if (last.id === st.lastHandledMessageID) return;
          st.lastHandledMessageID = last.id;
        } else {
          const fresh =
            st.lastHandledMessageID !== "(unknown)" ||
            now - (st.lastHandledAt ?? 0) > 15_000;
          if (!fresh) return;
          st.lastHandledMessageID = "(unknown)";
        }
        st.lastHandledAt = now;

        // A new assistant turn without an execution error means the previous
        // failures are behind us.
        if (!failed) st.failures = 0;

        // G9: only goal-originated turns (prompt carries MARK) continue the
        // loop — if the user took over, say so once and leave the goal alone.
        if (!last.userText.includes(MARK)) {
          if (!st.userTookOver) {
            st.userTookOver = true;
            st.updatedAt = now;
            await save(st);
            await note(
              sessionID,
              `${MARK} You took over this session, so the goal loop is not continuing automatically. Use \`/goal resume\` to keep working toward the objective.`,
            );
          } else {
            st.updatedAt = now;
            await save(st);
          }
          return;
        }
        st.userTookOver = false;

        // G10: stall = no tools this turn AND the reply repeats something
        // recent (catches A/B/A/B alternation, not just exact A/A repeats).
        // toolsRan was consumed at the top of evaluate so user-takeover and
        // other early returns cannot leak it into the next turn (GO-1).
        const sig = signature(last.text);
        const ring = st.recentSignatures ?? [];
        if (toolsRan) {
          st.stallCount = 0;
          ring.length = 0;
        } else if (ring.includes(sig)) {
          st.stallCount += 1;
        } else {
          st.stallCount = 0;
        }
        ring.push(sig);
        if (ring.length > 6) ring.shift();
        st.recentSignatures = ring;
        st.lastSignature = sig;
        if (st.stallCount >= cfg.stallLimit) {
          await stop(
            st,
            "stalled",
            `${st.stallCount} turns with no tool use and no change in the reply.`,
          );
          return;
        }

        st.iterations += 1;
        st.updatedAt = now;
        await save(st);
        await kick(
          st,
          failed ? "The previous attempt failed with an execution error; recover or change approach." : "",
          false,
        );
      } catch (err) {
        log(`evaluate failed for ${sessionID}: ${describeError(err)}`);
      } finally {
        inFlight.delete(sessionID);
      }
    };

    const interrupt = async (sessionID: string, reason = ""): Promise<void> => {
      const st = await load(sessionID);
      if (!st || st.status !== "active") return;
      st.status = "paused";
      st.pausedAt = Date.now();
      st.updatedAt = Date.now();
      await save(st);
      log(`goal paused for ${sessionID} (interrupt reason: ${reason || "unspecified"})`);
      await note(
        sessionID,
        `${MARK} Goal paused (the turn was interrupted${reason ? `: ${reason}` : ""}). Use \`/goal resume\` to keep going.`,
      );
    };

    /* --------------------------------------------------------- registration */

    // GO-11: each registration is guarded so one failure is logged and
    // setup continues with the rest instead of aborting the plugin.
    if (c.tool?.transform) {
      try {
        track(
          await c.tool.transform((editor) => {
            editor.add({
              name: "goal_complete",
              description:
                "Session-scoped: no-ops without an active goal in this session. Declare the active goal complete. Only call this when the objective and every success criterion is genuinely achieved and verified; include the checks you ran and their observed results as evidence.",
              input: z.object({
                summary: z.string().min(1).describe("One-line summary of what was accomplished."),
                evidence: z
                  .string()
                  .optional()
                  .describe("The exact commands/tests you ran and their results."),
              }),
              execute: (async (
                args: { summary: string; evidence?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No goal is set for this session." };
                if (st.status !== "active") {
                  return { content: `The goal is already ${STATUS_LABEL[st.status]}; nothing to complete.` };
                }
                const evidence = (args.evidence ?? "").trim();
                if (cfg.requireEvidence && !evidence) {
                  return {
                    content:
                      "Refused: `goal_complete` needs `evidence` — the exact commands/tests you ran and their observed results. Verify the goal first, then call again.",
                  };
                }
                st.status = "complete";
                st.lastSummary = args.summary.trim();
                if (evidence) st.evidence = evidence;
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content:
                    "Goal marked complete; the goal loop has stopped. Give the user a concise final summary now.",
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "goal_blocked",
              description:
                "Session-scoped: no-ops without an active goal in this session. Declare that the active goal cannot be completed without the user. Explains why the loop should stop.",
              input: z.object({
                reason: z.string().min(1).describe("Why you cannot proceed."),
                needs: z.string().optional().describe("What you need from the user to continue."),
              }),
              execute: (async (
                args: { reason: string; needs?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No goal is set for this session." };
                if (st.status !== "active") {
                  return { content: `The goal is already ${STATUS_LABEL[st.status]}; nothing to block.` };
                }
                st.status = "blocked";
                st.blockedReason = [args.reason.trim(), args.needs ? `Needs: ${args.needs.trim()}` : ""]
                  .filter(Boolean)
                  .join(" — ");
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content:
                    "Goal marked blocked; the goal loop has stopped. Tell the user the reason and what you need from them.",
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "goal_progress",
              description:
                "Session-scoped: no-ops without an active goal in this session. Record a milestone while working toward the active goal. Keeps the user informed and tells the goal loop that real progress is happening.",
              input: z.object({
                note: z.string().min(1).describe("What you just accomplished or learned."),
              }),
              execute: (async (args: { note: string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No goal is set for this session." };
                if (st.status !== "active") {
                  return { content: `The goal is ${STATUS_LABEL[st.status]}; progress was not recorded.` };
                }
                st.progress.push({ at: Date.now(), text: args.note.trim() });
                if (st.progress.length > MAX_PROGRESS) {
                  st.progress.splice(0, st.progress.length - MAX_PROGRESS);
                }
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Progress recorded (attempt ${st.iterations}/${st.maxIterations}). Keep going.`,
                };
              }) as AnyToolDef["execute"],
            });
          }),
        );
      } catch (err) {
        console.error(`[goal] tool.transform registration failed: ${describeError(err)}`);
      }
    }

    if (c.tool?.hook) {
      try {
        track(
          await c.tool.hook("execute.before", (event) => {
            const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
            if (!sessionID) return;
            const tool = typeof event?.tool === "string" ? event.tool : "";
            // G11: goal's own tools are not "progress" — counting them made
            // every turn look like tool activity and hid stalls.
            if (tool === "goal_complete" || tool === "goal_blocked" || tool === "goal_progress") {
              return;
            }
            // GO-3/CR-5: cap toolActivity with the same FIFO eviction.
            evictSessionStateIfFull();
            toolActivity.add(sessionID);
          }),
        );
      } catch (err) {
        console.error(`[goal] tool.hook registration failed: ${describeError(err)}`);
      }
    }

    if (c.session.hook) {
      // GO-11: a failed registration must not abort setup - log and continue.
      try {
        track(
          await c.session.hook("context", (event) => {
            if (!cfg.enabled) return;
            const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
            if (!sessionID) return;
            const messages = Array.isArray(event.messages) ? event.messages : [];
            // G4: ALWAYS strip stale goal reminders first — a paused, cleared,
            // or completed goal must not keep steering the model from context.
            // GO-6: strip only our own stale reminders — the unique sentinel
            // this hook injects, or a system message opening with the MARK
            // line (the legacy reminder format). Non-system text is never
            // inspected, so user text that merely mentions the plugin
            // survives.
            for (let i = messages.length - 1; i >= 0; i--) {
              const text = messages[i]?.role === "system" ? textOf(messages[i]) : "";
              if (
                text.includes(REMINDER_SENTINEL) ||
                text === MARK ||
                text.startsWith(MARK + "\n")
              ) {
                messages.splice(i, 1);
              }
            }
            const st = live.get(sessionID);
            if (!st) {
              // GO-5: the first context call after a reload misses the reminder
              // by design — live state is empty until the storage read above
              // resolves, so this miss pre-warms it and the NEXT request
              // injects. A goal is never lost, just one request late.
              if (!live.has(sessionID)) void load(sessionID).catch((err) => log(`pre-warm load failed for ${sessionID}: ${describeError(err)}`));
              return;
            }
            if (st.status !== "active") return;
            messages.push({
              role: "system",
              content: [{ type: "text", text: `${REMINDER_SENTINEL}\n${MARK}\n${buildReminder(st, cfg)}` }],
            });
          }),
        );
      } catch (err) {
        console.error(`[goal] session.hook registration failed: ${describeError(err)}`);
      }
    }

    if (c.command?.transform) {
      // GO-11: a failed registration must not abort setup - log and continue.
      try {
        track(
          await c.command.transform((editor) => {
            editor.add({
              name: "goal",
              description: "Set and manage an objective the model works toward until it is reached.",
              execute: async ({ sessionID, prompt }) => {
                if (!cfg.enabled) {
                  await note(sessionID, `${MARK} The goal plugin is disabled (enabled=false).`);
                  return;
                }
                const { verb, arg } = parseCommand(prompt?.text ?? "");
                switch (verb) {
                  case "help":
                    await note(sessionID, HELP);
                    return;
                  case "status": {
                    const st = await load(sessionID);
                    await note(sessionID, st ? statusText(st, cfg) : NO_GOAL);
                    return;
                  }
                  case "pause": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_GOAL));
                    if (st.status !== "active") {
                      return void (await note(sessionID, `${MARK} Goal is already ${STATUS_LABEL[st.status]}.`));
                    }
                    st.status = "paused";
                    st.pausedAt = Date.now();
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(
                      sessionID,
                      `${MARK} Paused. The current turn will finish but the loop will not continue. Use \`/goal resume\` to keep going.`,
                    );
                    return;
                  }
                  case "resume": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_GOAL));
                    // G3: extend the wall-clock budget by the paused span so a
                    // long pause doesn't instantly trip the timeout on resume.
                    if (st.deadlineAt) {
                      const pausedAt = st.pausedAt ?? st.updatedAt;
                      st.deadlineAt += Math.max(0, Date.now() - pausedAt);
                    }
                    // GO-9: remove the key instead of assigning undefined, so
                    // persisted state never carries a pausedAt field.
                    delete st.pausedAt;
                    st.status = "active";
                    st.failures = 0;
                    st.stallCount = 0;
                    st.userTookOver = false;
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Resumed.`);
                    await kick(st, "The goal was resumed by the user.", false);
                    return;
                  }
                  case "done": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_GOAL));
                    st.status = "complete";
                    st.lastSummary = "Marked complete by the user.";
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Goal marked complete; the loop is stopped.`);
                    return;
                  }
                  case "clear": {
                    await clear(sessionID);
                    await note(sessionID, `${MARK} Goal cleared.`);
                    return;
                  }
                  default: {
                    const goal = parseGoalText(arg);
                    if (!goal.objective) return void (await note(sessionID, HELP));
                    const st = newGoal(sessionID, goal.objective, goal.criteria);
                    await save(st);
                    await note(
                      sessionID,
                      `${MARK} Goal set.\nObjective: ${st.objective}\nBudget: ${st.maxIterations} attempts${cfg.maxMinutes > 0 ? ` / ${cfg.maxMinutes} min` : " (no wall-clock deadline)"}.`,
                    );
                    await kick(st, "", true);
                    return;
                  }
                }
              },
            });
          }),
        );
      } catch (err) {
        console.error(`[goal] command registration failed: ${describeError(err)}`);
      }
    }

    if (cfg.log) {
      console.error(
        `[goal] ready (max ${cfg.maxIterations} attempts, ${cfg.maxMinutes} min, stall limit ${cfg.stallLimit}).`,
      );
    }

    /* ------------------------------------------------------------ event loop */

    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of c.event!.subscribe!({ signal: abort.signal })) {
          if (!cfg.enabled) continue;
          const type = String(event?.type ?? "");
          const data = (event?.data ?? {}) as Record<string, unknown>;
          const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
          if (!sessionID) continue;
          if (type === "session.execution.interrupted") {
            // G5: branch on the interrupt reason so superseded/inactivity
            // interrupts are visible in the pause note and logs.
            const reason = typeof data.reason === "string" ? data.reason : "";
            void interrupt(sessionID, reason).catch((err) => console.error(`[goal] interrupt failed for ${sessionID}: ${describeError(err)}`));
          } else if (type === "session.idle" || type === "session.execution.succeeded") {
            void evaluate(sessionID, false).catch((err) => console.error(`[goal] evaluate failed for ${sessionID}: ${describeError(err)}`));
          } else if (type === "session.execution.failed") {
            void evaluate(sessionID, true).catch((err) => console.error(`[goal] evaluate failed for ${sessionID}: ${describeError(err)}`));
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) console.error(`[goal] event stream ended: ${describeError(err)}`);
      }
    })();

    return async () => {
      abort.abort();
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          /* best effort */
        }
      }
    };
  },
});
