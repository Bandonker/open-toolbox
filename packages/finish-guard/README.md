# @bandonker/opencode-finish-guard

Normalises OpenAI-compatible SSE streams so a content or reasoning delta that arrives after the finish reason cannot kill a session ("OpenAI Chat received content after the finish reason"). A stream the gateway cuts mid-generation is left unterminated — never disguised as a clean stop — so it stays visible, counted, and re-attemptable.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-finish-guard"]
}
```

Then restart opencode.

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_FINISH_GUARD_ENABLED` | `true` | Turn stream normalisation off without uninstalling |
| `OPENCODE_FINISH_GUARD_LOG` | `false` | Log each normalised stream to stderr |
| `OPENCODE_FINISH_GUARD_RETRY` | `true` | Retry a turn whose provider stream was malformed |
| `OPENCODE_FINISH_GUARD_RETRY_MAX` | `3` | Maximum retry attempts before the turn is allowed to fail |
| `OPENCODE_FINISH_GUARD_RETRY_DELAY_BASE` | `300` | Initial retry delay in milliseconds |
| `OPENCODE_FINISH_GUARD_RETRY_DELAY_MAX` | `2000` | Maximum retry delay in milliseconds |
| `OPENCODE_FINISH_GUARD_CAPTURE` | `/tmp/opencode/finish-guard-toolcalls.jsonl` | Where truncated or undecodable provider streams are dumped for diagnosis |

## License

MIT © Bandonker
