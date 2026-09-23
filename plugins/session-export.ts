import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, extname, join } from "path";
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

type ExportFormat = "markdown" | "json" | "jsonl" | "text";

type ExportConfig = {
  enabled: boolean;
  format: ExportFormat;
  includeReasoning: boolean;
  includeToolCalls: boolean;
  includeToolResults: boolean;
  maxCharsPerPart: number;
  redact: boolean;
  dir: string | undefined;
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
  redact?: boolean;
  dest?: string;
  inline?: boolean;
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
  kind: "text" | "reasoning" | "tool";
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
    includeToolCalls: asBool(o.includeToolCalls, true),
    includeToolResults: asBool(pick("includeToolResults", "OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_RESULTS"), true),
    maxCharsPerPart: asInt(pick("maxCharsPerPart", "OPENCODE_SESSION_EXPORT_MAX_PART_CHARS"), 4000, 1),
    redact: asBool(pick("redact", "OPENCODE_SESSION_EXPORT_REDACT"), true),
    dir: (pick("dir", "OPENCODE_SESSION_EXPORT_DIR") as string | undefined) || undefined,
  };
}

// ------------------------------------------------------------ redaction

function rewriteHome(text: string): string {
  try {
    const home = homedir();
    if (!home) return text;
    let out = text.split(home).join("~");
    const fwd = home.replace(/\\/g, "/");
    if (fwd !== home) out = out.split(fwd).join("~");
    // Paths embedded in JSON strings arrive with escaped backslashes.
    const escaped = home.replace(/\\/g, "\\\\");
    if (escaped !== home) out = out.split(escaped).join("~");
    return out;
  } catch {
    return text;
  }
}

/** Scrub secrets and rewrite the home directory to `~`. */
function sanitize(text: string, cfg: ExportConfig): string {
  if (!cfg.redact || !text) return text;
  // X1/H4: scrub with the same detection core secret-shield uses
  // (lib/redact) — the old private pattern list was much weaker, and
  // exports are the leakiest surface in a leak-prevention pack.
  return rewriteHome(redactSecrets(text));
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
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

function normalize(msg: LooseMessage, index: number, args: ExportArgs, cfg: ExportConfig): { out: OutMessage | null; toolCalls: number } {
  const role = msg.type ?? "unknown";
  if (args.roles && args.roles.length > 0 && !args.roles.includes(role)) return { out: null, toolCalls: 0 };
  const out: OutMessage = { index, role };
  if (msg.id) out.id = msg.id;
  if (msg.time?.created) out.time = new Date(msg.time.created).toISOString();
  if (msg.agent) out.agent = msg.agent;
  const model = modelLabel(msg.model);
  if (model) out.model = model;
  if (typeof msg.cost === "number") out.cost = msg.cost;
  if (msg.tokens) out.tokens = tokenSummary(msg.tokens);

  let toolCalls = 0;
  if (role === "assistant") {
    const parts: OutPart[] = [];
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ kind: "text", text: clamp(sanitize(part.text, cfg), cfg.maxCharsPerPart) });
      } else if (part.type === "reasoning") {
        if (!args.includeReasoning) continue;
        parts.push({ kind: "reasoning", text: clamp(sanitize(part.text ?? "", cfg), cfg.maxCharsPerPart) });
      } else if (part.type === "tool") {
        if (!args.includeToolCalls) continue;
        const name = part.name ?? "tool";
        if (args.tools && args.tools.length > 0 && !args.tools.includes(name)) continue;
        const state = part.state ?? {};
        const rendered: OutPart = { kind: "tool", name, status: state.status ?? "unknown" };
        if (state.input !== undefined) rendered.input = clamp(sanitize(safeJson(state.input), cfg), cfg.maxCharsPerPart);
        if (args.includeToolResults) {
          if (state.status === "completed") {
            rendered.output = clamp(sanitize(toolContentText(state.content), cfg), cfg.maxCharsPerPart);
          } else if (state.status === "error") {
            rendered.error = clamp(sanitize(errorText(state.error), cfg), cfg.maxCharsPerPart);
          }
        }
        parts.push(rendered);
        toolCalls += 1;
      }
    }
    out.parts = parts;
  } else {
    const body = textBody(msg);
    if (body) out.text = clamp(sanitize(body, cfg), cfg.maxCharsPerPart);
  }
  return { out, toolCalls };
}

