# open-toolbox

**A pack of local plugins for [opencode](https://opencode.ai) Desktop v2** — session
orchestration and handoff, decision/error journals, a snippet library, codebase
search, a tool-call flight recorder, slash commands, context pruning and prompt
slimming, transcript export, local-first memory, autonomous goal loops, secret
redaction, and a lifetime usage dashboard.

[![ci](https://github.com/Bandonker/open-toolbox/actions/workflows/ci.yml/badge.svg)](https://github.com/Bandonker/open-toolbox/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin%20v2-000000.svg)](https://opencode.ai/docs/plugins)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

---

## Quick start

```bash
git clone https://github.com/Bandonker/open-toolbox.git
cd open-toolbox

# copy all three pieces into your opencode config (see "Layout" below)
CFG="$HOME/.config/opencode"
mkdir -p "$CFG/plugins" "$CFG/lib" "$CFG/opencode-sessions"
cp plugins/*.ts          "$CFG/plugins/"
cp lib/sqlite.ts         "$CFG/lib/"
cp opencode-sessions/helpers.ts "$CFG/opencode-sessions/"
cp package.json          "$CFG/package.json"

cd "$CFG" && npm install     # or: bun install
```

Restart opencode. Done — every tool below is now available to your agent.

<details>
<summary><b>Windows / PowerShell</b></summary>

```powershell
git clone https://github.com/Bandonker/open-toolbox.git
cd open-toolbox

$CFG = "$HOME\.config\opencode"
New-Item -ItemType Directory "$CFG\plugins", "$CFG\lib", "$CFG\opencode-sessions" -Force | Out-Null
Copy-Item plugins\*.ts              "$CFG\plugins\"
Copy-Item lib\sqlite.ts             "$CFG\lib\"
Copy-Item opencode-sessions\helpers.ts "$CFG\opencode-sessions\"
Copy-Item package.json              "$CFG\package.json"

Set-Location $CFG; npm install   # or: bun install
```

</details>

<details>
<summary><b>Project-local (one repo instead of globally)</b></summary>

Same files, under `<repo>/.opencode/` instead of `$HOME/.config/opencode/`:

```bash
mkdir -p .opencode/plugins .opencode/lib .opencode/opencode-sessions
cp /path/to/open-toolbox/plugins/*.ts          .opencode/plugins/
cp /path/to/open-toolbox/lib/sqlite.ts         .opencode/lib/
cp /path/to/open-toolbox/opencode-sessions/helpers.ts .opencode/opencode-sessions/
cp /path/to/open-toolbox/package.json          .opencode/package.json
cd .opencode && npm install
```

</details>

## Plugins

Click any plugin name to jump to its expandable documentation below.

| Plugin | Tools | Description |
| :-- | :--: | :-- |
| **[opencode-sessions](#plugin-opencode-sessions)** | 7 | Spawn child sessions, wait for them, read results, send follow-ups, answer permission prompts, cancel them — and **hand off the current working point into a fresh session**. Created sessions are real opencode sessions, so they show up in the Desktop session switcher as if you'd pressed `+`. |
| **[decision-log](#plugin-decision-log)** | 5 | Record and search architectural decisions in a local SQLite FTS5 database. `decision_log`, `decision_search`, `decision_list`, `decision_get`, `decision_update`. |
| **[error-journal](#plugin-error-journal)** | 5 | Log errors with context, search past ones, and record resolutions so you stop re-debugging the same failure. |
| **[snippet-library](#plugin-snippet-library)** | 5 | Save reusable code snippets and search them by language, tag, or full text. |
| **[codebase-index](#plugin-codebase-index)** | 4 | Index a codebase directory and run BM25-ranked full-text search over it. |
| **[tool-audit](#plugin-tool-audit)** | 3 | Flight recorder for every tool call: tool, args, status, duration and error land in a local SQLite DB, searchable with `trace_query`, summarised with `trace_stats`, exportable with `trace_export`. Secrets in arguments are redacted before they touch disk. |
| **[command-pack](#plugin-command-pack)** | — | Registers 7 slash commands so the pack is one keystroke away (see [Commands](#commands)). |
| **[context-pruner](#plugin-context-pruner)** | 1 | Token-accurate context compiler: trims stale tool output out of the request only (`session.hook("context")`), plans changes once per epoch so the prompt-cache prefix stays stable, dedupes and purges stale output, and never touches the transcript on disk. `context_pruner_stats` shows what it trimmed; `context_report` shows budget, epoch, cache hit ratio and active decisions; `context_pruner_recall` returns a pruned output on demand so it need not be re-run. |
| **[session-export](#plugin-session-export)** | 2 | Dump a session transcript to markdown / json / jsonl / text with a model + message/tool/token/cost header, role and tool filters, optional reasoning, per-part truncation, secret redaction with home-path rewriting, and safe non-overwriting filenames. `session_export` writes a file (or returns it inline); `session_export_info` reports config and the last export. |
| **[memory](#plugin-memory)** | 5 | Local-first long-term memory in SQLite FTS5 — `memory_remember`, `memory_recall`, `memory_forget`, `memory_list`, `memory_stats`. No embedding API, no cloud, no network. Relevant memories are auto-injected into each request (`session.hook("context")`) within a hard character budget, deduped per session. DB at `~/.opencode-plugins/memory/memory.db`. |
| **[goal](#plugin-goal)** | 3 | Set an objective for a session and keep working until it is actually reached. `/goal <objective>` (add `- ` lines for success criteria) starts the loop; the goal is re-injected into every request (`session.hook("context")`) so it survives long turns, and when a turn ends the model is auto-continued (`session.prompt`) with the remaining budget. The loop stops only on `goal_complete` (with evidence) or `goal_blocked`, a user interrupt (which pauses), a detected stall (turns that run no tools and repeat themselves), a failure streak, or the iteration/time budget. Goal state is persisted per session, so it survives a plugin reload. Tools: `goal_complete`, `goal_blocked`, `goal_progress`. |
| **[secret-shield](#plugin-secret-shield)** | 4 | v2-native secret detector and redactor. Scrubs the **outbound HTTP body** (session-title, compaction and generate calls), the prompt, tool arguments/results and child-process env; `observe`/`redact`/`block` modes, 69 high-precision rules plus a Shannon-entropy fallback, allowlist precedence, and a hashed JSONL audit that never stores the value. Tools: `secret_shield_scan`, `secret_shield_stats`, `secret_shield_shape`, `secret_shield_keys`. |
| **[finish-guard](#plugin-finish-guard)** | — | Normalises OpenAI-compatible SSE streams at the `session.hook("http.response")` seam so a content/reasoning/tool delta that arrives *after* the `finish_reason` chunk cannot abort the turn. Fixes `AI.Error.InvalidProviderOutput: OpenAI Chat received content after the finish reason` (and the `Failed to drain Session` cascade) from reasoning models behind strict OpenAI-compatible gateways. |
| **[strip-skills-catalog](#plugin-strip-skills-catalog)** | — | Strips the `<available_skills>` catalog from the system prompt to save tokens. The `skill` tool still works on demand — agents can call it by name. |
| **[usage-stats](#plugin-usage-stats)** | 5 | Lifetime token / dollar / tool accounting in local SQLite. Cumulative `session.usage.updated` totals are delta-attributed to the session's current model; `title`/`compaction` spend is tracked separately as background. `stats_summary`, `stats_tools`, `stats_tokens`, `stats_heatmap` and `/stats` expose the numbers; `stats_dashboard` writes a self-contained HTML dashboard (heatmap + bar chart + tables) to `~/.opencode-plugins/usage-stats/dashboard.html`. |

> All SQLite-backed plugins use `bun:sqlite` when available and fall back to
> `node:sqlite`. Databases land in `~/.opencode-plugins/`.

## Plugin details

Expand a plugin to read its purpose and key capabilities. Configuration options
are documented in [Configuration](#configuration).

<a id="plugin-opencode-sessions"></a>
<details>
<summary><strong>opencode-sessions</strong> — session orchestration and handoff</summary>

Spawn child sessions, wait for their results, send follow-ups, answer permission
prompts, cancel them, and hand off the current working point into a fresh
session. Created sessions are real opencode sessions and appear in the Desktop
session switcher.

Tools: 7. See the [opencode-sessions package documentation](opencode-sessions/README.md)
for the complete tool list and configuration knobs.

</details>

<a id="plugin-decision-log"></a>
<details>
<summary><strong>decision-log</strong> — durable architecture decisions</summary>

Record architectural decisions with context and consequences, then search and
update them from a local SQLite FTS5 database.

Tools: `decision_log`, `decision_search`, `decision_list`, `decision_get`, and
`decision_update`.

</details>

<a id="plugin-error-journal"></a>
<details>
<summary><strong>error-journal</strong> — searchable debugging history</summary>

Log errors with context, search previous failures, and record resolutions so
recurring problems do not have to be debugged from scratch.

Tools: 5, including error logging, search, listing, and resolution tracking.

</details>

<a id="plugin-snippet-library"></a>
<details>
<summary><strong>snippet-library</strong> — reusable code snippets</summary>

Save reusable code snippets locally and search them by language, tags, or full
text. Everything is stored locally in SQLite with full-text search.

Tools: 5 for saving, retrieving, listing, updating, and searching snippets.

</details>

<a id="plugin-codebase-index"></a>
<details>
<summary><strong>codebase-index</strong> — local codebase search</summary>

Index a codebase directory and run BM25-ranked full-text search over it. The
index is local and can be refreshed incrementally as the project changes.

Tools: 4 for indexing, searching, inspecting status, and managing the index.

</details>

<a id="plugin-tool-audit"></a>
<details>
<summary><strong>tool-audit</strong> — local tool-call flight recorder</summary>

Record every tool call with its tool name, arguments, status, duration, and
error. Use `trace_query` to search the audit log, `trace_stats` to summarise it,
and `trace_export` to export it. Secrets in arguments are redacted before they
touch disk.

Tools: `trace_query`, `trace_stats`, and `trace_export`.

</details>

<a id="plugin-command-pack"></a>
<details>
<summary><strong>command-pack</strong> — slash commands for the toolbox</summary>

Registers slash commands for the most common toolbox actions, including
`/handoff`, `/decide`, `/journal`, `/recall`, `/index`, `/trace`, `/toolbox`,
and `/stats`.

See [Commands](#commands) for the command list. Commands inject short
instructions into the current session and use the corresponding toolbox tools.

</details>

<a id="plugin-context-pruner"></a>
<details>
<summary><strong>context-pruner</strong> — token-accurate context compiler</summary>

Trims stale tool output from the outgoing request only. The session transcript
on disk is unchanged, and pruned tool output can be recalled or re-run. The
planner preserves a stable prompt-cache prefix, removes superseded output, and
can proactively summarise stale context before the model window fills.

Use `context_pruner_stats` to inspect savings, `context_report` to inspect the
active budget and epoch, and `context_pruner_recall` to retrieve pruned output
without re-running the original tool.

</details>

<a id="plugin-session-export"></a>
<details>
<summary><strong>session-export</strong> — transcript exports</summary>

Export session transcripts to Markdown, JSON, JSONL, or text with a model and
usage header. Exports support role and tool filters, optional reasoning,
per-part truncation, secret redaction, and safe non-overwriting filenames.

`session_export` writes a file or returns the export inline;
`session_export_info` reports the current configuration and last export.

</details>

<a id="plugin-memory"></a>
<details>
<summary><strong>memory</strong> — local-first long-term memory</summary>

Store and recall durable local memories without an embedding API, cloud service,
or network request. Relevant memories are injected into each request within a
character budget and deduplicated per session.

Tools: `memory_remember`, `memory_recall`, `memory_forget`, `memory_list`, and
`memory_stats`. The database lives at
`~/.opencode-plugins/memory/memory.db`.

</details>

<a id="plugin-goal"></a>
<details>
<summary><strong>goal</strong> — persistent autonomous goal loops</summary>

Start an objective with `/goal <objective>` and optional `- ` success
criteria. The goal is re-injected into requests and the model is automatically
continued when a turn ends, until `goal_complete`, `goal_blocked`, an
interrupt, a stall, repeated failures, or the iteration/time budget stops it.

Goal state is persisted per session, so it survives plugin reloads and long
turns. Tools: `goal_complete`, `goal_blocked`, and `goal_progress`.

</details>

<a id="plugin-secret-shield"></a>
<details>
<summary><strong>secret-shield</strong> — secret detection and redaction</strong>

Detect and redact secrets across outbound HTTP bodies, prompts, tool arguments
and results, and child-process environments. Choose `observe`, `redact`, or
`block` mode, with high-precision rules, entropy fallback detection, allowlists,
and a hashed JSONL audit that never stores the secret value.

Tools: `secret_shield_scan`, `secret_shield_stats`, `secret_shield_shape`, and
`secret_shield_keys`.

</details>

<a id="plugin-finish-guard"></a>
<details>
<summary><strong>finish-guard</strong> — resilient SSE stream handling</summary>

Normalise OpenAI-compatible SSE streams when a content, reasoning, or tool delta
arrives after the provider's `finish_reason` chunk. This prevents invalid
provider-output failures and the follow-on failed-session-drain cascade for
reasoning models behind strict gateways.

</details>

<a id="plugin-strip-skills-catalog"></a>
<details>
<summary><strong>strip-skills-catalog</strong> — smaller system prompts</summary>

Strips the `<available_skills>` catalog from the system prompt to save tokens.
The `skill` tool remains available on demand, so agents can still load a skill
when they need it.

</details>

<a id="plugin-usage-stats"></a>
<details>
<summary><strong>usage-stats</strong> — lifetime usage dashboard</summary>

Track lifetime tokens, cost, tool calls, model usage, and background title or
compaction spend in local SQLite. Use `stats_summary`, `stats_tools`,
`stats_tokens`, `stats_heatmap`, or `/stats` for the data, and `stats_dashboard`
to write a self-contained HTML dashboard.

The dashboard includes an activity heatmap, a 30-day token chart, tool and model
tables, exact hover breakdowns for daily activity and chart bars, searchable
multi-select model filtering, responsive layout, and automatic refresh without
spending model tokens.

### Dashboard screenshots

![Usage-stats dashboard overview](images/usage-stats.PNG)

![Usage-stats dashboard with a populated activity chart](images/usage-stats2.PNG)

![Usage-stats dashboard details](images/usage-stats3.PNG)

</details>

## Commands

`command-pack` adds these to your command palette (`usage-stats` adds `/stats`, `goal` adds `/goal`):

| Command | Does |
| :-- | :-- |
| `/handoff` | Hand the current working point off to a fresh session |
| `/decide` | Record a decision in the decision log |
| `/journal` | Log a bug or recurring failure in the error journal |
| `/recall` | Search past decisions, errors, snippets and indexed code |
| `/index` | Index this project for full-text code search |
| `/trace` | Inspect the tool-call audit log |
| `/toolbox` | Show which pack tools are installed in this session |
| `/stats` | Refresh and open the usage dashboard — runs server-side, so it costs **zero model tokens** |
| `/goal` | Set an objective the agent keeps working toward until it is reached (`/goal status`, `pause`, `resume`, `done`, `clear` manage it) |

Each command injects a short instruction into the current session, so the agent
does the work with its normal tools. If a command's tool isn't installed, the
instruction says so instead of failing silently.

## Configuration

Zero config is required — files in `plugins/` load with defaults. The `plugins`
array in `opencode.jsonc` is for **npm packages** (and directory-based plugin
packages); entries are a package name or an object carrying `options`:

```jsonc
{
  "plugins": [
    // a bare package name
    "@bandonker/opencode-context-pruner",
    // or an object carrying options
    { "package": "@bandonker/opencode-tool-audit", "options": { "retentionDays": 90 } },
    // a name starting with "-" removes that plugin
    { "package": "-some-plugin" }
  ]
}
```

A string starting with `-` removes a plugin.

> **Local `.ts` plugins take no `options`.** The loader rejects a bare file path
> with `configured plugin path must be a directory`, and files in `plugins/` are
> loaded with defaults. To tune a local plugin, use its env vars — that is why
> every knob below has one.

### tool-audit options

Each option is read from the plugin `options` object (npm installs) or the env
var (always works):

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `dir` | `OPENCODE_TOOL_AUDIT_DIR` | `~/.opencode-plugins/tool-audit` | Where the SQLite DB lives |
| `enabled` | `OPENCODE_TOOL_AUDIT_ENABLED` | `true` | Turn recording off without uninstalling |
| `redact` | `OPENCODE_TOOL_AUDIT_REDACT` | `true` | Scrub secrets from arguments before writing |
| `maxInputChars` | `OPENCODE_TOOL_AUDIT_MAX_INPUT_CHARS` | `2000` | Per-call argument cap |
| `retentionDays` | `OPENCODE_TOOL_AUDIT_RETENTION_DAYS` | `30` | Prune rows older than this (`0` = keep forever) |
| `ignoreTools` | `OPENCODE_TOOL_AUDIT_IGNORE` | `todowrite` + its own tools | Comma-separated tools to skip |

Values are read when the plugin loads, so restart opencode after changing them.
`opencode-sessions` has its own knobs — see
[its README](opencode-sessions/README.md#config-knobs).

### context-pruner options

`context-pruner` is a *context compiler*: it trims stale tool output from the
outgoing request only. The session transcript on disk is unchanged, and a pruned
tool can simply be re-run.

It measures tokens (calibrated against provider usage), plans prune changes once
per **epoch**, and reuses those decisions verbatim so the prompt-cache prefix
stays stable between replans. By default it also keeps the outgoing request near
a **steady ceiling** well below the model window (`steadyTargetRatio`, default
`0.06`), so stale closed topics are summarised before the window ever fills; set
`proactiveSummarize: false` or `steadyTargetRatio: 0` for window-only behaviour.
Without a resolvable window it falls back to the positional rules below.

On top of that it removes output that is *provably* superseded (a newer read or
write of the same file), and over the target it summarises the largest stale
units — tool output and, since prose is on by default, assistant/user text — with
the session model automatically, so savings land even when the model ignores
nudges. It reads optional config from
`.opencode/context-pruner.jsonc` (project) then
`~/.config/opencode/context-pruner.jsonc` (global), and can also read a DCP
`dcp.jsonc` for migration.

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_CONTEXT_PRUNER_ENABLED` | `true` | Turn pruning off without uninstalling |
| `keepRecent` | `OPENCODE_CONTEXT_PRUNER_KEEP_RECENT` | `6` | Most-recent tool results to leave untouched |
| `minChars` | `OPENCODE_CONTEXT_PRUNER_MIN_CHARS` | `2000` | Only prune results longer than this |
| `keepHeadChars` | `OPENCODE_CONTEXT_PRUNER_KEEP_HEAD` | `200` | Characters of the result kept as a preview |
| `keepErrors` | `OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS` | `true` | Never prune error results |
| `ignoreTools` | `OPENCODE_CONTEXT_PRUNER_IGNORE` | `context_pruner_stats` | Comma-separated tools to never prune |
| `log` | `OPENCODE_CONTEXT_PRUNER_LOG` | `false` | Log each prune to stderr |
| `budgetRatio` | `OPENCODE_CONTEXT_PRUNER_BUDGET_RATIO` | `0.9` | Fraction of the model window treated as input budget |
| `targetRatio` | `OPENCODE_CONTEXT_PRUNER_TARGET_RATIO` | `0.85` | Fraction of the budget to prune down to |
| `maxOutputReserve` | `OPENCODE_CONTEXT_PRUNER_MAX_OUTPUT_RESERVE` | `8192` | Tokens reserved for the model's output |
| `keepRecentTurns` | `OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TURNS` | `2` | Recent turns left untouched |
| `minReplanTokens` | `OPENCODE_CONTEXT_PRUNER_MIN_REPLAN_TOKENS` | `2000` | New tokens saved needed to justify a replan |
| `dedupe` | `OPENCODE_CONTEXT_PRUNER_DEDUPE` | `true` | Stub duplicate tool output |
| `purgeErrors` | `OPENCODE_CONTEXT_PRUNER_PURGE_ERRORS` | `true` | Stub stale errors (only when `keepErrors` is `false`) |
| `charsPerToken` | `OPENCODE_CONTEXT_PRUNER_CHARS_PER_TOKEN` | `3.6` | Seed estimator before calibration |
| `protectedTools` | `OPENCODE_CONTEXT_PRUNER_PROTECTED_TOOLS` | `task,skill,compress,context_report` | Tools never pruned |
| `protectedPatterns` | `OPENCODE_CONTEXT_PRUNER_PROTECTED_PATTERNS` | (none) | Regexes of tools never pruned |
| `notify` | `OPENCODE_CONTEXT_PRUNER_NOTIFY` | `true` | Receipt verbosity: `off` \| `minimal` \| `detailed` |
| `notifyType` | `OPENCODE_CONTEXT_PRUNER_NOTIFY_TYPE` | `toast` | `chat` posts the receipt inline (`session.synthetic`); `toast` logs to stderr |
| `notifyMinTokens` | `OPENCODE_CONTEXT_PRUNER_NOTIFY_MIN_TOKENS` | `500` | Turn savings needed to trigger a receipt (`0` = every prune) |
| `notifyOnTopic` | `OPENCODE_CONTEXT_PRUNER_NOTIFY_ON_TOPIC` | `true` | Also send a receipt when a summary is applied, even below the token floor |
| `collapseRanges` | `OPENCODE_CONTEXT_PRUNER_COLLAPSE` | `true` | Collapse fully-pruned message spans |
| `collapseStubs` | `OPENCODE_CONTEXT_PRUNER_COLLAPSE_STUBS` | `true` | Also collapse spans that are only stubbed (max savings) |
| `superseded` | `OPENCODE_CONTEXT_PRUNER_SUPERSEDED` | `true` | Prune output superseded by a newer read/write of the same file |
| `autoSummarize` | `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS` | `true` | Summarise automatically when the token target is exceeded |
| `autoSummarizeMaxCalls` | `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MAX` | `0` | Max automatic summariser calls per session (`0` = unlimited) |
| `autoSummarizeMinTokens` | `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MIN` | `4000` | Minimum tokens a range must hold to be auto-summarised |
| `maxAutoSummaries` | `OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES` | `12` | Max stale units covered per proactive summary (`0` = unlimited; lower trades coverage for fewer calls) |
| `proactiveSummarize` | `OPENCODE_CONTEXT_PRUNER_PROACTIVE` | `true` | Keep the request near the steady ceiling even when the window is wide |
| `steadyTargetRatio` | `OPENCODE_CONTEXT_PRUNER_STEADY_RATIO` | `0.06` | Steady ceiling as a fraction of the window (`0` disables) |
| `steadyTargetMinTokens` | `OPENCODE_CONTEXT_PRUNER_STEADY_MIN` | `1500` | Floor for the steady ceiling |
| `compressText` | `OPENCODE_CONTEXT_PRUNER_COMPRESS_TEXT` | `true` | Let the summariser cover assistant/user prose, not just tool output |
| `compactionCheckpoint` | `OPENCODE_CONTEXT_PRUNER_COMPACTION` | `true` | Replace native compaction with a deterministic checkpoint |
| `retryOnOverflow` | `OPENCODE_CONTEXT_PRUNER_RETRY` | `true` | Recover from context-limit errors by trimming harder and retrying |
| `titleShortCircuit` | `OPENCODE_CONTEXT_PRUNER_TITLE` | `false` | Skip model title generation using the first user line |
| `cacheAware` | `OPENCODE_CONTEXT_PRUNER_CACHE_AWARE` | `true` | Defer voluntary replans until the cache rewrite premium amortises |
| `cacheAmortize` | `OPENCODE_CONTEXT_PRUNER_CACHE_AMORTIZE` | `4` | Requests over which a cache rewrite must pay back |
| `recall` | `OPENCODE_CONTEXT_PRUNER_RECALL` | `true` | Keep pruned output locally so it can be recalled instead of re-run |
| `recallKeep` | `OPENCODE_CONTEXT_PRUNER_RECALL_KEEP` | `50` | Most pruned outputs kept per session |
| `recallMaxChars` | `OPENCODE_CONTEXT_PRUNER_RECALL_MAX_CHARS` | `200000` | Max characters returned by a single recall |
| `compressEnabled` | `OPENCODE_CONTEXT_PRUNER_COMPRESS` | `true` | Enable the model-callable `compress` tool |
| `compressMaxSourceChars` | `OPENCODE_CONTEXT_PRUNER_COMPRESS_MAX_CHARS` | `24000` | Max characters sent to the summariser per call |
| `protectTags` | `OPENCODE_CONTEXT_PRUNER_PROTECT_TAGS` | `true` | Preserve `<protect>` blocks during summarisation |
| `protectUserMessages` | `OPENCODE_CONTEXT_PRUNER_PROTECT_USER` | `false` | Never summarise user messages |
| `summaryBuffer` | `OPENCODE_CONTEXT_PRUNER_SUMMARY_BUFFER` | `true` | Let summary tokens extend the effective budget |
| `minContextLimit` | `OPENCODE_CONTEXT_PRUNER_MIN_CONTEXT_LIMIT` | (none) | Token count or percent at which nudges start |
| `maxContextLimit` | `OPENCODE_CONTEXT_PRUNER_MAX_CONTEXT_LIMIT` | (none) | Token count or percent treated as the hard window |
| `nudgeEnabled` | `OPENCODE_CONTEXT_PRUNER_NUDGE` | `true` | Tell the model to compress when context grows |
| `nudgeFrequency` | `OPENCODE_CONTEXT_PRUNER_NUDGE_FREQUENCY` | `5` | Requests between nudges |
| `nudgeForce` | `OPENCODE_CONTEXT_PRUNER_NUDGE_FORCE` | `soft` | `soft` or `strong` nudge wording |
| `iterationNudgeThreshold` | `OPENCODE_CONTEXT_PRUNER_ITERATION_NUDGE` | `15` | Tool results after which a nudge is sent |
| `protectedFilePatterns` | `OPENCODE_CONTEXT_PRUNER_PROTECTED_FILES` | (none) | Globs of file paths never pruned |
| `debug` | `OPENCODE_CONTEXT_PRUNER_DEBUG` | `false` | Write a debug log under `~/.config/opencode/logs/context-pruner` |

### session-export options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_SESSION_EXPORT_ENABLED` | `true` | Disable exporting without uninstalling |
| `dir` | `OPENCODE_SESSION_EXPORT_DIR` | `<cwd>/.opencode-exports` | Default output directory |
| `format` | `OPENCODE_SESSION_EXPORT_FORMAT` | `markdown` | `markdown` \| `json` \| `jsonl` \| `text` |
| `includeReasoning` | `OPENCODE_SESSION_EXPORT_INCLUDE_REASONING` | `false` | Include assistant reasoning parts |
| `includeToolResults` | `OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_RESULTS` | `true` | Include tool results/errors |
| `maxCharsPerPart` | `OPENCODE_SESSION_EXPORT_MAX_PART_CHARS` | `4000` | Truncate each part to this many chars |
| `redact` | `OPENCODE_SESSION_EXPORT_REDACT` | `true` | Scrub secrets; rewrite home paths to `~` |

### memory options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_MEMORY_ENABLED` | `true` | Turn the plugin off without uninstalling |
| `autoRecall` | `OPENCODE_MEMORY_AUTO_RECALL` | `true` | Inject relevant memories into each request |
| `budgetChars` | `OPENCODE_MEMORY_BUDGET_CHARS` | `1200` | Hard character budget per injection |
| `topK` | `OPENCODE_MEMORY_TOP_K` | `5` | Max memories per recall/injection |
| `minScore` | `OPENCODE_MEMORY_MIN_SCORE` | `0` | Minimum BM25 score (`0` = any FTS hit) |
| `scope` | `OPENCODE_MEMORY_SCOPE` | `project` | Default scope: `global` \| `project` \| `session` |
| `maxEntries` | `OPENCODE_MEMORY_MAX_ENTRIES` | `0` | Prune least-important rows beyond this (`0` = unlimited) |
| `log` | `OPENCODE_MEMORY_LOG` | `false` | Log activity to stderr |

### goal options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_GOAL_ENABLED` | `true` | Turn the goal loop off without uninstalling |
| `maxIterations` | `OPENCODE_GOAL_MAX_ITERATIONS` | `30` | Max continuation turns per goal |
| `maxMinutes` | `OPENCODE_GOAL_MAX_MINUTES` | `180` | Wall-clock budget per goal (minutes) |
| `stallLimit` | `OPENCODE_GOAL_STALL_LIMIT` | `3` | Turns with no tool use and an unchanged reply before stopping as stalled |
| `maxFailures` | `OPENCODE_GOAL_MAX_FAILURES` | `3` | Consecutive execution errors before stopping |
| `requireEvidence` | `OPENCODE_GOAL_REQUIRE_EVIDENCE` | `true` | Require evidence in `goal_complete` |
| `maxInjectChars` | `OPENCODE_GOAL_MAX_INJECT_CHARS` | `1600` | Character cap on the injected goal reminder |
| `notify` | `OPENCODE_GOAL_NOTIFY` | `true` | Post loop start/stop notes into the session |
| `log` | `OPENCODE_GOAL_LOG` | `false` | Log loop activity to stderr |

**The loop.** `/goal Ship the login fix` stores the objective and starts a normal
turn. Follow it with `- ` lines to list success criteria. The objective is
re-injected into every request, so it survives long turns and compaction; when a
turn ends (`session.idle`/`session.execution.succeeded`) the plugin queues a
continuation prompt carrying the objective and the remaining budget. It stops
when the model calls `goal_complete` (which requires concrete evidence unless
`requireEvidence` is off) or `goal_blocked`, when you interrupt a turn (the goal
**pauses** rather than fighting you), when `stallLimit` turns run no tools and the
reply is unchanged, after `maxFailures` consecutive execution errors, or when the
iteration/time budget is exhausted. Goal state is persisted per session, so a
paused or budget-stopped goal can be resumed with `/goal resume`.

### secret-shield options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_SECRET_SHIELD_ENABLED` | `true` | Turn the shield off without uninstalling |
| `mode` | `OPENCODE_SECRET_SHIELD_MODE` | `observe` | `observe` (audit only) \| `redact` \| `block` |
| `entropy` | `OPENCODE_SECRET_SHIELD_ENTROPY` | `true` | Shannon-entropy fallback for unlabelled tokens |
| `allow` | `OPENCODE_SECRET_SHIELD_ALLOW` | (none) | Comma-separated literals, `/regex/`, globs or rule ids |
| `blockEnvReads` | `OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS` | `true` | In `block` mode, deny protected secret-file reads |
| `log` | `OPENCODE_SECRET_SHIELD_LOG` | `false` | Emit diagnostics to stderr |

### finish-guard options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `enabled` | `OPENCODE_FINISH_GUARD_ENABLED` | `true` | Turn stream normalisation off without uninstalling |
| `log` | `OPENCODE_FINISH_GUARD_LOG` | `false` | Log each normalised stream to stderr |
| `retry` | `OPENCODE_FINISH_GUARD_RETRY` | `true` | Ask opencode to retry the turn when a stream is malformed |
| `retryMax` | `OPENCODE_FINISH_GUARD_RETRY_MAX` | `3` | Maximum retry attempts before the turn is allowed to fail |

### usage-stats options

| Option | Env var | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `dir` | `OPENCODE_USAGE_STATS_DIR` | `~/.opencode-plugins/usage-stats` | Where the SQLite DB and dashboard live |
| `enabled` | `OPENCODE_USAGE_STATS_ENABLED` | `true` | Turn recording off without uninstalling |
| `retentionDays` | `OPENCODE_USAGE_STATS_RETENTION_DAYS` | `0` | Prune daily rollups older than this (`0` = keep forever) |
| `heatmapMetric` | `OPENCODE_USAGE_STATS_HEATMAP_METRIC` | `tokens` | Heatmap metric (`tokens` \| `cost` \| `calls`) |
| `heatmapWeeks` | `OPENCODE_USAGE_STATS_HEATMAP_WEEKS` | `26` | Heatmap width in weeks |
| `includeBackground` | `OPENCODE_USAGE_STATS_INCLUDE_BACKGROUND` | `true` | Include title/compaction spend in charts |
| `autoRefreshSec` | `OPENCODE_USAGE_STATS_AUTO_REFRESH` | `20` | Regenerate the dashboard this often (s) when data changed; `0` disables |
| `pricingRefreshMin` | `OPENCODE_USAGE_STATS_PRICING_REFRESH_MIN` | `10` | Re-fetch model price lists this often (min); `0` disables |
| `prices` | `OPENCODE_USAGE_STATS_PRICES` | (none) | JSON rate overrides keyed `providerID/modelID`, e.g. for local models |
| `openOnStart` | `OPENCODE_USAGE_STATS_OPEN` | `false` | Open the dashboard in your browser when opencode starts |
| `log` | `OPENCODE_USAGE_STATS_LOG` | `false` | Log plugin activity to stderr |

**The dashboard.** `stats_dashboard` (and `/stats`) writes a self-contained HTML
report to `~/.opencode-plugins/usage-stats/dashboard.html` — a GitHub-style
activity heatmap, a 30-day bar chart, top-tools and per-model tables, and a
separate background (title/compaction) section. Hovering an activity day shows
its token categories, tool calls, model usage and cost; hovering a bar shows
its exact token total; and the Models table can be filtered by model. It has
no external scripts, CDN or network access; a small inline script powers the
model filter, it auto-switches light/dark with your OS theme, and reloads itself
every `autoRefreshSec` so it stays current **without spending any model
tokens** (the plugin runs in the server process, not the model).

**Cost is computed from the provider's real price list.** The plugin reads each
model's published per-million-token rates via `ctx.model.list()` and shows both
`reported` (what opencode billed) and `list price` (API-equivalent) — so free
models show `$0.00`, unpriced ones show `—` (never a fake zero), and flat-rate
subscriptions still show what the usage was worth. Local models have no published
price; give them one with `prices`, e.g.
`OPENCODE_USAGE_STATS_PRICES={"lmstudio/qwen3-coder":{"input":0,"output":0,"cache":{"read":0,"write":0}}}`.
Token counts, tool calls and the heatmap are captured for every model regardless
of pricing.

The plugin API has no way to add a Settings tab, so `/stats` opens the dashboard
for you directly from the server process — it never calls the model. Set
`OPENCODE_USAGE_STATS_OPEN=true` to open it automatically at startup, or
`OPENCODE_USAGE_STATS_NO_OPEN=1` to suppress browser launches (headless).

<details>
<summary><b>Why does the published JSON schema say <code>plugin</code>?</b></summary>

`https://opencode.ai/config.json` describes the TUI's settings, not the server
config. The server validates a `plugins` (plural) array — that is the key the
runtime reads, confirmed in the server log when the config is reloaded.
</details>

## Layout

Copy all three folders into your config dir — **`plugins/` alone is not enough**,
since some plugins import helpers that live outside it:

```
~/.config/opencode/        # or <repo>/.opencode/ — this is under your HOME dir,
                           # not relative to the repo
├── plugins/               # what opencode loads
│   ├── opencode-sessions.ts
│   ├── command-pack.ts
│   ├── tool-audit.ts
│   ├── decision-log.ts
│   ├── error-journal.ts
│   ├── snippet-library.ts
│   ├── codebase-index.ts
│   ├── context-pruner.ts
│   ├── session-export.ts
│   ├── memory.ts
│   ├── secret-shield.ts
│   ├── finish-guard.ts
│   ├── usage-stats.ts
│   ├── goal.ts
│   └── strip-skills-catalog.ts
├── lib/
│   └── sqlite.ts          # used by the SQLite-backed plugins
└── opencode-sessions/
    └── helpers.ts         # used by opencode-sessions
```

<details>
<summary><b>Why aren't the helpers inside <code>plugins/</code>?</b></summary>

opencode treats **every export** of a file under `plugins/` as a plugin factory.
A stray helper export therefore fails the load with
`prompt.split is not a function` and cascades into config/provider errors.
Keeping `lib/` and `opencode-sessions/` outside `plugins/` avoids that entirely.

</details>

## Verify

From the repo root — no opencode server needed:

```bash
npm install --no-audit --no-fund
npm test          # helper unit tests + mock-context checks for the pack
npm run typecheck # tsc --noEmit over plugins/ and lib/
```

The same two commands run on every push in [CI](.github/workflows/ci.yml).

## Development

`opencode-sessions/` is the source of truth for the sessions plugin (the copy in
`plugins/` is the built artifact):

```bash
node opencode-sessions/sync.mjs        # install: repo -> plugins/ (fixes the helpers import)
node opencode-sessions/sync.mjs pull   # pull:    plugins/ -> repo
```

## Publishing

Each plugin also ships as its own scoped npm package (the v2 loader allows
exactly one plugin per package). The build inlines each plugin's helpers and
rewrites the relative imports, so the published package is self-contained:

```bash
npm run build:packages   # transpile + write packages/<dir>/ and smoke-load each entry
npm run pack:check       # the above, plus `npm pack --dry-run` per package
```

Then publish (one package at a time):

```bash
npm login                                  # once per machine
cd packages/decision-log
npm publish --access public                # scoped packages need --access public
```

`packages/` is generated and gitignored. Publish order does not matter — the
packages have no runtime dependency on each other.

## FAQ

<details>
<summary>opencode logs <code>failed to load plugin</code> / <code>prompt.split is not a function</code></summary>

A helper file ended up inside `plugins/`. Move `lib/` and `opencode-sessions/`
out of `plugins/` and restart.
</details>

<details>
<summary>Tools don't appear after installing</summary>

Check that you copied all three folders (`plugins/`, `lib/`,
`opencode-sessions/`), ran `npm install` in the config dir, and fully
restarted opencode.
</details>

<details>
<summary>An npm plugin fails to load</summary>

The `plugins` list in `opencode.jsonc` is for npm packages. Local plugins in the
`plugins/` folder need no config entry. Many packages are still v1-only and will
fail under v2 — verify a v2 release before adding one.
</details>

## Contributing

Issues and PRs are welcome. Keep changes scoped, run `npm test` and
`npm run typecheck` before opening a PR, and describe the tool behavior you changed.

## License

[MIT](LICENSE) © Bandonker
