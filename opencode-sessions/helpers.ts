/**
 * Pure helpers shared by the opencode-sessions plugin.
 *
 * These live in their own module on purpose: opencode's local-plugin loader
 * treats *every* named export of a file under `plugins/` as a plugin factory, so
 * anything exported from the plugin file itself must be the plugin. Keeping the
 * helpers here lets unit tests import them without exposing non-plugin exports.
 */

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
