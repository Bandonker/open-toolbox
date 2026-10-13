# @bandonker/opencode-plan

Register a /plan command that guides the agent through a thorough planning phase: research the task, ask clarifying questions, present a detailed plan, then execute it by spawning child sessions (free models first, paid as fallback).

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-plan"]
}
```

Then restart opencode.

## Commands

`/plan`

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_PLAN_ENABLED` | `true` | Turn the plugin off without uninstalling. |
| `OPENCODE_PLAN_MAX_PARALLEL_CHILDREN` | `3` | Child sessions allowed to run at once (1-10). |
| `OPENCODE_PLAN_NOTIFY` | `true` | Post plan notifications into the session. |
| `OPENCODE_PLAN_LOG` | `false` | Log plan activity to stderr. |

## License

MIT © Bandonker
