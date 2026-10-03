import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { redactSecrets } from "../lib/redact.ts";

/**
 * session-export
 *
 * Dumps the current session transcript to disk (or returns it inline) in
 * markdown / json / jsonl / text. Registered tools:
 *
 *   - session_export:      render + write (or return) the transcript
 *   - session_export_info: report resolved config, default dir, last export
 *
 * Transcripts are sensitive: by default secrets are scrubbed and the user's
 * home directory is rewritten to `~`. See `sanitize()`.
 */

type ExportFormat = "markdown" | "json" | "jsonl" | "text" | "html" | "csv";

type ExportConfig = {
  enabled: boolean;
  format: ExportFormat;
  includeReasoning: boolean;
  includeToolCalls: boolean;
  includeToolResults: boolean;
  maxCharsPerPart: number;
  maxMessages: number;
  redact: boolean;
  dir: string | undefined;
  /** E346: include system messages in the export. */
  includeSystemMessages: boolean;
};

type ExportArgs = {
  format?: ExportFormat;
  sessionID?: string;
  includeReasoning?: boolean;
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
  tools?: string[];
  roles?: string[];
  maxCharsPerPart?: number;
  maxMessages?: number;
  redact?: boolean;
  dest?: string;
  inline?: boolean;
  since?: string;
  until?: string;
  summaryOnly?: boolean;
  conversationOnly?: boolean;
  /** E341: gzip-compress the output file. */
  compress?: boolean;
  /** E342: export multiple sessions at once. */
  sessionIDs?: string[];
  /** E344: write to stdout instead of a file. */
  stdout?: boolean;
  /** E348: auto-scale truncation when maxCharsPerPart is too high. */
  autoTruncate?: boolean;
};

// Structurally loose views of the SessionMessageInfo union. The plugin only
// reads a few fields per variant and never trusts the exact shape.
type LooseTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};
type LooseModel = { id?: string; providerID?: string; variant?: string };
type LooseToolState = {
  status?: string;
  input?: unknown;
  content?: unknown;
  error?: unknown;
};
type LoosePart = {
  type?: string;
  text?: string;
  name?: string;
  state?: LooseToolState;
};
type LooseMessage = {
  type?: string;
  id?: string;
  time?: { created?: number };
  text?: string;
  description?: string;
  skill?: string;
  name?: string;
  command?: string;
  status?: string;
  output?: { output?: string } | string;
  reason?: string;
  summary?: string;
  recent?: string;
  agent?: string;
  model?: LooseModel;
  cost?: number;
  tokens?: LooseTokens;
  content?: LoosePart[];
};

type OutPart = {
  kind: "text" | "reasoning" | "tool" | "note";
  text?: string;
  name?: string;
  status?: string;
  input?: string;
  output?: string;
  error?: string;
};

type OutMessage = {
  index: number;
  role: string;
  id?: string;
  time?: string;
  agent?: string;
  model?: string;
  cost?: number;
  tokens?: TokenSummary;
  text?: string;
  parts?: OutPart[];
};

type TokenSummary = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type ExportMeta = {
  sessionID: string;
  exportedAt: string;
  format: ExportFormat;
  messageCount: number;
  countsByRole: Record<string, number>;
  toolCalls: number;
  model?: string;
  agent?: string;
  tokens?: TokenSummary;
  cost?: number;
  redacted: boolean;
  truncated: boolean;
  /** E345: per-message token usage timeline. */
  tokenTimeline?: Array<{ index: number; role: string; input: number; output: number; total: number }>;
  /** E347: SHA-256 checksum of the exported file. */
  checksum?: string;
};

type LastExport = {
  path: string;
  format: ExportFormat;
  time: string;
  bytes: number;
  messages: number;
};

// --------------------------------------------------------------- config

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  }
  return fallback;
}

function asInt(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= min ? i : fallback;
}

function asFormat(value: unknown, fallback: ExportFormat): ExportFormat {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "markdown" || s === "md") return "markdown";
  if (s === "json") return "json";
  if (s === "jsonl") return "jsonl";
  if (s === "text" || s === "txt") return "text";
  if (s === "html" || s === "htm") return "html";
  // SE-3: csv was a dead format — renderCSV existed but neither the config
  // parser nor the tool schema accepted it.
  if (s === "csv") return "csv";
  return fallback;
}

function resolveConfig(options: Record<string, unknown> | undefined): ExportConfig {
  const o = options ?? {};
  const env = (key: string): string | undefined => {
    const v = process.env[key];
    return v === undefined || v === "" ? undefined : v;
  };
  const pick = (optionKey: string, envKey: string): unknown => o[optionKey] ?? env(envKey);
  return {
    enabled: asBool(pick("enabled", "OPENCODE_SESSION_EXPORT_ENABLED"), true),
    format: asFormat(pick("format", "OPENCODE_SESSION_EXPORT_FORMAT"), "markdown"),
    includeReasoning: asBool(pick("includeReasoning", "OPENCODE_SESSION_EXPORT_INCLUDE_REASONING"), false),
    includeToolCalls: asBool(pick("includeToolCalls", "OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_CALLS"), true),
    includeToolResults: asBool(pick("includeToolResults", "OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_RESULTS"), true),
    maxCharsPerPart: asInt(pick("maxCharsPerPart", "OPENCODE_SESSION_EXPORT_MAX_PART_CHARS"), 4000, 1),
    maxMessages: asInt(pick("maxMessages", "OPENCODE_SESSION_EXPORT_MAX_MESSAGES"), 2000, 0),
    redact: asBool(pick("redact", "OPENCODE_SESSION_EXPORT_REDACT"), true),
    dir: (pick("dir", "OPENCODE_SESSION_EXPORT_DIR") as string | undefined) || undefined,
    // E346: include system messages in the export.
    includeSystemMessages: asBool(pick("includeSystemMessages", "OPENCODE_SESSION_EXPORT_INCLUDE_SYSTEM_MESSAGES"), true),
  };
}

