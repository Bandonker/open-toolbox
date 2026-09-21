import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import {
  asBool,
  clampInt,
  deriveTitle,
  describeError,
  type ModelRef,
  parseJsonFromText,
  parseModelString,
  schemaInstruction,
  shortId,
  truncate,
} from "./helpers.ts";

/**
 * opencode-sessions (v2)
 *
 * Lets the current agent spawn fresh child sessions, brief them, wait for them
 * (without blocking the server event loop), read their results, send follow-ups,
 * hand off the current working point into a new session, and cancel them.
 *
 * Every session created here is a REAL opencode session, so it shows up in the
 * Desktop session list / tab switcher exactly as if the user had hit `+`.
 *
 * Non-blocking strategy:
 *   - spawn uses `session.prompt` (returns the inbox entry once queued) and
 *     returns immediately.
 *   - completion is observed through `event.subscribe` (`session.idle` /
 *     `session.execution.*`), never by awaiting a long request inside the tool.
 *   - `wait:true` / `session_result(wait:true)` register a promise that the
 *     event loop resolves, with a timeout that interrupts the child.
 *   - results are read back with `session.context`, not from events.
 */

type SessionState =
  | "starting"
  | "running"
  | "idle"
  | "error"
  | "cancelled"
  | "timeout";

type SessionOutcome = {
  sessionId: string;
  status: SessionState;
  text?: string;
  partial?: string;
  structured?: unknown;
  error?: string;
  title?: string;
  agentMode?: string;
  elapsedSec?: number;
};

