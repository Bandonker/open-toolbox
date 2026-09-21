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
    requires: ["decision_search", "error_search", "snippet_search"],
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
      const installed = TOOLBOX_TOOLS.filter((t) => available.has(t));
      const lines = installed.length
        ? installed.map((t) => `- ${t}`)
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
    const toolIds = async (): Promise<Set<string>> => {
      try {
        const tools = await ctx.tool.list();
        return new Set(tools.map((t) => t.id));
      } catch (err) {
        console.error(`[command-pack] tool.list failed: ${String(err)}`);
        return new Set<string>();
      }
    };

    const registration = await ctx.command.transform((editor) => {
      for (const spec of COMMANDS) {
        editor.add({
          name: spec.name,
          description: spec.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            const args = (prompt?.text ?? "").trim();
            const available = await toolIds();
            const missing = spec.requires.filter((t) => !available.has(t));
            const body = spec.build(args, available);
            const text = missing.length
              ? `Note: this command needs ${missing.join(", ")} but that plugin is not installed, so the request below cannot be completed.\n\n${body}`
              : body;
            try {
              await ctx.session.prompt({
                sessionID,
                text,
                ...(delivery ? { delivery } : {}),
              });
            } catch (err) {
              console.error(`[command-pack] /${spec.name} failed to inject: ${String(err)}`);
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
