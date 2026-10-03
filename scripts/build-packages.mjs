/**
 * Build publishable npm packages, one per plugin.
 *
 * The v2 loader allows exactly one plugin per npm package, resolves
 * `<pkg>/server` then `<pkg>`, and treats every export of the loaded entry as a
 * plugin factory. The repo sources import shared helpers from outside `plugins/`
 * (`../lib/sqlite.ts`, `./helpers.ts`), which do not resolve inside node_modules.
 *
 * This script transpiles each plugin (and its helpers) to plain ESM JavaScript
 * and writes a self-contained package under `packages/<dir>/`:
 *
 *   packages/<dir>/index.js      the plugin entry (default export only)
 *   packages/<dir>/helpers.js    or lib/sqlite.js, kept OUT of the entry so the
 *                                loader never sees a second "plugin"
 *   packages/<dir>/package.json  name/exports/files/deps
 *   packages/<dir>/README.md, LICENSE
 *
 *   node scripts/build-packages.mjs               # build
 *   node scripts/build-packages.mjs --pack-check   # build + `npm pack --dry-run`
 *
 * Nothing here publishes; publishing needs `npm login` first (see README).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outRoot = resolve(root, "packages");
const rootPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const VERSION = rootPkg.version;
const SCOPE = "@bandonker";

/** One entry per plugin. `rewrites` fixes relative imports for the package layout. */
const PACKAGES = [
  {
    dir: "opencode-sessions",
    name: `${SCOPE}/opencode-sessions`,
    source: "opencode-sessions/opencode-sessions.ts",
    helpers: [{ src: "opencode-sessions/helpers.ts", dest: "helpers.js" }],
    rewrites: { "./helpers.ts": "./helpers.js" },
    description:
      "Spawn, brief, await, read, follow up on, hand off to and cancel fresh child sessions without blocking the server event loop. Adds targeted project presence: a brief about only the sessions that bear on yours, and an enforced file lock so two agents take turns on one file.",
    keywords: ["sessions", "subagents", "handoff", "orchestration", "presence"],
    tools: [
      ["spawn_session", "Spawn a fresh child session and brief it."],
      ["session_result", "Read a child's status and result (optionally wait)."],
      ["session_send", "Send a follow-up to a child session, or to any session in this project."],
      ["session_cancel", "Abort a child session."],
      ["session_permission", "Answer a child's permission prompt."],
      ["session_handoff", "Hand the current working point to a new session."],
      ["list_sessions", "List sessions created by this plugin."],
      ["project_sessions", "List the other sessions in this project; declare your task; forget a closed one."],
      ["session_broadcast", "Send one message to every reachable session in this project."],
    ],
    config: [
      ["OPENCODE_SESSIONS_MAX_CONCURRENT", "3", "Max active child sessions"],
      ["OPENCODE_SESSIONS_MAX_PER_PARENT", "3", "Max active children per parent"],
      ["OPENCODE_SESSIONS_TIMEOUT_SEC", "900", "Default wait timeout (s)"],
      ["OPENCODE_SESSIONS_HARD_TIMEOUT_SEC", "1800", "Hard timeout cap (s)"],
      ["OPENCODE_SESSIONS_AUTO_APPROVE", "never", "never | once | always"],
      ["OPENCODE_SESSIONS_MAX_TRACKED", "200", "Tracked-session cap"],
      ["OPENCODE_SESSIONS_PEER_AWARENESS", "true", "Inject the targeted peer brief into each request"],
      ["OPENCODE_SESSIONS_PEER_STALE_SEC", "900", "Drop a peer unheard from for this long"],
      ["OPENCODE_SESSIONS_PEER_LIVE_SEC", "90", "Reachability window; older peers are verified via session.get"],
      ["OPENCODE_SESSIONS_MAX_PEERS", "4", "Cap peers named in the brief (the rest are counted)"],
      ["OPENCODE_SESSIONS_FILE_LOCKS", "advise", "advise | enforce | off — enforce makes a colliding write wait"],
      ["OPENCODE_SESSIONS_LOCK_WAIT_SEC", "60", "How long an enforced write waits for an in-progress write"],
      ["OPENCODE_SESSIONS_INFLIGHT_TTL_SEC", "3", "How long another process's in-flight marker is honoured"],
      ["OPENCODE_SESSIONS_CLAIM_STALE_SEC", "600", "A file claim older than this counts as released"],
    ],
  },
  {
    dir: "context-pruner",
    name: `${SCOPE}/opencode-context-pruner`,
    source: "plugins/context-pruner.ts",
    helpers: [],
    rewrites: {},
    description:
      "Context compiler for opencode v2: token-accurate pruning with a cache-stable epoch scheduler (session.hook context). Measures real tokens, plans changes once per epoch, dedupes and purges stale output, and never touches the transcript on disk.",
    keywords: ["context", "tokens", "compaction", "pruner", "context-compiler"],
    tools: [
      ["context_pruner_stats", "Show what context-pruner trimmed and the active config."],
      ["context_report", "Token budget, epoch, cache hit ratio, summariser stats and active prune decisions."],
      ["context_map", "List compressible tool output with stable #N references before calling compress."],
      ["context_pruner_recall", "Get back the full output of a tool result that was replaced with a prune stub."],
      ["compress", "Replace a chosen range of tool output with a model-generated summary."],
    ],
    config: [
      ["OPENCODE_CONTEXT_PRUNER_ENABLED", "true", "Turn pruning off without uninstalling"],
      ["OPENCODE_CONTEXT_PRUNER_KEEP_RECENT", "6", "Most-recent tool results to leave untouched"],
      ["OPENCODE_CONTEXT_PRUNER_MIN_CHARS", "2000", "Only prune results longer than this"],
      ["OPENCODE_CONTEXT_PRUNER_KEEP_HEAD", "200", "Chars of the result kept as a preview"],
      ["OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS", "true", "Never prune error results"],
      ["OPENCODE_CONTEXT_PRUNER_IGNORE", "context_pruner_stats", "Comma-separated tools to never prune"],
      ["OPENCODE_CONTEXT_PRUNER_LOG", "false", "Log each prune to stderr"],
      ["OPENCODE_CONTEXT_PRUNER_BUDGET_RATIO", "0.9", "Fraction of the model window treated as input budget"],
      ["OPENCODE_CONTEXT_PRUNER_TARGET_RATIO", "0.85", "Fraction of the budget to prune down to"],
      ["OPENCODE_CONTEXT_PRUNER_MAX_OUTPUT_RESERVE", "8192", "Tokens reserved for the model's output"],
      ["OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TURNS", "2", "Recent turns left untouched"],
      ["OPENCODE_CONTEXT_PRUNER_MIN_REPLAN_TOKENS", "2000", "New tokens saved needed to justify a replan"],
      ["OPENCODE_CONTEXT_PRUNER_DEDUPE", "true", "Stub duplicate tool output"],
      ["OPENCODE_CONTEXT_PRUNER_PURGE_ERRORS", "true", "Stub stale errors when keepErrors is off"],
      ["OPENCODE_CONTEXT_PRUNER_CHARS_PER_TOKEN", "3.6", "Seed estimator before calibration"],
      ["OPENCODE_CONTEXT_PRUNER_PROTECTED_TOOLS", "task,skill,compress,context_report", "Tools never pruned"],
      ["OPENCODE_CONTEXT_PRUNER_PROTECTED_PATTERNS", "(none)", "Regexes of tools never pruned"],
      ["OPENCODE_CONTEXT_PRUNER_NOTIFY", "true", "Receipt verbosity: off | minimal | detailed"],
      ["OPENCODE_CONTEXT_PRUNER_NOTIFY_TYPE", "toast", "chat posts the receipt inline, toast logs to stderr"],
      ["OPENCODE_CONTEXT_PRUNER_NOTIFY_MIN_TOKENS", "500", "Turn savings needed to trigger a receipt"],
      ["OPENCODE_CONTEXT_PRUNER_NOTIFY_ON_TOPIC", "true", "Receipt on applied summaries even below the floor"],
      ["OPENCODE_CONTEXT_PRUNER_COLLAPSE", "true", "Collapse fully-pruned message spans"],
      ["OPENCODE_CONTEXT_PRUNER_COLLAPSE_STUBS", "true", "Also collapse spans that are only stubbed"],
      ["OPENCODE_CONTEXT_PRUNER_COMPACTION", "true", "Replace native compaction with a deterministic checkpoint"],
      ["OPENCODE_CONTEXT_PRUNER_RETRY", "true", "Recover from context-limit errors by trimming harder and retrying"],
      ["OPENCODE_CONTEXT_PRUNER_TITLE", "false", "Short-circuit model title generation"],
      ["OPENCODE_CONTEXT_PRUNER_RECALL", "true", "Keep pruned output locally so it can be recalled instead of re-run"],
      ["OPENCODE_CONTEXT_PRUNER_RECALL_KEEP", "50", "Most pruned outputs kept per session"],
      ["OPENCODE_CONTEXT_PRUNER_RECALL_MAX_CHARS", "200000", "Max characters returned by a single recall"],
      ["OPENCODE_CONTEXT_PRUNER_STORAGE_GC", "true", "Bound the non-session KV caches (digest + calibration)"],
      ["OPENCODE_CONTEXT_PRUNER_SUMMARY_CACHE_MAX", "500", "Max persisted digest-cache entries (0 = unlimited)"],
      ["OPENCODE_CONTEXT_PRUNER_CALIBRATION_MAX", "256", "Max persisted calibration entries (0 = unlimited)"],
      ["OPENCODE_CONTEXT_PRUNER_CACHE_AWARE", "true", "Defer voluntary replans until the cache rewrite premium amortises"],
      ["OPENCODE_CONTEXT_PRUNER_CACHE_AMORTIZE", "4", "Requests over which a cache rewrite must pay back"],
      ["OPENCODE_CONTEXT_PRUNER_SUPERSEDED", "true", "Prune output superseded by a newer read/write of the same file"],
      ["OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS", "true", "Summarise automatically when the token target is exceeded"],
      ["OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MAX", "3", "Max automatic summariser calls per session"],
      ["OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MIN", "4000", "Minimum tokens a range must hold to be auto-summarised"],
      ["OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES", "12", "Max stale units covered per proactive summary"],
      ["OPENCODE_CONTEXT_PRUNER_COMPRESS", "true", "Enable the model-callable compress tool"],
      ["OPENCODE_CONTEXT_PRUNER_COMPRESS_MAX_CHARS", "24000", "Max characters sent to the summariser per compress call"],
      ["OPENCODE_CONTEXT_PRUNER_PROTECT_TAGS", "true", "Preserve <protect>...</protect> blocks during summarisation"],
      ["OPENCODE_CONTEXT_PRUNER_PROTECT_USER", "false", "Never summarise user messages"],
      ["OPENCODE_CONTEXT_PRUNER_SUMMARY_BUFFER", "true", "Let summary tokens extend the effective budget"],
      ["OPENCODE_CONTEXT_PRUNER_MIN_CONTEXT_LIMIT", "(none)", "Token count or percent at which nudges start"],
      ["OPENCODE_CONTEXT_PRUNER_MAX_CONTEXT_LIMIT", "(none)", "Token count or percent treated as the hard window"],
      ["OPENCODE_CONTEXT_PRUNER_NUDGE", "true", "Tell the model to compress when context grows"],
      ["OPENCODE_CONTEXT_PRUNER_NUDGE_FREQUENCY", "5", "Requests between nudges"],
      ["OPENCODE_CONTEXT_PRUNER_NUDGE_FORCE", "soft", "soft or strong nudge wording"],
      ["OPENCODE_CONTEXT_PRUNER_ITERATION_NUDGE", "15", "Tool results after which a nudge is sent"],
      ["OPENCODE_CONTEXT_PRUNER_PROTECTED_FILES", "(none)", "Globs of file paths whose tool output is never pruned"],
      ["OPENCODE_CONTEXT_PRUNER_CONFIG", "(none)", "Explicit path to a context-pruner.jsonc config file"],
      ["OPENCODE_CONTEXT_PRUNER_DEBUG", "false", "Write a debug log under ~/.config/opencode/logs/context-pruner"],
    ],
  },
  {
    dir: "session-export",
    name: `${SCOPE}/opencode-session-export`,
    source: "plugins/session-export.ts",
    helpers: [{ src: "lib/redact.ts", dest: "lib/redact.js" }],
    rewrites: { "../lib/redact.ts": "./lib/redact.js" },
    description:
      "Export a session transcript to markdown, json, jsonl or text with reasoning/tool filtering, secret redaction, home-path rewriting and non-overwriting filenames.",
    keywords: ["session", "export", "transcript", "redaction"],
    tools: [
      ["session_export", "Export the current session transcript to a file or inline."],
      ["session_export_info", "Show config, default export dir and the last export."],
    ],
    config: [
      ["OPENCODE_SESSION_EXPORT_ENABLED", "true", "Turn exporting off without uninstalling"],
      ["OPENCODE_SESSION_EXPORT_DIR", "<cwd>/.opencode-exports", "Default output directory"],
      ["OPENCODE_SESSION_EXPORT_FORMAT", "markdown", "markdown | json | jsonl | text"],
      ["OPENCODE_SESSION_EXPORT_INCLUDE_REASONING", "false", "Include assistant reasoning parts"],
      ["OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_RESULTS", "true", "Include tool results and errors"],
      ["OPENCODE_SESSION_EXPORT_MAX_PART_CHARS", "4000", "Truncate each part to this many chars"],
      ["OPENCODE_SESSION_EXPORT_REDACT", "true", "Scrub secrets and rewrite home paths to ~"],
    ],
  },
  {
    dir: "memory",
    name: `${SCOPE}/opencode-memory`,
    source: "plugins/memory.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/redact.ts", dest: "lib/redact.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/redact.ts": "./lib/redact.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Local-first long-term memory: store and BM25-recall fragments with SQLite FTS5. No embedding API, no cloud. Auto-injects relevant memories into each request within a hard character budget.",
    keywords: ["memory", "recall", "sqlite", "fts5", "local-first"],
    tools: [
      ["memory_remember", "Store a memory (deduped by normalized content)."],
      ["memory_recall", "BM25 full-text search over memories."],
      ["memory_forget", "Delete a memory by id or query."],
      ["memory_list", "List recent memories."],
      ["memory_stats", "Totals by scope, DB path and config."],
    ],
    config: [
      ["OPENCODE_MEMORY_ENABLED", "true", "Turn the plugin off without uninstalling"],
      ["OPENCODE_MEMORY_AUTO_RECALL", "true", "Inject relevant memories into each request"],
      ["OPENCODE_MEMORY_BUDGET_CHARS", "1200", "Hard character budget per injection"],
      ["OPENCODE_MEMORY_TOP_K", "5", "Max memories per recall/injection"],
      ["OPENCODE_MEMORY_MIN_SCORE", "0", "Minimum BM25 score (0 = any hit)"],
      ["OPENCODE_MEMORY_SCOPE", "project", "global | project | session"],
      ["OPENCODE_MEMORY_MAX_ENTRIES", "0", "Prune beyond this many rows (0 = unlimited)"],
      ["OPENCODE_MEMORY_LOG", "false", "Log activity to stderr"],
    ],
  },
  {
    dir: "secret-shield",
    name: `${SCOPE}/opencode-secret-shield`,
    source: "plugins/secret-shield.ts",
    helpers: [{ src: "lib/redact.ts", dest: "lib/redact.js" }],
    rewrites: { "../lib/redact.ts": "./lib/redact.js" },
    description:
      "v2-native secret detector/redactor: scrubs the outbound HTTP body (title/compaction/generate), prompt, tool args/results and child-process env; observe/redact/block modes with entropy detection, allowlist precedence and a hashed JSONL audit.",
    keywords: ["secrets", "redaction", "security", "guardrails"],
    tools: [
      ["secret_shield_scan", "Scan a string for secrets (ids/offsets, no values)."],
      ["secret_shield_stats", "Mode, rule count, audit path and finding totals."],
      ["secret_shield_shape", "Safe shape of a secret file (names/lengths/fingerprint)."],
      ["secret_shield_keys", "List key names in a secret file."],
    ],
    config: [
      ["OPENCODE_SECRET_SHIELD_ENABLED", "true", "Turn the shield off without uninstalling"],
      ["OPENCODE_SECRET_SHIELD_MODE", "observe", "observe | redact | block"],
      ["OPENCODE_SECRET_SHIELD_ENTROPY", "true", "Shannon-entropy fallback for unlabelled tokens"],
      ["OPENCODE_SECRET_SHIELD_ALLOW", "(none)", "Comma-separated literals, /regex/, globs or rule ids"],
      ["OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS", "true", "Block-mode deny of protected secret files"],
      ["OPENCODE_SECRET_SHIELD_LOG", "false", "Emit diagnostics to stderr"],
    ],
  },
  {
    dir: "finish-guard",
    name: `${SCOPE}/opencode-finish-guard`,
    source: "plugins/finish-guard.ts",
    helpers: [],
    rewrites: {},
    description:
      "Normalises OpenAI-compatible SSE streams so a content or reasoning delta that arrives after the finish reason cannot kill a session (\"OpenAI Chat received content after the finish reason\").",
    keywords: ["stream", "sse", "provider", "openai", "compatibility"],
    tools: [],
    config: [
      ["OPENCODE_FINISH_GUARD_ENABLED", "true", "Turn stream normalisation off without uninstalling"],
      ["OPENCODE_FINISH_GUARD_LOG", "false", "Log each normalised stream to stderr"],
      ["OPENCODE_FINISH_GUARD_RETRY", "true", "Retry a turn whose provider stream was malformed"],
      ["OPENCODE_FINISH_GUARD_RETRY_MAX", "3", "Maximum retry attempts before the turn is allowed to fail"],
    ],
  },
  {
    dir: "loop-guard",
    name: `${SCOPE}/opencode-loop-guard`,
    source: "plugins/loop-guard.ts",
    helpers: [{ src: "lib/config.ts", dest: "lib/config.js" }],
    rewrites: { "../lib/config.ts": "./lib/config.js" },
    description:
      "Always-on doom-loop breaker: when a session repeats the same tool call or the same assistant reply consecutively, the model is nudged to change approach and, if it keeps repeating, the turn is cancelled.",
    keywords: ["loop", "repetition", "stall", "guard", "reliability"],
    tools: [],
    config: [
      ["OPENCODE_LOOP_GUARD_ENABLED", "true", "Turn the guard off without uninstalling"],
      ["OPENCODE_LOOP_GUARD_REPEAT_LIMIT", "4", "Consecutive identical calls/replies before nudging the model"],
      ["OPENCODE_LOOP_GUARD_CANCEL_LIMIT", "8", "Consecutive identical calls/replies before cancelling the turn"],
      ["OPENCODE_LOOP_GUARD_NOTIFY", "true", "Post a note into the session when the guard acts"],
      ["OPENCODE_LOOP_GUARD_LOG", "false", "Log guard activity to stderr"],
    ],
  },
  {
    dir: "deep-research",
    name: `${SCOPE}/opencode-deep-research`,
    source: "plugins/deep-research.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
      { src: "lib/command-registry.ts", dest: "lib/command-registry.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/config.ts": "./lib/config.js",
      "../lib/command-registry.ts": "./lib/command-registry.js",
    },
    description:
      "Autonomous multi-agent research. Fans a topic out across a taxonomy of research angles as parallel child sessions, iterates on the gaps those agents report, then hands the deduplicated, conflict-flagged findings back for a written report.",
    keywords: ["research", "deep-research", "agents", "analysis", "report", "parallel"],
    tools: ["deep_research", "deep_research_runs"],
    config: [
      ["OPENCODE_DEEP_RESEARCH_ENABLED", "true", "Turn deep research off without uninstalling"],
      ["OPENCODE_DEEP_RESEARCH_DIR", "~/.opencode-plugins/deep-research", "Where the SQLite history and markdown reports are written"],
      ["OPENCODE_DEEP_RESEARCH_CONCURRENCY", "4", "Maximum research agents running at once"],
    ],
  },
  {
    dir: "usage-stats",
    name: `${SCOPE}/opencode-usage-stats`,
    source: "plugins/usage-stats.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Lifetime token / dollar / tool accounting in local SQLite with a self-contained HTML dashboard and Unicode heatmaps.",
    keywords: ["usage", "tokens", "cost", "stats", "dashboard", "sqlite"],
    tools: [
      ["stats_summary", "Lifetime and today tokens/cost/tools."],
      ["stats_tools", "Per-tool calls, outcomes and durations."],
      ["stats_tokens", "Per-day and per-model token/cost breakdown."],
      ["stats_heatmap", "Unicode contribution heatmap."],
      ["stats_dashboard", "Write the HTML dashboard and return its path."],
    ],
    commands: ["/stats"],
    config: [
      ["OPENCODE_USAGE_STATS_DIR", "~/.opencode-plugins/usage-stats", "Where the DB and dashboard live"],
      ["OPENCODE_USAGE_STATS_ENABLED", "true", "Turn recording off"],
      ["OPENCODE_USAGE_STATS_RETENTION_DAYS", "0", "Prune daily rollups older than this (0 = keep)"],
      ["OPENCODE_USAGE_STATS_HEATMAP_METRIC", "tokens", "Heatmap metric: tokens|cost|calls"],
      ["OPENCODE_USAGE_STATS_HEATMAP_WEEKS", "26", "Heatmap width in weeks"],
      ["OPENCODE_USAGE_STATS_INCLUDE_BACKGROUND", "true", "Include title/compaction spend in charts"],
      ["OPENCODE_USAGE_STATS_LOG", "false", "Log plugin activity to stderr"],
    ],
  },
  {
    dir: "decision-log",
    name: `${SCOPE}/opencode-decision-log`,
    source: "plugins/decision-log.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/redact.ts", dest: "lib/redact.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/redact.ts": "./lib/redact.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Record and search architectural decisions in a local SQLite FTS5 database.",
    keywords: ["decisions", "adr", "memory", "sqlite", "fts5"],
    tools: [
      ["decision_log", "Record a decision."],
      ["decision_get", "Get a decision by id."],
      ["decision_search", "Full-text search decisions."],
      ["decision_list", "List decisions with filters."],
      ["decision_update", "Update or supersede a decision."],
    ],
    config: [],
  },
  {
    dir: "error-journal",
    name: `${SCOPE}/opencode-error-journal`,
    source: "plugins/error-journal.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/redact.ts", dest: "lib/redact.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/redact.ts": "./lib/redact.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Log errors with context, search past ones, and record resolutions so you stop re-debugging the same failure.",
    keywords: ["errors", "journal", "debugging", "sqlite", "fts5"],
    tools: [
      ["error_log", "Log an error."],
      ["error_resolve", "Record a resolution."],
      ["error_search", "Full-text search errors."],
      ["error_list", "List recent errors."],
      ["error_delete", "Delete an error entry."],
    ],
    config: [],
  },
  {
    dir: "snippet-library",
    name: `${SCOPE}/opencode-snippet-library`,
    source: "plugins/snippet-library.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/redact.ts", dest: "lib/redact.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/redact.ts": "./lib/redact.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Save reusable code snippets and search them by language, tag or full text.",
    keywords: ["snippets", "library", "sqlite", "fts5"],
    tools: [
      ["snippet_save", "Save a snippet."],
      ["snippet_search", "Full-text search snippets."],
      ["snippet_list", "List snippets."],
      ["snippet_get", "Get a snippet with full code."],
      ["snippet_delete", "Delete a snippet."],
    ],
    config: [],
  },
  {
    dir: "codebase-index",
    name: `${SCOPE}/opencode-codebase-index`,
    source: "plugins/codebase-index.ts",
    helpers: [{ src: "lib/sqlite.ts", dest: "lib/sqlite.js" }],
    rewrites: { "../lib/sqlite.ts": "./lib/sqlite.js" },
    description:
      "Index a codebase and run BM25-ranked full-text search over it with SQLite FTS5.",
    keywords: ["codebase", "search", "index", "sqlite", "fts5"],
    tools: [
      ["codebase_index", "Index a directory."],
      ["codebase_search", "Search indexed code."],
      ["codebase_index_status", "Show index statistics."],
      ["codebase_delete_index", "Delete a project's index."],
    ],
    config: [],
  },
  {
    dir: "tool-audit",
    name: `${SCOPE}/opencode-tool-audit`,
    source: "plugins/tool-audit.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Flight recorder for every tool call: tool, args, status, duration and error land in a local SQLite DB, with secrets redacted before they touch disk.",
    keywords: ["audit", "trace", "observability", "sqlite"],
    tools: [
      ["trace_query", "Query recorded tool calls."],
      ["trace_stats", "Summarise recorded calls."],
      ["trace_export", "Export calls as JSONL or Markdown."],
    ],
    config: [
      ["OPENCODE_TOOL_AUDIT_DIR", "~/.opencode-plugins/tool-audit", "Where the DB lives"],
      ["OPENCODE_TOOL_AUDIT_ENABLED", "true", "Turn recording off"],
      ["OPENCODE_TOOL_AUDIT_REDACT", "true", "Scrub secrets from arguments"],
      ["OPENCODE_TOOL_AUDIT_MAX_INPUT_CHARS", "2000", "Per-call argument cap"],
      ["OPENCODE_TOOL_AUDIT_RETENTION_DAYS", "30", "Prune rows older than this (0 = keep)"],
      ["OPENCODE_TOOL_AUDIT_IGNORE", "todowrite", "Comma-separated tools to skip"],
    ],
  },
  {
    dir: "command-pack",
    name: `${SCOPE}/opencode-command-pack`,
    source: "plugins/command-pack.ts",
    helpers: [
      { src: "lib/command-registry.ts", dest: "lib/command-registry.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/command-registry.ts": "./lib/command-registry.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Registers slash commands that put the rest of the pack one keystroke away.",
    keywords: ["commands", "slash", "ux"],
    tools: [],
    commands: ["/handoff", "/decide", "/journal", "/recall", "/index", "/trace", "/toolbox"],
    config: [],
  },
  {
    dir: "strip-skills-catalog",
    name: `${SCOPE}/opencode-strip-skills-catalog`,
    source: "plugins/strip-skills-catalog.ts",
    helpers: [{ src: "opencode-sessions/helpers.ts", dest: "lib/helpers.js" }],
    rewrites: { "../opencode-sessions/helpers.ts": "./lib/helpers.js" },
    description:
      "Strips the <available_skills> catalog from the system prompt to save tokens; the skill tool still works on demand.",
    keywords: ["context", "tokens", "skills", "prompt"],
    tools: [],
    config: [
      ["OPENCODE_STRIP_SKILLS_LOG", "(unset)", "Log stripped byte counts to stderr"],
    ],
  },
  {
    dir: "goal",
    name: `${SCOPE}/opencode-goal`,
    source: "plugins/goal.ts",
    helpers: [{ src: "lib/config.ts", dest: "lib/config.js" }],
    rewrites: { "../lib/config.ts": "./lib/config.js" },
    description:
      "Set an objective for a session and keep working until it is reached: the goal is re-injected into every request, the model auto-continues when a turn ends, and the loop stops only on goal_complete/goal_blocked, a user interrupt, a stall, or the iteration/time budget.",
    keywords: ["goal", "agent", "autonomous", "loop", "automation"],
    tools: [
      ["goal_complete", "Declare the goal done, with evidence."],
      ["goal_blocked", "Declare the goal cannot proceed without the user."],
      ["goal_progress", "Record a milestone while working toward the goal."],
    ],
    config: [
      ["OPENCODE_GOAL_ENABLED", "true", "Turn the goal loop off without uninstalling"],
      ["OPENCODE_GOAL_MAX_ITERATIONS", "30", "Max continuation turns per goal"],
      ["OPENCODE_GOAL_MAX_MINUTES", "180", "Wall-clock budget per goal (minutes)"],
      ["OPENCODE_GOAL_STALL_LIMIT", "3", "No-tool, unchanged turns before stopping as stalled"],
      ["OPENCODE_GOAL_MAX_FAILURES", "3", "Consecutive execution errors before stopping"],
      ["OPENCODE_GOAL_REQUIRE_EVIDENCE", "true", "Require evidence in goal_complete"],
      ["OPENCODE_GOAL_MAX_INJECT_CHARS", "1600", "Character cap on the injected goal reminder"],
      ["OPENCODE_GOAL_NOTIFY", "true", "Post loop start/stop notes into the session"],
      ["OPENCODE_GOAL_LOG", "false", "Log loop activity to stderr"],
    ],
  },
  {
    dir: "plan",
    name: `${SCOPE}/opencode-plan`,
    source: "plugins/plan.ts",
    helpers: [],
    rewrites: {},
    description:
      "Register a /plan command that guides the agent through a thorough planning phase: research the task, ask clarifying questions, present a detailed plan, then execute it by spawning child sessions (free models first, paid as fallback).",
    keywords: ["plan", "planning", "research", "orchestration"],
    tools: [],
    commands: ["/plan"],
    config: [],
  },
  {
    dir: "code-review",
    name: `${SCOPE}/opencode-code-review`,
    source: "plugins/code-review.ts",
    helpers: [
      { src: "lib/sqlite.ts", dest: "lib/sqlite.js" },
      { src: "lib/redact.ts", dest: "lib/redact.js" },
      { src: "lib/format.ts", dest: "lib/format.js" },
      { src: "lib/config.ts", dest: "lib/config.js" },
    ],
    rewrites: {
      "../lib/sqlite.ts": "./lib/sqlite.js",
      "../lib/redact.ts": "./lib/redact.js",
      "../lib/format.ts": "./lib/format.js",
      "../lib/config.ts": "./lib/config.js",
    },
    description:
      "Review source files and diffs for security vulnerabilities, code smells, and type safety issues. Stores review history in a local SQLite FTS5 database with full-text search.",
    keywords: ["code-review", "review", "security", "static-analysis", "sqlite"],
    tools: [
      ["code_review_file", "Review a source file for issues."],
      ["code_review_diff", "Review a diff for issues."],
      ["code_review_history", "List past reviews with filters."],
      ["code_review_get", "Get a review by id."],
      ["code_review_search", "Full-text search reviews."],
      ["code_review_stats", "Aggregate review statistics."],
    ],
    commands: [
      "/code-review file <path> | diff | project [path]",
      "/code-review fix-all [reviewId]",
      "/code-review deep [path]",
      "/deep-code-review [path]",
    ],
    config: [
      ["OPENCODE_CODE_REVIEW_AGENT_FIXES", "true", "Spawn fixer subagents after a review."],
      ["OPENCODE_CODE_REVIEW_LLM_FALLBACK", "true", "Run a free-LLM pass when the static scan is sparse."],
      ["OPENCODE_CODE_REVIEW_LLM_FALLBACK_THRESHOLD", "5", "Findings below this trigger the LLM fallback."],
      ["OPENCODE_CODE_REVIEW_FIX_MODEL", '""', "Pin the fixer model as providerID/modelID."],
      ["OPENCODE_CODE_REVIEW_REVIEW_MODEL", '""', "Pin the reviewer model as providerID/modelID."],
      ["OPENCODE_CODE_REVIEW_MAX_FIX_AGENTS", "6", "Fixer children allowed to run at once."],
      ["OPENCODE_CODE_REVIEW_SPAWN_MODE", "agent", 'agent | direct (plugin spawns the children itself).'],
      ["OPENCODE_CODE_REVIEW_DIRECT_REVIEW_TIMEOUT_SEC", "300", "Seconds direct mode waits for its reviewer."],
      ["OPENCODE_CODE_REVIEW_DEEP", "true", "Expose /deep-code-review and /code-review deep."],
    ],
  },
];

/**
 * Transpiled output keyed by source path, shared across packages.
 *
 * `lib/sqlite.ts` alone is bundled into ~8 packages, `lib/config.ts` into ~7
 * and `lib/redact.ts` into ~6, so a naive re-read + re-transpile per consumer
 * paid for the same file seven or eight times per build. ts.transpileModule
 * is a pure function of (source text, compilerOptions, fileName), and
 * fileName is just relPath here, so the result is memoizable on relPath alone.
 *
 * Only the *pre-rewrite* output is cached. rewriteImports() runs per package
 * on the way out, because the same helper legitimately maps to different dest
 * specifiers in different packages. Caching post-rewrite text would need a
 * (src, rewrites) composite key and would be wrong for the current callers.
 *
 * Safe for one process run: the build only ever writes under .packages-tmp/,
 * never back into the source tree, so a cached entry cannot go stale mid-build.
 */
const transpileCache = new Map();

function transpile(relPath) {
  const cached = transpileCache.get(relPath);
  if (cached !== undefined) return cached;
  const abs = resolve(root, relPath);
  if (!existsSync(abs)) throw new Error(`source not found: ${relPath}`);
  const source = readFileSync(abs, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      verbatimModuleSyntax: false,
      removeComments: false,
    },
    fileName: relPath,
  }).outputText;
  transpileCache.set(relPath, output);
  return output;
}

