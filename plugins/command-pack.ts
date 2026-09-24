import { Plugin } from "@opencode/plugin";

/**
 * command-pack
 *
 * Registers slash commands that make the rest of the pack one keystroke away.
 * v1 could only define commands as markdown files; v2 lets a plugin register
 * them programmatically (`command.transform`).
 *
 * A command injects a short instruction into the current session, so the agent
 * does the work with its normal tools. If a command's tool is missing (that
 * plugin isn't installed) the instruction says so instead of failing silently.
 */

type CommandSpec = {
  name: string;
  description: string;
  /** Tool ids this command relies on; a missing one is reported to the user. */
  requires: string[];
  build: (args: string, available: ReadonlySet<string>) => string;
};

const TOOLBOX_TOOLS = [
  "spawn_session",
  "session_result",
  "session_send",
  "session_cancel",
  "session_permission",
  "session_handoff",
  "list_sessions",
  "decision_log",
  "decision_search",
  "decision_list",
  "decision_get",
  "decision_update",
  "error_log",
  "error_search",
  "error_list",
  "error_resolve",
  "error_delete",
  "snippet_save",
  "snippet_search",
  "snippet_list",
  "snippet_get",
  "snippet_delete",
  "codebase_index",
  "codebase_index_status",
  "codebase_search",
  "codebase_delete_index",
  "trace_query",
  "trace_stats",
  "trace_export",
  "context_pruner_stats",
  "session_export",
  "session_export_info",
  "memory_remember",
  "memory_recall",
  "memory_forget",
  "memory_list",
  "memory_stats",
  "secret_shield_scan",
  "secret_shield_stats",
  "secret_shield_shape",
  "secret_shield_keys",
  "stats_summary",
  "stats_tools",
  "stats_tokens",
  "stats_heatmap",
  "stats_dashboard",
];

/**
 * Q1: which plugin provides each toolbox tool. Used by /toolbox and by the
 * "plugin not installed" note so both name the provider, not just the tool.
 */
const TOOL_OWNERS: Record<string, string> = {
  spawn_session: "opencode-sessions",
  session_result: "opencode-sessions",
  session_send: "opencode-sessions",
  session_cancel: "opencode-sessions",
  session_permission: "opencode-sessions",
  session_handoff: "opencode-sessions",
  list_sessions: "opencode-sessions",
  decision_log: "decision-log",
  decision_search: "decision-log",
  decision_list: "decision-log",
  decision_get: "decision-log",
  decision_update: "decision-log",
  error_log: "error-journal",
  error_search: "error-journal",
  error_list: "error-journal",
  error_resolve: "error-journal",
  error_delete: "error-journal",
  snippet_save: "snippet-library",
  snippet_search: "snippet-library",
  snippet_list: "snippet-library",
  snippet_get: "snippet-library",
  snippet_delete: "snippet-library",
  codebase_index: "codebase-index",
  codebase_index_status: "codebase-index",
  codebase_search: "codebase-index",
  codebase_delete_index: "codebase-index",
  trace_query: "tool-audit",
  trace_stats: "tool-audit",
  trace_sessions: "tool-audit",
  trace_export: "tool-audit",
  context_pruner_stats: "context-pruner",
  context_pruner_recall: "context-pruner",
  context_report: "context-pruner",
  compress: "context-pruner",
  session_export: "session-export",
  session_export_info: "session-export",
  memory_remember: "memory",
  memory_recall: "memory",
  memory_forget: "memory",
  memory_list: "memory",
  memory_stats: "memory",
  secret_shield_scan: "secret-shield",
  secret_shield_stats: "secret-shield",
  secret_shield_shape: "secret-shield",
  secret_shield_keys: "secret-shield",
  stats_summary: "usage-stats",
  stats_tools: "usage-stats",
  stats_tokens: "usage-stats",
  stats_heatmap: "usage-stats",
  stats_dashboard: "usage-stats",
};

const ownerOf = (tool: string): string => TOOL_OWNERS[tool] ?? "unknown plugin";

/**
 * CP-5: delivery allowlist — only known delivery modes are forwarded to
 * session.prompt; anything else is dropped rather than passed through blindly.
 */
const DELIVERY_ALLOWLIST = new Set(["agent", "user", "queue", "steer"]);
function isAllowedDelivery(value: unknown): value is "agent" | "user" | "queue" | "steer" {
  return typeof value === "string" && DELIVERY_ALLOWLIST.has(value);
}

