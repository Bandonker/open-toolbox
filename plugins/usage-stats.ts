import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, statSync } from "fs";
import { spawn } from "node:child_process";
import { openDatabase, applyPragmas, type AnyDatabase } from "../lib/sqlite.ts";
import {
  fmtUsd,
  fmtUsdOrDash,
  fmtRate,
  fmtInt,
  fmtCompact,
  fmtShortUsd,
  fmtShortUsdOrDash,
} from "../lib/format.ts";
import { envStr, asBool, asInt } from "../lib/config.ts";

/**
 * usage-stats
 *
 * Lifetime token / dollar / tool accounting plus a browser dashboard.
 *
 * Data sources:
 *   - `session.usage.updated` carries the session's CUMULATIVE totals. We keep
 *     the last cumulative per session (persisted in `session_state`) and
 *     attribute only the positive delta to the session's current model.
 *   - `session.usage.recorded` is an additive one-off ("title" / "compaction").
 *     It is tracked separately in `sources` and the `daily.bg_*` columns — this
 *     is the hidden spend most tools miss.
 *   - `session.model.selected` records the current model per session so deltas
 *     land on the right model.
 *   - `session.created` counts sessions.
 *   - tool `execute.before` / `execute.after` hooks count calls, outcomes and
 *     durations per tool.
 *
 * The dashboard is a self-contained HTML file (inline SVG/CSS and a small
 * inline model-filter script; no CDN or external assets) written to
 * `<dir>/dashboard.html`. There is no way to open a browser
 * from a plugin, so tools return the path for the user to open.
 */

const DB_NAME = "stats.db";
const DASHBOARD_NAME = "dashboard.html";

/**
 * US-7/TA-6: upper bound on remembered swept call ids (see `sweptPending`).
 * Generous compared to `pending`, because overflowing only costs us the
 * old "drop a very late after" behaviour — never a wrong duration.
 */
const PENDING_SWEEP_ID_CAP = 10_000;

type HeatMetric = "tokens" | "cost" | "calls";

type Config = {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  heatmapMetric: HeatMetric;
  heatmapWeeks: number;
  includeBackground: boolean;
  autoRefreshSec: number;
  pricingRefreshMin: number;
  prices: unknown;
  openOnStart: boolean;
  log: boolean;
};

/**
 * Per-setup mutable state (US-1). This used to live in module-level
 * `let`/`const` bindings, so two concurrent setups shared one sqlite
 * handle (opened for whichever dir came first) plus one pricing map,
 * one in-flight map, and one model-attribution map. Each `setup()`
 * now creates its own `UsageState` and threads it through the helpers.
 */
interface UsageState {
  db: AnyDatabase | null;
  lastPruneMs: number;
  /** Latest provider/model price list keyed by `providerID/modelID`. */
  pricing: PricingMap;
  /** User-supplied price overrides (win over `pricing`), e.g. for local models. */
  priceOverrides: PricingMap;
  /** Set by every record; the refresh timer regenerates the dashboard while true. */
  dirty: boolean;
  /** Last model we attributed per session, so http.request doesn't rewrite every call. */
  sessionModels: Map<string, { model: string; updatedMs: number }>;
  /** Last US-6 threshold-gated sessionModels sweep (epoch ms). */
  lastSessionModelsSweep: number;
  /**
   * In-flight tool calls keyed by call id, for duration measurement.
   * US-7/TA-6: once a call outlives the pending TTL it is marked
   * `unknownDuration` instead of being dropped, so a late `execute.after`
   * still records the call — with an unknown (null) duration.
   * US-3: the session id is captured at `execute.before` (the after event in
   * some hosts carries no sessionID) so the per-session tool upsert in
   * recordToolCall knows which session to attribute the call to.
   */
  pending: Map<string, { tool: string; startedMs: number; unknownDuration?: boolean; sessionID?: string }>;
  /**
   * US-7/TA-6: call ids evicted from `pending` by the hard-TTL sweep. Their
   * `execute.after` may still arrive hours later, and must NOT be silently
   * dropped — the id is remembered here so the after hook can still record
   * the call, with an unknown (null) duration. Bounded like `pending`, and
   * insertion-ordered so the oldest id is the first to be forgotten.
   */
  sweptPending: Set<string>;
  /** Last US-6 threshold-gated pending sweep (epoch ms). */
  lastPendingSweep: number;
  /** Whether the event subscription pump is currently alive. */
  eventPumpAlive: boolean;
  /** Last pricing fetch attempt (epoch ms) — TTL gate for refreshPricing (E44). */
  lastPricingFetchMs: number;
}

function createState(): UsageState {
  return {
    db: null,
    lastPruneMs: 0,
    pricing: new Map(),
    priceOverrides: new Map(),
    dirty: false,
    sessionModels: new Map(),
    pending: new Map(),
    sweptPending: new Set(),
    lastPendingSweep: 0,
    lastSessionModelsSweep: 0,
    eventPumpAlive: false,
    lastPricingFetchMs: 0,
  };
}

function resolveConfig(options: unknown): Config {
  const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  const dir =
    typeof o.dir === "string" && o.dir
      ? o.dir
      : envStr("OPENCODE_USAGE_STATS_DIR") ?? join(homedir(), ".opencode-plugins", "usage-stats");
  const rawMetric =
    typeof o.heatmapMetric === "string"
      ? o.heatmapMetric
      : envStr("OPENCODE_USAGE_STATS_HEATMAP_METRIC") ?? "tokens";
  const metric = rawMetric.toLowerCase();
  const heatmapMetric: HeatMetric = metric === "cost" || metric === "calls" ? metric : "tokens";
  return {
    enabled: asBool(o.enabled, asBool(envStr("OPENCODE_USAGE_STATS_ENABLED"), true)),
    dir,
    retentionDays: Math.max(
      0,
      asInt(o.retentionDays, asInt(envStr("OPENCODE_USAGE_STATS_RETENTION_DAYS"), 0)),
    ),
    heatmapMetric,
    heatmapWeeks: Math.min(
      Math.max(asInt(o.heatmapWeeks, asInt(envStr("OPENCODE_USAGE_STATS_HEATMAP_WEEKS"), 26)), 1),
      104,
    ),
    includeBackground: asBool(
      o.includeBackground,
      asBool(envStr("OPENCODE_USAGE_STATS_INCLUDE_BACKGROUND"), true),
    ),
    autoRefreshSec: Math.max(
      0,
      asInt(o.autoRefreshSec, asInt(envStr("OPENCODE_USAGE_STATS_AUTO_REFRESH"), 20)),
    ),
    pricingRefreshMin: Math.max(
      0,
      asInt(o.pricingRefreshMin, asInt(envStr("OPENCODE_USAGE_STATS_PRICING_REFRESH_MIN"), 10)),
    ),
    prices: o.prices ?? envStr("OPENCODE_USAGE_STATS_PRICES"),
    openOnStart: asBool(o.openOnStart, asBool(envStr("OPENCODE_USAGE_STATS_OPEN"), false)),
    log: asBool(o.log, asBool(envStr("OPENCODE_USAGE_STATS_LOG"), false)),
  };
}

function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function shiftDays(d: Date, delta: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + delta);
  return x;
}

function modelKey(model: unknown): string {
  if (!model) return "unknown";
  if (typeof model === "string") return model.trim() || "unknown";
  if (typeof model === "object") {
    const m = model as { providerID?: unknown; id?: unknown; variant?: unknown };
    const provider = typeof m.providerID === "string" ? m.providerID : "";
    const id = typeof m.id === "string" ? m.id : "";
    const base = [provider, id].filter(Boolean).join("/") || "unknown";
    return typeof m.variant === "string" && m.variant ? `${base}#${m.variant}` : base;
  }
  return "unknown";
}

type PriceEntry = {
  tierSize: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type PricingMap = Map<string, PriceEntry[]>;

/** Drop a `#variant` suffix so a model key matches the `providerID/modelID` price key. */
function baseModelKey(model: string): string {
  const hash = model.indexOf("#");
  return hash >= 0 ? model.slice(0, hash) : model;
}

/**
 * Split a stored `providerID/modelID` key into display parts.
 * - provider: text before the first `/`, or "—" when there is none.
 * - name: text after the provider prefix.
 * - effort: text after `#` (variant such as `default`, `medium`, `max`), or "—" when absent.
 */
function splitModelDisplay(model: string): { provider: string; name: string; effort: string } {
  const hash = model.indexOf("#");
  const effort = hash >= 0 ? model.slice(hash + 1).trim() || "—" : "—";
  const base = hash >= 0 ? model.slice(0, hash) : model;
  const slash = base.indexOf("/");
  if (slash < 0) {
    const name = base.trim() || "unknown";
    return { provider: "—", name, effort };
  }
  const provider = base.slice(0, slash).trim() || "—";
  const name = base.slice(slash + 1).trim() || base.trim();
  return { provider, name, effort };
}

/** Pick the greatest tier whose size is <= the request's input tokens, else the untiered entry. */
function selectRate(entries: PriceEntry[], inputTokens: number): PriceEntry | null {
  const untiered = entries.find((e) => e.tierSize === null) ?? null;
  const tiered = entries.filter((e) => e.tierSize !== null);
  if (tiered.length === 0) return untiered;
  let best: PriceEntry | null = null;
  for (const e of tiered) {
    if (e.tierSize !== null && e.tierSize <= inputTokens && (best === null || e.tierSize > (best.tierSize ?? -1))) {
      best = e;
    }
  }
  return best ?? untiered;
}

/**
 * List-price cost in USD for one usage delta, or null when the model price is unknown.
 * Reasoning tokens are billed at the output rate.
 * US-5: the context tier is selected from the request's context size
 * (input + cacheRead + cacheWrite), not the uncached-input delta — cached
 * turns report cache_read separately, so the old basis made tiered
 * ("context over 200k") rates effectively unreachable.
 */
function computedCost(model: string, t: Tokens, state: UsageState): number | null {
  const key = baseModelKey(model);
  // User overrides win over the provider's published rates (e.g. local models).
  const entries = state.priceOverrides.get(key) ?? state.pricing.get(key);
  if (!entries || entries.length === 0) return null;
  const rate = selectRate(entries, t.input + t.cacheRead + t.cacheWrite);
  if (!rate) return null;
  return (
    (t.input * rate.input +
      (t.output + t.reasoning) * rate.output +
      t.cacheRead * rate.cacheRead +
      t.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}

function entryFrom(c: Record<string, unknown>): PriceEntry {
  const cache = (c.cache && typeof c.cache === "object" ? c.cache : {}) as Record<string, unknown>;
  const tier = (c.tier && typeof c.tier === "object" ? c.tier : {}) as Record<string, unknown>;
  return {
    tierSize: typeof tier.size === "number" && Number.isFinite(tier.size) ? tier.size : null,
    input: num(c.input),
    output: num(c.output),
    // The API types use `cache: { read, write }`; the models.dev cache uses
    // flat `cache_read` / `cache_write`. Accept both.
    cacheRead: num(cache.read ?? c.cache_read),
    cacheWrite: num(cache.write ?? c.cache_write),
  };
}

/**
 * US-4: a cost object is priced when it explicitly carries any rate key —
 * an all-zero rate is a real price (free/local models render $0.00), not a
 * missing price. Only entries with *no* rate keys at all count as unpriced.
 */
function hasRateKeys(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  const cache = (c.cache && typeof c.cache === "object" ? c.cache : {}) as Record<string, unknown>;
  return (
    c.input !== undefined ||
    c.output !== undefined ||
    c.cache_read !== undefined ||
    c.cache_write !== undefined ||
    cache.read !== undefined ||
    cache.write !== undefined
  );
}

/**
 * Accept both shapes the model registry can hand us:
 *  - `ModelCost[]` (what the API types declare): `{ tier?, input, output, cache: { read, write } }`
 *  - the models.dev object (what the cache holds): `{ input, output, cache_read, cache_write, tiers, context_over_200k }`
 * US-4: entries whose rate keys are present-but-zero are kept (free models
 * are priced at $0.00); only rate-less entries are dropped.
 */
function readPriceEntries(raw: unknown): PriceEntry[] {
  const kept: PriceEntry[] = [];
  const consider = (item: unknown, forcedTierSize?: number): void => {
    if (!item || typeof item !== "object") return;
    const e = entryFrom(item as Record<string, unknown>);
    const entry = forcedTierSize === undefined ? e : { ...e, tierSize: forcedTierSize };
    if (entry.tierSize !== null || hasRateKeys(item)) kept.push(entry);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) consider(item);
    return kept;
  }
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  consider(o);
  const tiers = Array.isArray(o.tiers) ? o.tiers : [];
  for (const t of tiers) consider(t);
  if (o.context_over_200k && typeof o.context_over_200k === "object") {
    consider(o.context_over_200k, 200_000);
  }
  return kept;
}

/**
 * Parse `OPENCODE_USAGE_STATS_PRICES` / `options.prices`, an object keyed by
 * `providerID/modelID` whose values are a rate object or an array of them (with
 * optional context tiers). Overrides win over the provider's published rates.
 */
function parsePriceOverrides(raw: unknown): PricingMap {
  const out: PricingMap = new Map();
  if (!raw) return out;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const entries = readPriceEntries(Array.isArray(value) ? value : [value]);
    if (entries.length > 0) out.set(key, entries);
  }
  return out;
}

function parseModelList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: Array<Record<string, unknown>> }).data;
  }
  return [];
}

/** Fetch `ctx.model.list()` and rebuild the price map. Failures keep the previous map. */
async function refreshPricing(
  ctx: { model?: unknown },
  log: (message: string) => void,
  state: UsageState,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - state.lastPricingFetchMs < 30_000) return;
  state.lastPricingFetchMs = now;
  try {
    const api = (ctx as { model?: { list?: (input?: unknown) => unknown } }).model;
    if (!api || typeof api.list !== "function") return;
    const list = parseModelList(await api.list());
    const next: PricingMap = new Map();
    for (const m of list) {
      const providerID = typeof m.providerID === "string" ? m.providerID : "";
      const modelID = typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : "";
      if (!providerID || !modelID) continue;
      const entries = readPriceEntries(m.cost);
      if (entries.length === 0) continue;
      next.set(`${providerID}/${modelID}`, entries);
    }
    state.pricing = next;
    log(`pricing loaded for ${next.size} model(s)`);
  } catch (err) {
    log(`pricing refresh failed: ${String(err)}`);
  }
}

// A table cell that shows a shortened display value but keeps the exact
// value in a title tooltip for auditability.
type Cell = string | { text: string; title: string };

function exactCell(display: string, exact: string): Cell {
  return display === exact ? display : { text: display, title: exact };
}

function compactCell(n: number): Cell {
  return exactCell(fmtCompact(n), fmtInt(n));
}

function usdCell(n: number): Cell {
  return exactCell(fmtShortUsd(n), fmtUsd(n));
}

