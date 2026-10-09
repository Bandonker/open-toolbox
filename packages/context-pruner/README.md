# @bandonker/opencode-context-pruner

Context compiler for opencode v2: token-accurate pruning with a cache-stable epoch scheduler (session.hook context). Measures real tokens, plans changes once per epoch, dedupes and purges stale output, and never touches the transcript on disk.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-context-pruner"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `context_pruner_stats` | Show what context-pruner trimmed and the active config. |
| `context_report` | Token budget, epoch, cache hit ratio, summariser stats and active prune decisions. |
| `context_map` | List compressible tool output with stable #N references before calling compress. |
| `context_pruner_recall` | Get back the full output of a tool result that was replaced with a prune stub. |
| `compress` | Replace a chosen range of tool output with a model-generated summary. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_CONTEXT_PRUNER_ENABLED` | `true` | Turn pruning off without uninstalling |
| `OPENCODE_CONTEXT_PRUNER_KEEP_RECENT` | `6` | Most-recent tool results to leave untouched |
| `OPENCODE_CONTEXT_PRUNER_MIN_CHARS` | `2000` | Only prune results longer than this |
| `OPENCODE_CONTEXT_PRUNER_KEEP_HEAD` | `200` | Chars of the result kept as a preview |
| `OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS` | `true` | Never prune error results |
| `OPENCODE_CONTEXT_PRUNER_IGNORE` | `context_pruner_stats` | Comma-separated tools to never prune |
| `OPENCODE_CONTEXT_PRUNER_LOG` | `false` | Log each prune to stderr |
| `OPENCODE_CONTEXT_PRUNER_BUDGET_RATIO` | `0.9` | Fraction of the model window treated as input budget |
| `OPENCODE_CONTEXT_PRUNER_TARGET_RATIO` | `0.85` | Fraction of the budget to prune down to |
| `OPENCODE_CONTEXT_PRUNER_MAX_OUTPUT_RESERVE` | `8192` | Tokens reserved for the model's output |
| `OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TURNS` | `2` | Recent turns left untouched |
| `OPENCODE_CONTEXT_PRUNER_MIN_REPLAN_TOKENS` | `2000` | New tokens saved needed to justify a replan |
| `OPENCODE_CONTEXT_PRUNER_DEDUPE` | `true` | Stub duplicate tool output |
| `OPENCODE_CONTEXT_PRUNER_PURGE_ERRORS` | `true` | Stub stale errors when keepErrors is off |
| `OPENCODE_CONTEXT_PRUNER_CHARS_PER_TOKEN` | `3.6` | Seed estimator before calibration |
| `OPENCODE_CONTEXT_PRUNER_PROTECTED_TOOLS` | `task,skill,compress,context_report` | Tools never pruned |
| `OPENCODE_CONTEXT_PRUNER_PROTECTED_PATTERNS` | `(none)` | Regexes of tools never pruned |
| `OPENCODE_CONTEXT_PRUNER_NOTIFY` | `true` | Receipt verbosity: off | minimal | detailed |
| `OPENCODE_CONTEXT_PRUNER_NOTIFY_TYPE` | `toast` | chat posts the receipt inline, toast logs to stderr |
| `OPENCODE_CONTEXT_PRUNER_NOTIFY_MIN_TOKENS` | `500` | Turn savings needed to trigger a receipt |
| `OPENCODE_CONTEXT_PRUNER_NOTIFY_ON_TOPIC` | `true` | Receipt on applied summaries even below the floor |
| `OPENCODE_CONTEXT_PRUNER_COLLAPSE` | `true` | Collapse fully-pruned message spans |
| `OPENCODE_CONTEXT_PRUNER_COLLAPSE_STUBS` | `true` | Also collapse spans that are only stubbed |
| `OPENCODE_CONTEXT_PRUNER_COMPACTION` | `true` | Replace native compaction with a deterministic checkpoint |
| `OPENCODE_CONTEXT_PRUNER_RETRY` | `true` | Recover from context-limit errors by trimming harder and retrying |
| `OPENCODE_CONTEXT_PRUNER_TITLE` | `false` | Short-circuit model title generation |
| `OPENCODE_CONTEXT_PRUNER_RECALL` | `true` | Keep pruned output locally so it can be recalled instead of re-run |
| `OPENCODE_CONTEXT_PRUNER_RECALL_KEEP` | `50` | Most pruned outputs kept per session |
| `OPENCODE_CONTEXT_PRUNER_RECALL_MAX_CHARS` | `200000` | Max characters returned by a single recall |
| `OPENCODE_CONTEXT_PRUNER_STORAGE_GC` | `true` | Bound the non-session KV caches (digest + calibration) |
| `OPENCODE_CONTEXT_PRUNER_SUMMARY_CACHE_MAX` | `500` | Max persisted digest-cache entries (0 = unlimited) |
| `OPENCODE_CONTEXT_PRUNER_CALIBRATION_MAX` | `256` | Max persisted calibration entries (0 = unlimited) |
| `OPENCODE_CONTEXT_PRUNER_CACHE_AWARE` | `true` | Defer voluntary replans until the cache rewrite premium amortises |
| `OPENCODE_CONTEXT_PRUNER_CACHE_AMORTIZE` | `4` | Requests over which a cache rewrite must pay back |
| `OPENCODE_CONTEXT_PRUNER_SUPERSEDED` | `true` | Prune output superseded by a newer read/write of the same file |
| `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS` | `true` | Summarise automatically when the token target is exceeded |
| `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MAX` | `3` | Max automatic summariser calls per session |
| `OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MIN` | `4000` | Minimum tokens a range must hold to be auto-summarised |
| `OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES` | `12` | Max stale units covered per proactive summary |
| `OPENCODE_CONTEXT_PRUNER_COMPRESS` | `true` | Enable the model-callable compress tool |
| `OPENCODE_CONTEXT_PRUNER_COMPRESS_MAX_CHARS` | `24000` | Max characters sent to the summariser per compress call |
| `OPENCODE_CONTEXT_PRUNER_PROTECT_TAGS` | `true` | Preserve <protect>...</protect> blocks during summarisation |
| `OPENCODE_CONTEXT_PRUNER_PROTECT_USER` | `false` | Never summarise user messages |
| `OPENCODE_CONTEXT_PRUNER_SUMMARY_BUFFER` | `true` | Let summary tokens extend the effective budget |
| `OPENCODE_CONTEXT_PRUNER_MIN_CONTEXT_LIMIT` | `(none)` | Token count or percent at which nudges start |
| `OPENCODE_CONTEXT_PRUNER_MAX_CONTEXT_LIMIT` | `(none)` | Token count or percent treated as the hard window |
| `OPENCODE_CONTEXT_PRUNER_NUDGE` | `true` | Tell the model to compress when context grows |
| `OPENCODE_CONTEXT_PRUNER_NUDGE_FREQUENCY` | `5` | Requests between nudges |
| `OPENCODE_CONTEXT_PRUNER_NUDGE_FORCE` | `soft` | soft or strong nudge wording |
| `OPENCODE_CONTEXT_PRUNER_ITERATION_NUDGE` | `15` | Tool results after which a nudge is sent |
| `OPENCODE_CONTEXT_PRUNER_PROTECTED_FILES` | `(none)` | Globs of file paths whose tool output is never pruned |
| `OPENCODE_CONTEXT_PRUNER_CONFIG` | `(none)` | Explicit path to a context-pruner.jsonc config file |
| `OPENCODE_CONTEXT_PRUNER_DEBUG` | `false` | Write a debug log under ~/.config/opencode/logs/context-pruner |

## License

MIT © Bandonker
