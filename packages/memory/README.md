# @bandonker/opencode-memory

Local-first long-term memory: store and BM25-recall fragments with SQLite FTS5. No embedding API, no cloud. Auto-injects relevant memories into each request within a hard character budget.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-memory"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `memory_remember` | Store a memory (deduped by normalized content). |
| `memory_recall` | BM25 full-text search over memories. |
| `memory_forget` | Delete a memory by id or query. |
| `memory_list` | List recent memories. |
| `memory_stats` | Totals by scope, DB path and config. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_MEMORY_ENABLED` | `true` | Turn the plugin off without uninstalling |
| `OPENCODE_MEMORY_AUTO_RECALL` | `true` | Inject relevant memories into each request |
| `OPENCODE_MEMORY_BUDGET_CHARS` | `1200` | Hard character budget per injection |
| `OPENCODE_MEMORY_TOP_K` | `5` | Max memories per recall/injection |
| `OPENCODE_MEMORY_MIN_SCORE` | `0` | Minimum BM25 score (0 = any hit) |
| `OPENCODE_MEMORY_SCOPE` | `project` | global | project | session |
| `OPENCODE_MEMORY_MAX_ENTRIES` | `0` | Prune beyond this many rows (0 = unlimited) |
| `OPENCODE_MEMORY_LOG` | `false` | Log activity to stderr |

## License

MIT © Bandonker
