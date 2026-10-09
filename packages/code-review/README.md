# @bandonker/opencode-code-review

Review source files and diffs for security vulnerabilities, code smells, and type safety issues. Stores review history in a local SQLite FTS5 database with full-text search.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-code-review"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `code_review_file` | Review a source file for issues. |
| `code_review_diff` | Review a diff for issues. |
| `code_review_history` | List past reviews with filters. |
| `code_review_get` | Get a review by id. |
| `code_review_search` | Full-text search reviews. |
| `code_review_stats` | Aggregate review statistics. |

## Commands

`/code-review file <path> | diff | project [path]`, `/code-review fix-all [reviewId]`, `/code-review deep [path]`, `/deep-code-review [path]`

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_CODE_REVIEW_AGENT_FIXES` | `true` | Spawn fixer subagents after a review. |
| `OPENCODE_CODE_REVIEW_LLM_FALLBACK` | `true` | Run a free-LLM pass when the static scan is sparse. |
| `OPENCODE_CODE_REVIEW_LLM_FALLBACK_THRESHOLD` | `5` | Findings below this trigger the LLM fallback. |
| `OPENCODE_CODE_REVIEW_FIX_MODEL` | `""` | Pin the fixer model as providerID/modelID. |
| `OPENCODE_CODE_REVIEW_REVIEW_MODEL` | `""` | Pin the reviewer model as providerID/modelID. |
| `OPENCODE_CODE_REVIEW_MAX_FIX_AGENTS` | `6` | Fixer children allowed to run at once. |
| `OPENCODE_CODE_REVIEW_SPAWN_MODE` | `agent` | agent | direct (plugin spawns the children itself). |
| `OPENCODE_CODE_REVIEW_DIRECT_REVIEW_TIMEOUT_SEC` | `300` | Seconds direct mode waits for its reviewer. |
| `OPENCODE_CODE_REVIEW_DEEP` | `true` | Expose /deep-code-review and /code-review deep. |

## License

MIT © Bandonker
