# @bandonker/opencode-goal

Set an objective for a session and keep working until it is reached: the goal is re-injected into every request, the model auto-continues when a turn ends, and the loop stops only on goal_complete/goal_blocked, a user interrupt, a stall, or the iteration/time budget.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-goal"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `goal_complete` | Declare the goal done, with evidence. |
| `goal_blocked` | Declare the goal cannot proceed without the user. |
| `goal_progress` | Record a milestone while working toward the goal. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_GOAL_ENABLED` | `true` | Turn the goal loop off without uninstalling |
| `OPENCODE_GOAL_MAX_ITERATIONS` | `30` | Max continuation turns per goal |
| `OPENCODE_GOAL_MAX_MINUTES` | `180` | Wall-clock budget per goal (minutes) |
| `OPENCODE_GOAL_STALL_LIMIT` | `3` | No-tool, unchanged turns before stopping as stalled |
| `OPENCODE_GOAL_MAX_FAILURES` | `3` | Consecutive execution errors before stopping |
| `OPENCODE_GOAL_REQUIRE_EVIDENCE` | `true` | Require evidence in goal_complete |
| `OPENCODE_GOAL_MAX_INJECT_CHARS` | `1600` | Character cap on the injected goal reminder |
| `OPENCODE_GOAL_NOTIFY` | `true` | Post loop start/stop notes into the session |
| `OPENCODE_GOAL_LOG` | `false` | Log loop activity to stderr |

## License

MIT © Bandonker
