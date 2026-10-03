/**
 * lib/config.ts
 *
 * Shared configuration helpers for reading plugin options with environment
 * fallbacks. These were previously duplicated in usage-stats.ts, memory.ts,
 * and goal.ts.
 */

/**
 * Read an environment variable as a string, returning undefined for empty strings.
 */
export function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Coerce an unknown value to a boolean.
 * - boolean: returned as-is
 * - string: "1", "true", "yes", "on" (case-insensitive) -> true; "0", "false", "no", "off" -> false
 * - everything else: fallback
 */
export function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

/**
 * Coerce an unknown value to an integer.
 * - null/undefined: fallback
 * - string: parsed as Number, truncated if finite, else fallback;
 *   empty/whitespace-only strings are treated as UNSET (LIB-4: same
 *   "empty means unset" policy as envStr above — `OPENCODE_MEMORY_TOP_K=""`
 *   from a stray CI env assignment must fall back, not become 0)
 * - number: truncated if finite, else fallback
 */
export function asInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Pick a value from options or environment. Options win over env.
 */
export function pick(options: Record<string, unknown> | undefined, key: string, envName: string): unknown {
  return options?.[key] ?? process.env[envName];
}

/* ------------------------------------------------------------------ *
 * E349: Debug/verbose mode
 * ------------------------------------------------------------------ */

/**
 * E349: Check if debug mode is enabled for a plugin.
 * Reads from options.debug or PLUGIN_NAME_DEBUG env var.
 */
export function isDebugEnabled(
  options: Record<string, unknown> | undefined,
  pluginName: string,
): boolean {
  const opt = options?.debug;
  if (typeof opt === "boolean") return opt;
  if (typeof opt === "string") return asBool(opt, false);
  const envName = `${pluginName.toUpperCase().replace(/-/g, "_")}_DEBUG`;
  return asBool(process.env[envName], false);
}

/**
 * E349: Log a debug message if debug mode is enabled.
 */
export function debugLog(
  pluginName: string,
  message: string,
  ...args: unknown[]
): void {
  if (isDebugEnabled(undefined, pluginName)) {
    console.error(`[${pluginName}:debug] ${message}`, ...args);
  }
}

/* ------------------------------------------------------------------ *
 * E350: Plugin metrics
 * ------------------------------------------------------------------ */

export type PluginMetrics = {
  operationCount: number;
  errorCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  errorRate: number;
};

/**
 * E350: Create a metrics tracker for a plugin.
 * Returns a function to record operations and a function to get metrics.
 */
export function createMetricsTracker(): {
  record: (latencyMs: number, isError?: boolean) => void;
  getMetrics: () => PluginMetrics;
  reset: () => void;
} {
  let operationCount = 0;
  let errorCount = 0;
  let totalLatencyMs = 0;

  return {
    record(latencyMs: number, isError = false) {
      operationCount++;
      totalLatencyMs += latencyMs;
      if (isError) errorCount++;
    },
    getMetrics(): PluginMetrics {
      const avgLatencyMs = operationCount > 0 ? totalLatencyMs / operationCount : 0;
      const errorRate = operationCount > 0 ? errorCount / operationCount : 0;
      return {
        operationCount,
        errorCount,
        totalLatencyMs,
        avgLatencyMs,
        errorRate,
      };
    },
    reset() {
      operationCount = 0;
      errorCount = 0;
      totalLatencyMs = 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * E351: Graceful degradation
 * ------------------------------------------------------------------ */

// LIB-5: ESM has no bare `require` — a direct call threw ReferenceError, which
// tryRequire swallowed, so the helper always reported "module missing".
// Same createRequire pattern as lib/sqlite.ts.
import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);

/**
 * E351: Try to require a module, returning null if it's not available.
 * Used for optional dependencies like better-sqlite3.
 */
export function tryRequire<T>(moduleName: string): T | null {
  try {
    return esmRequire(moduleName) as T;
  } catch {
    return null;
  }
}

/**
 * E351: Wrap a function with graceful degradation.
 * If the function throws, returns the fallback value instead.
 */
export function withFallback<T>(
  fn: () => T,
  fallback: T,
  onError?: (err: unknown) => void,
): T {
  try {
    return fn();
  } catch (err) {
    if (onError) onError(err);
    return fallback;
  }
}

/**
 * E351: Wrap an async function with graceful degradation.
 * If the function throws, returns the fallback value instead.
 */
export async function withFallbackAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  onError?: (err: unknown) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (onError) onError(err);
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * E352: Config validation/migration
 * ------------------------------------------------------------------ */

export type ConfigProblem = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

/**
 * E352: Validate a config object against a schema.
 * Returns a list of problems (empty if valid).
 */
export function validateConfig(
  config: Record<string, unknown>,
  schema: Record<string, { type: "string" | "number" | "boolean" | "array"; required?: boolean; default?: unknown }>,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const [key, rule] of Object.entries(schema)) {
    const value = config[key];
    if (value === undefined || value === null) {
      if (rule.required) {
        problems.push({ path: key, message: `Missing required field: ${key}`, severity: "error" });
      }
      continue;
    }
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== rule.type) {
      problems.push({
        path: key,
        message: `Expected ${rule.type}, got ${actualType}`,
        severity: "error",
      });
    }
  }
  return problems;
}

/**
 * E352: Migrate a config object to the latest version.
 * Returns the migrated config and a list of changes made.
 */
export function migrateConfig(
  config: Record<string, unknown>,
  migrations: Array<{ version: number; migrate: (config: Record<string, unknown>) => Record<string, unknown> }>,
): { config: Record<string, unknown>; changes: string[] } {
  let current = { ...config };
  const changes: string[] = [];
  for (const migration of migrations.sort((a, b) => a.version - b.version)) {
    const before = JSON.stringify(current);
    current = migration.migrate(current);
    const after = JSON.stringify(current);
    if (before !== after) {
      changes.push(`Migrated to version ${migration.version}`);
    }
  }
  return { config: current, changes };
}
