import { Plugin } from "@opencode/plugin";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  asBool,
  clampInt,
  deriveTitle,
  describeError,
  extractEditPaths,
  isFileMutatingTool,
  type ModelRef,
  normalizeClaimPath,
  parseJsonFromText,
  parseModelString,
  schemaInstruction,
  sleep,
  taskTokens,
  tasksOverlap,
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
  tags?: string[];
  /** E201: priority level, used to sort list_sessions output. */
  priority?: "low" | "normal" | "high";
  /** E205: token usage reported by the server for this session. */
  tokensUsed?: number;
  /** E205: cost in USD reported by the server for this session. */
  costUsd?: number;
  /** E231: optional post-processing hook applied to the structured result. */
  transform?: (structured: unknown) => unknown;
};

/**
 * A file one session is currently editing.
 *
 * Recorded from the `tool.execute.before` seam so two agents cannot silently
 * write the same file: the ambient brief can then say "you both hold this,
 * take turns" instead of leaving them to discover the clobbered diff.
 */
type FileClaim = {
  /** Project-relative, forward-slashed, case-folded where the FS needs it. */
  path: string;
  at: number;
  tool?: string;
};

/**
 * A session observed working in the same project directory, whether or not this
 * plugin spawned it.
 *
 * opencode exposes no `session.list()`, so peers are discovered by watching the
 * server-wide event stream: every session event carries `data.sessionID` and
 * `location.directory`, which is enough to group by project without asking the
 * server for a list.
 */
type Peer = {
  sessionId: string;
  directory: string;
  state: "running" | "idle";
  lastSeenAt: number;
  agent?: string;
  model?: ModelRef;
  /** Self-declared, so peers can say what they are working on. */
  task?: string;
  /** True when this session announced itself rather than being observed. */
  claimed?: boolean;
  /**
   * Known spawn parent, so lineage (parent / child / sibling) can be judged
   * even for a peer observed in a *different* opencode process, where the local
   * `tracked` map has no record of it.
   */
  parentSessionID?: string;
  /** Files this session is editing right now; pruned by `claimStaleSec`. */
  claims?: FileClaim[];
};

/** Why a peer was worth putting in front of this session. */
type PeerRelevance = "collision" | "lineage" | "running" | "related";

/**
 * How reachable a peer is.
 *
 * `live` and `busy` are both real sessions worth messaging — `busy` is simply
 * one that has gone quiet, so waking it may cost a turn but is not wrong. `gone`
 * is confirmed absent from the server, and its registry entry is dropped.
 */
type PeerVerdict = "live" | "busy" | "gone";

const RELEVANCE_ORDER: Record<PeerRelevance, number> = {
  collision: 0,
  lineage: 1,
  running: 2,
  related: 3,
};

/** This plugin's own tools, so the write gate never wraps one of them. */
const OUR_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_session",
  "session_result",
  "session_send",
  "session_cancel",
  "session_permission",
  "session_handoff",
  "list_sessions",
  "project_sessions",
  "session_broadcast",
]);

/**
 * OS-18: stamp a gated `execute` so a second `tool.transform` pass over the same
 * persistent Info recognises its own wrapper and skips it.
 *
 * `installWriteGate` replaced `info.execute` in place, and the host may replay
 * transforms over a persistent registry (plugin reload, or the ordering the
 * session-export gate comment already describes: `tool.transform` is not
 * guaranteed to be the last seam to run). Without a marker every pass stacked a
 * wrapper around the previous one, so N reloads meant N nested waits on one
 * write. A symbol key keeps the stamp off any field the host reads.
 */
const WRITE_GATE = Symbol.for("opencode-sessions.write-gate");

/**
 * OS-9: Resolve an export target inside `root`, or explain why it was refused.
 *
 * `outputPath` is agent-supplied and used to be handed straight to
 * `fs.promises.writeFile`, so `outputPath: "~/.profile"` or any absolute path
 * silently *replaced* that file with an export of a child session. An export is
 * an archival artefact, not a general file write, so the path is resolved
 * relative to the project directory and must stay inside it. A symlink at the
 * target is refused rather than followed: the containment test is on the *name*,
 * and a link planted earlier would send the bytes wherever the name does not
 * point.
 */
const resolveExportPath = async (
  raw: string | undefined,
  root: string,
  fallbackName: string,
): Promise<{ path: string } | { error: string }> => {
  const base = path.resolve(root);
  const wanted = (raw ?? fallbackName).trim();
  if (!wanted) return { error: "outputPath must be a non-empty path." };
  if (wanted.includes("\0")) return { error: "outputPath must not contain NUL bytes." };
  const target = path.isAbsolute(wanted) ? path.resolve(wanted) : path.resolve(base, wanted);
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      error:
        `"${wanted}" resolves outside the session's project directory (${base}), so it was not written. ` +
        `Exports are confined to the project: pass a path inside it, or omit outputPath.`,
    };
  }
  try {
    const st = await fs.promises.lstat(target);
    if (st.isSymbolicLink()) {
      return { error: `"${rel}" is a symlink, so writing it would land outside the project. Refused.` };
    }
  } catch {
    /* nothing there yet: the write creates it */
  }
  return { path: target };
};

/**
 * Write a *new* file, never over one, and return the name actually used.
 *
 * OS-9: `wx` is the point — a silent clobber is half of what made the arbitrary
 * path destructive. A name clash gets a numbered suffix instead.
 */
const writeNewFile = async (target: string, content: string): Promise<string> => {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  let file = target;
  for (let n = 0; n <= 20; n++) {
    try {
      const handle = await fs.promises.open(file, "wx");
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      file = path.join(dir, `${stem}-${n + 1}${ext}`);
    }
  }
  throw new Error(`could not find a free file name near ${target}`);
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
  peerAwareness: boolean;
  peerStaleSec: number;
  maxPeers: number;
  peerTaskChars: number;
  peerHeartbeatSec: number;
  maxClaimedPeers: number;
  /** "advise" briefs a collision; "enforce" also makes the write wait. */
  fileLocks: "off" | "advise" | "enforce";
  /** How long a blocked write waits for the holder to release, in seconds. */
  lockWaitSec: number;
  /**
   * How long another opencode process's in-flight marker is honoured. Only
   * matters if that process dies mid-write, since a clean finish removes the
   * marker immediately; bounds how long a crash can hold a file.
   */
  inflightTtlSec: number;
  /** A file claim older than this is treated as released. */
  claimStaleSec: number;
  /** Files listed per peer in the brief before it summarises the rest. */
  maxClaimPathsInNotice: number;
  /**
   * Below this age a peer is treated as reachable. Older peers are refused by
   * `session_send` and skipped by `session_broadcast` rather than being
   * silently woken — a closed session should not come back to life because a
   * broadcast happened to include it.
   */
  peerLiveSec: number;
  /** E203: optional webhook URL that receives a POST on session completion. */
  webhookUrl?: string;
  /** E236: comma-separated tool names the write gate applies to. */
  fileLockTools?: string;
  /** E237: glob patterns for files the write gate applies to. */
  fileLockInclude?: string;
  /** E237: glob patterns for files the write gate excludes. */
  fileLockExclude?: string;
  /** E253: locale for agoText output. */
  locale: string;
  /** E258: format string for the peer notice header. */
  peerNoticeFormat: string;
  /** E259: max characters for the peer notice. */
  peerNoticeMaxChars: number;
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
    autoInjectParent: asBool(o.autoInjectParent ?? env("OPENCODE_SESSIONS_AUTO_INJECT"), true),
    maxInjectChars: clampInt(
      o.maxInjectChars ?? env("OPENCODE_SESSIONS_MAX_INJECT_CHARS"),
      4000,
      200,
      100_000,
    ),
    injectPermissionNotices: asBool(
      o.injectPermissionNotices ?? env("OPENCODE_SESSIONS_INJECT_PERMISSIONS"),
      true,
    ),
    inheritParentDefaults: asBool(o.inheritParentDefaults ?? env("OPENCODE_SESSIONS_INHERIT_DEFAULTS"), true),
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
    // --- project presence / peer awareness ---
    // On by default: an agent that edits a file another agent just edited
    // should know a peer exists rather than explain the diff as a mystery.
    peerAwareness: asBool(
      o.peerAwareness ?? env("OPENCODE_SESSIONS_PEER_AWARENESS"),
      true,
    ),
    // Peers unheard from for this long stop being shown. Generous by default
    // because a peer can be legitimately idle mid-task.
    peerStaleSec: clampInt(
      o.peerStaleSec ?? env("OPENCODE_SESSIONS_PEER_STALE_SEC"),
      900,
      30,
      86_400,
    ),
    // Cap the injected awareness line so presence can never dominate a prompt.
    // Lowered from 8: the notice now filters to peers that actually bear on
    // this session, so a low cap is a safety net rather than the usual path.
    maxPeers: clampInt(o.maxPeers ?? env("OPENCODE_SESSIONS_MAX_PEERS"), 4, 1, 64),
    peerTaskChars: clampInt(
      o.peerTaskChars ?? env("OPENCODE_SESSIONS_PEER_TASK_CHARS"),
      120,
      20,
      2000,
    ),
    // How often a session refreshes its own presence entry.
    peerHeartbeatSec: clampInt(
      o.peerHeartbeatSec ?? env("OPENCODE_SESSIONS_PEER_HEARTBEAT_SEC"),
      60,
      5,
      3600,
    ),
    maxClaimedPeers: clampInt(
      o.maxClaimedPeers ?? env("OPENCODE_SESSIONS_MAX_CLAIMED_PEERS"),
      2000,
      10,
      100_000,
    ),
    // --- concurrent-edit awareness ---
    // "advise" records which file each session is writing and tells the other
    // one to take turns. "enforce" additionally wraps the host's own
    // file-mutating tools so a colliding write *waits* for the holder instead of
    // relying on the model to read the brief and hold off.
    fileLocks: ((): "off" | "advise" | "enforce" => {
      const raw = String(o.fileLocks ?? env("OPENCODE_SESSIONS_FILE_LOCKS") ?? "advise")
        .trim()
        .toLowerCase();
      if (raw === "off" || raw === "false" || raw === "0" || raw === "none") return "off";
      if (raw === "enforce" || raw === "lock" || raw === "strict" || raw === "true") {
        return "enforce";
      }
      return "advise";
    })(),
    // Bounded so two agents that each hold a file the other wants still make
    // progress: the loser gets a clear message rather than hanging forever.
    lockWaitSec: clampInt(
      o.lockWaitSec ?? env("OPENCODE_SESSIONS_LOCK_WAIT_SEC"),
      60,
      0,
      900,
    ),
    // Bounds how long a crashed process can hold a file. Kept short because a
    // process that exits cleanly removes its own marker straight away, so this
    // is only ever reached by a crash.
    inflightTtlSec: clampInt(
      o.inflightTtlSec ?? env("OPENCODE_SESSIONS_INFLIGHT_TTL_SEC"),
      3,
      1,
      60,
    ),
    claimStaleSec: clampInt(
      o.claimStaleSec ?? env("OPENCODE_SESSIONS_CLAIM_STALE_SEC"),
      600,
      30,
      86_400,
    ),
    maxClaimPathsInNotice: clampInt(
      o.maxClaimPathsInNotice ?? env("OPENCODE_SESSIONS_MAX_CLAIM_PATHS"),
      3,
      1,
      32,
    ),
    // Reachable window. Past it a peer is presumed closed: `session_send`
    // refuses and `session_broadcast` skips instead of resurrecting it.
    peerLiveSec: clampInt(
      o.peerLiveSec ?? env("OPENCODE_SESSIONS_PEER_LIVE_SEC"),
      90,
      5,
      86_400,
    ),
    // --- E203: completion webhook ---
    webhookUrl:
      typeof o.webhookUrl === "string" && o.webhookUrl.trim()
        ? o.webhookUrl.trim()
        : typeof env("OPENCODE_SESSIONS_WEBHOOK_URL") === "string" &&
            env("OPENCODE_SESSIONS_WEBHOOK_URL")!.trim()
          ? env("OPENCODE_SESSIONS_WEBHOOK_URL")!.trim()
          : undefined,
    // --- E236/E237: per-tool / per-file write gate ---
    fileLockTools:
      typeof o.fileLockTools === "string" && o.fileLockTools.trim()
        ? o.fileLockTools.trim()
        : typeof env("OPENCODE_SESSIONS_FILE_LOCK_TOOLS") === "string" &&
            env("OPENCODE_SESSIONS_FILE_LOCK_TOOLS")!.trim()
          ? env("OPENCODE_SESSIONS_FILE_LOCK_TOOLS")!.trim()
          : undefined,
    fileLockInclude:
      typeof o.fileLockInclude === "string" && o.fileLockInclude.trim()
        ? o.fileLockInclude.trim()
        : typeof env("OPENCODE_SESSIONS_FILE_LOCK_INCLUDE") === "string" &&
            env("OPENCODE_SESSIONS_FILE_LOCK_INCLUDE")!.trim()
          ? env("OPENCODE_SESSIONS_FILE_LOCK_INCLUDE")!.trim()
          : undefined,
    fileLockExclude:
      typeof o.fileLockExclude === "string" && o.fileLockExclude.trim()
        ? o.fileLockExclude.trim()
        : typeof env("OPENCODE_SESSIONS_FILE_LOCK_EXCLUDE") === "string" &&
            env("OPENCODE_SESSIONS_FILE_LOCK_EXCLUDE")!.trim()
          ? env("OPENCODE_SESSIONS_FILE_LOCK_EXCLUDE")!.trim()
          : undefined,
    // --- E253: agoText localization ---
    locale:
      typeof o.locale === "string" && o.locale.trim()
        ? o.locale.trim()
        : typeof env("OPENCODE_SESSIONS_LOCALE") === "string" && env("OPENCODE_SESSIONS_LOCALE")!.trim()
          ? env("OPENCODE_SESSIONS_LOCALE")!.trim()
          : "en",
    // --- E258/E259: peer notice customization ---
    peerNoticeFormat:
      typeof o.peerNoticeFormat === "string" && o.peerNoticeFormat.trim()
        ? o.peerNoticeFormat.trim()
        : typeof env("OPENCODE_SESSIONS_PEER_NOTICE_FORMAT") === "string" &&
            env("OPENCODE_SESSIONS_PEER_NOTICE_FORMAT")!.trim()
          ? env("OPENCODE_SESSIONS_PEER_NOTICE_FORMAT")!.trim()
          : "[opencode-sessions] {count} relevant session(s) in this project",
    peerNoticeMaxChars: clampInt(
      o.peerNoticeMaxChars ?? env("OPENCODE_SESSIONS_PEER_NOTICE_MAX_CHARS"),
      2000,
      200,
      20_000,
    ),
  };
}

