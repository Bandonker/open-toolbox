import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { spawn } from "node:child_process";
import { openDatabase, applyPragmas, type AnyDatabase } from "../lib/sqlite.ts";

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
 * The dashboard is a self-contained HTML file (inline SVG/CSS, no CDN, no
 * script) written to `<dir>/dashboard.html`. There is no way to open a browser
 * from a plugin, so tools return the path for the user to open.
 */

const DB_NAME = "stats.db";
const DASHBOARD_NAME = "dashboard.html";

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

let db: AnyDatabase | null = null;
let lastPruneMs = 0;

/** Latest provider/model price list keyed by `providerID/modelID`. */
let pricing: PricingMap = new Map();
/** User-supplied price overrides (win over `pricing`), e.g. for local models. */
let priceOverrides: PricingMap = new Map();
/** Set by every record; the refresh timer regenerates the dashboard while true. */
let dirty = false;
/** Last model we attributed per session, so http.request doesn't rewrite every call. */
const sessionModels = new Map<string, string>();

/** In-flight tool calls keyed by call id, for duration measurement. */
const pending = new Map<string, { tool: string; startedMs: number }>();

function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
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
 */
function computedCost(model: string, t: Tokens): number | null {
  const key = baseModelKey(model);
  // User overrides win over the provider's published rates (e.g. local models).
  const entries = priceOverrides.get(key) ?? pricing.get(key);
  if (!entries || entries.length === 0) return null;
  const rate = selectRate(entries, t.input);
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
 * Accept both shapes the model registry can hand us:
 *  - `ModelCost[]` (what the API types declare): `{ tier?, input, output, cache: { read, write } }`
 *  - the models.dev object (what the cache holds): `{ input, output, cache_read, cache_write, tiers, context_over_200k }`
 */
function readPriceEntries(raw: unknown): PriceEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item) => item && typeof item === "object")
      .map((item) => entryFrom(item as Record<string, unknown>));
  }
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const entries: PriceEntry[] = [entryFrom(o)];
  const tiers = Array.isArray(o.tiers) ? o.tiers : [];
  for (const t of tiers) {
    if (t && typeof t === "object") entries.push(entryFrom(t as Record<string, unknown>));
  }
  if (o.context_over_200k && typeof o.context_over_200k === "object") {
    entries.push({ ...entryFrom(o.context_over_200k as Record<string, unknown>), tierSize: 200_000 });
  }
  return entries.filter((e) => e.tierSize !== null || e.input || e.output || e.cacheRead || e.cacheWrite);
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
async function refreshPricing(ctx: { model?: unknown }, log: (message: string) => void): Promise<void> {
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
    pricing = next;
    log(`pricing loaded for ${next.size} model(s)`);
  } catch (err) {
    log(`pricing refresh failed: ${String(err)}`);
  }
}

function fmtUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(6)}`;
}

function fmtUsdOrDash(n: number | null): string {
  return n === null ? "—" : fmtUsd(n);
}

function fmtRate(n: number): string {
  return `$${Number.isFinite(n) ? n : 0}`;
}

function fmtInt(n: number): string {
  return String(Math.round(Number.isFinite(n) ? n : 0));
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
      max_ms INTEGER NOT NULL DEFAULT 0
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
  `);
  for (const statement of [
    "ALTER TABLE daily ADD COLUMN cost_computed REAL",
    "ALTER TABLE model_totals ADD COLUMN cost_computed REAL",
    "ALTER TABLE sources ADD COLUMN cost_computed REAL",
  ]) {
    try {
      database.exec(statement);
    } catch {
      /* column already exists on migrated databases */
    }
  }
}

function getDb(cfg: Config): AnyDatabase {
  if (!db) {
    db = openDatabase(join(cfg.dir, DB_NAME));
    applyPragmas(db);
    initSchema(db);
    prune(cfg, true);
  }
  return db;
}

