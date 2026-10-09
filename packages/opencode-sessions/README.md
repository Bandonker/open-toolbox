# @bandonker/opencode-sessions

Spawn, brief, await, read, follow up on, hand off to and cancel fresh child sessions without blocking the server event loop. Adds targeted project presence: a brief about only the sessions that bear on yours, and an enforced file lock so two agents take turns on one file.

Part of [open-toolbox](https://github.com/Bandonker/open-toolbox) — a pack of
local plugins for opencode Desktop v2. One plugin per package.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["@bandonker/opencode-sessions"]
}
```

Then restart opencode.

## Tools

| Tool | Does |
| :-- | :-- |
| `spawn_session` | Spawn a fresh child session and brief it. |
| `session_result` | Read a child's status and result (optionally wait). |
| `session_send` | Send a follow-up to a child session, or to any session in this project. |
| `session_cancel` | Abort a child session. |
| `session_permission` | Answer a child's permission prompt. |
| `session_handoff` | Hand the current working point to a new session. |
| `list_sessions` | List sessions created by this plugin. |
| `project_sessions` | List the other sessions in this project; declare your task; forget a closed one. |
| `session_broadcast` | Send one message to every reachable session in this project. |

## Configuration

Options are read from the plugin `options` object (npm installs) or the env
var (always works). Values are read at load time.

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `OPENCODE_SESSIONS_MAX_CONCURRENT` | `3` | Max active child sessions |
| `OPENCODE_SESSIONS_MAX_PER_PARENT` | `3` | Max active children per parent |
| `OPENCODE_SESSIONS_TIMEOUT_SEC` | `900` | Default wait timeout (s) |
| `OPENCODE_SESSIONS_HARD_TIMEOUT_SEC` | `1800` | Hard timeout cap (s) |
| `OPENCODE_SESSIONS_AUTO_APPROVE` | `never` | never | once | always |
| `OPENCODE_SESSIONS_MAX_TRACKED` | `200` | Tracked-session cap |
| `OPENCODE_SESSIONS_PEER_AWARENESS` | `true` | Inject the targeted peer brief into each request |
| `OPENCODE_SESSIONS_PEER_STALE_SEC` | `900` | Drop a peer unheard from for this long |
| `OPENCODE_SESSIONS_PEER_LIVE_SEC` | `90` | Reachability window; older peers are verified via session.get |
| `OPENCODE_SESSIONS_MAX_PEERS` | `4` | Cap peers named in the brief (the rest are counted) |
| `OPENCODE_SESSIONS_FILE_LOCKS` | `advise` | advise | enforce | off — enforce makes a colliding write wait |
| `OPENCODE_SESSIONS_LOCK_WAIT_SEC` | `60` | How long an enforced write waits for an in-progress write |
| `OPENCODE_SESSIONS_INFLIGHT_TTL_SEC` | `3` | How long another process's in-flight marker is honoured |
| `OPENCODE_SESSIONS_CLAIM_STALE_SEC` | `600` | A file claim older than this counts as released |

## License

MIT © Bandonker
