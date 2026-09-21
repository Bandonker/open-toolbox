import { Plugin } from "@opencode/plugin";
import { z } from "zod";

/**
 * context-pruner
 *
 * Trims stale tool output out of the context sent to the model on every request
 * (`session.hook("context")`). Long tool results from earlier turns are the
 * cheapest tokens to win back: the agent rarely re-reads them, yet they stay in
 * the transcript and are re-sent on every subsequent request.
 *
 * Strategy: walk the request messages, find every `tool-result` part, leave the
 * most recent `keepRecent` untouched, and replace older results longer than
 * `minChars` with a short stub that keeps a preview (`keepHeadChars`). Error
 * results are kept by default so failures stay debuggable. Nothing is removed
 * from the session on disk -- only the outgoing request is trimmed, so the
 * Desktop transcript is unchanged and a pruned tool can simply be re-run.
 *
 * v2-only: `session.hook("context")` did not exist in v1.
 */

type PrunerConfig = {
  enabled: boolean;
  keepRecent: number;
  minChars: number;
  keepHeadChars: number;
  keepErrors: boolean;
  ignoreTools: Set<string>;
  log: boolean;
};

type ResultLike = { type?: string; value?: unknown };
type PartLike = {
  type?: string;
  name?: string;
  result?: ResultLike;
  text?: string;
};
type MessageLike = { role?: string; content?: PartLike[] };

type Stats = {
  runs: number;
  partsPruned: number;
  charsSaved: number;
  lastRunAt: number;
  lastPartsPruned: number;
  lastCharsSaved: number;
};

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function resolveConfig(options: Record<string, unknown> | undefined): PrunerConfig {
  const o = options ?? {};
  const env = (key: string): string | undefined => process.env[key];
  const minChars = asInt(
    o.minChars ?? env("OPENCODE_CONTEXT_PRUNER_MIN_CHARS"),
    2000,
    200,
    1_000_000,
  );
  const keepHeadChars = Math.min(
    asInt(o.keepHeadChars ?? env("OPENCODE_CONTEXT_PRUNER_KEEP_HEAD"), 400, 0, minChars),
    Math.max(0, minChars - 1),
  );
  return {
    enabled: asBool(o.enabled ?? env("OPENCODE_CONTEXT_PRUNER_ENABLED"), true),
    keepRecent: asInt(o.keepRecent ?? env("OPENCODE_CONTEXT_PRUNER_KEEP_RECENT"), 6, 0, 500),
    minChars,
    keepHeadChars,
    keepErrors: asBool(o.keepErrors ?? env("OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS"), true),
    ignoreTools: new Set([
      "context_pruner_stats",
      ...asList(o.ignoreTools),
      ...asList(env("OPENCODE_CONTEXT_PRUNER_IGNORE")),
    ]),
    log: asBool(o.log ?? env("OPENCODE_CONTEXT_PRUNER_LOG"), false),
  };
}

/** Best-effort plain text for a tool result, regardless of its union variant. */
function resultText(result: ResultLike | undefined): string {
  if (!result) return "";
  if (result.type === "content" && Array.isArray(result.value)) {
    return (result.value as Array<{ type?: string; text?: string }>)
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result.value === "string") return result.value;
  try {
    const json = JSON.stringify(result.value);
    return json === undefined ? String(result.value) : json;
  } catch {
    return String(result.value);
  }
}

export default Plugin.define({
  id: "context-pruner",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);
    const stats: Stats = {
      runs: 0,
      partsPruned: 0,
      charsSaved: 0,
      lastRunAt: 0,
      lastPartsPruned: 0,
      lastCharsSaved: 0,
    };

    const log = (message: string): void => {
      if (!cfg.log) return;
      try {
        console.error(`[context-pruner] ${message}`);
      } catch {
        /* logging must never break a request */
      }
    };

    await ctx.session.hook("context", (event) => {
      if (!cfg.enabled) return;
      try {
        const messages = event.messages as unknown as MessageLike[];
        // Collect every tool-result part in chronological order.
        const parts: PartLike[] = [];
        for (const m of messages) {
          if (!Array.isArray(m?.content)) continue;
          for (const p of m.content) {
            if (p && p.type === "tool-result") parts.push(p);
          }
        }
        const pruneCount = Math.max(0, parts.length - cfg.keepRecent);
        let pruned = 0;
        let saved = 0;
        for (let i = 0; i < pruneCount; i += 1) {
          const part = parts[i];
          if (cfg.ignoreTools.has(String(part.name ?? ""))) continue;
          const result = part.result;
          if (!result) continue;
          if (cfg.keepErrors && result.type === "error") continue;
          const text = resultText(result);
          if (text.length < cfg.minChars) continue;
          const head = text.slice(0, cfg.keepHeadChars).trimEnd();
          const stub =
            `[context-pruner] output of "${part.name ?? "tool"}" pruned ` +
            `(${text.length} chars). Re-run the tool if you need it again.` +
            (head ? `\n\n${head}` : "");
          if (stub.length >= text.length) continue;
          // Message/part objects are structurally plain at runtime; the schema
          // types mark them readonly, so mutate through a widened view (same
          // approach as strip-skills-catalog).
          (part as { result: ResultLike }).result = { type: "text", value: stub };
          pruned += 1;
          saved += text.length - stub.length;
        }

        stats.runs += 1;
        stats.partsPruned += pruned;
        stats.charsSaved += saved;
        stats.lastRunAt = Date.now();
        stats.lastPartsPruned = pruned;
        stats.lastCharsSaved = saved;
        if (pruned > 0) {
          log(`pruned ${pruned} tool result(s), saved ${saved} chars`);
        }
      } catch (err) {
        log(`hook failed (context left untouched): ${String(err)}`);
      }
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "context_pruner_stats",
        description:
          "Show context-pruner activity: how many stale tool results were trimmed from outgoing requests, how many characters that saved, and the active configuration.",
        input: z.object({}),
        execute: async () => {
          const lines = [
            `enabled: ${cfg.enabled}`,
            `keep_recent: ${cfg.keepRecent}`,
            `min_chars: ${cfg.minChars}`,
            `keep_head_chars: ${cfg.keepHeadChars}`,
            `keep_errors: ${cfg.keepErrors}`,
            `ignore_tools: ${[...cfg.ignoreTools].join(", ") || "(none)"}`,
            "",
            `requests seen: ${stats.runs}`,
            `tool results pruned: ${stats.partsPruned}`,
            `characters saved: ${stats.charsSaved}`,
            stats.lastRunAt
              ? `last request: ${new Date(stats.lastRunAt).toISOString()} (pruned ${stats.lastPartsPruned}, saved ${stats.lastCharsSaved} chars)`
              : "last request: (none yet)",
          ];
          return { content: lines.join("\n") };
        },
      });
    });

    log(
      `enabled=${cfg.enabled} keepRecent=${cfg.keepRecent} minChars=${cfg.minChars} ` +
        `keepHeadChars=${cfg.keepHeadChars} keepErrors=${cfg.keepErrors}`,
    );
  },
});
