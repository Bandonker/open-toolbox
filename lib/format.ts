/**
 * lib/format.ts
 *
 * Shared formatters used across plugins. These were previously duplicated
 * in usage-stats.ts, tool-audit.ts, memory.ts, decision-log.ts, and
 * error-journal.ts. Centralizing them here keeps the output consistent.
 */

import { createHash } from "node:crypto";

/**
 * E303: Format a timestamp as a human-readable age (e.g. "5m", "2h", "3d").
 * Accepts ISO strings or SQLite datetime format ("YYYY-MM-DD HH:MM:SS").
 * LIB-2: `Z` is appended only when the string carries no timezone marker —
 * the old unconditional append made every zone-carrying ISO string
 * (`...Z`, `...+02:00`, `...+0200`) parse to NaN and render "?" forever,
 * which is what code-review.ts stores via `toISOString()`. Naive strings
 * (SQLite `datetime('now')`) remain treated as UTC.
 */
export function formatAge(iso: string): string {
  if (typeof iso !== "string" || iso.trim() === "") return "?";
  let s = iso.trim().replace(" ", "T");
  if (!/(?:[zZ]$|[+-]\d{2}:?\d{2}$)/.test(s)) s += "Z";
  const then = Date.parse(s);
  if (!Number.isFinite(then)) return "?";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * E306: Stable hash of a project directory path, used for project identification.
 */
export function projectHash(directory: string): string {
  return createHash("sha1").update(directory).digest("hex").slice(0, 16);
}

/**
 * Format a duration in milliseconds (e.g. "250ms", "1.5s", "2.3m").
 */
export function fmtDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Format a byte size (e.g. "512 B", "1.5 KB", "2.3 MB").
 */
export function fmtSize(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format an ISO timestamp for display (e.g. "2024-01-15 10:30:00Z").
 */
export function fmtTime(iso: unknown): string {
  if (typeof iso !== "string") return "?";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/**
 * Format a USD amount with 6 decimal places.
 */
export function fmtUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(6)}`;
}

/**
 * Format a USD amount with a dash for null.
 */
export function fmtUsdOrDash(n: number | null): string {
  return n === null ? "—" : fmtUsd(n);
}

/**
 * Format a rate in USD.
 */
export function fmtRate(n: number): string {
  return `$${Number.isFinite(n) ? n : 0}`;
}

/**
 * Format an integer with rounding.
 */
export function fmtInt(n: number): string {
  return String(Math.round(Number.isFinite(n) ? n : 0));
}

/**
 * Compact dashboard display for large counts: exact below 1000, otherwise
 * k/m/b suffixes (1400 -> "1.4k", 1000000000 -> "1b"). Text-tool output keeps
 * using fmtInt so CLI results stay exact.
 */
export function fmtCompact(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  if (Math.abs(v) < 1000) return String(v);
  const units = ["k", "m", "b"];
  let u = -1;
  let x = v;
  while (Math.abs(x) >= 1000 && u < units.length - 1) {
    x /= 1000;
    u++;
  }
  const short = (y: number): string => (Math.abs(y) >= 100 ? String(Math.round(y)) : String(Math.round(y * 10) / 10));
  let s = short(x);
  if (parseFloat(s) >= 1000 && u < units.length - 1) {
    x /= 1000;
    u++;
    s = short(x);
  }
  return `${s}${units[u]}`;
}

/**
 * Short dashboard display for USD: trims noise ($0.001000 -> "$.001",
 * $0.025000 -> "$.025", $0 -> "$0"). Text-tool output keeps fmtUsd.
 */
export function fmtShortUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v === 0) return "$0";
  const s = v
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "")
    .replace(/^(-?)0\./, "$1.");
  return `$${s}`;
}

/**
 * Short USD with a dash for null.
 */
export function fmtShortUsdOrDash(n: number | null): string {
  return n === null ? "—" : fmtShortUsd(n);
}

/**
 * E304: Export rows as a JSON array string.
 */
export function exportToJson(rows: object[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * E304: Export rows as a Markdown table.
 * `formatRow` converts each row to a string representation.
 */
export function exportToMarkdown(rows: object[], formatRow: (row: object) => string): string {
  if (rows.length === 0) return "";
  return rows.map(formatRow).join("\n\n---\n\n");
}
