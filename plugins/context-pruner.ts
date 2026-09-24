import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * context-pruner — the context compiler (tiers 1–3)
 *
 * Rewrites the messages handed to the model on every request
 * (`session.hook("context")`) without touching the transcript on disk.
 *
 * Tier 1 — token ledger: per-part token estimates calibrated against provider
 *   usage (`session.usage.updated`), so pruning is accounting, not guesswork.
 * Tier 2 — epoch scheduler: prune decisions are computed once and reused
 *   verbatim until enough new savings accumulate (`minReplanTokens`). The sent
 *   prefix stays byte-identical, so the provider prompt cache stays warm.
 * Tier 3 — semantic compression: a model-callable `compress` tool replaces a
 *   chosen range of tool output with a real summary produced by the session
 *   model (`session.generate`), cached by content hash and nestable. Automatic
 *   strategies (`dedupe`, `purgeErrors`) run on the same ledger, and threshold
 *   nudges ask the model to compress before the window fills.
 *
 * Everything DCP does, plus token-accurate budgets, cache-stable epochs,
 * cross-session summary caching, and live observability.
 */

type AnyRecord = Record<string, unknown>;

const VERSION = 1;
const STUB_MARK = "[context-pruner] output of ";
const SUMMARY_MARK = "[context summary]";
const PROSE_SUMMARY_MARK = "[context prose summary]";
const POINTER_MARK = "[context-pruner] folded into summary";

type ResultLike = { type?: string; value?: unknown };

type PartLike = {
  type?: string;
  name?: string;
  toolName?: string;
  tool?: string;
  id?: string;
  toolCallId?: string;
  text?: string;
  result?: ResultLike;
  input?: unknown;
};

type MessageLike = { id?: string; role?: string; content?: PartLike[] };

type Limit = { pct?: number; abs?: number };

type ManualMode = { enabled: boolean; automaticStrategies: boolean };
type TurnProtection = { enabled: boolean; turns: number };
type NotifyLevel = "off" | "minimal" | "detailed";
type NotifyType = "chat" | "toast";

type Config = {
  enabled: boolean;
  // legacy positional controls
  keepRecent: number;
  keepRecentText: number;
  /** Hot outputs that survive even the deepest over-budget relaxation. */
  relaxRecentFloor: number;
  minChars: number;
  budgetMinChars: number;
  keepHeadChars: number;
  keepErrors: boolean;
  ignoreTools: Set<string>;
  // tier 1
  charsPerToken: number;
  // tier 2
  budgetRatio: number;
  targetRatio: number;
  maxOutputReserve: number;
  keepRecentTurns: number;
  minReplanTokens: number;
  dedupe: boolean;
  purgeErrors: boolean;
  purgeErrorTurns: number;
  protectedTools: Set<string>;
  protectedPatterns: RegExp[];
  protectedFilePatterns: RegExp[];
  superseded: boolean;
  // tier 3 — compression
  compressEnabled: boolean;
  compressText: boolean;
  // NOTE: a `compressMode` ("range" | "message") option existed historically but
  // both branches behaved as "range"; it was removed — range behavior is the only mode.
  compressMaxSourceChars: number;
  protectTags: boolean;
  protectUserMessages: boolean;
  summaryBuffer: boolean;
  autoSummarize: boolean;
  autoSummarizeMaxCalls: number;
  autoSummarizeMinTokens: number;
  /** Per-request cap on auto-summarised units (top tokens first); 0 = unlimited. */
  maxAutoSummaries: number;
  /** Stub prose without a model call when past `autoSummarizeRatio` of budget. */
  autoSummarizeStub: boolean;
  autoSummarizeRatio: number;
  /**
   * Steady-state compaction: keep the outgoing request near a ceiling well
   * below the model window, so stale closed topics are summarised even when the
   * window is far from full. `steadyTargetRatio` 0 disables it.
   */
  proactiveSummarize: boolean;
  steadyTargetRatio: number;
  steadyTargetMinTokens: number;
  /**
   * Collapse closed spans that are fully represented in an applied summary:
   * drop the message shells, the per-unit JSON scaffolding, the pointers and
   * the tool-call arguments the digest already stands for. This is the
   * outgoing-request equivalent of a model-driven range compression, derived
   * locally and for free; nothing is written to disk and a tool call always
   * leaves with its result (invariant #2).
   */
  collapseRanges: boolean;
  /**
   * Also collapse spans whose parts are only *stubbed* rather than summarised,
   * dropping the retained head and the recall hint along with the rest of the
   * run. Maximum raw-token reduction; more local context is given up.
   */
  collapseStubs: boolean;
  cacheAware: boolean;
  cacheAmortize: number;
  compactionCheckpoint: boolean;
  retryOnOverflow: boolean;
  retryMaxAttempts: number;
  recoveryRatio: number;
  titleShortCircuit: boolean;
  summaryKeep: number;
  recall: boolean;
  recallKeep: number;
  recallMaxChars: number;
  minContextLimit: Limit | undefined;
  maxContextLimit: Limit | undefined;
  modelMinLimits: AnyRecord;
  modelMaxLimits: AnyRecord;
  nudgeEnabled: boolean;
  nudgeFrequency: number;
  // A nudge is also sent when the tool-call cadence stalls (every
  // `nudgeCallFrequency` tool calls) or the window is nearly full.
  nudgeCallFrequency: number;
  nudgeCriticalRatio: number;
  iterationNudgeThreshold: number;
  nudgeForce: "soft" | "strong";
  manualMode: ManualMode;
  turnProtection: TurnProtection;
  // reporting
  notify: NotifyLevel;
  notifyType: NotifyType;
  /** Minimum turn savings that trigger an inline prune receipt (0 = every prune). */
  notifyMinTokens: number;
  /** Also send a receipt when a summary is applied, even below the token floor. */
  notifyOnTopic: boolean;
  log: boolean;
  debug: boolean;
  configPath: string | undefined;
};

type Decision = {
  key: string;
  reason: string;
  origChars: number;
  savedChars: number;
  savedTokens: number;
};

type CollectedResult = {
  mi: number;
  pi: number;
  key: string;
  name: string;
  text: string;
  error: boolean;
  tokens: number;
  part: PartLike;
  input: unknown;
  /** "tool" for tool-result parts, "text" for assistant/user prose parts. */
  kind: "tool" | "text";
};

type SummaryRecord = {
  first: string;
  covers: string[];
  hashes: number[];
  text: string;
  tokens: number;
  topic: string;
  at: number;
  /** True when every covered unit is prose, so recall/report can distinguish it. */
  prose?: boolean;
};

type SessionState = {
  epoch: number;
  /** C18: recency tick for LRU eviction + epoch/decisions reload guard. */
  lastSeen: number;
  loadedEpoch: boolean;
  decisions: Map<string, Decision>;
  summaries: Map<string, SummaryRecord>;
  loadedSummaries: boolean;
  pendingEstimate: number;
  lastUsageTotal: number | null;
  ratio: number;
  requestCount: number;
  replanCount: number;
  window: number | null;
  budget: number | null;
  target: number | null;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  compressible: CollectedResult[];
  summariesCount: number;
  summarySavedTokens: number;
  savedTokensTotal: number;
  inputCost: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  lastGate: number;
  lastReplan: "allowed" | "deferred" | null;
  lastReplanShort: number;
  autoSummarizeCalls: number;
  autoSummarizing: boolean;
  recoveryTarget: number | null;
  overflowRetries: number;
  modelRef: string;
  recall: Map<string, { tool: string; text: string; chars: number; at: number }>;
  loadedRecall: boolean;
  recallDirty: boolean;
  lastNudgeRequest: number;
  iterationsSinceCompress: number;
  /** C3: total tool-call parts seen so far — cadence driver (not prunes). */
  lastToolCallTotal: number;
  /** C1: per-field CUMULATIVE baselines from the previous usage event. */
  lastInputTotal: number | null;
  lastCacheReadTotal: number | null;
  lastCacheWriteTotal: number | null;
  nudges: number;
  /** Message index from which prose is protected by turn protection (-1 = none). */
  textProtectedFrom: number;
  /** Message index of the live turn's user message (-1 = none). Never summarised. */
  turnProtectedFrom: number;
  /** Span collapse measured on the last compiled request. */
  collapseSpans: number;
  collapseMessages: number;
  collapseSavedTokens: number;
  /**
   * Receipt fragments banked by async/out-of-turn completions (auto-summarise,
   * compress tool, checkpoint). Flushed as part of the next turn's single
   * digest so one request never emits more than one receipt line.
   */
  pendingNotes: string[];
};

type ModelInfo = {
  id?: string;
  modelID?: string;
  providerID?: string;
  limit?: { context?: number; output?: number };
  cost?: Array<{
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  }>;
};

type LooseCtx = {
  options?: AnyRecord;
  location?: { directory?: string };
  session?: {
    hook?: (name: string, callback: (event: AnyRecord) => unknown) => Promise<unknown>;
    synthetic?: (input: AnyRecord) => Promise<unknown>;
    generate?: (input: AnyRecord) => Promise<{ text?: string }>;
  };
  tool?: { transform?: (callback: (editor: ToolEditorLike) => void) => Promise<unknown> };
  command?: { transform?: (callback: (editor: CommandEditorLike) => void) => Promise<unknown> };
  event?: { subscribe?: (callback: (event: AnyRecord) => void) => unknown };
  storage?: {
    get?: (key: string) => Promise<unknown>;
    set?: (key: string, value: unknown) => Promise<void>;
  };
  model?: { list?: () => unknown };
};

type ToolEditorLike = {
  add: (tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (input: unknown, context?: unknown) => Promise<{ content: string }>;
  }) => void;
};

type CommandEditorLike = {
  add: (definition: {
    name: string;
    description?: string;
    execute: (input: { sessionID?: string; prompt?: unknown }) => Promise<void>;
  }) => void;
};

// ----------------------------------------------------------------------------
// helpers

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as AnyRecord)[key];
  }
  return cur;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: AnyRecord, patch: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Parse JSONC (comments + trailing commas) without pulling a dependency. */
