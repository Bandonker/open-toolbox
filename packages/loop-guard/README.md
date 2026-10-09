# @bandonker/opencode-loop-guard

Always-on doom-loop breaker: when a session repeats the same tool call or the same assistant reply consecutively, the model is nudged to change approach and, if it keeps repeating, the turn is cancelled.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-loop-guard"]
}
```

Then restart opencode.

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_LOOP_GUARD_ENABLED` | `true` | Turn the guard off without uninstalling |
| `OPENCODE_LOOP_GUARD_REPEAT_LIMIT` | `4` | Consecutive identical calls/replies before nudging the model |
| `OPENCODE_LOOP_GUARD_CANCEL_LIMIT` | `8` | Consecutive identical calls/replies before cancelling the turn |
| `OPENCODE_LOOP_GUARD_NOTIFY` | `true` | Post a note into the session when the guard acts |
| `OPENCODE_LOOP_GUARD_LOG` | `false` | Log guard activity to stderr |

## License

MIT © Bandonker
