# @bandonker/opencode-deep-research

Autonomous multi-agent research. Fans a topic out across a taxonomy of research angles as parallel child sessions, iterates on the gaps those agents report, then hands the deduplicated, conflict-flagged findings back for a written report.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-deep-research"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `deep_research` | Run autonomous multi-agent research on a topic: parallel child sessions, gap iteration, consolidated report. |
| `deep_research_deliberate` | Ask a follow-up question about a topic; it is recorded in the topic folder and answered by the research agents. |
| `deep_research_answer` | Record the answer to a deep_research_deliberate question. |
| `deep_research_consolidate` | Merge a topic's findings and its deliberation Q&A into one deduplicated, conflict-flagged report.md. |
| `deep_research_write_report` | Write the consolidated report.md for a research topic. |
| `deep_research_runs` | List recent runs, newest first, with status and report paths. |

## Commands

`/deep-research`

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_DEEP_RESEARCH_ENABLED` | `true` | Turn deep research off without uninstalling |
| `OPENCODE_DEEP_RESEARCH_DIR` | `~/.opencode-plugins/deep-research` | Where the SQLite history and markdown reports are written |
| `OPENCODE_DEEP_RESEARCH_CONCURRENCY` | `4` | Maximum research agents running at once |
| `OPENCODE_DEEP_RESEARCH_MODEL` | `(none)` | Pin the research agents to a provider/modelID |

## License

MIT © Bandonker
