# @bandonker/opencode-error-journal

Log errors with context, search past ones, and record resolutions so you stop re-debugging the same failure.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-error-journal"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `error_log` | Log an error. |
| `error_resolve` | Record a resolution. |
| `error_search` | Full-text search errors. |
| `error_list` | List recent errors. |
| `error_delete` | Delete an error entry. |

## License

MIT © Bandonker