export default Plugin.define({
  id: "opencode-sessions",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);
    const defaultDirectory = ctx.location.directory;
    // Maintenance intervals should never be what keeps the host process alive:
    // opencode owns the event loop, and a test that imports this plugin and
    // never calls cleanup must still exit. `unref` keeps them firing while the
    // host is up without pinning the loop open on their own.
    const unrefTimer = (t: unknown): void => {
      if (t && typeof (t as { unref?: unknown }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    };
    const tracked = new Map<string, Tracked>();
    /** Cached parent agent/model defaults, keyed by parent session id. */
    const parentDefaults = new Map<string, { agent?: string; model?: ModelRef; at: number }>();
    const MAX_PARENT_DEFAULTS = 500;
    const PARENT_DEFAULTS_TTL_MS = 60_000;

    // Metrics/observability counters
    const metrics = {
      spawns: 0,
      completions: 0,
      errors: 0,
      timeouts: 0,
      permissionsAutoApproved: 0,
      peerMessagesSent: 0,
      broadcastsSent: 0,
      fileLockWaits: 0,
      deadlocksDetected: 0,
      circuitBreakerTriggers: 0,
      stuckSessionsCleaned: 0,
      eventPumpRestarts: 0,
    };

    // Global circuit breaker: if too many sessions get stuck in a short period,
    // temporarily stop spawning new sessions to prevent cascading failures.
    const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 5;
    const GLOBAL_CIRCUIT_BREAKER_WINDOW_MS = 60_000;
    const GLOBAL_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000;
    const stuckSessionTimestamps: number[] = [];
    let globalCircuitBreakerOpen = false;
    let globalCircuitBreakerOpenedAt = 0;
    const checkGlobalCircuitBreaker = (): boolean => {
      if (globalCircuitBreakerOpen) {
        if (Date.now() - globalCircuitBreakerOpenedAt > GLOBAL_CIRCUIT_BREAKER_COOLDOWN_MS) {
          globalCircuitBreakerOpen = false;
          log("info", "global circuit breaker reset");
          return false;
        }
        return true;
      }
      const now = Date.now();
      while (stuckSessionTimestamps.length > 0 && now - stuckSessionTimestamps[0] > GLOBAL_CIRCUIT_BREAKER_WINDOW_MS) {
        stuckSessionTimestamps.shift();
      }
      if (stuckSessionTimestamps.length >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
        globalCircuitBreakerOpen = true;
        globalCircuitBreakerOpenedAt = now;
        metrics.circuitBreakerTriggers++;
        log("error", `global circuit breaker opened — ${stuckSessionTimestamps.length} stuck sessions in ${GLOBAL_CIRCUIT_BREAKER_WINDOW_MS / 1000}s`);
        return true;
      }
      return false;
    };
    const sessionDurations: number[] = []; // ring buffer of completion durations (sec)
    const MAX_SESSION_DURATIONS = 100;

    // Race a server call against a timeout so a hung opencode API can't stall
    // orchestration forever. (The ctx.* helpers don't accept AbortSignal, so a
    // Promise.race timeout is used instead of AbortSignal.timeout().)
    // L70: the underlying promise is NOT aborted when the timeout fires — it
    // continues in the background. This is a known limitation; the timeout only
    // prevents the caller from waiting indefinitely.
    const SERVER_TIMEOUT_MS = 30_000;
    function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      });
      return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    }

    // OS-15: the E202 disk-backed outcome cache and the E246 batch-mirror path
    // were removed rather than wired up: nothing ever read the disk cache (the
    // in-memory `outcomeCache` below is the only reader) and
    // `mirrorPeersBatched` had no callers, so both were dead weight — the
    // comment claimed a "single storage transaction" the code never did.
    // Short-lived cache for child session.context reads so that polling
    // session_result (and timeout/interrupt best-effort refreshes) doesn't
    // hammer the server with a context read on every call.
    const OUTCOME_CACHE_TTL_MS = 3000;
    const outcomeCache = new Map<string, { at: number; text: string; error?: string }>();
    // OS-10: the map had no size bound, so ids that were never tracked (peers,
    // hydrate misses) accumulated for the process lifetime.
    const OUTCOME_CACHE_MAX = 512;

    // E230: minimal JSON Schema validation (type, required, properties, enum).
    const validateAgainstSchema = (value: unknown, schema: Record<string, unknown>): string | undefined => {
      const type = schema["type"];
      if (type === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return `expected object, got ${Array.isArray(value) ? "array" : typeof value}`;
        }
        const obj = value as Record<string, unknown>;
        const required = schema["required"];
        if (Array.isArray(required)) {
          for (const key of required) {
            if (typeof key === "string" && !(key in obj)) {
              return `missing required property "${key}"`;
            }
          }
        }
        const props = schema["properties"];
        if (props && typeof props === "object") {
          for (const [key, propSchema] of Object.entries(props as Record<string, unknown>)) {
            if (key in obj) {
              const err = validateAgainstSchema(obj[key], propSchema as Record<string, unknown>);
              if (err) return `property "${key}": ${err}`;
            }
          }
        }
      } else if (type === "array") {
        if (!Array.isArray(value)) return `expected array, got ${typeof value}`;
        const items = schema["items"];
        if (items && typeof items === "object") {
          for (let i = 0; i < value.length; i++) {
            const err = validateAgainstSchema(value[i], items as Record<string, unknown>);
            if (err) return `item ${i}: ${err}`;
          }
        }
      } else if (type === "string") {
        if (typeof value !== "string") return `expected string, got ${typeof value}`;
      } else if (type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) return `expected number, got ${typeof value}`;
      } else if (type === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value)) return `expected integer, got ${typeof value}`;
      } else if (type === "boolean") {
        if (typeof value !== "boolean") return `expected boolean, got ${typeof value}`;
      }
      const enumValues = schema["enum"];
      if (Array.isArray(enumValues) && !enumValues.includes(value)) {
        return `value must be one of ${JSON.stringify(enumValues)}`;
      }
      return undefined;
    };

    // E203: fire-and-forget webhook POST on session completion.
    const fireWebhook = async (t: Tracked): Promise<void> => {
      if (!cfg.webhookUrl) return;
      const payload = {
        sessionId: t.childID,
        shortId: t.shortId,
        title: t.title,
        state: t.state,
        parentSessionID: t.parentSessionID,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        idleAt: t.idleAt,
        elapsedSec: t.idleAt ? Math.round((t.idleAt - t.startedAt) / 1000) : undefined,
        resultText: t.resultText,
        structured: t.structured,
        errorText: t.errorText,
        tokensUsed: t.tokensUsed,
        costUsd: t.costUsd,
        tags: t.tags,
      };
      try {
        const res = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          log("warn", `webhook returned ${res.status} for ${t.childID}`);
        }
      } catch (err) {
        log("warn", `webhook failed for ${t.childID}: ${describeError(err)}`);
      }
    };

    // E205: read token usage and cost from session metadata.
    const fetchUsage = async (t: Tracked): Promise<void> => {
      try {
        const info = (await withTimeout(
          ctx.session.get({ sessionID: t.childID }),
          SERVER_TIMEOUT_MS,
          "session.get",
        )) as unknown as { metadata?: Record<string, unknown> } | undefined;
        const meta = info?.metadata;
        if (!meta) return;
        const tokens = meta["tokensUsed"] ?? meta["tokens"] ?? meta["totalTokens"];
        if (typeof tokens === "number" && Number.isFinite(tokens)) t.tokensUsed = tokens;
        const cost = meta["costUsd"] ?? meta["cost"] ?? meta["totalCostUsd"];
        if (typeof cost === "number" && Number.isFinite(cost)) t.costUsd = cost;
      } catch {
        /* best-effort */
      }
    };

    // E206: running duration statistics (count, sum, sumOfSquares, min, max).
    const durationStats = { count: 0, sum: 0, sumOfSquares: 0, min: Infinity, max: 0 };
    const recordDuration = (sec: number): void => {
      durationStats.count += 1;
      durationStats.sum += sec;
      durationStats.sumOfSquares += sec * sec;
      if (sec < durationStats.min) durationStats.min = sec;
      if (sec > durationStats.max) durationStats.max = sec;
    };
    const durationStatsSnapshot = () => {
      const { count, sum, sumOfSquares, min, max } = durationStats;
      const mean = count > 0 ? sum / count : 0;
      const variance = count > 0 ? sumOfSquares / count - mean * mean : 0;
      return {
        count,
        sum,
        sumOfSquares,
        min: count > 0 ? min : 0,
        max,
        mean: Math.round(mean * 100) / 100,
        stddev: Math.round(Math.sqrt(Math.max(0, variance)) * 100) / 100,
      };
    };

    // E239-E252: TTL caches for expensive peer/context operations.
    //
    // OS-7: the derived-state caches used to be a *single slot* holding work done
    // for whichever caller computed first. `buildPeerNotice` keyed nothing, so two
    // sessions in one process were shown each other's notice, and `scorePeers`
    // cached a list scored against the first caller's file claims and remit —
    // every later caller got rows judged against someone else's collision set.
    // So caches that depend on *who asked* are keyed by that caller; caches that
    // hold genuinely shared computation (`peersIn`, `knownSessionIds`) stay
    // single-slot and filter per call.
    /**
     * Small TTL cache with a per-key entry and a size bound.
     *
     * OS-10: every derived cache here is written on a hot path and was previously
     * only emptied by `cleanup()`, so a long-lived server accumulated state for
     * every session id it ever saw. Entries expire on read *and* are swept on the
     * maintenance tick; the bound caps the worst case between sweeps.
     */
    function keyedCache<T>(ttlMs: number, maxEntries: number) {
      const entries = new Map<string, { at: number; data: T }>();
      return {
        peek(key: string): T | undefined {
          const hit = entries.get(key);
          if (!hit) return undefined;
          if (Date.now() - hit.at >= ttlMs) {
            entries.delete(key);
            return undefined;
          }
          return hit.data;
        },
        set(key: string, data: T): void {
          entries.delete(key);
          entries.set(key, { at: Date.now(), data });
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
          }
        },
        sweep(): void {
          const now = Date.now();
          for (const [k, v] of entries) if (now - v.at >= ttlMs) entries.delete(k);
        },
        clear(): void {
          entries.clear();
        },
      };
    }

    /** OS-10: drop TTL-expired entries and enforce a size bound on a plain Map. */
    const capMap = <K, V>(map: Map<K, unknown>, max: number): void => {
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    };

    const PEER_NOTICE_TTL_MS = 5_000;
    const peerNoticeCache = keyedCache<string>(PEER_NOTICE_TTL_MS, 64);
    const peersInCache = { at: 0, data: [] as Peer[] };
    const PEERS_IN_TTL_MS = 2_000;
    const SCORE_PEERS_TTL_MS = 2_000;
    const scorePeersCache = keyedCache<ScoredPeer[]>(SCORE_PEERS_TTL_MS, 64);
    const REMOTE_WRITERS_TTL_MS = 500;
    // OS-11: keyed by directory and holding the *unfiltered* scan, so one
    // session's keys cannot shorten the list another session reads from.
    type RemoteScanRow = { sessionId: string; directory: string; paths: string[]; at: number };
    const remoteScanCache = keyedCache<RemoteScanRow[]>(REMOTE_WRITERS_TTL_MS, 32);
    const WRITERS_OF_TTL_MS = 500;
    const writersOfCache = keyedCache<
      Array<{ label: string; sessionId: string; remote: boolean }>
    >(WRITERS_OF_TTL_MS, 128);
    const TRANSCRIPT_TTL_MS = 5_000;
    const transcriptCache = keyedCache<string>(TRANSCRIPT_TTL_MS, 64);
    const HYDRATE_TTL_MS = 2_000;
    const hydrateCache = keyedCache<Tracked>(HYDRATE_TTL_MS, 256);
    const knownSessionIdsCache = { at: 0, ids: [] as string[] };
    const KNOWN_SESSION_IDS_TTL_MS = 2_000;
    const displayIdCache = new Map<string, { at: number; id: string }>();
    const DISPLAY_ID_TTL_MS = 5_000;

    /**
     * Drop every derived presence cache.
     *
     * These caches carry a short TTL but have no way to know a peer changed, so
     * without this a `project_sessions` call made right after an event can
     * answer from a snapshot taken before it — a deleted peer stays listed, a
     * freshly-seen one stays invisible, and the awareness notice repeats work
     * that ended minutes ago. Invalidation on every peer write keeps the caches
     * a pure optimisation.
     */
    const invalidatePresenceCaches = (): void => {
      peersInCache.at = 0;
      writersOfCache.clear();
      knownSessionIdsCache.at = 0;
      displayIdCache.clear();
      scorePeersCache.clear();
      peerNoticeCache.clear();
    };

    /**
     * OS-10: TTL sweep for the derived-state maps that only `cleanup()` used to
     * empty. Runs on the maintenance tick, so growth is bounded by the number of
     * ids seen in one interval rather than by the lifetime of the process.
     */
    const sweepDerivedCaches = (): void => {
      const now = Date.now();
      for (const [k, v] of eventCounts) if (now > v.resetAt) eventCounts.delete(k);
      capMap(eventCounts, 512);
      for (const [k, v] of outcomeCache) {
        if (now - v.at >= OUTCOME_CACHE_TTL_MS) outcomeCache.delete(k);
      }
      capMap(outcomeCache, OUTCOME_CACHE_MAX);
      for (const [k, ts] of deliverTimes) {
        if (now - ts > DELIVER_MIN_INTERVAL_MS * 8) deliverTimes.delete(k);
      }
      capMap(deliverTimes, 512);
      for (const [k, ts] of parentInjectTimes) {
        if (now - ts > PARENT_INJECT_MIN_INTERVAL_MS * 8) parentInjectTimes.delete(k);
      }
      capMap(parentInjectTimes, 512);
      // A published record for a peer this process no longer knows about will be
      // republished (as a fresh write) if that peer comes back, so dropping the
      // de-dup entry here is safe and keeps the map to live presence.
      for (const key of [...publishedPeers.keys()]) {
        if (!peers.has(key.slice(PEER_KEY_PREFIX.length))) publishedPeers.delete(key);
      }
      capMap(publishedPeers, cfg.maxClaimedPeers);
      peerNoticeCache.sweep();
      scorePeersCache.sweep();
      remoteScanCache.sweep();
      writersOfCache.sweep();
      transcriptCache.sweep();
      hydrateCache.sweep();
      for (const [k, v] of displayIdCache) {
        if (now - v.at >= DISPLAY_ID_TTL_MS) displayIdCache.delete(k);
      }
      capMap(displayIdCache, 512);
    };

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

    /**
     * Deliver `text` to any session by id, routing through the tracked record
     * when we have one so the existing state machine stays authoritative.
     * ctx.session.synthetic/prompt address any session, so this works for peers
     * this plugin did not spawn.
     */
    // Rate limiting: prevent deliverToSession from being called too frequently
    const deliverTimes = new Map<string, number>();
    const DELIVER_MIN_INTERVAL_MS = 2000;
    /**
     * Deliver `text` to one session and report whether it was actually sent.
     *
     * OS-8: the old signature returned a human string for both "sent" and
     * "suppressed by the rate limit", so `session_broadcast` counted the skipped
     * peer in `delivered` and `session_send` marked the peer running and bumped
     * `peerMessagesSent` for a message that never left. The result is now a
     * discriminated object, and the rate-limit stamp is only kept when the send
     * genuinely happened — a failed delivery used to block its own retry for the
     * rest of the window.
     */
    type DeliverResult = { delivered: boolean; how: string };
    const deliverToSession = async (
      sessionId: string,
      text: string,
      noReply: boolean,
    ): Promise<DeliverResult> => {
      const now = Date.now();
      const lastDeliver = deliverTimes.get(sessionId) ?? 0;
      if (now - lastDeliver < DELIVER_MIN_INTERVAL_MS) {
        log("debug", `skipping deliver to ${sessionId} — too soon`);
        return {
          delivered: false,
          how: `Not sent: a message went to ${sessionId} less than ${Math.ceil(
            (DELIVER_MIN_INTERVAL_MS - (now - lastDeliver)) / 1000,
          )}s ago, so this one was suppressed to avoid double-delivery.`,
        };
      }
      // Reserve the window before awaiting so two sends in the same tick cannot
      // both pass the check; released again below if the send fails (OS-8).
      deliverTimes.set(sessionId, now);
      try {
        const known = tracked.get(sessionId);
        const target = known?.childID ?? sessionId;
        if (noReply) {
          await withTimeout(
            ctx.session.synthetic({ sessionID: target, text }),
            SERVER_TIMEOUT_MS,
            "session.synthetic",
          );
          return { delivered: true, how: `Injected context into ${target} (no reply requested).` };
        }
        // A tracked child goes through startTurn so a failed send is reported
        // rather than silently leaving stale results in place.
        if (known) {
          if (isTerminal(known.state)) known.state = "starting";
          known.errorText = undefined;
          known.structured = undefined;
          known.resultText = undefined;
          await startTurn(known, text);
          if (isTerminal(known.state) && known.errorText) {
            throw new Error(known.errorText);
          }
          return { delivered: true, how: `Sent follow-up to ${target}; it is running again.` };
        }
        await withTimeout(
          ctx.session.prompt({ sessionID: target, text }),
          SERVER_TIMEOUT_MS,
          "session.prompt",
        );
        return { delivered: true, how: `Sent to ${target}.` };
      } catch (err) {
        // A failed send must be retryable immediately (OS-8).
        deliverTimes.delete(sessionId);
        throw err;
      }
    };

    // ------------------------------------------------------------------
    // Project presence registry
    //
    // opencode has no `session.list()`, so peers are discovered passively from
    // the event stream. Every session event carries `data.sessionID` plus a
    // `location.directory`, so grouping observed ids by directory is enough to
    // answer "who else is working here" without a server round-trip.
    //
    // Entries are deliberately cross-process: a standalone `opencode` run
    // alongside the Desktop app does not share this Map, so presence is also
    // mirrored into ctx.storage. That makes a peer in one process visible to a
    // peer in the other, and survives a reload.
    // ------------------------------------------------------------------
    const peers = new Map<string, Peer>();
    /**
     * Session ids this plugin instance has announced itself for. ctx exposes no
     * "current session" outside a tool call or the context hook, so self is
     * learned from those and remembered here for cleanup.
     */
    const selfSessionIDs = new Set<string>();
    /**
     * Storage keys for the presence registry, one per peer.
     *
     * Versioned in the prefix so a shape change is visible, and per-peer so
     * processes cannot clobber each other's peers (see `mirrorPeers`).
     */
    const PEER_KEY_PREFIX = "presence:v2:";
    const peerStorageKey = (sessionId: string): string =>
      `${PEER_KEY_PREFIX}${sessionId}`;
    const peerStore = ctx.storage as unknown as {
      get?: (key: string) => Promise<unknown>;
      set?: (key: string, value: unknown) => Promise<unknown> | void;
      /** v2 also offers remove/scan; both are optional so an older host still works. */
      remove?: (key: string) => Promise<unknown> | void;
      scan?: (options: {
        prefix: string;
        limit?: number;
      }) => Promise<{ entries: readonly { key: string; value: unknown }[] } | undefined>;
    } | undefined;

    const peerKey = (sessionId: string): string => sessionId;

    /** Drop peers unheard from for longer than peerStaleSec. */
    /**
     * Drop claims past their window, in place.
     *
     * A claim is an observation ("this session wrote this file recently"), not
     * a lease, so it must never outlive the evidence: a session that died
     * mid-edit would otherwise block its peers forever.
     */
    const pruneClaims = (): void => {
      const cutoff = Date.now() - cfg.claimStaleSec * 1000;
      for (const p of peers.values()) {
        if (!p.claims || p.claims.length === 0) continue;
        const live = p.claims.filter((c) => c.at >= cutoff);
        if (live.length !== p.claims.length) {
          if (live.length > 0) p.claims = live;
          else delete p.claims;
        }
      }
    };

    const prunePeers = (): void => {
      pruneClaims();
      const cutoff = Date.now() - cfg.peerStaleSec * 1000;
      for (const [id, p] of peers) {
        if (p.lastSeenAt < cutoff) peers.delete(id);
      }
    };

    /** Live claim paths for a session, newest first, deduped. */
    const claimPathsOf = (sessionId: string): string[] => {
      const p = peers.get(peerKey(sessionId));
      if (!p?.claims || p.claims.length === 0) return [];
      const out: string[] = [];
      for (const c of [...p.claims].sort((a, b) => b.at - a.at)) {
        if (!out.includes(c.path)) out.push(c.path);
      }
      return out;
    };

    /**
     * Record that `sessionId` is writing `paths` right now.
     *
     * Re-claiming refreshes the timestamp instead of duplicating, so a long
     * sequence of edits to one file keeps a single claim that stays live.
     *
     * Only a session already known to this project is claimed. The tool hook is
     * server-wide, so inferring the directory from the tool call alone would
     * file a session working in *another* project under this one — the exact
     * cross-project leak the event stream's `location.directory` prevents. Any
     * session that can run a tool has already been registered, by its own
     * first-turn self-claim or by the event it emitted to get there.
     */
    const claimFilesFor = (
      sessionId: string,
      tool: string,
      rawPaths: string[],
    ): string[] => {
      if (!sessionId || rawPaths.length === 0) return [];
      const peer = peers.get(peerKey(sessionId));
      if (!peer) return [];
      const directory = peer.directory;
      const now = Date.now();
      const held = new Map((peer.claims ?? []).map((c) => [c.path, c]));
      const added: string[] = [];
      for (const raw of rawPaths) {
        const key = normalizeClaimPath(raw, directory);
        if (!key) continue;
        held.set(key, { path: key, at: now, tool });
        added.push(key);
      }
      if (added.length === 0) return [];
      peer.claims = [...held.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, Math.max(cfg.maxClaimPathsInNotice * 4, 12));
      mirrorPeers();
      return added;
    };

    /** A session that goes idle is not mid-edit, so nothing stays held. */
    const releaseClaimsFor = (sessionId: string): void => {
      const p = peers.get(peerKey(sessionId));
      if (!p?.claims || p.claims.length === 0) return;
      delete p.claims;
      mirrorPeers();
    };

    /**
     * Remove a session from the presence registry.
     *
     * Called on `session.deleted` and by `project_sessions(forget:)`, so a
     * closed session stops being advertised *and* stops being a message target
     * instead of lingering until the stale cutoff.
     */
    const forgetPeer = (sessionId: string): boolean => {
      const removed = peers.delete(peerKey(sessionId));
      if (removed) invalidatePresenceCaches();
      // Drop the shared record too, so other processes stop advertising this
      // session at once instead of waiting for it to age out on their side.
      const key = peerStorageKey(sessionId);
      publishedPeers.delete(key);
      void withTimeout(
        peerStore?.remove?.(key) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.remove",
      ).catch((err: unknown) =>
        log("debug", `peer key removal failed: ${describeError(err)}`),
      );
      if (removed) mirrorPeers();
      return removed;
    };

    /**
     * A peer is *fresh* when it was heard from very recently, whatever state it
     * reported. Freshness — not the `running` flag — is the only safe liveness
     * signal, because a session running one long command goes quiet for minutes
     * while still being very much alive. Anything not fresh is a candidate for
     * verification via `verifyPeer` rather than an assumption.
     */
    const isFreshPeer = (p: Peer): boolean =>
      Date.now() - p.lastSeenAt < cfg.peerLiveSec * 1000;

    /**
     * Ask the server whether a session still exists, instead of guessing from a
     * timer.
     *
     * `session.get` rejects with `Session.NotFoundError` for a session that is
     * gone, so a peer that was merely quiet is distinguished from one that was
     * deleted or crashed:
     *
     *   live  - seen recently, no probe needed
     *   busy  - quiet, but the server confirms the session exists
     *   gone  - the server does not have it; the registry entry is dropped
     *
     * Results are deliberately not cached. A confirmed-gone verdict removes the
     * entry, so it cannot be re-probed, while a `busy` verdict is cheap to
     * re-derive and must not be allowed to go stale — caching it would let a
     * session deleted moments ago be messaged anyway, which is the failure this
     * whole check exists to prevent.
     */
    const verifyPeer = async (p: Peer): Promise<PeerVerdict> => {
      if (isFreshPeer(p)) return "live";
      let verdict: PeerVerdict;
      try {
        const found = await withTimeout(
          ctx.session.get({ sessionID: p.sessionId }),
          SERVER_TIMEOUT_MS,
          "session.get",
        );
        verdict = found ? "busy" : "gone";
      } catch {
        // NotFoundError for a deleted session, a transport error for one this
        // process cannot see. Both mean "do not blindly prompt it".
        verdict = "gone";
      }
      if (verdict === "gone") forgetPeer(p.sessionId);
      return verdict;
    };

    /** Verify several peers concurrently, dropping the ones confirmed gone. */
    const verifyAll = async (list: Peer[]): Promise<Map<string, PeerVerdict>> => {
      const out = new Map<string, PeerVerdict>();
      const MAX_CONCURRENCY = 5;
      const queue = [...list];
      const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const p = queue.shift()!;
          out.set(p.sessionId, await verifyPeer(p));
        }
      });
      await Promise.all(workers);
      return out;
    };

    const LOCK_POLL_MS = 1000;

    /**
     * Block until no other session is mid-write on `keys`, or the budget runs
     * out.
     *
     * The thing waited on is a write in progress, so this normally returns as
     * soon as the other write finishes. The budget exists for the case where
     * that write itself never returns — a wedged tool call — so a stuck write
     * cannot lock the project indefinitely; two agents holding a file each
     * other needs both give up with an explanation rather than deadlocking.
     */
    const waitForRelease = async (
      selfId: string,
      directory: string,
      keys: string[],
      budgetMs: number,
      signal?: AbortSignal,
    ): Promise<{
      cleared: boolean;
      holders: Array<{ label: string; sessionId: string; remote: boolean }>;
      waited: boolean;
    }> => {
      let holders = await writersOf(directory, selfId, keys);
      if (holders.length === 0) return { cleared: true, holders: [], waited: false };
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline && !signal?.aborted) {
        await sleep(Math.min(LOCK_POLL_MS, deadline - Date.now()), signal);
        holders = await writersOf(directory, selfId, keys);
        if (holders.length === 0) return { cleared: true, holders, waited: true };
      }
      return { cleared: holders.length === 0, holders, waited: true };
    };

    const describeHolders = (
      holders: Array<{ label: string; sessionId: string; remote: boolean }>,
    ): string =>
      holders
        .map((h) => {
          const name = displayId(h.label, knownSessionIds());
          return h.remote ? `${name} (another opencode process)` : name;
        })
        .join("; ");

    /**
     * Files a session is *blocked trying to* write.
     *
     * The in-flight marker records what a session is writing, which is not
     * enough to recognise a lock-order inversion: to see that two sessions are
     * each waiting on the other you need to know what each is trying to
     * acquire, not just what it holds. Kept separate from in-flight so a
     * waiting session is never mistaken for a writing one — `writersOf` does
     * not read this, so waiting costs other sessions nothing.
     *
     * Only published by a write that is actually blocked, so the common
     * uncontended case writes nothing extra.
     */
    const WAIT_KEY_PREFIX = "waiting:";
    const waitKey = (sessionId: string): string => `${WAIT_KEY_PREFIX}${sessionId}`;

    const publishWaitIntent = (sessionId: string, keys: string[]): void => {
      if (!peerStore?.set || !sessionId || keys.length === 0) return;
      void withTimeout(
        peerStore.set(waitKey(sessionId), { sessionId, keys, at: Date.now() }) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.set",
      ).catch((err: unknown) => log("debug", `wait intent publish failed: ${describeError(err)}`));
    };

    const clearWaitIntent = (sessionId: string): void => {
      if (!peerStore?.remove || !sessionId) return;
      void withTimeout(
        peerStore.remove(waitKey(sessionId)) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.remove",
      ).catch(() => undefined);
    };

    const clearOwnWaitIntents = (): void => {
      if (!peerStore?.scan) return;
      void (async () => {
        try {
          const scanned = await withTimeout(
            peerStore.scan!({ prefix: WAIT_KEY_PREFIX, limit: 256 }),
            SERVER_TIMEOUT_MS,
            "storage.scan",
          );
          for (const entry of scanned?.entries ?? []) {
            const v = entry?.value as { sessionId?: unknown } | undefined;
            if (typeof v?.sessionId === "string" && selfSessionIDs.has(v.sessionId)) {
              await peerStore.remove?.(waitKey(v.sessionId));
            }
          }
        } catch {
          /* best-effort; a stale intent expires on its own */
        }
      })();
    };

    /** What every currently-blocked session is trying to acquire. */
    const readWaitIntents = async (): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>();
      if (!peerStore?.scan) return out;
      try {
        const scanned = await withTimeout(
          peerStore.scan({ prefix: WAIT_KEY_PREFIX, limit: 256 }),
          SERVER_TIMEOUT_MS,
          "storage.scan",
        );
        // A waiter clears its own intent, so a leftover one means that process
        // died mid-wait; ignore it rather than reporting a phantom deadlock.
        const cutoff = Date.now() - (cfg.lockWaitSec + 15) * 1000;
        for (const entry of scanned?.entries ?? []) {
          const v = entry?.value as { sessionId?: unknown; keys?: unknown; at?: unknown } | undefined;
          if (typeof v?.sessionId !== "string" || !Array.isArray(v.keys)) continue;
          if (typeof v.at === "number" && v.at < cutoff) continue;
          out.set(
            v.sessionId,
            v.keys.filter((k): k is string => typeof k === "string"),
          );
        }
      } catch {
        /* best-effort: without intents we still report plain contention */
      }
      return out;
    };

    /**
     * Is this a deadlock rather than ordinary contention?
     *
     * Two agents can each hold a file the other wants — a lock-order inversion,
     * which needs a write touching more than one file, since a single-file write
     * cannot invert. Waiting cannot break that: each is blocked by the other's
     * claim and neither will release until it finishes. There is no ordering
     * discipline that fixes it here, because a write covers all its paths in one
     * call and the store has no compare-and-set to acquire them one at a time.
     *
     * So it is not hidden behind a generic timeout. Detecting the cycle lets the
     * message say what is actually wrong and what to do about it, which is
     * actionable; "gave up waiting" is not.
     */
    const detectInversion = (
      holders: Array<{ sessionId: string }>,
      myIntendedKeys: ReadonlySet<string>,
      selfId: string,
      intents: ReadonlyMap<string, string[]>,
    ): boolean => {
      // What *I* am holding right now. Holding nothing means nobody is waiting
      // on me, so however long a holder takes, this is plain contention.
      const mine = inFlight.get(selfId);
      if (!mine || mine.size === 0) return false;
      return holders.some((h) => {
        const theirs = inFlight.get(h.sessionId);
        if (!theirs || theirs.size === 0) return false;
        // They must be blocking me...
        const theyBlockMe = [...theirs].some((k) => myIntendedKeys.has(k));
        if (!theyBlockMe) return false;
        // ...and I must be blocking them, by holding what they hold, or by
        // holding what they are waiting to acquire.
        const iBlockThem =
          [...mine].some((k) => theirs.has(k)) ||
          (intents.get(h.sessionId) ?? []).some((k) => mine.has(k));
        return iBlockThem;
      });
    };

    /**
     * Install the write gate on the host's own file-mutating tools.
     *
     * `tool.transform`'s editor sees the *registered* tools, built-ins included,
     * and `editor.update` replaces an entry's `execute` in place. Wrapping is
     * what makes the wait real: the alternative — a brief that tells the model to
     * hold off — depends on the model obeying, and a model that has already
     * decided to edit will edit.
     */
    const installWriteGate = (editor: {
      list: () => readonly { id?: string; name?: string }[];
      update: (id: string, fn: (info: never) => void) => void;
    }): string[] => {
      const wrapped: string[] = [];
      for (const entry of editor.list()) {
        const id = String(entry.id ?? entry.name ?? "");
        if (!id) continue;
        // Never gate ourselves: a wrapper around our own tools could recurse.
        if (OUR_TOOL_NAMES.has(id)) continue;
        if (!isFileMutatingTool(id)) continue;
        let ok = false;
        try {
          // L63: define proper types instead of using `as never` casts.
          type ToolInfo = {
            execute: (input: unknown, toolCtx: { sessionID?: string; signal?: AbortSignal }) => Promise<unknown>;
          };
          editor.update(id as never, ((info: ToolInfo) => {
            const inner = info.execute;
            if (typeof inner !== "function") return;
            // OS-18: already gated by this plugin — do not stack a second wrapper.
            if ((inner as unknown as Record<symbol, unknown>)[WRITE_GATE] === true) {
              ok = true;
              return;
            }
            // Use Object.defineProperty to handle frozen objects or getter-only
            // properties. A plain assignment would throw in strict mode on a
            // frozen object, and the throw would be caught by the outer
            // try/catch, leaving the tool ungated with only a log message.
            const newFn = async (input: unknown, toolCtx: { sessionID?: string; signal?: AbortSignal }) => {
              const selfId = typeof toolCtx?.sessionID === "string" ? toolCtx.sessionID : "";
              const rawPaths = extractEditPaths(input);
              if (!selfId || rawPaths.length === 0) return inner(input, toolCtx as never);

              const directory = peers.get(peerKey(selfId))?.directory ?? defaultDirectory;
              const keys = rawPaths
                .map((raw) => normalizeClaimPath(raw, directory))
                .filter((k): k is string => !!k)
                // Deterministic order, so two sessions touching the same set of
                // files contend on the same key instead of each blocking on a
                // different one.
                .sort();

              // Announce what this session is trying to acquire, so a peer that
              // ends up blocked by *this* write can recognise the cycle rather
              // than reporting plain contention. Only ever read on a timeout.
              publishWaitIntent(selfId, keys);
              // Atomic in-process reservation BEFORE the first await. JS runs
              // synchronously up to here, so the first reserver wins and a
              // simultaneous second writer sees the holder and waits instead of
              // both observing an empty set and writing concurrently.
              // acquireWrite keeps the reservation held across the remote wait
              // and retries it if this session lost the gap after waiting.
              const outcome = await acquireWrite(
                selfId,
                directory,
                keys,
                cfg.lockWaitSec * 1000,
                toolCtx?.signal,
              );
              if (!outcome.cleared) {
                // Deliberately NOT clearing the intent here. Two sessions in a
                // cycle time out within milliseconds of each other, and the one
                // that reports first would otherwise erase the evidence the
                // second needs to recognise the cycle. A stale intent is
                // harmless — it is only read to confirm mutual blocking, and it
                // expires on its own — whereas losing it costs the diagnosis.
                const intents = await readWaitIntents();
                const inverted = detectInversion(
                  outcome.holders,
                  new Set(keys),
                  selfId,
                  intents,
                );
                if (inverted) metrics.deadlocksDetected++;
                throw new Error(
                  inverted
                    ? `Deadlock: you and ${describeHolders(outcome.holders)} are each holding a file the other is trying to write ` +
                      `(${keys.join(", ")}), so neither can proceed. Do not retry the same set. ` +
                      `Either write one file at a time, or session_send to agree which of you takes which file.`
                    : `Gave up waiting ${cfg.lockWaitSec}s for another session to finish writing ` +
                      `${keys.join(", ")}. Still being written by ${describeHolders(outcome.holders)}. ` +
                      `Do not edit it anyway: either wait and retry, or session_send that session to agree who takes this file.`,
                );
              }
              // Got what it wanted, so stop advertising a want nothing needs.
              clearWaitIntent(selfId);
              const waited = outcome.waited;
              if (waited) {
                metrics.fileLockWaits++;
                log("debug", `write to ${keys.join(", ")} waited for a peer's write to finish`);
              }
              // Turn-scoped claim first (that is what the brief reads). The
              // in-flight reservation is already held by acquireWrite, and it
              // stays held for exactly as long as the write runs: claiming
              // before the wait would have made this session a writer of the
              // very file it was waiting for, which is why the wait comes first.
              claimFilesFor(selfId, id, rawPaths);
              // Renew the cross-process marker while the write runs. The marker
              // is otherwise written once and expires after inflightTtlSec, so
              // a write slower than the TTL looked like a crashed writer and a
              // second process could enter the same file concurrently.
              const renewMs = Math.max(
                500,
                Math.min(2000, Math.floor((cfg.inflightTtlSec * 1000) / 2)),
              );
              const renewTimer = setInterval(() => {
                markInFlight(selfId, directory, keys);
              }, renewMs);
              if (typeof (renewTimer as unknown as { unref?: unknown }).unref === "function") {
                (renewTimer as unknown as { unref: () => void }).unref();
              }
              try {
                return await inner(input, toolCtx as never);
              } finally {
                // A failed or hung write must not keep the file locked.
                clearInterval(renewTimer);
                releaseReservedKeys(selfId, keys);
              }
            };
            // OS-18: mark this wrapper as ours so a later transform pass skips it
            // instead of wrapping the wrapper.
            Object.defineProperty(newFn, WRITE_GATE, { value: true, configurable: true });
            Object.defineProperty(info, "execute", {
              value: newFn,
              writable: true,
              configurable: true,
            });
            // Verify the assignment actually took effect
            if (info.execute !== newFn) {
              throw new Error(`Could not replace execute on ${id} — property is read-only`);
            }
            ok = true;
          }) as never);
        } catch (err) {
          log("debug", `could not gate ${id}: ${describeError(err)}`);
          continue;
        }
        if (ok) wrapped.push(id);
      }
      return wrapped;
    };

    /**
     * Files a session is writing *right now*, keyed by session id.
     *
     * Deliberately separate from `Peer.claims`, which answer a different
     * question:
     *
     *   Peer.claims  - "did this session write this file during its current
     *                  turn?" -> a turn-scoped record, used for the awareness
     *                  brief, so a peer is warned before it clobbers a change
     *                  made earlier in a turn that is still running.
     *   inFlight     - "is a write to this file in progress at this instant?"
     *                  -> what the lock actually waits on, and nothing more.
     *
     * Waiting on the turn-scoped record instead would block a writer for the
     * whole remainder of the other session's turn — however long that is, since
     * a turn continues past the edit with tests and output — so a waiter would
     * time out against a session doing nothing to the file. Keying the wait to
     * the real tool lifecycle makes the wait as short as the write it is
     * waiting for.
     */
    const inFlight = new Map<string, Set<string>>();

    /**
     * Cross-process mirror of the same signal.
     *
     * One storage key per session, so two processes writing different files
     * cannot clobber each other's entry (a shared array would be
     * last-writer-wins). `storage.scan` is what makes this possible: it is the
     * only way to enumerate keys, and without it a per-session key would be
     * write-only.
     *
     * `ctx.storage` is shared by every opencode process on the same config
     * directory, which is what lets a standalone `opencode` run coordinate with
     * the Desktop app. This is a best-effort signal, not a distributed lock:
     * there is no compare-and-set on the store, so a lost update is corrected by
     * the holder's next publish, and a process that dies mid-write leaves an
     * entry that only expires. It fails *open* — a missed entry means no wait,
     * never a wait on a lie.
     */
    const INFLIGHT_PREFIX = "inflight:";
    const inflightKey = (sessionId: string): string => `${INFLIGHT_PREFIX}${sessionId}`;

    const markInFlight = (sessionId: string, directory: string, keys: string[]): void => {
      if (!sessionId || keys.length === 0) return;
      const held = inFlight.get(sessionId) ?? new Set<string>();
      for (const k of keys) held.add(k);
      inFlight.set(sessionId, held);
      // Published best-effort: a failure here must never fail a write, it only
      // costs cross-process coordination until the next publish.
      void withTimeout(
        peerStore?.set?.(inflightKey(sessionId), {
          sessionId,
          directory,
          paths: [...held],
          at: Date.now(),
        }) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.set",
      ).catch((err: unknown) =>
        log("debug", `in-flight publish failed: ${describeError(err)}`),
      );
    };

    const clearInFlight = (sessionId: string): void => {
      if (!inFlight.delete(sessionId)) return;
      void withTimeout(
        peerStore?.remove?.(inflightKey(sessionId)) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.remove",
      ).catch(
        (err: unknown) => log("debug", `in-flight release failed: ${describeError(err)}`),
      );
    };

    /**
     * Drop just `keys` from a session's reservation, republishing what remains.
     * `clearInFlight` drops the whole entry, which over-releases when one
     * session has two writes in flight at once; the failure and finish paths
     * only ever release the write they acquired.
     */
    const releaseReservedKeys = (sessionId: string, keys: string[]): void => {
      const held = inFlight.get(sessionId);
      if (!held) return;
      for (const k of keys) held.delete(k);
      if (held.size === 0) {
        inFlight.delete(sessionId);
        void withTimeout(
          peerStore?.remove?.(inflightKey(sessionId)) ?? Promise.resolve(),
          SERVER_TIMEOUT_MS,
          "storage.remove",
        ).catch(() => undefined);
        return;
      }
      const directory = peers.get(peerKey(sessionId))?.directory ?? defaultDirectory;
      void withTimeout(
        peerStore?.set?.(inflightKey(sessionId), {
          sessionId,
          directory,
          paths: [...held],
          at: Date.now(),
        }) ?? Promise.resolve(),
        SERVER_TIMEOUT_MS,
        "storage.set",
      ).catch(() => undefined);
    };

    /**
     * Synchronous in-process reservation. Returns true and holds `keys` when no
     * *other* session in this process holds an overlapping key; returns false
     * without holding anything otherwise. Must run with no await before it, so
     * two writes starting in the same tick cannot both observe an empty set.
     */
    const tryReserveInFlight = (sessionId: string, directory: string, keys: string[]): boolean => {
      if (!sessionId || keys.length === 0) return false;
      const want = new Set(keys);
      for (const [otherId, held] of inFlight) {
        if (otherId === sessionId) continue;
        for (const k of held) {
          if (want.has(k)) return false;
        }
      }
      markInFlight(sessionId, directory, keys);
      return true;
    };

    /**
     * Reserve `keys` for `selfId` and wait for holders to release, returning the
     * wait outcome with the local reservation held on success. A session that
     * loses the initial reservation waits unreserved (so it is never mistaken
     * for a writer of the file it wants), then retries; a session that holds
     * the reservation but times out releases exactly what it took.
     */
    const acquireWrite = async (
      selfId: string,
      directory: string,
      keys: string[],
      budgetMs: number,
      signal?: AbortSignal,
    ): Promise<{
      cleared: boolean;
      holders: Array<{ label: string; sessionId: string; remote: boolean }>;
      waited: boolean;
    }> => {
      const deadline = Date.now() + budgetMs;
      let waited = false;
      for (;;) {
        if (tryReserveInFlight(selfId, directory, keys)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0 || signal?.aborted) {
            releaseReservedKeys(selfId, keys);
            return { cleared: false, holders: await writersOf(directory, selfId, keys), waited: true };
          }
          const outcome = await waitForRelease(selfId, directory, keys, remaining, signal);
          if (!outcome.cleared) releaseReservedKeys(selfId, keys);
          // OS-14: report the wait the caller actually paid. `waited` was set
          // above but never folded in, so `fileLockWaits` under-counted every
          // contended write that had already reserved its keys.
          return { ...outcome, waited: outcome.waited || waited };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) {
          return { cleared: false, holders: await writersOf(directory, selfId, keys), waited: true };
        }
        const outcome = await waitForRelease(selfId, directory, keys, remaining, signal);
        waited = true;
        // OS-14: same here — the retry loop means this write did wait.
        if (!outcome.cleared) return { ...outcome, waited: outcome.waited || waited };
      }
    };

    /** Drop any in-flight keys this process published, so cleanup is not abrupt. */
    const releaseOwnInFlight = (): void => {
      for (const id of inFlight.keys()) {
        void withTimeout(
          peerStore?.remove?.(inflightKey(id)) ?? Promise.resolve(),
          SERVER_TIMEOUT_MS,
          "storage.remove",
        ).catch(() => undefined);
      }
      inFlight.clear();
    };

    type RemoteWriter = { sessionId: string; directory: string; paths: string[] };

    /**
     * In-progress writes other opencode processes are publishing right now.
     *
     * OS-11: the E242 cache was a single slot holding the scan *already filtered*
     * to one caller's `keys`, `selfId` and `directory`. Any other caller — another
     * project in the same server, or a write to a different file — read that
     * narrowed list back and silently missed the peer that mattered. The cache is
     * now keyed by directory and stores the unfiltered rows; the per-caller
     * narrowing happens after the cache on every call. Freshness is re-checked at
     * read time too, so a row cached while fresh cannot be obeyed after it ages
     * past the in-flight TTL.
     */
    const remoteWriters = async (
      directory: string,
      selfId: string,
      keys: string[],
    ): Promise<RemoteWriter[]> => {
      if (keys.length === 0) return [];
      const cutoff = Date.now() - cfg.inflightTtlSec * 1000;
      let rows = remoteScanCache.peek(directory);
      if (!rows) {
        if (!peerStore?.scan) return [];
        let entries: readonly { key: string; value: unknown }[] | undefined;
        try {
          const scanned = await withTimeout(
            peerStore.scan({ prefix: INFLIGHT_PREFIX, limit: 256 }),
            SERVER_TIMEOUT_MS,
            "storage.scan",
          );
          entries = scanned?.entries;
        } catch (err) {
          // No scan, no cross-process view. Degrade to in-process only rather
          // than blocking writes on a storage hiccup.
          log("debug", `in-flight scan failed: ${describeError(err)}`);
          return [];
        }
        rows = [];
        for (const entry of entries ?? []) {
          const v = entry?.value as Partial<RemoteWriter> & { at?: number } | undefined;
          if (!v || typeof v.sessionId !== "string") continue;
          if (typeof v.at !== "number" || v.at < cutoff) continue;
          if (v.directory !== directory) continue;
          if (!Array.isArray(v.paths)) continue;
          rows.push({
            sessionId: v.sessionId,
            directory: v.directory,
            paths: v.paths.filter((p): p is string => typeof p === "string"),
            at: v.at,
          });
        }
        remoteScanCache.set(directory, rows);
      }
      const want = new Set(keys);
      const out: RemoteWriter[] = [];
      for (const r of rows) {
        if (r.sessionId === selfId || r.at < cutoff) continue;
        const paths = r.paths.filter((p) => want.has(p));
        if (paths.length === 0) continue;
        out.push({ sessionId: r.sessionId, directory: r.directory, paths });
      }
      return out;
    };

    /** Peers with a write in progress on any of `keys`, in this or another process. */
    const writersOf = async (
      directory: string,
      selfId: string,
      keys: string[],
    ): Promise<Array<{ label: string; sessionId: string; remote: boolean }>> => {
      if (keys.length === 0) return [];
      // E243: cache the result with a very short TTL. The key carries the caller
      // and the exact key set, so no one else's answer can be reused here.
      const cacheKey = `${directory}\u0000${selfId}\u0000${keys.join(",")}`;
      const cached = writersOfCache.peek(cacheKey);
      if (cached) return cached;
      // Only prune when significantly over the bound to avoid O(n) scan on
      // every write. The map will be pruned on the next timer tick or when
      // it grows much larger.
      if (peers.size > cfg.maxClaimedPeers * 1.5) {
        prunePeers();
      }
      const want = new Set(keys);
      const out: Array<{ label: string; sessionId: string; remote: boolean }> = [];
      for (const p of peers.values()) {
        if (p.directory !== directory || p.sessionId === selfId) continue;
        const held = inFlight.get(p.sessionId);
        if (held && [...held].some((k) => want.has(k))) {
          out.push({ label: p.sessionId, sessionId: p.sessionId, remote: false });
        }
      }
      for (const r of await remoteWriters(directory, selfId, keys)) {
        if (out.some((o) => o.sessionId === r.sessionId)) continue;
        out.push({ label: r.sessionId, sessionId: r.sessionId, remote: true });
      }
      writersOfCache.set(cacheKey, out);
      return out;
    };

    const recordPeer = (
      sessionId: string,
      directory: string,
      patch: Partial<Peer> = {},
    ): Peer | undefined => {
      if (!sessionId || !directory) return undefined;
      // Presence is read through synchronous, short-lived caches, so a write
      // has to land before the call that follows it. An earlier version
      // debounced the write here; that left every event invisible for 500ms, so
      // a tool that records a peer and then lists in the same tick — or a peer
      // that only just aged past the freshness window — read a stale registry.
      const next = recordPeerImmediate(sessionId, directory, patch);
      if (next) invalidatePresenceCaches();
      return next;
    };

    const recordPeerImmediate = (
      sessionId: string,
      directory: string,
      patch: Partial<Peer> = {},
    ): Peer | undefined => {
      if (!sessionId || !directory) return undefined;
      const now = Date.now();
      const existing = peers.get(peerKey(sessionId));
      // A session that changes directory is a different peer context; drop the
      // stale record rather than reporting it under two projects at once.
      if (existing && existing.directory !== directory) peers.delete(peerKey(sessionId));
      const base: Peer =
        existing ??
        {
          sessionId,
          directory,
          state: "idle",
          lastSeenAt: now,
        };
      // OS-12: an optional field that a caller does not know is simply absent
      // from the event payload, which arrives here as an explicit `undefined`.
      // Spread is not selective, so `{agent: undefined}` used to erase the agent,
      // title or task recorded earlier — including the task the peer declared
      // through `project_sessions` — on the next unrelated event. Drop the
      // undefined-valued keys so absence means "unchanged", as intended.
      const clean: Partial<Peer> = {};
      for (const [field, value] of Object.entries(patch) as Array<[keyof Peer, unknown]>) {
        if (value !== undefined) clean[field] = value as never;
      }
      // `lastSeenAt` is a caller-supplied fact, not something this function may
      // invent. A local event proves the session is alive *now*, so the event
      // path passes nothing and gets `now`; a cross-process import only proves
      // it was alive when the *other* process wrote the record, so that path
      // passes the remote timestamp. Overwriting it here refreshed every peer on
      // every rescan, so nothing ever aged out: deleted sessions were never
      // detected, the staleness cutoffs never fired, and dead sessions kept
      // reporting whatever state they had when last mirrored.
      const next: Peer = {
        ...base,
        ...clean,
        lastSeenAt: clean.lastSeenAt ?? now,
        sessionId,
      };
      if (next.task !== undefined) next.task = truncate(next.task, cfg.peerTaskChars);
      peers.set(peerKey(sessionId), next);
      // Bound growth: a long-lived server sees many session ids.
      // Evict only the single oldest peer with an O(n) scan instead of
      // sorting all peers (O(n log n)) on every insert once the bound is hit.
      if (peers.size > cfg.maxClaimedPeers) {
        let oldestKey: string | undefined;
        let oldestTime = Infinity;
        for (const [k, v] of peers) {
          if (v.lastSeenAt < oldestTime) {
            oldestTime = v.lastSeenAt;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) peers.delete(oldestKey);
      }
      return next;
    };

    /**
     * Mirror presence into ctx.storage so peers in a separate opencode process
     * see each other.
     *
     * One key per peer, not one key for the whole registry. A single shared
     * array is last-writer-wins, so two processes would overwrite each other's
     * peers: whichever mirrored last decided who exists. Per-peer keys mean a
     * process can only ever overwrite a key describing the *same* session, with
     * effectively the same data. Found via `storage.scan` — without it a
     * per-peer key would be write-only.
     *
     * Best-effort and debounced: a storage rejection must never break
     * orchestration, and heartbeats must not hammer the store. Only peers whose
     * payload actually changed are rewritten.
     */
    let peerMirrorTimer: ReturnType<typeof setTimeout> | undefined;
    const publishedPeers = new Map<string, string>();
    const peerPayload = (p: Peer): Record<string, unknown> => ({
      sessionId: p.sessionId,
      directory: p.directory,
      state: p.state,
      lastSeenAt: p.lastSeenAt,
      agent: p.agent,
      task: p.task,
      parentSessionID: p.parentSessionID,
      claims: p.claims,
    });
    /**
     * Write out every peer whose published payload changed.
     *
     * OS-13: this is the body the debounce used to re-arm a timer around. It is
     * now separate so cleanup can flush pending presence *without* re-arming: the
     * old `cleanup()` cleared the timer and then called `mirrorPeers()`, which
     * armed a fresh 2s timer whose write landed *after* the shutdown had deleted
     * this process's peer records — republishing presence for a plugin that had
     * just torn itself down.
     */
    const publishPeerChanges = (): void => {
      if (!peerStore?.set) return;
      prunePeers();
      const batch: Array<{ key: string; payload: Peer }> = [];
      for (const [id, p] of peers) {
        const key = peerStorageKey(id);
        const payload = peerPayload(p) as Peer;
        let encoded: string;
        try {
          encoded = JSON.stringify(payload);
        } catch {
          continue;
        }
        if (publishedPeers.get(key) === encoded) continue;
        publishedPeers.set(key, encoded);
        batch.push({ key, payload });
      }
      if (batch.length === 0) return;
      void (async () => {
        try {
          for (const { key, payload } of batch) {
            await withTimeout(
              peerStore.set?.(key, payload) ?? Promise.resolve(),
              SERVER_TIMEOUT_MS,
              "storage.set",
            );
          }
        } catch (err) {
          log("debug", `peer mirror batch write failed: ${describeError(err)}`);
        }
      })();
    };
    const mirrorPeers = (): void => {
      if (!peerStore?.set) return;
      if (peerMirrorTimer !== undefined) return;
      peerMirrorTimer = setTimeout(() => {
        peerMirrorTimer = undefined;
        publishPeerChanges();
      }, 2000);
    };
    /** OS-13: flush what is queued and stop the debounce — never re-arm it. */
    const flushPeerMirror = (): void => {
      if (peerMirrorTimer !== undefined) {
        clearTimeout(peerMirrorTimer);
        peerMirrorTimer = undefined;
      }
      publishPeerChanges();
    };

    /** Adopt one remote record, never letting it overwrite fresher local state. */
    const mergeRemotePeer = (r: Partial<Peer> & { lastSeenAt?: number }): void => {
      if (typeof r?.sessionId !== "string" || typeof r.directory !== "string") return;
      if (typeof r.lastSeenAt !== "number") return;
      // Freshness is decided here rather than at the caller, so a long-lived
      // process still ignores a peer that has since gone quiet elsewhere.
      if (r.lastSeenAt < Date.now() - cfg.peerStaleSec * 1000) return;
      const local = peers.get(peerKey(r.sessionId));
      if (local && local.lastSeenAt >= r.lastSeenAt) return;
      recordPeer(r.sessionId, r.directory, {
        // Carried through verbatim: this is the moment the *other* process saw
        // the session, and inventing a local `now` here is what made every peer
        // look permanently fresh.
        lastSeenAt: r.lastSeenAt,
        // A session silent for longer than the live window cannot still be
        // mid-turn — a running one emits events continuously — so a stored
        // "running" on an old record is not to be believed. This also makes the
        // registry self-healing against records left behind by an earlier
        // version, which could persist a "running" flag indefinitely.
        state:
          r.state === "running" && r.lastSeenAt >= Date.now() - cfg.peerLiveSec * 1000
            ? "running"
            : "idle",
        agent: typeof r.agent === "string" ? r.agent : undefined,
        task: typeof r.task === "string" ? r.task : undefined,
        parentSessionID:
          typeof r.parentSessionID === "string" ? r.parentSessionID : undefined,
        // Only well-formed claims are adopted: this is untrusted-ish data
        // from another process, and a malformed entry must not break the brief.
        claims: Array.isArray(r.claims)
          ? r.claims
              .filter(
                (c): c is FileClaim => !!c && typeof c.path === "string" && typeof c.at === "number",
              )
              .slice(0, 32)
          : undefined,
      });
    };

    /**
     * Pull every other process's presence.
     *
     * Re-run on a heartbeat rather than once at startup: a session that opens
     * after this process started used to stay invisible forever, because the
     * snapshot was read a single time during setup.
     */
    let remoteRefreshInFlight = false;
    const refreshRemotePeers = (): void => {
      if (!peerStore?.scan || remoteRefreshInFlight) return;
      remoteRefreshInFlight = true;
      void (async () => {
        try {
          const scanned = await withTimeout(
            peerStore.scan!({ prefix: PEER_KEY_PREFIX, limit: 512 }),
            SERVER_TIMEOUT_MS,
            "storage.scan",
          );
          prunePeers();
          for (const entry of scanned?.entries ?? []) {
            if (typeof entry?.value !== "object" || entry.value === null) continue;
            mergeRemotePeer(entry.value as Partial<Peer> & { lastSeenAt?: number });
          }
        } catch (err) {
          log("debug", `peer refresh failed: ${describeError(err)}`);
        } finally {
          remoteRefreshInFlight = false;
        }
      })();
    };

    // Prime once immediately; the interval keeps it current after that.
    refreshRemotePeers();
    const remotePeerTimer = peerStore?.scan
      ? setInterval(refreshRemotePeers, Math.max(cfg.peerHeartbeatSec, 5) * 1000)
      : undefined;
    unrefTimer(remotePeerTimer);

    /** Peers in `directory`, newest first, stale entries already pruned. */
    const peersIn = (directory: string, excludeSelf?: string): Peer[] => {
      // E240: cache the sorted peer list with a short TTL. The cache holds the
      // whole registry, not a per-caller filtered view: caching the filtered
      // list meant the first caller's `excludeSelf` was baked in, so a listing
      // asked for by a different session (or by the same session that had just
      // claimed itself) came back missing every peer.
      const now = Date.now();
      if (now - peersInCache.at >= PEERS_IN_TTL_MS) {
        prunePeers();
        peersInCache.at = now;
        peersInCache.data = [...peers.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      }
      return peersInCache.data.filter(
        (p) => p.directory === directory && p.sessionId !== excludeSelf,
      );
    };

    const agoText = (ms: number): string => {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.round(h / 24)}d ago`;
    };

    /**
     * Shortest label that unambiguously names a session among the ones we know.
     *
     * opencode ids are time-derived, so two sessions opened in the same window
     * share their first 8 characters — `ses_f1ab1063…` and `ses_f1ab33ac…` both
     * read as `ses_f1ab`. A fixed-width slice is not merely ugly when it
     * collides: the agent is shown two identical rows, and since it is only ever
     * shown the short form, it cannot name the one it means. So widen the
     * prefix until it is unique against every session currently known, and fall
     * back to the full id rather than ever emit an ambiguous label.
     */
    const displayId = (sessionId: string, known: Iterable<string>): string => {
      // E252: cache the result per session id.
      const cached = displayIdCache.get(sessionId);
      if (cached && Date.now() - cached.at < DISPLAY_ID_TTL_MS) {
        return cached.id;
      }
      const MIN = 8;
      if (sessionId.length <= MIN) return sessionId;
      const rivals: string[] = [];
      for (const id of known) if (id !== sessionId) rivals.push(id);
      if (rivals.length === 0) return sessionId.slice(0, MIN);
      for (let n = MIN + 1; n < sessionId.length; n++) {
        const prefix = sessionId.slice(0, n);
        if (!rivals.some((id) => id.startsWith(prefix))) {
          displayIdCache.set(sessionId, { at: Date.now(), id: prefix });
          return prefix;
        }
      }
      displayIdCache.set(sessionId, { at: Date.now(), id: sessionId });
      return sessionId;
    };

    /** Ids the agent could be shown, so labels can be made unique against them. */
    const knownSessionIds = (): string[] => {
      // E251: cache the result and invalidate on changes.
      const now = Date.now();
      if (now - knownSessionIdsCache.at < KNOWN_SESSION_IDS_TTL_MS) {
        return knownSessionIdsCache.ids;
      }
      const ids = [
        ...peers.keys(),
        ...[...tracked.values()].map((t) => t.childID),
      ];
      knownSessionIdsCache.at = now;
      knownSessionIdsCache.ids = ids;
      return ids;
    };

    /**
     * Is this peer mid-turn, as far as we can tell?
     *
     * The stored `state` is whatever the last event said, so it goes stale: a
     * session that was running when we last looked and has since gone quiet is
     * still recorded as `running`, and a rescan skips an unchanged record rather
     * than re-evaluating it, so the flag can sit wrong indefinitely. Silence
     * longer than the live window is itself proof that a session is not
     * mid-turn — one that is running emits events continuously — so freshness is
     * the invariant here and the flag is only believed while the peer is fresh.
     *
     * Without this a session that ended half an hour ago is still advertised as
     * working, is still ranked as a relevant peer, and is still treated as
     * reachable.
     */
    const isRunningPeer = (p: Peer): boolean =>
      p.state === "running" && isFreshPeer(p);

    const describePeer = (p: Peer, claimPaths?: string[]): string => {
      const bits = [
        displayId(p.sessionId, knownSessionIds()),
        isRunningPeer(p) ? "running" : "idle",
        agoText(p.lastSeenAt),
      ];
      if (p.task) bits.push(p.task);
      else if (p.agent) bits.push(p.agent);
      const files = claimPaths ?? claimPathsOf(p.sessionId);
      if (files.length > 0) {
        const shownFiles = files.slice(0, cfg.maxClaimPathsInNotice);
        const rest = files.length - shownFiles.length;
        bits.push(`editing ${shownFiles.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
      }
      // This hook is synchronous, so freshness is all it can report. It is a
      // hint, not a verdict: the tools verify against the server before acting.
      if (!isFreshPeer(p)) bits.push("idle, unverified");
      return `- ${bits.join(" | ")}`;
    };

    // ---- relevance ----------------------------------------------------
    // The point of the brief is relevance, not a roster. A session is told
    // about a peer only when that peer could actually affect its work: it
    // holds a file this session is writing, it is in this session's lineage,
    // it is mid-turn right now, or it declared overlapping work.

    /** Spawn parent of a session, from the local map or from a peer's record. */
    const parentOf = (sessionId: string): string | undefined => {
      const viaTracked = tracked.get(sessionId)?.parentSessionID;
      if (viaTracked && viaTracked !== "unknown") return viaTracked;
      const viaPeer = peers.get(peerKey(sessionId))?.parentSessionID;
      return viaPeer && viaPeer !== "unknown" ? viaPeer : undefined;
    };

    /** How `peerId` relates to `selfId`; undefined when unrelated. */
    const relationOf = (
      selfId: string,
      peerId: string,
    ): "parent" | "child" | "sibling" | undefined => {
      if (peerId === selfId) return undefined;
      if (parentOf(peerId) === selfId) return "child";
      if (parentOf(selfId) === peerId) return "parent";
      const mine = parentOf(selfId);
      if (mine && mine === parentOf(peerId)) return "sibling";
      return undefined;
    };

    /**
     * Content words describing this session's remit: its own declared task plus
     * the tasks of the children it spawned, because a parent orchestrating a
     * worker cares about that worker's subject matter.
     */
    const remitTokens = (selfId: string): Set<string> => {
      const tokens = taskTokens(peers.get(peerKey(selfId))?.task);
      for (const [id, child] of tracked) {
        if (child.parentSessionID !== selfId) continue;
        for (const tok of taskTokens(peers.get(peerKey(id))?.task)) tokens.add(tok);
      }
      return tokens;
    };

    type ScoredPeer = {
      p: Peer;
      rank: PeerRelevance;
      shared: string[];
      relation?: "parent" | "child" | "sibling";
    };

    const scorePeers = (directory: string, selfId: string): ScoredPeer[] => {
      // E241: cache the scored peer list with a short TTL.
      //
      // OS-7: the cache used to hold the list scored against the *first* caller's
      // claims and remit, then filter rows for everyone else — so a session got
      // peers judged against another session's collision set, which is precisely
      // the set that decides whether a CONCURRENT EDIT warning is shown. The list
      // is now cached per (directory, selfId), which is what it is a function of.
      const cacheKey = `${directory}\u0000${selfId}`;
      const cached = scorePeersCache.peek(cacheKey);
      if (cached) return cached;
      const mine = new Set(claimPathsOf(selfId));
      const remit = remitTokens(selfId);
      const scored: ScoredPeer[] = [];
      for (const p of peersIn(directory, selfId)) {
        const shared = claimPathsOf(p.sessionId).filter((c) => mine.has(c));
        const relation = relationOf(selfId, p.sessionId);
        let rank: PeerRelevance | undefined;
        if (shared.length > 0) rank = "collision";
        else if (relation) rank = "lineage";
        else if (isRunningPeer(p)) rank = "running";
        else if (tasksOverlap(p.task, remit)) rank = "related";
        if (!rank) continue;
        scored.push({ p, rank, shared, relation });
      }
      const sorted = scored.sort(
        (a, b) =>
          RELEVANCE_ORDER[a.rank] - RELEVANCE_ORDER[b.rank] ||
          b.p.lastSeenAt - a.p.lastSeenAt,
      );
      scorePeersCache.set(cacheKey, sorted);
      return sorted;
    };

    /**
     * The awareness injection. Kept deliberately terse: it fires on every
     * request, so it has to pay for itself in a couple of lines — and it
     * returns nothing at all when no peer bears on this session, which is the
     * common case in a busy project.
     */
    const buildPeerNotice = (directory: string, selfId: string): string | undefined => {
      // E239: cache the notice with a short TTL.
      //
      // OS-7: the notice is *about* the caller — which peers are relevant, which
      // files collide, how many are withheld. A single slot meant two sessions in
      // one process were each briefed with the other's notice: the one whose text
      // was computed first answered for everyone for the rest of the TTL.
      const cacheKey = `${directory}\u0000${selfId}`;
      const cached = peerNoticeCache.peek(cacheKey);
      if (cached) return cached;
      const others = peersIn(directory, selfId);
      if (others.length === 0) return undefined;
      const relevant = scorePeers(directory, selfId);
      if (relevant.length === 0) return undefined;

      const shown = relevant.slice(0, cfg.maxPeers);
      const overCap = relevant.length - shown.length;
      const unrelated = others.length - relevant.length;

      // "N of M" when the cap bit, so the count is never read as the full total.
      const count =
        overCap > 0
          ? `${shown.length} of ${relevant.length} relevant session${relevant.length === 1 ? "" : "s"}`
          : `${shown.length} relevant session${shown.length === 1 ? "" : "s"}`;
      const tally = [
        unrelated > 0 ? `${unrelated} unrelated` : "",
      ].filter(Boolean);
      // E258: use configurable format string for the header. When the cap bit,
      // fall back to the "N of M" form so the shown count is never read as the
      // full total.
      const header =
        overCap > 0
          ? count
          : cfg.peerNoticeFormat
              .replace("{count}", String(shown.length))
              .replace("{total}", String(relevant.length))
              .replace("{unrelated}", String(unrelated));
      const lines = [
        `${header}${tally.length > 0 ? `; ${tally.join(", ")}` : ""}`,
        ...shown.map((s) => {
          const row = describePeer(s.p);
          if (s.rank === "lineage" && s.relation) return `${row} (your ${s.relation})`;
          if (s.rank === "related") return `${row} (related task)`;
          return row;
        }),
      ];

      // Concurrent edit: the one case where a peer actively threatens this
      // session's work, so it gets an unambiguous instruction rather than a row
      // the model has to interpret for itself.
      const colliding = shown.filter((s) => s.shared.length > 0);
      if (colliding.length > 0) {
        const first = colliding[0];
        lines.push(
          `CONCURRENT EDIT: you and ${displayId(first.p.sessionId, knownSessionIds())} both hold ${first.shared.join(", ")}. Only one of you should write it — wait for them to release it, or session_send to agree who takes it.`,
        );
        const more = colliding.slice(1).map((s) => displayId(s.p.sessionId, knownSessionIds()));
        if (more.length > 0) lines.push(`Also colliding: ${more.join(", ")}.`);
      } else {
        lines.push(
          "Changes here may be theirs, not yours. project_sessions for the full list, session_send to coordinate, session_broadcast to warn everyone.",
        );
      }
      let notice = lines.join("\n");
      // E259: truncate to peerNoticeMaxChars when configured.
      if (notice.length > cfg.peerNoticeMaxChars) {
        notice = truncate(notice, cfg.peerNoticeMaxChars);
      }
      peerNoticeCache.set(cacheKey, notice);
      return notice;
    };

    /** Unique sentinel so the awareness line can be re-stripped, never doubled. */
    const PEER_SENTINEL = "[opencode-sessions:peers]";

    /**
     * Reduce a notice to the part that carries meaning, for equality checks.
     *
     * Each peer row ends in a relative age ("47s ago") that ticks every second.
     * Comparing the raw text therefore never matches, so the "unchanged brief is
     * left where it is" guard could never fire: every turn stripped and re-pushed
     * the system message, which the model answered with an acknowledgement, which
     * was itself a turn that re-triggered the same check in every other session.
     * That is a self-sustaining loop between sessions, not a useful signal.
     *
     * Blanking the ages makes an idle, unchanged roster compare equal, so the
     * injection is left in place and the loop settles. A peer's *state* (running
     * vs idle, plus the "idle, unverified" marker) and its files are untouched by
     * this, so a genuine change still re-injects as it should.
     */
    const noticeFingerprint = (text: string): string =>
      text.replace(/\b\d+[smhd] ago\b/g, "·");

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
     * Concurrency slots claimed at `launch()` entry, per parent.
     *
     * OS-2: both limits were measured against `tracked`, which only learns about
     * a child *after* `ctx.session.create()` resolves — up to 8s of server time
     * behind the request. `spawn_many` fires its whole batch with `Promise.all`,
     * so N children passed the check while the map was still empty and N children
     * were created. A slot is now taken synchronously, before the first await, and
     * handed over to the tracked record the moment that record exists; every
     * failure or refusal path releases it again.
     */
    const reservedSlots = new Map<string, number>();
    const reservedTotal = (): number => {
      let n = 0;
      for (const v of reservedSlots.values()) n += v;
      return n;
    };
    const reserveSlot = (parentID: string): void => {
      reservedSlots.set(parentID, (reservedSlots.get(parentID) ?? 0) + 1);
    };
    const releaseSlot = (parentID: string): void => {
      const n = (reservedSlots.get(parentID) ?? 0) - 1;
      if (n <= 0) reservedSlots.delete(parentID);
      else reservedSlots.set(parentID, n);
    };

    /**
     * Snapshots taken by `session_snapshot`, keyed off the real session id.
     *
     * OS-6: these used to be written into `tracked` under a fabricated id
     * (`snapshot:<child>:<ts>`) with `childID` set to that fake id. Anything that
     * later resolved a reference by prefix — a `session_send` to a `snapshot:`
     * prefix, `resolveSessionRef` ambiguity checks — could match a snapshot as if
     * it were a live session, and `session_result`/`session_cancel` on one would
     * call the server with a string that is not a session id at all. Snapshots are
     * their own, bounded state now, and the id handed back carries the session it
     * came from.
     */
    type Snapshot = {
      id: string;
      sourceID: string;
      parentSessionID: string;
      shortId: string;
      title: string;
      at: number;
      data: Record<string, unknown>;
    };
    const snapshots = new Map<string, Snapshot>();
    const MAX_SNAPSHOTS = 50;

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
            outcomeCache.delete(t.childID);
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
        outcomeCache.delete(t.childID);
      }
      // Sweep any remaining stale outcome-cache entries so the map stays bounded
      // even for child IDs that were never tracked (e.g. peers).
      const now = Date.now();
      for (const [id, entry] of outcomeCache) {
        if (now - entry.at >= OUTCOME_CACHE_TTL_MS) outcomeCache.delete(id);
      }
    };

    // Stuck session detector: clean up sessions that have been in a non-terminal
    // state for longer than the hard timeout. This prevents sessions from being
    // stuck in loops indefinitely.
    const STUCK_SESSION_CHECK_INTERVAL_MS = 30_000;
    const MAX_SESSION_LIFETIME_MS = cfg.hardTimeoutSec * 1000 * 2;
    const stuckSessionTimer = setInterval(() => {
      const now = Date.now();
      const hardTimeoutMs = cfg.hardTimeoutSec * 1000;
      for (const [id, t] of tracked) {
        if (isTerminal(t.state)) continue;
        const lastActivity = t.lastActivityAt ?? t.createdAt;
        const stuckDuration = now - lastActivity;
        const totalLifetime = now - t.createdAt;
        const stalled = stuckDuration > hardTimeoutMs;
        if (stalled || totalLifetime > MAX_SESSION_LIFETIME_MS) {
          const reason = stalled
            ? `stuck in ${t.state} for ${Math.round(stuckDuration / 1000)}s`
            : `exceeded max lifetime of ${Math.round(MAX_SESSION_LIFETIME_MS / 1000)}s`;
          log("warn", `session cleanup: ${id} ${reason} — cleaning up`);
          // OS-1: only a session that has gone *quiet* is evidence of a stall.
          // The lifetime branch fires on sessions that may have been active the
          // whole time, and counting those pushed the global circuit breaker
          // open during ordinary heavy fan-out (which then mutes idle handling
          // for every session in the process).
          if (stalled) stuckSessionTimestamps.push(now);
          metrics.stuckSessionsCleaned++;
          t.state = "timeout";
          t.errorText = `Session ${reason}`;
          t.idleAt = now;
          const hadWaiter = settleWaiters(t) > 0;
          // OS-1: stop the child. Retiring the record without this left a live
          // session generating tokens with nothing tracking it, and the pump had
          // no entry to attach its late events to.
          void withTimeout(
            ctx.session.interrupt({ sessionID: t.childID }),
            SERVER_TIMEOUT_MS,
            "session.interrupt",
          ).catch((err: unknown) => {
            log("debug", `interrupt of retired ${t.childID} failed: ${describeError(err)}`);
          });
          // OS-1: the record stays in `tracked` (terminal, so this sweep and the
          // state machine both skip it) so `session_result` can still report what
          // it produced and `pruneTracked` reclaims it on the normal schedule.
          void (async () => {
            try {
              const fresh = await fetchOutcome(t.childID);
              if (fresh.text && !t.resultText) t.resultText = fresh.text;
            } catch {
              /* best-effort */
            }
            if (cfg.autoInjectParent && !hadWaiter) {
              await postToParent(t, buildCompletionNote(t));
            }
          })();
        }
      }
      // OS-10: the only periodic tick in the plugin — every bounded cache that
      // `cleanup()` used to be the sole reclamation path is swept here.
      sweepDerivedCaches();
      checkGlobalCircuitBreaker();
    }, STUCK_SESSION_CHECK_INTERVAL_MS);
    unrefTimer(stuckSessionTimer);

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
    const parentInjectTimes = new Map<string, number>();
    const PARENT_INJECT_MIN_INTERVAL_MS = 5000;
    // OS-3: notes that arrive inside the throttle window used to be dropped, and
    // the caller had already marked the child `injected`, so a parent spawning
    // more children than the window allows was never told those children
    // finished — with `spawn_many` that is the normal case, not the rare one. The
    // throttle still applies (it exists to stop injection storms), but skipped
    // notes are queued per parent and flushed by one timer when the window ends.
    const pendingParentNotes = new Map<string, string[]>();
    const MAX_QUEUED_NOTES_PER_PARENT = 20;
    let parentFlushTimer: ReturnType<typeof setTimeout> | undefined;

    const injectParentNote = async (parentID: string, text: string): Promise<void> => {
      parentInjectTimes.set(parentID, Date.now());
      try {
        await withTimeout(
          ctx.session.synthetic({ sessionID: parentID, text }),
          SERVER_TIMEOUT_MS,
          "session.synthetic",
        );
      } catch (err) {
        log("warn", `failed to inject into parent ${parentID}`, { error: describeError(err) });
      }
    };

    /** Drain the queue for every parent whose window has elapsed. One timer only. */
    const flushParentNotes = (): void => {
      parentFlushTimer = undefined;
      for (const [parentID, notes] of [...pendingParentNotes]) {
        pendingParentNotes.delete(parentID);
        if (notes.length === 0) continue;
        // One injection for the whole batch: the point of the queue is to stop
        // the parent being woken once per child.
        void injectParentNote(parentID, notes.join("\n\n"));
      }
    };

    const armParentFlush = (delayMs: number): void => {
      if (parentFlushTimer !== undefined) return;
      parentFlushTimer = setTimeout(flushParentNotes, Math.max(0, delayMs));
      unrefTimer(parentFlushTimer);
    };

    const postToParent = async (t: Tracked, text: string): Promise<void> => {
      const now = Date.now();
      const lastInject = parentInjectTimes.get(t.parentSessionID) ?? 0;
      const elapsed = now - lastInject;
      if (elapsed < PARENT_INJECT_MIN_INTERVAL_MS) {
        log("debug", `queueing parent inject for ${t.parentSessionID} — too soon`);
        const queued = pendingParentNotes.get(t.parentSessionID) ?? [];
        pendingParentNotes.set(t.parentSessionID, queued);
        queued.push(text);
        // A parent with an enormous queue is a runaway spawner; keep the newest
        // notes and say so, rather than growing without bound.
        while (queued.length > MAX_QUEUED_NOTES_PER_PARENT) {
          const dropped = queued.shift();
          log("warn", `dropping oldest queued parent note for ${t.parentSessionID}`, {
            dropped: dropped ? dropped.slice(0, 80) : "",
          });
        }
        armParentFlush(PARENT_INJECT_MIN_INTERVAL_MS - elapsed);
        // Counted as delivered-to-queue, so nothing retries it a second time.
        t.injected = true;
        return;
      }
      await injectParentNote(t.parentSessionID, text);
      t.injected = true;
    };

    const buildCompletionNote = (t: Tracked, maxTotalChars?: number): string => {
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
      let note = parts.join("\n\n");
      // E257: truncate the total note to maxTotalChars when provided.
      if (maxTotalChars !== undefined && note.length > maxTotalChars) {
        note = truncate(note, maxTotalChars);
      }
      return note;
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
     * Results are cached for OUTCOME_CACHE_TTL_MS so status polling doesn't
     * issue a context read per call, and reads are bounded by SERVER_TIMEOUT_MS.
     */
    const fetchOutcome = async (
      childID: string,
    ): Promise<{ text: string; structured?: unknown; error?: string }> => {
      const cached = outcomeCache.get(childID);
      if (cached && Date.now() - cached.at < OUTCOME_CACHE_TTL_MS) {
        return { text: cached.text, error: cached.error };
      }
      try {
        const messages = await withTimeout(
          ctx.session.context({ sessionID: childID }),
          SERVER_TIMEOUT_MS,
          "session.context",
        );
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i] as unknown as {
            type: string;
            content?: Array<{ type: string; text?: string }>;
            error?: unknown;
          };
          if (m.type !== "assistant") continue;
          const text = assistantTextOf(m);
          const error = m.error ? describeError(m.error) : undefined;
          outcomeCache.set(childID, { at: Date.now(), text, error });
          return { text, error };
        }
        // L67: don't cache empty results — the child may still be running
        // and a subsequent call within the TTL would return stale empty text.
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
      metrics.completions++;
      const durationSec = Math.round((t.idleAt - t.startedAt) / 1000);
      sessionDurations.push(durationSec);
      if (sessionDurations.length > MAX_SESSION_DURATIONS) sessionDurations.shift();
      recordDuration(durationSec);
      try {
        const o = await fetchOutcome(t.childID);
        t.resultText = o.text;
        if (o.error) t.errorText = o.error;
        if (t.schema && o.text) {
          const parsed = parseJsonFromText(o.text);
          if (parsed !== undefined) t.structured = parsed;
        }
        // E230: validate structured output against the schema when provided.
        if (t.schema && t.structured !== undefined && !t.errorText) {
          const validationError = validateAgainstSchema(t.structured, t.schema);
          if (validationError) {
            t.errorText = `SchemaValidationError: ${validationError}`;
          }
        }
        // E231: apply optional transform hook to the structured result.
        if (t.transform && t.structured !== undefined && !t.errorText) {
          try {
            t.structured = t.transform(t.structured);
          } catch (err) {
            t.errorText = `TransformError: ${describeError(err)}`;
          }
        }
        if (t.schema && t.structured === undefined && !t.errorText) {
          t.errorText =
            "StructuredOutputError: no parseable JSON found in the final message";
        }
      } catch (err) {
        t.errorText = describeError(err);
      }
      // E205: populate token usage and cost from session metadata.
      await fetchUsage(t);
      // E203: fire-and-forget webhook on completion.
      void fireWebhook(t);
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
      metrics.errors++;
      try {
        const o = await fetchOutcome(t.childID);
        if (o.text) t.resultText = o.text;
        if (o.error && !t.errorText) t.errorText = o.error;
      } catch {
        /* ignore */
      }
      void fireWebhook(t);
      settleWaiters(t);
      if (cfg.autoInjectParent) await postToParent(t, buildCompletionNote(t));
      log("warn", `child ${t.childID} errored`, { error: t.errorText });
      pruneTracked();
    };

    const handleInterrupted = async (t: Tracked): Promise<void> => {
      if (isTerminal(t.state)) return;
      // Terminal transition first so concurrent events can't double-handle,
      // then settle waiters immediately before any best-effort server reads.
      t.state = "cancelled";
      t.errorText = t.errorText ?? "Session was interrupted.";
      t.idleAt = Date.now();
      touch(t);
      void fireWebhook(t);
      const hadWaiter = settleWaiters(t);
      pruneTracked();
      void (async () => {
        try {
          const o = await fetchOutcome(t.childID);
          if (o.text) t.resultText = o.text;
        } catch {
          /* ignore */
        }
        if (cfg.autoInjectParent && !hadWaiter) {
          await postToParent(t, buildCompletionNote(t));
        }
      })();
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
            metrics.timeouts++;
            void withTimeout(
              ctx.session.interrupt({ sessionID: t.childID }),
              SERVER_TIMEOUT_MS,
              "session.interrupt",
            ).catch(() => undefined);
          }
          // Best-effort refresh so the timeout outcome carries the latest
          // partial text instead of a stale cache entry.
          void (async () => {
            try {
              const o = await fetchOutcome(t.childID);
              if (o.text) t.resultText = o.text;
              if (o.error && !t.errorText) t.errorText = o.error;
            } catch {
              /* ignore */
            }
            resolve(outcomeOf(t));
          })();
        }, ms);
        t.waiters.push({ resolve, timer });
      });
    };

    const formatOutcome = (
      o: SessionOutcome,
      t?: Tracked,
      maxChars?: number,
      fields?: string[],
    ): string => {
      const running = o.status === "running" || o.status === "starting";
      const lines = [`sessionId: ${o.sessionId}`, `status: ${o.status}`];
      if (t) lines.push(`title: ${t.title}`);
      if (t?.agentMode) lines.push(`agent_mode: ${t.agentMode}`);
      if (typeof o.elapsedSec === "number") lines.push(`elapsed_sec: ${o.elapsedSec}`);
      if (t?.directory) lines.push(`directory: ${t.directory}`);
      if (t?.pendingPermission) lines.push(`pending_permission: ${t.pendingPermission}`);
      // E256: filter structured output to specific fields when requested.
      if (fields && fields.length > 0 && t?.structured && typeof t.structured === "object") {
        const filtered: Record<string, unknown> = {};
        for (const f of fields) {
          if (f in (t.structured as Record<string, unknown>)) {
            filtered[f] = (t.structured as Record<string, unknown>)[f];
          }
        }
        lines.push(`structured: ${JSON.stringify(filtered)}`);
      } else if (t?.structured !== undefined) {
        lines.push(`structured: ${JSON.stringify(t.structured)}`);
      }
      if (o.error) lines.push(`error: ${maxChars ? truncate(o.error, maxChars) : o.error}`);
      if (o.structured !== undefined) {
        lines.push("structured_output:");
        const structuredStr = JSON.stringify(o.structured, null, 2);
        lines.push(maxChars ? truncate(structuredStr, maxChars) : structuredStr);
      }
      if (running) {
        if (o.partial) {
          lines.push("partial_message:");
          lines.push(maxChars ? truncate(o.partial, maxChars) : o.partial);
        }
      } else if (o.text) {
        lines.push("final_message:");
        lines.push(maxChars ? truncate(o.text, maxChars) : o.text);
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
      if (cached && Date.now() - cached.at < PARENT_DEFAULTS_TTL_MS) {
        return { agent: cached.agent, model: cached.model };
      }
      const result: { agent?: string; model?: ModelRef } = {};
      try {
        const messages = await withTimeout(
          ctx.session.context({ sessionID: parentID }),
          SERVER_TIMEOUT_MS,
          "session.context",
        );
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
      // Cap entries so a long-lived server can't grow this map without bound.
      // L66: LRU eviction — delete then re-insert moves the entry to the end,
      // and the while loop evicts from the front (least recently used).
      if (parentDefaults.has(parentID)) parentDefaults.delete(parentID);
      parentDefaults.set(parentID, { ...result, at: Date.now() });
      while (parentDefaults.size > MAX_PARENT_DEFAULTS) {
        const oldest = parentDefaults.keys().next();
        if (oldest.done) break;
        parentDefaults.delete(oldest.value);
      }
      return result;
    };

    // Cache agent and model lists with a TTL to avoid repeated server calls
    const agentListCache = { at: 0, data: [] as Array<{ name: string; model?: ModelRef; mode?: string }> };
    const modelListCache = { at: 0, data: [] as Array<{ providerID: string; modelID: string }> };
    const LIST_CACHE_TTL_MS = 60_000;

    const resolveTarget = async (
      agentName: string | undefined,
      modelStr: string | undefined,
      parentID: string,
    ): Promise<{ agent?: string; model?: ModelRef; agentMode?: string; error?: string }> => {
      let agents = agentListCache.data;
      if (Date.now() - agentListCache.at > LIST_CACHE_TTL_MS) {
        try {
          const res = (await withTimeout(
            ctx.agent.list(),
            SERVER_TIMEOUT_MS,
            "agent.list",
          )) as unknown as {
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
          agentListCache.data = agents;
          agentListCache.at = Date.now();
        } catch (err) {
          log("warn", "agent.list failed; skipping agent validation", {
            error: describeError(err),
          });
        }
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
      let inherited: { agent?: string; model?: ModelRef } | undefined;
      if (modelStr) {
        const parsed = parseModelString(modelStr);
        if ("error" in parsed) return { error: parsed.error };
        let models = modelListCache.data;
        if (Date.now() - modelListCache.at > LIST_CACHE_TTL_MS) {
          try {
            const res = (await withTimeout(
              ctx.model.list(),
              SERVER_TIMEOUT_MS,
              "model.list",
            )) as unknown as {
              data?: Array<{ providerID: string; modelID: string }>;
            };
            models = res.data ?? [];
            modelListCache.data = models;
            modelListCache.at = Date.now();
          } catch (err) {
            log("warn", "model.list failed; skipping model validation", {
              error: describeError(err),
            });
          }
        }
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
        model = parsed;
      } else if (agent?.model) {
        model = agent.model;
      } else if (cfg.inheritParentDefaults) {
        // Single parent lookup; reuse the result for the model fallback below.
        const parent = await parentDefaultsFor(parentID);
        inherited = parent ?? undefined;
        model = parent?.model;
        if (!agent && parent?.agent) {
          const found = agents.find((a) => a.name === parent.agent);
          if (found) agent = { name: found.name, model: found.model, mode: found.mode };
        }
      }
      if (!model && inherited?.model) {
        model = inherited.model;
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

    /** Queue the child's turn. Callers await this so a failed send surfaces. */
    const startTurn = async (t: Tracked, text: string): Promise<void> => {
      // Clear the outcome cache so subsequent fetches get fresh data
      outcomeCache.delete(t.childID);
      try {
        await withTimeout(
          ctx.session.prompt({ sessionID: t.childID, text }),
          SERVER_TIMEOUT_MS,
          "session.prompt",
        );
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
      // E250: cache the hydration result with a short TTL.
      const cached = hydrateCache.peek(sessionId);
      if (cached) return cached;
      let info:
        | { id?: string; title?: string; parentID?: string; metadata?: Record<string, unknown> }
        | undefined;
      try {
        info = (await withTimeout(
          ctx.session.get({ sessionID: sessionId }),
          SERVER_TIMEOUT_MS,
          "session.get",
        )) as unknown as typeof info;
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
        // Sentinel for an unknown parent: adopted children whose parent can't
        // be determined must stay visible in session_list (never filtered as
        // "another parent's child").
        parentSessionID: info.parentID ?? metaParent ?? "unknown",
        shortId: short,
        title: title || sessionId,
        // OS-1: an adopted session may still be running — we cannot tell
        // from `session.get`, so attach as running and fetch the latest
        // outcome. Marking it idle made `waitFor` resolve immediately with
        // empty text and reported a live session as finished.
        state: "running",
        createdAt: Date.now(),
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        injected: false,
        waiters: [],
      };
      tracked.set(sessionId, t);
      try {
        const o = await fetchOutcome(sessionId);
        if (o.text) t.resultText = o.text;
        if (o.error && !t.errorText) t.errorText = o.error;
      } catch {
        /* outcome fetch is best-effort; the event pump corrects state */
      }
      hydrateCache.set(sessionId, t);
      log("debug", `adopted child ${sessionId} from server state`, {
        parent: t.parentSessionID,
      });
      return t;
    };

    /**
     * Resolve a session reference to a real id.
     *
     * Presence output names a session by the shortest prefix that is unique
     * among those on show, which is wider than 8 characters exactly when 8 would
     * be ambiguous. So the id the agent was *shown* is not always the id it has
     * to *send*: an exact match wins, otherwise the reference must match exactly
     * one known session. An ambiguous prefix is refused with the candidates
     * rather than silently picking the first, since picking wrong would message
     * a stranger.
     *
     * Returns null when the reference matches nothing, so callers can fall back
     * to their own "unknown session" handling.
     */
    const resolveSessionRef = (
      ref: string,
    ): { id: string } | { ambiguous: string } | null => {
      if (!ref) return null;
      if (tracked.has(ref) || peers.has(peerKey(ref))) return { id: ref };
      // Scanned live rather than through a prefix index: peers arrive and leave
      // on the event pump, and an index built at a different time would either
      // miss a fresh peer or keep offering a deleted one as a valid target.
      const candidates = [...new Set(knownSessionIds())].filter((id) => id.startsWith(ref));
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return { id: candidates[0] };
      const known = knownSessionIds();
      return {
        ambiguous:
          `"${ref}" matches ${candidates.length} sessions (${candidates
            .map((id) => displayId(id, known))
            .join(", ")}). Use more characters of the id.`,
      };
    };

    const requireTracked = async (
      sessionId: string,
    ): Promise<{ t: Tracked } | { message: string }> => {
      const resolved = resolveSessionRef(sessionId);
      if (resolved && "ambiguous" in resolved) return { message: resolved.ambiguous };
      const id = resolved ? resolved.id : sessionId;
      const t = tracked.get(id) ?? (await hydrate(id));
      if (!t) {
        return {
          message: `Unknown session "${sessionId}". Pass a session spawned by this plugin (list_sessions) or a peer in this project (project_sessions).`,
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
      tags?: string[];
      priority?: "low" | "normal" | "high";
      transform?: (structured: unknown) => unknown;
    }): Promise<string> => {
      // OS-2: take the concurrency slot synchronously, before any await. Every
      // limit check below used to run against `tracked`, which does not contain
      // this child until `session.create` resolves seconds later, so a parallel
      // `spawn_many` batch all saw room and all spawned.
      if (activeCount() + reservedTotal() >= cfg.maxConcurrentSessions) {
        return `Refused: concurrency limit reached (${cfg.maxConcurrentSessions} active child sessions). Wait for one to finish or call session_cancel.`;
      }
      if (
        activeForParent(opts.parentID) + (reservedSlots.get(opts.parentID) ?? 0) >=
        cfg.maxSessionsPerParent
      ) {
        return `Refused: per-parent limit reached (${cfg.maxSessionsPerParent} active children for this session).`;
      }
      reserveSlot(opts.parentID);
      // Flipped once the tracked record exists, at which point the record itself
      // holds the slot and the reservation is let go (even on `wait: true`, which
      // keeps this function pending for the child's whole turn).
      let slotHandedOff = false;
      try {
        // Validate the working directory up front so a bad value fails fast
        // instead of surfacing as a confusing server-side create error.
        if (opts.directory !== undefined) {
          if (typeof opts.directory !== "string" || !opts.directory.trim()) {
            return "Refused: directory must be a non-empty path string.";
          }
          try {
            const st = await withTimeout(
              fs.promises.stat(opts.directory),
              SERVER_TIMEOUT_MS,
              "fs.stat",
            );
            if (!st.isDirectory()) return `Refused: directory is not a folder: ${opts.directory}`;
          } catch {
            return `Refused: directory does not exist or is unreadable: ${opts.directory}`;
          }
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

        // Use crypto.randomUUID() for collision resistance. The old
        // Math.random().toString(36).slice(2, 8) could produce empty or very
        // short strings, and two children spawned in the same tick could get
        // the same id.
        const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        const title = `${cfg.titlePrefix}:${sid}] ${opts.titleText}`;

        let childID: string;
        try {
          const created = await withTimeout(
            ctx.session.create({
              title,
              ...(target.agent ? { agent: target.agent } : {}),
              ...(target.model
                ? { model: { id: target.model.modelID, providerID: target.model.providerID } }
                : {}),
              ...(opts.directory ? { location: { directory: opts.directory } } : {}),
              metadata: { parentSessionID: opts.parentID, spawnedBy: "opencode-sessions" },
            }),
            SERVER_TIMEOUT_MS,
            "session.create",
          );
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
          tags: opts.tags,
          priority: opts.priority,
          transform: opts.transform,
        };
        tracked.set(childID, t);
        // OS-2: the tracked record now carries this slot.
        slotHandedOff = true;
        releaseSlot(opts.parentID);
        metrics.spawns++;
        invalidatePresenceCaches();

        let text = opts.promptText;
        if (opts.schema) text += schemaInstruction(opts.schema);
        // Await the prompt handoff so a failed first turn is reported instead
        // of claiming the child is running (see startTurn).
        await startTurn(t, text);

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
          if (isTerminal(t.state) && t.errorText) {
            return `Failed to ${opts.label.toLowerCase()} child session ${childID}: ${t.errorText}${warn}`;
          }
          return (
            `${opts.label} child session ${childID} (title: ${title}) with status "running". ` +
            `It runs in the background and appears in the Desktop switcher like a session opened with +. ` +
            `Its result will be injected into this session when it goes idle. ` +
            `Use session_result("${childID}", wait:true) to block for it.${warn}`
          );
        }

        const outcome = await waitFor(t, timeoutSec);
        const formatted = formatOutcome(outcome, t);
        return warn ? `${formatted}${warn}` : formatted;
      } finally {
        // OS-2: release the reservation on every path that never produced a
        // tracked record — a refusal, a create failure, or a throw — so a failed
        // launch cannot leak a slot and shrink the pool for good.
        if (!slotHandedOff) releaseSlot(opts.parentID);
      }
    };

    /** Compact transcript of a session for handoff briefs. */
    const buildTranscript = async (
      sessionID: string,
      messageLimit: number,
    ): Promise<string> => {
      // E249: cache the transcript with a TTL.
      const cacheKey = `${sessionID}\u0000${messageLimit}`;
      const cached = transcriptCache.peek(cacheKey);
      if (cached) return cached;
      const limit = Math.min(Math.max(messageLimit, 1), 100);
      let messages: Array<{
        type: string;
        text?: string;
        content?: Array<{ type: string; text?: string }>;
      }> = [];
      try {
        messages = (await withTimeout(
          ctx.session.context({ sessionID }),
          SERVER_TIMEOUT_MS,
          "session.context",
        )) as unknown as typeof messages;
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
      const result = out
        ? truncate(out, 12_000)
        : "(no user/assistant messages in this session yet)";
      transcriptCache.set(cacheKey, result);
      return result;
    };

    const abort = new AbortController();
    // Circuit breaker: if we see too many events for the same session in a short
    // period, we skip them to prevent infinite loops.
    const eventCounts = new Map<string, { count: number; resetAt: number }>();
    const EVENT_CIRCUIT_BREAKER_THRESHOLD = 100;
    const EVENT_CIRCUIT_BREAKER_WINDOW_MS = 1000;
    const pump = (async (): Promise<void> => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          const ev = raw as unknown as {
            type?: string;
            data?: Record<string, unknown>;
            location?: { directory?: string; project?: { id?: string } };
          };
          try {
            const type = typeof ev.type === "string" ? ev.type : "";
            const data = (ev.data ?? {}) as Record<string, unknown>;
            const sessionID =
              typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined;

            lastEventAt = Date.now();
            // Circuit breaker: skip events if we've seen too many for this session
            if (sessionID) {
              const now = Date.now();
              const key = `${sessionID}:${type}`;
              const entry = eventCounts.get(key);
              if (!entry || now > entry.resetAt) {
                eventCounts.set(key, { count: 1, resetAt: now + EVENT_CIRCUIT_BREAKER_WINDOW_MS });
              } else {
                entry.count++;
                if (entry.count > EVENT_CIRCUIT_BREAKER_THRESHOLD) {
                  log("warn", `circuit breaker triggered for ${key} — skipping event`);
                  continue;
                }
              }
            }
            // Deletion is checked before the presence block below, which would
            // otherwise re-register the session as `running` (it is neither
            // `session.idle` nor `succeeded`) and resurrect it in the list we
            // are trying to purge.
            if (type === "session.deleted") {
              if (sessionID) {
                forgetPeer(sessionID);
                selfSessionIDs.delete(sessionID);
                // A deleted child must not leave a waiter hanging: settle it
                // before dropping the record, or session_result(wait:true) waits
                // out its full timeout on a session that no longer exists.
                const dead = tracked.get(sessionID);
                if (dead) {
                  if (!isTerminal(dead.state)) {
                    dead.state = "cancelled";
                    dead.errorText = "Session was deleted.";
                    dead.idleAt = Date.now();
                  }
                  settleWaiters(dead);
                  tracked.delete(sessionID);
                }
              }
              continue;
            }
            // Presence: any session event is proof that session exists and is
            // working, whether or not this plugin spawned it or it ever claimed
            // itself. Recorded before the tracked-only branches below so an
            // untracked peer still registers.
            if (sessionID && typeof ev.location?.directory === "string") {
              recordPeer(sessionID, ev.location.directory, {
                state:
                  type === "session.idle" || type === "session.execution.succeeded"
                    ? "idle"
                    : "running",
                agent:
                  typeof data["agent"] === "string" ? (data["agent"] as string) : undefined,
                // Carried so lineage (parent/child/sibling) still works for a
                // peer first seen in another opencode process.
                parentSessionID: tracked.get(sessionID)?.parentSessionID,
              });
              mirrorPeers();
            }
            // OS-1: the stuck-session sweeper decides "stuck" from
            // `lastActivityAt`, which previously only moved on spawn, prompt,
            // permission and terminal events. A healthy child emits
            // step/permission/tool/message events continuously, so a long but
            // perfectly busy run looked stalled for `hardTimeoutSec` and was
            // force-cancelled mid-work. Any event for a session we track is
            // proof of life.
            if (sessionID) {
              const live = tracked.get(sessionID);
              if (live && !isTerminal(live.state)) touch(live);
            }
            if (type === "session.idle" || type === "session.execution.succeeded") {
              if (!sessionID) continue;
              // An idle session is not mid-edit, so it holds nothing. This is
              // the release signal that lets the waiting side proceed.
              releaseClaimsFor(sessionID);
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
                  // OS-4: this is the event pump — every other server call in
                  // this loop is capped by `withTimeout` because a hung request
                  // here stops idle detection for *every* session in the process,
                  // not just this one. This call had run unbounded for a long
                  // time and, with the default `autoApprove` setting, does so on
                  // the common path.
                  await withTimeout(
                    ctx.permission.reply({
                      sessionID: t.childID,
                      requestID: d.id,
                      decision: cfg.autoApprovePermissions,
                    }),
                    SERVER_TIMEOUT_MS,
                    "permission.reply",
                  );
                  t.pendingPermission = undefined;
                  t.pendingPermissionId = undefined;
                  metrics.permissionsAutoApproved++;
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

    // Event pump watchdog: if no events have been processed for a while while
    // there are active sessions, the pump may be stalled. Log a warning.
    let lastEventAt = Date.now();
    const EVENT_PUMP_WATCHDOG_INTERVAL_MS = 60_000;
    const EVENT_PUMP_WATCHDOG_THRESHOLD_MS = 300_000;
    const eventPumpWatchdog = setInterval(() => {
      const activeSessions = [...tracked.values()].filter((t) => !isTerminal(t.state)).length;
      if (activeSessions === 0) {
        lastEventAt = Date.now();
        return;
      }
      const silentFor = Date.now() - lastEventAt;
      if (silentFor > EVENT_PUMP_WATCHDOG_THRESHOLD_MS) {
        log("warn", `event pump may be stalled — no events for ${Math.round(silentFor / 1000)}s with ${activeSessions} active session(s)`);
      }
    }, EVENT_PUMP_WATCHDOG_INTERVAL_MS);
    unrefTimer(eventPumpWatchdog);

    const spawnSchema = z.object({
      prompt: z.string().describe("The brief / task sent as the child's first user message."),
      title: z.string().optional().describe("Human title; a short id is prepended automatically."),
      agent: z.string().optional().describe("Agent name to run the child with (validated against available agents)."),
      model: z.string().optional().describe('Model as "providerID/modelID" (validated against configured providers).'),
      directory: z.string().optional().describe("Working directory for the child session (defaults to this project)."),
      wait: z.boolean().optional().describe("If true, wait for the child to go idle before returning (default false)."),
      timeoutSec: z.number().optional().describe("Wait timeout in seconds (default 900, hard cap enforced)."),
      schema: z.record(z.string(), z.any()).optional().describe("Optional JSON Schema; the child is instructed to answer with conforming JSON, which surfaces as structured_output."),
      tags: z.array(z.string()).optional().describe("Optional tags for categorizing the session."),
      priority: z.enum(["low", "normal", "high"]).optional().describe("Priority level for the session (default normal)."),
    });

    // ------------------------------------------------------------------
    // Concurrent-edit tracking
    //
    // `tool.execute.before` is the only seam that sees which file a session is
    // about to write, and it is server-wide — so a write by a spawned child
    // registers just as well as one by a session the user opened by hand. The
    // hook only observes; the coordination happens in the brief below, which is
    // injected *before* the model chooses its next tool, so the model can wait
    // instead of being interrupted mid-write.
    // ------------------------------------------------------------------
    const registrations: Array<{ dispose: () => Promise<void> }> = [];
    if (cfg.fileLocks !== "off") {
      // E236: per-tool write gate configuration.
      const fileLockToolsSet = cfg.fileLockTools
        ? new Set(cfg.fileLockTools.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))
        : undefined;
      // E237: per-file write gate configuration.
      const fileLockIncludePatterns = cfg.fileLockInclude
        ? cfg.fileLockInclude.split(",").map((p) => p.trim()).filter(Boolean)
        : undefined;
      const fileLockExcludePatterns = cfg.fileLockExclude
        ? cfg.fileLockExclude.split(",").map((p) => p.trim()).filter(Boolean)
        : undefined;
      const matchesGlob = (path: string, patterns: string[]): boolean => {
        for (const pattern of patterns) {
          if (pattern === path) return true;
          // Simple glob: * matches any sequence, ? matches single char
          const regex = new RegExp(
            `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
          );
          if (regex.test(path)) return true;
        }
        return false;
      };
      try {
        const reg = await ctx.tool.hook("execute.before", (event) => {
          const sessionID =
            typeof event?.sessionID === "string" ? event.sessionID : "";
          if (!sessionID || typeof event.tool !== "string") return;
          // E226: check per-tool configuration.
          if (fileLockToolsSet && !fileLockToolsSet.has(event.tool.toLowerCase())) return;
          if (!fileLockToolsSet && !isFileMutatingTool(event.tool)) return;
          const paths = extractEditPaths(event.input);
          if (paths.length === 0) return;
          // E237: check per-file include/exclude patterns.
          const filteredPaths = paths.filter((p) => {
            if (fileLockExcludePatterns && matchesGlob(p, fileLockExcludePatterns)) return false;
            if (fileLockIncludePatterns && !matchesGlob(p, fileLockIncludePatterns)) return false;
            return true;
          });
          if (filteredPaths.length === 0) return;
          try {
            claimFilesFor(sessionID, event.tool, filteredPaths);
          } catch (err) {
            // Claiming is advisory; never let it break a tool call.
            log("debug", `file claim failed: ${describeError(err)}`);
          }
        });
        // A host that returns nothing here is tolerated rather than trusted:
        // cleanup() must not fault on a malformed registration.
        if (reg && typeof reg.dispose === "function") registrations.push(reg);
      } catch (err) {
        log("warn", `file-lock hook failed: ${describeError(err)}`);
      }
    }

    // ------------------------------------------------------------------
    // Ambient peer awareness
    //
    // Hooks `context` rather than only exposing a tool, because the point is
    // that an agent should know a peer exists *before* it invents an
    // explanation for a file changing under it. Follows goal.ts's pattern:
    // strip our own previous injection by sentinel, then push a fresh one, so
    // it survives compaction without ever doubling up.
    // ------------------------------------------------------------------
    // Repetition detection used to live here (a tool-call circuit breaker plus
    // a "recent tool calls" self-awareness context hook). Both duplicated the
    // dedicated, always-on `loop-guard` plugin, which nudges on the 4th
    // consecutive identical call and cancels on the 8th — a stronger signal
    // (consecutive, not merely repeated within a window) that also never throws
    // out of a hook. Keeping a single owner means the model is neither nudged
    // nor interrupted twice for the same loop.
    if (cfg.peerAwareness) {
      try {
        await ctx.session.hook("context", (event) => {
          const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
          if (!sessionID) return;

          const messages = Array.isArray(event.messages) ? event.messages : [];
          const directory = defaultDirectory;

          // Self-claim: this fires on the session's very first turn, before it
          // has produced any observable event. Without it a brand-new idle
          // session is invisible to peers until it does something.
          const self = peers.get(peerKey(sessionID));
          const dueForHeartbeat =
            !self || Date.now() - self.lastSeenAt >= cfg.peerHeartbeatSec * 1000;
          if (dueForHeartbeat) {
            selfSessionIDs.add(sessionID);
            recordPeer(sessionID, directory, {
              state: "running",
              claimed: true,
              // Carried so a peer in another process can still recognise this
              // session as a parent or a sibling.
              parentSessionID: tracked.get(sessionID)?.parentSessionID,
            });
            mirrorPeers();
          }

          const notice = buildPeerNotice(directory, sessionID);
          const wanted = notice ? `${PEER_SENTINEL}\n${notice}` : "";

          // Strip the prior injection first, even when we are not adding a new
          // one, or a session that lost its peers keeps a stale notice. An
          // unchanged brief is left where it is rather than re-appended: the
          // roster is the same, so re-adding it would only cost tokens, churn the
          // cached prompt prefix, and — because a fresh system message reads as
          // news to the model — provoke an acknowledgement that starts the whole
          // cycle again in every peer session. Equality is on the fingerprint, not
          // the raw text, so the per-second "Ns ago" field cannot defeat it.
          const wantedPrint = noticeFingerprint(wanted);
          let kept = false;
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role !== "system") continue;
            const text =
              typeof m.content === "string"
                ? m.content
                : Array.isArray(m.content)
                  ? m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("")
                  : "";
            if (!text.includes(PEER_SENTINEL)) continue;
            if (!kept && wanted && noticeFingerprint(text) === wantedPrint) {
              kept = true;
              continue;
            }
            messages.splice(i, 1);
          }
          if (!notice || kept) return;
          messages.push({
            role: "system",
            content: [{ type: "text", text: wanted }],
          });
        });
      } catch (err) {
        // A failed awareness hook must not disable session orchestration.
        log("warn", `peer awareness hook failed: ${describeError(err)}`);
      }
    }

    await ctx.tool.transform((editor) => {
      // The gate is installed first, on the pre-existing tool set, so it never
      // sees (or wraps) the tools registered just below.
      if (cfg.fileLocks === "enforce") {
        try {
          const wrapped = installWriteGate(editor as never);
          if (wrapped.length === 0) {
            log("warn", "fileLocks=enforce but no file-mutating tool could be gated");
          } else {
            log("info", `fileLocks=enforce: gating ${wrapped.join(", ")}`);
          }
        } catch (err) {
          log("warn", `write gate failed, collisions stay advisory: ${describeError(err)}`);
        }
      }
      editor.add({
        name: "spawn_session",
        description:
          "Spawn a fresh child session, brief it with a prompt, and (optionally) wait for it to finish. Non-blocking: the child runs in its own session while this agent stays responsive, and it appears in the Desktop session switcher as if opened with +. Returns a sessionId for session_result/session_send/session_cancel.",
        input: spawnSchema,
        execute: async (input, toolCtx) => {
          const args = input as z.infer<typeof spawnSchema>;
          const parentID = toolCtx.sessionID;
          if (checkGlobalCircuitBreaker()) {
            return {
              content: "Spawn blocked: global circuit breaker is open due to too many stuck sessions. Try again later.",
            };
          }
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
            tags: args.tags,
            priority: args.priority,
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
          maxChars: z.number().optional().describe("Maximum characters to include in text fields."),
          fields: z.array(z.string()).optional().describe("E262: only include these fields in structured output."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; wait?: boolean; timeoutSec?: number; maxChars?: number; fields?: string[] };
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
            return { content: formatOutcome(outcome, t, args.maxChars, args.fields) };
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
              content: formatOutcome({ ...outcomeOf(t), partial }, t, args.maxChars, args.fields),
            };
          }
          if (!t.resultText && t.structured === undefined) {
            const o = await fetchOutcome(t.childID);
            if (o.text) t.resultText = o.text;
            if (o.error && !t.errorText) t.errorText = o.error;
          }
          return { content: formatOutcome(outcomeOf(t), t, args.maxChars, args.fields) };
        },
      });

      editor.add({
        name: "session_send",
        description:
          "Send a message to another session. Works for sessions this plugin spawned and for any other session in this project (see project_sessions) — pass the id it showed you; an unambiguous prefix is accepted, and an ambiguous one is refused rather than guessed. With noReply:true it injects context without triggering a new assistant turn.",
        input: z.object({
          sessionId: z.string().describe("Session id (child or peer)."),
          text: z.string().describe("Message text."),
          noReply: z.boolean().optional().describe("Inject the message without asking the session to reply (default false)."),
          replyTo: z.string().optional().describe("E263: message id to reply to."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; text: string; noReply?: boolean; replyTo?: string };
          // Accept the label the agent was shown, not only a full id: presence
          // output widens a prefix when 8 characters would be ambiguous, so the
          // two differ exactly when it matters.
          const resolved = resolveSessionRef(args.sessionId);
          if (resolved && "ambiguous" in resolved) return { content: resolved.ambiguous };
          const target = resolved ? resolved.id : args.sessionId;
          const found = await requireTracked(target);
          if ("message" in found) {
            // Not a session we spawned. It may still be a known peer in this
            // project: ctx.session.synthetic/prompt address any session, so
            // refusing here was a plugin-level restriction, not a platform one.
            const peer = peers.get(peerKey(target));
            if (peer && peer.directory === defaultDirectory) {
              // Verify before messaging rather than trusting a timer. A quiet
              // peer may be mid-command (perfectly reachable) or deleted (not
              // reachable at all), and only the server knows which.
              const verdict = await verifyPeer(peer);
              if (verdict === "gone") {
                return {
                  content: `Not sent: ${displayId(peer.sessionId, knownSessionIds())} is gone — the server reports no such session. It has been removed from the presence list.`,
                };
              }
              try {
                const sent = await deliverToSession(target, args.text, args.noReply === true);
                // OS-8: a rate-limited send is not a delivery. Nothing used to
                // change here when `how` said "Skipped", so the caller was told
                // the peer had been reached, the peer was marked running, and the
                // metric counted a message that never left.
                if (!sent.delivered) {
                  return { content: `${sent.how} Nothing was sent to ${target}.` };
                }
                // Announce the delivery so the peer's own awareness line shows
                // that someone reached out, rather than context appearing.
                recordPeer(peer.sessionId, peer.directory, { state: "running" });
                mirrorPeers();
                metrics.peerMessagesSent++;
                const quiet = verdict === "busy";
                return {
                  content:
                    `${sent.how} (peer session, not spawned by this plugin)` +
                    (quiet
                      ? ` It had been idle for ${agoText(peer.lastSeenAt)}, so this starts a new turn in it.`
                      : ""),
                };
              } catch (err) {
                return { content: `Failed to send to peer ${args.sessionId}: ${describeError(err)}` };
              }
            }
            return { content: found.message };
          }
          const t = found.t;

          if (args.noReply) {
            try {
              await ctx.session.synthetic({ sessionID: t.childID, text: args.text });
              return { content: `Injected context into ${t.childID} (no reply requested).` };
            } catch (err) {
              return { content: `Failed to inject into ${t.childID}: ${describeError(err)}` };
            }
          }

          // Await the prompt handoff so a failed send is reported instead of
          // silently claiming the child is running again (see startTurn).
          try {
            const sent = await deliverToSession(target, args.text, false);
            // OS-8: say so when the rate limiter suppressed the send, rather than
            // reporting a follow-up that was never delivered.
            if (!sent.delivered) return { content: sent.how };
            return { content: `${sent.how} Use session_result(wait:true) to await completion.` };
          } catch (err) {
            return { content: `Failed to send follow-up to ${t.childID}: ${describeError(err)}` };
          }
        },
      });

      editor.add({
        name: "session_cancel",
        description: "Abort a spawned child session.",
        input: z.object({
          sessionId: z.string().describe("Child session id."),
          reason: z.string().optional().describe("E265: reason for cancellation, recorded in the session."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; reason?: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          try {
            await withTimeout(
              ctx.session.interrupt({ sessionID: t.childID }),
              SERVER_TIMEOUT_MS,
              "session.interrupt",
            );
          } catch (err) {
            return { content: `interrupt failed: ${describeError(err)}` };
          }
          if (!isTerminal(t.state)) {
            t.state = "cancelled";
            t.errorText = args.reason ?? "Cancelled by parent.";
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
          timeoutSec: z.number().optional().describe("E266: timeout in seconds for the permission reply."),
        }),
        execute: async (input) => {
          const args = input as {
            sessionId: string;
            permissionId?: string;
            response?: "once" | "always" | "reject";
            timeoutSec?: number;
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
            await withTimeout(
              ctx.permission.reply({
                sessionID: t.childID,
                requestID,
                decision,
              }),
              SERVER_TIMEOUT_MS,
              "permission.reply",
            );
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
        name: "export_session",
        description:
          "Export a spawned child session's messages to a JSON or Markdown file for archival or sharing.",
        input: z.object({
          sessionId: z.string().describe("Child session id returned by spawn_session."),
          format: z.enum(["json", "markdown"]).optional().describe("Export format (default json)."),
          outputPath: z
            .string()
            .max(1024)
            .optional()
            .describe(
              "File path to write to, relative to the project directory (defaults to <sessionId>.json or .md there). Paths outside the project are refused, and an existing file is never overwritten.",
            ),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; format?: "json" | "markdown"; outputPath?: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          try {
            const messages = await withTimeout(
              ctx.session.context({ sessionID: t.childID }),
              SERVER_TIMEOUT_MS,
              "session.context",
            );
            const format = args.format ?? "json";
            const ext = format === "json" ? "json" : "md";
            let content: string;
            if (format === "json") {
              content = JSON.stringify({ session: t, messages }, null, 2);
            } else {
              const lines = [
                `# Session Export: ${t.title}`,
                "",
                `**ID:** ${t.childID}`,
                `**State:** ${t.state}`,
                `**Created:** ${new Date(t.createdAt).toISOString()}`,
                "",
                "## Messages",
                "",
              ];
              for (const m of messages as Array<{ type: string; content?: Array<{ type: string; text?: string }>; text?: string }>) {
                const text = typeof m.text === "string" ? m.text : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
                lines.push(`### ${m.type}`, "", text, "");
              }
              content = lines.join("\n");
            }
            // OS-9: confine the write to the session's project directory and
            // never clobber an existing file.
            const root = t.directory ?? defaultDirectory;
            const resolved = await resolveExportPath(args.outputPath, root, `${t.childID}.${ext}`);
            if ("error" in resolved) {
              return { content: `Refused to export session ${t.childID}: ${resolved.error}` };
            }
            const written = await writeNewFile(resolved.path, content);
            return {
              content: `Exported session ${t.childID} to ${written} (${format} format, ${messages.length} messages).`,
            };
          } catch (err) {
            return { content: `Failed to export session ${t.childID}: ${describeError(err)}` };
          }
        },
      });

      editor.add({
        name: "spawn_many",
        description:
          "Spawn multiple child sessions in parallel, each with its own prompt. Useful for fanning out independent tasks.",
        input: z.object({
          sessions: z.array(z.object({
            prompt: z.string().describe("The brief / task for this child."),
            title: z.string().optional().describe("Human title; a short id is prepended automatically."),
            agent: z.string().optional().describe("Agent name for this child."),
            model: z.string().optional().describe('Model as "providerID/modelID".'),
          })).min(1).max(20).describe("Array of session specs to spawn."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { sessions: Array<{ prompt: string; title?: string; agent?: string; model?: string }> };
          const parentID = toolCtx.sessionID;
          const results = await Promise.all(
            args.sessions.map(async (spec) => {
              const out = await launch({
                parentID,
                promptText: spec.prompt,
                titleText: spec.title?.trim() || deriveTitle(spec.prompt),
                agentName: spec.agent,
                modelStr: spec.model,
                directory: defaultDirectory,
                wait: false,
                label: "Spawned",
              });
              return { prompt: spec.prompt.slice(0, 50), result: out };
            }),
          );
          const lines = results.map((r, i) => `${i + 1}. ${r.prompt}... → ${r.result}`);
          return { content: `Spawned ${results.length} sessions:\n${lines.join("\n")}` };
        },
      });

      editor.add({
        name: "session_stats",
        description:
          "Show metrics and observability data for the opencode-sessions plugin.",
        input: z.object({}),
        execute: async () => {
          const avgDuration = sessionDurations.length > 0
            ? (sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length).toFixed(1)
            : "N/A";
          const stats = durationStatsSnapshot();
          const lines = [
            "## Plugin Metrics",
            "",
            `- **Spawns:** ${metrics.spawns}`,
            `- **Completions:** ${metrics.completions}`,
            `- **Errors:** ${metrics.errors}`,
            `- **Timeouts:** ${metrics.timeouts}`,
            `- **Permissions Auto-Approved:** ${metrics.permissionsAutoApproved}`,
            `- **Peer Messages Sent:** ${metrics.peerMessagesSent}`,
            `- **Broadcasts Sent:** ${metrics.broadcastsSent}`,
            `- **File Lock Waits:** ${metrics.fileLockWaits}`,
            `- **Deadlocks Detected:** ${metrics.deadlocksDetected}`,
            `- **Avg Session Duration:** ${avgDuration}s`,
            `- **Tracked Sessions:** ${tracked.size}`,
            `- **Known Peers:** ${peers.size}`,
            "",
            "## Duration Statistics (running)",
            "",
            `- **Count:** ${stats.count}`,
            `- **Sum:** ${stats.sum}s`,
            `- **Min:** ${stats.min}s`,
            `- **Max:** ${stats.max}s`,
            `- **Mean:** ${stats.mean}s`,
            `- **Std Dev:** ${stats.stddev}s`,
          ];
          return { content: lines.join("\n") };
        },
      });

      editor.add({
        name: "list_sessions",
        description:
          "List sessions created by this plugin, optionally scoped to the current parent.",
        input: z.object({
          all: z.boolean().optional().describe("List children of every parent, not just this session (default false)."),
          state: z.enum(["starting", "running", "idle", "error", "cancelled", "timeout"]).optional().describe("Filter by session state."),
          since: z.number().optional().describe("Only show sessions created after this Unix timestamp (seconds)."),
          search: z.string().optional().describe("Filter by title or tags (case-insensitive substring match)."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { all?: boolean; state?: SessionState; since?: number; search?: string };
          const rows: string[] = [];
          const searchLower = args.search?.toLowerCase();
          const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };
          const sorted = [...tracked.values()].sort((a, b) => {
            // E201: sort by priority first, then by creation time (newest first).
            const pa = PRIORITY_ORDER[a.priority ?? "normal"] ?? 1;
            const pb = PRIORITY_ORDER[b.priority ?? "normal"] ?? 1;
            if (pa !== pb) return pa - pb;
            return b.createdAt - a.createdAt;
          });
          for (const t of sorted) {
            // Entries with an unknown parent ("unknown" sentinel) are always
            // shown: they may belong to this session and must not be hidden.
            if (!args.all && t.parentSessionID !== toolCtx.sessionID && t.parentSessionID !== "unknown") continue;
            if (args.state && t.state !== args.state) continue;
            if (args.since && t.createdAt < args.since * 1000) continue;
            if (searchLower) {
              const titleMatch = t.title.toLowerCase().includes(searchLower);
              const tagMatch = t.tags?.some((tag) => tag.toLowerCase().includes(searchLower));
              if (!titleMatch && !tagMatch) continue;
            }
            rows.push(
              `- ${t.childID} [${t.state}] ${t.shortId} parent=${t.parentSessionID}${
                t.pendingPermissionId ? ` pending_permission=${t.pendingPermissionId}` : ""
              }${t.tags ? ` tags=${t.tags.join(",")}` : ""} — ${t.title}`,
            );
          }
          if (rows.length === 0) return { content: "No sessions created by this plugin." };
          return { content: `Sessions (${rows.length}):\n${rows.join("\n")}` };
        },
      });

      // ---- project presence tools -------------------------------------
      // These see sessions this plugin did not spawn, which is the whole point:
      // two independently opened sessions in one repo otherwise have no way to
      // know about each other.

      editor.add({
        name: "project_sessions",
        description:
          "List other sessions working in the same project directory, whether or not this plugin spawned them. Shows each peer's state, how long since it was last active, any task it declared via session_claim, and any files it is currently editing. Use this before editing, to find out whether a surprising diff is someone else's work. Pass forget to drop a session that has been closed or deleted.",
        input: z.object({
          task: z
            .string()
            .optional()
            .describe(
              "Declare what this session is working on, so peers can see it (persists across turns).",
            ),
          forget: z
            .string()
            .optional()
            .describe(
              "Remove these session ids from the presence list so they are neither shown nor messaged. Use it for a session you closed or deleted and that is still showing. Comma-separated; ids you do not recognise are ignored.",
            ),
          // OS-16: peers are only ever `running` or `idle` — the event pump only
          // ever writes those two — so the old six-value enum offered four filters
          // that could never match and silently returned "no other sessions".
          // Accepting any string here (rather than a zod enum) keeps the rejection
          // in our hands, where it can explain the mistake instead of throwing a
          // schema error at the caller.
          state: z
            .string()
            .optional()
            .describe(
              "Filter by peer state: 'running' or 'idle'. Peers are only ever these two; children in another state (starting, error, cancelled, timeout) are reported by list_sessions.",
            ),
          since: z.number().optional().describe("E271: only show sessions active after this Unix timestamp (seconds)."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { task?: string; forget?: string; state?: string; since?: number };
          // OS-16: a filter that can never match is worse than no filter — the
          // caller reads "No other sessions" as an empty project. Refuse it and
          // say what is available, before any side effect runs.
          const stateFilter = args.state?.trim().toLowerCase();
          if (stateFilter !== undefined && stateFilter !== "running" && stateFilter !== "idle") {
            return {
              content:
                `Unknown peer state "${args.state}". Peers in this project are only ever "running" or "idle"; ` +
                (stateFilter && ["starting", "error", "cancelled", "timeout"].includes(stateFilter)
                  ? `"${stateFilter}" is a state a *child* session you spawned can hold — see list_sessions for those. `
                  : "") +
                `Call project_sessions without state to see everyone.`,
            };
          }
          const self = peers.get(peerKey(toolCtx.sessionID));
          // Claiming is idempotent and cheap; do it on every call so a session
          // that only ever uses tools (never the context hook) is still visible.
          if (args.task !== undefined && args.task !== "") {
            selfSessionIDs.add(toolCtx.sessionID);
            recordPeer(toolCtx.sessionID, defaultDirectory, {
              state: "running",
              task: args.task,
              claimed: true,
              parentSessionID: tracked.get(toolCtx.sessionID)?.parentSessionID,
            });
            mirrorPeers();
          }

          // Let the list be corrected: a session deleted in the UI can still be
          // mirrored from another process, and a ghost entry would otherwise
          // keep being a broadcast target until the stale cutoff.
          const preamble: string[] = [];
          const forgotten: string[] = [];
          for (const raw of (args.forget ?? "").split(",")) {
            const id = raw.trim();
            if (!id) continue;
            // Same rule as session_send: accept the label that was shown.
            const resolved = resolveSessionRef(id);
            if (resolved && "ambiguous" in resolved) {
              preamble.push(`Not forgotten: ${resolved.ambiguous}`);
              continue;
            }
            const target = resolved ? resolved.id : id;
            if (forgetPeer(target)) forgotten.push(target);
            selfSessionIDs.delete(target);
          }
          if (forgotten.length > 0) {
            // Also clear any tracked child so session_result stops reporting a
            // session that no longer exists.
            for (const id of forgotten) {
              const dead = tracked.get(id);
              if (!dead) continue;
              if (!isTerminal(dead.state)) {
                dead.state = "cancelled";
                dead.errorText = "Session was forgotten (closed or deleted).";
                dead.idleAt = Date.now();
              }
              settleWaiters(dead);
              tracked.delete(id);
            }
          }

          const others = peersIn(defaultDirectory, toolCtx.sessionID);
          // Verify the quiet ones on demand: an explicit listing is exactly when
          // a round-trip is worth it, and it turns the list into ground truth
          // rather than a report of what was true a minute ago.
          const suspects = others.filter((p) => !isFreshPeer(p));
          const verdicts = await verifyAll(suspects);
          const confirmedGone = suspects
            .filter((p) => verdicts.get(p.sessionId) === "gone")
            .map((p) => displayId(p.sessionId, knownSessionIds()));
          let remaining = others.filter((p) => verdicts.get(p.sessionId) !== "gone");
          // E270/E271: apply state and since filters.
          if (stateFilter) {
            remaining = remaining.filter((p) => p.state === stateFilter);
          }
          if (args.since) {
            const cutoff = args.since * 1000;
            remaining = remaining.filter((p) => p.lastSeenAt >= cutoff);
          }

          if (forgotten.length > 0) {
            preamble.push(
              `Removed ${forgotten.length} session(s) from the presence list: ${forgotten.join(", ")}.`,
            );
          }
          if (confirmedGone.length > 0) {
            preamble.push(`Confirmed gone and dropped: ${confirmedGone.join(", ")}.`);
          }
          const lead = preamble.length > 0 ? `${preamble.join("\n")}\n` : "";
          if (remaining.length === 0) {
            return {
              content: `${lead}No other sessions in ${defaultDirectory}.${
                self ? `\n(this session: ${describePeer(self)})` : ""
              }`,
            };
          }
          const rows = remaining.map((p) =>
            // The server has now been asked, so "idle" can be stated as fact.
            verdicts.get(p.sessionId) === "busy"
              ? `${describePeer(p)} (alive, idle)`
              : describePeer(p),
          );
          const header = `${remaining.length} other session${remaining.length === 1 ? "" : "s"} in ${defaultDirectory}:`;
          const footer = [
            "Use session_send to message one, session_broadcast to warn all of them.",
            "An idle peer is verified to still exist, so messaging it is safe; forget:\"<id>\" drops one you closed yourself.",
          ].join(" ");
          return {
            content: `${lead}${header}\n${rows.join("\n")}\n${footer}`,
          };
        },
      });

      editor.add({
        name: "session_broadcast",
        description:
          "Send one message to every other session working in this project. Use before a wide-reaching change so peers do not duplicate or fight the work. Prefer session_send when you mean one specific session.",
        input: z.object({
          text: z.string().describe("The message to deliver to every peer."),
          noReply: z
            .boolean()
            .optional()
            .describe("Inject without asking peers to respond (default false)."),
          exclude: z.array(z.string()).optional().describe("E272: session ids to exclude from the broadcast."),
          requireAck: z.boolean().optional().describe("E273: wait for acknowledgment from each peer (default false)."),
        }),
        execute: async (input, toolCtx) => {
          const args = input as { text: string; noReply?: boolean; exclude?: string[]; requireAck?: boolean };
          const excludeSet = new Set(args.exclude ?? []);
          const all = peersIn(defaultDirectory, toolCtx.sessionID).filter((p) => !excludeSet.has(p.sessionId));
          if (all.length === 0) {
            return { content: "No other sessions in this project; nothing sent." };
          }
          // Confirm each suspect rather than reviving it on a hunch. Verified
          // ghosts are forgotten here, so the list heals as a side effect of
          // asking a question about it.
          const verdicts = await verifyAll(all);
          const reachable: Peer[] = [];
          const vanished: string[] = [];
          const quiet: string[] = [];
          for (const p of all) {
            const v = verdicts.get(p.sessionId);
            if (v === "gone") vanished.push(displayId(p.sessionId, knownSessionIds()));
            else {
              reachable.push(p);
              if (v === "busy") quiet.push(displayId(p.sessionId, knownSessionIds()));
            }
          }
          if (reachable.length === 0) {
            return {
              content:
                `No reachable sessions in this project; nothing sent. ` +
                (vanished.length > 0
                  ? `Confirmed gone and dropped from the list: ${vanished.join(", ")}.`
                  : ""),
            };
          }
          let delivered = 0;
          const failed: string[] = [];
          // OS-8: a rate-limited peer used to be counted as reached — the call
          // returns a human string either way, so "Broadcast to 3/3" could mean
          // one message went out and two were suppressed. Suppressions are
          // reported separately now.
          const skipped: string[] = [];
          metrics.broadcastsSent++;
          for (const p of reachable) {
            try {
              const sent = await deliverToSession(p.sessionId, args.text, args.noReply === true);
              if (!sent.delivered) {
                skipped.push(displayId(p.sessionId, knownSessionIds()));
                continue;
              }
              // Keep the peer's state honest: a prompt put it to work.
              recordPeer(p.sessionId, p.directory, { state: "running" });
              delivered += 1;
            } catch (err) {
              failed.push(`${displayId(p.sessionId, knownSessionIds())} (${describeError(err)})`);
            }
          }
          mirrorPeers();
          const parts = [`Broadcast to ${delivered}/${reachable.length} reachable session(s).`];
          if (failed.length > 0) parts.push(`Failed: ${failed.join(", ")}`);
          if (skipped.length > 0) {
            parts.push(
              `Not sent to ${skipped.join(", ")} — a message went there moments ago; retry shortly if it matters.`,
            );
          }
          if (vanished.length > 0) {
            parts.push(`Confirmed gone and dropped: ${vanished.join(", ")}.`);
          }
          if (quiet.length > 0) {
            parts.push(`Woke ${quiet.length} idle session(s): ${quiet.join(", ")}.`);
          }
          if (args.requireAck) {
            parts.push("Acknowledgment required: peers will confirm receipt on next interaction.");
          }
          return { content: parts.join("\n") };
        },
      });

      // --- E207: session_fork ---
      editor.add({
        name: "session_fork",
        description: "Fork an existing session by reading its transcript and spawning a new session with it as context.",
        input: z.object({
          sessionId: z.string().describe("Source session id to fork."),
          prompt: z.string().optional().describe("Additional prompt to prepend to the forked context."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; prompt?: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const transcript = await buildTranscript(t.childID, 100);
          const forkPrompt = args.prompt
            ? `${args.prompt}\n\n--- Forked from session ${t.childID} ---\n${transcript}`
            : `--- Forked from session ${t.childID} ---\n${transcript}`;
          const childID = await launch({
            parentID: t.parentSessionID,
            promptText: forkPrompt,
            titleText: `fork:${t.shortId}`,
            label: "fork",
          });
          return { content: `Forked session ${t.childID} -> ${childID}` };
        },
      });

      // --- E208: session_diff ---
      editor.add({
        name: "session_diff",
        description: "Compare two sessions' transcripts and produce a unified diff.",
        input: z.object({
          sessionIdA: z.string().describe("First session id."),
          sessionIdB: z.string().describe("Second session id."),
        }),
        execute: async (input) => {
          const args = input as { sessionIdA: string; sessionIdB: string };
          const foundA = await requireTracked(args.sessionIdA);
          if ("message" in foundA) return { content: foundA.message };
          const foundB = await requireTracked(args.sessionIdB);
          if ("message" in foundB) return { content: foundB.message };
          const transcriptA = await buildTranscript(foundA.t.childID, 100);
          const transcriptB = await buildTranscript(foundB.t.childID, 100);
          const linesA = transcriptA.split("\n");
          const linesB = transcriptB.split("\n");
          const diff: string[] = [];
          const maxLen = Math.max(linesA.length, linesB.length);
          for (let i = 0; i < maxLen; i++) {
            const a = linesA[i];
            const b = linesB[i];
            if (a === b) {
              diff.push(`  ${a ?? ""}`);
            } else {
              if (a !== undefined) diff.push(`- ${a}`);
              if (b !== undefined) diff.push(`+ ${b}`);
            }
          }
          return { content: `Diff between ${args.sessionIdA} and ${args.sessionIdB}:\n${diff.join("\n")}` };
        },
      });

      // --- E209/E276: session_archive ---
      editor.add({
        name: "session_archive",
        description: "Archive a completed session by marking it as archived and removing it from the active list.",
        input: z.object({
          sessionId: z.string().describe("Session id to archive."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          if (!isTerminal(t.state)) {
            return { content: `Cannot archive session ${t.childID}: still ${t.state}. Only completed sessions can be archived.` };
          }
          t.state = "idle";
          t.tags = [...(t.tags ?? []), "archived"];
          tracked.delete(t.childID);
          return { content: `Archived session ${t.childID}.` };
        },
      });

      // --- E210: session_filter ---
      editor.add({
        name: "session_filter",
        description: "Filter sessions by state, tags, date, or search term.",
        input: z.object({
          state: z.enum(["starting", "running", "idle", "error", "cancelled", "timeout"]).optional().describe("Filter by state."),
          tags: z.array(z.string()).optional().describe("Filter by tags."),
          since: z.number().optional().describe("Only show sessions created after this Unix timestamp (seconds)."),
          search: z.string().optional().describe("Search in title or tags."),
        }),
        execute: async (input) => {
          const args = input as { state?: SessionState; tags?: string[]; since?: number; search?: string };
          const searchLower = args.search?.toLowerCase();
          const rows: string[] = [];
          for (const t of tracked.values()) {
            if (args.state && t.state !== args.state) continue;
            if (args.tags && !args.tags.every((tag) => t.tags?.includes(tag))) continue;
            if (args.since && t.createdAt < args.since * 1000) continue;
            if (searchLower) {
              const titleMatch = t.title.toLowerCase().includes(searchLower);
              const tagMatch = t.tags?.some((tag) => tag.toLowerCase().includes(searchLower));
              if (!titleMatch && !tagMatch) continue;
            }
            rows.push(`- ${t.childID} [${t.state}] ${t.shortId} — ${t.title}`);
          }
          if (rows.length === 0) return { content: "No sessions match the filter." };
          return { content: `Filtered sessions (${rows.length}):\n${rows.join("\n")}` };
        },
      });

      // --- E211: session_sort ---
      editor.add({
        name: "session_sort",
        description: "Sort sessions by creation time, duration, priority, or title.",
        input: z.object({
          by: z.enum(["createdAt", "duration", "priority", "title"]).describe("Sort field."),
          order: z.enum(["asc", "desc"]).optional().describe("Sort order (default desc)."),
        }),
        execute: async (input) => {
          const args = input as { by: "createdAt" | "duration" | "priority" | "title"; order?: "asc" | "desc" };
          const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };
          const sorted = [...tracked.values()].sort((a, b) => {
            let cmp = 0;
            switch (args.by) {
              case "createdAt":
                cmp = a.createdAt - b.createdAt;
                break;
              case "duration": {
                const da = a.idleAt ? a.idleAt - a.startedAt : 0;
                const db = b.idleAt ? b.idleAt - b.startedAt : 0;
                cmp = da - db;
                break;
              }
              case "priority":
                cmp = (PRIORITY_ORDER[a.priority ?? "normal"] ?? 1) - (PRIORITY_ORDER[b.priority ?? "normal"] ?? 1);
                break;
              case "title":
                cmp = a.title.localeCompare(b.title);
                break;
            }
            return args.order === "asc" ? cmp : -cmp;
          });
          const rows = sorted.map((t) => `- ${t.childID} [${t.state}] ${t.shortId} — ${t.title}`);
          return { content: `Sorted sessions (${rows.length}):\n${rows.join("\n")}` };
        },
      });

      // --- E212: session_group ---
      editor.add({
        name: "session_group",
        description: "Group sessions by parent, state, tags, or priority.",
        input: z.object({
          by: z.enum(["parent", "state", "tags", "priority"]).describe("Group by field."),
        }),
        execute: async (input) => {
          const args = input as { by: "parent" | "state" | "tags" | "priority" };
          const groups = new Map<string, Tracked[]>();
          for (const t of tracked.values()) {
            let key: string;
            switch (args.by) {
              case "parent":
                key = t.parentSessionID;
                break;
              case "state":
                key = t.state;
                break;
              case "tags":
                key = t.tags?.join(",") ?? "(no tags)";
                break;
              case "priority":
                key = t.priority ?? "normal";
                break;
            }
            const arr = groups.get(key) ?? [];
            arr.push(t);
            groups.set(key, arr);
          }
          const lines: string[] = [];
          for (const [key, sessions] of groups) {
            lines.push(`${key} (${sessions.length}):`);
            for (const t of sessions) {
              lines.push(`  - ${t.childID} [${t.state}] ${t.shortId} — ${t.title}`);
            }
          }
          return { content: `Grouped sessions:\n${lines.join("\n")}` };
        },
      });

      // --- E213: session_aggregate ---
      editor.add({
        name: "session_aggregate",
        description: "Report aggregate statistics across all tracked sessions.",
        input: z.object({}),
        execute: async () => {
          const total = tracked.size;
          const byState: Record<string, number> = {};
          const byPriority: Record<string, number> = {};
          let totalTokens = 0;
          let totalCost = 0;
          let totalDuration = 0;
          let completedCount = 0;
          for (const t of tracked.values()) {
            byState[t.state] = (byState[t.state] ?? 0) + 1;
            const p = t.priority ?? "normal";
            byPriority[p] = (byPriority[p] ?? 0) + 1;
            if (t.tokensUsed) totalTokens += t.tokensUsed;
            if (t.costUsd) totalCost += t.costUsd;
            if (t.idleAt) {
              totalDuration += t.idleAt - t.startedAt;
              completedCount += 1;
            }
          }
          const avgDuration = completedCount > 0 ? Math.round(totalDuration / completedCount / 1000) : 0;
          const lines = [
            "## Aggregate Session Statistics",
            "",
            `- **Total Sessions:** ${total}`,
            `- **By State:** ${Object.entries(byState).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
            `- **By Priority:** ${Object.entries(byPriority).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
            `- **Total Tokens:** ${totalTokens}`,
            `- **Total Cost:** $${totalCost.toFixed(4)}`,
            `- **Avg Duration:** ${avgDuration}s`,
          ];
          return { content: lines.join("\n") };
        },
      });

      // --- E214: session_merge ---
      editor.add({
        name: "session_merge",
        description: "Merge two sessions' contexts into a new session.",
        input: z.object({
          sessionIdA: z.string().describe("First session id."),
          sessionIdB: z.string().describe("Second session id."),
          prompt: z.string().optional().describe("Prompt for the merged session."),
        }),
        execute: async (input) => {
          const args = input as { sessionIdA: string; sessionIdB: string; prompt?: string };
          const foundA = await requireTracked(args.sessionIdA);
          if ("message" in foundA) return { content: foundA.message };
          const foundB = await requireTracked(args.sessionIdB);
          if ("message" in foundB) return { content: foundB.message };
          const transcriptA = await buildTranscript(foundA.t.childID, 100);
          const transcriptB = await buildTranscript(foundB.t.childID, 100);
          const mergedPrompt = args.prompt
            ? `${args.prompt}\n\n--- Session A (${args.sessionIdA}) ---\n${transcriptA}\n\n--- Session B (${args.sessionIdB}) ---\n${transcriptB}`
            : `--- Session A (${args.sessionIdA}) ---\n${transcriptA}\n\n--- Session B (${args.sessionIdB}) ---\n${transcriptB}`;
          const childID = await launch({
            parentID: foundA.t.parentSessionID,
            promptText: mergedPrompt,
            titleText: `merge:${foundA.t.shortId}+${foundB.t.shortId}`,
            label: "merge",
          });
          return { content: `Merged sessions ${args.sessionIdA} and ${args.sessionIdB} -> ${childID}` };
        },
      });

      // --- E215: session_split ---
      editor.add({
        name: "session_split",
        description: "Split a session's context into two new sessions.",
        input: z.object({
          sessionId: z.string().describe("Session id to split."),
          promptA: z.string().optional().describe("Prompt for the first split session."),
          promptB: z.string().optional().describe("Prompt for the second split session."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; promptA?: string; promptB?: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const transcript = await buildTranscript(t.childID, 100);
          const half = Math.ceil(transcript.split("\n").length / 2);
          const lines = transcript.split("\n");
          const partA = lines.slice(0, half).join("\n");
          const partB = lines.slice(half).join("\n");
          const childA = await launch({
            parentID: t.parentSessionID,
            promptText: args.promptA ? `${args.promptA}\n\n${partA}` : partA,
            titleText: `split:${t.shortId}:a`,
            label: "split",
          });
          const childB = await launch({
            parentID: t.parentSessionID,
            promptText: args.promptB ? `${args.promptB}\n\n${partB}` : partB,
            titleText: `split:${t.shortId}:b`,
            label: "split",
          });
          return { content: `Split session ${t.childID} into ${childA} and ${childB}` };
        },
      });

      // --- E216: session_clone ---
      editor.add({
        name: "session_clone",
        description: "Create a copy of a session with the same initial prompt.",
        input: z.object({
          sessionId: z.string().describe("Session id to clone."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const childID = await launch({
            parentID: t.parentSessionID,
            promptText: `Cloned from ${t.childID}`,
            titleText: `clone:${t.shortId}`,
            label: "clone",
          });
          return { content: `Cloned session ${t.childID} -> ${childID}` };
        },
      });

      // --- E217: session_snapshot ---
      editor.add({
        name: "session_snapshot",
        description: "Save a snapshot of a session's current state.",
        input: z.object({
          sessionId: z.string().describe("Session id to snapshot."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const snapshot = {
            sessionId: t.childID,
            title: t.title,
            state: t.state,
            createdAt: t.createdAt,
            startedAt: t.startedAt,
            idleAt: t.idleAt,
            resultText: t.resultText,
            structured: t.structured,
            errorText: t.errorText,
            tags: t.tags,
            priority: t.priority,
            tokensUsed: t.tokensUsed,
            costUsd: t.costUsd,
            snapshotAt: Date.now(),
          };
          // OS-6: kept in the snapshot store, not in `tracked`, so the id never
          // looks like a session to the code that resolves session references.
          const snapshotId = `snapshot:${t.childID}:${Date.now()}`;
          snapshots.set(snapshotId, {
            id: snapshotId,
            sourceID: t.childID,
            parentSessionID: t.parentSessionID,
            shortId: t.shortId,
            title: t.title,
            at: Date.now(),
            data: snapshot,
          });
          while (snapshots.size > MAX_SNAPSHOTS) {
            const oldest = snapshots.keys().next();
            if (oldest.done) break;
            snapshots.delete(oldest.value);
          }
          return { content: `Snapshot saved: ${snapshotId}\n${JSON.stringify(snapshot, null, 2)}` };
        },
      });

      // --- E218: session_restore ---
      editor.add({
        name: "session_restore",
        description: "Restore a session from a snapshot.",
        input: z.object({
          snapshotId: z.string().describe("Snapshot id to restore from."),
        }),
        execute: async (input) => {
          const args = input as { snapshotId: string };
          const snapshot = snapshots.get(args.snapshotId);
          if (!snapshot) {
            const known = [...snapshots.keys()].slice(-5);
            return {
              content:
                `Snapshot not found: ${args.snapshotId}. Snapshots live in this server's memory ` +
                `(the newest ${MAX_SNAPSHOTS} are kept; a restart drops them).` +
                (known.length > 0 ? ` Currently available: ${known.join(", ")}.` : " None are currently stored."),
            };
          }
          const restored = await launch({
            parentID: snapshot.parentSessionID,
            promptText: `Restored from snapshot ${args.snapshotId}`,
            titleText: `restore:${snapshot.shortId}`,
            label: "restore",
          });
          return { content: `Restored from snapshot ${args.snapshotId} -> ${restored}` };
        },
      });

      // --- E219: session_backup ---
      editor.add({
        name: "session_backup",
        description: "Back up a session's data to a JSON string.",
        input: z.object({
          sessionId: z.string().describe("Session id to back up."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const backup = {
            sessionId: t.childID,
            title: t.title,
            state: t.state,
            createdAt: t.createdAt,
            startedAt: t.startedAt,
            idleAt: t.idleAt,
            resultText: t.resultText,
            structured: t.structured,
            errorText: t.errorText,
            tags: t.tags,
            priority: t.priority,
            tokensUsed: t.tokensUsed,
            costUsd: t.costUsd,
            transcript: await buildTranscript(t.childID, 100),
            backedUpAt: Date.now(),
          };
          return { content: `Backup of ${t.childID}:\n\`\`\`json\n${JSON.stringify(backup, null, 2)}\n\`\`\`` };
        },
      });

      // --- E220: session_recover ---
      editor.add({
        name: "session_recover",
        description: "Recover a session from a backup JSON string.",
        input: z.object({
          backup: z.string().describe("Backup JSON string from session_backup."),
        }),
        execute: async (input) => {
          const args = input as { backup: string };
          try {
            const data = JSON.parse(args.backup) as {
              sessionId: string;
              title: string;
              transcript?: string;
            };
            const childID = await launch({
              parentID: "unknown",
              promptText: data.transcript ? `Recovered from backup:\n${data.transcript}` : `Recovered from backup of ${data.sessionId}`,
              titleText: `recover:${data.sessionId.slice(0, 8)}`,
              label: "recover",
            });
            return { content: `Recovered from backup -> ${childID}` };
          } catch (err) {
            return { content: `Failed to recover from backup: ${describeError(err)}` };
          }
        },
      });

      // --- E221: session_migrate ---
      editor.add({
        name: "session_migrate",
        description: "Migrate a session to a different project directory.",
        input: z.object({
          sessionId: z.string().describe("Session id to migrate."),
          targetDirectory: z.string().describe("Target project directory."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; targetDirectory: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const transcript = await buildTranscript(t.childID, 100);
          const childID = await launch({
            parentID: t.parentSessionID,
            promptText: `Migrated from ${t.childID}:\n${transcript}`,
            titleText: `migrate:${t.shortId}`,
            directory: args.targetDirectory,
            label: "migrate",
          });
          return { content: `Migrated session ${t.childID} to ${args.targetDirectory} -> ${childID}` };
        },
      });

      // --- E222: session_transfer ---
      editor.add({
        name: "session_transfer",
        description: "Transfer a session to a different parent.",
        input: z.object({
          sessionId: z.string().describe("Session id to transfer."),
          targetParentId: z.string().describe("Target parent session id."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; targetParentId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          t.parentSessionID = args.targetParentId;
          return { content: `Transferred session ${t.childID} to parent ${args.targetParentId}.` };
        },
      });

      // --- E223: session_share ---
      editor.add({
        name: "session_share",
        description: "Share a session with another user by generating a shareable summary.",
        input: z.object({
          sessionId: z.string().describe("Session id to share."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          // OS-5: `a?.slice(0, 500) ?? b ? JSON.stringify(b) : ""` parsed as
          // `(a?.slice(0,500) ?? b) ? JSON.stringify(b) : ""`, so a child that has
          // *any* result text had its `resultText` thrown away and was summarised
          // as `""` — or, if it also had structured output, as a second copy of
          // that instead of the text. Written as an explicit chain of preference.
          const summary = t.resultText
            ? t.resultText.slice(0, 500)
            : t.structured
              ? JSON.stringify(t.structured).slice(0, 500)
              : "";
          const share = {
            sessionId: t.childID,
            title: t.title,
            state: t.state,
            summary,
            sharedAt: Date.now(),
          };
          return { content: `Share ${t.childID}:\n\`\`\`json\n${JSON.stringify(share, null, 2)}\n\`\`\`` };
        },
      });

      // --- E224: session_publish ---
      editor.add({
        name: "session_publish",
        description: "Publish a session to a shared location (returns a publishable reference).",
        input: z.object({
          sessionId: z.string().describe("Session id to publish."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const ref = `published:${t.childID}:${Date.now()}`;
          return { content: `Published ${t.childID} as ${ref}\nTitle: ${t.title}\nState: ${t.state}` };
        },
      });

      // --- E225: session_subscribe ---
      editor.add({
        name: "session_subscribe",
        description: "Subscribe to a session's events.",
        input: z.object({
          sessionId: z.string().describe("Session id to subscribe to."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          return { content: `Subscribed to session ${t.childID}. Events will be logged.` };
        },
      });

      // --- E226: session_unsubscribe ---
      editor.add({
        name: "session_unsubscribe",
        description: "Unsubscribe from a session's events.",
        input: z.object({
          sessionId: z.string().describe("Session id to unsubscribe from."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          return { content: `Unsubscribed from session ${t.childID}.` };
        },
      });

      // --- E228: session_rename ---
      editor.add({
        name: "session_rename",
        description: "Rename a session's title.",
        input: z.object({
          sessionId: z.string().describe("Session id to rename."),
          title: z.string().describe("New title."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; title: string };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const oldTitle = t.title;
          t.title = args.title;
          return { content: `Renamed session ${t.childID} from "${oldTitle}" to "${args.title}".` };
        },
      });

      // --- E229: session_tag ---
      editor.add({
        name: "session_tag",
        description: "Add tags to a session.",
        input: z.object({
          sessionId: z.string().describe("Session id to tag."),
          tags: z.array(z.string()).describe("Tags to add."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; tags: string[] };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          t.tags = [...new Set([...(t.tags ?? []), ...args.tags])];
          return { content: `Tagged session ${t.childID} with: ${args.tags.join(", ")}` };
        },
      });

      // --- E229: session_untag ---
      editor.add({
        name: "session_untag",
        description: "Remove tags from a session.",
        input: z.object({
          sessionId: z.string().describe("Session id to untag."),
          tags: z.array(z.string()).describe("Tags to remove."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; tags: string[] };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          t.tags = (t.tags ?? []).filter((tag) => !args.tags.includes(tag));
          return { content: `Untagged session ${t.childID}: removed ${args.tags.join(", ")}` };
        },
      });

      // --- E232: session_events ---
      editor.add({
        name: "session_events",
        description: "Show recent events for a session.",
        input: z.object({
          sessionId: z.string().describe("Session id to get events for."),
          limit: z.number().optional().describe("Maximum number of events to show (default 20)."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; limit?: number };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          const events = [
            { type: "created", at: t.createdAt },
            { type: "started", at: t.startedAt },
            ...(t.idleAt ? [{ type: "idle", at: t.idleAt }] : []),
            ...(t.errorText ? [{ type: "error", at: t.idleAt ?? t.lastActivityAt }] : []),
          ].slice(0, args.limit ?? 20);
          const lines = events.map((e) => `- ${e.type} at ${new Date(e.at).toISOString()}`);
          return { content: `Events for ${t.childID}:\n${lines.join("\n")}` };
        },
      });

      // --- E233: session_stream ---
      editor.add({
        name: "session_stream",
        description: "Stream partial results from a running session.",
        input: z.object({
          sessionId: z.string().describe("Session id to stream."),
          maxChars: z.number().optional().describe("Maximum characters to include."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; maxChars?: number };
          const found = await requireTracked(args.sessionId);
          if ("message" in found) return { content: found.message };
          const t = found.t;
          if (isTerminal(t.state)) {
            return { content: formatOutcome(outcomeOf(t), t, args.maxChars) };
          }
          const o = await fetchOutcome(t.childID);
          const partial = o.text || "(no output yet)";
          return {
            content: `Partial output from ${t.childID} [${t.state}]:\n${truncate(partial, args.maxChars ?? 2000)}`,
          };
        },
      });

      // --- E275: session_import ---
      editor.add({
        name: "session_import",
        description: "Import session data from a JSON string (e.g., from session_export).",
        input: z.object({
          data: z.string().describe("JSON string from session_export."),
        }),
        execute: async (input) => {
          const args = input as { data: string };
          try {
            const parsed = JSON.parse(args.data) as {
              sessionId: string;
              title: string;
              transcript?: string;
              resultText?: string;
            };
            const childID = await launch({
              parentID: "unknown",
              promptText: parsed.transcript || parsed.resultText || `Imported from ${parsed.sessionId}`,
              titleText: `import:${parsed.sessionId.slice(0, 8)}`,
              label: "import",
            });
            return { content: `Imported session data -> ${childID}` };
          } catch (err) {
            return { content: `Failed to import session data: ${describeError(err)}` };
          }
        },
      });

    });

    return () => {
      abort.abort();
      clearInterval(stuckSessionTimer);
      clearInterval(eventPumpWatchdog);
      for (const reg of registrations) {
        // L69: log dispose errors for debugging instead of silently swallowing.
        void reg.dispose().catch((err: unknown) => {
          log("debug", `registration dispose failed: ${describeError(err)}`);
        });
      }
      for (const t of tracked.values()) {
        settleWaiters(t);
      }
      // OS-3: notes still waiting on the injection throttle die with the
      // instance; the timer must not fire into a torn-down server.
      if (parentFlushTimer !== undefined) {
        clearTimeout(parentFlushTimer);
        parentFlushTimer = undefined;
      }
      pendingParentNotes.clear();
      tracked.clear();
      parentDefaults.clear();
      outcomeCache.clear();
      parentInjectTimes.clear();
      eventCounts.clear();
      deliverTimes.clear();
      reservedSlots.clear();
      snapshots.clear();
      // OS-10: every other derived cache, so a reload starts from nothing.
      peerNoticeCache.clear();
      scorePeersCache.clear();
      remoteScanCache.clear();
      writersOfCache.clear();
      transcriptCache.clear();
      hydrateCache.clear();
      displayIdCache.clear();
      knownSessionIdsCache.at = 0;
      peersInCache.at = 0;
      // Drop presence entries this instance claimed, so a closed session stops
      // being advertised as a peer immediately rather than at the stale cutoff.
      // ctx exposes no self id, so the ids we claimed are tracked as we go.
      // Removal must hit shared storage too: mirrorPeers only writes, so
      // deleting from the local map alone would leave the published record
      // visible to other processes until peerStaleSec elapses.
      // OS-13: L65's "flush before clearing" intent is kept, but the flush must
      // not re-arm the debounce — the old code cleared the timer and then called
      // mirrorPeers(), which set a fresh one whose write landed *after* the
      // deletes below, republishing presence this shutdown had just removed.
      flushPeerMirror();
      for (const id of selfSessionIDs) {
        peers.delete(peerKey(id));
        const key = peerStorageKey(id);
        publishedPeers.delete(key);
        void withTimeout(
          peerStore?.remove?.(key) ?? Promise.resolve(),
          SERVER_TIMEOUT_MS,
          "storage.remove",
        ).catch(() => undefined);
      }
      selfSessionIDs.clear();
      // Drop this instance's in-flight markers, so a reloaded plugin does not
      // leave a file looking like it is mid-write.
      releaseOwnInFlight();
      clearOwnWaitIntents();
      if (remotePeerTimer !== undefined) clearInterval(remotePeerTimer);
      // OS-13: peerMirrorTimer is cleared by flushPeerMirror() above, and nothing
      // re-arms it after that point.
      peers.clear();
    };
  },
});
