/**
 * Pure helpers shared by the opencode-sessions plugin.
 *
 * These live in their own module on purpose: opencode's local-plugin loader
 * treats *every* named export of a file under `plugins/` as a plugin factory, so
 * anything exported from the plugin file itself must be the plugin. Keeping the
 * helpers here lets unit tests import them without exposing non-plugin exports.
 */
import {
  isAbsolute,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";

export type ModelRef = { providerID: string; modelID: string };

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  // Accept numbers and numeric strings; reject everything else.
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "") return fallback;
    if (/^(1|true|yes|y|on)$/.test(v)) return true;
    if (/^(0|false|no|n|off)$/.test(v)) return false;
  }
  return fallback;
}

export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0] ?? "";
  // Strip control characters (including \x00-\x1f and \x7f) that would render
  // as garbage or invisibly corrupt the title in logs and the session list.
  const cleaned = firstLine.replace(/[\x00-\x1f\x7f]/g, "");
  const trimmed = cleaned.trim().replace(/\s+/g, " ");
  if (!trimmed) return "untitled task";
  if (trimmed.length <= 60) return trimmed;
  // Break on a word boundary when truncating: find the last space within the
  // budget and cut there, so a very long single word is sliced mid-string but
  // normal prose ends at a word edge.
  const slice = trimmed.slice(0, 57);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 32 ? slice.slice(0, lastSpace) : slice;
  return `${cut}...`;
}

/**
 * Truncate text to at most `max` characters, marker included.
 *
 * OS-17: the doc said "at most `max`" and the implementation returned `max`
 * *content* characters plus a ~25-character marker, so every caller that relied
 * on the bound (`peerNoticeMaxChars`, the injection caps) overflowed it by that
 * much. The marker now counts against the budget — which makes the reported
 * "N chars" and the kept length depend on each other, so the pair is solved by a
 * short fixed-point pass (the digit count of N can only shift once).
 *
 * `position` controls which end is kept:
 *  - "end"   (default) keep the head, mark the cut at the tail — for prose.
 *  - "start"  keep the tail, prepend a marker — for long outputs where the
 *             end (final message / verdict) holds the important part.
 *  - "middle" keep both head and tail with a marker between them.
 */
export function truncate(
  text: string,
  max: number,
  position: "end" | "start" | "middle" = "end",
): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const markerFor = (n: number) => `\n... [truncated ${n} chars]`;
  // First estimate assumes the marker is free, then each pass re-derives the
  // removed count from the space the marker actually left.
  let removed = text.length - max;
  let marker = markerFor(removed);
  for (let i = 0; i < 4; i++) {
    const next = text.length - Math.max(0, max - marker.length);
    if (next === removed) break;
    removed = next;
    marker = markerFor(removed);
  }
  const room = max - marker.length;
  if (room < (position === "end" ? 1 : 2)) {
    // The budget cannot hold the wording at all: honour the bound rather than
    // the message, and mark the cut with a single character.
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }
  if (position === "start") {
    return `${marker}\n${text.slice(text.length - (room - 1))}`;
  }
  if (position === "middle") {
    const budget = room - 1;
    const headLen = Math.ceil(budget / 2);
    const tailLen = budget - headLen;
    return `${text.slice(0, headLen)}${marker}\n${text.slice(text.length - tailLen)}`;
  }
  return `${text.slice(0, room)}${marker}`;
}

/**
 * Native json_schema `format` is rejected by some providers (e.g. thinking models
 * that disallow the forced tool_choice). Appending the schema as an instruction
 * keeps the plain-text path producing parseable JSON after `retryWithoutFormat`.
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "",
    "Respond with a single JSON value that strictly conforms to this JSON Schema.",
    "Output only the JSON, with no prose and no markdown code fences.",
    JSON.stringify(schema),
  ].join("\n");
}

export function describeError(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const anyErr = err as { name?: string; message?: string; data?: unknown };
  const name = anyErr.name ? `${anyErr.name}: ` : "";
  const message = anyErr.message ?? "";
  // L61: JSON.stringify can throw on circular references — wrap in try/catch.
  let data = "";
  if (anyErr.data) {
    try {
      data = ` ${JSON.stringify(anyErr.data)}`;
    } catch {
      data = ` [unserializable data]`;
    }
  }
  const out = `${name}${message}${data}`.trim();
  if (out) return out;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Best-effort extraction of the first JSON object/array from free text. */
