# @bandonker/opencode-deep-research

Autonomous multi-agent research. Fans a topic out across a taxonomy of research angles as parallel child sessions, iterates on the gaps those agents report, then hands the deduplicated, conflict-flagged findings back for a written report.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-deep-research"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `d` | e |
| `d` | e |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_DEEP_RESEARCH_ENABLED` | `true` | Turn deep research off without uninstalling |
| `OPENCODE_DEEP_RESEARCH_DIR` | `~/.opencode-plugins/deep-research` | Where the SQLite history and markdown reports are written |
| `OPENCODE_DEEP_RESEARCH_CONCURRENCY` | `4` | Maximum research agents running at once |

## License

MIT © Bandonker
