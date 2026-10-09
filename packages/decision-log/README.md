# @bandonker/opencode-decision-log

Record and search architectural decisions in a local SQLite FTS5 database.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-decision-log"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `decision_log` | Record a decision. |
| `decision_get` | Get a decision by id. |
| `decision_search` | Full-text search decisions. |
| `decision_list` | List decisions with filters. |
| `decision_update` | Update or supersede a decision. |

## License

MIT © Bandonker
