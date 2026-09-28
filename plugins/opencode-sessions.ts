import { Plugin } from "@opencode/plugin";
import fs from "node:fs";
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
  shortId,
  taskTokens,
  tasksOverlap,
  truncate,
} from "../opencode-sessions/helpers.ts";

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
    const MAX_PARENT_DEFAULTS = 500;

    // Race a server call against a timeout so a hung opencode API can't stall
    // orchestration forever. (The ctx.* helpers don't accept AbortSignal, so a
    // Promise.race timeout is used instead of AbortSignal.timeout().)
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

    // Short-lived cache for child session.context reads so that polling
    // session_result (and timeout/interrupt best-effort refreshes) doesn't
    // hammer the server with a context read on every call.
    const OUTCOME_CACHE_TTL_MS = 3000;
    const outcomeCache = new Map<string, { at: number; text: string; error?: string }>();

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
    const deliverToSession = async (
      sessionId: string,
      text: string,
      noReply: boolean,
    ): Promise<string> => {
      const known = tracked.get(sessionId);
      const target = known?.childID ?? sessionId;
      if (noReply) {
        await ctx.session.synthetic({ sessionID: target, text });
        return `Injected context into ${target} (no reply requested).`;
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
        return `Sent follow-up to ${target}; it is running again.`;
      }
      await ctx.session.prompt({ sessionID: target, text });
      return `Sent to ${target}.`;
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
      // Drop the shared record too, so other processes stop advertising this
      // session at once instead of waiting for it to age out on their side.
      const key = peerStorageKey(sessionId);
      publishedPeers.delete(key);
      void Promise.resolve(peerStore?.remove?.(key)).catch((err: unknown) =>
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
      await Promise.all(
        list.map(async (p) => {
          out.set(p.sessionId, await verifyPeer(p));
        }),
      );
      return out;
    };

    /** Bounded, cancellable sleep used while a write waits for a release. */
    const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (signal?.aborted || ms <= 0) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
      });

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
        await sleepFor(Math.min(LOCK_POLL_MS, deadline - Date.now()), signal);
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
      void Promise.resolve(
        peerStore.set(waitKey(sessionId), { sessionId, keys, at: Date.now() }),
      ).catch((err: unknown) => log("debug", `wait intent publish failed: ${describeError(err)}`));
    };

    const clearWaitIntent = (sessionId: string): void => {
      if (!peerStore?.remove || !sessionId) return;
      void Promise.resolve(peerStore.remove(waitKey(sessionId))).catch(() => undefined);
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
            if (typeof v?.sessionId === "string") await peerStore.remove?.(waitKey(v.sessionId));
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
          editor.update(id as never, ((info: {
            execute: (input: unknown, toolCtx: { sessionID?: string; signal?: AbortSignal }) => Promise<unknown>;
          }) => {
            const inner = info.execute;
            if (typeof inner !== "function") return;
            info.execute = async (input, toolCtx) => {
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
      void Promise.resolve(
        peerStore?.set?.(inflightKey(sessionId), {
          sessionId,
          directory,
          paths: [...held],
          at: Date.now(),
        }),
      ).catch((err: unknown) =>
        log("debug", `in-flight publish failed: ${describeError(err)}`),
      );
    };

    const clearInFlight = (sessionId: string): void => {
      if (!inFlight.delete(sessionId)) return;
      void Promise.resolve(peerStore?.remove?.(inflightKey(sessionId))).catch(
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
        void Promise.resolve(peerStore?.remove?.(inflightKey(sessionId))).catch(() => undefined);
        return;
      }
      const directory = peers.get(peerKey(sessionId))?.directory ?? defaultDirectory;
      void Promise.resolve(
        peerStore?.set?.(inflightKey(sessionId), {
          sessionId,
          directory,
          paths: [...held],
          at: Date.now(),
        }),
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
          return { ...outcome, waited: outcome.waited || waited };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) {
          return { cleared: false, holders: await writersOf(directory, selfId, keys), waited: true };
        }
        const outcome = await waitForRelease(selfId, directory, keys, remaining, signal);
        waited = true;
        if (!outcome.cleared) return outcome;
      }
    };

    /** Drop any in-flight keys this process published, so cleanup is not abrupt. */
    const releaseOwnInFlight = (): void => {
      for (const id of inFlight.keys()) {
        void Promise.resolve(peerStore?.remove?.(inflightKey(id))).catch(() => undefined);
      }
      inFlight.clear();
    };

    type RemoteWriter = { sessionId: string; directory: string; paths: string[] };

    /** In-progress writes other opencode processes are publishing right now. */
    const remoteWriters = async (
      directory: string,
      selfId: string,
      keys: string[],
    ): Promise<RemoteWriter[]> => {
      if (!peerStore?.scan || keys.length === 0) return [];
      const want = new Set(keys);
      const cutoff = Date.now() - cfg.inflightTtlSec * 1000;
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
      const out: RemoteWriter[] = [];
      for (const entry of entries ?? []) {
        const v = entry?.value as Partial<RemoteWriter> & { at?: number } | undefined;
        if (!v || typeof v.sessionId !== "string") continue;
        if (v.sessionId === selfId) continue;
        if (typeof v.at !== "number" || v.at < cutoff) continue;
        if (v.directory !== directory) continue;
        if (!Array.isArray(v.paths)) continue;
        const paths = v.paths.filter((p): p is string => typeof p === "string" && want.has(p));
        if (paths.length === 0) continue;
        out.push({ sessionId: v.sessionId, directory: v.directory, paths });
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
      prunePeers();
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
      return out;
    };

    const recordPeer = (
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
      // `lastSeenAt` is a caller-supplied fact, not something this function may
      // invent. A local event proves the session is alive *now*, so the event
      // path passes nothing and gets `now`; a cross-process import only proves
      // it was alive when the *other* process wrote the record, so that path
      // passes the remote timestamp. Overwriting it here refreshed every peer on
      // every rescan, so nothing ever aged out: deleted sessions were never
      // detected, the staleness cutoffs never fired, and dead sessions kept
      // reporting whatever state they had when last mirrored.
      const next: Peer = { ...base, ...patch, lastSeenAt: patch.lastSeenAt ?? now, sessionId };
      if (next.task !== undefined) next.task = truncate(next.task, cfg.peerTaskChars);
      peers.set(peerKey(sessionId), next);
      // Bound growth: a long-lived server sees many session ids.
      if (peers.size > cfg.maxClaimedPeers) {
        const oldest = [...peers.entries()].sort(
          (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
        )[0];
        if (oldest) peers.delete(oldest[0]);
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
    const mirrorPeers = (): void => {
      if (!peerStore?.set) return;
      if (peerMirrorTimer !== undefined) return;
      peerMirrorTimer = setTimeout(() => {
        peerMirrorTimer = undefined;
        prunePeers();
        for (const [id, p] of peers) {
          const key = peerStorageKey(id);
          const payload = peerPayload(p);
          let encoded: string;
          try {
            encoded = JSON.stringify(payload);
          } catch {
            continue;
          }
          if (publishedPeers.get(key) === encoded) continue;
          publishedPeers.set(key, encoded);
          void Promise.resolve(peerStore.set?.(key, payload)).catch(
            (err: unknown) => log("debug", `peer mirror write failed: ${describeError(err)}`),
          );
        }
      }, 2000);
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

    /** Peers in `directory`, newest first, stale entries already pruned. */
    const peersIn = (directory: string, excludeSelf?: string): Peer[] => {
      prunePeers();
      return [...peers.values()]
        .filter((p) => p.directory === directory && p.sessionId !== excludeSelf)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    };

    const agoText = (ms: number): string => {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m}m ago`;
      return `${Math.round(m / 60)}h ago`;
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
      const MIN = 8;
      if (sessionId.length <= MIN) return sessionId;
      const rivals: string[] = [];
      for (const id of known) if (id !== sessionId) rivals.push(id);
      if (rivals.length === 0) return sessionId.slice(0, MIN);
      for (let n = MIN + 1; n < sessionId.length; n++) {
        const prefix = sessionId.slice(0, n);
        if (!rivals.some((id) => id.startsWith(prefix))) return prefix;
      }
      return sessionId;
    };

    /** Ids the agent could be shown, so labels can be made unique against them. */
    const knownSessionIds = (): string[] => [
      ...peers.keys(),
      ...[...tracked.values()].map((t) => t.childID),
    ];

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
      return scored.sort(
        (a, b) =>
          RELEVANCE_ORDER[a.rank] - RELEVANCE_ORDER[b.rank] ||
          b.p.lastSeenAt - a.p.lastSeenAt,
      );
    };

    /**
     * The awareness injection. Kept deliberately terse: it fires on every
     * request, so it has to pay for itself in a couple of lines — and it
     * returns nothing at all when no peer bears on this session, which is the
     * common case in a busy project.
     */
    const buildPeerNotice = (directory: string, selfId: string): string | undefined => {
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
      const lines = [
        `[${count} in this project${tally.length > 0 ? `; ${tally.join(", ")}` : ""}]`,
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
      return lines.join("\n");
    };

    /** Unique sentinel so the awareness line can be re-stripped, never doubled. */
    const PEER_SENTINEL = "[opencode-sessions:peers]";

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
        outcomeCache.set(childID, { at: Date.now(), text: "" });
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
      // Terminal transition first so concurrent events can't double-handle,
      // then settle waiters immediately before any best-effort server reads.
      t.state = "cancelled";
      t.errorText = t.errorText ?? "Session was interrupted.";
      t.idleAt = Date.now();
      touch(t);
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
            void ctx.session.interrupt({ sessionID: t.childID }).catch(() => undefined);
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
      // Cap entries so a long-lived server can't grow this map without bound (FIFO eviction).
      if (parentDefaults.has(parentID)) parentDefaults.delete(parentID);
      parentDefaults.set(parentID, result);
      while (parentDefaults.size > MAX_PARENT_DEFAULTS) {
        const oldest = parentDefaults.keys().next();
        if (oldest.done) break;
        parentDefaults.delete(oldest.value);
      }
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
      let inherited: { agent?: string; model?: ModelRef } | undefined;
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
      const candidates = [
        ...new Set([...[...tracked.values()].map((t) => t.childID), ...peers.keys()]),
      ].filter((id) => id.startsWith(ref));
      if (candidates.length === 1) return { id: candidates[0] };
      if (candidates.length > 1) {
        const known = knownSessionIds();
        return {
          ambiguous:
            `"${ref}" matches ${candidates.length} sessions (${candidates
              .map((id) => displayId(id, known))
              .join(", ")}). Use more characters of the id.`,
        };
      }
      return null;
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
    }): Promise<string> => {
      // Validate the working directory up front so a bad value fails fast
      // instead of surfacing as a confusing server-side create error.
      if (opts.directory !== undefined) {
        if (typeof opts.directory !== "string" || !opts.directory.trim()) {
          return "Refused: directory must be a non-empty path string.";
        }
        try {
          const st = await fs.promises.stat(opts.directory);
          if (!st.isDirectory()) return `Refused: directory is not a folder: ${opts.directory}`;
        } catch {
          return `Refused: directory does not exist or is unreadable: ${opts.directory}`;
        }
      }
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
      };
      tracked.set(childID, t);

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
      return out
        ? truncate(out, 12_000)
        : "(no user/assistant messages in this session yet)";
    };

    const abort = new AbortController();
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
      try {
        const reg = await ctx.tool.hook("execute.before", (event) => {
          const sessionID =
            typeof event?.sessionID === "string" ? event.sessionID : "";
          if (!sessionID || typeof event.tool !== "string") return;
          if (!isFileMutatingTool(event.tool)) return;
          const paths = extractEditPaths(event.input);
          if (paths.length === 0) return;
          try {
            claimFilesFor(sessionID, event.tool, paths);
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
          // text is identical, so re-adding it would only cost tokens and
          // churn the cached prompt prefix for no new information.
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
            if (!kept && wanted && text === wanted) {
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
          "Send a message to another session. Works for sessions this plugin spawned and for any other session in this project (see project_sessions) — pass the id it showed you; an unambiguous prefix is accepted, and an ambiguous one is refused rather than guessed. With noReply:true it injects context without triggering a new assistant turn.",
        input: z.object({
          sessionId: z.string().describe("Session id (child or peer)."),
          text: z.string().describe("Message text."),
          noReply: z.boolean().optional().describe("Inject the message without asking the session to reply (default false)."),
        }),
        execute: async (input) => {
          const args = input as { sessionId: string; text: string; noReply?: boolean };
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
                const how = await deliverToSession(target, args.text, args.noReply === true);
                // Announce the delivery so the peer's own awareness line shows
                // that someone reached out, rather than context appearing.
                recordPeer(peer.sessionId, peer.directory, { state: "running" });
                mirrorPeers();
                const quiet = verdict === "busy";
                return {
                  content:
                    `${how} (peer session, not spawned by this plugin)` +
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
            const how = await deliverToSession(target, args.text, false);
            return { content: `${how} Use session_result(wait:true) to await completion.` };
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
            // Entries with an unknown parent ("unknown" sentinel) are always
            // shown: they may belong to this session and must not be hidden.
            if (!args.all && t.parentSessionID !== toolCtx.sessionID && t.parentSessionID !== "unknown") continue;
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
        }),
        execute: async (input, toolCtx) => {
          const args = input as { task?: string; forget?: string };
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
          const remaining = others.filter((p) => verdicts.get(p.sessionId) !== "gone");

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
        }),
        execute: async (input, toolCtx) => {
          const args = input as { text: string; noReply?: boolean };
          const all = peersIn(defaultDirectory, toolCtx.sessionID);
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
          for (const p of reachable) {
            try {
              await deliverToSession(p.sessionId, args.text, args.noReply === true);
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
          if (vanished.length > 0) {
            parts.push(`Confirmed gone and dropped: ${vanished.join(", ")}.`);
          }
          if (quiet.length > 0) {
            parts.push(`Woke ${quiet.length} idle session(s): ${quiet.join(", ")}.`);
          }
          return { content: parts.join("\n") };
        },
      });
    });

    return () => {
      abort.abort();
      for (const reg of registrations) {
        void reg.dispose().catch(() => undefined);
      }
      for (const t of tracked.values()) {
        settleWaiters(t);
      }
      tracked.clear();
      parentDefaults.clear();
      outcomeCache.clear();
      // Drop presence entries this instance claimed, so a closed session stops
      // being advertised as a peer immediately rather than at the stale cutoff.
      // ctx exposes no self id, so the ids we claimed are tracked as we go.
      // Removal must hit shared storage too: mirrorPeers only writes, so
      // deleting from the local map alone would leave the published record
      // visible to other processes until peerStaleSec elapses.
      if (peerMirrorTimer !== undefined) clearTimeout(peerMirrorTimer);
      peerMirrorTimer = undefined;
      for (const id of selfSessionIDs) {
        peers.delete(peerKey(id));
        const key = peerStorageKey(id);
        publishedPeers.delete(key);
        void Promise.resolve(peerStore?.remove?.(key)).catch(() => undefined);
      }
      selfSessionIDs.clear();
      // Drop this instance's in-flight markers, so a reloaded plugin does not
      // leave a file looking like it is mid-write.
      releaseOwnInFlight();
      clearOwnWaitIntents();
      if (remotePeerTimer !== undefined) clearInterval(remotePeerTimer);
      if (peerMirrorTimer !== undefined) clearTimeout(peerMirrorTimer);
      peerMirrorTimer = undefined;
      peers.clear();
    };
  },
});
