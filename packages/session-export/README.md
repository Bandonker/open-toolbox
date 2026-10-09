# @bandonker/opencode-session-export

Export a session transcript to markdown, json, jsonl or text with reasoning/tool filtering, secret redaction, home-path rewriting and non-overwriting filenames.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-session-export"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `session_export` | Export the current session transcript to a file or inline. |
| `session_export_info` | Show config, default export dir and the last export. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_SESSION_EXPORT_ENABLED` | `true` | Turn exporting off without uninstalling |
| `OPENCODE_SESSION_EXPORT_DIR` | `<cwd>/.opencode-exports` | Default output directory |
| `OPENCODE_SESSION_EXPORT_FORMAT` | `markdown` | markdown | json | jsonl | text |
| `OPENCODE_SESSION_EXPORT_INCLUDE_REASONING` | `false` | Include assistant reasoning parts |
| `OPENCODE_SESSION_EXPORT_INCLUDE_TOOL_RESULTS` | `true` | Include tool results and errors |
| `OPENCODE_SESSION_EXPORT_MAX_PART_CHARS` | `4000` | Truncate each part to this many chars |
| `OPENCODE_SESSION_EXPORT_REDACT` | `true` | Scrub secrets and rewrite home paths to ~ |

## License

MIT © Bandonker