// ------------------------------------------------------------ redaction

function rewriteHome(text: string): string {
  try {
    const home = homedir();
    if (!home) return text;
    // L104: use a regex with a path-boundary lookbehind so that
    // `/home/user-other/file` is NOT rewritten when home is `/home/user`.
    // The boundary class keeps path characters out (a preceding `/` or word
    // char means this is a longer, different path) but SE-5 adds the
    // assignment/punctuation starts `=`, `(`, `[`, `:` and `,` — exports
    // kept leaking `cwd=/home/user/app`- and `"at": "/home/user/…`-style
    // occurrences un-rewritten under the old whitespace/quote-only class.
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedFwd = home.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedBack = home.replace(/\\/g, "\\\\").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let out = text;
    for (const variant of [escapedHome, escapedFwd, escapedBack]) {
      if (!variant) continue;
      // Match home only when preceded by start, whitespace, a quote, or one
      // of the SE-5 delimiters (= ( [ : ,).
      out = out.replace(new RegExp(`(^|[\\s"'\\\`=(\\[,:])${variant}`, "g"), "$1~");
    }
    return out;
  } catch {
    return text;
  }
}

/**
 * SE-2: the detection core (lib/redact collectFindings) scans at most this
 * many chars, head/tail windows only — lib/redact exposes no cap knob today
 * (LIB-8), so mirror its MAX_SCAN here. Anything beyond the windows is
 * UNscanned and must never reach an export file.
 */
const EXPORT_SCAN_CAP = 2_000_000;

/**
 * SE-2: seam guard — clamp() first means a secret straddling the cut would
 * no longer match any rule, so sanitize() sees `max + SEAM` chars and the
 * kept prefix is cut only after redaction. Replacements only shorten, so
 * the first `max` chars of the sanitized window can only contain
 * already-scanned, already-scrubbed content.
 */
const SANITIZE_SEAM = 16384;

/** Scrub secrets and rewrite the home directory to `~`. */
function sanitize(text: string, cfg: ExportConfig): string {
  if (!cfg.redact || !text) return text;
  // X1/H4: scrub with the same detection core secret-shield uses
  // (lib/redact) — the old private pattern list was much weaker, and
  // exports are the leakiest surface in a leak-prevention pack.
  // Neutralize inline `secret-shield:allow` markers first: they are honoured
  // by the detection core, and transcript text is untrusted — a tool eching
  // `<secret> // secret-shield:allow` would otherwise be written verbatim.
  // L103: only `secret-shield:allow` is handled. Other inline allow markers
  // (e.g. `secret-shield:audit`) are not neutralized — they don't suppress
  // detection so they don't need to be scrubbed from exports.
  let neutralized = text.replace(/secret-shield\s*:\s*allow/gi, "secret-shield allow");
  // SE-2 fail closed: text past the detection core's scan windows would be
  // written verbatim — splice the unscanned middle out (same approach as the
  // shield's processText gap) so every byte in the export was scanned.
  if (neutralized.length > EXPORT_SCAN_CAP) {
    const half = Math.floor(EXPORT_SCAN_CAP / 2);
    neutralized = `${neutralized.slice(0, half)}\n[session-export: ${neutralized.length - EXPORT_SCAN_CAP} unscanned chars removed]\n${neutralized.slice(neutralized.length - half)}`;
  }
  return rewriteHome(redactSecrets(neutralized));
}

/**
 * SE-2: clamp BEFORE sanitize (the old sanitize-then-clamp order redaction-
 * scanned every char of a multi-MB part — only the first maxCharsPerPart
 * ever ship). The scan window keeps the SANITIZE_SEAM tail so a secret
 * straddling the cut is still fully matched and replaced; the kept content
 * is cut to `max` after scrubbing. SE-2 also retired the standalone clamp()
 * helper — the truncation marker moved here.
 */