function buildExport(
  messages: LooseMessage[],
  args: ExportArgs,
  cfg: ExportConfig,
  sessionID: string,
): { messages: OutMessage[]; meta: ExportMeta } {
  const out: OutMessage[] = [];
  const countsByRole: Record<string, number> = {};
  let toolCalls = 0;
  let tokens: TokenSummary | undefined;
  let cost: number | undefined;
  let model: string | undefined;
  let agent: string | undefined;

  for (const msg of messages) {
    const { out: entry, toolCalls: calls } = normalize(msg, out.length + 1, args, cfg);
    if (!entry) continue;
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
    }
    if (typeof entry.cost === "number") cost = (cost ?? 0) + entry.cost;
    if (!model && entry.model) model = entry.model;
    if (!agent && entry.agent) agent = entry.agent;
  }

  const meta: ExportMeta = {
    sessionID: sanitize(sessionID, cfg),
    exportedAt: new Date().toISOString(),
    format: cfg.format,
    messageCount: out.length,
    countsByRole,
    toolCalls,
    redacted: cfg.redact,
  };
  if (model) meta.model = model;
  if (agent) meta.agent = agent;
  if (tokens) meta.tokens = tokens;
  if (typeof cost === "number") meta.cost = cost;
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
  if (format === "jsonl") return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  if (format === "text") return renderText(meta, messages);
  return renderMarkdown(meta, messages);
}

// ------------------------------------------------------------ file output

const EXT_BY_FORMAT: Record<ExportFormat, string> = {
  markdown: "md",
  json: "json",
  jsonl: "jsonl",
  text: "txt",
};

const KNOWN_EXTS = new Set([".md", ".markdown", ".json", ".jsonl", ".txt", ".text"]);

function fileStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function safeSessionID(sessionID: string): string {
  const cleaned = (sessionID || "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.slice(0, 8) || "session";
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

/** Resolve `dest` (file or directory) to a concrete, non-colliding file path. */
function resolveDestPath(dest: string, format: ExportFormat, sessionID: string, date: Date): string {
  const looksDir = /[\\/]$/.test(dest);
  let asDir: boolean;
  if (looksDir) asDir = true;
  else if (existsSync(dest)) asDir = statSync(dest).isDirectory();
  else asDir = !KNOWN_EXTS.has(extname(dest).toLowerCase());
  const target = asDir
    ? join(dest, `${fileStamp(date)}-${safeSessionID(sessionID)}.${EXT_BY_FORMAT[format]}`)
    : dest;
  return uniquePath(target);
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
      redact: args.redact ?? cfg.redact,
      dest: args.dest,
      inline: args.inline,
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_export",
        description:
          "Export the current session transcript to markdown, json, jsonl or text. Writes a file by default " +
          "(set `inline: true` to return the text instead). Secrets are redacted and home paths rewritten to `~` " +
          "by default; pass `redact: false` to keep raw content.",
        input: z.object({
          format: z.enum(["markdown", "json", "jsonl", "text"]).optional().describe("Output format (default from config)."),
          sessionID: z.string().optional().describe("Session to export (default: the calling session)."),
          includeReasoning: z.boolean().optional().describe("Include assistant reasoning parts."),
          includeToolCalls: z.boolean().optional().describe("Include tool-call parts."),
          includeToolResults: z.boolean().optional().describe("Include tool results and errors (the call's name and arguments are still shown)."),
          tools: z.array(z.string()).optional().describe("Only include tool calls with these names."),
          roles: z.array(z.string()).optional().describe("Only include messages of these types."),
          maxCharsPerPart: z.number().int().positive().optional().describe("Truncate each part to this many chars."),
          redact: z.boolean().optional().describe("Scrub secrets and home paths."),
          dest: z.string().optional().describe("Output file or directory (default: <cwd>/.opencode-exports/)."),
          inline: z.boolean().optional().describe("Return the rendered text instead of writing a file."),
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
          const rendered = render(meta, messages, format);

          if (args.inline) return { content: rendered };

          const dest = args.dest ?? defaultDir;
          const date = new Date();
          const path = resolveDestPath(dest, format, sessionID, date);
          try {
            mkdirSync(dirname(path), { recursive: true });
            // X2: transcripts are sensitive — owner-readable/writable only.
            writeFileSync(path, rendered, { encoding: "utf8", mode: 0o600 });
          } catch (err) {
            return { content: `session_export could not write ${path}: ${String(err)}` };
          }
          const bytes = statSync(path).size;
          lastExport = { path, format, time: new Date().toISOString(), bytes, messages: messages.length };
          return {
            content:
              `Exported ${messages.length} message(s) as ${format} to ${path} ` +
              `(${bytes} bytes, ${meta.toolCalls} tool call(s)).`,
          };
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