const COMMANDS: CommandSpec[] = [
  {
    name: "handoff",
    description:
      "Hand the current working point off to a fresh session (new session appears in the session switcher).",
    requires: ["session_handoff"],
    build: (args) =>
      [
        "Use the session_handoff tool to hand this work off to a new session.",
        `Brief for the new session: ${args || "continue from the current working point."}`,
        "Then report the new session id so it can be opened from the session switcher.",
      ].join("\n"),
  },
  {
    name: "decide",
    description: "Record an architectural/design decision in the decision log.",
    requires: ["decision_log"],
    build: (args) =>
      [
        "Record a decision with the decision_log tool.",
        `Decision: ${args || "(ask me what to record, then log it)"}`,
        'Infer a short title, the context and any consequences from this session; use status "accepted" unless I said otherwise. Then confirm the new decision id.',
      ].join("\n"),
  },
  {
    name: "journal",
    description: "Log a bug, mistake or recurring failure in the error journal.",
    requires: ["error_log"],
    build: (args) =>
      [
        "Log this in the error journal with the error_log tool.",
        `Problem: ${args || "(ask me what to log, then log it)"}`,
        "Include what was happening (context) and a few useful tags. If the fix is already known, record it with error_resolve.",
      ].join("\n"),
  },
  {
    name: "recall",
    description: "Search past decisions, errors, snippets and indexed code.",
    requires: ["decision_search", "error_search", "snippet_search", "codebase_search"],
    build: (args) =>
      [
        `Search the toolbox knowledge bases for: ${args || "(ask me what to look for)"}`,
        "Use decision_search, error_search and snippet_search, plus codebase_search for code.",
        "Summarise the most relevant hits with their ids, and say clearly if nothing matched.",
      ].join("\n"),
  },
  {
    name: "index",
    description: "Index this project for full-text code search.",
    requires: ["codebase_index"],
    build: (args) =>
      [
        `Index this project with codebase_index${args ? ` (path: ${args})` : ""}.`,
        "Then confirm the file and chunk counts with codebase_index_status.",
      ].join("\n"),
  },
  {
    name: "trace",
    description: "Inspect the tool-call audit log (what the agent actually ran).",
    requires: ["trace_query"],
    build: (args) =>
      [
        `Inspect the tool-call audit log for: ${args || "this session"}`,
        "Use trace_query, and trace_stats for counts.",
        "Report the calls that matter with their status, duration and any errors.",
      ].join("\n"),
  },
  {
    name: "toolbox",
    description: "Show which open-toolbox tools are installed in this session.",
    requires: [],
    build: (args, available) => {
      // CP-1: work from the live tool list and only fall back to the static
      // inventory when the live listing failed (empty set).
      const live = [...available];
      const source = live.length ? live : [...TOOLBOX_TOOLS];
      const installed = source.filter((t) => TOOLBOX_TOOLS.includes(t) && (!live.length || available.has(t)));
      const lines = installed.length
        ? installed.map((t) => `- ${t} (${ownerOf(t)})`)
        : ["(no open-toolbox tools detected)"];
      return [
        "These open-toolbox tools are installed in this session:",
        ...lines,
        args ? `\nFocus on: ${args}` : "",
        "\nSay which of them fits what I am doing right now, and suggest the single best next step.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
];

export default Plugin.define({
  id: "command-pack",
  async setup(ctx) {
    // CP-3: cache the tool listing — every command delivery re-invokes
    // toolIds(), and listing on each call is wasteful. 60s TTL.
    let toolIdsCache: { at: number; ids: Set<string> } | null = null;
    const toolIds = async (): Promise<Set<string>> => {
      if (toolIdsCache && Date.now() - toolIdsCache.at < 60_000) return toolIdsCache.ids;
      try {
        const tools = await ctx.tool.list();
        const ids = new Set(tools.map((t) => t.id));
        toolIdsCache = { at: Date.now(), ids };
        return ids;
      } catch (err) {
        console.error(`[command-pack] tool.list failed: ${String(err)}`);
        return toolIdsCache?.ids ?? new Set<string>();
      }
    };

    const registration = await ctx.command.transform((editor) => {
      for (const spec of COMMANDS) {
        editor.add({
          name: spec.name,
          description: spec.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            // CP-6: bound raw args — a pasted wall of text must not bloat every prompt.
            const rawArgs = (prompt?.text ?? "").trim();
            const args = rawArgs.length > 500 ? `${rawArgs.slice(0, 500)}…[truncated]` : rawArgs;
            const available = await toolIds();
            const missing = spec.requires.filter((t) => !available.has(t));
            const body = spec.build(args, available);
            const text = missing.length
              ? `Note: this command needs ${missing.map((t) => `${t} (from ${ownerOf(t)})`).join(", ")} but that plugin is not installed, so the request below cannot be completed.\n\n${body}`
              : body;
            try {
              await ctx.session.prompt({
                sessionID,
                text,
                ...(isAllowedDelivery(delivery) ? { delivery } : {}),
              });
            } catch (err) {
              // CP-4: surface prompt failures visibly — a bare console.error
              // leaves the user believing the command ran.
              console.error(`[command-pack] /${spec.name} failed to inject: ${String(err)}`);
              throw err;
            }
          },
        });
      }
    });

    console.error(
      `[command-pack] registered ${COMMANDS.length} commands: ${COMMANDS.map((c) => "/" + c.name).join(", ")}`,
    );

    return async () => {
      try {
        await registration.dispose();
      } catch {
        /* ignore */
      }
    };
  },
});