function usdOrDashCell(n: number | null): Cell {
  return n === null ? "—" : usdCell(n);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daily (
      day TEXT PRIMARY KEY,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      cost_computed REAL,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_ok INTEGER NOT NULL DEFAULT 0,
      tool_fail INTEGER NOT NULL DEFAULT 0,
      bg_input INTEGER NOT NULL DEFAULT 0,
      bg_output INTEGER NOT NULL DEFAULT 0,
      bg_reasoning INTEGER NOT NULL DEFAULT 0,
      bg_cache_read INTEGER NOT NULL DEFAULT 0,
      bg_cache_write INTEGER NOT NULL DEFAULT 0,
      bg_cost REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS model_totals (
      model TEXT PRIMARY KEY,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      cost_computed REAL,
      events INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tool_totals (
      tool TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      total_ms INTEGER NOT NULL DEFAULT 0,
      max_ms INTEGER NOT NULL DEFAULT 0,
      timed_calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_models (
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      cost_computed REAL,
      events INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model)
    );
    CREATE TABLE IF NOT EXISTS daily_tools (
      day TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      total_ms INTEGER NOT NULL DEFAULT 0,
      max_ms INTEGER NOT NULL DEFAULT 0,
      timed_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, tool)
    );
    CREATE TABLE IF NOT EXISTS sources (
      source TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      cost_computed REAL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY,
      model TEXT,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    -- US-3: real per-session tool counters, written from recordToolCall.
    -- The old stats_sessions joined session_state.updated_at (a day key) to
    -- the global daily rollup and printed that day's totals as if they were
    -- the session's own. This table is what those columns should have read.
    -- CREATE TABLE IF NOT EXISTS is this plugin's migration mechanism (same
    -- as every other table above): existing databases gain the table on open.
    CREATE TABLE IF NOT EXISTS session_tools (
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0,
      fail INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, tool)
    );
  `);
  for (const statement of [
    "ALTER TABLE daily ADD COLUMN cost_computed REAL",
    "ALTER TABLE model_totals ADD COLUMN cost_computed REAL",
    "ALTER TABLE sources ADD COLUMN cost_computed REAL",
    // US-7/TA-6: number of calls that contributed a duration; avg is
    // total_ms / timed_calls so unknown-duration calls never drag it down.
    "ALTER TABLE tool_totals ADD COLUMN timed_calls INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE daily_tools ADD COLUMN timed_calls INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      database.exec(statement);
    } catch {
      /* column already exists on migrated databases */
    }
  }

  // U2: a lifetime rollup that is never pruned. `daily` is subject to
  // retention, which made the "lifetime" hero cards disagree with the
  // never-pruned model/tool tables. Written in lockstep with `daily`
  // below; rows still inside the retention window are reconciled from
  // `daily` on every open so a divergent lifetime row can never pin a
  // hero card to a stale value. Days already pruned from `daily` are
  // preserved untouched.
  database.exec(`
    CREATE TABLE IF NOT EXISTS lifetime (
      day TEXT PRIMARY KEY,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      cost_computed REAL,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_ok INTEGER NOT NULL DEFAULT 0,
      tool_fail INTEGER NOT NULL DEFAULT 0,
      bg_input INTEGER NOT NULL DEFAULT 0,
      bg_output INTEGER NOT NULL DEFAULT 0,
      bg_reasoning INTEGER NOT NULL DEFAULT 0,
      bg_cache_read INTEGER NOT NULL DEFAULT 0,
      bg_cache_write INTEGER NOT NULL DEFAULT 0,
      bg_cost REAL NOT NULL DEFAULT 0
    );
    -- Reconcile: rows still inside the retention window are authoritative in
    -- daily, so overwrite any divergent lifetime twin. (OR REPLACE, not an
    -- ON CONFLICT upsert: INSERT ... SELECT ... ON CONFLICT misparses
    -- because the parser reads ON as a JOIN constraint.) Days already pruned
    -- from daily have no twin row and are preserved untouched.
    -- Column lists are explicit on both sides: legacy databases exist where
    -- daily carries cost_computed last (added via ALTER TABLE) while lifetime
    -- already has it after cost, and a positional SELECT * copy shifts
    -- tool_calls/tool_ok/tool_fail into cost_computed/tool_calls/tool_ok.
    INSERT OR REPLACE INTO lifetime
      (day, input, output, reasoning, cache_read, cache_write, cost,
       cost_computed, tool_calls, tool_ok, tool_fail, bg_input, bg_output,
       bg_reasoning, bg_cache_read, bg_cache_write, bg_cost)
    SELECT day, input, output, reasoning, cache_read, cache_write, cost,
       cost_computed, tool_calls, tool_ok, tool_fail, bg_input, bg_output,
       bg_reasoning, bg_cache_read, bg_cache_write, bg_cost
    FROM daily;
  `);
}

/** US-7: last unconditional db-failure notice (epoch ms, module-level). */
let lastDbErrorLog = 0;

/**
 * US-7: db failures must never fail silently. This logs unconditionally
 * (independent of cfg.log) but rate-limited to one notice per 5 minutes so
 * a permanently broken db cannot spam stderr on every tool call.
 */
function logDbError(message: string): void {
  const now = Date.now();
  if (now - lastDbErrorLog < 300_000) return;
  lastDbErrorLog = now;
  console.error(`[usage-stats] ${message}`);
}

function getDb(state: UsageState, cfg: Config): AnyDatabase {
  if (!state.db) {
    state.db = openDatabase(join(cfg.dir, DB_NAME));
    applyPragmas(state.db);
    initSchema(state.db);
    prune(state, cfg, true);
  }
  return state.db;
}

function prune(state: UsageState, cfg: Config, force: boolean): void {
  if (cfg.retentionDays <= 0) return;
  const now = Date.now();
  if (!force && now - state.lastPruneMs < 3_600_000) return;
  state.lastPruneMs = now;
  try {
    const cutoff = dayKey(shiftDays(new Date(), -cfg.retentionDays));
    const database = state.db;
    if (!database) return;
    database.prepare("DELETE FROM daily WHERE day < ?").run(cutoff);
    database.prepare("DELETE FROM daily_models WHERE day < ?").run(cutoff);
    database.prepare("DELETE FROM daily_tools WHERE day < ?").run(cutoff);
    // US-3: per-session tool rows are day-scoped detail like daily_tools, so
    // they age out with the same retention window. session_state itself is
    // exempt below (U1), so age session_tools off that row's updated_at day
    // key rather than deleting it alongside its session.
    database
      .prepare(
        `DELETE FROM session_tools
          WHERE session_id IN (
            SELECT session_id FROM session_state
             WHERE updated_at != '' AND updated_at < ?
          )`,
      )
      .run(cutoff);
    // U1: never prune session_state rows that hold cumulative usage — a
    // resumed session would otherwise re-add its entire lifetime as one
    // delta (double counting everything). Only rows with no recorded
    // usage are safe to drop; lifetime rollups are never pruned (U2).
    database
      .prepare(
        `DELETE FROM session_state
          WHERE updated_at != '' AND updated_at < ?
            AND input = 0 AND output = 0 AND reasoning = 0
            AND cache_read = 0 AND cache_write = 0 AND cost = 0`,
      )
      .run(cutoff);
  } catch {
    /* pruning is best-effort */
  }
}

type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

type SessionRow = {
  session_id: string;
  model: string | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost: number;
};

function readTokens(raw: unknown): Tokens {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cache = (t.cache && typeof t.cache === "object" ? t.cache : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function readCost(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function loadSession(database: AnyDatabase, sessionID: string): SessionRow | null {
  return (database
    .prepare("SELECT * FROM session_state WHERE session_id = ?")
    .get(sessionID) ?? null) as SessionRow | null;
}

function ensureSession(database: AnyDatabase, sessionID: string, model: string | null): void {
  database
    .prepare(
      `INSERT INTO session_state(session_id, model, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         model = COALESCE(excluded.model, session_state.model),
         updated_at = excluded.updated_at`,
    )
    .run(sessionID, model, dayKey());
}

function addDailyUsage(
  database: AnyDatabase,
  day: string,
  t: Tokens,
  cost: number,
  costComputed: number | null,
): void {
  // U2: mirror every daily increment into the never-pruned lifetime rollup.
  for (const table of ["daily", "lifetime"] as const) {
    database
      .prepare(
        `INSERT INTO ${table}(day, input, output, reasoning, cache_read, cache_write, cost, cost_computed)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           input = input + excluded.input,
           output = output + excluded.output,
           reasoning = reasoning + excluded.reasoning,
           cache_read = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write,
           cost = cost + excluded.cost,
           cost_computed = CASE WHEN excluded.cost_computed IS NULL THEN cost_computed ELSE COALESCE(cost_computed, 0) + excluded.cost_computed END`,
      )
      .run(day, t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, cost, costComputed);
  }
}

function addModelUsage(
  database: AnyDatabase,
  model: string,
  t: Tokens,
  cost: number,
  events: number,
  costComputed: number | null,
): void {
  database
    .prepare(
      `INSERT INTO model_totals(model, input, output, reasoning, cache_read, cache_write, cost, events, cost_computed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET
         input = input + excluded.input,
         output = output + excluded.output,
         reasoning = reasoning + excluded.reasoning,
         cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write,
         cost = cost + excluded.cost,
         events = events + excluded.events,
         cost_computed = CASE WHEN excluded.cost_computed IS NULL THEN cost_computed ELSE COALESCE(cost_computed, 0) + excluded.cost_computed END`,
    )
    .run(model, t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, cost, events, costComputed);
}

function addDailyModelUsage(
  database: AnyDatabase,
  day: string,
  model: string,
  t: Tokens,
  cost: number,
  events: number,
  costComputed: number | null,
): void {
  database
    .prepare(
      `INSERT INTO daily_models(day, model, input, output, reasoning, cache_read, cache_write, cost, events, cost_computed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, model) DO UPDATE SET
         input = input + excluded.input,
         output = output + excluded.output,
         reasoning = reasoning + excluded.reasoning,
         cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write,
         cost = cost + excluded.cost,
         events = events + excluded.events,
         cost_computed = CASE WHEN excluded.cost_computed IS NULL THEN cost_computed ELSE COALESCE(cost_computed, 0) + excluded.cost_computed END`,
    )
    .run(day, model, t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, cost, events, costComputed);
}

/**
 * US-3: background usage must also land in model_totals (with a computed
 * list-price cost) — otherwise cost_computed is never written for it and
 * per-model totals silently miss background traffic.
 */
function addBackgroundUsage(
  database: AnyDatabase,
  state: UsageState,
  day: string,
  sessionID: string,
  source: string,
  t: Tokens,
  cost: number,
): void {
  database
    .prepare(
      `INSERT INTO sources(source, count, cost, input, output, reasoning, cache_read, cache_write)
       VALUES(?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         count = count + 1,
         cost = cost + excluded.cost,
         input = input + excluded.input,
         output = output + excluded.output,
         reasoning = reasoning + excluded.reasoning,
         cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write`,
    )
    .run(source, cost, t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite);
  // U2: mirror the background (title/compaction) usage into the lifetime rollup too.
  for (const table of ["daily", "lifetime"] as const) {
    database
      .prepare(
        `INSERT INTO ${table}(day, bg_input, bg_output, bg_reasoning, bg_cache_read, bg_cache_write, bg_cost)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           bg_input = bg_input + excluded.bg_input,
           bg_output = bg_output + excluded.bg_output,
           bg_reasoning = bg_reasoning + excluded.bg_reasoning,
           bg_cache_read = bg_cache_read + excluded.bg_cache_read,
           bg_cache_write = bg_cache_write + excluded.bg_cache_write,
           bg_cost = bg_cost + excluded.bg_cost`,
      )
      .run(day, t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, cost);
  }
  // US-3: attribute background usage to a model as well, storing a computed
  // list-price cost — without this, cost_computed is never written for
  // background traffic and per-model totals miss it entirely.
  const model = state.sessionModels.get(sessionID)?.model ?? loadSession(database, sessionID)?.model ?? "unknown";
  const modelCost = computedCost(model, t, state);
  addModelUsage(database, model, t, cost, 1, modelCost);
  addDailyModelUsage(database, day, model, t, cost, 1, modelCost);
}

function recordUsageUpdated(
  database: AnyDatabase,
  sessionID: string,
  tokensRaw: unknown,
  costRaw: unknown,
  modelRaw: unknown,
  state: UsageState,
): void {
  const current = readTokens(tokensRaw);
  const cost = readCost(costRaw);
  const last = loadSession(database, sessionID);
  // U6: prefer the model carried on the usage event when present — the
  // `session_state.model` written by the http.request hook can race the
  // event pump; without this the delta can land on the wrong model.
  const eventModel = modelKey(modelRaw);
  const model = eventModel !== "unknown" ? eventModel : last?.model ?? "unknown";
  const prev = last ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    cost: 0,
  };
  const delta: Tokens = {
    input: Math.max(0, current.input - prev.input),
    output: Math.max(0, current.output - prev.output),
    reasoning: Math.max(0, current.reasoning - prev.reasoning),
    cacheRead: Math.max(0, current.cacheRead - prev.cache_read),
    cacheWrite: Math.max(0, current.cacheWrite - prev.cache_write),
  };
  const deltaCost = Math.max(0, cost - prev.cost);
  const deltaComputed = computedCost(model, delta, state);
  const day = dayKey();
  const changed =
    delta.input > 0 ||
    delta.output > 0 ||
    delta.reasoning > 0 ||
    delta.cacheRead > 0 ||
    delta.cacheWrite > 0 ||
    deltaCost > 0;
  // U3: the rollups and the baseline write must be atomic — a mid-sequence
  // failure would double-count the delta against session_state on the next
  // event. U4: the upsert below already creates the row, so the separate
  // ensureSession INSERT was redundant.
  // US-1: the baseline write is monotonic (MAX of stored vs incoming) — a
  // downward-revised cumulative snapshot (session.revert.committed, or an
  // out-of-order/replayed event) must never lower the stored baseline, or
  // the same tokens/cost get counted a second time when the total climbs
  // back up.
  database.exec("BEGIN TRANSACTION");
  try {
    if (changed) {
      addDailyUsage(database, day, delta, deltaCost, deltaComputed);
      addModelUsage(database, model, delta, deltaCost, 1, deltaComputed);
      addDailyModelUsage(database, day, model, delta, deltaCost, 1, deltaComputed);
    }
    database
      .prepare(
        `INSERT INTO session_state(session_id, input, output, reasoning, cache_read, cache_write, cost, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           input = MAX(input, excluded.input),
           output = MAX(output, excluded.output),
           reasoning = MAX(reasoning, excluded.reasoning),
           cache_read = MAX(cache_read, excluded.cache_read),
           cache_write = MAX(cache_write, excluded.cache_write),
           cost = MAX(cost, excluded.cost),
           updated_at = excluded.updated_at`,
      )
      .run(sessionID, current.input, current.output, current.reasoning, current.cacheRead, current.cacheWrite, cost, day);
    database.exec("COMMIT");
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
  state.dirty = true;
}

function recordUsageRecorded(database: AnyDatabase, sessionID: string, source: string, tokensRaw: unknown, costRaw: unknown, state: UsageState): void {
  ensureSession(database, sessionID, null);
  addBackgroundUsage(database, state, dayKey(), sessionID, source || "unknown", readTokens(tokensRaw), readCost(costRaw));
  state.dirty = true;
}

function recordModelSelected(database: AnyDatabase, sessionID: string, model: string, state: UsageState): void {
  ensureSession(database, sessionID, model);
  state.dirty = true;
}

function recordSessionCreated(database: AnyDatabase, sessionID: string, state: UsageState): void {
  ensureSession(database, sessionID, null);
  state.dirty = true;
}

/**
 * Attribute a session to its current model. `session.model.selected` only fires
 * on switches (not for the initial model), so we also call this from the
 * `http.request` hook, which carries the model on every request.
 */
function rememberModel(state: UsageState, sessionID: string, model: string): void {
  if (!sessionID || !model) return;
  const existing = state.sessionModels.get(sessionID);
  if (existing && existing.model === model) {
    existing.updatedMs = Date.now();
    return;
  }
  state.sessionModels.set(sessionID, { model, updatedMs: Date.now() });
  try {
    if (state.db) recordModelSelected(state.db, sessionID, model, state);
  } catch {
    /* db unavailable */
  }
}

/**
 * US-7/TA-6: `durationMs` may be null for calls whose pending entry expired
 * (a call longer than the sweep TTL, or a lost execute.before). The call is
 * still counted — total_ms/max_ms just get 0 and timed_calls stays 0, so
 * averages divide by timed calls only.
 */
function addDailyToolUsage(
  database: AnyDatabase,
  day: string,
  tool: string,
  ok: boolean,
  durationMs: number | null,
): void {
  const ms = durationMs === null ? 0 : durationMs;
  database
    .prepare(
      `INSERT INTO daily_tools(day, tool, calls, succeeded, failed, total_ms, max_ms, timed_calls)
       VALUES(?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(day, tool) DO UPDATE SET
         calls = calls + 1,
         succeeded = succeeded + excluded.succeeded,
         failed = failed + excluded.failed,
         total_ms = total_ms + excluded.total_ms,
         max_ms = MAX(max_ms, excluded.max_ms),
         timed_calls = timed_calls + excluded.timed_calls`,
    )
    .run(day, tool, ok ? 1 : 0, ok ? 0 : 1, ms, ms, durationMs === null ? 0 : 1);
}

function recordToolCall(
  database: AnyDatabase,
  tool: string,
  ok: boolean,
  durationMs: number | null,
  sessionID: string,
  state: UsageState,
): void {
  const ms = durationMs === null ? null : Math.max(0, Math.round(durationMs));
  const day = dayKey();
  // U3: both rollups are written atomically; U2: the daily increment is
  // mirrored into the never-pruned lifetime rollup.
  database.exec("BEGIN TRANSACTION");
  try {
    database
      .prepare(
        `INSERT INTO tool_totals(tool, calls, succeeded, failed, total_ms, max_ms, timed_calls)
         VALUES(?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(tool) DO UPDATE SET
           calls = calls + 1,
           succeeded = succeeded + excluded.succeeded,
           failed = failed + excluded.failed,
           total_ms = total_ms + excluded.total_ms,
           max_ms = MAX(max_ms, excluded.max_ms),
           timed_calls = timed_calls + excluded.timed_calls`,
      )
      .run(tool, ok ? 1 : 0, ok ? 0 : 1, ms ?? 0, ms ?? 0, ms === null ? 0 : 1);
    // US-3: per-session counters alongside the global ones, so stats_sessions
    // can report this session's own calls instead of the day's rollup.
    // Calls with no known session (hooks fired without a sessionID) still
    // count toward tool_totals/daily — they just land in no session row.
    if (sessionID) {
      database
        .prepare(
          `INSERT INTO session_tools(session_id, tool, calls, ok, fail, duration_ms)
           VALUES(?, ?, 1, ?, ?, ?)
           ON CONFLICT(session_id, tool) DO UPDATE SET
             calls = calls + 1,
             ok = ok + excluded.ok,
             fail = fail + excluded.fail,
             duration_ms = duration_ms + excluded.duration_ms`,
        )
        .run(sessionID, tool, ok ? 1 : 0, ok ? 0 : 1, ms ?? 0);
    }
    addDailyToolUsage(database, day, tool, ok, ms);
    for (const table of ["daily", "lifetime"] as const) {
      database
        .prepare(
          `INSERT INTO ${table}(day, tool_calls, tool_ok, tool_fail)
           VALUES(?, 1, ?, ?)
           ON CONFLICT(day) DO UPDATE SET
             tool_calls = tool_calls + 1,
             tool_ok = tool_ok + excluded.tool_ok,
             tool_fail = tool_fail + excluded.tool_fail`,
        )
        .run(day, ok ? 1 : 0, ok ? 0 : 1);
    }
    database.exec("COMMIT");
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
  state.dirty = true;
}

type UsageTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costComputed: number | null;
};

type DayRow = UsageTotals & {
  day: string;
  tool_calls: number;
  tool_ok: number;
  tool_fail: number;
  bg_input: number;
  bg_output: number;
  bg_reasoning: number;
  bg_cache_read: number;
  bg_cache_write: number;
  bg_cost: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * US-7/TA-6: average duration over *timed* calls only, so unknown-duration
 * (swept) calls never drag the average toward zero. Returns null when the
 * average is genuinely unknown — every call so far had no measurable
 * duration — so callers render "?" instead of a misleading "0ms".
 *
 * Rows written before the timed_calls column existed report 0 timed calls
 * while holding accumulated durations; those keep averaging over all calls
 * so their pre-existing numbers render exactly as before.
 */
function avgMsOrNull(totalMs: number, timedCalls: number, calls: number): number | null {
  if (timedCalls > 0) return totalMs / timedCalls;
  // Legacy row: durations were accumulated before timed_calls existed.
  if (totalMs > 0) return calls > 0 ? totalMs / calls : null;
  // No timed calls and no accumulated time: the average is unknown, not 0.
  return null;
}

/**
 * US-7/TA-6: the same "unknown, not instantaneous" rule for the maximum. A
 * row whose only calls had unknown durations has no meaningful max; the
 * stored 0 is a sentinel, not a measurement, so it renders as "?".
 */
function maxMsOrNull(maxMs: number, timedCalls: number): number | null {
  return timedCalls > 0 || maxMs > 0 ? maxMs : null;
}

/** Render a possibly-unknown duration for text output. */
function fmtMsOrUnknown(ms: number | null): string {
  return ms === null ? "?" : `${fmtInt(ms)}ms`;
}

function totalsOf(r: Record<string, unknown> | null | undefined): UsageTotals {
  if (!r)
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costComputed: null };
  return {
    input: num(r.input),
    output: num(r.output),
    reasoning: num(r.reasoning),
    cacheRead: num(r.cache_read ?? r.cacheRead),
    cacheWrite: num(r.cache_write ?? r.cacheWrite),
    cost: num(r.cost),
    costComputed: numOrNull(r.cost_computed),
  };
}

function tokenTotal(t: UsageTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function dailyRows(database: AnyDatabase, sinceDay?: string): DayRow[] {
  const sql = sinceDay
    ? "SELECT * FROM daily WHERE day >= ? ORDER BY day ASC"
    : "SELECT * FROM daily ORDER BY day ASC";
  const rows = (sinceDay ? database.prepare(sql).all(sinceDay) : database.prepare(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    day: String(r.day ?? ""),
    ...totalsOf(r),
    tool_calls: num(r.tool_calls),
    tool_ok: num(r.tool_ok),
    tool_fail: num(r.tool_fail),
    bg_input: num(r.bg_input),
    bg_output: num(r.bg_output),
    bg_reasoning: num(r.bg_reasoning),
    bg_cache_read: num(r.bg_cache_read),
    bg_cache_write: num(r.bg_cache_write),
    bg_cost: num(r.bg_cost),
  }));
}

/** US-8: fetch a single day row directly instead of scanning the table. */
function dailyRow(database: AnyDatabase, day: string): DayRow | undefined {
  const r = database.prepare("SELECT * FROM daily WHERE day = ?").get(day) as Record<string, unknown> | null;
  if (!r) return undefined;
  return {
    day: String(r.day ?? ""),
    ...totalsOf(r),
    tool_calls: num(r.tool_calls),
    tool_ok: num(r.tool_ok),
    tool_fail: num(r.tool_fail),
    bg_input: num(r.bg_input),
    bg_output: num(r.bg_output),
    bg_reasoning: num(r.bg_reasoning),
    bg_cache_read: num(r.bg_cache_read),
    bg_cache_write: num(r.bg_cache_write),
    bg_cost: num(r.bg_cost),
  };
}

function lifetimeTotals(database: AnyDatabase): UsageTotals {
  const r = database
    .prepare(
      `SELECT SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(cost) cost,
              SUM(cost_computed) cost_computed
       FROM lifetime`,
    )
    .get() as Record<string, unknown> | null;
  return totalsOf(r);
}

function lifetimeTools(database: AnyDatabase): { calls: number; ok: number; fail: number } {
  const r = database
    .prepare("SELECT SUM(tool_calls) calls, SUM(tool_ok) ok, SUM(tool_fail) fail FROM lifetime")
    .get() as Record<string, unknown> | null;
  return { calls: num(r?.calls), ok: num(r?.ok), fail: num(r?.fail) };
}

function countSessions(database: AnyDatabase): number {
  const r = database.prepare("SELECT COUNT(*) c FROM session_state").get() as { c?: number } | null;
  return num(r?.c);
}

function countUnknownModels(database: AnyDatabase): number {
  const r = database
    .prepare("SELECT COUNT(*) c FROM model_totals WHERE cost_computed IS NULL")
    .get() as { c?: number } | null;
  return num(r?.c);
}

function backgroundTotals(database: AnyDatabase): { total: number; cost: number; bySource: Record<string, number> } {
  const rows = database.prepare("SELECT * FROM sources").all() as Array<Record<string, unknown>>;
  let total = 0;
  let cost = 0;
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    const t = totalsOf(r);
    const tokens = tokenTotal(t);
    total += tokens;
    cost += t.cost;
    bySource[String(r.source ?? "unknown")] = tokens;
  }
  return { total, cost, bySource };
}

function summaryText(database: AnyDatabase): string {
  const life = lifetimeTotals(database);
  const tools = lifetimeTools(database);
  const sessions = countSessions(database);
  const bg = backgroundTotals(database);
  const unknownModels = countUnknownModels(database);
  const day = dayKey();
  const todayRow = dailyRow(database, day);
  const today = totalsOf(todayRow);
  // Success rate is measured over completed calls (ok + fail). Older rows
  // counted every started call, so `calls` can exceed completed; those
  // leftovers are reported as pending instead of tanking the rate.
  const completed = tools.ok + tools.fail;
  const pending = Math.max(0, tools.calls - completed);
  const rate = completed > 0 ? (tools.ok / completed) * 100 : 0;
  const tokenLine = (t: UsageTotals): string =>
    `input=${fmtInt(t.input)} output=${fmtInt(t.output)} reasoning=${fmtInt(t.reasoning)} cache_read=${fmtInt(t.cacheRead)} cache_write=${fmtInt(t.cacheWrite)}`;
  return [
    "Usage stats — lifetime",
    `  tokens: ${tokenLine(life)}`,
    `  cost: ${fmtUsd(life.cost)}`,
    `  cost (list price): ${fmtUsdOrDash(life.costComputed)}`,
    `  unknown models: ${fmtInt(unknownModels)} (no published pricing)`,
    `  sessions: ${sessions}`,
    `  tool calls: ${fmtInt(tools.calls)} (ok ${fmtInt(tools.ok)}, failed ${fmtInt(tools.fail)}${pending > 0 ? `, ${fmtInt(pending)} pending` : ""}, ${rate.toFixed(1)}% success)`,
    `  background: tokens=${fmtInt(bg.total)} cost=${fmtUsd(bg.cost)} (title=${fmtInt(bg.bySource.title ?? 0)} compaction=${fmtInt(bg.bySource.compaction ?? 0)})`,
    "",
    `Usage stats — today (${day})`,
    `  tokens: ${tokenLine(today)}`,
    `  cost: ${fmtUsd(today.cost)}`,
    `  cost (list price): ${fmtUsdOrDash(today.costComputed)}`,
    `  tool calls: ${fmtInt(todayRow?.tool_calls ?? 0)}`,
  ].join("\n");
}

function toolsText(database: AnyDatabase, limit: number): string {
  const rows = database
    .prepare(
      "SELECT tool, calls, succeeded, failed, total_ms, max_ms, timed_calls FROM tool_totals ORDER BY calls DESC, tool ASC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
  if (rows.length === 0) return "No tool calls recorded yet.";
  const lines = [`Tool usage (${rows.length} tools)`];
  for (const r of rows) {
    const calls = num(r.calls);
    // US-7/TA-6: average/maximum cover timed calls only, and render as "?"
    // when every call so far had an unknown duration — "0ms" would read as
    // instantaneous for a call that was actually still running.
    const timed = num(r.timed_calls);
    const avg = avgMsOrNull(num(r.total_ms), timed, calls);
    lines.push(
      `  ${String(r.tool)}: calls=${fmtInt(calls)} ok=${fmtInt(num(r.succeeded))} failed=${fmtInt(num(r.failed))} avg=${avg === null ? "?" : `${Math.round(avg)}ms`} max=${fmtMsOrUnknown(maxMsOrNull(num(r.max_ms), timed))}`,
    );
  }
  return lines.join("\n");
}

function tokensText(database: AnyDatabase, days: number): string {
  const since = dayKey(shiftDays(new Date(), -(days - 1)));
  const rows = dailyRows(database, since);
  const lines = [`Token usage by day (last ${days} days)`];
  if (rows.length === 0) lines.push("  (none)");
  for (const r of rows) {
    lines.push(
      `  ${r.day}: tokens=${fmtInt(tokenTotal(r))} cost=${fmtUsd(r.cost)} calls=${fmtInt(r.tool_calls)}`,
    );
  }
  const models = database
    .prepare(
      `SELECT * FROM model_totals
       ORDER BY (input + output + reasoning + cache_read + cache_write) DESC, model ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  lines.push("", "By model:");
  if (models.length === 0) lines.push("  (none)");
  for (const m of models) {
    const t = totalsOf(m);
    lines.push(
      `  ${String(m.model)}: tokens=${fmtInt(tokenTotal(t))} cost=${fmtUsd(t.cost)} events=${fmtInt(num(m.events))}`,
    );
  }
  return lines.join("\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEAT_CHARS = ["·", "░", "▒", "▓", "█"];

type HeatCell = { day: string; value: number; inRange: boolean; row: DayRow | null };
type HeatGrid = {
  weeks: number;
  metric: HeatMetric;
  max: number;
  total: number;
  columns: HeatCell[][];
  months: { col: number; label: string }[];
  start: Date;
  end: Date;
};

function metricValue(r: DayRow, metric: HeatMetric, includeBackground: boolean): number {
  if (metric === "calls") return r.tool_calls;
  if (metric === "cost") return r.cost + (includeBackground ? r.bg_cost : 0);
  const bg = includeBackground
    ? r.bg_input + r.bg_output + r.bg_reasoning + r.bg_cache_read + r.bg_cache_write
    : 0;
  return tokenTotal(r) + bg;
}

function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

function heatmapGrid(
  database: AnyDatabase,
  weeks: number,
  metric: HeatMetric,
  includeBackground: boolean,
): HeatGrid {
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const thisSunday = shiftDays(todayMid, -todayMid.getDay());
  const startSunday = shiftDays(thisSunday, -(weeks - 1) * 7);
  const rows = dailyRows(database, dayKey(startSunday));
  const byDay = new Map<string, DayRow>();
  for (const r of rows) byDay.set(r.day, r);
  const columns: HeatCell[][] = [];
  const months: { col: number; label: string }[] = [];
  let max = 0;
  let total = 0;
  let lastMonth = -1;
  for (let col = 0; col < weeks; col++) {
    const cells: HeatCell[] = [];
    for (let row = 0; row < 7; row++) {
      const d = shiftDays(startSunday, col * 7 + row);
      const key = dayKey(d);
      const inRange = d.getTime() <= todayMid.getTime();
      const r = byDay.get(key);
      const value = r && inRange ? metricValue(r, metric, includeBackground) : 0;
      if (inRange) {
        max = Math.max(max, value);
        total += value;
      }
      cells.push({ day: key, value, inRange, row: r ?? null });
    }
    const first = shiftDays(startSunday, col * 7);
    // Month labels sit in a single 12px column but render ~18px wide, so
    // labels in adjacent columns overlap. Skip a label that would collide
    // with the previously emitted one.
    if (first.getMonth() !== lastMonth) {
      lastMonth = first.getMonth();
      if (months.length === 0 || col - months[months.length - 1]!.col >= 2) {
        months.push({ col, label: MONTHS[first.getMonth()] ?? "" });
      }
    }
    columns.push(cells);
  }
  return { weeks, metric, max, total, columns, months, start: startSunday, end: todayMid };
}

type DayModelUsage = UsageTotals & { model: string; events: number };
type DayToolUsage = {
  tool: string;
  calls: number;
  succeeded: number;
  failed: number;
  /** US-7/TA-6: null when every call that day had an unknown duration. */
  avgMs: number | null;
  maxMs: number | null;
};
type DayBreakdown = { models: DayModelUsage[]; tools: DayToolUsage[] };

function dayBreakdowns(database: AnyDatabase, grid: HeatGrid): Map<string, DayBreakdown> {
  const start = dayKey(grid.start);
  const end = dayKey(grid.end);
  const result = new Map<string, DayBreakdown>();
  const ensure = (day: string): DayBreakdown => {
    let breakdown = result.get(day);
    if (!breakdown) {
      breakdown = { models: [], tools: [] };
      result.set(day, breakdown);
    }
    return breakdown;
  };
  const models = database
    .prepare(
      `SELECT day, model, input, output, reasoning, cache_read, cache_write, cost, cost_computed, events
       FROM daily_models
       WHERE day >= ? AND day <= ?
       ORDER BY day ASC, (input + output + reasoning + cache_read + cache_write) DESC, model ASC`,
    )
    .all(start, end) as Array<Record<string, unknown>>;
  for (const row of models) {
    const totals = totalsOf(row);
    ensure(String(row.day ?? "")).models.push({
      model: String(row.model ?? "unknown"),
      ...totals,
      events: num(row.events),
    });
  }
  const tools = database
    .prepare(
      `SELECT day, tool, calls, succeeded, failed, total_ms, max_ms, timed_calls
       FROM daily_tools
       WHERE day >= ? AND day <= ?
       ORDER BY day ASC, calls DESC, tool ASC`,
    )
    .all(start, end) as Array<Record<string, unknown>>;
  for (const row of tools) {
    const calls = num(row.calls);
    ensure(String(row.day ?? "")).tools.push({
      tool: String(row.tool ?? "unknown"),
      calls,
      succeeded: num(row.succeeded),
      failed: num(row.failed),
      // US-7/TA-6: average/maximum cover timed calls only (legacy rows fall
      // back to calls), and are null when every call had an unknown duration
      // so an in-flight call never reads as instantaneous.
      avgMs: avgMsOrNull(num(row.total_ms), num(row.timed_calls), calls),
      maxMs: maxMsOrNull(num(row.max_ms), num(row.timed_calls)),
    });
  }
  return result;
}

function tokenBreakdownText(t: UsageTotals): string {
  return `input=${fmtInt(t.input)} output=${fmtInt(t.output)} reasoning=${fmtInt(t.reasoning)} cache_read=${fmtInt(t.cacheRead)} cache_write=${fmtInt(t.cacheWrite)}`;
}

function heatmapDayTitle(
  row: DayRow,
  metric: HeatMetric,
  includeBackground: boolean,
  breakdown: DayBreakdown | undefined,
): string {
  const background: UsageTotals = {
    input: row.bg_input,
    output: row.bg_output,
    reasoning: row.bg_reasoning,
    cacheRead: row.bg_cache_read,
    cacheWrite: row.bg_cache_write,
    cost: row.bg_cost,
    costComputed: null,
  };
  const displayed: UsageTotals = includeBackground
    ? {
        input: row.input + background.input,
        output: row.output + background.output,
        reasoning: row.reasoning + background.reasoning,
        cacheRead: row.cacheRead + background.cacheRead,
        cacheWrite: row.cacheWrite + background.cacheWrite,
        cost: row.cost + background.cost,
        costComputed: row.costComputed,
      }
    : row;
  const lines = [
    `${row.day} — ${heatCellLabel(metricValue(row, metric, includeBackground), metric)} ${metric}`,
    `Tokens: ${fmtInt(tokenTotal(displayed))} total`,
    `  ${tokenBreakdownText(displayed)}`,
  ];
  if (includeBackground && tokenTotal(background) > 0) {
    lines.push(`Background: ${fmtInt(tokenTotal(background))} tokens (${tokenBreakdownText(background)})`);
  }
  lines.push(`Tools: ${fmtInt(row.tool_calls)} calls (${fmtInt(row.tool_ok)} ok, ${fmtInt(row.tool_fail)} failed)`);
  for (const tool of breakdown?.tools ?? []) {
    lines.push(
      `  ${tool.tool}: ${fmtInt(tool.calls)} calls (${fmtInt(tool.succeeded)} ok, ${fmtInt(tool.failed)} failed), avg ${tool.avgMs === null ? "?" : `${Math.round(tool.avgMs)}ms`}, max ${fmtMsOrUnknown(tool.maxMs)}`,
    );
  }
  lines.push(`Models: ${breakdown?.models.length ?? 0} used`);
  for (const model of breakdown?.models ?? []) {
    lines.push(
      `  ${model.model}: ${fmtInt(tokenTotal(model))} tokens (${tokenBreakdownText(model)}), ${fmtInt(model.events)} events, cost ${fmtUsd(model.cost)}${model.costComputed === null ? "" : ` (list ${fmtUsd(model.costComputed)})`}`,
    );
  }
  if ((breakdown?.models.length ?? 0) === 0) {
    lines.push("  No per-model history was recorded for this day.");
  }
  lines.push(`Cost: ${fmtUsd(displayed.cost)} reported${includeBackground && row.bg_cost > 0 ? ` (including ${fmtUsd(row.bg_cost)} background)` : ""}`);
  return lines.join("\n");
}

/**
 * The heatmap window adapts to the history the database actually
 * holds: never wider than cfg.heatmapWeeks, and never wider than
 * the oldest recorded day, so it grows as months of data accrue
 * instead of showing empty leading columns forever.
 */
function effectiveHeatmapWeeks(cfg: Config, database: AnyDatabase, requested?: number): number {
  let weeks = requested ?? cfg.heatmapWeeks;
  const oldest = database.prepare("SELECT MIN(day) AS d FROM daily").get() as
    | { d: string | null }
    | null;
  const oldestDay = oldest?.d;
  if (oldestDay) {
    const days = Math.round(
      (Date.now() - Date.parse(oldestDay + "T00:00:00Z")) / 86_400_000,
    );
    weeks = Math.min(weeks, Math.max(1, Math.ceil((days + 1) / 7)));
  } else {
    weeks = 1; // no daily rows yet: just the current week
  }
  return Math.max(1, Math.min(weeks, requested ?? cfg.heatmapWeeks));
}

function heatmapText(database: AnyDatabase, weeks: number, metric: HeatMetric, includeBackground: boolean): string {
  const grid = heatmapGrid(database, weeks, metric, includeBackground);
  const lines: string[] = [`Usage heatmap (last ${weeks} weeks, metric=${metric})`];
  let header = "    ";
  for (const m of grid.months) {
    const target = 4 + m.col;
    if (header.length < target) header += " ".repeat(target - header.length);
    header += m.label;
  }
  lines.push(header.replace(/\s+$/, ""));
  for (let row = 0; row < 7; row++) {
    let s = `${DOWS[row]} `;
    for (let col = 0; col < grid.weeks; col++) {
      const cell = grid.columns[col]?.[row];
      s += cell && cell.inRange ? HEAT_CHARS[heatLevel(cell.value, grid.max)] : " ";
    }
    lines.push(s.replace(/\s+$/, ""));
  }
  lines.push(`Legend: ${HEAT_CHARS.join(" ")} (low → high, max ${fmtInt(grid.max)})`);
  lines.push(`Total: ${metric === "cost" ? fmtUsd(grid.total) : fmtInt(grid.total)}`);
  return lines.join("\n");
}

// CSS class per heat level (colours live in the stylesheet so the dark-mode
// media query can switch them).
const HEAT_COLORS = ["hm-l0", "hm-l1", "hm-l2", "hm-l3", "hm-l4"];

function heatCellLabel(value: number, metric: HeatMetric): string {
  return metric === "cost" ? fmtShortUsd(value) : fmtCompact(value);
}

/** All three metrics at once, so the heatmap can carry client-side toggle data. */
const HEAT_METRICS: ReadonlyArray<HeatMetric> = ["tokens", "cost", "calls"];

/** Metric switch for the heatmap. aria-pressed carries the state for AT. */
function metricToggleHtml(current: HeatMetric): string {
  const label: Record<HeatMetric, string> = { tokens: "Tokens", cost: "Cost", calls: "Calls" };
  return (
    `<div class="metric-toggle" role="group" aria-label="Heatmap metric">` +
    HEAT_METRICS.map(
      (m) =>
        `<button type="button" data-metric="${m}" aria-pressed="${m === current ? "true" : "false"}">${label[m]}</button>`,
    ).join("") +
    `</div>`
  );
}

function buildHeatmapHtml(
  grid: HeatGrid,
  breakdowns: Map<string, DayBreakdown>,
  includeBackground: boolean,
): string {
  // Per-metric peak, needed to compute each cell's level for the toggle.
  const metricsMax: Record<HeatMetric, number> = { tokens: 0, cost: 0, calls: 0 };
  for (const col of grid.columns) {
    for (const cell of col) {
      if (!cell.inRange || !cell.row) continue;
      for (const m of HEAT_METRICS) {
        const v = metricValue(cell.row, m, includeBackground);
        if (v > metricsMax[m]) metricsMax[m] = v;
      }
    }
  }
  const cells: string[] = [];
  for (let col = 0; col < grid.weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const cell = grid.columns[col]?.[row];
      if (!cell) continue;
      const level = cell.inRange ? heatLevel(cell.value, grid.max) : 0;
      const cls = cell.inRange ? `hm-cell ${HEAT_COLORS[level]}` : "hm-cell hm-out";
      const title = cell.inRange && cell.row
        ? heatmapDayTitle(cell.row, grid.metric, includeBackground, breakdowns.get(cell.day))
        : `${cell.day}: no usage recorded`;
      // Client-side metric switching: emit the level and the line-1 label for
      // every metric up front so the toggle is instant and needs no reload.
      // Only line 1 of the tooltip is metric-specific; the rest (tokens,
      // tools, models, cost) is metric-independent detail.
      const metricData = (HEAT_METRICS as readonly HeatMetric[])
        .map((m) => {
          const v = cell.inRange && cell.row ? metricValue(cell.row, m, includeBackground) : 0;
          const lv = cell.inRange ? heatLevel(v, metricsMax[m]) : 0;
          return ` data-lv-${m}="${lv}" data-v-${m}="${escapeHtml(heatCellLabel(v, m))}"`;
        })
        .join("");
      cells.push(`<span class="${cls}" tabindex="0" role="button" data-day="${escapeHtml(cell.day)}" data-tooltip="${escapeHtml(title)}"${metricData} aria-label="${escapeHtml(`${cell.day} usage details`)}"></span>`);
    }
  }
  const monthSpans = grid.months
    .map((m) => `<span style="grid-column:${m.col + 1}">${escapeHtml(m.label)}</span>`)
    .join("");
  const dayLabels = [0, 1, 2, 3, 4, 5, 6]
    .map((r) => `<span>${r === 1 ? "Mon" : r === 3 ? "Wed" : r === 5 ? "Fri" : ""}</span>`)
    .join("");
  const legend = HEAT_COLORS.map((c) => `<i class="${c}"></i>`).join("");
  const span = `${dayKey(grid.start)} → ${dayKey(grid.end)}`;
  return [
    `<!-- heatmap -->`,
    `<div class="hm-wrap" role="group" aria-label="${escapeHtml(`activity heatmap ${span}, metric ${grid.metric}`)}">`,
    `<div class="hm-months" style="grid-template-columns:repeat(${grid.weeks},24px)">${monthSpans}</div>`,
    `<div class="hm-body">`,
    `<div class="hm-days">${dayLabels}</div>`,
    `<div class="hm-grid" style="grid-template-columns:repeat(${grid.weeks},24px)">${cells.join("")}</div>`,
    `</div>`,
    `</div>`,
    `<div class="hm-legend"><span class="muted">Less</span>${legend}<span class="muted">More</span><span class="hm-max" data-peak-tokens="${escapeHtml(heatCellLabel(metricsMax.tokens, "tokens"))}" data-peak-cost="${escapeHtml(heatCellLabel(metricsMax.cost, "cost"))}" data-peak-calls="${escapeHtml(heatCellLabel(metricsMax.calls, "calls"))}">peak ${escapeHtml(heatCellLabel(grid.max, grid.metric))}</span></div>`,
  ].join("");
}

/** US-4: the bar chart follows the configured metric instead of hardcoding tokens. */
function buildBarChartHtml(rows: DayRow[], includeBackground: boolean, metric: HeatMetric): string {
  const last = rows.slice(-30);
  const values = last.map((r) => metricValue(r, metric, includeBackground));
  const max = Math.max(1, ...values);
  const w = 760;
  const h = 220;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = Math.max(1, last.length);
  const step = plotW / n;
  const barW = Math.max(2, step - 4);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH * (1 - f);
      return (
        `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" class="gl"/>` +
        `<text x="${padL - 8}" y="${(y + 3).toFixed(1)}" class="axis" text-anchor="end">${escapeHtml(fmtCompact(max * f))}</text>`
      );
    })
    .join("");

  const rects = last
    .map((r, i) => {
      const v = values[i] ?? 0;
      const bh = Math.max(0, Math.round((v / max) * plotH));
      const visibleHeight = Math.max(4, bh);
      const x = padL + i * step + (step - barW) / 2;
      const y = padT + plotH - visibleHeight;
      const rx = Math.min(3, barW / 2);
      const backgroundTokens = r.bg_input + r.bg_output + r.bg_reasoning + r.bg_cache_read + r.bg_cache_write;
      const barTokens = tokenTotal(r) + (includeBackground ? backgroundTokens : 0);
      const barTitle = [
        `${r.day}: ${fmtInt(barTokens)} tokens`,
        `  ${tokenBreakdownText(includeBackground ? {
          input: r.input + r.bg_input,
          output: r.output + r.bg_output,
          reasoning: r.reasoning + r.bg_reasoning,
          cacheRead: r.cacheRead + r.bg_cache_read,
          cacheWrite: r.cacheWrite + r.bg_cache_write,
          cost: 0,
          costComputed: null,
        } : r)}`,
        ...(metric === "tokens"
          ? []
          : [metric === "cost" ? `  ${heatCellLabel(v, "cost")} cost` : `  ${fmtInt(v)} tool calls`]),
      ].join("\n");
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${visibleHeight}" rx="${rx.toFixed(1)}" class="bar" tabindex="0" focusable="true" role="button" data-tooltip="${escapeHtml(barTitle)}" aria-label="${escapeHtml(`${r.day} usage details`)}"></rect>`;
    })
    .join("");

  const stride = Math.max(1, Math.floor(n / 6));
  const xLabels = last
    .map((r, i) => ({ i, day: r.day }))
    .filter(({ i }) => i % stride === 0)
    .map(({ i, day }) => {
      const x = padL + i * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${h - 9}" class="axis" text-anchor="middle">${escapeHtml(day.slice(5))}</text>`;
    })
    .join("");

  return [
    `<!-- bar-chart -->`,
    `<svg class="bars" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${metric} per day over the last 30 days">`,
    gridLines,
    rects,
    `<line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" class="axis-line"/>`,
    xLabels,
    `</svg>`,
  ].join("");
}

function tableHtml(
  headers: string[],
  rows: Cell[][],
  rowAttributes: Array<string | undefined> = [],
  tableId?: string,
): string {
  const cell = (c: Cell, tag: "th" | "td", num: boolean): string => {
    const cls = num ? ' class="num"' : "";
    return typeof c === "string"
      ? `<${tag}${cls}>${escapeHtml(c)}</${tag}>`
      : `<${tag}${cls} title="${escapeHtml(c.title)}">${escapeHtml(c.text)}</${tag}>`;
  };
  const head = headers.map((x, i) => cell(x, "th", i > 0)).join("");
  const body =
    rows.length > 0
      ? rows
          .map((r, rowIndex) => {
            const attrs = rowAttributes[rowIndex] ? ` ${rowAttributes[rowIndex]}` : "";
            return `<tr${attrs}>${r.map((c, i) => cell(c, "td", i > 0)).join("")}</tr>`;
          })
          .join("")
      : `<tr><td colspan="${headers.length}" class="muted">No data yet</td></tr>`;
  const idAttribute = tableId ? ` id="${escapeHtml(tableId)}"` : "";
  // Long tables get their own scroll box so a sticky header has somewhere to
  // stick to; short tables keep the plain wrapper.
  const wrapClass = rows.length > 12 ? "tbl-wrap tall" : "tbl-wrap";
  return `<div class="${wrapClass}"><table${idAttribute} class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

type AppInfo = { name?: string; version?: string; channel?: string };

function lifetimeSummaryLine(database: AnyDatabase): string {
  const life = lifetimeTotals(database);
  const tools = lifetimeTools(database);
  return `${fmtCompact(tokenTotal(life))} tokens / ${fmtShortUsd(life.cost)} / ${fmtCompact(tools.calls)} tool calls`;
}

function buildDashboardHtml(database: AnyDatabase, cfg: Config, app: AppInfo, state: UsageState): string {
  const life = lifetimeTotals(database);
  const tools = lifetimeTools(database);
  const sessions = countSessions(database);
  const bg = backgroundTotals(database);
  const hmWeeks = effectiveHeatmapWeeks(cfg, database);
  const grid = heatmapGrid(database, hmWeeks, cfg.heatmapMetric, cfg.includeBackground);
  const breakdowns = dayBreakdowns(database, grid);
  const recent = dailyRows(database, dayKey(shiftDays(new Date(), -29)));
  // Success rate is measured over completed calls (ok + fail). Older rows
  // counted every started call, so `calls` can exceed completed; those
  // leftovers are reported as pending instead of tanking the rate.
  const completed = tools.ok + tools.fail;
  const pending = Math.max(0, tools.calls - completed);
  const rate = completed > 0 ? (tools.ok / completed) * 100 : 0;

  // First-run state: nothing recorded yet, so explain the page instead of
  // rendering a wall of zeroed KPIs and empty tables.
  const usageRecorded = tokenTotal(life) > 0 || tools.calls > 0 || sessions > 0;
  const firstRunHtml = [
    `<section class="empty-state">`,
    `<h2>No usage recorded yet</h2>`,
    `<p>Nothing has been counted in <code>${escapeHtml(DB_NAME)}</code> yet. Start a session, run some tools, and the heatmap, charts and tables below will fill in automatically.</p>`,
    `<p class="hint">If you have already been running sessions, check <code>stats_health</code> to confirm the stats database is writable.</p>`,
    `</section>`,
  ].join("\n");

  // KPI deltas: trailing 30 days vs the 30 days before it. Lifetime cards
  // stay lifetime totals; the delta is just the sub-label.
  const dayEnd = dayKey(new Date());
  const dayStart = dayKey(shiftDays(new Date(), -29));
  const dayPrevStart = dayKey(shiftDays(new Date(), -59));
  const windowRows = dailyRows(database, dayPrevStart).filter((r) => r.day >= dayPrevStart && r.day <= dayEnd);
  const sumWin = (from: string, pick: (r: DayRow) => number): number =>
    windowRows.filter((r) => r.day >= from && r.day <= dayEnd).reduce((s, r) => s + pick(r), 0);
  const bgTokens = (r: DayRow): number =>
    r.bg_input + r.bg_output + r.bg_reasoning + r.bg_cache_read + r.bg_cache_write;
  const windowTokens = {
    life: sumWin(dayStart, (r) => tokenTotal(r) + (cfg.includeBackground ? bgTokens(r) : 0)),
    prev: sumWin(dayPrevStart, (r) => tokenTotal(r) + (cfg.includeBackground ? bgTokens(r) : 0)),
  };
  const windowCost = {
    life: sumWin(dayStart, (r) => r.cost + (cfg.includeBackground ? r.bg_cost : 0)),
    prev: sumWin(dayPrevStart, (r) => r.cost + (cfg.includeBackground ? r.bg_cost : 0)),
  };
  const windowCostComputed = {
    life: sumWin(dayStart, (r) => r.costComputed ?? 0),
    prev: sumWin(dayPrevStart, (r) => r.costComputed ?? 0),
  };
  const deltaText = (cur: number, prev: number): string => {
    if (prev <= 0 || cur <= 0) return "";
    const pct = ((cur - prev) / prev) * 100;
    if (!isFinite(pct) || Math.abs(pct) < 0.5) return "";
    return ` · ${pct > 0 ? "▲" : "▼"}${Math.round(Math.abs(pct))}% vs prior 30d`;
  };

  const toolRows = (
    database.prepare("SELECT * FROM tool_totals ORDER BY calls DESC, tool ASC LIMIT 15").all() as Array<
      Record<string, unknown>
    >
  ).map((r) => {
    const calls = num(r.calls);
    // US-7/TA-6: timed calls only, and "?" when no call had a known duration
    // — a call still in flight must not render as a 0ms instant call.
    const timed = num(r.timed_calls);
    const avg = avgMsOrNull(num(r.total_ms), timed, calls);
    return [
      String(r.tool),
      compactCell(calls),
      compactCell(num(r.succeeded)),
      compactCell(num(r.failed)),
      avg === null ? "?" : `${Math.round(avg)}ms`,
      fmtMsOrUnknown(maxMsOrNull(num(r.max_ms), timed)),
    ];
  });

  // The literal "unknown" bucket holds usage that arrived before any
  // `session.model.selected`/http.request could attribute it. It is not a
  // model, so it never belongs in the model table — it inflates the row count
  // and takes a slot beside real providers. Its spend is not lost: it is
  // already tracked separately by addBackgroundUsage() and the Background
  // panel below.
  const modelRecords = database
    .prepare(
      `SELECT * FROM model_totals
       WHERE model <> 'unknown'
       ORDER BY (input + output + reasoning + cache_read + cache_write) DESC, model ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  const modelRows = modelRecords.map((r) => {
    const t = totalsOf(r);
    const model = String(r.model);
    const parts = splitModelDisplay(model);
    const entries = state.priceOverrides.get(baseModelKey(model)) ?? state.pricing.get(baseModelKey(model));
    const rate = entries && entries.length > 0 ? selectRate(entries, t.input) : null;
    // Effort is now between model name and provider per user request.
    return [
      { text: parts.name, title: model },
      parts.effort,
      parts.provider,
      rate ? fmtRate(rate.input) : "—",
      rate ? fmtRate(rate.output) : "—",
      compactCell(tokenTotal(t)),
      usdCell(t.cost),
      usdOrDashCell(t.costComputed),
      compactCell(num(r.events)),
    ];
  });
  const modelAttributes = modelRecords.map((r) => {
    const t = totalsOf(r);
    // Machine-readable mirror of the visible cells, so the filter script can
    // total the *filtered* rows without re-parsing compact display text.
    // An unpriced model has no list cost — emit an empty attribute, not the
    // string "null", so the client-side Number()/||0 guard never sees it.
    return (
      `data-model="${escapeHtml(String(r.model ?? "unknown"))}"` +
      ` data-tokens="${tokenTotal(t)}"` +
      ` data-cost="${t.cost}"` +
      ` data-list="${t.costComputed ?? ""}"` +
      ` data-events="${num(r.events)}"`
    );
  });
  const modelOptions = modelRecords
    .map((r) => {
      const model = String(r.model ?? "unknown");
      const parts = splitModelDisplay(model);
      return `<option value="${escapeHtml(model)}" data-search="${escapeHtml(`${model} ${parts.provider} ${parts.name} ${parts.effort}`)}">${escapeHtml(model)}</option>`;
    })
    .join("");
  const modelFilterHtml = [
    `<div class="model-filter">`,
    `<label class="model-filter-field" for="model-filter-search"><span>Search models</span><input id="model-filter-search" type="search" autocomplete="off" placeholder="Model or provider" /></label>`,
    `<label class="model-filter-field" for="model-filter"><span>Selected models</span><select id="model-filter" multiple size="5">${modelOptions}</select></label>`,
    `<div class="model-filter-actions"><button type="button" id="model-filter-all">Select all</button><button type="button" id="model-filter-clear">Clear</button><span id="model-filter-status" class="muted" aria-live="polite">${fmtInt(modelRecords.length)} models</span><span id="model-filter-empty" class="muted" hidden>No models match</span></div>`,
    `</div>`,
  ].join("");

  const sourceRows = (
    database
      .prepare(
        `SELECT * FROM sources
         ORDER BY (input + output + reasoning + cache_read + cache_write) DESC, source ASC`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => {
    const t = totalsOf(r);
    return [
      String(r.source),
      compactCell(num(r.count)),
      compactCell(tokenTotal(t)),
      usdCell(t.cost),
      usdOrDashCell(t.costComputed),
    ];
  });

  const name = app.name || "opencode";
  const version = app.version ? ` v${app.version}` : "";
  const channel = app.channel ? ` · ${app.channel}` : "";
  const generated = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const cards: Array<[string, string, string, string]> = [
    ["Total tokens", fmtCompact(tokenTotal(life)), "c1", `in + out + cache${deltaText(windowTokens.life, windowTokens.prev)}`],
    ["Cost (reported)", fmtShortUsd(life.cost), "c2", `USD billed by the provider${deltaText(windowCost.life, windowCost.prev)}`],
    ["Cost (list price)", fmtShortUsdOrDash(life.costComputed), "c2", `API-equivalent USD${deltaText(windowCostComputed.life, windowCostComputed.prev)}`],
    ["Sessions", fmtCompact(sessions), "c3", "tracked"],
    ["Tool calls", fmtCompact(tools.calls), "c4", `${fmtCompact(tools.ok)} ok · ${fmtCompact(tools.fail)} failed${pending > 0 ? ` · ${fmtCompact(pending)} pending` : ""}`],
    ["Success rate", `${rate.toFixed(1)}%`, "c5", "completed calls"],
    ["Background", fmtCompact(bg.total), "c6", `${fmtShortUsd(bg.cost)} title + compaction`],
  ];
  const cardsHtml = cards
    .map(
      ([k, v, cls, s]) =>
        `<div class="kpi ${cls}"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span><span class="s">${escapeHtml(s)}</span></div>`,
    )
    .join("");

  const css = [
    ":root{--font-display:Georgia,'Iowan Old Style','Times New Roman',serif;--font-text:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;",
    "--step--1:0.75rem;--step-0:1rem;--step-1:1.333rem;--step-2:1.777rem;--step-3:2.369rem;--step-4:3.157rem;--step-5:4.209rem;",
    "--space-3xs:0.25rem;--space-2xs:0.5rem;--space-xs:0.75rem;--space-s:1rem;--space-m:1.5rem;--space-l:2rem;--space-xl:3rem;--space-2xl:4.5rem;--space-3xl:7rem;",
    "--base:#f4f1ea;--surface:#fdfcf7;--surface-2:#ece5d3;--line:#d9d1c1;--ink:#161310;--ink-2:#575046;--ink-3:#6b645a;",
    "--accent:#a92c1a;--accent-deep:#7e1f12;--ok:#1e6b3a;",
    "--hm0:#e5ddcb;--hm1:#d8b9a5;--hm2:#d08a6d;--hm3:#c15535;--hm4:#9e2a16;",
    "--radius:0;--shadow:none}",
    "@media (prefers-color-scheme:dark){:root{--base:#14110e;--surface:#1d1a15;--surface-2:#2a251d;--line:#38312a;--ink:#ece5d8;--ink-2:#b8ae9f;--ink-3:#9b9184;",
    "--accent:#e2603f;--accent-deep:#f08663;--ok:#5fce8a;",
    "--hm0:#26211b;--hm1:#4a2a20;--hm2:#7a3420;--hm3:#b04a2a;--hm4:#e2603f;",
    "--radius:0;--shadow:none}}",
    "*{box-sizing:border-box}",
    "html,body{margin:0}",
    "body{background:var(--base);color:var(--ink);font:400 var(--step-0)/1.55 var(--font-text);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}",
    ".wrap{max-width:76rem;margin:0 auto;padding:var(--space-m) var(--space-m) var(--space-2xl);counter-reset:section}",
    ".hero{border-top:4px solid var(--ink);padding-top:var(--space-xs);padding-bottom:var(--space-s);margin-bottom:var(--space-m);display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--space-2xs) var(--space-m);border-bottom:3px double var(--ink)}",
    ".brand{display:flex;align-items:baseline;gap:var(--space-xs)}",
    ".brand .dot{width:12px;height:12px;background:var(--ink);align-self:center}",
    ".brand .dot::after{content:'';display:block;width:12px;height:4px;background:var(--accent);margin-top:12px}",
    "h1{font-family:var(--font-display);font-weight:400;font-size:var(--step-3);line-height:1;margin:0;letter-spacing:-0.02em;text-wrap:balance}",
    ".meta{color:var(--ink-3);font-size:var(--step--1);line-height:1.4;margin:0;text-transform:uppercase;letter-spacing:.08em}",
    ".kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(11rem,100%),1fr));gap:0;margin:0 0 var(--space-xl);border-top:2px solid var(--ink);border-bottom:1px solid var(--ink);background:var(--surface)}",
    ".kpi{position:relative;background:transparent;border:0;border-left:1px solid var(--line);border-radius:0;padding:var(--space-xs) var(--space-s) var(--space-s);overflow:visible}",
    ".kpi:first-child{border-left:0;grid-column:1/-1}",
    ".kpi::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:var(--ink)}",
    ".kpi.c2::before{background:var(--accent)}",
    ".kpi.c3::before{background:var(--accent)}.kpi.c4::before{background:var(--ink)}",
    ".kpi.c5::before{background:var(--ok)}.kpi.c6::before{background:var(--accent)}",
    ".kpi .k{display:block;font-size:var(--step--1);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);line-height:1.4}",
    ".kpi .v{display:block;font-family:var(--font-text);font-size:var(--step-1);font-weight:700;letter-spacing:-0.01em;font-variant-numeric:tabular-nums lining-nums;margin-top:var(--space-3xs);line-height:1.1}",
    ".kpi:first-child .v{font-family:var(--font-display);font-weight:400;font-size:var(--step-4);letter-spacing:-0.02em;line-height:.95}",
    ".kpi.c2 .v,.kpi.c3 .v{color:var(--accent)}",
    ".kpi .s{display:block;font-size:var(--step--1);color:var(--ink-3);margin-top:var(--space-3xs);line-height:1.4}",
    ".panel{counter-increment:section;background:transparent;border:0;border-top:2px solid var(--ink);border-radius:0;padding:var(--space-s) 0 var(--space-l);margin-bottom:var(--space-xl)}",
    ".panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-xs);margin-bottom:var(--space-s);border-bottom:1px solid var(--line);padding-bottom:var(--space-2xs)}",
    ".panel-head h2{font-family:var(--font-text);font-size:var(--step--1);font-weight:700;margin:0;letter-spacing:.1em;text-transform:uppercase}",
    ".panel-head h2::before{content:'0' counter(section) ' — ';color:var(--accent);font-weight:400}",
    ".sub{color:var(--ink-3);font-size:var(--step--1)}",
    ".muted{color:var(--ink-3)}",
    ".grid2{display:grid;grid-template-columns:5fr 7fr;gap:var(--space-xl);min-width:0}",
    ".grid2>.panel{min-width:0}",
    "@media (max-width:60em){.grid2{grid-template-columns:1fr}.wrap{padding:var(--space-s) var(--space-s) var(--space-xl)}.kpi:first-child .v{font-size:var(--step-3)}}",
    ".hm-wrap{display:inline-block;max-width:100%;overflow-x:auto;padding-bottom:var(--space-2xs)}",
    ".hm-months{display:grid;gap:0;margin-left:30px;height:14px;font-size:10px;color:var(--ink-3);align-items:end;text-transform:uppercase;letter-spacing:.06em}",
    ".hm-months span{white-space:nowrap}",
    ".hm-body{display:flex;gap:6px;margin-top:4px}",
    ".hm-days{display:grid;grid-template-rows:repeat(7,24px);gap:0;width:24px;font-size:10px;color:var(--ink-3);text-align:right;line-height:24px}",
    ".hm-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,24px);gap:0}",
    ".hm-cell{position:relative;display:grid;place-items:center;width:24px;height:24px;background:transparent;border:0;cursor:pointer}",
    ".hm-cell::before{content:\"\";display:block;width:12px;height:12px;background:var(--hm0);border:1px solid var(--line);border-radius:0}",
    ".hm-out::before{background:transparent;border:1px dashed var(--line)}",
    ".hm-cell.hm-l0::before{background:var(--hm0)}.hm-cell.hm-l1::before{background:var(--hm1)}.hm-cell.hm-l2::before{background:var(--hm2)}.hm-cell.hm-l3::before{background:var(--hm3)}.hm-cell.hm-l4::before{background:var(--hm4)}",
    ".hm-legend{display:flex;align-items:center;gap:5px;margin-top:var(--space-s);font-size:11.5px;color:var(--ink-3)}",
    ".hm-legend i{width:12px;height:12px;border-radius:0;display:inline-block;border:1px solid var(--line)}",
    ".hm-max{margin-left:auto;font-variant-numeric:tabular-nums}",
    ".bars{display:block;width:100%;height:auto;overflow:visible}",
    ".bar{fill:var(--ink);opacity:1;cursor:pointer}.bar:hover,.bar:focus-visible{fill:var(--accent)}.bar:last-of-type{fill:var(--accent)}",
    ".hm-cell{cursor:pointer}",
    "[data-tooltip]{cursor:help}",
    ".usage-tooltip{position:fixed;z-index:100;width:min(30rem,calc(100vw - 1.5rem));max-height:min(32rem,calc(100vh - 1.5rem));overflow:auto;padding:var(--space-s) var(--space-m);background:var(--surface);border:1px solid var(--ink);border-left:3px solid var(--accent);box-shadow:5px 5px 0 var(--surface-2);color:var(--ink);font:400 var(--step--1)/1.55 var(--font-text);white-space:normal;overflow-wrap:anywhere;pointer-events:auto;overscroll-behavior:contain}",
    // Compact hover card for heatmap cells: headline plus a
    // small 2x2 stat grid, narrow enough that it never hides
    // the map. The full card still appears pinned (click)
    // and in the day-detail panel.
    ".usage-tooltip.mini{width:min(17rem,calc(100vw - 1.5rem));padding:var(--space-2xs) var(--space-s)}",
    ".usage-tooltip.mini .tt-sec{display:none}",
    ".tt-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2xs) var(--space-s);margin-top:var(--space-2xs)}",
    ".tt-cell b{display:block;font-size:var(--step--1);font-weight:400;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}",
    ".tt-cell span{font-family:var(--font-text);font-weight:700;font-variant-numeric:tabular-nums}",
    ".usage-tooltip[hidden]{display:none}",
    // Tooltip card structure: title row (day + headline value),
    // then labelled sections with inline values and detail rows.
    ".tt-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-xs);border-bottom:1px solid var(--ink);padding-bottom:var(--space-2xs);margin-bottom:var(--space-2xs)}",
    ".tt-day{font-family:var(--font-display);font-size:var(--step-1);letter-spacing:-0.01em}",
    ".tt-value{font-family:var(--font-text);font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap}",
    ".tt-value em{font-style:normal;font-weight:400;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;font-size:var(--step--1)}",
    ".tt-sec{margin-top:var(--space-xs)}",
    ".tt-sec h4{margin:0 0 1px;font-size:var(--step--1);font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}",
    ".tt-val{font-family:var(--font-text);margin:0;font-variant-numeric:tabular-nums}",
    ".tt-rows{list-style:none;margin:var(--space-3xs) 0 0;padding:0;display:grid;gap:1px;font-size:var(--step--1);font-family:var(--font-text)}",
    ".tt-row{margin:var(--space-3xs) 0 0;display:flex;flex-wrap:wrap;gap:0 var(--space-xs)}",
    ".tt-kv{white-space:nowrap}",
    ".tt-kv b{font-weight:400;color:var(--ink-3)}",
    ".gl{stroke:var(--line);stroke-width:1}",
    ".axis{fill:var(--ink-3);font-size:10.5px;font-family:var(--font-text);font-variant-numeric:tabular-nums}",
    ".axis-line{stroke:var(--ink);stroke-width:1}",
    ".tbl-wrap{overflow-x:auto;overscroll-behavior-x:contain}",
    ".tbl{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums lining-nums}",
    ".tbl th,.tbl td{padding:var(--space-2xs) var(--space-xs);border-bottom:1px solid var(--line);text-align:left;vertical-align:baseline}",
    ".tbl thead th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:700;border-bottom:1px solid var(--ink)}",
    ".tbl td.num,.tbl th.num{text-align:right;white-space:nowrap}",
    ".tbl tbody tr:last-child td{border-bottom:0}",
    ".model-filter{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-2xs);margin:0 0 var(--space-m)}",
    ".model-filter-field{display:grid;gap:var(--space-3xs);min-width:0}",
    ".model-filter-field>span{font-size:var(--step--1);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);line-height:1.4}",
    ".model-filter input,.model-filter select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:0;padding:var(--space-3xs) var(--space-2xs);min-width:0}",
    ".model-filter input{width:100%}",
    ".model-filter input:focus-visible,.model-filter select:focus-visible{outline:0;border-color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}",
    ".model-filter select{width:100%;min-height:6.5rem;max-height:11rem;border-color:var(--ink-2)}",
    ".model-filter-actions{display:flex;align-items:baseline;gap:var(--space-s);flex-wrap:wrap;padding-top:var(--space-3xs)}",
    ".model-filter-actions button{font:inherit;font-size:var(--step--1);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0 0 2px;cursor:pointer}",
    ".model-filter-actions button:hover,.model-filter-actions button:focus-visible{color:var(--ink);border-bottom-color:var(--ink)}",
    "#model-filter-status{margin-left:auto}",
    ".model-filter .muted{font-size:var(--step--1);color:var(--ink-3)}",
    "@media (max-width:60em){.model-filter-actions{gap:var(--space-s)}}",
    ".model-totals{margin:var(--space-s) 0 0;border-top:2px solid var(--ink);border-bottom:1px solid var(--line);padding:var(--space-2xs) 0}",
    ".model-totals[hidden]{display:none}",
    ".totals-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-3xs) var(--space-m);font-size:var(--step--1)}",
    ".totals-row>span{text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}",
    ".totals-row>b{font-family:var(--font-text);font-weight:700;color:var(--ink);font-size:var(--step-0);letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;border-bottom:1px dotted var(--ink-2);cursor:help}",
    ".totals-row>span:first-child>b{color:var(--ink-3);font-weight:400;border-bottom:0;cursor:default}",
    ".bg-panel{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--surface);padding:var(--space-s) var(--space-m);border-top:2px solid var(--ink)}",
    "p.sub{max-width:68ch}",
    ":focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    "footer{color:var(--ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;text-align:left;border-top:3px double var(--ink);padding:var(--space-xs) 0 0}",
    // First-run state: no rows at all yet. Keeps the hero so the page still
    // reads as ours, but replaces zeroed KPIs with an explanation instead of
    // a wall of 0s and empty tables.
    ".empty-state{display:grid;gap:var(--space-s);border-top:2px solid var(--ink);background:var(--surface);padding:var(--space-l) var(--space-m);margin-bottom:var(--space-xl)}",
    ".empty-state h2{font-family:var(--font-display);font-weight:400;font-size:var(--step-2);margin:0;line-height:1.1}",
    ".empty-state p{margin:0;max-width:68ch;color:var(--ink-2);font-size:var(--step-0)}",
    ".empty-state .hint{font-size:var(--step--1);color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}",
    // Metric toggle for the heatmap. aria-pressed carries the state for AT;
    // the filled style is the visual echo of it.
    ".metric-toggle{display:flex;gap:0;border:1px solid var(--ink);align-self:center}",
    ".metric-toggle button{font:inherit;font-size:var(--step--1);text-transform:uppercase;letter-spacing:.06em;color:var(--ink);background:transparent;border:0;border-left:1px solid var(--ink);border-radius:0;padding:var(--space-3xs) var(--space-2xs);cursor:pointer}",
    ".metric-toggle button:first-child{border-left:0}",
    ".metric-toggle button:hover,.metric-toggle button:focus-visible{background:var(--surface-2)}",
    ".metric-toggle button[aria-pressed=true]{background:var(--ink);color:var(--surface)}",
    // Persistent day breakdown: the tooltip pins on click, this keeps the
    // selected day's detail on the page after the tooltip dismisses.
    ".day-detail{margin-top:var(--space-s);border:1px solid var(--line);border-left:3px solid var(--accent);border-top:2px solid var(--ink);background:var(--surface);padding:var(--space-s);font:400 var(--step--1)/1.55 var(--font-text);white-space:pre-wrap;overflow-wrap:anywhere}",
    ".day-detail[hidden]{display:none}",
    // Sticky headers only where the table actually scrolls internally;
    // otherwise the header would stick to a container that never scrolls.
    ".tbl-wrap.tall{max-height:65vh;overflow:auto}",
    ".tbl-wrap.tall thead th{position:sticky;top:0;z-index:1;background:var(--surface);box-shadow:inset 0 -1px 0 var(--ink)}",
  ].join("\n");

  const tooltipScript = [
    `<script>`,
    `(function(){`,
    `function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}`,
    `function kvRow(line){var out="";var re=/([a-z_]+)=(\\S+)/g;var m;var any=false;while((m=re.exec(line))!==null){any=true;out+='<span class="tt-kv"><b>'+esc(m[1])+"</b> "+esc(m[2])+"</span>";}return any?'<p class="tt-row">'+out+"</p>":null;}`,
    // Parse the plain-text tooltip into a titled, sectioned card.
    // Line 1 is the headline ("2026-10-01 — 7.6k tokens" or
    // "2026-10-01: 7615 tokens"); lines like "Tokens: 7615 total"
    // open a labelled section; two-space-indented lines are detail
    // rows, with a=b pairs rendered as key/value chips.
    `function renderTip(text){`,
    `  var lines=String(text).split("\\n");`,
    `  var head=lines[0]||"";`,
    `  var sep=head.match(/\\s—\\s|: /);`,
    `  var day=head,rest=head;`,
    `  if(sep){var i=head.indexOf(sep[0]);day=head.slice(0,i);rest=head.slice(i+sep[0].length);}`,
    `  var words=rest.split(/\\s+/).filter(Boolean);`,
    `  var metric=words.length>1?words[words.length-1]:"";`,
    `  var value=words.slice(0,words.length>1?-1:words.length).join(" ");`,
    `  var parts=['<div class="tt-head"><span class="tt-day">'+esc(day)+'</span><span class="tt-value">'+esc(value)+(metric?" <em>"+esc(metric)+"</em>":"")+"</span></div>"];`,
    `  var secs=[];`,
    `  for(var i=1;i<lines.length;i++){`,
    `    var l=lines[i];`,
    `    if(!l)continue;`,
    `    if(l.indexOf("  ")===0){`,
    `      var s=secs[secs.length-1];`,
    `      if(!s){parts.push("<p>"+esc(l.trim())+"</p>");continue;}`,
    `      var kv=kvRow(l);`,
    `      s.rows.push(kv?kv:"<li>"+esc(l.trim())+"</li>");`,
    `    }else{`,
    `      var idx=l.indexOf(":");`,
    `      secs.push({title:idx>=0?l.slice(0,idx):l,val:idx>=0?l.slice(idx+1).trim():"",rows:[]});`,
    `    }`,
    `  }`,
    `  for(var j=0;j<secs.length;j++){`,
    `    var sec=secs[j];`,
    `    parts.push('<div class="tt-sec"><h4>'+esc(sec.title)+"</h4>"+(sec.val?'<p class="tt-val">'+esc(sec.val)+"</p>":"")+(sec.rows.length?'<ul class="tt-rows">'+sec.rows.join("")+"</ul>":"")+"</div>");`,
    `  }`,
    `  return parts.join("");`,
    `}`,
    // Compact card for heatmap hovers: headline plus a
    // 2x2 stat grid (tokens / cost / calls / models).
    // Full detail stays one click away in the pinned card.
    `function renderMini(text){`,
    `  var lines=String(text).split("\\n");`,
    `  var head=lines[0]||"";`,
    `  var sep=head.match(/\\s—\\s|: /);`,
    `  var day=head,rest=head;`,
    `  if(sep){var i=head.indexOf(sep[0]);day=head.slice(0,i);rest=head.slice(i+sep[0].length);}`,
    `  var words=rest.split(/\\s+/).filter(Boolean);`,
    `  var metric=words.length>1?words[words.length-1]:"";`,
    `  var value=words.slice(0,words.length>1?-1:words.length).join(" ");`,
    `  var stats={};`,
    `  for(var i=1;i<lines.length;i++){`,
    `    var l=lines[i];`,
    `    if(!l||l.indexOf("  ")===0)continue;`,
    `    var idx=l.indexOf(":");`,
    `    if(idx<0)continue;`,
    `    stats[l.slice(0,idx)]=l.slice(idx+1).trim();`,
    `  }`,
    `  var cell=function(label,val){return val?'<div class="tt-cell"><b>'+esc(label)+'</b><span>'+esc(val)+"</span></div>":"";};`,
    `  return '<div class="tt-head"><span class="tt-day">'+esc(day)+'</span><span class="tt-value">'+esc(value)+(metric?" <em>"+esc(metric)+"</em>":"")+"</span></div>"+`,
    `    '<div class="tt-grid">'+`,
    `    cell("Tokens",(stats.Tokens||"").replace(/ total$/,""))+`,
    `    cell("Cost",(stats.Cost||"").replace(/ reported$/,""))+`,
    `    cell("Tool calls",(stats.Tools||"").replace(/ calls.*/,""))+`,
    `    cell("Models",(stats.Models||"").replace(/ used$/,""))+`,
    `    "</div>";`,
    `}`,
    `window.__renderTip=renderTip;`,
    `var tooltip=document.getElementById("usage-tooltip");`,
    `if(!tooltip)return;`,
    `var active=null;`,
    `var pinned=false;`,
    `var returnFocus=null;`,
    `var returning=false;`,
    `var hideTimer;`,
    `function position(target,mini){tooltip.style.left="0px";tooltip.style.top="0px";var box=target.getBoundingClientRect();var gap=10;var edge=12;var width=tooltip.offsetWidth;var height=tooltip.offsetHeight;var left;var top;`,
    `  if(mini){`,
    `    // Side placement: a compact card to the right (or`,
    `    // left) of the cell so it never covers the map.`,
    `    left=box.right+gap;`,
    `    if(left+width>window.innerWidth-edge)left=box.left-width-gap;`,
    `    if(left<edge)left=Math.max(edge,box.left+box.width/2-width/2);`,
    `    top=box.top+box.height/2-height/2;`,
    `  }else{`,
    `    left=box.left+box.width/2-width/2;`,
    `    top=box.bottom+gap;`,
    `    left=Math.max(edge,Math.min(left,window.innerWidth-width-edge));`,
    `    if(top+height>window.innerHeight-edge)top=box.top-height-gap;`,
    `  }`,
    `  top=Math.max(edge,Math.min(top,window.innerHeight-height-edge));`,
    `  tooltip.style.left=left+"px";tooltip.style.top=top+"px";}`,
    `function hide(){var focusTarget=returnFocus;var restoreFocus=!!(focusTarget&&document.activeElement===tooltip);if(active)active.removeAttribute("aria-describedby");active=null;pinned=false;returnFocus=null;tooltip.hidden=true;tooltip.setAttribute("aria-hidden","true");if(restoreFocus){returning=true;focusTarget.focus();setTimeout(function(){returning=false;},0);}}`,
    `function show(target,pin,keyboard){var text=target.getAttribute("data-tooltip");if(!text||returning)return;clearTimeout(hideTimer);if(active&&active!==target)active.removeAttribute("aria-describedby");active=target;pinned=pin===true;returnFocus=keyboard?target:null;var mini=target.classList.contains("hm-cell")&&!pinned;tooltip.classList.toggle("mini",mini);tooltip.innerHTML=mini?renderMini(text):renderTip(text);tooltip.hidden=false;tooltip.setAttribute("aria-hidden","false");target.setAttribute("aria-describedby","usage-tooltip");position(target,mini);if(keyboard)tooltip.focus();}`,
    `function scheduleHide(){clearTimeout(hideTimer);hideTimer=setTimeout(function(){if(!pinned&&document.activeElement!==active&&!tooltip.matches(":hover"))hide();},120);}`,
    `function toggle(target,keyboard){if(active===target&&pinned)hide();else show(target,true,keyboard);}`,
    `function bind(target){target.addEventListener("mouseenter",function(){show(target,false);});target.addEventListener("mouseleave",function(){scheduleHide();});target.addEventListener("focus",function(){if(target.classList.contains("hm-cell"))setHeatIndex(target);if(!returning)show(target,false);});target.addEventListener("blur",function(){scheduleHide();});target.addEventListener("click",function(event){event.stopPropagation();toggle(target,false);});target.addEventListener("keydown",function(event){if(event.key==="Escape"){hide();}else if(event.key==="Enter"||event.key===" "){event.preventDefault();toggle(target,true);}});}`,
    `var heatCells=Array.prototype.slice.call(document.querySelectorAll(".hm-grid .hm-cell"));`,
    `var heatIndex=0;`,
    `function setHeatIndex(target){var index=heatCells.indexOf(target);if(index<0)return;heatIndex=index;heatCells.forEach(function(cell,i){cell.tabIndex=i===heatIndex?0:-1;});}`,
    `function focusHeatCell(index){if(!heatCells.length)return;heatIndex=Math.max(0,Math.min(heatCells.length-1,index));setHeatIndex(heatCells[heatIndex]);heatCells[heatIndex].focus();}`,
    `if(heatCells.length){heatCells.forEach(function(cell){cell.tabIndex=-1;});heatCells[0].tabIndex=0;heatCells.forEach(function(cell,index){cell.addEventListener("keydown",function(event){var next=index;if(event.key==="ArrowLeft")next--;else if(event.key==="ArrowRight")next++;else if(event.key==="ArrowUp")next-=7;else if(event.key==="ArrowDown")next+=7;else if(event.key==="Home")next=0;else if(event.key==="End")next=heatCells.length-1;else return;event.preventDefault();focusHeatCell(next);});});}`,
    `document.querySelectorAll("[data-tooltip]").forEach(bind);`,
    `function updateScrollableTables(){document.querySelectorAll(".tbl-wrap").forEach(function(wrapper){if(wrapper.scrollWidth>wrapper.clientWidth){var panel=wrapper.closest(".panel");var heading=panel&&panel.querySelector("h2");wrapper.tabIndex=0;wrapper.setAttribute("role","region");wrapper.setAttribute("aria-label",heading?heading.textContent+" table, scrollable":"Scrollable table");}else{wrapper.removeAttribute("tabindex");wrapper.removeAttribute("role");wrapper.removeAttribute("aria-label");}});}`,
    `updateScrollableTables();`,
    `tooltip.addEventListener("mouseenter",function(){clearTimeout(hideTimer);});`,
    `tooltip.addEventListener("mouseleave",function(){scheduleHide();});`,
    `document.addEventListener("click",function(event){if(!(event.target instanceof Element)||(!event.target.closest("[data-tooltip]")&&!tooltip.contains(event.target)))hide();});`,
    `document.addEventListener("keydown",function(event){if(event.key==="Escape")hide();});`,
    `window.addEventListener("resize",function(){updateScrollableTables();if(active)position(active);});`,
    `})();`,
    `</script>`,
  ].join("\n");

  const modelFilterScript = [
    `<script>`,
    `(function(){`,
    `var search=document.getElementById("model-filter-search");`,
    `var select=document.getElementById("model-filter");`,
    `var all=document.getElementById("model-filter-all");`,
    `var clear=document.getElementById("model-filter-clear");`,
    `var status=document.getElementById("model-filter-status");`,
    `var empty=document.getElementById("model-filter-empty");`,
    `var table=document.getElementById("models-table");`,
    `if(!search||!select||!all||!clear||!status||!empty||!table)return;`,
    `var rows=Array.prototype.slice.call(table.querySelectorAll("tbody tr[data-model]"));`,
    `var allOptions=Array.prototype.slice.call(select.options);`,
    `var selectedValues=new Set();`,
    `var totalsBox=document.getElementById("model-totals");`,
    `var totalsEls={count:document.getElementById("model-totals-count"),tokens:document.getElementById("model-totals-tokens"),cost:document.getElementById("model-totals-cost"),list:document.getElementById("model-totals-list"),events:document.getElementById("model-totals-events")};`,
    `function matchesOption(option,query){return !query||(option.getAttribute("data-search")||"").toLowerCase().indexOf(query)>=0;}`,
    `function updateOptions(){var query=search.value.trim().toLowerCase();var fragment=document.createDocumentFragment();var matches=0;allOptions.forEach(function(option){if(!matchesOption(option,query))return;matches++;option.selected=selectedValues.has(option.value);option.disabled=false;fragment.appendChild(option);});select.textContent="";select.appendChild(fragment);return matches;}`,
    `function selectedModels(){return Array.from(selectedValues);}`,
    // Same compact/grouped formatting the server uses, so a totals row reads
    // like the cells it sums. Exact values go in the title for hover.
    `function fmtCompact(n){n=Math.round(n);if(Math.abs(n)>=1e9)return (n/1e9).toFixed(1).replace(/\\.0$/,"")+"b";if(Math.abs(n)>=1e6)return (n/1e6).toFixed(1).replace(/\\.0$/,"")+"m";if(Math.abs(n)>=1e3)return (n/1e3).toFixed(1).replace(/\\.0$/,"")+"k";return String(n);}`,
    `function fmtInt(n){return Math.round(n).toLocaleString("en-US");}`,
    `function fmtUsd(n){return n===0?"$0":"$"+(Math.abs(n)<1?n.toFixed(4):n.toFixed(2));}`,
    // Sum the rows that survived the filter. The exact figures ride along in
    // data-* attributes the server rendered next to each row.
    `function updateTotals(visible){`,
    `  if(!totalsBox)return;`,
    `  if(!visible){totalsBox.hidden=true;return;}`,
    `  var t=0,c=0,l=0,e=0;`,
    `  rows.forEach(function(row){`,
    `    if(row.hidden)return;`,
    `    t+=Number(row.getAttribute("data-tokens"))||0;`,
    `    c+=Number(row.getAttribute("data-cost"))||0;`,
    `    l+=Number(row.getAttribute("data-list"))||0;`,
    `    e+=Number(row.getAttribute("data-events"))||0;`,
    `  });`,
    `  totalsBox.hidden=false;`,
    `  totalsEls.count.textContent=visible+(visible===1?" model":" models");`,
    `  totalsEls.tokens.textContent=fmtCompact(t);totalsEls.tokens.title=fmtInt(t)+" tokens";`,
    `  totalsEls.cost.textContent=fmtUsd(c);totalsEls.cost.title="$"+c.toFixed(6);`,
    `  totalsEls.list.textContent=fmtUsd(l);totalsEls.list.title="$"+l.toFixed(6);`,
    `  totalsEls.events.textContent=fmtCompact(e);totalsEls.events.title=fmtInt(e)+" events";`,
    `}`,
    `function apply(){var query=search.value.trim().toLowerCase();var matches=updateOptions();var selected=selectedModels();var selectedSet=new Set(selected);var visible=0;rows.forEach(function(row){var match=selected.length===0||selectedSet.has(row.getAttribute("data-model"));row.hidden=!match;if(match)visible++;});var noResults=query!==""&&matches===0;empty.hidden=!noResults;status.textContent=noResults?"No models match":selected.length?(selected.length+" of "+allOptions.length+" models selected"):(visible===1?"1 model":visible+" models");updateTotals(visible);}`,
    `search.addEventListener("input",apply);`,
    `select.addEventListener("change",function(){Array.prototype.slice.call(select.options).forEach(function(option){if(option.selected)selectedValues.add(option.value);else selectedValues.delete(option.value);});apply();});`,
    `all.addEventListener("click",function(){var query=search.value.trim().toLowerCase();allOptions.forEach(function(option){if(matchesOption(option,query))selectedValues.add(option.value);});apply();});`,
    `clear.addEventListener("click",function(){selectedValues.clear();apply();});`,
    `apply();`,
    `})();`,
    `</script>`,
  ].join("\n");

  // Metric switch for the heatmap + click-through day detail. Both operate
  // purely on data already embedded above, so switching is instant.
  const heatmapToggleScript = [
    `<script>`,
    `(function(){`,
    `function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}`,
    `var toggle=document.querySelector(".metric-toggle");`,
    `if(!toggle)return;`,
    `var cells=Array.prototype.slice.call(document.querySelectorAll(".hm-grid .hm-cell"));`,
    `var peak=document.querySelector(".hm-max");`,
    `var sub=document.querySelector("[data-hm-sub]");`,
    `var btns=Array.prototype.slice.call(toggle.querySelectorAll("button"));`,
    `var current="tokens";`,
    `var tooltip=document.getElementById("usage-tooltip");`,
    `var detail=document.getElementById("day-detail");`,
    `function firstLine(cell,metric){var day=cell.getAttribute("data-day");var v=cell.getAttribute("data-v-"+metric)||"";return day+" — "+v+" "+metric;}`,
    `function setMetric(metric){`,
    `  if(!metric)return;current=metric;`,
    `  btns.forEach(function(b){b.setAttribute("aria-pressed",b.getAttribute("data-metric")===metric?"true":"false");});`,
    `  cells.forEach(function(cell){`,
    `    if(cell.classList.contains("hm-out"))return;`,
    `    var lv=cell.getAttribute("data-lv-"+metric)||"0";`,
    `    cell.className="hm-cell hm-l"+lv;`,
    `    var full=cell.getAttribute("data-tooltip")||"";`,
    `    var nl=full.indexOf("\\n");`,
    `    cell.setAttribute("data-tooltip",firstLine(cell,metric)+(nl>=0?full.slice(nl):""));`,
    `    if(detail&&!detail.hidden&&detail.getAttribute("data-day")===cell.getAttribute("data-day"))refreshDetail(cell);`,
    `  });`,
    `  if(peak)peak.textContent="peak "+(peak.getAttribute("data-peak-"+metric)||"");`,
    `  if(sub)sub.textContent=sub.textContent.replace(/metric: \\S+$/,"metric: "+metric);`,
    `  if(tooltip&&tooltip.getAttribute("aria-hidden")==="false"){`,
    `    var focused=document.activeElement;`,
    `    if(focused&&focused.classList&&focused.classList.contains("hm-cell")){`,
    `      var t=focused.getAttribute("data-tooltip");if(t)tooltip.textContent=t;`,
    `    }`,
    `  }`,
    `}`,
    `function refreshDetail(cell){if(!detail)return;var t=cell.getAttribute("data-tooltip")||"";detail.innerHTML=window.__renderTip?window.__renderTip(t):esc(t);detail.setAttribute("data-day",cell.getAttribute("data-day")||"");}`,
    `btns.forEach(function(b){b.addEventListener("click",function(){setMetric(b.getAttribute("data-metric"));});});`,
    `cells.forEach(function(cell){cell.addEventListener("click",function(){if(!detail)return;refreshDetail(cell);detail.hidden=false;});});`,
    `})();`,
    `</script>`,
  ].join("\n");

  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    ...(cfg.autoRefreshSec > 0
      ? [`<meta http-equiv="refresh" content="${cfg.autoRefreshSec}"/>`]
      : []),
    `<title>${escapeHtml(`${name} usage stats`)}</title>`,
    `<style>${css}</style>`,
    "</head><body>",
    `<div class="wrap">`,
    `<header class="hero">`,
    `<div class="brand"><span class="dot"></span><h1>Usage stats</h1></div>`,
    `<p class="meta">${escapeHtml(name)} ${escapeHtml(version)} · ${escapeHtml(channel)} · generated ${escapeHtml(generated)}</p>`,
    `</header>`,
    `<section class="kpis">${cardsHtml}</section>`,
    ...(!usageRecorded ? [firstRunHtml] : [
    `<section class="panel">`,
    `<div class="panel-head"><h2>Activity</h2><span class="sub" data-hm-sub>last ${grid.weeks} weeks · metric: ${escapeHtml(grid.metric)}</span>${metricToggleHtml(grid.metric)}</div>`,
    buildHeatmapHtml(grid, breakdowns, cfg.includeBackground),
    `<div class="day-detail" id="day-detail" role="region" aria-live="polite" aria-label="Selected day breakdown" hidden></div>`,
    `</section>`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Activity per day</h2><span class="sub">last 30 days · metric: ${escapeHtml(cfg.heatmapMetric)}</span></div>`,
    buildBarChartHtml(recent, cfg.includeBackground, cfg.heatmapMetric),
    `</section>`,
    `<div class="grid2">`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Top tools</h2></div>`,
    tableHtml(["tool", "calls", "ok", "failed", "avg", "max"], toolRows),
    `</section>`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Models</h2><span class="sub">$/M list rates</span></div>`,
    modelFilterHtml,
    tableHtml(
      ["model", "effort", "provider", "in $/M", "out $/M", "tokens", "cost", "cost (list)", "events"],
      modelRows,
      modelAttributes,
      "models-table",
    ),
    `<!-- Totals for the currently filtered models. The filter script fills
         this in and un-hides it as soon as at least one row is visible; the
         values carry the exact figure in a title, matching the cells. -->
    <div class="model-totals" id="model-totals" hidden>
      <div class="totals-row" role="group" aria-label="Filtered model totals">
        <span>models <b id="model-totals-count"></b></span>
        <span>tokens <b id="model-totals-tokens"></b></span>
        <span>cost <b id="model-totals-cost"></b></span>
        <span>list <b id="model-totals-list"></b></span>
        <span>events <b id="model-totals-events"></b></span>
      </div>
    </div>
  </section>`,
    `</div>`,
    `<section class="panel bg-panel">`,
    `<!-- background -->`,
    `<div class="panel-head"><h2>Background usage</h2><span class="sub">title + compaction</span></div>`,
    `<p class="sub">Hidden spend recorded outside the main session counters: <b>${escapeHtml(fmtCompact(bg.total))}</b> tokens · <b>${escapeHtml(fmtShortUsd(bg.cost))}</b>.</p>`,
    tableHtml(["source", "events", "tokens", "cost", "cost (list)"], sourceRows),
    `</section>`,
    ]),
    `<p class="sub">List-price cost is computed from the provider's published per-million-token rates. ` +
      `Subscription plans (e.g. opencode Zen or a flat account) may report <b>$0</b> billed while the ` +
      `list-price column shows the API-equivalent value. Unknown prices render <b>—</b>, never $0.</p>`,
    `<footer>lifetime: ${escapeHtml(lifetimeSummaryLine(database))} · usage-stats</footer>`,
    `</div>`,
    `<div id="usage-tooltip" class="usage-tooltip" role="tooltip" tabindex="-1" aria-hidden="true" hidden></div>`,
    tooltipScript,
    modelFilterScript,
    heatmapToggleScript,
    "</body></html>",
  ].join("\n");
}

function renderDashboard(
  database: AnyDatabase,
  cfg: Config,
  app: AppInfo,
  state: UsageState,
): { path: string; bytes: number; summary: string } {
  const html = buildDashboardHtml(database, cfg, app, state);
  // US-5: intentionally synchronous — this runs on the render path (command
  // or 60s interval), writes a single small file, and keeping it sync avoids
  // interleaved dashboard writes from overlapping renders.
  mkdirSync(cfg.dir, { recursive: true });
  const path = join(cfg.dir, DASHBOARD_NAME);
  writeFileSync(path, html, "utf8");
  return { path, bytes: Buffer.byteLength(html, "utf8"), summary: lifetimeSummaryLine(database) };
}

/**
 * Open a file in the OS default browser, straight from the server process. This
 * is what makes `/stats` free: the command opens the dashboard itself instead of
 * asking the model to do it (which would spend tokens). Set
 * OPENCODE_USAGE_STATS_NO_OPEN=1 to suppress (headless/test environments).
 */
type OpenResult = { opened: boolean; path: string; error?: string };

function openInBrowser(filePath: string): OpenResult {
  if (process.env.OPENCODE_USAGE_STATS_NO_OPEN) {
    return { opened: false, path: filePath, error: "OPENCODE_USAGE_STATS_NO_OPEN is set" };
  }
  try {
    // US-2: never pass the path through a shell (cmd /c start re-parses
    // metacharacters such as `&` — a command-injection vector). Launch the
    // opener directly with an argv list, and swallow async spawn failures so
    // they cannot crash the host as an unhandled "error" event.
    const child =
      process.platform === "win32"
        ? spawn("powershell", ["-NoProfile", "-Command", "Start-Process", "-FilePath", filePath], {
            detached: true,
            stdio: "ignore",
          })
        : process.platform === "darwin"
          ? spawn("open", [filePath], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`[usage-stats] failed to open ${filePath}: ${String(err)}`);
    });
    child.unref?.();
    return { opened: true, path: filePath };
  } catch (err) {
    return { opened: false, path: filePath, error: String(err) };
  }
}

// --- E41/E42/E43/E45 helpers -----------------------------------------------

/** Escape a value for CSV output per RFC 4180. */
function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Convert rows to CSV with a header row. */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n");
}

/**
 * Parse a date string to a day key (YYYY-MM-DD). Accepts ISO dates and "Nd"
 * relative spans.
 * US-6: a bare YYYY-MM-DD input is already a day key — pass it through after
 * validation instead of round-tripping through Date + local getters, which
 * shifted the day backwards in UTC-x timezones (a UTC-8 server asked for
 * "2026-10-01" got "2026-09-30"). "Nd" spans exactly N days inclusive:
 * "7d" starts 6 days back so [start, today] covers 7 days.
 */
function parseDayKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const s = value.trim();
  const rel = /^(\d+)d$/i.exec(s);
  if (rel) {
    return dayKey(shiftDays(new Date(), -(Math.max(1, Number(rel[1])) - 1)));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Validate the calendar date (rejects 2026-02-30) then pass it through.
    const d = new Date(`${s}T00:00:00Z`);
    return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : s;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return dayKey(d);
  }
  return undefined;
}

export default Plugin.define({
  id: "usage-stats",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options);
    if (!cfg.enabled) return () => {};
    // US-1: per-setup state (db handle, pricing, dirty flag, session
    // models, in-flight calls) — never module-level.
    const state = createState();

    const log = (message: string): void => {
      if (cfg.log) console.error(`[usage-stats] ${message}`);
    };
    const database = (): AnyDatabase => getDb(state, cfg);
    const app = (ctx.app ?? {}) as AppInfo;

    try {
      getDb(state, cfg);
    } catch (err) {
      // US-7: unconditional (not cfg.log-gated), rate-limited — a dead db
      // must not silently stop recording.
      logDbError(`db init failed: ${String(err)}`);
      log(`db init failed: ${String(err)}`);
    }

    const timers: Array<ReturnType<typeof setInterval>> = [];

    const render = (): void => {
      try {
        renderDashboard(database(), cfg, app, state);
        state.dirty = false;
      } catch (err) {
        log(`dashboard render failed: ${String(err)}`);
      }
    };

    // Price list: fetch once at startup, then refresh periodically.
    state.priceOverrides = parsePriceOverrides(cfg.prices);
    if (state.priceOverrides.size > 0) log(`price overrides loaded for ${state.priceOverrides.size} model(s)`);
    await refreshPricing(ctx, log, state, true);
    if (cfg.pricingRefreshMin > 0) {
      const timer = setInterval(() => {
        void refreshPricing(ctx, log, state);
      }, cfg.pricingRefreshMin * 60_000);
      timer.unref?.();
      timers.push(timer);
    }

    // Render once at startup, then re-render in the background when data changed.
    try {
      database();
      render();
      if (cfg.openOnStart) openInBrowser(join(cfg.dir, DASHBOARD_NAME));
    } catch {
      /* db unavailable */
    }
    if (cfg.autoRefreshSec > 0) {
      const timer = setInterval(() => {
        if (state.dirty) render();
      }, cfg.autoRefreshSec * 1000);
      timer.unref?.();
      timers.push(timer);
    }

    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    registrations.push(
      await ctx.tool.hook("execute.before", (event) => {
        try {
          const key = String(event.id ?? "");
          if (!key) return;
          // U5/US-6: sweep orphaned entries (execute.after never arrived) so the
          // map cannot grow without bound in long-lived servers. The full
          // scan is threshold-gated — it only runs when the map is large or
          // a minute has passed since the last sweep, not on every tool call.
          // US-7/TA-6: a swept entry is first marked duration-unknown (a late
          // execute.after still records the call, just without a duration);
          // only entries left orphaned for hours after that mark are dropped,
          // keeping the map bounded.
          const now = Date.now();
          if (state.pending.size > 500 || now - state.lastPendingSweep > 60_000) {
            state.lastPendingSweep = now;
            const markCutoff = now - 600_000;
            const dropCutoff = now - 6 * 3_600_000;
            for (const [k, v] of state.pending) {
              if (!v.unknownDuration) {
                if (v.startedMs < markCutoff) v.unknownDuration = true;
              } else if (v.startedMs < dropCutoff) {
                // US-7/TA-6: dropping the entry must not lose the call.
                // Remember the id (bounded, oldest-first) so a very late
                // execute.after is still recorded with a null duration
                // instead of being silently discarded.
                state.pending.delete(k);
                state.sweptPending.add(k);
              }
            }
            // Keep the swept-id memory bounded like `pending` itself. The
            // cap is generous: a forgotten id only degrades back to the old
            // "drop very late after" behaviour, never to a wrong duration.
            while (state.sweptPending.size > PENDING_SWEEP_ID_CAP) {
              const oldest = state.sweptPending.values().next();
              if (oldest.done) break;
              state.sweptPending.delete(oldest.value);
            }
          }
          // US-6: sweep stale sessionModels entries so the map cannot grow
          // without bound in long-lived servers. Same threshold-gated pattern
          // as the pending sweep above.
          if (state.sessionModels.size > 500 || now - state.lastSessionModelsSweep > 60_000) {
            state.lastSessionModelsSweep = now;
            const cutoff = now - 600_000;
            for (const [k, v] of state.sessionModels) {
              if (v.updatedMs < cutoff) state.sessionModels.delete(k);
            }
          }
          // US-3: capture the session id so execute.after can attribute the
          // call to a session even when its own event carries no sessionID.
          state.pending.set(key, {
            tool: String(event.tool ?? "unknown"),
            startedMs: Date.now(),
            sessionID: String((event as { sessionID?: unknown }).sessionID ?? ""),
          });
        } catch (err) {
          // US-2: recording-path failures are always reported (rate-limited),
          // never hidden behind the optional cfg.log flag.
          logDbError(`execute.before failed: ${String(err)}`);
        }
      }),
    );

    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        try {
          const key = String(event.id ?? "");
          const entry = key ? state.pending.get(key) : undefined;
          if (entry) state.pending.delete(key);
          // US-7/TA-6: a call whose entry the sweep already evicted still has
          // to be counted. Before this, `if (!entry) return` dropped it, so a
          // call outliving the TTL never reached tool_totals/daily.tool_calls.
          // The duration is unknown here (no retained startedMs), so record a
          // null duration: it counts toward calls/ok/fail and is excluded from
          // every duration aggregate.
          const swept = !entry && key !== "" && state.sweptPending.delete(key);
          if (!entry && !swept) return;
          const tool = String(event.tool ?? entry?.tool ?? "unknown");
          // US-7/TA-6: a swept (unknown-duration) entry still records the
          // call — with a null duration instead of a bogus number.
          const duration = entry && !entry.unknownDuration ? Date.now() - entry.startedMs : null;
          const status = String((event as { status?: unknown }).status ?? "completed");
          // US-3: prefer the after event's sessionID, fall back to the one
          // captured at execute.before (some hosts only send it there).
          const sessionID =
            String((event as { sessionID?: unknown }).sessionID ?? "") || entry?.sessionID || "";
          recordToolCall(database(), tool, status === "completed", duration, sessionID, state);
        } catch (err) {
          logDbError(`execute.after failed: ${String(err)}`);
        }
      }),
    );

    const abort = new AbortController();
    const pump = (async (): Promise<void> => {
      try {
        state.eventPumpAlive = true;
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          const ev = raw as unknown as { type?: string; data?: Record<string, unknown> };
          const data = (ev.data ?? {}) as Record<string, unknown>;
          const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
          try {
            switch (ev.type) {
              case "session.usage.updated":
                // U6: pass the event's model along so attribution doesn't
                // depend on the racy session_state.model fallback.
                if (sessionID) {
                  recordUsageUpdated(database(), sessionID, data.tokens, data.cost, data.model, state);
                }
                break;
              case "session.usage.recorded":
                if (sessionID) {
                  recordUsageRecorded(
                    database(),
                    sessionID,
                    String(data.source ?? "unknown"),
                    data.tokens,
                    data.cost,
                    state,
                  );
                }
                break;
              case "session.model.selected":
                if (sessionID) rememberModel(state, sessionID, modelKey(data.model));
                break;
              case "session.created":
                if (sessionID) recordSessionCreated(database(), sessionID, state);
                break;
              default:
                break;
            }
            prune(state, cfg, false);
          } catch (err) {
            // US-2: data-path failures surface unconditionally (rate-limited)
            // even with options.log=false; the chatty info logs elsewhere stay
            // behind cfg.log.
            logDbError(`event ${String(ev.type)} failed: ${String(err)}`);
          }
        }
      } catch (err) {
        state.eventPumpAlive = false;
        logDbError(`event pump stopped: ${String(err)}`);
      }
    })();
    void pump;

    // Reliable model attribution: every request carries the model, including the
    // initial one (which `session.model.selected` does not announce).
    try {
      registrations.push(
        await ctx.session.hook("http.request", (event) => {
          try {
            if (event?.sessionID && event.model) {
              rememberModel(state, String(event.sessionID), modelKey(event.model));
            }
          } catch (err) {
            logDbError(`http.request model attribution failed: ${String(err)}`);
          }
        }),
      );
    } catch (err) {
      log(`http.request hook unavailable: ${String(err)}`);
    }

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "stats_summary",
          description:
            "Lifetime and today token/cost/tool accounting, including background (title/compaction) spend.",
          input: z.object({}),
          execute: async () => {
            try {
              return { content: summaryText(database()) };
            } catch (err) {
              return { content: `stats_summary failed: ${String(err)}` };
            }
          },
        });

        editor.add({
          name: "stats_tools",
          description: "Per-tool calls, success/failure counts and durations, sorted by call count.",
          input: z.object({
            limit: z.number().int().positive().max(500).optional().describe("Max tools (default 20)"),
          }),
          execute: async (input) => {
            const args = input as { limit?: number };
            const limit = Math.min(Math.max(args.limit ?? 20, 1), 500);
            try {
              return { content: toolsText(database(), limit) };
            } catch (err) {
              return { content: `stats_tools failed: ${String(err)}` };
            }
          },
        });

        editor.add({
          name: "stats_tokens",
          description: "Per-day and per-model token and cost breakdown.",
          input: z.object({
            days: z.number().int().positive().max(3650).optional().describe("Days to show (default 30)"),
          }),
          execute: async (input) => {
            const args = input as { days?: number };
            const days = Math.min(Math.max(args.days ?? 30, 1), 3650);
            try {
              return { content: tokensText(database(), days) };
            } catch (err) {
              return { content: `stats_tokens failed: ${String(err)}` };
            }
          },
        });

        editor.add({
          name: "stats_heatmap",
          description: "Unicode contribution heatmap of usage over the last N weeks, with a legend.",
          input: z.object({
            weeks: z.number().int().positive().max(104).optional().describe("Weeks to show (default from config)"),
            metric: z.enum(["tokens", "cost", "calls"]).optional().describe("Metric to chart"),
          }),
          execute: async (input) => {
            const args = input as { weeks?: number; metric?: HeatMetric };
            const weeks = effectiveHeatmapWeeks(cfg, database(), Math.min(Math.max(args.weeks ?? cfg.heatmapWeeks, 1), 104));
            const metric = args.metric ?? cfg.heatmapMetric;
            try {
              return { content: heatmapText(database(), weeks, metric, cfg.includeBackground) };
            } catch (err) {
              return { content: `stats_heatmap failed: ${String(err)}` };
            }
          },
        });

        editor.add({
          name: "stats_dashboard",
          description:
            "Regenerate the self-contained HTML usage dashboard and return its path and size. Open it in a browser.",
          input: z.object({}),
          execute: async () => {
            try {
              const dash = renderDashboard(database(), cfg, app, state);
              state.dirty = false;
              return {
                content: `dashboard: ${dash.path}\nbytes: ${dash.bytes}\nlifetime: ${dash.summary}`,
              };
            } catch (err) {
              return { content: `stats_dashboard failed: ${String(err)}` };
            }
          },
        });

        // E41 — stats_export
        editor.add({
          name: "stats_export",
          description: "Export usage data as JSON or CSV for external analysis.",
          input: z.object({
            format: z.enum(["json", "csv"]).optional().describe("Output format (default json)"),
            table: z.enum(["daily", "models", "tools", "sources"]).optional().describe("Table to export (default daily)"),
            since: z.string().optional().describe('Start date (ISO date or "7d" for last 7 days)'),
            to: z.string().optional().describe("End date (ISO date)"),
          }),
          execute: async (input) => {
            const args = input as { format?: string; table?: string; since?: string; to?: string };
            try {
              const db = database();
              const format = args.format ?? "json";
              const table = args.table ?? "daily";
              const sinceDay = parseDayKey(args.since);
              const toDay = parseDayKey(args.to);

              let rows: Array<Record<string, unknown>>;
              if (table === "daily") {
                let sql = "SELECT * FROM daily";
                const params: unknown[] = [];
                if (sinceDay) {
                  sql += " WHERE day >= ?";
                  params.push(sinceDay);
                }
                if (toDay) {
                  sql += sinceDay ? " AND day <= ?" : " WHERE day <= ?";
                  params.push(toDay);
                }
                sql += " ORDER BY day ASC";
                rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
              } else if (table === "models") {
                rows = db.prepare("SELECT * FROM model_totals ORDER BY model ASC").all() as Array<Record<string, unknown>>;
              } else if (table === "tools") {
                rows = db.prepare("SELECT * FROM tool_totals ORDER BY tool ASC").all() as Array<Record<string, unknown>>;
              } else {
                rows = db.prepare("SELECT * FROM sources ORDER BY source ASC").all() as Array<Record<string, unknown>>;
              }

              if (rows.length === 0) return { content: "No data to export." };

              if (format === "csv") {
                return { content: toCsv(rows) };
              }
              return { content: JSON.stringify(rows, null, 2) };
            } catch (err) {
              return { content: `stats_export failed: ${String(err)}` };
            }
          },
        });

        // E42 — stats_compare
        editor.add({
          name: "stats_compare",
          description: "Compare current period vs previous period (week or month).",
          input: z.object({
            period: z.enum(["week", "month"]).optional().describe("Period to compare (default week)"),
          }),
          execute: async (input) => {
            const args = input as { period?: string };
            try {
              const db = database();
              const period = args.period ?? "week";
              const days = period === "week" ? 7 : 30;

              const now = new Date();
              const currentStart = dayKey(shiftDays(now, -(days - 1)));
              const currentEnd = dayKey(now);
              const prevStart = dayKey(shiftDays(now, -(2 * days - 1)));
              const prevEnd = dayKey(shiftDays(now, -days));

              const currentRows = db
                .prepare("SELECT * FROM daily WHERE day >= ? AND day <= ?")
                .all(currentStart, currentEnd) as Array<Record<string, unknown>>;
              const prevRows = db
                .prepare("SELECT * FROM daily WHERE day >= ? AND day <= ?")
                .all(prevStart, prevEnd) as Array<Record<string, unknown>>;

              const sumTokens = (rows: Array<Record<string, unknown>>): number => {
                let t = 0;
                for (const r of rows) {
                  t += num(r.input) + num(r.output) + num(r.reasoning) + num(r.cache_read) + num(r.cache_write);
                }
                return t;
              };
              const sumCost = (rows: Array<Record<string, unknown>>): number => {
                let c = 0;
                for (const r of rows) c += num(r.cost);
                return c;
              };
              const sumCalls = (rows: Array<Record<string, unknown>>): number => {
                let c = 0;
                for (const r of rows) c += num(r.tool_calls);
                return c;
              };

              const currentTokens = sumTokens(currentRows);
              const prevTokens = sumTokens(prevRows);
              const currentCost = sumCost(currentRows);
              const prevCost = sumCost(prevRows);
              const currentCalls = sumCalls(currentRows);
              const prevCalls = sumCalls(prevRows);

              const pctChange = (curr: number, prev: number): string => {
                if (prev === 0) return curr === 0 ? "0%" : "+∞";
                const pct = ((curr - prev) / prev) * 100;
                return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
              };

              const lines = [
                `Period comparison (${period})`,
                `  current: ${currentStart} → ${currentEnd}`,
                `  previous: ${prevStart} → ${prevEnd}`,
                "",
                `  tokens: ${fmtInt(currentTokens)} vs ${fmtInt(prevTokens)} (${pctChange(currentTokens, prevTokens)})`,
                `  cost: ${fmtUsd(currentCost)} vs ${fmtUsd(prevCost)} (${pctChange(currentCost, prevCost)})`,
                `  tool calls: ${fmtInt(currentCalls)} vs ${fmtInt(prevCalls)} (${pctChange(currentCalls, prevCalls)})`,
              ];
              return { content: lines.join("\n") };
            } catch (err) {
              return { content: `stats_compare failed: ${String(err)}` };
            }
          },
        });

        // E43 — stats_sessions
        editor.add({
          name: "stats_sessions",
          description: "Per-session token and cost breakdown.",
          input: z.object({
            limit: z.number().int().positive().max(100).optional().describe("Max sessions (default 20)"),
          }),
          execute: async (input) => {
            const args = input as { limit?: number };
            const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
            try {
              const db = database();
              // US-3: the old query joined session_state.updated_at (a day
              // key) to the global `daily` rollup and printed that day's
              // tool_calls/tool_ok/tool_fail as if they were the session's.
              // The counters are now real: session_tools is written per call
              // from recordToolCall and joined here (top N tools per session).
              const rows = db
                .prepare(
                  `SELECT s.session_id, s.model, s.input, s.output, s.reasoning, s.cache_read, s.cache_write, s.cost, s.updated_at
                   FROM session_state s
                   ORDER BY s.cost DESC, s.session_id ASC
                   LIMIT ?`,
                )
                .all(limit) as Array<Record<string, unknown>>;

              if (rows.length === 0) return { content: "No sessions recorded yet." };

              // One query for every listed session, grouped in JS — avoids a
              // per-session query and keeps the join on the real counter table.
              const ids = rows.map((r) => String(r.session_id));
              const toolRows = db
                .prepare(
                  `SELECT session_id, tool, calls, ok, fail, duration_ms
                     FROM session_tools
                    WHERE session_id IN (${ids.map(() => "?").join(",")})
                    ORDER BY session_id ASC, calls DESC, tool ASC`,
                )
                .all(...ids) as Array<Record<string, unknown>>;
              const toolsBySession = new Map<string, Array<Record<string, unknown>>>();
              for (const t of toolRows) {
                const key = String(t.session_id);
                const list = toolsBySession.get(key);
                if (list) list.push(t);
                else toolsBySession.set(key, [t]);
              }
              const TOP_TOOLS = 5;

              const lines = [`Per-session breakdown (${rows.length} sessions)`];
              for (const r of rows) {
                const tokens =
                  num(r.input) + num(r.output) + num(r.reasoning) + num(r.cache_read) + num(r.cache_write);
                lines.push(
                  `  ${String(r.session_id)}: tokens=${fmtInt(tokens)} cost=${fmtUsd(num(r.cost))} model=${String(r.model ?? "unknown")} updated=${String(r.updated_at)}`,
                );
                // US-3: this session's own tool calls, straight from
                // session_tools — never the global daily rollup.
                const tools = toolsBySession.get(String(r.session_id)) ?? [];
                if (tools.length === 0) continue;
                const totalCalls = tools.reduce((sum, t) => sum + num(t.calls), 0);
                const shown = tools.slice(0, TOP_TOOLS).map(
                  (t) =>
                    `${String(t.tool)}×${fmtInt(num(t.calls))} [ok ${fmtInt(num(t.ok))}, fail ${fmtInt(num(t.fail))}, ${fmtInt(num(t.duration_ms))}ms]`,
                );
                if (tools.length > TOP_TOOLS) shown.push(`+${tools.length - TOP_TOOLS} more`);
                lines.push(
                  `    tools this session (${fmtInt(totalCalls)} calls): ${shown.join(", ")}`,
                );
              }
              return { content: lines.join("\n") };
            } catch (err) {
              return { content: `stats_sessions failed: ${String(err)}` };
            }
          },
        });

        // E45 — stats_health
        editor.add({
          name: "stats_health",
          description: "Health check: db path, size, last prune, pricing, pending calls, event subscription.",
          input: z.object({}),
          execute: async () => {
            try {
              database();
              const dbPath = join(cfg.dir, DB_NAME);
              let dbSize = 0;
              try {
                dbSize = statSync(dbPath).size;
              } catch {
                // db file may not exist yet
              }

              const lines = [
                `db: ${dbPath}`,
                `size: ${dbSize} bytes`,
                `last prune: ${state.lastPruneMs > 0 ? new Date(state.lastPruneMs).toISOString() : "never"}`,
                `pricing models: ${state.pricing.size}`,
                `pending calls: ${state.pending.size}`,
                `event subscription: ${state.eventPumpAlive ? "active" : "inactive"}`,
              ];
              return { content: lines.join("\n") };
            } catch (err) {
              return { content: `stats_health failed: ${String(err)}` };
            }
          },
        });
      }),
    );

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "stats",
          description: "Refresh the usage dashboard and open it in your browser (runs entirely server-side; no model tokens).",
          execute: async () => {
            // No session.prompt: the command does its work server-side so the
            // model is never invoked and no tokens are spent.
            try {
              const dash = renderDashboard(database(), cfg, app, state);
              state.dirty = false;
              const result = openInBrowser(dash.path);
              log(`/stats refreshed ${dash.path} (${dash.bytes} bytes)${result.opened ? ", opened in browser" : `, open failed: ${result.error ?? "unknown"}`}`);
            } catch (err) {
              log(`/stats failed: ${String(err)}`);
            }
          },
        });
      }),
    );

    log(`dir=${cfg.dir} retentionDays=${cfg.retentionDays} metric=${cfg.heatmapMetric} weeks=${cfg.heatmapWeeks}`);

    return async () => {
      abort.abort();
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch {
          /* ignore */
        }
      }
      state.pending.clear();
      state.sweptPending.clear();
      for (const timer of timers) clearInterval(timer);
      if (state.db) {
        try {
          state.db.close();
        } catch {
          /* ignore */
        }
        state.db = null;
      }
    };
  },
});
