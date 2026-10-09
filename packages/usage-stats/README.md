# @bandonker/opencode-usage-stats

Lifetime token / dollar / tool accounting in local SQLite with a self-contained HTML dashboard and Unicode heatmaps.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-usage-stats"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `stats_summary` | Lifetime and today tokens/cost/tools. |
| `stats_tools` | Per-tool calls, outcomes and durations. |
| `stats_tokens` | Per-day and per-model token/cost breakdown. |
| `stats_heatmap` | Unicode contribution heatmap. |
| `stats_dashboard` | Write the HTML dashboard and return its path. |

## Commands

`/stats`

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_USAGE_STATS_DIR` | `~/.opencode-plugins/usage-stats` | Where the DB and dashboard live |
| `OPENCODE_USAGE_STATS_ENABLED` | `true` | Turn recording off |
| `OPENCODE_USAGE_STATS_RETENTION_DAYS` | `0` | Prune daily rollups older than this (0 = keep) |
| `OPENCODE_USAGE_STATS_HEATMAP_METRIC` | `tokens` | Heatmap metric: tokens|cost|calls |
| `OPENCODE_USAGE_STATS_HEATMAP_WEEKS` | `26` | Heatmap width in weeks |
| `OPENCODE_USAGE_STATS_INCLUDE_BACKGROUND` | `true` | Include title/compaction spend in charts |
| `OPENCODE_USAGE_STATS_LOG` | `false` | Log plugin activity to stderr |

## License

MIT © Bandonker
