# @bandonker/opencode-strip-skills-catalog

Strips the <available_skills> catalog from the system prompt to save tokens; the skill tool still works on demand.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-strip-skills-catalog"]
}
```

Then restart opencode.

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_STRIP_SKILLS_LOG` | `(unset)` | Log stripped byte counts to stderr |

## License

MIT © Bandonker
