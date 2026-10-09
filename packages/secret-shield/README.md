# @bandonker/opencode-secret-shield

v2-native secret detector/redactor: scrubs the outbound HTTP body (title/compaction/generate), prompt, tool args/results and child-process env; observe/redact/block modes with entropy detection, allowlist precedence and a hashed JSONL audit.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-secret-shield"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `secret_shield_scan` | Scan a string for secrets (ids/offsets, no values). |
| `secret_shield_stats` | Mode, rule count, audit path and finding totals. |
| `secret_shield_shape` | Safe shape of a secret file (names/lengths/fingerprint). |
| `secret_shield_keys` | List key names in a secret file. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_SECRET_SHIELD_ENABLED` | `true` | Turn the shield off without uninstalling |
| `OPENCODE_SECRET_SHIELD_MODE` | `observe` | observe | redact | block |
| `OPENCODE_SECRET_SHIELD_ENTROPY` | `true` | Shannon-entropy fallback for unlabelled tokens |
| `OPENCODE_SECRET_SHIELD_ALLOW` | `(none)` | Comma-separated literals, /regex/, globs or rule ids |
| `OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS` | `true` | Block-mode deny of protected secret files |
| `OPENCODE_SECRET_SHIELD_LOG` | `false` | Emit diagnostics to stderr |

## License

MIT © Bandonker
