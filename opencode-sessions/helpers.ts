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
  const n = typeof value === "number" ? value : Number(value);
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
  return Math.random().toString(36).slice(2, 8);
}

export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0] ?? "";
  const trimmed = firstLine.trim().replace(/\s+/g, " ");
  if (!trimmed) return "untitled task";
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
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
  const data = anyErr.data ? ` ${JSON.stringify(anyErr.data)}` : "";
  const out = `${name}${message}${data}`.trim();
  return out || JSON.stringify(err);
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
    try {
      return JSON.parse(c);
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
      for (const m of node.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(m[1]);
      for (const m of node.matchAll(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/gm)) add(m[1]);
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
  const abs = isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(directory, trimmed);
  let rel = relativePath(directory, abs);
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