function prune(cfg: Config, force: boolean): void {
  if (cfg.retentionDays <= 0) return;
  const now = Date.now();
  if (!force && now - lastPruneMs < 3_600_000) return;
  lastPruneMs = now;
  try {
    const cutoff = dayKey(shiftDays(new Date(), -cfg.retentionDays));
    const database = db;
    if (!database) return;
    database.prepare("DELETE FROM daily WHERE day < ?").run(cutoff);
    database.prepare("DELETE FROM session_state WHERE updated_at != '' AND updated_at < ?").run(cutoff);
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
  database
    .prepare(
      `INSERT INTO daily(day, input, output, reasoning, cache_read, cache_write, cost, cost_computed)
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

function addBackgroundUsage(database: AnyDatabase, day: string, source: string, t: Tokens, cost: number): void {
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
  database
    .prepare(
      `INSERT INTO daily(day, bg_input, bg_output, bg_reasoning, bg_cache_read, bg_cache_write, bg_cost)
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

function recordUsageUpdated(database: AnyDatabase, sessionID: string, tokensRaw: unknown, costRaw: unknown): void {
  const current = readTokens(tokensRaw);
  const cost = readCost(costRaw);
  const last = loadSession(database, sessionID);
  const model = last?.model ?? "unknown";
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
  const deltaComputed = computedCost(model, delta);
  const day = dayKey();
  const changed =
    delta.input > 0 ||
    delta.output > 0 ||
    delta.reasoning > 0 ||
    delta.cacheRead > 0 ||
    delta.cacheWrite > 0 ||
    deltaCost > 0;
  if (changed) {
    addDailyUsage(database, day, delta, deltaCost, deltaComputed);
    addModelUsage(database, model, delta, deltaCost, 1, deltaComputed);
  }
  dirty = true;
  ensureSession(database, sessionID, null);
  database
    .prepare(
      `INSERT INTO session_state(session_id, input, output, reasoning, cache_read, cache_write, cost, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         input = excluded.input,
         output = excluded.output,
         reasoning = excluded.reasoning,
         cache_read = excluded.cache_read,
         cache_write = excluded.cache_write,
         cost = excluded.cost,
         updated_at = excluded.updated_at`,
    )
    .run(sessionID, current.input, current.output, current.reasoning, current.cacheRead, current.cacheWrite, cost, day);
}

function recordUsageRecorded(database: AnyDatabase, sessionID: string, source: string, tokensRaw: unknown, costRaw: unknown): void {
  ensureSession(database, sessionID, null);
  addBackgroundUsage(database, dayKey(), source || "unknown", readTokens(tokensRaw), readCost(costRaw));
  dirty = true;
}

function recordModelSelected(database: AnyDatabase, sessionID: string, model: string): void {
  ensureSession(database, sessionID, model);
  dirty = true;
}

function recordSessionCreated(database: AnyDatabase, sessionID: string): void {
  ensureSession(database, sessionID, null);
  dirty = true;
}

/**
 * Attribute a session to its current model. `session.model.selected` only fires
 * on switches (not for the initial model), so we also call this from the
 * `http.request` hook, which carries the model on every request.
 */
function rememberModel(sessionID: string, model: string): void {
  if (!sessionID || !model || sessionModels.get(sessionID) === model) return;
  sessionModels.set(sessionID, model);
  try {
    if (db) recordModelSelected(db, sessionID, model);
  } catch {
    /* db unavailable */
  }
}

function recordToolCall(database: AnyDatabase, tool: string, ok: boolean, durationMs: number): void {
  const ms = Math.max(0, Math.round(durationMs));
  database
    .prepare(
      `INSERT INTO tool_totals(tool, calls, succeeded, failed, total_ms, max_ms)
       VALUES(?, 1, ?, ?, ?, ?)
       ON CONFLICT(tool) DO UPDATE SET
         calls = calls + 1,
         succeeded = succeeded + excluded.succeeded,
         failed = failed + excluded.failed,
         total_ms = total_ms + excluded.total_ms,
         max_ms = MAX(max_ms, excluded.max_ms)`,
    )
    .run(tool, ok ? 1 : 0, ok ? 0 : 1, ms, ms);
  database
    .prepare(
      `INSERT INTO daily(day, tool_calls, tool_ok, tool_fail)
       VALUES(?, 1, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         tool_calls = tool_calls + 1,
         tool_ok = tool_ok + excluded.tool_ok,
         tool_fail = tool_fail + excluded.tool_fail`,
    )
    .run(dayKey(), ok ? 1 : 0, ok ? 0 : 1);
  dirty = true;
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

function lifetimeTotals(database: AnyDatabase): UsageTotals {
  const r = database
    .prepare(
      `SELECT SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(cost) cost,
              SUM(cost_computed) cost_computed
       FROM daily`,
    )
    .get() as Record<string, unknown> | null;
  return totalsOf(r);
}

function lifetimeTools(database: AnyDatabase): { calls: number; ok: number; fail: number } {
  const r = database
    .prepare("SELECT SUM(tool_calls) calls, SUM(tool_ok) ok, SUM(tool_fail) fail FROM daily")
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
  const todayRow = dailyRows(database, day).find((r) => r.day === day);
  const today = totalsOf(todayRow);
  const rate = tools.calls > 0 ? (tools.ok / tools.calls) * 100 : 0;
  const tokenLine = (t: UsageTotals): string =>
    `input=${fmtInt(t.input)} output=${fmtInt(t.output)} reasoning=${fmtInt(t.reasoning)} cache_read=${fmtInt(t.cacheRead)} cache_write=${fmtInt(t.cacheWrite)}`;
  return [
    "Usage stats — lifetime",
    `  tokens: ${tokenLine(life)}`,
    `  cost: ${fmtUsd(life.cost)}`,
    `  cost (list price): ${fmtUsdOrDash(life.costComputed)}`,
    `  unknown models: ${fmtInt(unknownModels)} (no published pricing)`,
    `  sessions: ${sessions}`,
    `  tool calls: ${fmtInt(tools.calls)} (ok ${fmtInt(tools.ok)}, failed ${fmtInt(tools.fail)}, ${rate.toFixed(1)}% success)`,
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
      "SELECT tool, calls, succeeded, failed, total_ms, max_ms FROM tool_totals ORDER BY calls DESC, tool ASC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
  if (rows.length === 0) return "No tool calls recorded yet.";
  const lines = [`Tool usage (${rows.length} tools)`];
  for (const r of rows) {
    const calls = num(r.calls);
    const avg = calls > 0 ? num(r.total_ms) / calls : 0;
    lines.push(
      `  ${String(r.tool)}: calls=${fmtInt(calls)} ok=${fmtInt(num(r.succeeded))} failed=${fmtInt(num(r.failed))} avg=${Math.round(avg)}ms max=${fmtInt(num(r.max_ms))}ms`,
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

type HeatCell = { day: string; value: number; inRange: boolean };
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
      cells.push({ day: key, value, inRange });
    }
    const first = shiftDays(startSunday, col * 7);
    if (first.getMonth() !== lastMonth) {
      lastMonth = first.getMonth();
      months.push({ col, label: MONTHS[first.getMonth()] ?? "" });
    }
    columns.push(cells);
  }
  return { weeks, metric, max, total, columns, months, start: startSunday, end: todayMid };
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
  return metric === "cost" ? fmtUsd(value) : fmtInt(value);
}

function buildHeatmapHtml(grid: HeatGrid): string {
  const cells: string[] = [];
  for (let col = 0; col < grid.weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const cell = grid.columns[col]?.[row];
      if (!cell) continue;
      const level = cell.inRange ? heatLevel(cell.value, grid.max) : 0;
      const cls = cell.inRange ? `hm-cell ${HEAT_COLORS[level]}` : "hm-cell hm-out";
      const title = `${cell.day}: ${heatCellLabel(cell.value, grid.metric)} ${grid.metric}`;
      cells.push(`<span class="${cls}" title="${escapeHtml(title)}"></span>`);
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
    `<div class="hm-wrap" role="img" aria-label="${escapeHtml(`activity heatmap ${span}, metric ${grid.metric}`)}">`,
    `<div class="hm-months" style="grid-template-columns:repeat(${grid.weeks},12px)">${monthSpans}</div>`,
    `<div class="hm-body">`,
    `<div class="hm-days">${dayLabels}</div>`,
    `<div class="hm-grid" style="grid-template-columns:repeat(${grid.weeks},12px)">${cells.join("")}</div>`,
    `</div>`,
    `</div>`,
    `<div class="hm-legend"><span class="muted">Less</span>${legend}<span class="muted">More</span><span class="hm-max">peak ${escapeHtml(heatCellLabel(grid.max, grid.metric))}</span></div>`,
  ].join("");
}

function buildBarChartHtml(rows: DayRow[], includeBackground: boolean): string {
  const last = rows.slice(-30);
  const values = last.map((r) => metricValue(r, "tokens", includeBackground));
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
        `<text x="${padL - 8}" y="${(y + 3).toFixed(1)}" class="axis" text-anchor="end">${escapeHtml(fmtInt(max * f))}</text>`
      );
    })
    .join("");

  const rects = last
    .map((r, i) => {
      const v = values[i] ?? 0;
      const bh = Math.max(0, Math.round((v / max) * plotH));
      const x = padL + i * step + (step - barW) / 2;
      const y = padT + plotH - bh;
      const rx = Math.min(3, barW / 2);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh}" rx="${rx.toFixed(1)}" class="bar"><title>${escapeHtml(`${r.day}: ${fmtInt(v)} tokens`)}</title></rect>`;
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
    `<svg class="bars" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="tokens per day over the last 30 days">`,
    gridLines,
    rects,
    `<line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" class="axis-line"/>`,
    xLabels,
    `</svg>`,
  ].join("");
}

function tableHtml(headers: string[], rows: string[][]): string {
  const head = headers.map((x, i) => `<th${i > 0 ? ' class="num"' : ""}>${escapeHtml(x)}</th>`).join("");
  const body =
    rows.length > 0
      ? rows
          .map(
            (r) =>
              `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ""}>${escapeHtml(c)}</td>`).join("")}</tr>`,
          )
          .join("")
      : `<tr><td colspan="${headers.length}" class="muted">No data yet</td></tr>`;
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

type AppInfo = { name?: string; version?: string; channel?: string };

function lifetimeSummaryLine(database: AnyDatabase): string {
  const life = lifetimeTotals(database);
  const tools = lifetimeTools(database);
  return `${fmtInt(tokenTotal(life))} tokens / ${fmtUsd(life.cost)} / ${fmtInt(tools.calls)} tool calls`;
}

function buildDashboardHtml(database: AnyDatabase, cfg: Config, app: AppInfo): string {
  const life = lifetimeTotals(database);
  const tools = lifetimeTools(database);
  const sessions = countSessions(database);
  const bg = backgroundTotals(database);
  const grid = heatmapGrid(database, cfg.heatmapWeeks, cfg.heatmapMetric, cfg.includeBackground);
  const recent = dailyRows(database, dayKey(shiftDays(new Date(), -29)));
  const rate = tools.calls > 0 ? (tools.ok / tools.calls) * 100 : 0;

  const toolRows = (
    database.prepare("SELECT * FROM tool_totals ORDER BY calls DESC, tool ASC LIMIT 15").all() as Array<
      Record<string, unknown>
    >
  ).map((r) => {
    const calls = num(r.calls);
    const avg = calls > 0 ? num(r.total_ms) / calls : 0;
    return [
      String(r.tool),
      fmtInt(calls),
      fmtInt(num(r.succeeded)),
      fmtInt(num(r.failed)),
      `${Math.round(avg)}ms`,
      `${fmtInt(num(r.max_ms))}ms`,
    ];
  });

  const modelRows = (
    database
      .prepare(
        `SELECT * FROM model_totals
         ORDER BY (input + output + reasoning + cache_read + cache_write) DESC, model ASC LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => {
    const t = totalsOf(r);
    const model = String(r.model);
    const slash = model.indexOf("/");
    const provider = slash >= 0 ? model.slice(0, slash) : "—";
    const entries = priceOverrides.get(baseModelKey(model)) ?? pricing.get(baseModelKey(model));
    const rate = entries && entries.length > 0 ? selectRate(entries, t.input) : null;
    return [
      model,
      provider,
      rate ? fmtRate(rate.input) : "—",
      rate ? fmtRate(rate.output) : "—",
      fmtInt(tokenTotal(t)),
      fmtUsd(t.cost),
      fmtUsdOrDash(t.costComputed),
      fmtInt(num(r.events)),
    ];
  });

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
      fmtInt(num(r.count)),
      fmtInt(tokenTotal(t)),
      fmtUsd(t.cost),
      fmtUsdOrDash(t.costComputed),
    ];
  });

  const name = app.name || "opencode";
  const version = app.version ? ` v${app.version}` : "";
  const channel = app.channel ? ` · ${app.channel}` : "";
  const generated = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const cards: Array<[string, string, string, string]> = [
    ["Total tokens", fmtInt(tokenTotal(life)), "c1", "in + out + cache"],
    ["Cost (reported)", fmtUsd(life.cost), "c2", "USD billed by the provider"],
    ["Cost (list price)", fmtUsdOrDash(life.costComputed), "c2", "API-equivalent USD"],
    ["Sessions", fmtInt(sessions), "c3", "tracked"],
    ["Tool calls", fmtInt(tools.calls), "c4", `${fmtInt(tools.ok)} ok · ${fmtInt(tools.fail)} failed`],
    ["Success rate", `${rate.toFixed(1)}%`, "c5", "completed calls"],
    ["Background", fmtInt(bg.total), "c6", `${fmtUsd(bg.cost)} title + compaction`],
  ];
  const cardsHtml = cards
    .map(
      ([k, v, cls, s]) =>
        `<div class="kpi ${cls}"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span><span class="s">${escapeHtml(s)}</span></div>`,
    )
    .join("");

  const css = [
    ":root{--bg:#f4f6fb;--panel:#fff;--border:#e4e8f0;--text:#1c2230;--muted:#68718a;--grid:#e9edf5;",
    "--accent:#6366f1;--accent2:#8b5cf6;--ok:#16a34a;--warn:#d97706;",
    "--hm0:#edf0f7;--hm1:#c7d2fe;--hm2:#a5b4fc;--hm3:#818cf8;--hm4:#6366f1;",
    "--shadow:0 1px 2px rgba(16,24,40,.05),0 6px 20px -8px rgba(16,24,40,.18);--radius:16px}",
    "@media (prefers-color-scheme:dark){:root{--bg:#080b12;--panel:#111725;--border:#212b3d;--text:#e7ecf5;--muted:#8d99ad;--grid:#1b2434;",
    "--accent:#818cf8;--accent2:#a78bfa;--ok:#4ade80;--warn:#fbbf24;",
    "--hm0:#1a2231;--hm1:#312e81;--hm2:#4338ca;--hm3:#6366f1;--hm4:#a5b4fc;",
    "--shadow:0 1px 2px rgba(0,0,0,.5),0 12px 32px -12px rgba(0,0,0,.7)}}",
    "*{box-sizing:border-box}",
    "html,body{margin:0}",
    "body{background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}",
    ".wrap{max-width:1080px;margin:0 auto;padding:40px 22px 56px}",
    ".hero{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:24px}",
    ".brand{display:flex;align-items:center;gap:12px}",
    ".brand .dot{width:14px;height:14px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 0 4px rgba(99,102,241,.18)}",
    "h1{font-size:24px;margin:0;letter-spacing:-.02em}",
    ".meta{color:var(--muted);font-size:12.5px;margin:0}",
    ".kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:20px}",
    ".kpi{position:relative;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 16px 14px;box-shadow:var(--shadow);overflow:hidden}",
    ".kpi::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;background:var(--accent)}",
    ".kpi .k{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}",
    ".kpi .v{display:block;font-size:23px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}",
    ".kpi .s{display:block;font-size:11.5px;color:var(--muted);margin-top:2px}",
    ".kpi.c2::before{background:linear-gradient(90deg,var(--accent),var(--accent2))}",
    ".kpi.c3::before{background:#0ea5e9}.kpi.c4::before{background:#14b8a6}",
    ".kpi.c5::before{background:var(--ok)}.kpi.c6::before{background:var(--warn)}",
    ".panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);margin-bottom:18px}",
    ".panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:14px}",
    ".panel-head h2{font-size:15px;margin:0;letter-spacing:-.01em}",
    ".sub{color:var(--muted);font-size:12px}",
    ".muted{color:var(--muted)}",
    ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}",
    "@media (max-width:760px){.grid2{grid-template-columns:1fr}.wrap{padding:24px 14px 40px}}",
    ".hm-wrap{display:inline-block;max-width:100%;overflow-x:auto}",
    ".hm-months{display:grid;gap:3px;margin-left:30px;height:14px;font-size:10px;color:var(--muted);align-items:end}",
    ".hm-months span{white-space:nowrap}",
    ".hm-body{display:flex;gap:6px;margin-top:4px}",
    ".hm-days{display:grid;grid-template-rows:repeat(7,12px);gap:3px;width:24px;font-size:10px;color:var(--muted);text-align:right;line-height:12px}",
    ".hm-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);gap:3px}",
    ".hm-cell{display:block;width:12px;height:12px;border-radius:3px}",
    ".hm-out{background:var(--hm0);opacity:.4}",
    ".hm-l0{background:var(--hm0)}.hm-l1{background:var(--hm1)}.hm-l2{background:var(--hm2)}.hm-l3{background:var(--hm3)}.hm-l4{background:var(--hm4)}",
    ".hm-legend{display:flex;align-items:center;gap:5px;margin-top:14px;font-size:11.5px;color:var(--muted)}",
    ".hm-legend i{width:12px;height:12px;border-radius:3px;display:inline-block}",
    ".hm-max{margin-left:auto}",
    ".bars{display:block;width:100%;height:auto;overflow:visible}",
    ".bar{fill:var(--accent);opacity:.9}.bar:hover{opacity:1}",
    ".gl{stroke:var(--grid);stroke-width:1}",
    ".axis{fill:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}",
    ".axis-line{stroke:var(--border);stroke-width:1}",
    ".tbl{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}",
    ".tbl th,.tbl td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:left}",
    ".tbl th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}",
    ".tbl td.num,.tbl th.num{text-align:right}",
    ".tbl tbody tr:last-child td{border-bottom:0}",
    ".bg-panel{border-left:3px solid var(--warn)}",
    "footer{color:var(--muted);font-size:12px;text-align:center;padding:10px 0 0}",
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
    `<section class="panel">`,
    `<div class="panel-head"><h2>Activity</h2><span class="sub">last ${grid.weeks} weeks · metric: ${escapeHtml(grid.metric)}</span></div>`,
    buildHeatmapHtml(grid),
    `</section>`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Tokens per day</h2><span class="sub">last 30 days</span></div>`,
    buildBarChartHtml(recent, cfg.includeBackground),
    `</section>`,
    `<div class="grid2">`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Top tools</h2></div>`,
    tableHtml(["tool", "calls", "ok", "failed", "avg", "max"], toolRows),
    `</section>`,
    `<section class="panel">`,
    `<div class="panel-head"><h2>Models</h2><span class="sub">$/M list rates</span></div>`,
    tableHtml(
      ["model", "provider", "in $/M", "out $/M", "tokens", "cost", "cost (list)", "events"],
      modelRows,
    ),
    `</section>`,
    `</div>`,
    `<section class="panel bg-panel">`,
    `<!-- background -->`,
    `<div class="panel-head"><h2>Background usage</h2><span class="sub">title + compaction</span></div>`,
    `<p class="sub">Hidden spend recorded outside the main session counters: <b>${escapeHtml(fmtInt(bg.total))}</b> tokens · <b>${escapeHtml(fmtUsd(bg.cost))}</b>.</p>`,
    tableHtml(["source", "events", "tokens", "cost", "cost (list)"], sourceRows),
    `</section>`,
    `<p class="sub">List-price cost is computed from the provider's published per-million-token rates. ` +
      `Subscription plans (e.g. opencode Zen or a flat account) may report <b>$0</b> billed while the ` +
      `list-price column shows the API-equivalent value. Unknown prices render <b>—</b>, never $0.</p>`,
    `<footer>lifetime: ${escapeHtml(lifetimeSummaryLine(database))} · usage-stats</footer>`,
    `</div>`,
    "</body></html>",
  ].join("\n");
}

