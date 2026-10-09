# @bandonker/opencode-tool-audit

Flight recorder for every tool call: tool, args, status, duration and error land in a local SQLite DB, with secrets redacted before they touch disk.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-tool-audit"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `trace_query` | Query recorded tool calls. |
| `trace_stats` | Summarise recorded calls. |
| `trace_export` | Export calls as JSONL or Markdown. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_TOOL_AUDIT_DIR` | `~/.opencode-plugins/tool-audit` | Where the DB lives |
| `OPENCODE_TOOL_AUDIT_ENABLED` | `true` | Turn recording off |
| `OPENCODE_TOOL_AUDIT_REDACT` | `true` | Scrub secrets from arguments |
| `OPENCODE_TOOL_AUDIT_MAX_INPUT_CHARS` | `2000` | Per-call argument cap |
| `OPENCODE_TOOL_AUDIT_RETENTION_DAYS` | `30` | Prune rows older than this (0 = keep) |
| `OPENCODE_TOOL_AUDIT_IGNORE` | `todowrite` | Comma-separated tools to skip |

## License

MIT © Bandonker
