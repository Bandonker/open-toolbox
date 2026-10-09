# @bandonker/opencode-codebase-index

Index a codebase and run BM25-ranked full-text search over it with SQLite FTS5.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-codebase-index"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `codebase_index` | Index a directory. |
| `codebase_search` | Search indexed code. |
| `codebase_index_status` | Show index statistics. |
| `codebase_delete_index` | Delete a project's index. |

## License

MIT © Bandonker
