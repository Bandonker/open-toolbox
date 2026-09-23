/**
 * An independent policy model of DCP (`@tarquinen/opencode-dcp`) — the plugin
 * `context-pruner` was written to replace.
 *
 * PROVENANCE. This is *not* DCP's code: DCP is AGPL-3.0-or-later and nothing of
 * it is copied here. It is a behavioural model written from DCP's public
 * interface — its README, the published `dcp.schema.json` / `dist/lib/config.d.ts`
 * config surface, and the observable contract of its two automatic strategies
 * plus range compression — so the two plugins can be measured on identical
 * transcripts with identical model cooperation. Where DCP's behaviour leaves a
 * choice, this model takes the *best case for DCP* and says so inline.
 *
 * What it reproduces:
 *  - strategy `deduplication`: identical tool + identical normalised (sorted)
 *    arguments keep only the newest call; the older output becomes DCP's own
 *    placeholder text (DCP replaces the output, it does not delete the part).
 *  - strategy `purgeErrors`: for a tool call that errored, the *input* is
 *    removed after `purgeErrorsTurns` turns (default 4); the error text stays.
 *  - range compression: the model replaces a contiguous run of closed messages
 *    with one `[Compressed conversation section]` summary message, appended with
 *    the outputs of protected tools so they are not lost. The messages in the
 *    range — including their `tool-call` parts and arguments — leave the request.
 *  - defaults from DCP's config: protected tools `task, skill, todowrite,
 *    todoread, compress, batch, plan_enter, plan_exit, write, edit`; soft
 *    compression threshold `minContextLimit` 50 000 tokens, hard
 *    `maxContextLimit` 100 000 tokens.
 *
 * Cooperation modes (`cooperation`):
 *  - "nudged"    — DCP as shipped: the model compresses once the running
 *                  estimate reaches the soft threshold. This is the honest
 *                  comparison, because DCP's own automatic strategies are only
 *                  deduplication and error purging.
 *  - "unlimited" — the best case for DCP: the model compresses on every request,
 *                  so every closed message is summarised immediately. No
 *                  implementation can beat this by compressing *more*; it can
 *                  only beat it by leaving less behind.
 *
 * Both modes still keep two things a compression cannot touch: the *live turn*
 * (the newest user message and everything after it) and protected tool output.
 */

const PLACEHOLDER_OUTPUT = "[Output removed to save context - information superseded or no longer needed]";
const PLACEHOLDER_INPUT = "[input removed due to failed tool call]";
const BLOCK_HEADER = "[Compressed conversation section]";

export const DCP_DEFAULTS = {
  protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit", "write", "edit"],
  minContextLimit: 50_000,
  maxContextLimit: 100_000,
  purgeErrorsTurns: 4,
  deduplication: true,
  purgeErrors: true,
  /** Characters the cooperating model returns for one compressed range. */
  summaryChars: 509,
  charsPerToken: 3.6,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function normalize(value) {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(normalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || value[key] === null) continue;
    out[key] = normalize(value[key]);
  }
  return out;
}

/** DCP's signature: tool name plus normalised, sorted arguments. */
function signature(tool, input) {
  if (input === undefined) return tool;
  try {
    return `${tool}::${JSON.stringify(normalize(input))}`;
  } catch {
    return tool;
  }
}

const isToolResultPart = (part) => part?.type === "tool-result" || (part?.result !== undefined && part?.type === undefined);
const partId = (part) => String(part?.id ?? part?.toolCallId ?? "");
const partText = (part) => (typeof part?.result?.value === "string" ? part.result.value : JSON.stringify(part?.result?.value ?? ""));

function estimate(messages, charsPerToken) {
  return Math.ceil(JSON.stringify(messages).length / charsPerToken);
}

/**
 * Compile one outgoing request the way DCP does.
 *
 * @param {Array} input       hook-shaped messages (assistant `tool-call` parts,
 *                            `tool`-role `tool-result` parts, `text` parts)
 * @param {object} [options]  see DCP_DEFAULTS; `cooperation` is "nudged" | "unlimited"
 * @returns {{ messages: Array, stats: object }}
 */