function parseJsonc(text: string): AnyRecord | undefined {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed: unknown = JSON.parse(out);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readConfigFile(path: string): AnyRecord | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return parseJsonc(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Collect config from (in order): global file, project file, legacy dcp file. */
function configCandidatePaths(directory: string | undefined): string[] {
  const candidates: string[] = [];
  const explicit = process.env.OPENCODE_CONTEXT_PRUNER_CONFIG;
  if (explicit) candidates.push(explicit);
  const globalDir = join(homedir(), ".config", "opencode");
  candidates.push(join(globalDir, "context-pruner.jsonc"));
  if (directory) {
    candidates.push(join(directory, ".opencode", "context-pruner.jsonc"));
  }
  candidates.push(join(globalDir, "dcp.jsonc"));
  if (directory) {
    candidates.push(join(directory, ".opencode", "dcp.jsonc"));
  }
  return candidates;
}

function loadConfigFiles(directory: string | undefined): { config: AnyRecord; path: string | undefined } {
  let config: AnyRecord = {};
  let path: string | undefined;
  for (const candidate of configCandidatePaths(directory)) {
    const loaded = readConfigFile(candidate);
    if (!loaded) continue;
    config = deepMerge(config, loaded);
    path = candidate;
  }
  return { config, path };
}

function parseLimit(value: unknown): Limit | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? { abs: value } : undefined;
  const text = String(value).trim();
  const pct = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) {
    const n = Number(pct[1]);
    return n > 0 ? { pct: Math.min(n, 100) } : undefined;
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? { abs: n } : undefined;
}

function limitTokens(limit: Limit | undefined, window: number): number | undefined {
  if (!limit) return undefined;
  if (limit.abs !== undefined) return limit.abs;
  if (limit.pct !== undefined) {
    // C13: callers pass a possibly-unknown window — 0/NaN would turn a
    // percentage limit into 0 tokens (or NaN).
    if (!Number.isFinite(window) || window <= 0) return undefined;
    return Math.floor(window * (limit.pct / 100));
  }
  return undefined;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function compilePatterns(list: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of list) {
    try {
      out.push(new RegExp(pattern));
    } catch {
      /* ignore malformed patterns */
    }
  }
  return out;
}

function compileGlobs(list: string[]): RegExp[] {
  return list.map((glob) => globToRegExp(glob));
}

const DEFAULT_PROTECTED = [
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
  "context_report",
  "context_map",
  "context_pruner_recall",
];

function resolveConfig(directory: string | undefined, options: AnyRecord | undefined): Config {
  const o = options ?? {};
  const { config: file, path } = loadConfigFiles(directory);
  const pick = (key: string, envKey: string, dcpPath?: string): unknown => {
    const fromOption = o[key];
    if (fromOption !== undefined && fromOption !== null && fromOption !== "") return fromOption;
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromDcp = dcpPath ? getPath(file, dcpPath) : undefined;
    const fromFlat = file[key];
    return firstDefined(fromDcp, fromFlat);
  };

  const protectedTools = new Set([
    ...DEFAULT_PROTECTED,
    ...asList(getPath(file, "protectedTools")),
    ...asList(pick("protectedTools", "OPENCODE_CONTEXT_PRUNER_PROTECTED_TOOLS")),
  ]);
  const protectedPatterns = compilePatterns(
    asList(pick("protectedPatterns", "OPENCODE_CONTEXT_PRUNER_PROTECTED_PATTERNS")),
  );
  const protectedFilePatterns = compileGlobs(
    asList(firstDefined(getPath(file, "protectedFilePatterns"), pick("protectedFilePatterns", "OPENCODE_CONTEXT_PRUNER_PROTECTED_FILES"))),
  );

  const charsPerToken = num(pick("charsPerToken", "OPENCODE_CONTEXT_PRUNER_CHARS_PER_TOKEN"), 3.6);
  const keepHeadChars = asInt(pick("keepHeadChars", "OPENCODE_CONTEXT_PRUNER_KEEP_HEAD"), 200, 0, 100000);
  const keepRecent = asInt(pick("keepRecent", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT"), 6, 0, 10000);
  // Prose (assistant/user text) is only eligible when compressText is on; the
  // most recent N prose parts stay untouched so the live reasoning is kept.
  const keepRecentText = asInt(pick("keepRecentText", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TEXT"), 2, 0, 10000);
  const minChars = asInt(pick("minChars", "OPENCODE_CONTEXT_PRUNER_MIN_CHARS"), 2000, 0, 10_000_000);
  // Over-budget pruning is allowed below the voluntary floor so small stale
  // outputs still shed when the window is tight (DCP prunes at any size).
  const budgetMinChars = asInt(pick("budgetMinChars", "OPENCODE_CONTEXT_PRUNER_BUDGET_MIN_CHARS"), Math.min(minChars, 200), 0, 10_000_000);

  const notifyRaw = firstDefined(pick("notify", "OPENCODE_CONTEXT_PRUNER_NOTIFY"), "detailed");
  let notify: NotifyLevel;
  if (typeof notifyRaw === "boolean") notify = notifyRaw ? "detailed" : "off";
  else if (["off", "minimal", "detailed"].includes(String(notifyRaw))) notify = String(notifyRaw) as NotifyLevel;
  else notify = asBool(notifyRaw, true) ? "detailed" : "off";

  const notifyTypeRaw = String(firstDefined(pick("notifyType", "OPENCODE_CONTEXT_PRUNER_NOTIFY_TYPE"), "toast")).toLowerCase();
  const notifyType: NotifyType = notifyTypeRaw === "chat" ? "chat" : "toast";
  const notifyMinTokens = asInt(pick("notifyMinTokens", "OPENCODE_CONTEXT_PRUNER_NOTIFY_MIN_TOKENS"), 500, 0, 10_000_000);
  const notifyOnTopic = asBool(pick("notifyOnTopic", "OPENCODE_CONTEXT_PRUNER_NOTIFY_ON_TOPIC"), true);

  const manualRaw = getPath(file, "manualMode");
  const manualMode: ManualMode = {
    enabled: asBool(firstDefined(pick("manualMode", ""), isPlainObject(manualRaw) ? manualRaw.enabled : manualRaw), false),
    automaticStrategies: asBool(isPlainObject(manualRaw) ? firstDefined(manualRaw.automaticStrategies, true) : true, true),
  };

  const turnRaw = getPath(file, "turnProtection");
  const turnProtection: TurnProtection = {
    enabled: asBool(isPlainObject(turnRaw) ? firstDefined(turnRaw.enabled, false) : false, false),
    turns: asInt(isPlainObject(turnRaw) ? turnRaw.turns : undefined, 4, 0, 1000),
  };

  const compressRaw = getPath(file, "compress");
  const compress = isPlainObject(compressRaw) ? compressRaw : {};
  const compressValue = (dcpKey: string, envKey: string, flatKey: string): unknown =>
    firstDefined(getPath(compress, dcpKey), pick(flatKey, envKey));

  const strategiesRaw = getPath(file, "strategies");
  const strategies = isPlainObject(strategiesRaw) ? strategiesRaw : {};
  const dedupeFile = firstDefined(getPath(strategies, "deduplication"), getPath(file, "deduplication"));
  const purgeFile = firstDefined(getPath(strategies, "purgeErrors"), getPath(file, "purgeErrors"));

  const nudgeForceRaw = String(firstDefined(compressValue("nudgeForce", "", "nudgeForce"), "soft")).toLowerCase();

  return {
    enabled: asBool(pick("enabled", "OPENCODE_CONTEXT_PRUNER_ENABLED"), true),
    keepRecent,
    keepRecentText,
    relaxRecentFloor: asInt(pick("relaxRecentFloor", "OPENCODE_CONTEXT_PRUNER_RELAX_FLOOR"), 2, 0, 1000),
    minChars,
    budgetMinChars,
    keepHeadChars,
    keepErrors: asBool(pick("keepErrors", "OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS"), true),
    ignoreTools: new Set(asList(pick("ignoreTools", "OPENCODE_CONTEXT_PRUNER_IGNORE"))),
    charsPerToken: charsPerToken > 0 ? charsPerToken : 3.6,
    budgetRatio: Math.min(Math.max(num(pick("budgetRatio", "OPENCODE_CONTEXT_PRUNER_BUDGET_RATIO"), 0.9), 0.1), 1),
    targetRatio: Math.min(Math.max(num(pick("targetRatio", "OPENCODE_CONTEXT_PRUNER_TARGET_RATIO"), 0.85), 0.1), 1),
    maxOutputReserve: asInt(pick("maxOutputReserve", "OPENCODE_CONTEXT_PRUNER_MAX_OUTPUT_RESERVE"), 8192, 0, 1_000_000),
    keepRecentTurns: asInt(pick("keepRecentTurns", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TURNS"), 2, 0, 1000),
    minReplanTokens: asInt(pick("minReplanTokens", "OPENCODE_CONTEXT_PRUNER_MIN_REPLAN_TOKENS"), 2000, 0, 10_000_000),
    dedupe: asBool(firstDefined(isPlainObject(dedupeFile) ? dedupeFile.enabled : dedupeFile, pick("dedupe", "OPENCODE_CONTEXT_PRUNER_DEDUPE")), true),
    purgeErrors: asBool(firstDefined(isPlainObject(purgeFile) ? purgeFile.enabled : purgeFile, pick("purgeErrors", "OPENCODE_CONTEXT_PRUNER_PURGE_ERRORS")), true),
    purgeErrorTurns: asInt(isPlainObject(purgeFile) ? purgeFile.turns : undefined, 4, 0, 1000),
    protectedTools,
    protectedPatterns,
    protectedFilePatterns,
    superseded: asBool(pick("superseded", "OPENCODE_CONTEXT_PRUNER_SUPERSEDED"), true),
    compressEnabled: asBool(compressValue("enabled", "OPENCODE_CONTEXT_PRUNER_COMPRESS", "compressEnabled"), true),
    compressText: asBool(compressValue("text", "OPENCODE_CONTEXT_PRUNER_COMPRESS_TEXT", "compressText"), true),
    // CP-6: the `compress.mode` option was dead config (every accepted value
    // mapped to "range"); it is no longer read — range behavior always applies,
    // and legacy configs that still set "mode" keep parsing without error.
    compressMaxSourceChars: asInt(compressValue("maxSourceChars", "OPENCODE_CONTEXT_PRUNER_COMPRESS_MAX_CHARS", "compressMaxSourceChars"), 24000, 500, 10_000_000),
    protectTags: asBool(compressValue("protectTags", "OPENCODE_CONTEXT_PRUNER_PROTECT_TAGS", "protectTags"), true),
    protectUserMessages: asBool(compressValue("protectUserMessages", "OPENCODE_CONTEXT_PRUNER_PROTECT_USER", "protectUserMessages"), false),
    summaryBuffer: asBool(compressValue("summaryBuffer", "OPENCODE_CONTEXT_PRUNER_SUMMARY_BUFFER", "summaryBuffer"), true),
    autoSummarize: asBool(compressValue("autoSummarize", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS", "autoSummarize"), true),
    autoSummarizeMaxCalls: asInt(compressValue("autoSummarizeMaxCalls", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MAX", "autoSummarizeMaxCalls"), 5, 0, 1000),
    autoSummarizeMinTokens: asInt(compressValue("autoSummarizeMinTokens", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MIN", "autoSummarizeMinTokens"), 4000, 0, 10_000_000),
    maxAutoSummaries: asInt(compressValue("maxAutoSummaries", "OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES", "maxAutoSummaries"), 12, 0, 1000),
    // DCP has no cap on compression. The cap stays for the conservative
    // profile, but any profile can set it to 0 (unlimited); the model-call
    // budget is what actually gates the decision, and past
    // `autoSummarizeRatio` of the window a model call is worth it.
    autoSummarizeStub: asBool(compressValue("stubFallback", "OPENCODE_CONTEXT_PRUNER_AUTO_STUB", "autoSummarizeStub"), true),
    autoSummarizeRatio: Math.min(Math.max(num(compressValue("autoSummarizeRatio", "OPENCODE_CONTEXT_PRUNER_AUTO_RATIO", "autoSummarizeRatio"), 0.7), 0.1), 1),
    proactiveSummarize: asBool(pick("proactiveSummarize", "OPENCODE_CONTEXT_PRUNER_PROACTIVE"), true),
    steadyTargetRatio: Math.min(Math.max(num(pick("steadyTargetRatio", "OPENCODE_CONTEXT_PRUNER_STEADY_RATIO"), 0.06), 0), 1),
    steadyTargetMinTokens: asInt(pick("steadyTargetMinTokens", "OPENCODE_CONTEXT_PRUNER_STEADY_MIN"), 1500, 0, 10_000_000),
    collapseRanges: asBool(pick("collapseRanges", "OPENCODE_CONTEXT_PRUNER_COLLAPSE"), true),
    collapseStubs: asBool(pick("collapseStubs", "OPENCODE_CONTEXT_PRUNER_COLLAPSE_STUBS"), true),
    cacheAware: asBool(pick("cacheAware", "OPENCODE_CONTEXT_PRUNER_CACHE_AWARE"), true),
    cacheAmortize: asInt(pick("cacheAmortize", "OPENCODE_CONTEXT_PRUNER_CACHE_AMORTIZE"), 4, 1, 100),
    compactionCheckpoint: asBool(pick("compactionCheckpoint", "OPENCODE_CONTEXT_PRUNER_COMPACTION"), true),
    retryOnOverflow: asBool(pick("retryOnOverflow", "OPENCODE_CONTEXT_PRUNER_RETRY"), true),
    retryMaxAttempts: asInt(pick("retryMaxAttempts", "OPENCODE_CONTEXT_PRUNER_RETRY_MAX"), 3, 1, 100),
    recoveryRatio: Math.min(Math.max(num(pick("recoveryRatio", "OPENCODE_CONTEXT_PRUNER_RECOVERY_RATIO"), 0.5), 0.1), 0.9),
    titleShortCircuit: asBool(pick("titleShortCircuit", "OPENCODE_CONTEXT_PRUNER_TITLE"), false),
    summaryKeep: asInt(pick("summaryKeep", "OPENCODE_CONTEXT_PRUNER_SUMMARY_KEEP"), 100, 0, 100000),
    recall: asBool(pick("recall", "OPENCODE_CONTEXT_PRUNER_RECALL"), true),
    recallKeep: asInt(pick("recallKeep", "OPENCODE_CONTEXT_PRUNER_RECALL_KEEP"), 50, 0, 10000),
    recallMaxChars: asInt(pick("recallMaxChars", "OPENCODE_CONTEXT_PRUNER_RECALL_MAX_CHARS"), 200000, 1000, 10_000_000),
    minContextLimit: parseLimit(compressValue("minContextLimit", "OPENCODE_CONTEXT_PRUNER_MIN_CONTEXT_LIMIT", "minContextLimit")),
    maxContextLimit: parseLimit(compressValue("maxContextLimit", "OPENCODE_CONTEXT_PRUNER_MAX_CONTEXT_LIMIT", "maxContextLimit")),
    modelMinLimits: (getPath(compress, "modelMinLimits") as AnyRecord) ?? {},
    modelMaxLimits: (getPath(compress, "modelMaxLimits") as AnyRecord) ?? {},
    nudgeEnabled: asBool(compressValue("nudgeEnabled", "OPENCODE_CONTEXT_PRUNER_NUDGE", "nudgeEnabled"), true),
    nudgeFrequency: asInt(compressValue("nudgeFrequency", "OPENCODE_CONTEXT_PRUNER_NUDGE_FREQUENCY", "nudgeFrequency"), 5, 1, 1000),
    nudgeCallFrequency: asInt(compressValue("nudgeCallFrequency", "OPENCODE_CONTEXT_PRUNER_NUDGE_CALLS", "nudgeCallFrequency"), 8, 1, 10000),
    nudgeCriticalRatio: Math.min(Math.max(num(compressValue("nudgeCriticalRatio", "OPENCODE_CONTEXT_PRUNER_NUDGE_CRITICAL", "nudgeCriticalRatio"), 0.8), 0.1), 1),
    iterationNudgeThreshold: asInt(compressValue("iterationNudgeThreshold", "OPENCODE_CONTEXT_PRUNER_ITERATION_NUDGE", "iterationNudgeThreshold"), 15, 1, 10000),
    nudgeForce: nudgeForceRaw === "strong" ? "strong" : "soft",
    manualMode,
    turnProtection,
    notify,
    notifyType,
    notifyMinTokens,
    notifyOnTopic,
    log: asBool(pick("log", "OPENCODE_CONTEXT_PRUNER_LOG"), false),
    debug: asBool(pick("debug", "OPENCODE_CONTEXT_PRUNER_DEBUG"), false),
    configPath: path,
  };
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    // Live tool-result values are arrays of content parts
    // (`[{type:"text",text}, {type:"file",...}]`). Extract the readable text
    // so pruning measures — and stubs — the same text the model would see.
    const texts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        texts.push(item);
      } else if (isPlainObject(item) && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
    // No text parts (e.g. file-only output): fall through to JSON so the
    // size estimate still reflects the payload instead of reading empty.
  }
  try {
    // CP-9: file-only payloads can be huge — cap the serialized form.
    const json = JSON.stringify(value) ?? "";
    return json.length > 2000 ? `${json.slice(0, 2000)}\n[truncated]` : json;
  } catch {
    return String(value);
  }
}

function resultText(result: ResultLike | undefined): string {
  if (!result) return "";
  return valueToText(result.value);
}

function isToolResult(part: PartLike): boolean {
  return part.type === "tool-result" || (part.result !== undefined && part.type === undefined);
}

function toolNameOf(part: PartLike): string {
  return String(part.name ?? part.toolName ?? part.tool ?? "tool");
}

function isErrorResult(result: ResultLike | undefined): boolean {
  return result?.type === "error";
}

/** `session.generate` may return `{ text }` or a wrapped `{ data: { text } }`. */
function generatedText(response: unknown): string {
  if (typeof response === "string") return response;
  if (isPlainObject(response)) {
    if (typeof response.text === "string") return response.text;
    const data = response.data;
    if (isPlainObject(data) && typeof data.text === "string") return data.text;
  }
  return "";
}

/** FNV-1a, stable within a process and cheap over large strings. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function estimateTokens(text: string, cfg: Config, ratio: number): number {
  return estimateCharsTokens(text.length, cfg, ratio);
}

/** The same conversion for a size that is already known in characters. */
function estimateCharsTokens(chars: number, cfg: Config, ratio: number): number {
  if (chars <= 0) return 0;
  const base = chars / cfg.charsPerToken;
  return Math.max(1, Math.ceil(base * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1)));
}

function partKey(mi: number, pi: number, part: PartLike, message: MessageLike): string {
  const id = part.id ?? part.toolCallId;
  if (id) return `t:${id}`;
  return `m:${message.id ?? mi}:${pi}`;
}

/**
 * Tool arguments live on the sibling `tool-call` part, not on `tool-result`
 * (`ToolResultPart` has no `input`). Correlate them by id so signature dedupe,
 * superseded reads and protected paths also work on the real hook payload.
 */
function toolCallInputs(messages: MessageLike[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (part?.type !== "tool-call") continue;
      const id = part.id ?? part.toolCallId;
      if (id) out.set(id, part.input);
    }
  }
  return out;
}

function collectResults(messages: MessageLike[], cfg: Config, ratio: number): CollectedResult[] {
  const out: CollectedResult[] = [];
  const callInputs = toolCallInputs(messages);
  for (let mi = 0; mi < messages.length; mi++) {
    const message = messages[mi] ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi] ?? {};
      if (isToolResult(part)) {
        const text = resultText(part.result);
        const callId = part.id ?? part.toolCallId;
        out.push({
          mi,
          pi,
          key: partKey(mi, pi, part, message),
          name: toolNameOf(part),
          text,
          error: isErrorResult(part.result),
          tokens: estimateTokens(text, cfg, ratio),
          part,
          input: part.input !== undefined ? part.input : callId ? callInputs.get(callId) : undefined,
          kind: "tool",
        });
        continue;
      }
      // Prose is opt-in (compressText). We replace the text part in place; the
      // message and any tool-call parts stay exactly where they were, so a
      // tool call is never decoupled from its result.
      if (!cfg.compressText || part.type !== "text" || typeof part.text !== "string") continue;
      const role = String(message.role ?? "");
      if (role !== "assistant" && role !== "user") continue;
      if (role === "user" && cfg.protectUserMessages) continue;
      const text = part.text;
      if (!text.trim()) continue;
      out.push({
        mi,
        pi,
        key: partKey(mi, pi, part, message),
        name: role === "user" ? "user-message" : "assistant-message",
        text,
        error: false,
        tokens: estimateTokens(text, cfg, ratio),
        part,
        input: undefined,
        kind: "text",
      });
    }
  }
  return out;
}

function protectedFromIndex(messages: MessageLike[], turns: number): number {
  if (turns <= 0) return -1;
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") userIdxs.push(i);
  }
  if (userIdxs.length <= turns) return -1;
  return userIdxs[userIdxs.length - turns];
}

/** C3: count of tool-call parts in the outgoing request. */
function countToolCalls(messages: MessageLike[]): number {
  let n = 0;
  for (const message of messages) {
    for (const part of message.content ?? []) if (part.type === "tool-call") n++;
  }
  return n;
}

/** C16: prose compresses far better than tool output — lower floor for it. */
function minCharsFor(r: CollectedResult, cfg: Config): number {
  return r.kind === "text" ? Math.max(200, Math.floor(cfg.minChars / 4)) : cfg.minChars;
}

function filePathOf(result: CollectedResult): string | undefined {
  if (!isPlainObject(result.input)) return undefined;
  const value = firstDefined(result.input.filePath, result.input.path, result.input.file);
  return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
}

/** Canonical key for comparing file paths across case-insensitive filesystems. */
function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function pathOfPart(part: PartLike): string | undefined {
  if (!isPlainObject(part.input)) return undefined;
  const value = firstDefined(part.input.filePath, part.input.path, part.input.file);
  return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isPlainObject(error)) {
    const direct = firstDefined(error.message, error.name, error.type, error.reason, error.detail);
    if (typeof direct === "string") return direct;
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return error ? String(error) : "";
}

/** Provider phrasing for "the prompt is larger than the window". */
function isOverflowError(text: string): boolean {
  return /context[_ ]?(length|window|limit|size)|maximum context|too many tokens|token limit|prompt is too long|reduce the length|exceeds? the (maximum |available )?context|exceed_?context/i.test(
    text,
  );
}

/** Deterministic compaction checkpoint: goals, progress, files, recent errors. */
function buildCheckpoint(messages: MessageLike[]): string {
  const goals: string[] = [];
  const progress: string[] = [];
  const files = new Map<string, number>();
  const errors: string[] = [];
  for (const message of messages) {
    const role = String(message.role ?? "");
    for (const part of message.content ?? []) {
      const type = String(part.type ?? "");
      if (type === "text" && typeof part.text === "string" && part.text.trim()) {
        if (role === "user") goals.push(part.text.trim());
        else if (role === "assistant") progress.push(part.text.trim());
        continue;
      }
      if (type === "tool-call" || type === "tool-result") {
        const path = pathOfPart(part);
        if (path) files.set(path, (files.get(path) ?? 0) + 1);
        if (type === "tool-result" && isErrorResult(part.result)) {
          const text = resultText(part.result).replace(/\s+/g, " ").trim();
          if (text) errors.push(`- ${String(part.name ?? "tool")}: ${text.slice(0, 200)}`);
        }
      }
    }
  }
  const squash = (text: string, limit: number): string => text.replace(/\s+/g, " ").trim().slice(0, limit);
  const lines = ["# Context checkpoint", ""];
  if (goals.length) {
    lines.push("## Goal");
    for (const goal of goals.slice(-3)) lines.push(`- ${squash(goal, 400)}`);
    lines.push("");
  }
  if (progress.length) {
    lines.push("## Progress");
    for (const item of progress.slice(-3)) lines.push(`- ${squash(item, 400)}`);
    lines.push("");
  }
  if (files.size) {
    lines.push("## Files touched");
    for (const [path, count] of [...files.entries()].slice(-40)) lines.push(`- ${path}${count > 1 ? ` (${count}x)` : ""}`);
    lines.push("");
  }
  if (errors.length) {
    lines.push("## Recent tool errors");
    lines.push(...errors.slice(-5));
    lines.push("");
  }
  lines.push("_Written automatically by context-pruner; the full transcript stays on disk._");
  return lines.join("\n");
}

function deriveTitle(messages: MessageLike[]): string | undefined {
  for (const message of messages) {
    if (String(message.role ?? "") !== "user") continue;
    for (const part of message.content ?? []) {
      if (String(part.type ?? "") !== "text" || typeof part.text !== "string") continue;
      const text = part.text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const sentence = text.split(/[.!?\n]/)[0]?.trim() ?? text;
      const title = sentence.slice(0, 60).trim();
      if (title.length >= 3) return title;
    }
  }
  return undefined;
}

// CP-11: shared RegExp instances are stateful when global/sticky — a `g`/`y`
// flag left over from a future caller or hand-built config would make
// `test()` alternate true/false via `lastIndex`. Reset around every test.
function statelessTest(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  const hit = re.test(text);
  re.lastIndex = 0;
  return hit;
}

function blockedByFilePattern(result: CollectedResult, cfg: Config): boolean {
  if (cfg.protectedFilePatterns.length === 0) return false;
  const path = filePathOf(result);
  if (!path) return false;
  return cfg.protectedFilePatterns.some((re) => statelessTest(re, path));
}

function isProtected(result: CollectedResult, cfg: Config): boolean {
  return (
    cfg.ignoreTools.has(result.name) ||
    cfg.protectedTools.has(result.name) ||
    cfg.protectedPatterns.some((re) => statelessTest(re, result.name)) ||
    blockedByFilePattern(result, cfg)
  );
}

function candidateResults(
  results: CollectedResult[],
  messages: MessageLike[],
  cfg: Config,
  covered: Set<string>,
  minLength = cfg.minChars,
  relax = {
    recent: false,
    turns: false,
  },
  liveFrom = -1,
): CollectedResult[] {
  const recent = relax.recent
    ? new Set<string>()
    : new Set(results.slice(Math.max(0, results.length - cfg.keepRecent)).map((r) => r.key));
  const turns = relax.turns ? 0 : Math.max(cfg.keepRecentTurns, cfg.turnProtection.enabled ? cfg.turnProtection.turns : 0);
  const from = turns <= 0 ? -1 : protectedFromIndex(messages, turns);
  const errorFrom = cfg.purgeErrors && !cfg.keepErrors ? protectedFromIndex(messages, cfg.purgeErrorTurns) : -1;
  return results.filter(
    (r) =>
      r.kind === "tool" &&
      // C2: the live turn is NEVER eligible — deep relaxation used to allow
      // stubbing the very tool result this request just received.
      !(liveFrom >= 0 && r.mi >= liveFrom) &&
      !recent.has(r.key) &&
      !covered.has(r.key) &&
      !(from >= 0 && r.mi >= from) &&
      !(errorFrom >= 0 && r.error && r.mi >= errorFrom) &&
      !isProtected(r, cfg) &&
      r.text.length >= minLength,
  );
}

/**
 * Prose units that must not be summarised: the most recent `keepRecentText`
 * and anything inside the protected turns. Tool results are handled separately
 * by `candidateResults`.
 */
function protectedTextKeys(units: CollectedResult[], st: SessionState, cfg: Config): Set<string> {
  const keys = new Set<string>();
  const texts = units.filter((u) => u.kind === "text");
  const recent = texts.slice(Math.max(0, texts.length - cfg.keepRecentText));
  for (const u of recent) keys.add(u.key);
  if (st.textProtectedFrom >= 0) {
    for (const u of texts) if (u.mi >= st.textProtectedFrom) keys.add(u.key);
  }
  return keys;
}

/** Stable identity of a tool call: tool name plus sorted, normalised arguments. */
function toolSignature(r: CollectedResult): string {
  if (r.kind !== "tool" || !isPlainObject(r.input)) return "";
  const keys = Object.keys(r.input).sort();
  const json = JSON.stringify(r.input, keys, 0) ?? "";
  if (json.length > 4096) return "";
  return hash32(`${r.name}\u0000${json}`).toString(16);
}

function recallId(key: string, text: string): string {
  return hash32(`${key}\u0000${text}`).toString(16).padStart(8, "0");
}

/** Drop the least recently stored entries until the cache is within `keep`. */
function evictRecall(st: SessionState, keep: number): void {
  while (st.recall.size > keep) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of st.recall) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    st.recall.delete(oldestKey);
  }
}

/**
 * Keep the full text of a pruned result so the model can recall it instead of
 * paying to re-run the tool. Bounded by count; oldest entries fall away first.
 * The entry is written through to `ctx.storage` so a restart keeps recall alive.
 */
function rememberOutput(st: SessionState, r: CollectedResult, cfg: Config): string | undefined {
  if (!cfg.recall || cfg.recallKeep <= 0) return undefined;
  const id = recallId(r.key, r.text);
  if (!st.recall.has(id)) {
    st.recall.set(id, { tool: r.name, text: r.text, chars: r.text.length, at: Date.now() });
    evictRecall(st, cfg.recallKeep);
    st.recallDirty = true;
  }
  return id;
}

/** C8: per-request memo — planDecisions runs up to 4x per request and each
 * run rebuilt identical stub strings with repeated slicing. Pure function of
 * the key parts, so entries stay valid across requests; bounded by cap. */
const stubMemo = new Map<string, { stub: string; savedChars: number; savedTokens: number }>();
const STUB_MEMO_MAX = 4096;

function makeStub(
  r: CollectedResult,
  reason: string,
  cfg: Config,
  ratio: number,
  id?: string,
): { stub: string; savedChars: number; savedTokens: number } {
  const memoKey = `${r.key}|${reason}|${r.text.length}|${hash32(r.text.slice(0, 512))}|${cfg.keepHeadChars}|${ratio}|${id ?? ""}`;
  const memoHit = stubMemo.get(memoKey);
  if (memoHit) return memoHit;
  const resultType = isPlainObject(r.part.result) ? r.part.result.type : undefined;
  const isText = resultType === undefined || resultType === "text";
  const head = isText ? r.text.slice(0, cfg.keepHeadChars).trimEnd() : "";
  const path = filePathOf(r);
  const fileNote = path ? ` (file: ${path})` : "";
  const hint = id ? ` Full output kept locally: call context_pruner_recall with id "${id}".` : "";
  const marker = `[context-pruner] output of "${r.name}"${fileNote} pruned (${r.text.length} chars, ~${r.tokens} tokens). ${reason}. Re-run the tool if you need it again.${hint}`;
  const stub = head ? `${head}\n\n${marker}` : marker;
  const out = {
    stub,
    savedChars: Math.max(0, r.text.length - stub.length),
    savedTokens: Math.max(0, r.tokens - estimateTokens(stub, cfg, ratio)),
  };
  // CP-10: FIFO-evict the oldest entries instead of dropping the whole
  // cache — a full clear throws away hot stubs next to cold ones.
  if (stubMemo.size >= STUB_MEMO_MAX) {
    let evicted = 0;
    for (const oldest of stubMemo.keys()) {
      stubMemo.delete(oldest);
      if (++evicted >= 512) break;
    }
  }
  stubMemo.set(memoKey, out);
  return out;
}

/** Hash each covered result's text so a summary can detect changed sources. */
function coverHashes(results: CollectedResult[]): number[] {
  return results.map((r) => hash32(r.text));
}

function isPrunedStub(text: string): boolean {
  return (
    text.startsWith(STUB_MARK) ||
    text.includes(`\n\n${STUB_MARK}`) ||
    text.startsWith(POINTER_MARK) ||
    text.startsWith(SUMMARY_MARK) ||
    text.startsWith(PROSE_SUMMARY_MARK)
  );
}

/**
 * Build a replacement result that the model request can actually send.
 * OpenCode core iterates `result.value` as an array
 * (`value.map((a) => a.type !== "file" ? a : ...)`, SessionModelRequest.prepare),
 * so a plain string here crashes every subsequent request with
 * `s.result.value.map is not a function`. Pruned output is text, so the
 * replacement is always `{type:"text", value:[{type:"text",text}]}`.
 */
function typedResult(_r: CollectedResult, value: string): ResultLike {
  return { type: "text", value: [{ type: "text", text: value }] };
}

/** Write the compiled value back into the part for this request only. */
function writeUnit(r: CollectedResult, value: string): void {
  if (r.kind === "text") {
    // Prose keeps `type: "text"` and every sibling part stays in place.
    r.part.text = value;
    return;
  }
  // CP-7: preserve extra host fields — replacing the whole object drops
  // metadata the host attached to `result`.
  const prev = isPlainObject(r.part.result) ? (r.part.result as AnyRecord) : {};
  r.part.result = { ...prev, ...typedResult(r, value) };
}

function sumSaved(decisions: Map<string, Decision>): number {
  let total = 0;
  for (const d of decisions.values()) total += d.savedTokens;
  return total;
}

function systemTextOf(event: AnyRecord): string {
  const system = event.system;
  if (!Array.isArray(system)) return "";
  return system
    .map((p) => (p && typeof (p as AnyRecord).text === "string" ? String((p as AnyRecord).text) : ""))
    .join("\n");
}

const modelCaches = new WeakMap<object, ModelInfo[]>();
let modelCacheSize = 0;

/** Model lists come back as `{ data: [...] }` (async) or a bare array (tests). */
function normalizeModels(value: unknown): ModelInfo[] {
  if (Array.isArray(value)) return value as ModelInfo[];
  if (isPlainObject(value) && Array.isArray(value.data)) return value.data as ModelInfo[];
  if (isPlainObject(value) && Array.isArray(value.models)) return value.models as ModelInfo[];
  return [];
}

function setModelCache(ctx: LooseCtx, models: ModelInfo[]): void {
  modelCaches.set(ctx as object, models);
  modelCacheSize = Math.max(modelCacheSize, models.length);
}

/**
 * `ctx.model.list()` is async in the live runtime, but the context hook is
 * synchronous. Resolve it once per context object and read the cached result.
 */
function refreshModels(ctx: LooseCtx): void {
  try {
    if (typeof ctx.model?.list !== "function") return;
    const value = ctx.model.list();
    if (Array.isArray(value)) {
      setModelCache(ctx, normalizeModels(value));
      return;
    }
    if (value && typeof (value as { then?: unknown }).then === "function") {
      void (value as Promise<unknown>)
        .then((output) => setModelCache(ctx, normalizeModels(output)))
        .catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function resolveModel(ctx: LooseCtx, ref: AnyRecord | undefined): ModelInfo | undefined {
  const list = modelCaches.get(ctx as object) ?? [];
  if (list.length === 0) return undefined;
  const id = ref?.id ?? ref?.modelID ?? ref?.model ?? ref?.name;
  const pid = ref?.providerID ?? ref?.provider;
  const matches = (m: ModelInfo): boolean =>
    m?.id === id ||
    m?.modelID === id ||
    (typeof m?.id === "string" && typeof id === "string" && (m.id === `${pid}/${id}` || m.id.endsWith(`/${id}`)));
  const wrongProvider = (m: ModelInfo): boolean => typeof pid === "string" && typeof m?.providerID === "string" && m.providerID !== pid;
  if (typeof id === "string") {
    const exact = list.find((m) => matches(m) && !wrongProvider(m));
    if (exact) return exact;
    const loose = list.find(matches);
    if (loose) return loose;
  }
  if (typeof pid === "string") return list.find((m) => m?.providerID === pid);
  return undefined;
}

function budgetFor(model: ModelInfo | undefined, cfg: Config): { window: number; budget: number; target: number } | null {
  const window = num(model?.limit?.context);
  if (!window || window <= 0) return null;
  // CP-5: real hard cap — reserve is the model's output limit clamped to
  // maxOutputReserve, falling back to maxOutputReserve when unknown.
  const outputLimit = num(model?.limit?.output);
  const reserve = outputLimit > 0 ? Math.min(outputLimit, cfg.maxOutputReserve) : cfg.maxOutputReserve;
  const budget = Math.max(0, Math.floor(window * cfg.budgetRatio) - reserve);
  const target = Math.max(0, Math.floor(budget * cfg.targetRatio));
  return { window, budget, target };
}

/** Resolve a per-model override map entry (exact provider/id, id, then substring). */
function overrideLimit(map: AnyRecord, model: ModelInfo | undefined, ref: AnyRecord | undefined): Limit | undefined {
  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;
  const pid = model?.providerID ?? (typeof ref?.providerID === "string" ? ref.providerID : undefined);
  const id = model?.id ?? (typeof ref?.modelID === "string" ? ref.modelID : typeof ref?.id === "string" ? ref.id : undefined);
  const candidates = [pid && id ? `${pid}/${id}` : "", id ?? "", pid ?? ""].filter(Boolean);
  for (const candidate of candidates) {
    if (map[candidate] !== undefined) return parseLimit(map[candidate]);
  }
  for (const key of keys) {
    if (id && id.includes(key)) return parseLimit(map[key]);
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// module state

const sessions = new Map<string, SessionState>();
const calibration = new Map<string, number>();
// CP-4: model-key hint per session — must be evicted with its session (see stateFor).
const sessionModelKey = new Map<string, string>();

/**
 * CP-1: best-effort storage write — a throwing or rejecting store must never
 * surface (sync throw is swallowed, async rejection gets a no-op catch so
 * Node never reports an unhandled rejection).
 */
function guardedSet(store: unknown, key: string, value: unknown): void {
  try {
    Promise.resolve(
      (store as { set?: (k: string, v: unknown) => unknown } | undefined)?.set?.(key, value),
    ).catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}
/**
 * Adaptive cache economics. Rewriting a cached prefix pays the provider's
 * cache-write premium once; pruning saves cache-read tokens on every later
 * request. Return the token savings needed to amortise that rewrite within
 * `cacheAmortize` future requests, capped at half the target so a warm cache
 * can defer churn but never starve the budget.
 */
function cacheReplanGate(st: SessionState, cfg: Config): number {
  if (!cfg.cacheAware) return 0;
  if (st.cacheRead === 0 && st.cacheWrite === 0) return 0;
  const read = st.cacheReadPrice > 0 ? st.cacheReadPrice : st.inputCost * 0.1;
  const write = st.cacheWritePrice > 0 ? st.cacheWritePrice : st.inputCost * 1.25;
  const premium = write - read;
  if (read <= 0 || premium <= 0) return 0;
  const suffix = st.pendingEstimate > 0 ? st.pendingEstimate : st.budget ?? 0;
  return Math.max(0, (suffix * premium) / (read * Math.max(1, cfg.cacheAmortize)));
}

const totals = {
  requests: 0,
  pruned: 0,
  stubbed: 0,
  stubSavedTokens: 0,
  savedChars: 0,
  savedTokens: 0,
  summaries: 0,
  summarySavedTokens: 0,
  generations: 0,
  nudgeCount: 0,
  checkpoints: 0,
  overflowRecoveries: 0,
  recalls: 0,
  collapsedSpans: 0,
  collapsedMessages: 0,
  collapsedTokens: 0,
};

function stateFor(sessionID: string): SessionState {
  // C18: monotonic recency tick (not wall clock) — every access strictly
  // increases, so ties are impossible and tests are deterministic.
  const now = ++seenClock;
  let st = sessions.get(sessionID);
  if (st) {
    st.lastSeen = now;
    return st;
  }
  // C18 (was C7): evict the least-recently-used session, not the
  // first-inserted one, so active sessions survive eviction pressure.
  // The victim's epoch/decisions are flushed first, making eviction lossless.
  if (sessions.size >= 512) {
    let stalestKey: string | undefined;
    let stalestAt = Infinity;
    for (const [key, entry] of sessions) {
      if (entry.lastSeen < stalestAt) {
        stalestAt = entry.lastSeen;
        stalestKey = key;
      }
    }
    if (stalestKey !== undefined) {
      const evicted = sessions.get(stalestKey);
      if (evicted) flushEpoch(stalestKey, evicted);
      sessions.delete(stalestKey);
      // CP-4: the model-key hint must die with its session or the map
      // grows without bound across sessions.
      sessionModelKey.delete(stalestKey);
    }
  }
  st = {
    epoch: 0,
    lastSeen: now,
    loadedEpoch: false,
    decisions: new Map(),
      summaries: new Map(),
      loadedSummaries: false,
      pendingEstimate: 0,
      lastUsageTotal: null,
      ratio: calibration.get(modelKeyHint(sessionID)) ?? 1,
      requestCount: 0,
      replanCount: 0,
      window: null,
      budget: null,
      target: null,
      inputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      compressible: [],
      summariesCount: 0,
      summarySavedTokens: 0,
      savedTokensTotal: 0,
      inputCost: 0,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
      lastGate: 0,
      lastReplan: null,
      lastReplanShort: 0,
      autoSummarizeCalls: 0,
      autoSummarizing: false,
      recoveryTarget: null,
      overflowRetries: 0,
      modelRef: "",
      recall: new Map(),
      loadedRecall: false,
      recallDirty: false,
      lastNudgeRequest: -1000,
      iterationsSinceCompress: 0,
      lastToolCallTotal: 0,
      lastInputTotal: null,
      lastCacheReadTotal: null,
      lastCacheWriteTotal: null,
      nudges: 0,
      textProtectedFrom: -1,
      turnProtectedFrom: -1,
      collapseSpans: 0,
      collapseMessages: 0,
      collapseSavedTokens: 0,
      pendingNotes: [],
    };
    sessions.set(sessionID, st);
    // C18: epoch/decisions reload lazily (fire-and-forget, like summaries) —
    // a restarted or evicted session resumes its epoch instead of repruning.
    loadEpochInto(sessionID, st);
  return st;
}

/**
 * C18: epoch/decisions store. Module-level because `stateFor` is module
 * scope; `setup()` registers the ctx.storage-backed implementation, tests
 * inject a fake. Eviction flushes through here, making it lossless.
 */
type EpochSnapshot = { epoch: number; decisions: Decision[] };
const MAX_EPOCH_DECISIONS = 200;
let seenClock = 0;
let epochStore: {
  load: (sessionID: string) => Promise<EpochSnapshot | undefined>;
  save: (sessionID: string, snapshot: EpochSnapshot) => void;
} | null = null;

function sanitizeDecision(raw: unknown): Decision | null {
  if (!isPlainObject(raw) || typeof raw.key !== "string") return null;
  return {
    key: raw.key,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    origChars: num(raw.origChars),
    savedChars: num(raw.savedChars),
    savedTokens: num(raw.savedTokens),
  };
}

function sanitizeEpochSnapshot(raw: unknown): EpochSnapshot | undefined {
  if (!isPlainObject(raw)) return undefined;
  const epoch = num(raw.epoch);
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.map(sanitizeDecision).filter((d): d is Decision => d !== null).slice(-MAX_EPOCH_DECISIONS)
    : [];
  return { epoch: Number.isFinite(epoch) ? Math.max(0, Math.floor(epoch)) : 0, decisions };
}

function flushEpoch(sessionID: string, st: SessionState): void {
  if (!epochStore) return;
  try {
    epochStore.save(sessionID, {
      epoch: st.epoch,
      decisions: [...st.decisions.values()].slice(-MAX_EPOCH_DECISIONS),
    });
  } catch {
    /* ignore — epoch persistence is best-effort */
  }
}

function loadEpochInto(sessionID: string, st: SessionState): void {
  if (!epochStore || st.loadedEpoch) return;
  st.loadedEpoch = true;
  void epochStore
    .load(sessionID)
    .then((snap) => {
      try {
        if (!snap || sessions.get(sessionID) !== st) return;
        const clean = sanitizeEpochSnapshot(snap);
        if (!clean) return;
        st.epoch = clean.epoch;
        for (const d of clean.decisions) st.decisions.set(d.key, d);
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
}

/** Test seam for C18 (session-state bounds + epoch persistence). */
export const __test__ = {
  stateFor,
  sessionCount: (): number => sessions.size,
  hasSession: (sessionID: string): boolean => sessions.has(sessionID),
  resetSessions: (): void => {
    sessions.clear();
    sessionModelKey.clear();
  },
  setEpochStore: (store: typeof epochStore): void => {
    epochStore = store;
  },
  sanitizeLabel,
  summaryCacheKey,
  // CP-1..CP-11 verification seams.
  resolveConfig,
  guardedSet,
  valueToText,
  statelessTest,
  compilePatterns,
  isProtected,
  writeUnit,
  budgetFor,
  makeStub,
  stubMemoSize: (): number => stubMemo.size,
  clearStubMemo: (): void => {
    stubMemo.clear();
  },
  setModelKey: (sid: string, key: string): void => {
    sessionModelKey.set(sid, key);
  },
  hasModelKey: (sid: string): boolean => sessionModelKey.has(sid),
  latestTopic,
  topicLedger,
};

/** Calibration is keyed per model string when the context hook has seen one. */

function modelKeyHint(sessionID: string): string {
  return sessionModelKey.get(sessionID) ?? "";
}

function modelKey(model: ModelInfo | undefined, ref: AnyRecord | undefined): string {
  if (model?.providerID && model?.id) return `${model.providerID}/${model.id}`;
  const pid = ref?.providerID ?? ref?.provider;
  const id = ref?.modelID ?? ref?.id ?? ref?.model;
  if (typeof pid === "string" && typeof id === "string") return `${pid}/${id}`;
  return "";
}

function coveredKeys(st: SessionState): Set<string> {
  const set = new Set<string>();
  for (const record of st.summaries.values()) for (const key of record.covers) set.add(key);
  return set;
}

function summarySavings(results: CollectedResult[], st: SessionState, cfg: Config, ratio: number): { saved: number; applied: number; tokens: number } {
  let saved = 0;
  let applied = 0;
  let tokens = 0;
  const byKey = new Map(results.map((r) => [r.key, r]));
  for (const record of st.summaries.values()) {
    const present = record.covers.filter((key) => byKey.has(key));
    if (present.length === 0) continue;
    const orig = present.reduce((sum, key) => sum + (byKey.get(key)?.tokens ?? 0), 0);
    const sumTokens = estimateTokens(record.text, cfg, ratio);
    saved += Math.max(0, orig - sumTokens);
    applied += present.length;
    tokens += sumTokens;
  }
  return { saved, applied, tokens };
}

// ----------------------------------------------------------------------------
// planner

function planDecisions(
  results: CollectedResult[],
  candidates: CollectedResult[],
  cfg: Config,
  ratio: number,
  budget: { target: number; overhead: number; pool?: CollectedResult[] } | null,
): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  const add = (r: CollectedResult, reason: string): Decision => {
    const existing = decisions.get(r.key);
    if (existing) return existing;
    const { savedChars, savedTokens } = makeStub(r, reason, cfg, ratio);
    const d: Decision = { key: r.key, reason, origChars: r.text.length, savedChars, savedTokens };
    decisions.set(r.key, d);
    return d;
  };

  const autoPrune = !cfg.manualMode.enabled || cfg.manualMode.automaticStrategies;

  if (autoPrune && cfg.superseded) {
    const candidateKeys = new Set(candidates.map((c) => c.key));
    const newestByPath = new Map<string, number>();
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      // C4: an errored read is not an authority — never let it supersede a
      // good earlier read of the same path.
      if (r.error) continue;
      const path = filePathOf(r);
      const key = path ? pathKey(path) : "";
      if (key && !newestByPath.has(key)) newestByPath.set(key, i);
    }
    for (let i = 0; i < results.length; i++) {
      const path = filePathOf(results[i]);
      if (!path || !candidateKeys.has(results[i].key)) continue;
      const newest = newestByPath.get(pathKey(path));
      if (newest !== undefined && newest > i) add(results[i], `superseded by a newer read/write of ${path}`);
    }
  }

  if (autoPrune && cfg.dedupe) {
    const candidateKeys = new Set(candidates.map((c) => c.key));
    // Two outputs are duplicates when the same tool returned the same text.
    const newestByHash = new Map<number, string>();
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if (r.kind !== "tool") continue;
      const h = hash32(`${r.name}\u0000${r.text}`);
      if (!newestByHash.has(h)) {
        newestByHash.set(h, r.key);
        continue;
      }
      if (candidateKeys.has(r.key)) add(r, "duplicate of newer output");
    }
  }

  if (autoPrune && cfg.dedupe) {
    const candidateKeys = new Set(candidates.map((c) => c.key));
    // Same tool + same normalised arguments, newest call wins (DCP's
    // `deduplication` strategy). Unlike exact-text dedupe this also drops a
    // re-read whose output changed.
    const newestBySignature = new Map<string, number>();
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      // C4: an errored call is not an authority over an earlier good read.
      if (r.error) continue;
      const signature = toolSignature(r);
      if (!signature || newestBySignature.has(signature)) continue;
      newestBySignature.set(signature, i);
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.kind !== "tool" || !candidateKeys.has(r.key)) continue;
      const signature = toolSignature(r);
      const newest = signature ? newestBySignature.get(signature) : undefined;
      if (newest !== undefined && newest > i) add(r, `superseded by a newer ${r.name} call with the same arguments`);
    }
  }

  if (autoPrune && cfg.purgeErrors && !cfg.keepErrors) {
    for (const r of candidates) if (r.error) add(r, "stale error output");
  }

  const remaining = candidates.filter((r) => !decisions.has(r.key)).sort((a, b) => b.tokens - a.tokens);

  if (!autoPrune) return decisions;

  if (budget) {
    // Over budget, the pool may reach below the voluntary floor: small stale
    // outputs are still worth dropping when the window is tight.
    const pool = (budget.pool ?? candidates)
      .filter((r) => !decisions.has(r.key))
      .sort((a, b) => b.tokens - a.tokens);
    let projected = budget.overhead;
    for (const r of results) projected += r.tokens;
    for (const d of decisions.values()) projected -= d.savedTokens;
    for (const r of pool) {
      if (projected <= budget.target) break;
      const d = add(r, "over budget");
      projected -= d.savedTokens;
    }
  } else {
    for (const r of remaining) add(r, "stale tool output");
  }

  return decisions;
}

function applyDecisions(
  results: CollectedResult[],
  decisions: Map<string, Decision>,
  cfg: Config,
  ratio: number,
  covered: Set<string>,
  st: SessionState,
): { count: number; savedChars: number; savedTokens: number } {
  let count = 0;
  let savedChars = 0;
  let savedTokens = 0;
  for (const r of results) {
    const d = decisions.get(r.key);
    if (!d) continue;
    if (covered.has(r.key) || isPrunedStub(r.text)) continue;
    const recall = rememberOutput(st, r, cfg);
    const { stub, savedChars: sc, savedTokens: stk } = makeStub(r, d.reason, cfg, ratio, recall);
    // A pruned result is always rewritten as text-with-array-value so the
    // model request can send it (core maps over result.value as an array).
    writeUnit(r, stub);
    d.savedChars = sc;
    d.savedTokens = stk;
    count++;
    savedChars += sc;
    savedTokens += stk;
  }
  return { count, savedChars, savedTokens };
}

type SpanCollapse = {
  /** Maximal runs of messages reduced to the digests they already carry. */
  spans: number;
  /** Messages removed from the outgoing array. */
  messages: number;
  /** Parts removed from messages that survive. */
  parts: number;
  /** Characters the outgoing request no longer carries. */
  savedChars: number;
  savedTokens: number;
};

/**
 * Whole-span collapse — the outgoing-request equivalent of a model-driven range
 * compression, derived locally and for free.
 *
 * Stubbing rewrites a value but leaves every part on the wire: the message
 * shell, the per-unit JSON scaffolding, the sibling `tool-call` with its
 * arguments, and a pointer for each folded unit. Once a closed run of messages
 * is *fully represented* in an applied summary (a digest or one of its
 * pointers), the run can be reduced to the digest parts it already carries and
 * the rest of the run dropped — including the tool-call parts. That structural
 * residual is exactly the "on-disk ceiling" measured in
 * `docs/CONTEXT-COMPILER-ONDISK.md`, recovered here with no disk write at all.
 *
 * Safety rules, all conservative:
 *  - the live turn (`turnProtectedFrom`) is never touched;
 *  - every part of a run must be represented by a summary (or, with
 *    `collapseStubs`, by a stub); an uncovered error, a small stale output,
 *    unsummarised prose or an unknown part type blocks the whole run;
 *  - a tool-call and its result are dropped together or kept together, so
 *    invariant #2 holds and no request loses a result it still references;
 *  - protected tools, ignored tools and protected file patterns are never
 *    dropped, and every failure path leaves the array exactly as it was.
 */
function collapseSpans(
  messages: MessageLike[],
  results: CollectedResult[],
  st: SessionState,
  cfg: Config,
  ratio: number,
): SpanCollapse {
  const none: SpanCollapse = { spans: 0, messages: 0, parts: 0, savedChars: 0, savedTokens: 0 };
  if (!cfg.collapseRanges || messages.length === 0) return none;
  const live = st.turnProtectedFrom;

  const unitAt = new Map<string, CollectedResult>();
  for (const r of results) unitAt.set(`${r.mi}:${r.pi}`, r);

  const callOwner = new Map<string, number>();
  const resultOwner = new Map<string, number>();
  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const id = part?.id ?? part?.toolCallId;
      if (!id) continue;
      if (part.type === "tool-call") callOwner.set(String(id), mi);
      else if (isToolResult(part)) resultOwner.set(String(id), mi);
    }
  }

  /**
   * How a part stands on the wire right now: `digest` (a summary body, which
   * must survive), `pointer` (a unit folded into a digest), `stub` (retained
   * head plus recall hint), or `raw` (untouched — nothing stands in for it, so
   * it blocks its run).
   */
  const statusOf = (mi: number, pi: number, part: PartLike): "digest" | "pointer" | "stub" | "raw" => {
    const unit = unitAt.get(`${mi}:${pi}`);
    if (!unit) return "raw";
    if (unit.kind === "tool" && isProtected(unit, cfg)) return "raw";
    const text = unit.kind === "text" ? String(part.text ?? "") : resultText(part.result);
    if (text.startsWith(SUMMARY_MARK) || text.startsWith(PROSE_SUMMARY_MARK)) return "digest";
    if (text.startsWith(POINTER_MARK)) return "pointer";
    if (isPrunedStub(text)) return "stub";
    return "raw";
  };
  const represented = (status: "digest" | "pointer" | "stub" | "raw"): boolean =>
    status === "digest" || status === "pointer" || (cfg.collapseStubs && status === "stub");

  /** The single part a tool message carries, when it carries exactly one. */
  const answerAt = (index: number): PartLike | undefined => {
    const content = messages[index]?.content;
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    return content[0] ?? undefined;
  };

  // A message is reducible when every part in it is represented. A tool-call
  // counts only when the result answering it is represented too, so the pair is
  // always removed as a unit.
  const reducible: boolean[] = new Array(messages.length).fill(false);
  for (let mi = 0; mi < messages.length; mi++) {
    if (live >= 0 && mi >= live) continue;
    const content = messages[mi]?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    let ok = true;
    for (let pi = 0; pi < content.length && ok; pi++) {
      const part = content[pi] ?? {};
      if (part.type === "tool-call") {
        const id = part.id ?? part.toolCallId;
        const answerMi = id ? resultOwner.get(String(id)) : undefined;
        const answer = answerMi === undefined ? undefined : answerAt(answerMi);
        if (answerMi === undefined || !answer || !represented(statusOf(answerMi, 0, answer))) ok = false;
        continue;
      }
      if (isToolResult(part)) {
        if (!represented(statusOf(mi, pi, part))) ok = false;
        continue;
      }
      if (part.type === "text") {
        if (!represented(statusOf(mi, pi, part))) ok = false;
        continue;
      }
      ok = false; // unknown part type: never dropped blind
    }
    if (ok) reducible[mi] = true;
  }

  // Maximal consecutive runs, pairing-checked before anything is removed.
  const planned = new Map<number, Set<number>>();
  let spans = 0;
  let droppedMessages = 0;
  let droppedParts = 0;
  let index = 0;
  while (index < messages.length) {
    if (!reducible[index]) {
      index++;
      continue;
    }
    let end = index;
    while (end + 1 < messages.length && reducible[end + 1]) end++;
    const inRun = (at: number): boolean => at >= index && at <= end;

    let safe = true;
    let anchors = 0;
    const keep = new Map<number, Set<number>>();
    for (let at = index; at <= end && safe; at++) {
      const content = messages[at]?.content ?? [];
      for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi] ?? {};
        const id = part.id ?? part.toolCallId;
        if (part.type === "tool-call") {
          const answerMi = id ? resultOwner.get(String(id)) : undefined;
          // A call whose result stays outside the run cannot leave alone.
          if (answerMi === undefined || !inRun(answerMi)) {
            safe = false;
            break;
          }
          // Keep the call only when it anchors a digest that survives.
          const answer = answerAt(answerMi);
          if (answer && statusOf(answerMi, 0, answer) === "digest") {
            anchors++;
            keep.set(at, (keep.get(at) ?? new Set<number>()).add(pi));
          }
          continue;
        }
        // A result whose call stays outside the run cannot be removed alone.
        if (isToolResult(part)) {
          const callMi = id ? callOwner.get(String(id)) : undefined;
          if (callMi !== undefined && !inRun(callMi)) {
            safe = false;
            break;
          }
        }
        if (statusOf(at, pi, part) === "digest") {
          anchors++;
          keep.set(at, (keep.get(at) ?? new Set<number>()).add(pi));
        }
      }
    }
    // Skip runs that fail the pairing check, or that carry no digest at all:
    // something the model can read must survive from the span. A run that would
    // keep every part is skipped too, so the counters only report real removals.
    let partsInRun = 0;
    let partsKept = 0;
    for (let at = index; at <= end; at++) {
      partsInRun += (messages[at]?.content ?? []).length;
      partsKept += keep.get(at)?.size ?? 0;
    }
    if (!safe || anchors === 0 || partsKept >= partsInRun) {
      index = end + 1;
      continue;
    }

    spans++;
    for (let at = index; at <= end; at++) {
      const size = (messages[at]?.content ?? []).length;
      const kept = keep.get(at)?.size ?? 0;
      if (kept === 0) droppedMessages++;
      else droppedParts += Math.max(0, size - kept);
      planned.set(at, keep.get(at) ?? new Set<number>());
    }
    index = end + 1;
  }
  if (spans === 0) return none;

  // Measure the request as it stands, then rewrite it in place.
  let before = 0;
  try {
    before = JSON.stringify(messages).length;
  } catch {
    return none; // unserialisable payload: leave the request exactly as it is
  }

  for (const [at, keep] of planned) {
    const content = messages[at]?.content;
    if (!Array.isArray(content) || keep.size === 0) continue;
    const kept: PartLike[] = [];
    for (let pi = 0; pi < content.length; pi++) if (keep.has(pi)) kept.push(content[pi]);
    content.length = 0;
    content.push(...kept);
  }
  // The context hook is in-place, so truncate and refill — the same pattern the
  // host and every mutating plugin use — and every holder sees the compiled
  // request. The transcript on disk is never involved.
  const survivors: MessageLike[] = [];
  for (let at = 0; at < messages.length; at++) {
    const keep = planned.get(at);
    if (keep === undefined || keep.size > 0) survivors.push(messages[at]);
  }
  messages.length = 0;
  messages.push(...survivors);

  let after = before;
  try {
    after = JSON.stringify(messages).length;
  } catch {
    after = before;
  }
  const savedChars = Math.max(0, before - after);
  return {
    spans,
    messages: droppedMessages,
    parts: droppedParts,
    savedChars,
    savedTokens: estimateCharsTokens(savedChars, cfg, ratio),
  };
}

function pointerFor(r: CollectedResult): string {
  if (r.kind === "text") return `${POINTER_MARK} (was ${r.name}, ${r.text.length} chars).`;
  return `${POINTER_MARK} (was "${r.name}", ${r.text.length} chars). Re-run the tool if you need it again.`;
}

/**
 * Drop summaries whose covered results were edited since the summary was
 * written: the model must not read a stale digest of changed output.
 */
function pruneStaleSummaries(st: SessionState, byKey: Map<string, CollectedResult>): number {
  let dropped = 0;
  for (const [key, record] of [...st.summaries]) {
    if (!Array.isArray(record.hashes) || record.hashes.length !== record.covers.length) continue;
    for (let i = 0; i < record.covers.length; i++) {
      const r = byKey.get(record.covers[i]);
      if (!r) continue;
      const h = record.hashes[i];
      if (Number.isFinite(h) && h !== hash32(r.text)) {
        st.summaries.delete(key);
        dropped++;
        break;
      }
    }
  }
  return dropped;
}

function applySummaries(results: CollectedResult[], st: SessionState): number {
  const byKey = new Map(results.map((r) => [r.key, r]));
  let applied = 0;
  for (const record of st.summaries.values()) {
    const present = record.covers.map((key) => byKey.get(key)).filter((r): r is CollectedResult => Boolean(r));
    if (present.length === 0) continue;
    writeUnit(present[0], record.text);
    for (let i = 1; i < present.length; i++) {
      writeUnit(present[i], pointerFor(present[i]));
    }
    applied += present.length;
  }
  return applied;
}

function sentTokens(results: CollectedResult[], overhead: number, decisions: Map<string, Decision>, summarySaved: number): number {
  let total = overhead;
  for (const r of results) {
    const d = decisions.get(r.key);
    total += d ? Math.max(0, r.tokens - d.savedTokens) : r.tokens;
  }
  return Math.max(0, total - summarySaved);
}

// ----------------------------------------------------------------------------
// summarisation

function extractProtected(text: string): { stripped: string; blocks: string[] } {
  const blocks: string[] = [];
  const stripped = text.replace(/<protect>([\s\S]*?)<\/protect>/g, (_match, inner: string) => {
    blocks.push(inner);
    // C10: a fixed NUL sentinel could collide with real content — a stable,
    // distinctive marker also keeps the summary cache key deterministic.
    return `[context-pruner protected #${blocks.length}]`;
  });
  return { stripped, blocks };
}

/**
 * C19: topic/reason are caller-controlled free text that used to flow raw
 * into the summarizer prompt (prompt injection: "ignore previous
 * instructions", fake <material>/<protect> blocks, role prefixes) and into
 * the summary cache key (cache fragmentation from whitespace/case/junk
 * variants). Sanitize once; use the clean value for both prompt and key.
 */
const MAX_LABEL_CHARS = 200;
function sanitizeLabel(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(/[\0-\b\f-\x1f\x7f]+/g, " "); // control chars (keep \t\n for now)
  s = s.replace(/<[^>\n]{0,64}>/g, " "); // tag-like framing: <material>, <protect>, <system>, ...
  s = s.replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|directives?|rules?)\b/gi, " ");
  s = s.replace(/\byou\s+are\s+now\b/gi, " ");
  s = s.replace(/^\s*(system|assistant|user)\s*:\s*/gim, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_LABEL_CHARS) s = s.slice(0, MAX_LABEL_CHARS).trimEnd();
  return s;
}

/**
 * Per-turn auto-prune tally. The context hook hands one to
 * maybeAutoSummarize so the synchronous auto-stub work accumulates into the
 * turn's single digest instead of notifying on its own.
 */
type TurnTally = { stubbed: number; stubSaved: number };

/** Cap for banked receipt fragments (each is one short clause). */
const MAX_PENDING_NOTES = 4;

/**
 * Bank a receipt fragment for the next turn's single digest. Out-of-turn
 * completions (async auto-summarise, compress tool, checkpoint) report here
 * so they never emit a second receipt line for a request.
 */
function bankNote(st: SessionState, note: string): void {
  const text = note.replace(/\s+/g, " ").trim();
  if (!text) return;
  st.pendingNotes.push(text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text);
  while (st.pendingNotes.length > MAX_PENDING_NOTES) st.pendingNotes.shift();
}

/** Most recently created summary topic ("": none). Receipts reuse it. */
function latestTopic(st: SessionState): string {
  let topic = "";
  let at = -Infinity;
  for (const rec of st.summaries.values()) {
    if (rec.topic && rec.at >= at) {
      at = rec.at;
      topic = rec.topic;
    }
  }
  return topic;
}

function summaryCacheKey(topic: string, source: string): string {
  return `summary:${hash32(`${VERSION}\0${sanitizeLabel(topic)}\0${source}`)}`;
}

function summaryPrompt(source: string, topic: string, reason: string, protectedBlocks: string[]): string {
  const focus = topic || "the conversation so far";
  return [
    "You compress part of a coding-agent conversation so it fits in a smaller context window.",
    "Rewrite the material as a dense, factual summary another coding agent can act on.",
    "Keep: file paths, symbol names, commands run, exact values, error messages, and decisions.",
    "Drop: boilerplate, repeated output, and prose that adds no facts.",
    "Do not invent details and do not add commentary. Output only the summary.",
    "",
    `Focus: ${focus}`,
    `Reason: ${reason || "context limit"}`,
    "",
    "<material>",
    source,
    "</material>",
    protectedBlocks.length > 0 ? "\n\nPreserve these protected excerpts verbatim at the end:" : "",
    ...protectedBlocks.map((b) => `<protect>${b}</protect>`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Deterministic digest used when the summariser model cannot be reached: the
 * head of every covered unit plus a pointer, so nothing is lost silently.
 */
function fallbackSummary(units: CollectedResult[]): string {
  const parts = units.map((r) => `- ${r.name} (~${r.tokens} tokens): ${r.text.slice(0, 200).replace(/\s+/g, " ").trim()}`);
  return ["Unavailable to summarise (model call failed); heads of the covered output:", ...parts].join("\n");
}

function buildSummaryText(summaryBody: string, protectedBlocks: string[], prose = false, filePaths?: string[]): string {
  const mark = prose ? PROSE_SUMMARY_MARK : SUMMARY_MARK;
  const fileLine = filePaths && filePaths.length ? `Compressed files: ${filePaths.join(", ")}. ` : "";
  const blocks = protectedBlocks.map((b) => `<protect>${b}</protect>`).join("\n");
  return `${mark} ${fileLine}${summaryBody.trim()}${blocks ? `\n\n${blocks}` : ""}`;
}

// ----------------------------------------------------------------------------
// reporting

function renderStats(): string {
  return [
    "context-pruner (context compiler)",
    "",
    `requests compiled: ${totals.requests}`,
    `tool results pruned: ${totals.pruned}`,
    `stubbed below summary floor: ${totals.stubbed} (~${totals.stubSavedTokens} tokens)`,
    `summaries generated: ${totals.summaries} (model calls: ${totals.generations})`,
    `characters saved: ${totals.savedChars}`,
    `estimated tokens saved: ${totals.savedTokens + totals.summarySavedTokens}`,
    `  · pruning: ${totals.savedTokens}`,
    `  · summaries: ${totals.summarySavedTokens}`,
    `  · of the pruning total, stubs: ${totals.stubSavedTokens}`,
    `nudges sent: ${totals.nudgeCount}`,
    `tracked sessions: ${sessions.size}`,
  ].join("\n");
}

/** Per-token value of a pruned token: fresh input, or the premium over a cache read. */
function effectiveInputPrice(st: SessionState): number {
  if (st.cacheRead > 0 && st.cacheReadPrice > 0) return Math.max(0, st.inputCost - st.cacheReadPrice);
  return st.inputCost;
}

/** Per-topic savings ledger: display-only rollup of the tracked summary records. */
function topicLedger(st: SessionState, cfg: Config): Array<{ topic: string; summaries: number; units: number; saved: number }> {
  if (st.summaries.size === 0) return [];
  const byKey = new Map(st.compressible.map((r) => [r.key, r]));
  const groups = new Map<string, { topic: string; summaries: number; units: number; saved: number }>();
  for (const record of st.summaries.values()) {
    const topic = record.topic || "(general)";
    let group = groups.get(topic);
    if (!group) {
      group = { topic, summaries: 0, units: 0, saved: 0 };
      groups.set(topic, group);
    }
    group.summaries++;
    group.units += record.covers.length;
    const present = record.covers.map((key) => byKey.get(key)).filter((r) => r !== undefined);
    const original = present.reduce((sum, r) => sum + r.tokens, 0);
    group.saved += Math.max(0, original - estimateTokens(record.text, cfg, st.ratio));
  }
  return [...groups.values()].sort((a, b) => b.saved - a.saved);
}

function renderReport(sessionID: string | undefined, cfg: Config): string {
  const st = sessionID ? sessions.get(sessionID) : undefined;
  const lines: string[] = ["context-pruner — context compiler", ""];
  if (!st) {
    lines.push("No request has been compiled for this session yet.");
    lines.push(`tracked sessions: ${sessions.size}`);
    return lines.join("\n");
  }
  const hitRatio = st.inputTokens + st.cacheRead > 0 ? st.cacheRead / (st.inputTokens + st.cacheRead) : 0;
  const window = st.window ?? limitTokens(cfg.maxContextLimit, 0) ?? "unknown";
  lines.push(`requests compiled: ${st.requestCount}`);
  lines.push(`epoch: ${st.epoch} (replans: ${st.replanCount})`);
  lines.push(`window: ${window}  budget: ${st.budget ?? "n/a"}  target: ${st.target ?? "n/a"}`);
  lines.push(`model ref: ${st.modelRef || "(none)"}  models cached: ${modelCacheSize}`);
  lines.push(`checkpoints: ${totals.checkpoints}  overflow recoveries: ${totals.overflowRecoveries}  recalls: ${totals.recalls}`);
  lines.push(`retry state: recover target ${st.recoveryTarget ?? "n/a"}  attempts ${st.overflowRetries}`);
  lines.push(`calibration ratio: ${st.ratio.toFixed(3)}  cache hit: ${(hitRatio * 100).toFixed(1)}%`);
  if (st.inputCost > 0) {
    const effective = effectiveInputPrice(st);
    const basis = st.cacheRead > 0 && st.cacheReadPrice > 0 ? "input − cache read" : "input tokens";
    lines.push(
      `estimated cost saved: $${(st.savedTokensTotal * effective).toFixed(4)} (at $${(effective * 1_000_000).toFixed(2)}/M ${basis})`,
    );
    if (st.cacheRead > 0 && st.cacheReadPrice > 0 && st.inputCost > st.cacheReadPrice) {
      lines.push(
        `cache savings: $${(st.cacheRead * (st.inputCost - st.cacheReadPrice)).toFixed(4)} (${st.cacheRead} cached tokens vs input price)`,
      );
    }
  }
  lines.push(`prompt tokens: ${st.inputTokens}  cache read: ${st.cacheRead}  cache write: ${st.cacheWrite}`);
  if (st.cacheRead > 0 || st.cacheWrite > 0) {
    const short = st.lastReplan === "deferred" && st.lastReplanShort > 0 ? ` (short ${Math.ceil(st.lastReplanShort)})` : "";
    lines.push(
      `cache economics: ${cfg.cacheAware ? "on" : "off"}  replan gate: ${st.lastGate} tok  last replan: ${st.lastReplan ?? "n/a"}${short}`,
    );
  }
  lines.push(`active prune decisions: ${st.decisions.size}`);
  const proseSummaries = [...st.summaries.values()].filter((r) => r.prose).length;
  lines.push(
    `active summaries: ${st.summaries.size} (covering ${coveredKeys(st).size} units, ~${st.summarySavedTokens} tokens saved${proseSummaries ? `, ${proseSummaries} prose` : ""})`,
  );
  const ledger = topicLedger(st, cfg);
  if (ledger.length > 0) {
    lines.push("savings by topic:");
    for (const row of ledger) {
      lines.push(`  · ${row.topic} — ${row.summaries} summaries, ${row.units} units, ~${row.saved} tokens saved`);
    }
  }
  lines.push(`nudges sent: ${st.nudges}  tool calls since last summary: ${st.iterationsSinceCompress}`);
  lines.push(
    `span collapse: ${cfg.collapseRanges ? "on" : "off"}${cfg.collapseStubs ? "+stubs" : ""}  last request: ${st.collapseSpans} span(s), ${st.collapseMessages} message(s), ~${st.collapseSavedTokens} tokens`,
  );
  lines.push(`mode: ${cfg.manualMode.enabled ? "manual" : "automatic"}  turnProtection: ${cfg.turnProtection.enabled ? `${cfg.turnProtection.turns} turns` : "off"}`);
  lines.push(
    `hooks: compaction=${cfg.compactionCheckpoint ? "on" : "off"} retry=${cfg.retryOnOverflow ? "on" : "off"} title=${cfg.titleShortCircuit ? "on" : "off"} recall=${cfg.recall ? "on" : "off"}`,
  );
  if (cfg.configPath) lines.push(`config file: ${cfg.configPath}`);
  if (st.decisions.size > 0) {
    for (const d of st.decisions.values()) {
      lines.push(`  · ${d.key} — ${d.reason} (~${d.savedTokens} tokens)`);
    }
  }
  lines.push("");
  lines.push(renderStats());
  return lines.join("\n");
}

function renderContextMap(st: SessionState, cfg: Config, limit = 50): string {
  const list = st.compressible;
  if (list.length === 0) return "No compressible context recorded yet.";
  const textProtected = protectedTextKeys(list, st, cfg);
  const lines = ["compressible context (oldest first):"];
  // C11: the map is embedded in nudges — an unbounded listing would eat the
  // very context it is trying to save.
  const shown = list.slice(0, Math.max(1, limit));
  shown.forEach((r, index) => {
    const protectedFlag = isProtected(r, cfg) || textProtected.has(r.key) ? " [protected]" : "";
    const preview = r.text.slice(0, 80).replace(/\s+/g, " ");
    lines.push(`#${index + 1} ${r.name} ~${r.tokens} tokens${protectedFlag} — ${preview}`);
  });
  if (list.length > shown.length) {
    lines.push(`… and ${list.length - shown.length} more (call context_map for the full list).`);
  }
  lines.push("");
  lines.push("Call `compress` with from/to (#N or a message id), before, after, or last to summarise a range.");
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// plugin

export default Plugin.define({
  id: "context-pruner",

  async setup(ctx) {
    const c = ctx as unknown as LooseCtx;
    let cfg = resolveConfig(c.location?.directory, c.options);
    if (!cfg.enabled) {
      // Keep the plugin file loadable for easy re-enabling, but do not register
      // any hooks, tools, or background work while explicitly disabled.
      return async () => {};
    }
    refreshModels(c);
    const disposers: Array<() => void | Promise<void>> = [];
    const track = (registration: unknown): void => {
      if (registration && typeof (registration as { dispose?: unknown }).dispose === "function") {
        disposers.push(() => (registration as { dispose: () => void | Promise<void> }).dispose());
      } else if (typeof registration === "function") {
        disposers.push(registration as () => void);
      }
    };
    const log = (message: string): void => {
      if (!cfg.log && !cfg.debug) return;
      try {
        console.error(`[context-pruner] ${message}`);
      } catch {
        /* ignore */
      }
    };
    const debug = (message: string): void => {
      if (!cfg.debug) return;
      try {
        const dir = join(homedir(), ".config", "opencode", "logs", "context-pruner");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${message}\n`);
      } catch {
        /* ignore */
      }
    };

    // Config hot reload: opencode only re-reads a plugin when its file changes,
    // so watch the config files and re-resolve in place when one is edited.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadConfig = (): void => {
      reloadTimer = undefined;
      try {
        cfg = resolveConfig(c.location?.directory, c.options);
        log("config reloaded");
        debug(`config reloaded from ${cfg.configPath ?? "(defaults)"}`);
      } catch (err) {
        debug(`config reload failed: ${String(err)}`);
      }
    };
    const scheduleReload = (): void => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadConfig, 250);
    };
    const watchedConfigs: Array<{ path: string; listener: () => void }> = [];
    for (const configPath of configCandidatePaths(c.location?.directory)) {
      if (!existsSync(configPath)) continue;
      try {
        watchFile(configPath, { interval: 1000 }, scheduleReload);
        watchedConfigs.push({ path: configPath, listener: scheduleReload });
      } catch {
        /* ignore */
      }
    }

    const readStore = async (key: string): Promise<unknown> => {
      try {
        const value = c.storage?.get ? await c.storage.get(key) : undefined;
        return value;
      } catch {
        return undefined;
      }
    };
    // CP-1: storage writes are best-effort — a rejecting store must never
    // surface as an unhandled rejection.
    const writeStore = (key: string, value: unknown): void => {
      guardedSet(c.storage, key, value);
    };
    // CP-2: per-session persist chain — serializes recall read-modify-write
    // so overlapping flushes cannot clobber each other.
    const persistChains = new Map<string, Promise<void>>();
    // CP-8: memoize the per-request JSON.stringify(event.tools).
    let lastToolsRef: unknown;
    let lastToolsJson = "{}";

    const notify = (sessionID: string, summaryLine: string, detail: string): void => {
      if (cfg.notify === "off") return;
      // Minimal stays a single line; detailed is that line plus the detail.
      const text = cfg.notify === "minimal" ? summaryLine : `${summaryLine}\n${detail}`;
      if (cfg.notifyType === "chat") {
        try {
          // CP-1: guarded so a rejecting session sink cannot escape.
          Promise.resolve(c.session?.synthetic?.({ sessionID, text: `[context-pruner] ${text}`, description: "context-pruner", delivery: "queue" })).catch(() => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
      } else {
        try {
          console.error(`[context-pruner] ${text}`);
        } catch {
          /* ignore */
        }
      }
    };

    const loadSummaries = async (sessionID: string, st: SessionState): Promise<void> => {
      if (st.loadedSummaries) return;
      st.loadedSummaries = true;
      const raw = await readStore(`summaries:${sessionID}`);
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (!isPlainObject(entry)) continue;
        const covers = asList(entry.covers);
        const text = typeof entry.text === "string" ? entry.text : "";
        if (covers.length === 0 || !text) continue;
        st.summaries.set(covers[0], {
          first: covers[0],
          covers,
          hashes: Array.isArray(entry.hashes) ? entry.hashes.map((h) => num(h)) : [],
          text,
          tokens: num(entry.tokens),
          topic: typeof entry.topic === "string" ? entry.topic : "",
          at: num(entry.at),
        });
      }
    };

    // C18: epoch/decisions survive eviction and restarts through ctx.storage
    // (same best-effort pattern as summaries/recall). stateFor() flushes on
    // eviction and reloads lazily on creation via this registration.
    epochStore = {
      save: (sid, snap) => writeStore(`epoch:${sid}`, { ...snap, at: Date.now() }),
      load: async (sid) => sanitizeEpochSnapshot(await readStore(`epoch:${sid}`)),
    };

    const persistSummaries = (sessionID: string, st: SessionState): void => {
      if (cfg.summaryKeep > 0) {
        while (st.summaries.size > cfg.summaryKeep) {
          let oldestKey: string | undefined;
          let oldestAt = Infinity;
          for (const [key, rec] of st.summaries) {
            if (rec.at < oldestAt) {
              oldestAt = rec.at;
              oldestKey = key;
            }
          }
          if (oldestKey === undefined) break;
          st.summaries.delete(oldestKey);
        }
      }
      writeStore(`summaries:${sessionID}`, [...st.summaries.values()]);
    };

    const loadRecall = async (sessionID: string, st: SessionState): Promise<void> => {
      if (st.loadedRecall) return;
      st.loadedRecall = true;
      const raw = await readStore(`recall:${sessionID}`);
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (!isPlainObject(entry)) continue;
        const id = typeof entry.id === "string" ? entry.id : "";
        const text = typeof entry.text === "string" ? entry.text : "";
        if (!id || !text) continue;
        st.recall.set(id, {
          tool: typeof entry.tool === "string" ? entry.tool : "",
          text,
          chars: num(entry.chars, text.length),
          at: num(entry.at),
        });
      }
      evictRecall(st, cfg.recallKeep);
    };

    /** Flush newly pruned outputs, merging anything already persisted first. */
    const persistRecall = (sessionID: string, st: SessionState): void => {
      if (!st.recallDirty) return;
      // CP-2: chain onto the session's pending persist so an in-flight
      // read-modify-write finishes before the next one starts.
      const tail = persistChains.get(sessionID) ?? Promise.resolve();
      const head = tail
        .then(() => loadRecall(sessionID, st))
        .then(() => {
          writeStore(`recall:${sessionID}`, [...st.recall.entries()].map(([id, entry]) => ({ id, ...entry })));
          st.recallDirty = false;
        })
        .catch(() => {
          /* CP-1: ignore */
        });
      persistChains.set(sessionID, head);
      void head.then(() => {
        if (persistChains.get(sessionID) === head) persistChains.delete(sessionID);
      }).catch(() => {});
    };

    /**
     * Guaranteed token relief: when the projected request exceeds the target,
     * summarise the largest compressible results immediately instead of waiting
     * for the model to act on a nudge. Runs at most `autoSummarizeMaxCalls`
     * model calls per session (cache hits are free), covers at most
     * `maxAutoSummaries` units per request (largest first; 0 = unlimited),
     * and the summary is applied on the next request.
     * Default budget is 5 calls; 0 opts out into unlimited.
     */
    async function maybeAutoSummarize(sessionID: string, st: SessionState, estimate: number, turn?: TurnTally): Promise<void> {
      if (!cfg.autoSummarize || !cfg.compressEnabled || st.autoSummarizing) return;
      // 0 = opt-out unlimited; default 5 bounds `session.generate` spend on stuck sessions.
      if (cfg.autoSummarizeMaxCalls > 0 && st.autoSummarizeCalls >= cfg.autoSummarizeMaxCalls) return;
      if (st.target === null || estimate <= st.target) return;
      const session = c.session;

      const covered = coveredKeys(st);
      const textProtected = protectedTextKeys(st.compressible, st, cfg);
      const pool = st.compressible
        .filter(
          (r) =>
            !covered.has(r.key) &&
            !isProtected(r, cfg) &&
            !textProtected.has(r.key) &&
            !(st.turnProtectedFrom >= 0 && r.mi >= st.turnProtectedFrom) &&
            !isPrunedStub(r.text) &&
            // C16: prose gets a lower floor than tool output.
            r.text.length >= minCharsFor(r, cfg),
        )
        .sort((a, b) => b.tokens - a.tokens);
      if (pool.length === 0) return;

      const shortfall = estimate - st.target;
      const chosen: CollectedResult[] = [];
      let sum = 0;
      // Per-request cap: the pool is sorted by tokens desc, so this keeps the
      // top-N biggest wins. 0 = unlimited (no count cap).
      const cap = cfg.maxAutoSummaries > 0 ? cfg.maxAutoSummaries : pool.length;
      for (const r of pool) {
        if (chosen.length > 0 && sum >= shortfall) break;
        chosen.push(r);
        sum += r.tokens;
        if (chosen.length >= cap) break;
      }

      // Present the summary at the earliest covered unit so the model reads it
      // before the pointers that fold into it.
      chosen.sort((a, b) => a.mi - b.mi || a.pi - b.pi);

      // Model calls are finite; below the floor a stub is still worth more than
      // a nudge the model may ignore. Only the window passing
      // `autoSummarizeRatio` of the limit justifies the call.
      const window = st.window ?? 0;
      const critical =
        cfg.proactiveSummarize ||
        cfg.autoSummarizeRatio <= 0.1 ||
        (window > 0 && estimate >= Math.floor(window * cfg.autoSummarizeRatio));
      if (sum < cfg.autoSummarizeMinTokens) {
        if (cfg.autoSummarizeStub && st.pendingEstimate > st.target) {
          const autoPlan = planDecisions(st.compressible, chosen, cfg, st.ratio, null);
          // C6: persist the ad-hoc stub decisions into the current epoch —
          // recomputing them every request let them flip-flop and broke the
          // byte-identical prompt prefix the provider cache relies on.
          for (const [k, v] of autoPlan) st.decisions.set(k, v);
          flushEpoch(sessionID, st);
          const appliedStubs = applyDecisions(st.compressible, autoPlan, cfg, st.ratio, covered, st);
          if (appliedStubs.count > 0) {
            const savedStubs = appliedStubs.savedTokens;
            totals.savedTokens += savedStubs;
            totals.stubbed += appliedStubs.count;
            totals.stubSavedTokens += savedStubs;
            st.savedTokensTotal += savedStubs;
            st.iterationsSinceCompress = 0;
            // Folded into the turn's single digest (or banked when there is
            // no turn to attach to) — never a receipt of its own.
            if (turn) {
              turn.stubbed += appliedStubs.count;
              turn.stubSaved += savedStubs;
            } else {
              bankNote(st, `stubbed ${appliedStubs.count} result(s), ~${savedStubs} tokens saved`);
            }
            debug(`auto-stub applied for ${sessionID}: ${appliedStubs.count} results, ~${savedStubs} tokens`);
          }
        }
        return;
      }
      if (!critical) return;
      if (typeof session?.generate !== "function") return;

      st.autoSummarizing = true;
      try {
        const raw = chosen.map((r) => `### ${r.name}\n${r.text}`).join("\n\n");
        let blocks: string[] = [];
        let source = raw;
        if (cfg.protectTags) {
          const extracted = extractProtected(raw);
          source = extracted.stripped;
          blocks = extracted.blocks;
        }
        if (source.length > cfg.compressMaxSourceChars) source = `${source.slice(0, cfg.compressMaxSourceChars)}\n\n[truncated]`;

        const cacheKey = `summary:${hash32(`${VERSION}\u0000auto\u0000${source}`)}`;
        let body: string | undefined;
        const cached = await readStore(cacheKey);
        if (isPlainObject(cached) && typeof cached.text === "string" && cached.text) body = cached.text;
        if (!body) {
          // Cache misses spend the session model-call budget; cache hits are
          // free so repeat requests covering the same units don't re-spend.
          st.autoSummarizeCalls++;
          if (cfg.autoSummarizeMaxCalls > 0 && st.autoSummarizeCalls > cfg.autoSummarizeMaxCalls) return;
          const prompt = summaryPrompt(source, "what future work needs", "context budget", blocks);
          try {
            const response = await session.generate({ sessionID, prompt });
            body = generatedText(response);
          } catch {
            body = "";
          }
          // The model call may fail or return nothing (local models are flaky);
          // fall back to a deterministic digest so the relief is still real.
          if (!body && cfg.autoSummarizeStub) body = fallbackSummary(chosen);
          if (!body) return;
          totals.generations++;
          writeStore(cacheKey, { text: body, topic: "auto", version: VERSION, at: Date.now() });
        }

        const prose = chosen.every((r) => r.kind === "text");
        const compressedPaths = chosen.map((r) => filePathOf(r)).filter(Boolean) as string[];
        const text = buildSummaryText(body, blocks, prose, compressedPaths);
        const tokens = estimateTokens(text, cfg, st.ratio);
        const covers = chosen.map((r) => r.key);
        for (const [key, existing] of [...st.summaries]) {
          if (existing.covers.every((cover) => covers.includes(cover))) st.summaries.delete(key);
        }
        st.summaries.set(covers[0], { first: covers[0], covers, hashes: coverHashes(chosen), text, tokens, topic: "auto", at: Date.now(), prose });
        for (const key of covers) st.decisions.delete(key);
        persistSummaries(sessionID, st);

        const saved = Math.max(0, chosen.reduce((acc, r) => acc + r.tokens, 0) - tokens);
        totals.summaries++;
        totals.summarySavedTokens += saved;
        st.iterationsSinceCompress = 0;
        // Banked for the next turn's single digest: this completion lands
        // after the triggering turn already flushed its receipt.
        bankNote(st, `auto-summarised ${chosen.length} result(s), ~${saved} tokens saved`);
        debug(`auto-summarise applied for ${sessionID}: ${chosen.length} results, ~${saved} tokens`);
      } catch (err) {
        debug(`auto-summarise failed: ${String(err)}`);
      } finally {
        st.autoSummarizing = false;
      }
    }

    // ---------------------------------------------------------------- context
    if (typeof c.session?.hook === "function") {
      try {
          track(
            await c.session.hook("context", (event) => {
          try {
            if (!cfg.enabled) return;
            const sessionID = String((event as AnyRecord).sessionID ?? "unknown");
            const st = stateFor(sessionID);
            const ref = (event as AnyRecord).model as AnyRecord | undefined;
            // C14: a cold model cache made budget resolution fail for every
            // request until the async model list landed — refresh on first use.
            if ((modelCaches.get(c as object) ?? []).length === 0) refreshModels(c);
            const model = resolveModel(c, ref);
            st.modelRef = `${String(ref?.providerID ?? ref?.provider ?? "?")}/${String(ref?.id ?? ref?.modelID ?? "?")}`;
            const mKey = modelKey(model, ref);
            if (mKey && !calibration.has(mKey)) {
              calibration.set(mKey, st.ratio);
              try {
                void readStore(`calibration:${mKey}`).then((value) => {
                  const r = num((value as AnyRecord | undefined)?.r, 0);
                  if (r > 0 && Number.isFinite(r)) {
                    calibration.set(mKey, r);
                    st.ratio = r;
                  }
                }).catch(() => {
                  /* CP-1: ignore */
                });
              } catch {
                /* ignore */
              }
            }
            if (mKey) sessionModelKey.set(sessionID, mKey);
            if (!st.loadedSummaries) void loadSummaries(sessionID, st).catch(() => {});

            const ratio = st.ratio;
            const messages = ((event as AnyRecord).messages ?? []) as MessageLike[];
            const results = collectResults(messages, cfg, ratio);
            st.compressible = results;
            const protectTurns = Math.max(cfg.keepRecentTurns, cfg.turnProtection.enabled ? cfg.turnProtection.turns : 0);
            st.textProtectedFrom = protectedFromIndex(messages, protectTurns);
            // The live turn (everything at or after the newest user message) is
            // never summarised: the model needs the tool output it just received.
            st.turnProtectedFrom = protectedFromIndex(messages, 1);
            // Integrity: a summary whose source output changed is dropped, so its
            // results can be summarised again (or pruned by another strategy).
            const byKey = new Map(results.map((r) => [r.key, r]));
            const droppedSummaries = pruneStaleSummaries(st, byKey);
            if (droppedSummaries > 0) {
              persistSummaries(sessionID, st);
              debug(`dropped ${droppedSummaries} stale summary record(s) for ${sessionID}`);
            }
            const covered = coveredKeys(st);
            const budget = budgetFor(model, cfg);
            if (budget) {
              st.window = budget.window;
              st.budget = budget.budget;
              st.target = budget.target;
            }
            const inputPrice = num(model?.cost?.[0]?.input);
            if (inputPrice > 0) st.inputCost = inputPrice / 1_000_000;
            const cacheReadPrice = num(model?.cost?.[0]?.cache?.read);
            if (cacheReadPrice > 0) st.cacheReadPrice = cacheReadPrice / 1_000_000;
            const cacheWritePrice = num(model?.cost?.[0]?.cache?.write);
            if (cacheWritePrice > 0) st.cacheWritePrice = cacheWritePrice / 1_000_000;

            // Overflow recovery: after a context-limit retry, aim well under the
            // normal budget. The halved target persists across turns until the
            // compiled request actually fits, then it is cleared.
            const recovering = st.recoveryTarget !== null && st.budget !== null;
            let effectiveTarget = recovering ? st.recoveryTarget : budget?.target ?? null;
            // Proactive steady state: aim well under the window so closed topics
            // are summarised before the request ever approaches the limit.
            const steady =
              cfg.proactiveSummarize && cfg.steadyTargetRatio > 0 && st.window
                ? Math.max(cfg.steadyTargetMinTokens, Math.floor(st.window * cfg.steadyTargetRatio))
                : null;
            if (steady !== null) effectiveTarget = effectiveTarget === null ? steady : Math.min(effectiveTarget, steady);
            if (effectiveTarget !== null) st.target = effectiveTarget;

            // CP-8: `event.tools` rarely changes between requests — reuse the
            // last serialization when the reference is identical.
            const eventTools = (event as AnyRecord).tools;
            if (eventTools !== lastToolsRef) {
              try {
                lastToolsJson = JSON.stringify(eventTools ?? {});
              } catch {
                lastToolsJson = "{}";
              }
              lastToolsRef = eventTools;
            }
            const overhead =
              estimateTokens(systemTextOf(event as AnyRecord), cfg, ratio) +
              estimateTokens(lastToolsJson, cfg, ratio) +
              messages.length * 4;

            const candidates = candidateResults(results, messages, cfg, covered, cfg.minChars, undefined, st.turnProtectedFrom);
            const budgetPool =
              budget && cfg.budgetMinChars < cfg.minChars
                ? candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, undefined, st.turnProtectedFrom)
                : candidates;
            const target = effectiveTarget ?? budget?.target ?? null;
            // Over target, the recency ring-fence is the first thing to give:
            // small stale results below the floor come next. Recent outputs are
            // touched only when the voluntary pool cannot reach the target, and
            // a small set of hottest outputs is always kept so the live turn
            // never loses its most recent context entirely.
            let desired = planDecisions(results, candidates, cfg, ratio, budget && target !== null ? { target, overhead, pool: budgetPool } : null);
            const planWith = (pool: CollectedResult[] | undefined) =>
              planDecisions(results, candidates, cfg, ratio, budget && target !== null ? { target, overhead, pool } : null);
            const projectedNow = (pool: CollectedResult[] | undefined) => sentTokens(results, overhead, planWith(pool), 0);
            if (budget && target !== null && projectedNow(budgetPool) > target) {
              // The hottest outputs survive every relaxation stage: even when the
              // recency ring-fence gives way, the live turn never loses its most
              // recent context entirely. With relaxRecentFloor 0 this is a no-op.
              const hottest =
                cfg.relaxRecentFloor > 0
                  ? new Set(
                      results
                        .slice(Math.max(0, results.length - cfg.relaxRecentFloor))
                        .filter((r) => r.kind === "tool")
                        .map((r) => r.key),
                    )
                  : new Set<string>();
              const keepHottest = (pool: CollectedResult[]) => pool.filter((r) => !hottest.has(r.key));
              const relaxed = keepHottest(
                candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, {
                  recent: true,
                  turns: cfg.turnProtection.enabled,
                }, st.turnProtectedFrom),
              );
              const relaxedPlan = planWith(relaxed);
              if (sumSaved(relaxedPlan) > sumSaved(desired)) desired = relaxedPlan;
              const deep = keepHottest(
                candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, { recent: true, turns: true }, st.turnProtectedFrom),
              );
              const deepPlan = planWith(deep);
              if (sumSaved(deepPlan) > sumSaved(desired)) desired = deepPlan;
            }

            let decisions = desired;
            const desiredSavings = sumSaved(desired);
            const currentSavings = sumSaved(st.decisions);
            const overTarget = effectiveTarget !== null && sentTokens(results, overhead, st.decisions, 0) > effectiveTarget;
            const gate = overTarget || recovering ? 0 : cacheReplanGate(st, cfg);
            // Over budget or recovering, don't let the voluntary replan floor
            // defer savings we need right now.
            const threshold = overTarget || recovering ? 0 : Math.max(cfg.minReplanTokens, gate);
            st.lastGate = Math.ceil(threshold);
            if (st.decisions.size > 0 && !recovering && desiredSavings - currentSavings < threshold) {
              decisions = st.decisions;
              st.lastReplan = "deferred";
              st.lastReplanShort = Math.max(0, threshold - (desiredSavings - currentSavings));
              debug(`replan deferred for ${sessionID}: gate ${Math.ceil(threshold)}, short ${Math.ceil(st.lastReplanShort)}`);
            } else {
              st.decisions = desired;
              st.epoch++;
              st.replanCount++;
              flushEpoch(sessionID, st);
              st.lastReplan = "allowed";
              st.lastReplanShort = 0;
            }

            // Summarise from the raw (pre-stub) size: stubbing alone can meet a
            // low steady target, but a digest of the stubbed units is smaller
            // still. The record is stored now and applied on the next request.
            const rawEstimate = sentTokens(results, overhead, new Map(), 0);
            // Single-digest receipts: auto-stub counts accumulate into this
            // turn's receipt instead of notifying separately; async
            // completions bank a note for the next turn's digest.
            const turnAuto: TurnTally = { stubbed: 0, stubSaved: 0 };
            if (!cfg.manualMode.enabled) void maybeAutoSummarize(sessionID, st, rawEstimate, turnAuto).catch(() => {});

            const summaryApplied = applySummaries(results, st);
            const applied = applyDecisions(results, decisions, cfg, ratio, covered, st);
            // Whole-span collapse runs last: the digests and stubs it reads are
            // already written, so a closed run that is fully represented loses
            // its message shells, per-unit scaffolding and tool-call arguments.
            const collapsed = collapseSpans(messages, results, st, cfg, ratio);
            st.collapseSpans = collapsed.spans;
            st.collapseMessages = collapsed.messages;
            st.collapseSavedTokens = collapsed.savedTokens;
            if (collapsed.spans > 0) {
              totals.collapsedSpans += collapsed.spans;
              totals.collapsedMessages += collapsed.messages;
              totals.collapsedTokens += collapsed.savedTokens;
              debug(
                `span collapse for ${sessionID}: ${collapsed.spans} span(s), ${collapsed.messages} message(s), ${collapsed.parts} part(s), ~${collapsed.savedTokens} tokens`,
              );
            }
            persistRecall(sessionID, st);
            const stats = summarySavings(results, st, cfg, ratio);
            st.summariesCount = st.summaries.size;
            st.summarySavedTokens = stats.saved;

            st.requestCount++;
            // C3: cadence counts ACTUAL tool calls seen this request — it used
            // to count pruned results, so nudges never fired in low-prune
            // sessions and fired constantly in heavy ones.
            const toolCallsNow = countToolCalls(messages);
            st.iterationsSinceCompress += Math.max(0, toolCallsNow - st.lastToolCallTotal);
            st.lastToolCallTotal = toolCallsNow;
            st.pendingEstimate = Math.max(
              0,
              sentTokens(results, overhead, decisions, stats.saved) - collapsed.savedTokens,
            );
            if (st.recoveryTarget !== null && st.pendingEstimate <= st.recoveryTarget) {
              st.recoveryTarget = null;
              st.overflowRetries = 0;
              debug(`overflow recovery complete for ${sessionID}`);
            }
            totals.requests++;
            totals.pruned += applied.count;
            totals.savedChars += applied.savedChars;
            totals.savedTokens += applied.savedTokens;
            // C5: standing summary savings live in summarySavedTokens (set
            // above) — adding them here again double-counted them on every
            // subsequent request.
            st.savedTokensTotal += applied.savedTokens + collapsed.savedTokens;

            // One receipt per turn: prune, stub, summary, collapse and any
            // banked notes share a single digest through notify().
            const banked = st.pendingNotes.length > 0 ? [...st.pendingNotes] : [];
            if ((applied.count > 0 || summaryApplied > 0 || collapsed.spans > 0 || turnAuto.stubbed > 0 || banked.length > 0) && cfg.notify !== "off") {
              const saved = applied.savedTokens + stats.saved + collapsed.savedTokens + turnAuto.stubSaved;
              const sessionTotal = st.savedTokensTotal + st.summarySavedTokens;
              const topic = latestTopic(st);
              // Throttled receipt: meaningful saves always report; a freshly
              // applied summary — or a banked note from an async/manual
              // summarise or checkpoint — reports too so nothing is lost.
              if (saved >= cfg.notifyMinTokens || (summaryApplied > 0 && cfg.notifyOnTopic) || (banked.length > 0 && cfg.notifyOnTopic)) {
                st.pendingNotes.length = 0;
                const receipt = `saved ~${saved} tokens this turn · ~${sessionTotal} session total${topic ? ` · topic: ${topic}` : ""}${banked.length > 0 ? ` · ${banked.join(" · ")}` : ""}`;
                notify(
                  sessionID,
                  `pruned ${applied.count} result(s)${summaryApplied ? `, ${summaryApplied} summarised` : ""}${turnAuto.stubbed > 0 ? `, ${turnAuto.stubbed} stubbed` : ""}${collapsed.spans > 0 ? `, ${collapsed.messages} message(s) collapsed` : ""} — ${receipt} (epoch ${st.epoch})`,
                  `epoch ${st.epoch}: pruned ${applied.count}/${results.length}, summaries ${st.summaries.size}, ${receipt}` +
                  (collapsed.spans > 0
                    ? `\n  span collapse: ${collapsed.spans} span(s), ${collapsed.messages} message(s), ~${collapsed.savedTokens} tokens`
                    : "") +
                  (applied.count > 0
                    ? `\n  reasons: ${[...new Set([...decisions.values()].map((d) => d.reason))].join(", ")}`
                    : ""),
              );
              }
            }

            // nudges -------------------------------------------------------
            if (cfg.nudgeEnabled && !cfg.manualMode.enabled && cfg.compressEnabled) {
              const window = st.window ?? limitTokens(cfg.maxContextLimit, 0) ?? 0;
              if (window > 0) {
                const minLimit = limitTokens(cfg.minContextLimit, window) ?? Math.floor(window * 0.5);
                const overLimit = st.pendingEstimate >= minLimit;
                const dueByFrequency = st.requestCount - st.lastNudgeRequest >= cfg.nudgeFrequency;
                const dueByCalls = st.iterationsSinceCompress >= cfg.nudgeCallFrequency;
                const dueByIterations = st.iterationsSinceCompress >= cfg.iterationNudgeThreshold;
                // Nearly full: ask even if the cadence has not come around.
                const critical = st.pendingEstimate >= Math.floor(window * cfg.nudgeCriticalRatio);
                if (overLimit && (dueByFrequency || dueByCalls || dueByIterations || critical)) {
                  st.lastNudgeRequest = st.requestCount;
                  st.nudges++;
                  totals.nudgeCount++;
                  // C11: a critical nudge carries only the top entries — the
                  // full map would itself eat the context it is trying to save.
                  const map = renderContextMap(st, cfg, critical ? 10 : 25);
                  const force = cfg.nudgeForce === "strong" ? "You should compress now." : "Consider compressing.";
                  const nudge = [
                    `[context-pruner] Context is at ~${st.pendingEstimate} of ~${window} tokens.`,
                    `${force} Use the \`compress\` tool to summarise older tool output.`,
                    "",
                    map,
                  ].join("\n");
                  try {
                    // CP-1: guarded so a rejecting session sink cannot escape.
                    Promise.resolve(c.session?.synthetic?.({ sessionID, text: nudge, description: "context-pruner nudge", delivery: "queue" })).catch(() => {
                      /* ignore */
                    });
                  } catch {
                    /* ignore */
                  }
                  st.iterationsSinceCompress = 0;
                }
              }
            }

            if (cfg.log) {
              log(
                `epoch ${st.epoch}: pruned ${applied.count}/${results.length}, summaries ${st.summaries.size}, ~${applied.savedTokens + stats.saved} tokens (sent ~${st.pendingEstimate}, target ${st.target ?? "n/a"})`,
              );
            }
          } catch (err) {
            debug(`context hook failed: ${String(err)}`);
          }
            }),
          );
        } catch (err) {
          // A failed registration must not take down the host session. Leave
          // context untouched and expose a safe diagnostic for debugging.
          log(`context hook registration failed; continuing without pruning: ${String(err)}`);
          debug(`context hook registration failed: ${String(err)}`);
        }
    }

    // ----------------------------------------------------------------- usage
    if (typeof c.event?.subscribe === "function") {
      const onUsage = (event: AnyRecord): void => {
        try {
          if (event?.type !== "session.usage.updated") return;
          const data = (event.data ?? {}) as AnyRecord;
          const sessionID = String(data.sessionID ?? "unknown");
          const st = stateFor(sessionID);
          const tokens = (data.tokens ?? {}) as AnyRecord;
          const input = num(tokens.input);
          const cache = (tokens.cache ?? {}) as AnyRecord;
          const cacheRead = num(cache.read);
          const cacheWrite = num(cache.write);
          const total = input + cacheRead + cacheWrite;

          if (st.pendingEstimate > 0 && st.lastUsageTotal !== null) {
            const delta = total - st.lastUsageTotal;
            if (delta > 0) {
              const observed = delta / st.pendingEstimate;
              if (observed > 0.05 && observed < 20) {
                st.ratio = st.ratio === 1 ? observed : st.ratio * 0.7 + observed * 0.3;
                const mKey = sessionModelKey.get(sessionID);
                if (mKey) {
                  // C7: cap the calibration map (FIFO eviction of old models).
                  if (calibration.size >= 256 && !calibration.has(mKey)) {
                    const oldestKey = calibration.keys().next();
                    if (!oldestKey.done) calibration.delete(oldestKey.value);
                  }
                  calibration.set(mKey, st.ratio);
                  writeStore(`calibration:${mKey}`, { r: st.ratio, updatedAt: Date.now() });
                }
              }
            }
          }
          st.lastUsageTotal = total;
          // C1: these totals are CUMULATIVE per session — accumulate only the
          // per-field deltas. Treating them as per-event increments corrupted
          // the cache-hit ratio, the cost-saved estimate and the cache-replan
          // gate (every event re-added the session's whole lifetime input).
          // A null baseline means "first sighting": the whole total is new.
          st.inputTokens += Math.max(0, input - (st.lastInputTotal ?? 0));
          st.cacheRead += Math.max(0, cacheRead - (st.lastCacheReadTotal ?? 0));
          st.cacheWrite += Math.max(0, cacheWrite - (st.lastCacheWriteTotal ?? 0));
          st.lastInputTotal = input;
          st.lastCacheReadTotal = cacheRead;
          st.lastCacheWriteTotal = cacheWrite;
          st.pendingEstimate = 0;
          // A request that reached usage accounting succeeded: clear overflow state.
          st.overflowRetries = 0;
          st.recoveryTarget = null;
        } catch (err) {
          debug(`usage event failed: ${String(err)}`);
        }
      };
      // The promise API's `event.subscribe` returns an async iterable (the
      // callback form is effect-domain only), so drive every shape. Note the
      // test double calls subscribe WITHOUT the callback — pass it only when
      // the function declares a parameter.
      try {
        const subscribe = c.event.subscribe as (...args: unknown[]) => unknown;
        const stream = subscribe.length > 0 ? subscribe(onUsage) : (subscribe as () => unknown)();
        if (stream && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          void (async () => {
            try {
              for await (const event of stream as AsyncIterable<AnyRecord>) onUsage(event);
            } catch {
              /* stream closed */
            }
          })().catch(() => {});
        } else if (typeof stream === "function") {
          track(stream as () => void | Promise<void>);
        } else if (stream && typeof (stream as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(stream)
            .then((registration) => {
              const dispose = (registration as { dispose?: () => unknown } | undefined)?.dispose;
              if (typeof dispose === "function") track(() => dispose());
            })
            .catch(() => {});
        } else if (stream && typeof (stream as { dispose?: unknown }).dispose === "function") {
          const dispose = (stream as { dispose: () => unknown }).dispose;
          track(() => dispose());
        }
      } catch {
        /* ignore */
      }
    }

    // ------------------------------------------------------------------ tools
    if (typeof c.tool?.transform === "function") {
      track(
        await c.tool.transform((editor) => {
          editor.add({
            name: "context_pruner_stats",
            description: "Show what context-pruner trimmed and the active configuration.",
            input: z.object({}),
            execute: async () => {
              try {
                return { content: renderStats() };
              } catch (err) {
                return { content: `context_pruner_stats failed: ${String(err)}` };
              }
            },
          });

          editor.add({
            name: "context_report",
            description:
              "Detailed context-compiler report: token budget, epoch, cache hit ratio, active prune decisions and summaries.",
            input: z.object({
              sessionID: z.string().optional().describe("Session to report on (defaults to the caller's session)"),
            }),
            execute: async (input, toolCtx) => {
              try {
                const args = (input ?? {}) as { sessionID?: string };
                // C12: default to the CALLING session, not "whichever
                // session happened to compile last".
                const callerSid = String((toolCtx as { sessionID?: string })?.sessionID ?? "");
                const sessionID = args.sessionID ?? (callerSid || undefined);
                return { content: renderReport(sessionID, cfg) };
              } catch (err) {
                return { content: `context_report failed: ${String(err)}` };
              }
            },
          });

          editor.add({
            name: "context_map",
            description:
              "List the compressible tool output in this session (oldest first, with stable #N references) before calling `compress`.",
            input: z.object({
              sessionID: z.string().optional().describe("Session to map (defaults to the caller's session)"),
            }),
            execute: async (input, toolCtx) => {
              try {
                const args = (input ?? {}) as { sessionID?: string };
                // C12: default to the CALLING session — the old
                // "[...sessions.keys()].pop()" guess picked whichever session
                // happened to compile last.
                const callerSid = String((toolCtx as { sessionID?: string })?.sessionID ?? "");
                const sessionID = args.sessionID ?? callerSid;
                const st = sessions.get(sessionID);
                if (!st) return { content: "No request has been compiled for this session yet." };
                return { content: renderContextMap(st, cfg, st.compressible.length) };
              } catch (err) {
                return { content: `context_map failed: ${String(err)}` };
              }
            },
          });

          editor.add({
            name: "context_pruner_recall",
            description:
              "Return the full output of a tool result that context-pruner replaced with a stub, instead of re-running the tool.",
            input: z.object({
              id: z.string().describe("The id shown in the pruned-output stub"),
            }),
            execute: async (input, toolCtx) => {
              try {
                const args = (input ?? {}) as { id?: string };
                const id = String(args.id ?? "").trim();
                if (!id) return { content: "context_pruner_recall requires an id." };
                // C17: recall is scoped to the calling session — ids are 32-bit
                // hashes, and scanning every session leaked other sessions'
                // tool output. Without a caller id (very old runtimes) fall
                // back to the previous scan.
                const callerSid = String((toolCtx as { sessionID?: string })?.sessionID ?? "");
                const order = callerSid ? [callerSid] : [...sessions.keys()];
                for (const sid of order) {
                  const st = sessions.get(sid) ?? (callerSid && sid === callerSid ? stateFor(sid) : undefined);
                  if (!st) continue;
                  if (!st.loadedRecall) await loadRecall(sid, st);
                  const hit = st.recall.get(id);
                  if (!hit) continue;
                  totals.recalls++;
                  const text =
                    hit.text.length > cfg.recallMaxChars
                      ? `${hit.text.slice(0, cfg.recallMaxChars)}\n\n[context-pruner] recall truncated at ${cfg.recallMaxChars} of ${hit.chars} chars.`
                      : hit.text;
                  return { content: text };
                }
                return { content: `No stored output for id "${id}". It may have been evicted or produced in another process.` };
              } catch (err) {
                return { content: `context_pruner_recall failed: ${String(err)}` };
              }
            },
          });

          editor.add({
            name: "compress",
            description:
              "Replace a chosen range of older tool output with a real summary produced by the session model. " +
              "Ranges: `last` (the N most recent tool outputs), `from`/`to` (inclusive, using #N from context_map or a message id), " +
              "`before`/`after`. Always give a `topic` describing what future work must retain. " +
              "Run context_map first to see what is available. Protected tools and `<protect>` blocks are never summarised.",
            input: z.object({
              topic: z.string().optional().describe("What the summary must preserve (files, symbols, decisions)"),
              reason: z.string().optional().describe("Why you are compressing now"),
              from: z.union([z.string(), z.number()]).optional().describe("#N or message id — start of the range"),
              to: z.union([z.string(), z.number()]).optional().describe("#N or message id — end of the range (inclusive)"),
              before: z.union([z.string(), z.number()]).optional().describe("Compress everything before this #N or message id"),
              after: z.union([z.string(), z.number()]).optional().describe("Compress everything after this #N or message id"),
              last: z.number().int().optional().describe("Compress the N most recent tool outputs"),
            }),
            execute: async (input, context) => {
              try {
                return await runCompress(input, context);
              } catch (err) {
                return { content: `compress failed: ${String(err)}` };
              }
            },
          });
        }),
      );
    }

    // --------------------------------------------------------------- commands
    if (typeof c.command?.transform === "function") {
      track(
        await c.command.transform((editor) => {
          editor.add({
            name: "context",
            description: "Report the current context-compiler budget, epoch, summaries and prune decisions.",
            execute: async (input) => {
              const text = renderReport(input?.sessionID, cfg);
              try {
                await c.session?.synthetic?.({ sessionID: input?.sessionID, text, description: "context report" });
              } catch {
                log(text);
              }
            },
          });

          editor.add({
            name: "compress",
            description: "Ask the model to compress older context with the current focus.",
            execute: async (input) => {
              const focus = typeof input?.prompt === "string" ? input.prompt : "";
              const text = [
                "[context-pruner] The user requested a context compression pass.",
                focus ? `Focus: ${focus}` : "",
                "Call `context_map` if needed, then call `compress` with a topic and a range (last/from/to/before/after).",
              ]
                .filter(Boolean)
                .join("\n");
              try {
                await c.session?.synthetic?.({ sessionID: input?.sessionID, text, description: "compress request", delivery: "queue" });
              } catch {
                log(text);
              }
            },
          });
        }),
      );
    }

    // --- compress tool implementation (closure over ctx/st) ------------------
    async function findTargets(
      args: { from?: unknown; to?: unknown; before?: unknown; after?: unknown; last?: unknown },
      list: CollectedResult[],
    ): Promise<CollectedResult[]> {
      const resolveIndex = (ref: unknown): number => {
        if (typeof ref === "number" && Number.isFinite(ref)) return Math.floor(ref) - 1;
        if (typeof ref === "string") {
          const text = ref.trim();
          const numbered = text.match(/^#?(\d+)$/);
          if (numbered) return Number(numbered[1]) - 1;
          const idx = list.findIndex((r) => r.key === text || r.part.id === text || r.part.toolCallId === text);
          if (idx >= 0) return idx;
        }
        return -1;
      };

      if (typeof args.last === "number" && Number.isFinite(args.last)) {
        return list.slice(Math.max(0, list.length - Math.floor(args.last)));
      }
      if (args.before !== undefined) {
        const i = resolveIndex(args.before);
        // C9: `list.slice(0, 0)` is the same `[]` as the `i === -1` arm —
        // the third ternary branch was dead.
        return i >= 0 ? list.slice(0, i) : [];
      }
      if (args.after !== undefined) {
        const i = resolveIndex(args.after);
        return i >= 0 ? list.slice(i + 1) : [];
      }
      if (args.from !== undefined) {
        const a = resolveIndex(args.from);
        const b = args.to !== undefined ? resolveIndex(args.to) : a;
        if (a >= 0 && b >= a) return list.slice(a, b + 1);
        return [];
      }
      if (args.to !== undefined) {
        const b = resolveIndex(args.to);
        return b >= 0 ? list.slice(0, b + 1) : [];
      }
      return [];
    }

    async function runCompress(input: unknown, callContext: unknown): Promise<{ content: string }> {
      if (!cfg.compressEnabled) return { content: "compress is disabled by configuration." };
      const args = (input ?? {}) as AnyRecord;
      const caller = (callContext ?? {}) as AnyRecord;
      const sessionID = String(caller.sessionID ?? [...sessions.keys()].pop() ?? "unknown");
      const st = sessions.get(sessionID);
      if (!st) return { content: "Nothing has been compiled for this session yet; call context_map first." };

      const list = st.compressible;
      if (list.length === 0) return { content: "No compressible context is available yet." };

      const textProtected = protectedTextKeys(list, st, cfg);
      let targets = await findTargets(args, list);
      targets = targets.filter(
        (r) =>
          !isProtected(r, cfg) &&
          !textProtected.has(r.key) &&
          r.text.length >= Math.min(cfg.minChars, 200) &&
          !isPrunedStub(r.text),
      );
      if (targets.length === 0) {
        return {
          content:
            "No compressible results matched. Use context_map to list available #N ranges; protected tools, tiny results, and recent prose cannot be compressed.",
        };
      }
      if (targets.length > 40) targets = targets.slice(0, 40);

      const topic = sanitizeLabel(args.topic);
      const reason = sanitizeLabel(args.reason) || "context limit";

      const rawSource = targets.map((r) => `### ${r.name}\n${r.text}`).join("\n\n");
      let protectedBlocks: string[] = [];
      let source = rawSource;
      if (cfg.protectTags) {
        const extracted = extractProtected(rawSource);
        source = extracted.stripped;
        protectedBlocks = extracted.blocks;
      }
      if (source.length > cfg.compressMaxSourceChars) {
        source = `${source.slice(0, cfg.compressMaxSourceChars)}\n\n[truncated]`;
      }

      const cacheKey = summaryCacheKey(topic, source);
      let body: string | undefined;
      const cached = await readStore(cacheKey);
      if (isPlainObject(cached) && typeof cached.text === "string" && cached.text) {
        body = cached.text;
        debug(`summary cache hit for ${targets.length} result(s)`);
      }

      const session = c.session;
      if (!body) {
        if (typeof session?.generate !== "function") {
          return { content: "The session model is unavailable, so compress cannot generate a summary right now." };
        }
        const prompt = summaryPrompt(source, topic, reason, protectedBlocks);
        const response = await session.generate({ sessionID, prompt });
        body = generatedText(response);
        if (!body) {
          debug(`compress generate returned empty (${isPlainObject(response) ? Object.keys(response).join(",") : typeof response})`);
          return { content: "The model returned an empty summary; nothing was compressed." };
        }
        totals.generations++;
        writeStore(cacheKey, { text: body, topic, version: VERSION, at: Date.now() });
      }

      const prose = targets.every((r) => r.kind === "text");
      const compressedPaths = targets.map((r) => filePathOf(r)).filter(Boolean) as string[];
      const text = buildSummaryText(body, protectedBlocks, prose, compressedPaths);
      const covers = targets.map((r) => r.key);
      const record: SummaryRecord = {
        first: covers[0],
        covers,
        hashes: coverHashes(targets),
        text,
        tokens: estimateTokens(text, cfg, st.ratio),
        topic,
        at: Date.now(),
        prose,
      };
      // Nested compression: drop any previous record fully contained here.
      for (const [key, existing] of [...st.summaries]) {
        if (existing.covers.every((cover) => covers.includes(cover))) st.summaries.delete(key);
      }
      st.summaries.set(covers[0], record);
      for (const key of covers) st.decisions.delete(key);
      persistSummaries(sessionID, st);

      const savedTokens = Math.max(0, targets.reduce((sum, r) => sum + r.tokens, 0) - record.tokens);
      totals.summaries++;
      totals.summarySavedTokens += savedTokens;
      st.iterationsSinceCompress = 0;

      // Banked for the next turn's single digest: the digest names the
      // summary and its topic when it applies the record.
      bankNote(st, `compress: ${targets.length} result(s) → ${record.tokens} tokens (saved ~${savedTokens})`);

      return {
        content: [
          `Summarised ${targets.length} tool result(s) (~${savedTokens} tokens saved).`,
          `The summary is applied on the next request; the covered output is replaced by it.`,
          topic ? `Focus preserved: ${topic}` : "",
          protectedBlocks.length > 0 ? `Kept ${protectedBlocks.length} protected block(s) verbatim.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    // ------------------------------------------------------------- tier 4
    // Native wins DCP cannot do: fill the compaction checkpoint ourselves,
    // recover from context-limit retries, and short-circuit title generation.
    if (typeof c.session?.hook === "function") {
      track(
        await c.session.hook("compaction", (event) => {
          try {
            if (!cfg.enabled || !cfg.compactionCheckpoint) return;
            const record = event as AnyRecord;
            const sessionID = String(record.sessionID ?? "unknown");
            const summary = buildCheckpoint((record.messages ?? []) as MessageLike[]);
            // No model request runs for a checkpoint, but opencode still reads
            // result.tokens as a full TokenUsage.Info (input/output/reasoning and
            // cache.read/write). A bare number crashes compaction on `cache.read`.
            record.result = { summary, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
            totals.checkpoints++;
            // Banked for the next turn's single digest, not a receipt of its own.
            bankNote(stateFor(sessionID), `checkpoint written (${summary.length} chars)`);
            debug(`checkpoint for ${sessionID}: ${summary.length} chars`);
          } catch (err) {
            debug(`compaction hook failed: ${String(err)}`);
          }
        }),
      );

      track(
        await c.session.hook("retry", (event) => {
          try {
            if (!cfg.enabled || !cfg.retryOnOverflow) return;
            const record = event as AnyRecord;
            if (!isOverflowError(errorText(record.error))) return;
            const attempt = num(record.attempt, 0);
            const sessionID = String(record.sessionID ?? "unknown");
            if (attempt >= cfg.retryMaxAttempts) {
              record.decision = { retry: false };
              debug(`overflow retry exhausted for ${sessionID}`);
              return;
            }
            const st = stateFor(sessionID);
            if (st.budget !== null) {
              const reduced = Math.max(1, Math.floor(st.budget * cfg.recoveryRatio));
              st.recoveryTarget = st.recoveryTarget === null ? reduced : Math.min(st.recoveryTarget, reduced);
            }
            st.overflowRetries++;
            totals.overflowRecoveries++;
            const delay = Math.min(2000, 250 * Math.max(1, attempt));
            record.decision = { retry: true, delay };
            notify(sessionID, "context overflow - trimming harder and retrying", `overflow: retry ${attempt + 1} in ${delay}ms`);
            debug(`overflow retry for ${sessionID} attempt ${attempt + 1} (delay ${delay}ms, target ${st.recoveryTarget ?? "n/a"})`);
          } catch (err) {
            debug(`retry hook failed: ${String(err)}`);
          }
        }),
      );

      track(
        await c.session.hook("title", (event) => {
          try {
            if (!cfg.enabled || !cfg.titleShortCircuit) return;
            const record = event as AnyRecord;
            const title = deriveTitle((record.messages ?? []) as MessageLike[]);
            if (title) record.result = title;
          } catch (err) {
            debug(`title hook failed: ${String(err)}`);
          }
        }),
      );
    }

    log(
      `ready (budgetRatio=${cfg.budgetRatio}, targetRatio=${cfg.targetRatio}, keepRecent=${cfg.keepRecent}, relaxRecentFloor=${cfg.relaxRecentFloor}, minReplanTokens=${cfg.minReplanTokens}, compress=${cfg.compressEnabled ? "range" : "off"}${cfg.compressEnabled && cfg.compressText ? "+text" : ""}, collapse=${cfg.collapseRanges ? (cfg.collapseStubs ? "stubs" : "on") : "off"}${cfg.configPath ? `, config=${cfg.configPath}` : ""})`,
    );
    debug("context-pruner initialised");

    return async () => {
      for (const watched of watchedConfigs) {
        try {
          unwatchFile(watched.path, watched.listener);
        } catch {
          /* ignore */
        }
      }
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          /* ignore */
        }
      }
    };
  },
});