export function parseJsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  if (start >= 0) {
    const lastBrace = text.lastIndexOf("}");
    const lastBracket = text.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  candidates.push(text.trim());
  for (const c of candidates) {
    if (!c) continue;
    // Tolerate JSON-with-comments: strip `//` line comments and trailing
    // commas before `}`/`]` before parsing. Models frequently emit these
    // and JSON.parse rejects them outright.
    const cleaned = c
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/^\s*\/\/.*$/gm, "");
    try {
      return JSON.parse(cleaned);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * True when an error looks like the model/provider cannot honor the requested
 * structured-output mode (json_schema -> tool_choice). Several providers reject
 * this, e.g. "Thinking mode does not support this tool_choice".
 */
export function formatUnsupported(message: string | undefined): boolean {
  if (!message) return false;
  return /structured.?output|json_schema|StructuredOutputError|tool_choice|tool choice|does not support/i.test(
    message,
  );
}

export function parseModelString(model: string): ModelRef | { error: string } {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) {
    return { error: `Invalid model "${model}" - expected "providerID/modelID".` };
  }
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

// ----------------------------------------------------------------------
// Concurrent-edit helpers
//
// Pure functions behind file claiming, kept here so they can be unit tested
// without a plugin context. Their input is a `tool.execute.before` payload,
// whose `input` is `unknown` and belongs to whichever tool the agent reached
// for, so every walk below is bounded.
// ----------------------------------------------------------------------

/** Windows and default macOS resolve paths case-insensitively. */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** Input keys the common file-mutating tools put the target path under. */
const PATH_KEYS: ReadonlySet<string> = new Set([
  "filePath",
  "file_path",
  "path",
  "file",
  "target",
  "filename",
  "fileName",
  "notebookPath",
  "notebook_path",
]);

/** Tool names that write to disk. */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "patch",
  "apply_patch",
  "applypatch",
  "str_replace",
  "str_replace_editor",
  "notebook_edit",
  "create_file",
  "write_file",
  "edit_file",
  "replace_in_file",
]);

/** Verb fragment, so namespaced and MCP spellings are caught too. */
const FILE_WRITE_VERB = /(^|[_:.-])(edit|write|patch|str[_-]?replace|notebook[_-]?edit|apply)/;

/** Does this tool write to disk? Catches `edit`, `fs.write_file`, `mcp__x__edit`. */
export function isFileMutatingTool(tool: string): boolean {
  const t = tool.toLowerCase();
  if (FILE_WRITE_TOOLS.has(t)) return true;
  const tail = t.split(/[_:.]/).pop() ?? t;
  return FILE_WRITE_TOOLS.has(tail) || FILE_WRITE_VERB.test(t);
}

/** Hard bounds on the input walk, so a huge payload cannot stall the hook. */
const MAX_SCAN_NODES = 256;
const MAX_SCAN_DEPTH = 5;

/**
 * Pull target paths out of a file-mutating tool's arguments.
 *
 * Handles both a plain path field (`edit`'s `filePath`) and a unified diff
 * (`patch`'s `patch` / `apply_patch`'s `*** Update File:` header, whose file
 * names live inside the patch text rather than in a field).
 */