export function compileWithDcp(input, options = {}) {
  const cfg = { ...DCP_DEFAULTS, cooperation: "nudged", ...options };
  const messages = clone(input);
  const stats = {
    prunedOutputs: 0,
    purgedInputs: 0,
    compressedMessages: 0,
    compressedRanges: 0,
    summaryChars: 0,
    protectedChars: 0,
    placeholderChars: 0,
    compressed: false,
  };

  // ---------------------------------------------------------------- inventory
  const calls = new Map(); // id -> { mi, pi, part, tool, input, turn, errored }
  const results = new Map(); // id -> { mi, pi, part, tool }
  let turn = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    const content = Array.isArray(messages[mi]?.content) ? messages[mi].content : [];
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi] ?? {};
      if (part.type === "tool-call") {
        const id = partId(part);
        if (id) calls.set(id, { mi, pi, part, tool: String(part.name ?? "tool"), input: part.input, turn, errored: false });
      } else if (isToolResultPart(part)) {
        const id = partId(part);
        if (id) results.set(id, { mi, pi, part, tool: String(part.name ?? "tool") });
      }
    }
    if (String(messages[mi]?.role ?? "") === "user") turn++;
  }
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (result) call.errored = result.part?.result?.type === "error";
  }
  const totalTurn = turn;

  const protectedId = (id) => {
    const tool = calls.get(id)?.tool ?? results.get(id)?.tool ?? "";
    return cfg.protectedTools.includes(tool);
  };

  // ------------------------------------------------- deduplication (strategy)
  if (cfg.deduplication) {
    const newest = new Map();
    for (const [id, call] of calls) newest.set(signature(call.tool, call.input), id);
    for (const [id, call] of calls) {
      const result = results.get(id);
      if (!result) continue;
      if (newest.get(signature(call.tool, call.input)) === id) continue;
      if (protectedId(id)) continue;
      if (partText(result.part) === PLACEHOLDER_OUTPUT) continue;
      result.part.result = { ...(result.part.result ?? { type: "text" }), type: "text", value: PLACEHOLDER_OUTPUT };
      stats.prunedOutputs++;
      stats.placeholderChars += PLACEHOLDER_OUTPUT.length;
    }
  }

  // -------------------------------------------------- purge errors (strategy)
  if (cfg.purgeErrors) {
    for (const [id, call] of calls) {
      if (!call.errored) continue;
      if (protectedId(id)) continue;
      if (totalTurn - call.turn < Math.max(1, cfg.purgeErrorsTurns)) continue;
      if (call.part.input === undefined || call.part.input === PLACEHOLDER_INPUT) continue;
      call.part.input = PLACEHOLDER_INPUT;
      stats.purgedInputs++;
      stats.placeholderChars += PLACEHOLDER_INPUT.length;
    }
  }

  // ------------------------------------------------------ range compression
  const before = estimate(messages, cfg.charsPerToken);
  const mayCompress = cfg.cooperation === "unlimited" || before >= cfg.minContextLimit;
  if (mayCompress) {
    let live = -1;
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      if (String(messages[mi]?.role ?? "") === "user") {
        live = mi;
        break;
      }
    }
    const end = live < 0 ? messages.length : live; // the closed region is [0, end)
    if (end > 0) {
      // Protected tool output is not discarded: DCP appends it to the summary.
      const retained = [];
      for (let mi = 0; mi < end; mi++) {
        for (const part of messages[mi]?.content ?? []) {
          if (isToolResultPart(part) && protectedId(partId(part))) retained.push(partText(part));
        }
      }
      const summary = [
        BLOCK_HEADER,
        "Summary: ".padEnd(cfg.summaryChars, "x"),
        ...(retained.length > 0 ? [retained.join("\n")] : []),
        "<dcp-message-id>b1</dcp-message-id>",
      ].join("\n");
      const anchor = messages[0] ?? { role: "user", content: [] };
      messages.splice(0, end, {
        ...anchor,
        role: "user",
        content: [{ type: "text", id: `${anchor.id ?? "msg"}:dcp-summary`, text: summary }],
      });
      stats.compressed = true;
      stats.compressedMessages = end;
      stats.compressedRanges = 1;
      stats.summaryChars = summary.length;
      stats.protectedChars = retained.reduce((sum, text) => sum + text.length, 0);
    }
  }

  return { messages, stats };
}