function renderDashboard(
  database: AnyDatabase,
  cfg: Config,
  app: AppInfo,
): { path: string; bytes: number; summary: string } {
  const html = buildDashboardHtml(database, cfg, app);
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
function openInBrowser(filePath: string): boolean {
  if (process.env.OPENCODE_USAGE_STATS_NO_OPEN) return false;
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" })
        : process.platform === "darwin"
          ? spawn("open", [filePath], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "usage-stats",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options);
    if (!cfg.enabled) return () => {};

    const log = (message: string): void => {
      if (cfg.log) console.error(`[usage-stats] ${message}`);
    };
    const database = (): AnyDatabase => getDb(cfg);
    const app = (ctx.app ?? {}) as AppInfo;

    try {
      getDb(cfg);
    } catch (err) {
      log(`db init failed: ${String(err)}`);
    }

    const timers: Array<ReturnType<typeof setInterval>> = [];

    const render = (): void => {
      try {
        renderDashboard(database(), cfg, app);
        dirty = false;
      } catch (err) {
        log(`dashboard render failed: ${String(err)}`);
      }
    };

    // Price list: fetch once at startup, then refresh periodically.
    priceOverrides = parsePriceOverrides(cfg.prices);
    if (priceOverrides.size > 0) log(`price overrides loaded for ${priceOverrides.size} model(s)`);
    await refreshPricing(ctx, log);
    if (cfg.pricingRefreshMin > 0) {
      const timer = setInterval(() => {
        void refreshPricing(ctx, log);
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
        if (dirty) render();
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
          pending.set(key, { tool: String(event.tool ?? "unknown"), startedMs: Date.now() });
        } catch (err) {
          log(`execute.before failed: ${String(err)}`);
        }
      }),
    );

    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        try {
          const key = String(event.id ?? "");
          const entry = pending.get(key);
          const tool = String(event.tool ?? entry?.tool ?? "unknown");
          const duration = entry ? Date.now() - entry.startedMs : 0;
          pending.delete(key);
          const status = String((event as { status?: unknown }).status ?? "completed");
          recordToolCall(database(), tool, status === "completed", duration);
        } catch (err) {
          log(`execute.after failed: ${String(err)}`);
        }
      }),
    );

    const abort = new AbortController();
    const pump = (async (): Promise<void> => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          const ev = raw as unknown as { type?: string; data?: Record<string, unknown> };
          const data = (ev.data ?? {}) as Record<string, unknown>;
          const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
          try {
            switch (ev.type) {
              case "session.usage.updated":
                if (sessionID) recordUsageUpdated(database(), sessionID, data.tokens, data.cost);
                break;
              case "session.usage.recorded":
                if (sessionID) {
                  recordUsageRecorded(
                    database(),
                    sessionID,
                    String(data.source ?? "unknown"),
                    data.tokens,
                    data.cost,
                  );
                }
                break;
              case "session.model.selected":
                if (sessionID) rememberModel(sessionID, modelKey(data.model));
                break;
              case "session.created":
                if (sessionID) recordSessionCreated(database(), sessionID);
                break;
              default:
                break;
            }
            prune(cfg, false);
          } catch (err) {
            log(`event ${String(ev.type)} failed: ${String(err)}`);
          }
        }
      } catch (err) {
        log(`event pump stopped: ${String(err)}`);
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
              rememberModel(String(event.sessionID), modelKey(event.model));
            }
          } catch (err) {
            log(`http.request model attribution failed: ${String(err)}`);
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
            const weeks = Math.min(Math.max(args.weeks ?? cfg.heatmapWeeks, 1), 104);
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
              const dash = renderDashboard(database(), cfg, app);
              dirty = false;
              return {
                content: `dashboard: ${dash.path}\nbytes: ${dash.bytes}\nlifetime: ${dash.summary}`,
              };
            } catch (err) {
              return { content: `stats_dashboard failed: ${String(err)}` };
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
              const dash = renderDashboard(database(), cfg, app);
              dirty = false;
              const opened = openInBrowser(dash.path);
              log(`/stats refreshed ${dash.path} (${dash.bytes} bytes)${opened ? ", opened in browser" : ""}`);
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
      pending.clear();
      for (const timer of timers) clearInterval(timer);
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        db = null;
      }
    };
  },
});