type Waiter = {
  resolve: (outcome: SessionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Tracked = {
  childID: string;
  parentSessionID: string;
  shortId: string;
  title: string;
  state: SessionState;
  createdAt: number;
  startedAt: number;
  idleAt?: number;
  lastActivityAt: number;
  agent?: string;
  agentMode?: string;
  model?: ModelRef;
  directory?: string;
  schema?: Record<string, unknown>;
  resultText?: string;
  structured?: unknown;
  errorText?: string;
  pendingPermission?: string;
  pendingPermissionId?: string;
  injected: boolean;
  waiters: Waiter[];
};

type ResolvedConfig = {
  maxConcurrentSessions: number;
  maxSessionsPerParent: number;
  defaultTimeoutSec: number;
  hardTimeoutSec: number;
  titlePrefix: string;
  autoInjectParent: boolean;
  maxInjectChars: number;
  injectPermissionNotices: boolean;
  inheritParentDefaults: boolean;
  pruneTerminalAfterSec: number;
  maxTrackedSessions: number;
  autoApprovePermissions: "never" | "once" | "always";
};

const TERMINAL: ReadonlySet<SessionState> = new Set([
  "idle",
  "error",
  "cancelled",
  "timeout",
]);

function isTerminal(state: SessionState): boolean {
  return TERMINAL.has(state);
}

function resolveConfig(options: Record<string, unknown> | undefined): ResolvedConfig {
  const o = options ?? {};
  const env = (key: string) => process.env[key];
  return {
    maxConcurrentSessions: clampInt(
      o.maxConcurrentSessions ?? env("OPENCODE_SESSIONS_MAX_CONCURRENT"),
      3,
      1,
      64,
    ),
    maxSessionsPerParent: clampInt(
      o.maxSessionsPerParent ?? env("OPENCODE_SESSIONS_MAX_PER_PARENT"),
      3,
      1,
      64,
    ),
    defaultTimeoutSec: clampInt(
      o.defaultTimeoutSec ?? env("OPENCODE_SESSIONS_TIMEOUT_SEC"),
      900,
      1,
      86_400,
    ),
    hardTimeoutSec: clampInt(
      o.hardTimeoutSec ?? env("OPENCODE_SESSIONS_HARD_TIMEOUT_SEC"),
      1800,
      1,
      86_400,
    ),
    titlePrefix:
      typeof o.titlePrefix === "string" && o.titlePrefix
        ? o.titlePrefix
        : "[spawned",
    autoInjectParent: asBool(o.autoInjectParent, true),
    maxInjectChars: clampInt(o.maxInjectChars, 4000, 200, 100_000),
    injectPermissionNotices: asBool(o.injectPermissionNotices, true),
    inheritParentDefaults: asBool(o.inheritParentDefaults, true),
    pruneTerminalAfterSec: clampInt(
      o.pruneTerminalAfterSec ?? env("OPENCODE_SESSIONS_PRUNE_AFTER_SEC"),
      3600,
      0,
      86_400,
    ),
    maxTrackedSessions: clampInt(
      o.maxTrackedSessions ?? env("OPENCODE_SESSIONS_MAX_TRACKED"),
      200,
      1,
      10_000,
    ),
    autoApprovePermissions: ((): "never" | "once" | "always" => {
      const raw = o.autoApprovePermissions ?? env("OPENCODE_SESSIONS_AUTO_APPROVE");
      return raw === "once" || raw === "always" ? raw : "never";
    })(),
  };
}

export default Plugin.define({
  id: "opencode-sessions",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);
    const defaultDirectory = ctx.location.directory;
    const tracked = new Map<string, Tracked>();
    /** Cached parent agent/model defaults, keyed by parent session id. */
    const parentDefaults = new Map<string, { agent?: string; model?: ModelRef }>();

    const log = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      extra?: Record<string, unknown>,
    ): void => {
      try {
        // No ctx.app.log in v2 — stderr is captured in the server log.
        console.error(
          `[opencode-sessions] ${level}: ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
        );
      } catch {
        /* logging must never break orchestration */
      }
    };

    log("info", "opencode-sessions plugin loaded", {
      maxConcurrentSessions: cfg.maxConcurrentSessions,
      maxSessionsPerParent: cfg.maxSessionsPerParent,
      defaultTimeoutSec: cfg.defaultTimeoutSec,
      hardTimeoutSec: cfg.hardTimeoutSec,
      titlePrefix: cfg.titlePrefix,
      inheritParentDefaults: cfg.inheritParentDefaults,
      maxTrackedSessions: cfg.maxTrackedSessions,
      pruneTerminalAfterSec: cfg.pruneTerminalAfterSec,
      autoApprovePermissions: cfg.autoApprovePermissions,
    });

    const activeCount = (): number => {
      let n = 0;
      for (const t of tracked.values()) {
        if (t.state === "starting" || t.state === "running") n += 1;
      }
      return n;
    };

    const activeForParent = (parentID: string): number => {
      let n = 0;
      for (const t of tracked.values()) {
        if (
          t.parentSessionID === parentID &&
          (t.state === "starting" || t.state === "running")
        ) {
          n += 1;
        }
      }
      return n;
    };

    /**
     * Keep the tracked map bounded: drop old terminal entries, then evict the
     * oldest terminal entries if still over `maxTrackedSessions`. Live sessions
     * and sessions with pending waiters are never pruned.
     */
    const pruneTracked = (): void => {
      if (cfg.pruneTerminalAfterSec > 0) {
        const cutoff = Date.now() - cfg.pruneTerminalAfterSec * 1000;
        for (const [id, t] of tracked) {
          if (
            isTerminal(t.state) &&
            t.waiters.length === 0 &&
            (t.idleAt ?? t.lastActivityAt) < cutoff
          ) {
            tracked.delete(id);
          }
        }
      }
      if (tracked.size <= cfg.maxTrackedSessions) return;
      const terminal = [...tracked.values()]
        .filter((t) => isTerminal(t.state) && t.waiters.length === 0)
        .sort((a, b) => (a.idleAt ?? a.lastActivityAt) - (b.idleAt ?? b.lastActivityAt));
      for (const t of terminal) {
        if (tracked.size <= cfg.maxTrackedSessions) break;
        tracked.delete(t.childID);
      }
    };

    const touch = (t: Tracked): void => {
      t.lastActivityAt = Date.now();
    };

    const outcomeOf = (t: Tracked): SessionOutcome => ({
      sessionId: t.childID,
      status: t.state,
      text: t.resultText,
      structured: t.structured,
      error: t.errorText,
      title: t.title,
      agentMode: t.agentMode,
      elapsedSec: Math.round(((t.idleAt ?? Date.now()) - t.startedAt) / 1000),
    });

    const settleWaiters = (t: Tracked): number => {
      const waiters = t.waiters.splice(0, t.waiters.length);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(outcomeOf(t));
      }
      return waiters.length;
    };

    /** Post a completion note to the parent without triggering a reply turn. */
    const postToParent = async (t: Tracked, text: string): Promise<void> => {
      try {
        await ctx.session.synthetic({
          sessionID: t.parentSessionID,
          text,
        });
        t.injected = true;
      } catch (err) {
        log("warn", `failed to inject into parent ${t.parentSessionID}`, {
          error: describeError(err),
        });
      }
    };

    const buildCompletionNote = (t: Tracked): string => {
      const label = `${cfg.titlePrefix}:${t.shortId}]`;
      const head = `${label} child session ${t.childID} finished with status "${t.state}".`;
      const parts = [head];
      if (t.errorText) parts.push(`Error: ${t.errorText}`);
      if (t.structured !== undefined) {
        parts.push(`Structured output:\n${truncate(JSON.stringify(t.structured, null, 2), cfg.maxInjectChars)}`);
      }
      if (t.resultText) {
        parts.push(`Final message:\n${truncate(t.resultText, cfg.maxInjectChars)}`);
      }
      parts.push(`Use session_result("${t.childID}") for the full result or session_send for a follow-up. It is also visible in the Desktop session switcher.`);
      return parts.join("\n\n");
    };

    /** Pull text out of a v2 assistant message's content parts. */
    const assistantTextOf = (msg: {
      content?: Array<{ type: string; text?: string }>;
    }): string =>
      (msg.content ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();

    /**
     * Read the child's last assistant turn via `session.context`.
     * Falls back to whatever was already recorded when the read fails.
     */
    const fetchOutcome = async (
      childID: string,
    ): Promise<{ text: string; structured?: unknown; error?: string }> => {
      try {
        const messages = await ctx.session.context({ sessionID: childID });
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i] as unknown as {
            type: string;
            content?: Array<{ type: string; text?: string }>;
            error?: unknown;
          };
          if (m.type !== "assistant") continue;
          const text = assistantTextOf(m);
          const error = m.error ? describeError(m.error) : undefined;
          return { text, error };
        }
        return { text: "" };
      } catch (err) {
        log("debug", `session.context unreadable for ${childID}`, {
          error: describeError(err),
        });
        return { text: "" };
      }
    };

    const handleIdle = async (t: Tracked): Promise<void> => {
      if (t.state !== "running" && t.state !== "starting") return;
      t.state = "idle";
      t.idleAt = Date.now();
      touch(t);
      try {
        const o = await fetchOutcome(t.childID);
        t.resultText = o.text;
        if (o.error) t.errorText = o.error;
        if (t.schema && o.text) {
          const parsed = parseJsonFromText(o.text);
          if (parsed !== undefined) t.structured = parsed;
        }
        if (t.schema && t.structured === undefined && !t.errorText) {
          t.errorText =
            "StructuredOutputError: no parseable JSON found in the final message";
        }
      } catch (err) {
        t.errorText = describeError(err);
      }
      const hadWaiter = settleWaiters(t) > 0;
      if (cfg.autoInjectParent && !hadWaiter) {
        await postToParent(t, buildCompletionNote(t));
      }
      log("info", `child ${t.childID} idle`, {
        status: t.state,
        hadWaiter,
        structured: t.structured !== undefined,
      });
      pruneTracked();
    };

    const handleError = async (t: Tracked, err: unknown): Promise<void> => {
      if (isTerminal(t.state)) return;
      t.state = "error";
      t.errorText = describeError(err);
      touch(t);
      try {
        const o = await fetchOutcome(t.childID);
        if (o.text) t.resultText = o.text;
        if (o.error && !t.errorText) t.errorText = o.error;
      } catch {
        /* ignore */
      }
      settleWaiters(t);
      if (cfg.autoInjectParent) await postToParent(t, buildCompletionNote(t));
      log("warn", `child ${t.childID} errored`, { error: t.errorText });
      pruneTracked();
    };

    const handleInterrupted = async (t: Tracked): Promise<void> => {
      if (isTerminal(t.state)) return;
      t.state = "cancelled";
      t.errorText = t.errorText ?? "Session was interrupted.";
      t.idleAt = Date.now();
      touch(t);
      try {
        const o = await fetchOutcome(t.childID);
        if (o.text) t.resultText = o.text;
      } catch {
        /* ignore */
      }
      const hadWaiter = settleWaiters(t) > 0;
      if (cfg.autoInjectParent && !hadWaiter) {
        await postToParent(t, buildCompletionNote(t));
      }
      pruneTracked();
    };

    const waitFor = (t: Tracked, timeoutSec: number): Promise<SessionOutcome> => {
      if (isTerminal(t.state)) return Promise.resolve(outcomeOf(t));
      const ms = Math.min(timeoutSec, cfg.hardTimeoutSec) * 1000;
      return new Promise<SessionOutcome>((resolve) => {
        const timer = setTimeout(() => {
          const idx = t.waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) t.waiters.splice(idx, 1);
          if (!isTerminal(t.state)) {
            t.state = "timeout";
            t.errorText = `Timed out after ${Math.round(ms / 1000)}s; interrupted child.`;
            void ctx.session.interrupt({ sessionID: t.childID }).catch(() => undefined);
          }
          resolve(outcomeOf(t));
        }, ms);
        t.waiters.push({ resolve, timer });
      });
    };

    const formatOutcome = (o: SessionOutcome, t?: Tracked): string => {
      const running = o.status === "running" || o.status === "starting";
      const lines = [`sessionId: ${o.sessionId}`, `status: ${o.status}`];
      if (t) lines.push(`title: ${t.title}`);
      if (t?.agentMode) lines.push(`agent_mode: ${t.agentMode}`);
      if (typeof o.elapsedSec === "number") lines.push(`elapsed_sec: ${o.elapsedSec}`);
      if (t?.directory) lines.push(`directory: ${t.directory}`);
      if (t?.pendingPermission) lines.push(`pending_permission: ${t.pendingPermission}`);
      if (o.error) lines.push(`error: ${o.error}`);
      if (o.structured !== undefined) {
        lines.push("structured_output:");
        lines.push(JSON.stringify(o.structured, null, 2));
      }
      if (running) {
        if (o.partial) {
          lines.push("partial_message:");
          lines.push(o.partial);
        }
      } else if (o.text) {
        lines.push("final_message:");
        lines.push(o.text);
      }
      if (!o.text && o.structured === undefined && !o.error && !running) {
        lines.push("(no assistant output yet)");
      }
      lines.push("Tip: this session is visible in the Desktop session switcher.");
      return lines.join("\n");
    };

    /** Last assistant agent/model seen in the parent session (cached per parent). */
    const parentDefaultsFor = async (
      parentID: string,
    ): Promise<{ agent?: string; model?: ModelRef }> => {
      const cached = parentDefaults.get(parentID);
      if (cached) return cached;
      const result: { agent?: string; model?: ModelRef } = {};
      try {
        const messages = await ctx.session.context({ sessionID: parentID });
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i] as unknown as {
            type: string;
            agent?: string;
            model?: { id: string; providerID: string };
          };
          if (m.type === "assistant") {
            if (m.model) {
              result.model = { providerID: m.model.providerID, modelID: m.model.id };
            }
            if (m.agent) result.agent = m.agent;
            break;
          }
        }
      } catch {
        /* parent context unreadable; leave defaults unset */
      }
      parentDefaults.set(parentID, result);
      return result;
    };

    const resolveTarget = async (
      agentName: string | undefined,
      modelStr: string | undefined,
      parentID: string,
    ): Promise<{ agent?: string; model?: ModelRef; agentMode?: string; error?: string }> => {
      let agents: Array<{ name: string; model?: ModelRef; mode?: string }> = [];
      try {
        const res = (await ctx.agent.list()) as unknown as {
          data?: Array<{
            name: string;
            model?: { id: string; providerID: string };
            mode?: string;
          }>;
        };
        agents = (res.data ?? []).map((a) => ({
          name: a.name,
          model: a.model ? { providerID: a.model.providerID, modelID: a.model.id } : undefined,
          mode: a.mode,
        }));
      } catch (err) {
        log("warn", "agent.list failed; skipping agent validation", {
          error: describeError(err),
        });
      }
      let agent: { name: string; model?: ModelRef; mode?: string } | undefined;
      if (agentName) {
        const found = agents.find((a) => a.name === agentName);
        if (!found && agents.length > 0) {
          return {
            error: `Unknown agent "${agentName}". Available: ${agents
              .map((a) => a.name)
              .join(", ")}`,
          };
        }
        if (found) agent = { name: found.name, model: found.model, mode: found.mode };
        else agent = { name: agentName };
      }

      let model: ModelRef | undefined;
      if (modelStr) {
        const parsed = parseModelString(modelStr);
        if ("error" in parsed) return { error: parsed.error };
        try {
          const res = (await ctx.model.list()) as unknown as {
            data?: Array<{ providerID: string; modelID: string }>;
          };
          const models = res.data ?? [];
          if (
            models.length > 0 &&
            !models.some(
              (m) => m.providerID === parsed.providerID && m.modelID === parsed.modelID,
            )
          ) {
            return {
              error: `Unknown model "${parsed.modelID}" for provider "${parsed.providerID}".`,
            };
          }
        } catch (err) {
          log("warn", "model.list failed; skipping model validation", {
            error: describeError(err),
          });
        }
        model = parsed;
      } else if (agent?.model) {
        model = agent.model;
      } else if (cfg.inheritParentDefaults) {
        const inherited = await parentDefaultsFor(parentID);
        model = inherited.model;
        if (!agent && inherited.agent) {
          const found = agents.find((a) => a.name === inherited.agent);
          if (found) agent = { name: found.name, model: found.model, mode: found.mode };
        }
      }
      if (!model && cfg.inheritParentDefaults) {
        model = (await parentDefaultsFor(parentID)).model;
      }
      if (!model) {
        try {
          const res = (await ctx.model.default()) as unknown as {
            data?: { providerID: string; modelID: string } | null;
          };
          if (res.data) {
            model = { providerID: res.data.providerID, modelID: res.data.modelID };
          }
        } catch {
          /* leave model undefined; server picks its default */
        }
      }
      return { agent: agent?.name, model, agentMode: agent?.mode };
    };

    /** Fire-and-forget: queue the child's turn and return immediately. */
    const startTurn = async (t: Tracked, text: string): Promise<void> => {
      try {
        await ctx.session.prompt({ sessionID: t.childID, text });
        if (t.state === "starting") t.state = "running";
        log("debug", `child ${t.childID} prompt accepted`, { state: t.state });
      } catch (err) {
        await handleError(t, err);
      }
    };

    /**
     * Rebuild a `Tracked` entry from server state when it is missing from the
     * in-memory map (e.g. the plugin/server restarted but the child session is
     * still around). Only title-marked sessions are adopted.
     */
    const hydrate = async (sessionId: string): Promise<Tracked | undefined> => {
      const existing = tracked.get(sessionId);
      if (existing) return existing;
      let info:
        | { id?: string; title?: string; parentID?: string; metadata?: Record<string, unknown> }
        | undefined;
      try {
        info = (await ctx.session.get({ sessionID: sessionId })) as unknown as typeof info;
      } catch {
        return undefined;
      }
      const title = typeof info?.title === "string" ? info.title : "";
      const metaParent =
        info?.metadata && typeof info.metadata["parentSessionID"] === "string"
          ? (info.metadata["parentSessionID"] as string)
          : undefined;
      if (!info?.id || (!title.startsWith(cfg.titlePrefix) && !metaParent)) {
        return undefined;
      }
      const tail = title.slice(cfg.titlePrefix.length);
      const short = tail.match(/^:([A-Za-z0-9]+)\]/)?.[1] ?? "adopted";
      const t: Tracked = {
        childID: sessionId,
        parentSessionID: info.parentID ?? metaParent ?? "",
        shortId: short,
        title: title || sessionId,
        state: "idle",
        createdAt: Date.now(),
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        injected: false,
        waiters: [],
      };
      tracked.set(sessionId, t);
      log("debug", `adopted child ${sessionId} from server state`, {
        parent: t.parentSessionID,
      });
      return t;
    };

    const requireTracked = async (
      sessionId: string,
    ): Promise<{ t: Tracked } | { message: string }> => {
      const t = tracked.get(sessionId) ?? (await hydrate(sessionId));
      if (!t) {
        return {
          message: `Unknown session "${sessionId}". Only sessions created by this plugin (titles starting with "${cfg.titlePrefix}") are tracked. Use list_sessions to see them.`,
        };
      }
      return { t };
    };

    /** Shared create + brief + optional-wait flow for spawn and handoff. */
    const launch = async (opts: {
      parentID: string;
      promptText: string;
      titleText: string;
      agentName?: string;
      modelStr?: string;
      directory?: string;
      wait?: boolean;
      timeoutSec?: number;
      schema?: Record<string, unknown>;
      label: string;
    }): Promise<string> => {
      if (activeCount() >= cfg.maxConcurrentSessions) {
        return `Refused: concurrency limit reached (${cfg.maxConcurrentSessions} active child sessions). Wait for one to finish or call session_cancel.`;
      }
      if (activeForParent(opts.parentID) >= cfg.maxSessionsPerParent) {
        return `Refused: per-parent limit reached (${cfg.maxSessionsPerParent} active children for this session).`;
      }
      pruneTracked();
      const timeoutSec = clampInt(
        opts.timeoutSec,
        cfg.defaultTimeoutSec,
        1,
        cfg.hardTimeoutSec,
      );

      const target = await resolveTarget(opts.agentName, opts.modelStr, opts.parentID);
      if (target.error) return `Refused: ${target.error}`;

      const sid = shortId();
      const title = `${cfg.titlePrefix}:${sid}] ${opts.titleText}`;

      let childID: string;
      try {
        const created = await ctx.session.create({
          title,
          ...(target.agent ? { agent: target.agent } : {}),
          ...(target.model
            ? { model: { id: target.model.modelID, providerID: target.model.providerID } }
            : {}),
          ...(opts.directory ? { location: { directory: opts.directory } } : {}),
          metadata: { parentSessionID: opts.parentID, spawnedBy: "opencode-sessions" },
        });
        childID = created.id;
      } catch (err) {
        return `Failed to create child session: ${describeError(err)}`;
      }

      const t: Tracked = {
        childID,
        parentSessionID: opts.parentID,
        shortId: sid,
        title,
        state: "starting",
        createdAt: Date.now(),
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        agent: target.agent,
        agentMode: target.agentMode,
        model: target.model,
        directory: opts.directory,
        schema: opts.schema,
        injected: false,
        waiters: [],
      };
      tracked.set(childID, t);

      let text = opts.promptText;
      if (opts.schema) text += schemaInstruction(opts.schema);
      void startTurn(t, text);

      const warnings: string[] = [];
      if (target.agentMode === "primary") {
        warnings.push(
          `Note: agent "${target.agent}" is a primary agent; running it as a child session may not be intended.`,
        );
      }
      if (!target.model) {
        warnings.push("Note: no model could be resolved; the server default will be used.");
      }
      const warn = warnings.length ? `\n${warnings.join("\n")}` : "";

      if (!opts.wait) {
        return (
          `${opts.label} child session ${childID} (title: ${title}) with status "running". ` +
          `It runs in the background and appears in the Desktop session switcher like a session opened with +. ` +
          `Its result will be injected into this session when it goes idle. ` +
          `Use session_result("${childID}", wait:true) to block for it.${warn}`
        );
      }

      const outcome = await waitFor(t, timeoutSec);
      const formatted = formatOutcome(outcome, t);
      return warn ? `${formatted}${warn}` : formatted;
    };

    /** Compact transcript of a session for handoff briefs. */
    const buildTranscript = async (
      sessionID: string,
      messageLimit: number,
    ): Promise<string> => {
      const limit = Math.min(Math.max(messageLimit, 1), 100);
      let messages: Array<{
        type: string;
        text?: string;
        content?: Array<{ type: string; text?: string }>;
      }> = [];
      try {
        messages = (await ctx.session.context({ sessionID })) as unknown as typeof messages;
      } catch (err) {
        return `(could not read current session context: ${describeError(err)})`;
      }
      const tail = messages.slice(-limit);
      const lines: string[] = [];
      for (const m of tail) {
        if (m.type === "user") {
          lines.push(`User: ${truncate(m.text ?? "", 2000)}`);
        } else if (m.type === "assistant") {
          lines.push(`Assistant: ${truncate(assistantTextOf(m), 2000)}`);
        } else if (m.type === "synthetic") {
          lines.push(`Note: ${truncate(m.text ?? "", 1000)}`);
        }
      }
      const out = lines.join("\n\n").trim();
      return out
        ? truncate(out, 12_000)
        : "(no user/assistant messages in this session yet)";
    };

    const abort = new AbortController();
    const pump = (async (): Promise<void> => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          const ev = raw as unknown as { type?: string; data?: Record<string, unknown> };
          try {
            const type = typeof ev.type === "string" ? ev.type : "";
            const data = (ev.data ?? {}) as Record<string, unknown>;
            const sessionID =
              typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined;
            if (type === "session.idle" || type === "session.execution.succeeded") {
              if (!sessionID) continue;
              const t = tracked.get(sessionID);
              if (t) await handleIdle(t);
              continue;
            }
            if (type === "session.execution.failed") {
              if (!sessionID) continue;
              const t = tracked.get(sessionID);
              if (t) {
                const d = data as { error?: unknown };
                await handleError(t, d.error ?? "session execution failed");
              }
              continue;
            }
            if (type === "session.execution.interrupted") {
              if (!sessionID) continue;
              const t = tracked.get(sessionID);
              if (t) await handleInterrupted(t);
              continue;
            }
            if (type === "permission.asked") {
              const d = data as {
                id?: string;
                sessionID?: string;
                action?: string;
                message?: string;
              };
              if (!d.sessionID) continue;
              const t = tracked.get(d.sessionID);
              if (!t) continue;
              const label =
                d.message ?? (d.action ? `permission: ${d.action}` : "permission");
              t.pendingPermission = label;
              t.pendingPermissionId = d.id;
              touch(t);
              if (cfg.autoApprovePermissions !== "never" && d.id) {
                try {
                  await ctx.permission.reply({
                    sessionID: t.childID,
                    requestID: d.id,
                    decision: cfg.autoApprovePermissions,
                  });
                  t.pendingPermission = undefined;
                  t.pendingPermissionId = undefined;
                  log("info", `auto-approved permission for child ${t.childID}`, {
                    response: cfg.autoApprovePermissions,
                  });
                } catch (err) {
                  log("warn", `auto-approve failed for child ${t.childID}`, {
                    error: describeError(err),
                  });
                }
              }
              if (cfg.autoInjectParent && cfg.injectPermissionNotices) {
                await postToParent(
                  t,
                  `${cfg.titlePrefix}:${t.shortId}] child ${t.childID} is waiting on a permission prompt: "${label}"${
                    d.id ? ` (id ${d.id})` : ""
                  }. Answer it with session_permission("${t.childID}", response: "once"|"always"|"reject"), or call session_cancel("${t.childID}") to abort.`,
                );
              }
              continue;
            }
          } catch (err) {
            log("error", "event handler failed", {
              error: describeError(err),
              type: ev.type,
            });
          }
        }
      } catch {
        /* subscribe ends on abort; anything else is already logged per-event */
      }
    })();
    void pump;

    const spawnSchema = z.object({
      prompt: z.string().describe("The brief / task sent as the child's first user message."),
      title: z.string().optional().describe("Human title; a short id is prepended automatically."),
      agent: z.string().optional().describe("Agent name to run the child with (validated against available agents)."),
      model: z.string().optional().describe('Model as "providerID/modelID" (validated against configured providers).'),
      directory: z.string().optional().describe("Working directory for the child session (defaults to this project)."),
      wait: z.boolean().optional().describe("If true, wait for the child to go idle before returning (default false)."),
      timeoutSec: z.number().optional().describe("Wait timeout in seconds (default 900, hard cap enforced)."),
      schema: z.record(z.string(), z.any()).optional().describe("Optional JSON Schema; the child is instructed to answer with conforming JSON, which surfaces as structured_output."),
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "spawn_session",
        description:
          "Spawn a fresh child session, brief it with a prompt, and (optionally) wait for it to finish. Non-blocking: the child runs in its own session while this agent stays responsive, and it appears in the Desktop session switcher as if opened with +. Returns a sessionId for session_result/session_send/session_cancel.",
        input: spawnSchema,
        execute: async (input, toolCtx) => {
          const args = input as z.infer<typeof spawnSchema>;
          const parentID = toolCtx.sessionID;
          const out = await launch({
            parentID,
            promptText: args.prompt,
            titleText: args.title?.trim() || deriveTitle(args.prompt),
            agentName: args.agent,
            modelStr: args.model,
            directory: args.directory ?? defaultDirectory,
            wait: args.wait,
            timeoutSec: args.timeoutSec,
            schema: args.schema as Record<string, unknown> | undefined,
            label: "Spawned",
          });
          return { content: out };
        },
      });

      editor.add({
        name: "session_result",
        description:
          "Get the status of a spawned child session and, if it is idle, its final assistant text and/or structured_output. Set wait:true to wait for completion.",
        input: z.object({
          sessionId: z.string().describe("Child session id returned by spawn_session."),
          wait: z.boolean().optional().describe("Wait until the child is idle/terminal or the timeout elapses."),
          timeoutSec: z.number().optional().describe("Wait timeout in seconds."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; wait?: boolean; timeoutSec?: number };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;

          if (args.wait && !isTerminal(t.state)) {
            const timeoutSec = clampInt(
              args.timeoutSec,
              cfg.defaultTimeoutSec,
              1,
              cfg.hardTimeoutSec,
            );
            const outcome = await waitFor(t, timeoutSec);
            return { content: formatOutcome(outcome, t) };
          }

          if (!isTerminal(t.state)) {
            const o = await fetchOutcome(t.childID);
            if (o.text) {
              t.resultText = o.text;
              touch(t);
            }
            if (o.error && !t.errorText) t.errorText = o.error;
            const partial = t.resultText;
            return {
              content: formatOutcome({ ...outcomeOf(t), partial }, t),
            };
          }
          if (!t.resultText && t.structured === undefined) {
            const o = await fetchOutcome(t.childID);
            if (o.text) t.resultText = o.text;
            if (o.error && !t.errorText) t.errorText = o.error;
          }
          return { content: formatOutcome(outcomeOf(t), t) };
        },
      });

      editor.add({
        name: "session_send",
        description:
          "Send a follow-up message to a spawned child session. With noReply:true it injects context without triggering a new assistant turn.",
        input: z.object({
          sessionId: z.string().describe("Child session id."),
          text: z.string().describe("Message text."),
          noReply: z.boolean().optional().describe("Inject the message without asking the child to reply (default false)."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; text: string; noReply?: boolean };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;

          if (args.noReply) {
            try {
              await ctx.session.synthetic({ sessionID: t.childID, text: args.text });
              return { content: `Injected context into ${t.childID} (no reply requested).` };
            } catch (err) {
              return { content: `Failed to inject into ${t.childID}: ${describeError(err)}` };
            }
          }

          if (isTerminal(t.state)) t.state = "starting";
          t.errorText = undefined;
          t.structured = undefined;
          t.resultText = undefined;
          void startTurn(t, args.text);
          return {
            content: `Sent follow-up to ${t.childID}; it is running again. Use session_result(wait:true) to await completion.`,
          };
        },
      });

      editor.add({
        name: "session_cancel",
        description: "Abort a spawned child session.",
        input: z.object({
          sessionId: z.string().describe("Child session id."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          try {
            await ctx.session.interrupt({ sessionID: t.childID });
          } catch (err) {
            return { content: `interrupt failed: ${describeError(err)}` };
          }
          if (!isTerminal(t.state)) {
            t.state = "cancelled";
            t.errorText = "Cancelled by parent.";
          }
          t.idleAt = Date.now();
          touch(t);
          settleWaiters(t);
          if (cfg.autoInjectParent) await postToParent(t, buildCompletionNote(t));
          pruneTracked();
          return { content: `Cancelled child session ${t.childID}.` };
        },
      });

      editor.add({
        name: "session_permission",
        description:
          "Answer a permission request raised by a spawned child session so it does not stall. Use session_result/list_sessions to discover a pending permission.",
        input: z.object({
          sessionId: z.string().describe("Child session id."),
          permissionId: z.string().optional().describe("Permission id from a permission notice; defaults to the child's pending permission."),
          response: z.enum(["once", "always", "reject"]).optional().describe("How to answer: allow once, always allow, or reject (default once)."),
        }),
        execute: async (input) => {
          const args = input as {
            sessionId: string;
            permissionId?: string;
            response?: "once" | "always" | "reject";
          };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const requestID = args.permissionId ?? t.pendingPermissionId;
          if (!requestID) {
            return {
              content: `No pending permission for ${t.childID}.${
                t.pendingPermission ? ` Last notice: ${t.pendingPermission}` : ""
              }`,
            };
          }
          const decision = args.response ?? "once";
          try {
            await ctx.permission.reply({
              sessionID: t.childID,
              requestID,
              decision,
            });
          } catch (err) {
            return { content: `Failed to answer permission ${requestID}: ${describeError(err)}` };
          }
          t.pendingPermission = undefined;
          t.pendingPermissionId = undefined;
          return { content: `Answered permission ${requestID} for ${t.childID} with "${decision}".` };
        },
      });

      editor.add({
        name: "session_handoff",
        description:
          "Hand off the current working point into a brand-new session seamlessly: captures a transcript of this session, spawns a new session briefed with that context plus your handoff note, and starts it. The new session is a real session, so it appears in the Desktop session switcher as if opened with + — continue there.",
        input: z.object({
          brief: z.string().optional().describe("What the new session should do next / current working point. Defaults to continuing from the current working point."),
          title: z.string().optional().describe("Human title for the new session; a short id is prepended automatically."),
          messageLimit: z.number().optional().describe("How many recent messages of this session to include as context (default 20, max 100)."),
          agent: z.string().optional().describe("Agent name for the new session (validated against available agents)."),
          model: z.string().optional().describe('Model as "providerID/modelID" (validated against configured providers).'),
          directory: z.string().optional().describe("Working directory for the new session (defaults to this project)."),
          wait: z.boolean().optional().describe("If true, wait for the new session's first turn to finish before returning (default false)."),
          timeoutSec: z.number().optional().describe("Wait timeout in seconds (default 900, hard cap enforced)."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as {
            brief?: string;
            title?: string;
            messageLimit?: number;
            agent?: string;
            model?: string;
            directory?: string;
            wait?: boolean;
            timeoutSec?: number;
          };
          const parentID = toolCtx.sessionID;
          const transcript = await buildTranscript(parentID, args.messageLimit ?? 20);
          const brief = args.brief?.trim() || "Continue from the current working point.";
          const promptText = [
            "# Session handoff",
            "",
            "You are continuing work handed off from another session. Read the prior context, then carry on.",
            "",
            "## Working point / next steps",
            "",
            brief,
            "",
            "## Prior session transcript (most recent last)",
            "",
            transcript,
          ].join("\n");
          const out = await launch({
            parentID,
            promptText,
            titleText: args.title?.trim() || `handoff: ${deriveTitle(brief)}`,
            agentName: args.agent,
            modelStr: args.model,
            directory: args.directory ?? defaultDirectory,
            wait: args.wait,
            timeoutSec: args.timeoutSec,
            label: "Handed off to",
          });
          return {
            content: `${out}\n\nOpen the new session from the Desktop session switcher to continue there seamlessly.`,
          };
        },
      });

      editor.add({
        name: "list_sessions",
        description:
          "List sessions created by this plugin, optionally scoped to the current parent.",
        input: z.object({
          all: z.boolean().optional().describe("List children of every parent, not just this session (default false)."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { all?: boolean };
          const rows: string[] = [];
          for (const t of tracked.values()) {
            if (!args.all && t.parentSessionID !== toolCtx.sessionID) continue;
            rows.push(
              `- ${t.childID} [${t.state}] ${t.shortId} parent=${t.parentSessionID}${
                t.pendingPermissionId ? ` pending_permission=${t.pendingPermissionId}` : ""
              } — ${t.title}`,
            );
          }
          if (rows.length === 0) return { content: "No sessions created by this plugin." };
          return { content: `Sessions (${rows.length}):\n${rows.join("\n")}` };
        },
      });
    });

    return () => {
      abort.abort();
      for (const t of tracked.values()) {
        settleWaiters(t);
      }
      tracked.clear();
      parentDefaults.clear();
    };
  },
});