/**
 * Fail loudly if a relative `.ts` import survived into a published file.
 *
 * The extension match is case-insensitive on purpose. rewriteImports() below
 * replaces exact lowercase specifiers, so a source importing "./Helpers.TS"
 * or "./helpers.TS" is never rewritten. On a case-insensitive filesystem
 * (Windows, default macOS) that mistake still resolves and the broken import
 * ships to npm, where it fails only at runtime on a Linux install. Matching
 * case-insensitively turns that into a build-time error on every platform.
 *
 * LIB-3: the scan covers every module-specifier position in the emitted
 * output, not just static `from` clauses. `await import("./memory.ts")`
 * escaped the old regex entirely — the published bundle carried verbatim .ts
 * specifiers that threw ERR_MODULE_NOT_FOUND inside swallowing try/catch, so
 * cross-plugin integrations silently never fired. `import(...)` and
 * `require(...)` specifiers now fail the build the same way. Plain ".ts"
 * strings in data (e.g. file-extension lists) are intentionally not matched;
 * only specifier positions are.
 */
const TS_IMPORT_RE =
  /\bfrom\s+["']([^"']+\.ts)["']|\b(?:import|require)\s*\(\s*["']([^"']+\.ts)["']/i;

export function assertNoTsImports(code, label) {
  const m = code.match(TS_IMPORT_RE);
  if (m) {
    throw new Error(
      `unrewritten .ts import remains in ${label}: ${m[1] ?? m[2]} ` +
        `(import specifiers are case-sensitive; use the exact lowercase path)`,
    );
  }
}

function rewriteImports(code, rewrites) {
  let out = code;
  for (const [from, to] of Object.entries(rewrites)) {
    // replaceAll (literal string pattern) is exactly the old
    // split(from).join(to) semantics -- both scan the original once, so
    // neither cascades when `to` itself contains `from`.
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
  }
  return out;
}

function buildReadme(pkg) {
  const lines = [
    `# ${pkg.name}`,
    "",
    pkg.description,
    "",
    "Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of",
    "local plugins for opencode Desktop v2. One plugin per package.",
    "",
    "## Install",
    "",
    "```jsonc",
    "// opencode.jsonc",
    "{",
    '  "plugins": ["' + pkg.name + '"]',
    "}",
    "```",
    "",
    "Then restart opencode.",
    "",
  ];
  if (pkg.tools?.length) {
    lines.push("## Tools", "", "| Tool | Does |", "| :-- | :-- |");
    for (const [name, desc] of pkg.tools) lines.push(`| \`${name}\` | ${desc} |`);
    lines.push("");
  }
  if (pkg.commands?.length) {
    lines.push("## Commands", "", pkg.commands.map((c) => `\`${c}\``).join(", "), "");
  }
  if (pkg.config?.length) {
    lines.push(
      "## Configuration",
      "",
      "Options are read from the plugin `options` object (npm installs) or the env",
      "var (always works). Values are read at load time.",
      "",
      "| Env var | Default | Meaning |",
      "| :-- | :-- | :-- |",
    );
    for (const [env, def, meaning] of pkg.config) {
      lines.push(`| \`${env}\` | \`${def}\` | ${meaning} |`);
    }
    lines.push("");
  }
  lines.push("## License", "", "MIT © Bandonker", "");
  return lines.join("\n");
}

function buildPackage(pkg, outRoot) {
  const outDir = resolve(outRoot, pkg.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const entry = rewriteImports(transpile(pkg.source), pkg.rewrites);
  assertNoTsImports(entry, `${pkg.name} index.js`);
  writeFileSync(join(outDir, "index.js"), entry);

  const helperDests = [];
  for (const helper of pkg.helpers) {
    const dest = join(outDir, helper.dest);
    mkdirSync(dirname(dest), { recursive: true });
    const code = rewriteImports(transpile(helper.src), {});
    assertNoTsImports(code, `${pkg.name} ${helper.dest}`);
    writeFileSync(dest, code);
    helperDests.push(helper.dest);
  }

  const hasZod = /\bfrom\s+["']zod["']/.test(entry);
  const files = ["index.js", ...helperDests, "README.md", "LICENSE"];
  for (const dest of helperDests) {
    if (!dest.includes("/")) continue;
    const dir = `${dest.split("/")[0]}/`;
    if (!files.includes(dir)) files.push(dir);
  }

  const manifest = {
    name: pkg.name,
    version: VERSION,
    description: pkg.description,
    type: "module",
    license: "MIT",
    main: "./index.js",
    exports: { ".": "./index.js", "./server": "./index.js" },
    files,
    keywords: ["opencode", "opencode-plugin", ...(pkg.keywords ?? [])],
    homepage: "https://github.com/Bandonker/open-toolbox",
    repository: {
      type: "git",
      url: "git+https://github.com/Bandonker/open-toolbox.git",
    },
    bugs: "https://github.com/Bandonker/open-toolbox/issues",
    engines: { node: ">=20" },
    peerDependencies: { "@opencode/plugin": "^2.0.11" },
    ...(hasZod ? { dependencies: { zod: rootPkg.dependencies?.zod } } : {}),
  };
  writeFileSync(join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(outDir, "README.md"), buildReadme(pkg));
  cpSync(resolve(root, "LICENSE"), join(outDir, "LICENSE"));

  return { outDir, manifest, entry, helperDests };
}

/** How many `npm pack` processes may overlap during `--pack-check`. */
const PACK_CHECK_CONCURRENCY = 4;

/**
 * Smoke-pack one built package.
 *
 * Async (`execFile`) rather than `execSync` because execSync blocks the event
 * loop, which would make the pool below meaningless. The command is passed as
 * a single fixed string under `shell: true` — byte-identical to the old
 * execSync call, and unlike an args array it does not trip Node's DEP0190
 * ("args to a child process with shell option true"). The command is a
 * hardcoded constant, so there is nothing to inject.
 */
function packCheck(outDir) {
  return new Promise((done, fail) => {
    execFile("npm pack --dry-run --json", {
      cwd: outDir,
      encoding: "utf8",
      shell: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? "").trim().split("\n")[0] || err.message;
        fail(new Error(`npm pack failed: ${detail}`));
        return;
      }
      try {
        const info = JSON.parse(stdout)[0];
        done({ files: info.entryCount, size: info.size, unpacked: info.unpackedSize });
      } catch (parseErr) {
        fail(new Error(`npm pack failed: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving index
 * order in the returned array. A worker that throws does not abort the pool;
 * callers handle per-item failures themselves.
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// LIB-3 support: the build runs only when this file is invoked directly, so
// tests/verify-lib-fix-build-guard.mjs can import assertNoTsImports without
// triggering a full build. `node scripts/build-packages.mjs` behavior is
// unchanged.
async function main() {
  const check = process.argv.includes("--pack-check");
  const tmpRoot = resolve(root, ".packages-tmp");
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  let failures = 0;
  console.log(`Building ${PACKAGES.length} packages from ${root} -> packages/\n`);

  const rows = PACKAGES.map((pkg) => {
    const built = buildPackage(pkg, tmpRoot);
    let line = `  ${built.manifest.name}@${VERSION}  index.js`;
    if (built.helperDests.length) line += ` + ${built.helperDests.join(", ")}`;
    if (built.manifest.dependencies) line += `  deps: ${Object.keys(built.manifest.dependencies).join(",")}`;
    return { line, outDir: built.outDir };
  });

  // Each `npm pack` is a full node process (~1s), so the serial loop was the
  // bulk of a --pack-check run. The calls are independent: each runs in its own
  // already-built directory, --dry-run writes no tarball, and every result only
  // feeds its own summary line plus the shared failure counter. So they can
  // safely overlap. Results are collected and reprinted in PACKAGES order, so
  // the emitted output is byte-identical to the serial version.
  let packRows = null;
  if (check) {
    packRows = await mapPool(rows, PACK_CHECK_CONCURRENCY, async (row) => {
      try {
        const info = await packCheck(row.outDir);
        return {
          failed: false,
          text:
            `      pack: ${info.files} files, ${(info.size / 1024).toFixed(1)} KiB tarball, ` +
            `${(info.unpacked / 1024).toFixed(1)} KiB unpacked`,
        };
      } catch (err) {
        failures += 1;
        return { failed: true, text: `      pack FAILED: ${err.message.split("\n")[0]}` };
      }
    });
  }

  rows.forEach((row, i) => {
    console.log(row.line);
    if (!packRows) return;
    if (packRows[i].failed) console.error(packRows[i].text);
    else console.log(packRows[i].text);
  });

  if (check && failures > 0) {
    console.error(`\n${failures} package(s) failed to pack`);
    process.exit(1);
  }

  // Swap the freshly built packages into place.
  const backupRoot = resolve(root, ".packages-backup");
  rmSync(backupRoot, { recursive: true, force: true });
  if (existsSync(outRoot)) {
    renameSync(outRoot, backupRoot);
  }
  renameSync(tmpRoot, outRoot);
  rmSync(backupRoot, { recursive: true, force: true });

  // Smoke-test every entry: it must load and export exactly one default plugin.
  let loadFailures = 0;
  for (const pkg of PACKAGES) {
    const entryUrl = pathToFileURL(resolve(outRoot, pkg.dir, "index.js")).href;
    try {
      const mod = await import(entryUrl);
      const keys = Object.keys(mod);
      const ok =
        keys.includes("default") &&
        keys.every((k) => k === "default" || k === "__test__") &&
        typeof mod.default?.id === "string" &&
        typeof mod.default?.setup === "function";
      if (!ok) {
        loadFailures += 1;
        console.error(
          `  LOAD FAIL ${pkg.name}: expected a single default plugin, got exports [${keys.join(", ")}]`,
        );
      }
    } catch (err) {
      loadFailures += 1;
      console.error(`  LOAD FAIL ${pkg.name}: ${err.message.split("\n")[0]}`);
    }
  }
  if (loadFailures > 0) {
    console.error(`\n${loadFailures} package(s) failed to load`);
    process.exit(1);
  }
  console.log(`Verified: all ${PACKAGES.length} entries load and export a single default plugin.`);

  console.log(
    `\nDone. Publish with:  cd packages/<dir> && npm publish --access public\n` +
      `(run 'npm login' first; scoped packages need --access public)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
