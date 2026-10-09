import { Plugin } from "@opencode/plugin";
import { getRegisteredCommands } from "./lib/command-registry.js";
import { asBool, asInt } from "./lib/config.js";
import { promises as fsp } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";
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
    "trace_sessions",
    "trace_export",
    "context_pruner_stats",
    "context_pruner_recall",
    "context_report",
    "compress",
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
const TOOL_OWNERS = {
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
const ownerOf = (tool) => TOOL_OWNERS[tool] ?? "unknown plugin";
/**
 * CP-5: delivery allowlist — only known delivery modes are forwarded to
 * session.prompt; anything else is dropped rather than passed through blindly.
 */
const DELIVERY_ALLOWLIST = new Set(["agent", "user", "queue", "steer"]);
function isAllowedDelivery(value) {
    return typeof value === "string" && DELIVERY_ALLOWLIST.has(value);
}
const COMMANDS = [
    [
        "handoff",
        {
            description: "Hand the current working point off to a fresh session (new session appears in the session switcher).",
            requires: ["session_handoff"],
            build: (args) => [
                "Use the session_handoff tool to hand this work off to a new session.",
                `Brief for the new session: ${args || "continue from the current working point."}`,
                "Then report the new session id so it can be opened from the session switcher.",
            ].join("\n"),
        },
    ],
    [
        "decide",
        {
            description: "Record an architectural/design decision in the decision log.",
            requires: ["decision_log"],
            build: (args) => [
                "Record a decision with the decision_log tool.",
                `Decision: ${args || "(ask me what to record, then log it)"}`,
                'Infer a short title, the context and any consequences from this session; use status "accepted" unless I said otherwise. Then confirm the new decision id.',
            ].join("\n"),
        },
    ],
    [
        "journal",
        {
            description: "Log a bug, mistake or recurring failure in the error journal.",
            requires: ["error_log"],
            build: (args) => [
                "Log this in the error journal with the error_log tool.",
                `Problem: ${args || "(ask me what to log, then log it)"}`,
                "Include what was happening (context) and a few useful tags. If the fix is already known, record it with error_resolve.",
            ].join("\n"),
        },
    ],
    [
        "recall",
        {
            description: "Search past decisions, errors, snippets and indexed code.",
            requires: ["decision_search", "error_search", "snippet_search", "codebase_search"],
            build: (args) => [
                `Search the toolbox knowledge bases for: ${args || "(ask me what to look for)"}`,
                "Use decision_search, error_search and snippet_search, plus codebase_search for code.",
                "Summarise the most relevant hits with their ids, and say clearly if nothing matched.",
            ].join("\n"),
        },
    ],
    [
        "index",
        {
            description: "Index this project for full-text code search.",
            requires: ["codebase_index"],
            build: (args) => [
                `Index this project with codebase_index${args ? ` (path: ${args})` : ""}.`,
                "Then confirm the file and chunk counts with codebase_index_status.",
            ].join("\n"),
        },
    ],
    [
        "trace",
        {
            description: "Inspect the tool-call audit log (what the agent actually ran). Optionally pass a session ID to filter.",
            requires: ["trace_query"],
            build: (args) => {
                const trimmed = args.trim();
                // E65: if args looks like a session ID (no spaces, reasonable length), filter by it
                if (trimmed && !/\s/.test(trimmed) && trimmed.length >= 8) {
                    return [
                        `Inspect the tool-call audit log for session: ${trimmed}`,
                        `Use trace_query with sessionId="${trimmed}" to filter, and trace_stats for counts.`,
                        "Report the calls that matter with their status, duration and any errors.",
                    ].join("\n");
                }
                return [
                    `Inspect the tool-call audit log for: ${trimmed || "this session"}`,
                    "Use trace_query, and trace_stats for counts.",
                    "Report the calls that matter with their status, duration and any errors.",
                ].join("\n");
            },
        },
    ],
    [
        "toolbox",
        {
            description: "Show which open-toolbox tools are installed in this session.",
            requires: [],
            build: (args, available) => {
                // CP-1: work from the live tool list (dynamic — any live tool with a
                // known provider counts) and only fall back to the static inventory
                // when the live listing failed (empty set). Gating on TOOL_OWNERS
                // instead of the static TOOLBOX_TOOLS keeps tools like trace_sessions
                // visible even as the pack grows.
                const live = [...available];
                const source = live.length ? live : [...TOOLBOX_TOOLS];
                const installed = source.filter((t) => t in TOOL_OWNERS);
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
    ],
    [
        "plan",
        {
            description: "Plan a task end-to-end using the plan plugin (research, clarify, present, execute).",
            requires: [],
            build: (args) => [
                "Use the plan plugin to plan and execute the following task.",
                `Task: ${args || "(ask me what to plan)"}`,
                "Follow the plan plugin's workflow: research, clarify with the user, present a plan, then execute it.",
            ].join("\n"),
        },
    ],
    [
        "snippet",
        {
            description: "Search the snippet library for reusable code.",
            requires: ["snippet_search"],
            build: (args) => [
                `Search the snippet library for: ${args || "(ask me what to search for)"}`,
                "Use snippet_search to find matching snippets, then present the results with their titles, languages, and code previews.",
            ].join("\n"),
        },
    ],
    [
        "stats",
        {
            description: "Show usage statistics (tokens, cost, tool calls).",
            requires: ["stats_summary"],
            build: () => [
                "Show usage statistics.",
                "Call stats_summary and present the results to the user.",
            ].join("\n"),
        },
    ],
    [
        "health",
        {
            description: "Check the health of all installed plugins by querying their status tools.",
            requires: [],
            build: (_args, available) => {
                const statusTools = [
                    { plugin: "decision-log", tool: "decision_stats" },
                    { plugin: "decision-log", tool: "decision_config" },
                    { plugin: "error-journal", tool: "error_stats" },
                    { plugin: "error-journal", tool: "error_config" },
                    { plugin: "memory", tool: "memory_stats" },
                    { plugin: "codebase-index", tool: "codebase_index_status" },
                    { plugin: "context-pruner", tool: "context_pruner_stats" },
                    { plugin: "secret-shield", tool: "secret_shield_stats" },
                    { plugin: "tool-audit", tool: "trace_stats" },
                    { plugin: "usage-stats", tool: "stats_summary" },
                ];
                const installed = statusTools.filter((t) => available.has(t.tool));
                const missing = statusTools.filter((t) => !available.has(t.tool));
                if (installed.length === 0) {
                    return "No plugin status tools are available. The plugins may not be installed.";
                }
                const lines = [
                    "Check the health of the installed plugins by calling their status tools:",
                    ...installed.map((t) => `- Call ${t.tool} (from ${t.plugin}) and report the result`),
                    "",
                    "Report a summary of each plugin's status.",
                ];
                if (missing.length > 0) {
                    const missingPlugins = [...new Set(missing.map((t) => t.plugin))];
                    lines.push("", `Note: ${missingPlugins.length} plugin(s) not installed: ${missingPlugins.join(", ")}`);
                }
                return lines.join("\n");
            },
        },
    ],
    [
        "agent_list",
        {
            description: "List running subagent sessions with their status and runtime.",
            requires: ["list_sessions"],
            build: (args) => [
                "List all subagent sessions using the list_sessions tool.",
                args ? `Filter by status: ${args}` : "Show all sessions (running and completed).",
                "Present the results as a table with: session ID, description, status, and runtime.",
                "Highlight any sessions that appear stuck (running for a long time with no recent activity).",
            ].join("\n"),
        },
    ],
    [
        "agent_kill",
        {
            description: "Kill/cancel a specific subagent session by ID.",
            requires: ["session_cancel"],
            build: (args) => {
                const sessionId = args.trim();
                if (!sessionId) {
                    return [
                        "You need to specify a session ID to kill.",
                        "Usage: /agent_kill <sessionID>",
                        "Use /agent_list to find the session ID you want to kill.",
                    ].join("\n");
                }
                return [
                    `Cancel the subagent session with ID: ${sessionId}`,
                    "Use the session_cancel tool to kill this session.",
                    "IMPORTANT: Do NOT cancel the current/parent session. Only cancel the specified subagent session.",
                    "After cancelling, confirm the session has been terminated and report the result.",
                ].join("\n");
            },
        },
    ],
    [
        "agent_status",
        {
            description: "Check the status of all subagents (running, idle, stuck).",
            requires: ["list_sessions"],
            build: (args) => [
                "Check the status of all subagent sessions.",
                "Use list_sessions to get all sessions, then for each subagent session determine:",
                "- Session ID",
                "- Description",
                "- Status (running, idle, or stuck)",
                "- Runtime (how long it has been running)",
                "- Last activity time",
                "- Progress (if available from session_result)",
                args ? `Filter: ${args}` : "Show all subagent sessions.",
                "Present the results as a table. Highlight any sessions that appear stuck.",
            ].join("\n"),
        },
    ],
    [
        "agent_health",
        {
            description: "Get detailed health information about agents (memory, tool calls, errors).",
            requires: ["list_sessions", "session_result"],
            build: (args) => {
                const sessionId = args.trim();
                if (sessionId) {
                    return [
                        `Get detailed health information for agent session: ${sessionId}`,
                        "Use list_sessions to confirm the session exists, then use session_result to get detailed information.",
                        "Report:",
                        "- Memory usage",
                        "- Tool call count",
                        "- Error count",
                        "- Last tool call",
                        "- Current operation",
                        "- Any other relevant health metrics",
                    ].join("\n");
                }
                return [
                    "Get detailed health information for all agent sessions.",
                    "Use list_sessions to get all sessions, then for each subagent session use session_result to get detailed information.",
                    "Report for each agent:",
                    "- Session ID and description",
                    "- Memory usage",
                    "- Tool call count",
                    "- Error count",
                    "- Last tool call",
                    "- Current operation",
                    "Present the results as a table. Flag any agents with high error rates or unusual resource usage.",
                ].join("\n");
            },
        },
    ],
    [
        "agent_check",
        {
            description: "Check if a specific agent is stuck (no progress for X seconds).",
            requires: ["list_sessions"],
            build: (args) => {
                const parts = args.trim().split(/\s+/);
                const sessionId = parts[0];
                const maxIdleSec = parts[1] || "60";
                if (!sessionId) {
                    return [
                        "You need to specify a session ID to check.",
                        "Usage: /agent_check <sessionID> [maxIdleSec]",
                        "Use /agent_list to find the session ID you want to check.",
                    ].join("\n");
                }
                return [
                    `Check if agent session ${sessionId} is stuck.`,
                    `Use list_sessions to get the session and check if it has been idle for more than ${maxIdleSec} seconds.`,
                    "A session is considered stuck if:",
                    "- It has been running for a long time with no recent activity",
                    "- The last activity was more than the specified idle threshold ago",
                    "- It is not making progress on its task",
                    "Report:",
                    "- Whether the session is stuck",
                    "- How long it has been idle",
                    "- Recommendations (wait, kill, or investigate further)",
                ].join("\n");
            },
        },
    ],
    [
        "agent_kill_stuck",
        {
            description: "Kill all stuck subagent sessions (no progress for X seconds).",
            requires: ["list_sessions", "session_cancel"],
            build: (args) => {
                const maxIdleSec = args.trim() || "60";
                return [
                    `Find and kill all stuck subagent sessions.`,
                    `Use list_sessions to get all sessions, then identify subagent sessions that have had no progress for more than ${maxIdleSec} seconds.`,
                    "A session is considered stuck if it has been idle (no activity) for longer than the specified threshold.",
                    "For each stuck session found, use session_cancel to terminate it.",
                    "IMPORTANT: Do NOT cancel the current/parent session. Only cancel subagent sessions that are stuck.",
                    "Report which sessions were killed and how long they had been idle.",
                    "If no stuck sessions are found, report that all subagent sessions are healthy.",
                ].join("\n");
            },
        },
    ],
    [
        "agent_broadcast",
        {
            description: "Send a message to all subagent sessions.",
            requires: ["session_broadcast"],
            build: (args) => {
                const message = args.trim();
                if (!message) {
                    return [
                        "You need to specify a message to broadcast.",
                        "Usage: /agent_broadcast <message>",
                    ].join("\n");
                }
                return [
                    `Broadcast the following message to all subagent sessions:`,
                    "",
                    `---`,
                    message,
                    `---`,
                    "",
                    "Use the session_broadcast tool to send this message to all active subagent sessions.",
                    "After broadcasting, confirm how many sessions received the message.",
                ].join("\n");
            },
        },
    ],
    [
        "agent_monitor",
        {
            description: "Start background monitoring of agents (checks for stuck agents periodically).",
            requires: ["list_sessions", "session_cancel"],
            build: (args) => {
                const parts = args.trim().split(/\s+/);
                const intervalSec = parts[0] || "30";
                const maxIdleSec = parts[1] || "60";
                return [
                    `Start background monitoring of subagent sessions.`,
                    `Set up a monitoring loop that checks agent status every ${intervalSec} seconds.`,
                    "For each check:",
                    "1. Use list_sessions to get all subagent sessions",
                    "2. Identify sessions that have been idle for more than the threshold",
                    "3. Report any stuck agents found",
                    "4. Optionally kill stuck agents (ask me first before killing)",
                    `Idle threshold: ${maxIdleSec} seconds`,
                    `Check interval: ${intervalSec} seconds`,
                    "Use setInterval to run the checks in the background.",
                    "Report the monitoring status and any agents that need attention.",
                    "IMPORTANT: Do NOT kill the current/parent session. Only monitor subagent sessions.",
                ].join("\n");
            },
        },
    ],
];
export default Plugin.define({
    id: "command-pack",
    async setup(ctx) {
        // CP-3: cache the tool listing — every command delivery re-invokes
        // toolIds(), and listing on each call is wasteful. 60s TTL.
        let toolIdsCache = null;
        const toolIds = async () => {
            if (toolIdsCache && Date.now() - toolIdsCache.at < 60_000)
                return toolIdsCache.ids;
            try {
                const tools = await ctx.tool.list();
                const ids = new Set(Array.isArray(tools) ? tools.map((t) => t.id) : []);
                toolIdsCache = { at: Date.now(), ids };
                return ids;
            }
            catch (err) {
                console.error(`[command-pack] tool.list failed: ${String(err)}`);
                return toolIdsCache?.ids ?? new Set();
            }
        };
        const registration = await ctx.command.transform((editor) => {
            const allSpecs = [...COMMANDS, ...getRegisteredCommands()];
            for (const [name, spec] of allSpecs) {
                editor.add({
                    name,
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
                        }
                        catch (err) {
                            // CP-4: surface prompt failures visibly — a bare console.error
                            // leaves the user believing the command ran.
                            console.error(`[command-pack] /${name} failed to inject: ${String(err)}`);
                            throw err;
                        }
                    },
                });
            }
        });
        console.error(`[command-pack] registered ${[...COMMANDS, ...getRegisteredCommands()].length} commands: ${[...COMMANDS, ...getRegisteredCommands()].map(([n]) => "/" + n).join(", ")}`);
        const resolveAgentMonitorConfig = (options) => {
            const pick = (key, env) => options?.[key] ?? process.env[env];
            return {
                enabled: asBool(pick("enabled", "AGENT_MONITOR_ENABLED"), true),
                intervalSec: Math.max(1, asInt(pick("intervalSec", "AGENT_MONITOR_INTERVAL_SEC"), 30)),
                maxIdleSec: Math.max(1, asInt(pick("maxIdleSec", "AGENT_MONITOR_MAX_IDLE_SEC"), 60)),
                // Destructive by nature (it calls session.interrupt), so killing is
                // opt-in. Detection and stderr logging still run; the monitor just
                // never terminates a session unless the user explicitly asks it to.
                killStuck: asBool(pick("killStuck", "AGENT_MONITOR_KILL_STUCK"), false),
                // The monitor cannot reliably tell which session is "the parent" (it
                // only knows whichever session was prompted first), so injecting a
                // synthetic report into it is a side effect that must be opt-in.
                reportIssues: asBool(pick("reportIssues", "AGENT_MONITOR_REPORT_ISSUES"), false),
                stuckDetectionEnabled: asBool(pick("stuckDetectionEnabled", "AGENT_MONITOR_STUCK_DETECTION"), true),
                stuckFileThresholdSec: Math.max(10, asInt(pick("stuckFileThresholdSec", "AGENT_MONITOR_STUCK_FILE_THRESHOLD_SEC"), 60)),
                stuckToolThreshold: Math.max(2, asInt(pick("stuckToolThreshold", "AGENT_MONITOR_STUCK_TOOL_THRESHOLD"), 5)),
            };
        };
        const agentMonitorCfg = resolveAgentMonitorConfig(ctx.options);
        /** Track session activity: sessionID -> last activity timestamp. */
        const sessionActivity = new Map();
        /**
         * The parent (owner) session ID — never kill this one. CMD-2: prefer the
         * owner the host tells us about at setup. The event stream cannot tell an
         * owner from a subagent, so the old "first session that emitted
         * session.context" heuristic attached the never-touch guard to whichever
         * session spoke first — when a subagent emitted first, the real owner
         * became killable under killStuck=true. Without a ctx owner, every session
         * seen BEFORE the first observed spawn (a brand-new session appearing
         * while others are already active) is shielded as owner-side.
         */
        const ownerSessionFromCtx = typeof ctx.sessionID === "string" &&
            ctx.sessionID
            ? ctx.sessionID
            : undefined;
        let parentSessionID = ownerSessionFromCtx;
        const preSpawnProtected = new Set();
        let spawnObserved = false;
        /** Interval handle for the monitoring loop. */
        let monitorInterval;
        /** AbortController for the event stream. */
        const monitorAbort = new AbortController();
        // Maintenance intervals should never be what keeps the host process alive:
        // opencode owns the event loop, and a test that imports this plugin and
        // never calls cleanup must still exit. `unref` keeps them firing while the
        // host is up without pinning the loop open on their own.
        const unrefTimer = (t) => {
            if (t && typeof t.unref === "function") {
                t.unref();
            }
        };
        const sessionToolCalls = new Map();
        const sessionFileEdits = new Map();
        /**
         * Whether a session is mid-turn ("running") or waiting for the user
         * ("idle"). opencode exposes no session status, so this is derived from the
         * event stream: turn-end events mark a session idle, any other event marks
         * it running. Only a running session can be stuck — one that has ended its
         * turn and is waiting for the user is not stuck, however long it sits.
         */
        const sessionStatus = new Map();
        /**
         * Events that mean "this turn ended". After one of these the session is
         * idle — waiting for the user — and must not be treated as a stuck running
         * session. `session.deleted` is handled before this is consulted.
         */
        const TURN_END_EVENTS = new Set([
            "session.idle",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
        ]);
        /** Maximum tool calls to keep per session (sliding window). */
        const MAX_TOOL_CALLS_TRACKED = 50;
        /** Tools that modify files — used to extract file paths from tool args. */
        const FILE_EDIT_TOOLS = new Set(["edit", "write", "patch"]);
        /**
         * Extract a file path from tool arguments, if the tool operates on a file.
         */
        function extractFilePath(tool, args) {
            if (!FILE_EDIT_TOOLS.has(tool))
                return undefined;
            const p = args["path"] ?? args["file_path"] ?? args["filePath"];
            return typeof p === "string" ? p : undefined;
        }
        /**
         * Build a signature for a tool call: tool name + key argument.
         * Used to detect repeated identical tool calls.
         */
        function toolCallSignature(tool, args) {
            const filePath = extractFilePath(tool, args);
            if (filePath)
                return `${tool}:${filePath}`;
            try {
                return `${tool}:${JSON.stringify(args)}`;
            }
            catch {
                return tool;
            }
        }
        /**
         * Record a tool call for stuck detection.
         */
        function recordToolCall(sessionID, tool, args, now) {
            let calls = sessionToolCalls.get(sessionID);
            if (!calls) {
                calls = [];
                sessionToolCalls.set(sessionID, calls);
            }
            calls.push({ tool, keyArg: toolCallSignature(tool, args), at: now });
            if (calls.length > MAX_TOOL_CALLS_TRACKED) {
                calls.splice(0, calls.length - MAX_TOOL_CALLS_TRACKED);
            }
        }
        /**
         * Record a file edit for stagnation detection.
         */
        function recordFileEdit(sessionID, filePath, now) {
            let fileEdits = sessionFileEdits.get(sessionID);
            if (!fileEdits) {
                fileEdits = new Map();
                sessionFileEdits.set(sessionID, fileEdits);
            }
            const existing = fileEdits.get(filePath);
            if (existing) {
                existing.lastEditAt = now;
                existing.editCount++;
            }
            else {
                fileEdits.set(filePath, { path: filePath, mtimeMs: 0, lastEditAt: now, editCount: 1 });
            }
        }
        /**
         * Clean up tracking data for a session. CMD-2: a *deleted* session no
         * longer needs the pre-spawn shield, so the protection entry goes with
         * it (keeps the set bounded). The CMD-1 idle sweep deliberately does NOT
         * route protected sessions through here — their protection must outlive
         * the tracking data.
         */
        function cleanupSession(sessionID) {
            sessionActivity.delete(sessionID);
            sessionToolCalls.delete(sessionID);
            sessionFileEdits.delete(sessionID);
            sessionStatus.delete(sessionID);
            preSpawnProtected.delete(sessionID);
        }
        /**
         * CMD-1: sessionActivity/sessionStatus/sessionToolCalls/sessionFileEdits
         * grew unbounded — entries were only ever removed by `session.deleted`
         * or a kill, so every session the server ever mentioned pinned data for
         * the process lifetime. Sweep anything idle for over a day: a session
         * with no event in 24h is not something the monitor can usefully watch.
         * The owner session is never swept; pre-spawn protected sessions lose
         * their tracking bookkeeping but KEEP the protection entry.
         */
        const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
        function sweepIdleSessions(now) {
            for (const [sessionID, last] of sessionActivity) {
                if (sessionID === parentSessionID)
                    continue;
                if (now - last <= SESSION_IDLE_TTL_MS)
                    continue;
                if (preSpawnProtected.has(sessionID)) {
                    sessionActivity.delete(sessionID);
                    sessionStatus.delete(sessionID);
                    sessionToolCalls.delete(sessionID);
                    sessionFileEdits.delete(sessionID);
                }
                else {
                    cleanupSession(sessionID);
                }
            }
        }
        /**
         * Resolve a file path to absolute for stat-ing.
         */
        function resolveFilePath(filePath) {
            try {
                if (isAbsolute(filePath))
                    return filePath;
                return resolvePath(process.cwd(), filePath);
            }
            catch {
                return filePath;
            }
        }
        /**
         * Detect if a session is stuck.
         *
         * Only a *running* session can be stuck. A session that has ended its turn
         * and is waiting for the user is idle, not stuck, however long it has been
         * quiet — that is the common case and must never be interrupted.
         *
         * Signals, strongest first:
         * 1. Tool call patterns — same tool called repeatedly (actionable)
         * 2. File stagnation — file edited but not modified (actionable)
         * 3. Quiet while running — no events for maxIdleSec (advisory only)
         *
         * Returns the reason plus whether it is safe to act on, or undefined.
         */
        const detectStuckAgent = async (sessionID, now) => {
            // The guard that stops an idle/waiting session from ever being killed:
            // do not judge a session that is not mid-turn.
            if (sessionStatus.get(sessionID) !== "running")
                return undefined;
            if (agentMonitorCfg.stuckDetectionEnabled) {
                // Signal 1: Tool call patterns — same tool+keyArg called repeatedly
                const calls = sessionToolCalls.get(sessionID);
                if (calls && calls.length >= agentMonitorCfg.stuckToolThreshold) {
                    const recent = calls.slice(-agentMonitorCfg.stuckToolThreshold);
                    const firstSig = recent[0].keyArg;
                    const allSame = recent.every((c) => c.keyArg === firstSig);
                    if (allSame) {
                        return { reason: `repeated tool call: ${firstSig} x${recent.length}`, killable: true };
                    }
                }
                // Signal 2: File stagnation — file edited but mtime unchanged
                const fileEdits = sessionFileEdits.get(sessionID);
                if (fileEdits) {
                    const thresholdMs = agentMonitorCfg.stuckFileThresholdSec * 1000;
                    for (const [filePath, record] of fileEdits) {
                        // Only check files edited at least twice
                        if (record.editCount < 2)
                            continue;
                        // Only check files being actively edited (last edit within threshold)
                        const sinceLastEdit = now - record.lastEditAt;
                        if (sinceLastEdit > thresholdMs)
                            continue;
                        try {
                            const absPath = resolveFilePath(filePath);
                            const stat = await fsp.stat(absPath);
                            record.mtimeMs = stat.mtimeMs;
                            const sinceModification = now - stat.mtimeMs;
                            if (sinceModification > thresholdMs) {
                                return {
                                    reason: `file stagnation: ${filePath} unchanged for ${Math.round(sinceModification / 1000)}s`,
                                    killable: true,
                                };
                            }
                        }
                        catch {
                            // File doesn't exist or can't be stat'd — skip
                        }
                    }
                }
            }
            // Signal 3: quiet while running. Advisory only — long commands legitimately
            // go silent, so this is reported but is never a reason to kill.
            const lastActivity = sessionActivity.get(sessionID);
            if (lastActivity !== undefined) {
                const idleMs = now - lastActivity;
                if (idleMs > agentMonitorCfg.maxIdleSec * 1000) {
                    return {
                        reason: `no events for ${Math.round(idleMs / 1000)}s while running`,
                        killable: false,
                    };
                }
            }
            return undefined;
        };
        /**
         * Check all sessions for stuck agents and optionally kill them.
         * Returns a summary of what was found/done.
         */
        const checkAgents = async () => {
            const issues = [];
            const now = Date.now();
            for (const [sessionID] of sessionActivity) {
                // Never touch the session this plugin instance belongs to, and
                // (CMD-2) never touch a session that was already around when
                // monitoring began — until a spawn was observed we cannot tell it
                // apart from the owner, and killStuck must not gamble on it.
                if (sessionID === parentSessionID || preSpawnProtected.has(sessionID))
                    continue;
                const report = await detectStuckAgent(sessionID, now);
                if (!report)
                    continue;
                issues.push(`Session ${sessionID} stuck: ${report.reason}`);
                // Killing is opt-in, and only ever for an actionable stall. A quiet
                // running session is reported, never interrupted.
                if (agentMonitorCfg.killStuck && report.killable) {
                    try {
                        await ctx.session.interrupt({ sessionID });
                        issues.push(`  -> killed ${sessionID}`);
                        cleanupSession(sessionID);
                    }
                    catch (err) {
                        issues.push(`  -> failed to kill ${sessionID}: ${String(err)}`);
                    }
                }
            }
            return issues;
        };
        /**
         * Report issues to the parent session via synthetic message.
         */
        const reportIssues = async (issues) => {
            if (!agentMonitorCfg.reportIssues || !parentSessionID)
                return;
            if (issues.length === 0)
                return;
            const text = `[agent-monitor] Detected ${issues.length} issue(s):\n${issues.join("\n")}`;
            try {
                await ctx.session.synthetic({ sessionID: parentSessionID, text });
            }
            catch (err) {
                console.error(`[command-pack] agent-monitor report failed: ${String(err)}`);
            }
        };
        /**
         * Main monitoring loop — runs every intervalSec.
         */
        const runMonitorCheck = async () => {
            try {
                // CMD-1: drop stale per-session tracking before checking, so the
                // monitor's maps cannot grow with every session the server ever
                // mentions.
                sweepIdleSessions(Date.now());
                const issues = await checkAgents();
                if (issues.length > 0) {
                    console.error(`[command-pack] agent-monitor: ${issues.join(", ")}`);
                    await reportIssues(issues);
                }
            }
            catch (err) {
                console.error(`[command-pack] agent-monitor check failed: ${String(err)}`);
            }
        };
        // Start autonomous monitoring if enabled
        if (agentMonitorCfg.enabled) {
            // Subscribe to event stream to track session activity
            const eventPump = (async () => {
                try {
                    for await (const raw of ctx.event.subscribe({ signal: monitorAbort.signal })) {
                        const ev = raw;
                        try {
                            const type = typeof ev.type === "string" ? ev.type : "";
                            const data = (ev.data ?? {});
                            const sessionID = typeof data["sessionID"] === "string" ? data["sessionID"] : undefined;
                            if (!sessionID)
                                continue;
                            if (type === "session.deleted") {
                                cleanupSession(sessionID);
                                continue;
                            }
                            // CMD-2: sessions observed before the first spawn are assumed
                            // owner-side and shielded from kill actions. A "spawn" is any
                            // brand-new session appearing while other sessions are already
                            // active. (When setup ctx already names the owner, all of this
                            // is moot — parentSessionID is authoritative.)
                            if (!ownerSessionFromCtx && !spawnObserved) {
                                if (sessionActivity.size > 0 && !sessionActivity.has(sessionID)) {
                                    spawnObserved = true;
                                }
                                else {
                                    preSpawnProtected.add(sessionID);
                                }
                            }
                            // Any session event proves the session exists, so record when we
                            // last heard from it. Turn-end events mean it is now idle
                            // (waiting for the user); anything else means it is mid-turn.
                            sessionActivity.set(sessionID, Date.now());
                            sessionStatus.set(sessionID, TURN_END_EVENTS.has(type) ? "idle" : "running");
                            // Track tool calls for stuck detection
                            if (type === "session.execution.succeeded") {
                                const tool = typeof data["tool"] === "string"
                                    ? data["tool"]
                                    : typeof data["toolName"] === "string"
                                        ? data["toolName"]
                                        : undefined;
                                const args = (data["args"] ?? data["arguments"] ?? {});
                                if (tool) {
                                    recordToolCall(sessionID, tool, args, Date.now());
                                    const filePath = extractFilePath(tool, args);
                                    if (filePath) {
                                        recordFileEdit(sessionID, filePath, Date.now());
                                    }
                                }
                            }
                            // CMD-2 fallback: without a ctx-named owner, the first
                            // session.context is still the best guess at who reports should
                            // go to — but it is only a report target now: the pre-spawn
                            // shield above (and the ownerSessionFromCtx fast path) keep the
                            // never-touch guarantee honest.
                            if (type === "session.context" && !parentSessionID) {
                                parentSessionID = sessionID;
                            }
                        }
                        catch {
                            /* ignore individual event errors */
                        }
                    }
                }
                catch (err) {
                    if (!monitorAbort.signal.aborted) {
                        console.error(`[command-pack] agent-monitor event stream ended: ${String(err)}`);
                    }
                }
            })();
            // Run the first check immediately, then on interval
            runMonitorCheck().catch((err) => console.error(`[command-pack] agent-monitor initial check failed: ${String(err)}`));
            monitorInterval = setInterval(() => {
                runMonitorCheck().catch((err) => console.error(`[command-pack] agent-monitor check failed: ${String(err)}`));
            }, agentMonitorCfg.intervalSec * 1000);
            unrefTimer(monitorInterval);
            console.error(`[command-pack] agent-monitor started (interval=${agentMonitorCfg.intervalSec}s, maxIdle=${agentMonitorCfg.maxIdleSec}s, killStuck=${agentMonitorCfg.killStuck}, stuckDetection=${agentMonitorCfg.stuckDetectionEnabled}, stuckFileThreshold=${agentMonitorCfg.stuckFileThresholdSec}s, stuckToolThreshold=${agentMonitorCfg.stuckToolThreshold})`);
        }
        else {
            console.error(`[command-pack] agent-monitor disabled by config`);
        }
        return async () => {
            // Stop the monitoring interval
            if (monitorInterval !== undefined) {
                clearInterval(monitorInterval);
                monitorInterval = undefined;
            }
            // Abort the event stream
            monitorAbort.abort();
            // Clean up tracking data
            sessionActivity.clear();
            sessionToolCalls.clear();
            sessionFileEdits.clear();
            sessionStatus.clear();
            preSpawnProtected.clear();
            // Dispose command registration
            try {
                await registration.dispose();
            }
            catch {
                /* ignore */
            }
        };
    },
});