function fitAndSanitize(text: string, max: number, hit: { value: boolean } | undefined, cfg: ExportConfig): string {
  if (text.length <= max) return sanitize(text, cfg);
  if (hit) hit.value = true;
  const window = sanitize(text.slice(0, max + SANITIZE_SEAM), cfg);
  return `${window.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

// ------------------------------------------------------- normalization

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

function tokenSummary(t: LooseTokens): TokenSummary {
  const input = num(t.input);
  const output = num(t.output);
  const reasoning = num(t.reasoning);
  const cacheRead = num(t.cache?.read);
  const cacheWrite = num(t.cache?.write);
  return { input, output, reasoning, cacheRead, cacheWrite, total: input + output + reasoning + cacheRead + cacheWrite };
}

function modelLabel(m?: LooseModel): string | undefined {
  if (!m) return undefined;
  if (m.providerID && m.id) return `${m.providerID}/${m.id}${m.variant ? `:${m.variant}` : ""}`;
  return m.id ?? m.providerID;
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const o = item as { type?: string; text?: string; uri?: string; mime?: string };
      if (o.type === "text" && typeof o.text === "string") chunks.push(o.text);
      else if (o.type === "file") chunks.push(`[file ${o.mime ?? ""} ${o.uri ?? ""}]`.trim());
    }
  }
  return chunks.join("\n");
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { message?: string };
    if (typeof e.message === "string") return e.message;
  }
  return safeJson(err);
}

function shellText(msg: LooseMessage): string {
  const command = msg.command ?? "";
  const output = typeof msg.output === "string" ? msg.output : msg.output?.output;
  const parts = [`$ ${command}`];
  if (output) parts.push(output);
  if (typeof msg.status === "string") parts.push(`(status: ${msg.status})`);
  return parts.join("\n");
}

function textBody(msg: LooseMessage): string | undefined {
  const type = msg.type ?? "unknown";
  if (type === "user" || type === "system" || type === "synthetic") return msg.text;
  if (type === "skill") return `skill ${msg.name ?? msg.skill ?? ""} (${msg.skill ?? msg.name ?? ""})`.trim();
  if (type === "shell") return shellText(msg);
  if (type === "compaction") {
    const bits = [msg.summary ?? ""];
    if (msg.recent) bits.push(`recent: ${msg.recent}`);
    return bits.filter(Boolean).join("\n");
  }
  if (typeof msg.text === "string") return msg.text;
  return undefined;
}

function normalize(msg: LooseMessage, index: number, args: ExportArgs, cfg: ExportConfig): { out: OutMessage | null; toolCalls: number; partTruncated: boolean } {
  const role = msg.type ?? "unknown";
  if (args.roles && args.roles.length > 0 && !args.roles.includes(role)) return { out: null, toolCalls: 0, partTruncated: false };
  // E343: conversation-only — keep just the user/assistant text exchange;
  // everything else (system, tool-only, etc.) is dropped.
  if (args.conversationOnly && role !== "user" && role !== "assistant") return { out: null, toolCalls: 0, partTruncated: false };
  // E346: include system messages in the export.
  if (role === "system" && !cfg.includeSystemMessages) return { out: null, toolCalls: 0, partTruncated: false };
  // E348: auto-scaling truncation — when maxCharsPerPart is set too high,
  // scale it down to keep the export manageable.
  let effectiveMaxChars = cfg.maxCharsPerPart;
  if (args.autoTruncate && effectiveMaxChars > 10000) {
    effectiveMaxChars = Math.max(1000, Math.floor(effectiveMaxChars / 4));
  }
  const out: OutMessage = { index, role };
  if (msg.id) out.id = msg.id;
  if (msg.time?.created) out.time = new Date(msg.time.created).toISOString();
  if (msg.agent) out.agent = msg.agent;
  const model = modelLabel(msg.model);
  if (model) out.model = model;
  if (typeof msg.cost === "number") out.cost = msg.cost;
  if (msg.tokens) out.tokens = tokenSummary(msg.tokens);

  let toolCalls = 0;
  const hit = { value: false };
  if (role === "assistant") {
    const parts: OutPart[] = [];
    if (!Array.isArray(msg.content)) {
      // msg.content is not an array (e.g. a string) — skip part processing.
    } else {
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string") {
        // SE-2: clamp BEFORE sanitize — only the chars that will ship are
        // redaction-scanned (a seam window keeps boundary secrets matched).
        parts.push({ kind: "text", text: fitAndSanitize(part.text, effectiveMaxChars, hit, cfg) });
      } else if (part.type === "reasoning") {
        if (!args.includeReasoning) continue;
        parts.push({ kind: "reasoning", text: fitAndSanitize(part.text ?? "", effectiveMaxChars, hit, cfg) });
      } else if (part.type === "tool") {
        if (!args.includeToolCalls || args.conversationOnly) continue;
        const name = part.name ?? "tool";
        if (args.tools && args.tools.length > 0 && !args.tools.includes(name)) continue;
        const state = part.state ?? {};
        const rendered: OutPart = { kind: "tool", name, status: state.status ?? "unknown" };
        if (state.input !== undefined) rendered.input = fitAndSanitize(safeJson(state.input), effectiveMaxChars, hit, cfg);
        if (args.includeToolResults) {
          if (state.status === "completed") {
            rendered.output = fitAndSanitize(toolContentText(state.content), effectiveMaxChars, hit, cfg);
          } else if (state.status === "error") {
            rendered.error = fitAndSanitize(errorText(state.error), effectiveMaxChars, hit, cfg);
          }
        }
        parts.push(rendered);
        toolCalls += 1;
      } else {
        parts.push({ kind: "note", text: `[part type=${part.type ?? "unknown"} omitted]` });
      }
    }
    out.parts = parts;
    }
    // E343: an assistant message with no text part (tool-only) is not part
    // of the text exchange — drop it.
    if (args.conversationOnly && !parts.some((p) => p.kind === "text")) {
      return { out: null, toolCalls: 0, partTruncated: false };
    }
  } else {
    const body = textBody(msg);
    if (body) out.text = fitAndSanitize(body, cfg.maxCharsPerPart, hit, cfg);
    // E343: a user message without text (e.g. a tool result) is not part of
    // the text exchange — drop it.
    if (args.conversationOnly && !out.text) return { out: null, toolCalls: 0, partTruncated: false };
  }
  return { out, toolCalls, partTruncated: hit.value };
}

function buildExport(
  messages: LooseMessage[],
  args: ExportArgs,
  cfg: ExportConfig,
  sessionID: string,
): { messages: OutMessage[]; meta: ExportMeta } {
  if (!Array.isArray(messages)) return { messages: [], meta: { sessionID, exportedAt: new Date().toISOString(), format: args.format ?? cfg.format, messageCount: 0, countsByRole: {}, toolCalls: 0, redacted: false, truncated: false } };
  // E339: date-range filter — applied BEFORE the maxMessages window so the
  // trailing-N window selects from the filtered set. Messages without a
  // timestamp are kept (their position in the range is unknown). Invalid
  // (unparseable) bounds are ignored rather than failing the export.
  let ranged = messages;
  if (args.since || args.until) {
    const sinceMs = args.since ? Date.parse(args.since) : null;
    const untilMs = args.until ? Date.parse(args.until) : null;
    ranged = messages.filter((m) => {
      const t = m.time?.created;
      if (typeof t !== "number") return true;
      if (sinceMs !== null && !Number.isNaN(sinceMs) && t < sinceMs) return false;
      if (untilMs !== null && !Number.isNaN(untilMs) && t > untilMs) return false;
      return true;
    });
  }
  const limit = args.maxMessages ?? cfg.maxMessages;
  const windowed = limit > 0 && ranged.length > limit ? ranged.slice(-limit) : ranged;
  const out: OutMessage[] = [];
  const countsByRole: Record<string, number> = {};
  let toolCalls = 0;
  let tokens: TokenSummary | undefined;
  let cost: number | undefined;
  let model: string | undefined;
  let agent: string | undefined;
  const truncated = windowed.length !== messages.length;
  let partTruncated = false;
  // E345: per-message token usage timeline.
  const tokenTimeline: Array<{ index: number; role: string; input: number; output: number; total: number }> = [];

  for (const msg of windowed) {
    const { out: entry, toolCalls: calls, partTruncated: entryTruncated } = normalize(msg, out.length + 1, args, cfg);
    if (!entry) continue;
    if (entryTruncated) partTruncated = true;
    out.push(entry);
    countsByRole[entry.role] = (countsByRole[entry.role] ?? 0) + 1;
    toolCalls += calls;
    if (entry.tokens) {
      const t = entry.tokens;
      tokens = tokens ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      tokens.input += t.input;
      tokens.output += t.output;
      tokens.reasoning += t.reasoning;
      tokens.cacheRead += t.cacheRead;
      tokens.cacheWrite += t.cacheWrite;
      tokens.total += t.total;
      // E345: record per-message token usage.
      tokenTimeline.push({ index: entry.index, role: entry.role, input: t.input, output: t.output, total: t.total });
    }
    if (typeof entry.cost === "number") cost = (cost ?? 0) + entry.cost;
    if (!model && entry.model) model = entry.model;
    if (!agent && entry.agent) agent = entry.agent;
  }

  const meta: ExportMeta = {
    sessionID, // Raw on purpose: the session id is the export's primary key, not a secret.
    exportedAt: new Date().toISOString(),
    format: cfg.format,
    messageCount: out.length,
    countsByRole,
    toolCalls,
    redacted: cfg.redact,
    truncated: truncated || partTruncated,
  };
  if (model) meta.model = model;
  if (agent) meta.agent = agent;
  if (tokens) meta.tokens = tokens;
  if (typeof cost === "number") meta.cost = cost;
  // E345: include token timeline in meta.
  if (tokenTimeline.length > 0) meta.tokenTimeline = tokenTimeline;
  return { messages: out, meta };
}

// ------------------------------------------------------------ rendering

function roleCountsLine(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([role, n]) => `${role} ${n}`).join(", ");
}

function tokenLine(t: TokenSummary): string {
  return `in ${t.input}, out ${t.output}, reasoning ${t.reasoning}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}, total ${t.total}`;
}

function renderMarkdown(meta: ExportMeta, messages: OutMessage[]): string {
  const lines: string[] = ["# Session export", ""];
  lines.push(`- Session: ${meta.sessionID}`);
  if (meta.model) lines.push(`- Model: ${meta.model}`);
  if (meta.agent) lines.push(`- Agent: ${meta.agent}`);
  lines.push(`- Messages: ${meta.messageCount} (${roleCountsLine(meta.countsByRole)})`);
  lines.push(`- Tool calls: ${meta.toolCalls}`);
  if (meta.tokens) lines.push(`- Tokens: ${tokenLine(meta.tokens)}`);
  if (typeof meta.cost === "number") lines.push(`- Cost: $${meta.cost.toFixed(6)}`);
  lines.push(`- Exported: ${meta.exportedAt}`);
  lines.push(`- Redacted: ${meta.redacted ? "yes" : "no"}`);
  lines.push("", "---", "");

  if (!Array.isArray(messages)) return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  for (const msg of messages) {
    const annotations: string[] = [];
    if (msg.time) annotations.push(msg.time);
    if (msg.model) annotations.push(msg.model);
    if (msg.agent) annotations.push(msg.agent);
    lines.push(`## ${msg.index}. ${msg.role}${annotations.length ? ` — ${annotations.join(" · ")}` : ""}`, "");
    if (msg.text) lines.push(msg.text, "");
    for (const part of msg.parts ?? []) {
      if (part.kind === "text") {
        lines.push(part.text ?? "", "");
      } else if (part.kind === "reasoning") {
        lines.push("### reasoning", "", part.text ?? "", "");
      } else if (part.kind === "note") {
        lines.push(part.text ?? "", "");
      } else {
        lines.push(`### tool: ${part.name} (${part.status ?? "unknown"})`, "");
        if (part.input) lines.push("input:", "", part.input, "");
        if (part.output) lines.push("output:", "", part.output, "");
        if (part.error) lines.push("error:", "", part.error, "");
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderText(meta: ExportMeta, messages: OutMessage[]): string {
  const lines: string[] = ["SESSION EXPORT", ""];
  lines.push(`Session: ${meta.sessionID}`);
  if (meta.model) lines.push(`Model: ${meta.model}`);
  if (meta.agent) lines.push(`Agent: ${meta.agent}`);
  lines.push(`Messages: ${meta.messageCount} (${roleCountsLine(meta.countsByRole)})`);
  lines.push(`Tool calls: ${meta.toolCalls}`);
  if (meta.tokens) lines.push(`Tokens: ${tokenLine(meta.tokens)}`);
  if (typeof meta.cost === "number") lines.push(`Cost: $${meta.cost.toFixed(6)}`);
  lines.push(`Exported: ${meta.exportedAt}`, `Redacted: ${meta.redacted ? "yes" : "no"}`, "");
  if (!Array.isArray(messages)) return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  for (const msg of messages) {
    lines.push(`[${msg.index}] ${msg.role}${msg.time ? ` (${msg.time})` : ""}`);
    if (msg.text) lines.push(msg.text);
    for (const part of msg.parts ?? []) {
      if (part.kind === "reasoning") lines.push(`(reasoning) ${part.text ?? ""}`);
      else if (part.kind === "tool") {
        lines.push(`(tool ${part.name} ${part.status ?? "unknown"})${part.input ? ` ${part.input}` : ""}`);
        if (part.output) lines.push(`  -> ${part.output}`);
        if (part.error) lines.push(`  !! ${part.error}`);
      } else lines.push(part.text ?? "");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function render(meta: ExportMeta, messages: OutMessage[], format: ExportFormat): string {
  if (format === "json") return JSON.stringify({ meta, messages }, null, 2) + "\n";
  // The meta line carries sessionID, counts, redacted/truncated flags — without
  // it a jsonl consumer cannot tell a windowed export from a complete one.
  if (format === "jsonl")
    return [JSON.stringify({ meta }), ...messages.map((m) => JSON.stringify(m))].join("\n") + "\n";
  if (format === "text") return renderText(meta, messages);
  if (format === "html") return renderHTML(meta, messages);
  if (format === "csv") return renderCSV(meta, messages);
  return renderMarkdown(meta, messages);
}

/** E338: CSV export for tool calls — one row per tool call. */
function renderCSV(meta: ExportMeta, messages: OutMessage[]): string {
  const header = "index,role,tool_name,status,input_length,output_length,error";
  const rows: string[] = [header];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.parts) {
      for (const part of msg.parts) {
        if (part.kind === "tool") {
          const inputLen = part.input ? part.input.length : 0;
          const outputLen = part.output ? part.output.length : 0;
          const error = part.error ? "yes" : "no";
          rows.push(`${msg.index},${msg.role},${part.name ?? ""},${part.status ?? ""},${inputLen},${outputLen},${error}`);
        }
      }
    }
  }
  return rows.join("\n") + "\n";
}

// ------------------------------------------------------------ file output

const EXT_BY_FORMAT: Record<ExportFormat, string> = {
  markdown: "md",
  json: "json",
  jsonl: "jsonl",
  text: "txt",
  html: "html",
  csv: "csv",
};

const KNOWN_EXTS = new Set([".md", ".markdown", ".json", ".jsonl", ".txt", ".text", ".html", ".htm", ".csv"]);

/** Cap for inline responses; longer exports spill to a file with a pointer. */
const INLINE_MAX_CHARS = 100_000;

/** E337: escape HTML metacharacters (quotes are left as-is — output is element content, not attributes). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * E337: minimal syntax highlighting for fenced code blocks. A single-pass
 * regex alternation (comments → strings → keywords → numbers) over the
 * HTML-escaped source; earliest-match-wins ordering keeps `//` inside
 * strings and quotes inside comments from being mis-highlighted.
 */
function highlightCode(code: string): string {
  const esc = escapeHtml(code);
  return esc.replace(
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|enum|new|async|await|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|in|of|do|yield|static|get|set|public|private|protected|readonly|extends|implements|this|null|undefined|true|false|void|delete)\b|\b(\d+(?:\.\d+)?)\b/g,
    (m, comment, str, kw, num) => {
      if (comment) return `<span class="tok-com">${comment}</span>`;
      if (str) return `<span class="tok-str">${str}</span>`;
      if (kw) return `<span class="tok-kw">${kw}</span>`;
      if (num) return `<span class="tok-num">${num}</span>`;
      return m;
    },
  );
}

/** E337: render message text — fenced code blocks become highlighted <pre>, the rest paragraphs.
 * SE-4: split() with the two capture groups (language, code) yields
 * [para, lang, code, para, lang, code, ...] — an explicit stride-3 walk
 * (para at base, language at base+1, code at base+2) replaces the old
 * `% 3` ladder so the indices cannot silently drift out of sync with the
 * regex, and the language is surfaced as a `language-*` class. A stray
 * unterminated ``` no longer emits an empty <pre>.
 */
function renderTextHtml(text: string): string {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  const out: string[] = [];
  for (let base = 0; base < parts.length; base += 3) {
    const para = parts[base];
    if (para && para.trim()) {
      out.push(`<p>${escapeHtml(para).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`);
    }
    const lang = parts[base + 1] ?? "";
    const code = parts[base + 2];
    if (code !== undefined && code.trim()) {
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${highlightCode(code)}</code></pre>`);
    }
  }
  return out.join("\n");
}

/** E337: collapsible tool call — <details> keeps the transcript scannable. */
function renderToolHtml(part: OutPart): string {
  const name = escapeHtml(part.name ?? "tool");
  const status = escapeHtml(part.status ?? "unknown");
  const inner: string[] = [];
  if (part.input) {
    inner.push(`<div class="tool-io"><h4>Input</h4><pre><code>${highlightCode(part.input)}</code></pre></div>`);
  }
  if (part.output) {
    inner.push(`<div class="tool-io"><h4>Output</h4><pre><code>${highlightCode(part.output)}</code></pre></div>`);
  }
  if (part.error) {
    inner.push(`<div class="tool-io error"><h4>Error</h4><pre><code>${escapeHtml(part.error)}</code></pre></div>`);
  }
  return `<details class="tool"><summary>tool: ${name} (${status})</summary>${inner.join("\n")}</details>`;
}

/** E337: self-contained HTML export — inline CSS, highlighted code, collapsible tools. */
function renderHTML(meta: ExportMeta, messages: OutMessage[]): string {
  const body: string[] = [];
  for (const msg of messages) {
    const head = `<div class="msg-head"><span class="role">${escapeHtml(msg.role)}</span>${msg.time ? ` <time>${escapeHtml(msg.time)}</time>` : ""}</div>`;
    if (msg.role === "assistant" && msg.parts) {
      const blocks: string[] = [];
      for (const part of msg.parts) {
        if (part.kind === "text") blocks.push(renderTextHtml(part.text ?? ""));
        else if (part.kind === "reasoning") {
          blocks.push(`<details class="reasoning"><summary>reasoning</summary><pre>${escapeHtml(part.text ?? "")}</pre></details>`);
        } else if (part.kind === "tool") blocks.push(renderToolHtml(part));
        else if (part.text) blocks.push(`<p class="note">${escapeHtml(part.text)}</p>`);
      }
      body.push(`<article class="msg assistant">${head}<div class="msg-body">${blocks.join("\n")}</div></article>`);
    } else {
      body.push(`<article class="msg ${escapeHtml(msg.role)}">${head}<div class="msg-body">${msg.text ? renderTextHtml(msg.text) : ""}</div></article>`);
    }
  }
  const metaItems = [
    `<li><strong>Session:</strong> ${escapeHtml(meta.sessionID)}</li>`,
    `<li><strong>Messages:</strong> ${meta.messageCount}</li>`,
    `<li><strong>Exported:</strong> ${escapeHtml(meta.exportedAt)}</li>`,
    `<li><strong>Redacted:</strong> ${meta.redacted ? "yes" : "no"}</li>`,
    meta.tokens ? `<li><strong>Tokens:</strong> ${escapeHtml(tokenLine(meta.tokens))}</li>` : "",
    typeof meta.cost === "number" ? `<li><strong>Cost:</strong> $${meta.cost.toFixed(6)}</li>` : "",
  ].filter(Boolean);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session export — ${escapeHtml(meta.sessionID)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
header h1 { margin: 0 0 .5rem; font-size: 1.4rem; }
header ul { list-style: none; padding: 0; margin: 0 0 1.5rem; color: #666; font-size: .9rem; }
.msg { border: 1px solid #ddd; border-radius: 6px; margin: 0 0 1rem; padding: .75rem 1rem; }
.msg-head { font-size: .8rem; color: #666; margin-bottom: .5rem; }
.msg-head .role { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
.msg.user { background: #f6f8fa; }
.msg.assistant { background: #fff; }
.msg-body p { margin: 0 0 .75rem; }
.msg-body pre { background: #f6f8fa; border-radius: 4px; padding: .75rem; overflow-x: auto; font-size: .85rem; }
.msg-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
details.tool, details.reasoning { border-top: 1px solid #eee; margin-top: .5rem; padding-top: .5rem; }
details.tool summary, details.reasoning summary { cursor: pointer; font-size: .85rem; color: #555; }
.tool-io h4 { margin: .5rem 0 .25rem; font-size: .8rem; color: #666; }
.tool-io.error pre { background: #fff5f5; }
.tok-kw { color: #d73a49; }
.tok-str { color: #032f62; }
.tok-com { color: #6a737d; font-style: italic; }
.tok-num { color: #005cc5; }
footer { margin-top: 2rem; font-size: .8rem; color: #888; }
</style>
</head>
<body>
<header>
  <h1>Session export</h1>
  <ul>${metaItems.join("")}</ul>
</header>
<main>
${body.join("\n")}
</main>
<footer>Exported by open-toolbox session-export</footer>
</body>
</html>
`;
}

function fileStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function safeSessionID(sessionID: string): string {
  const cleaned = (sessionID || "").replace(/[^A-Za-z0-9_-]/g, "");
  // L102: use a longer truncation to reduce collision risk between sessions
  // sharing the same prefix. 16 chars is still filesystem-safe.
  return cleaned.slice(0, 16) || "session";
}

/** Pick a filename that does not exist yet, appending -2, -3, ... on collision. */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Atomically write content, creating the file exclusively (`wx`). On EEXIST
 * — another writer won the race, or the uniquePath() probe went stale — walk
 * to the next `-N` candidate and retry, so a concurrent export can never
 * silently overwrite ours (or be overwritten by ours). SE-1: the previous
 * version returned a unique path WITHOUT writing to it on EEXIST, and every
 * export call site kept calling bare writeFileSync anyway — the `wx` guard
 * was decorative and exports clobbered each other (L96).
 * X2: mode 0o600 — exports contain full transcripts (redacted secrets may
 * still be recoverable and session content is sensitive). `wx` guarantees
 * creation-time mode application.
 */
function writeFileSyncExclusive(path: string, content: string | Uint8Array): string {
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  const opts = typeof content === "string"
    ? { encoding: "utf8" as const, flag: "wx" as const, mode: 0o600 }
    : { flag: "wx" as const, mode: 0o600 };
  let target = path;
  for (let n = 2; n < 2000; n += 1) {
    try {
      writeFileSync(target, content, opts);
      return target;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      target = `${stem}-${n}${ext}`;
    }
  }
  // Extreme contention fallback: a timestamped name, still exclusive.
  target = `${stem}-${Date.now()}${ext}`;
  writeFileSync(target, content, opts);
  return target;
}

/**
 * Resolve `dest` (file or directory) to a concrete, non-colliding file path.
 * Confined to `rootDir` (the project): absolute or relative destinations that
 * resolve outside the project are refused, so a crafted `dest` cannot write
 * elsewhere on disk. Throws on escape.
 */
function resolveDestPath(dest: string, format: ExportFormat, sessionID: string, date: Date, rootDir: string): string {
  const looksDir = /[\\/]$/.test(dest);
  let asDir: boolean;
  if (looksDir) asDir = true;
  else {
    let isDir = false;
    try {
      // exists + stat in one guarded attempt; the calls below re-check anyway,
      // so a path that vanishes in between just falls through to file handling.
      if (existsSync(dest)) isDir = statSync(dest).isDirectory();
    } catch {
      isDir = false;
    }
    asDir = existsSync(dest) ? isDir : !KNOWN_EXTS.has(extname(dest).toLowerCase());
  }
  const target = asDir
    ? join(dest, `${fileStamp(date)}-${safeSessionID(sessionID)}.${EXT_BY_FORMAT[format]}`)
    : dest;
  const resolved = resolve(target);
  const root = resolve(rootDir);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to export outside the project directory: ${dest}`);
  }
  return uniquePath(resolved);
}

// --------------------------------------------------------------- plugin

export default Plugin.define({
  id: "session-export",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);
    const baseDir = (ctx.location?.directory as unknown as string | undefined) || process.cwd();
    const defaultDir = cfg.dir ?? join(baseDir, ".opencode-exports");
    let lastExport: LastExport | undefined;

    const effective = (args: ExportArgs, sessionID: string): ExportArgs => ({
      format: args.format ?? cfg.format,
      sessionID: args.sessionID ?? sessionID,
      includeReasoning: args.includeReasoning ?? cfg.includeReasoning,
      includeToolCalls: args.includeToolCalls ?? cfg.includeToolCalls,
      includeToolResults: args.includeToolResults ?? cfg.includeToolResults,
      tools: args.tools,
      roles: args.roles,
      maxCharsPerPart: args.maxCharsPerPart ?? cfg.maxCharsPerPart,
      maxMessages: args.maxMessages ?? cfg.maxMessages,
      redact: args.redact ?? cfg.redact,
      dest: args.dest,
      inline: args.inline,
      since: args.since,
      until: args.until,
      summaryOnly: args.summaryOnly,
      conversationOnly: args.conversationOnly,
      compress: args.compress,
      sessionIDs: args.sessionIDs,
      stdout: args.stdout,
      autoTruncate: args.autoTruncate,
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_export",
        description:
          "Export the current session transcript to markdown, json, jsonl, text, html or csv. Writes a file by default " +
          "(set `inline: true` to return the text instead). Secrets are redacted and home paths rewritten to `~` " +
          "by default; pass `redact: false` to keep raw content.",
        input: z.object({
          // SE-3: csv was renderable but unselectable — the enum and config
          // parser rejected it, so renderCSV was dead code.
          format: z.enum(["markdown", "json", "jsonl", "text", "html", "csv"]).optional().describe("Output format (default from config)."),
          sessionID: z.string().optional().describe("Session to export (default: the calling session)."),
          includeReasoning: z.boolean().optional().describe("Include assistant reasoning parts."),
          includeToolCalls: z.boolean().optional().describe("Include tool-call parts."),
          includeToolResults: z.boolean().optional().describe("Include tool results and errors (the call's name and arguments are still shown)."),
          tools: z.array(z.string()).optional().describe("Only include tool calls with these names."),
          roles: z.array(z.string()).optional().describe("Only include messages of these types."),
          maxCharsPerPart: z.number().int().positive().optional().describe("Truncate each part to this many chars."),
          maxMessages: z.number().int().min(0).optional().describe("Export at most this many trailing messages (0 = no limit)."),
          redact: z.boolean().optional().describe("Scrub secrets and home paths."),
          dest: z.string().optional().describe("Output file or directory (default: <cwd>/.opencode-exports/). Confined to the project directory — paths outside it are refused."),
          inline: z.boolean().optional().describe("Return the rendered text instead of writing a file."),
          since: z.string().optional().describe("Only include messages created at or after this ISO date."),
          until: z.string().optional().describe("Only include messages created at or before this ISO date."),
          summaryOnly: z.boolean().optional().describe("Render only the export metadata as JSON, skipping all message content."),
          conversationOnly: z.boolean().optional().describe("Include only user/assistant text messages — no tool calls or other parts."),
        }),
        execute: async (input, toolCtx) => {
          if (!cfg.enabled) {
            return { content: "session-export is disabled (set OPENCODE_SESSION_EXPORT_ENABLED=true or options.enabled)." };
          }
          const args = effective(input as ExportArgs, toolCtx.sessionID);
          const sessionID = args.sessionID ?? toolCtx.sessionID;
          const format = args.format ?? cfg.format;
          const callCfg: ExportConfig = {
            ...cfg,
            format,
            includeReasoning: args.includeReasoning ?? cfg.includeReasoning,
            includeToolCalls: args.includeToolCalls ?? cfg.includeToolCalls,
            includeToolResults: args.includeToolResults ?? cfg.includeToolResults,
            maxCharsPerPart: args.maxCharsPerPart ?? cfg.maxCharsPerPart,
            maxMessages: args.maxMessages ?? cfg.maxMessages,
            redact: args.redact ?? cfg.redact,
          };

          let raw: LooseMessage[];
          try {
            raw = (await ctx.session.context({ sessionID })) as unknown as LooseMessage[];
          } catch (err) {
            return { content: `session_export could not read session ${sessionID}: ${String(err)}` };
          }

          const { messages, meta } = buildExport(raw, args, callCfg, sessionID);
          meta.format = format;
          // E340: summary-only — render just the ExportMeta object as JSON,
          // skipping all message content.
          const rendered = args.summaryOnly ? `${JSON.stringify(meta, null, 2)}\n` : render(meta, messages, format);

          // E344: stdout output — write to stdout instead of a file.
          if (args.stdout) {
            process.stdout.write(rendered);
            return { content: `Exported ${messages.length} message(s) as ${format} to stdout.` };
          }

          // E342: multi-session export — export multiple sessions at once.
          if (args.sessionIDs && args.sessionIDs.length > 0) {
            const results: string[] = [];
            for (const sid of args.sessionIDs) {
              let rawMulti: LooseMessage[];
              try {
                rawMulti = (await ctx.session.context({ sessionID: sid })) as unknown as LooseMessage[];
              } catch (err) {
                results.push(`Session ${sid}: could not read (${String(err)})`);
                continue;
              }
              const { messages: msgs, meta: m } = buildExport(rawMulti, args, callCfg, sid);
              m.format = format;
              const r = args.summaryOnly ? `${JSON.stringify(m, null, 2)}\n` : render(m, msgs, format);
              const destMulti = args.dest ?? defaultDir;
              const dateMulti = new Date();
              let pathMulti: string;
              try {
                pathMulti = resolveDestPath(destMulti, format, sid, dateMulti, baseDir);
              } catch (err) {
                results.push(`Session ${sid}: ${String(err)}`);
                continue;
              }
              try {
                mkdirSync(dirname(pathMulti), { recursive: true });
                // SE-1: exclusive write with -N retry; never clobber a
                // concurrent export that raced past uniquePath().
                pathMulti = writeFileSyncExclusive(pathMulti, r);
                const bytesMulti = statSync(pathMulti).size;
                results.push(`Session ${sid}: exported ${msgs.length} message(s) to ${pathMulti} (${bytesMulti} bytes)`);
              } catch (err) {
                results.push(`Session ${sid}: could not write ${pathMulti} (${String(err)})`);
              }
            }
            return { content: results.join("\n") };
          }

          if (args.inline) {
            if (rendered.length <= INLINE_MAX_CHARS) return { content: rendered };
            // SE-2: inline responses are capped — spill the full text to a file and return a pointer.
            let spill: string;
            try {
              spill = resolveDestPath(defaultDir, format, sessionID, new Date(), baseDir);
            } catch (err) {
              return {
                content:
                  rendered.slice(0, INLINE_MAX_CHARS) +
                  `\n\n…[truncated at ${INLINE_MAX_CHARS} chars; full export could not be written: ${String(err)}]`,
              };
            }
            try {
              mkdirSync(dirname(spill), { recursive: true });
              // SE-1: exclusive write with -N retry (mode 0o600 is set by
              // writeFileSyncExclusive; on Windows privacy comes from the
              // directory ACLs instead).
              spill = writeFileSyncExclusive(spill, rendered);
              const bytes = statSync(spill).size;
              lastExport = { path: spill, format, time: new Date().toISOString(), bytes, messages: messages.length };
              return {
                content:
                  rendered.slice(0, INLINE_MAX_CHARS) +
                  `\n\n…[truncated at ${INLINE_MAX_CHARS} chars; full ${bytes}-byte ${format} export written to ${spill}]`,
              };
            } catch (err) {
              return {
                content:
                  rendered.slice(0, INLINE_MAX_CHARS) +
                  `\n\n…[truncated at ${INLINE_MAX_CHARS} chars; full export could not be written: ${String(err)}]`,
              };
            }
          }

          const dest = args.dest ?? defaultDir;
          const date = new Date();
          let path: string;
          try {
            path = resolveDestPath(dest, format, sessionID, date, baseDir);
          } catch (err) {
            return { content: `session_export: ${String(err)}` };
          }
          let bytes = 0;
          try {
            mkdirSync(dirname(path), { recursive: true });
            // SE-1: exclusive write with -N retry. X2: transcripts are
            // sensitive — writeFileSyncExclusive creates owner-only (0o600).
            // Note: `mode` applies on POSIX only; on Windows file privacy comes from the
            // parent directory ACLs, so keep the export dir out of shared locations.
            path = writeFileSyncExclusive(path, rendered);
            bytes = statSync(path).size;
            lastExport = { path, format, time: new Date().toISOString(), bytes, messages: messages.length };
            // E347: compute SHA-256 checksum of the exported file.
            const { createHash } = await import("crypto");
            const { readFileSync } = await import("fs");
            const checksum = createHash("sha256").update(readFileSync(path)).digest("hex");
            meta.checksum = checksum;
            // E341: gzip compression.
            if (args.compress) {
              const { gzipSync } = await import("zlib");
              const compressed = gzipSync(rendered, { level: 9 });
              // SE-1: exclusive write here too.
              const gzPath = writeFileSyncExclusive(`${path}.gz`, compressed);
              return {
                content:
                  `Exported ${messages.length} message(s) as ${format} to ${path} ` +
                  `(${bytes} bytes, ${meta.toolCalls} tool call(s), checksum: ${checksum}). ` +
                  `Compressed to ${gzPath} (${compressed.length} bytes).`,
              };
            }
            return {
              content:
                `Exported ${messages.length} message(s) as ${format} to ${path} ` +
                `(${bytes} bytes, ${meta.toolCalls} tool call(s), checksum: ${checksum}).`,
            };
          } catch (err) {
            return { content: `session_export could not write ${path}: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "session_export_info",
        description: "Show session-export configuration, the default export directory, and the last export.",
        input: z.object({}),
        execute: async () => {
          const lines = [
            "session-export",
            `enabled: ${cfg.enabled}`,
            `format: ${cfg.format}`,
            `include_reasoning: ${cfg.includeReasoning}`,
            `include_tool_calls: ${cfg.includeToolCalls}`,
            `include_tool_results: ${cfg.includeToolResults}`,
            `max_chars_per_part: ${cfg.maxCharsPerPart}`,
            `redact: ${cfg.redact}`,
            `default export dir: ${defaultDir}`,
            lastExport
              ? `last export: ${lastExport.path} (${lastExport.format}, ${lastExport.time}, ${lastExport.bytes} bytes, ${lastExport.messages} messages)`
              : "last export: no exports yet",
          ];
          return { content: lines.join("\n") };
        },
      });
    });
  },
});