export function extractEditPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_SCAN_NODES;

  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 4096 || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const walk = (node: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > MAX_SCAN_DEPTH) return;
    if (typeof node === "string") {
      // L59: these regexes match any string containing lines starting with
      // `*** Add File:` or `+++ b/...`. This is a heuristic — it can match
      // prose that happens to contain such lines. The risk is low because
      // extractEditPaths is only called on tool inputs, not arbitrary text.
      for (const m of node.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(m[1]);
      // L58: filter out /dev/null which appears in +++ /dev/null for deleted files.
      for (const m of node.matchAll(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/gm)) {
        if (m[1] !== "/dev/null") add(m[1]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (PATH_KEYS.has(key)) add(value);
      // Recurse into strings too, not just containers: a `patch` argument is a
      // string whose file names live in the diff header, and the string branch
      // above is what reads them. Skipping strings here would silently make
      // every patch-style tool invisible to claiming.
      else walk(value, depth + 1);
    }
  };

  walk(input, 0);
  return out;
}

/**
 * Canonical key for a claimed path: project-relative, forward-slashed, and
 * case-folded where the filesystem needs it — otherwise two agents editing
 * `README.md` and `readme.md` would both be told they are alone.
 *
 * A path outside the project still collides, so it keeps an absolute marker
 * rather than being dropped.
 */
export function normalizeClaimPath(raw: string, directory: string): string | undefined {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.length > 4096) return undefined;
  // L60: resolve directory to absolute first so relative paths work correctly.
  const absDir = isAbsolute(directory) ? directory : resolvePath(directory);
  const abs = isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(absDir, trimmed);
  let rel = relativePath(absDir, abs);
  if (!rel || rel.split(sep).includes("..")) rel = abs;
  const slashed = rel.split(sep).join("/");
  return CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
}

/**
 * Generic words that make two declared tasks look related when they are not.
 *
 * Deliberately includes the everyday verbs agents put in a task string
 * ("updating", "fixing"): the point is a *specific* overlap, not a shared verb.
 * A false positive costs one line of context; a false negative risks two
 * agents picking the same task.
 */
const TASK_STOPWORDS: ReadonlySet<string> = new Set([
  "add", "adding", "all", "also", "and", "any", "are", "back", "been", "being", "but",
  "can", "change", "changes", "clean", "cleanup", "code", "could", "current", "debug",
  "did", "does", "doing", "done", "file", "files", "fix", "fixes", "fixing", "for", "from",
  "get", "getting", "has", "have", "here", "into", "its", "just", "let", "like", "make",
  "making", "may", "more", "need", "needs", "new", "next", "not", "now", "old", "only",
  "our", "out", "over", "please", "put", "see", "set", "should", "some", "still", "such",
  "test", "tests", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "to", "todo", "update", "updated", "updates", "updating",
  "upon", "use", "used", "uses", "using", "very", "want", "was", "way", "were", "what",
  "when", "where", "which", "while", "will", "with", "work", "working", "works", "would",
  "you", "your",
]);

/** Content words in a declared task, used for cheap task-overlap matching. */
export function taskTokens(task: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!task) return out;
  for (const raw of task.toLowerCase().split(/[^a-z0-9._-]+/)) {
    const tok = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (tok.length < 3 || TASK_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Do two declared tasks share at least one content word? */
export function tasksOverlap(a: string | undefined, b: ReadonlySet<string>): boolean {
  if (!a) return false;
  for (const tok of taskTokens(a)) if (b.has(tok)) return true;
  return false;
}

/** Cancellable sleep: resolves after `ms`, or immediately when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryOptions = {
  /** Maximum number of attempts (default 3). */
  attempts?: number;
  /** Base delay in ms; doubles each attempt (default 250). */
  baseMs?: number;
  /** Upper bound for any single backoff sleep in ms (default 5000). */
  maxMs?: number;
  /** Fraction of jitter to apply, 0-1 (default 0.2). */
  jitter?: number;
  /** Called before each retry sleep; return false to stop retrying. */
  onRetry?: (err: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Signal that aborts the retry loop when fired. */
  signal?: AbortSignal;
};

/**
 * Run an async function with exponential backoff and jitter.
 *
 * Every attempt runs; on failure the delay is `baseMs * 2^(n-1)` (capped at
 * `maxMs`) plus a random jitter of up to `jitter * delay`. The last failure is
 * rethrown. `onRetry` can veto further attempts (return false to give up).
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseMs = 250, maxMs = 5000, jitter = 0.2, onRetry, signal } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      if (onRetry && !(await onRetry(err, attempt))) break;
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = exp + Math.random() * jitter * exp;
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

/** Format a byte count as a human-readable string: "512 B", "1.5 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
