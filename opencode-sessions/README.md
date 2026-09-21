# opencode-sessions (v2)

An opencode plugin that lets the current agent **spawn fresh child sessions**, brief
them, wait for them, read their results, send follow-ups, **hand off the current
working point into a new session**, and cancel them — **without
blocking the server event loop**.

Every session created here is a real opencode session, so it appears in the
Desktop session list / tab switcher exactly as if the user had hit `+`.

It registers seven tools on the parent agent (`spawn_session`, `session_result`,
`session_send`, `session_cancel`, `session_permission`, `session_handoff`,
`list_sessions`) and does all completion tracking through the server's event
stream.

- Plugin source: `plugins/opencode-sessions.ts`
- Dev + verification: `opencode-sessions/` (this folder)

## Install

### Global (every project)

Place the plugin as a flat `.ts` file in the global plugins directory:

```
%USERPROFILE%\.config\opencode\plugins\opencode-sessions.ts
```

That is the layout used here. Global local plugins resolve their dependencies from
the config-root `package.json`; opencode runs `bun install` there at startup.
This plugin declares:

```json
{
  "dependencies": {
    "@opencode/plugin": "^2.0.11",
    "zod": "4.1.8"
  }
}
```

`@opencode/plugin` is required (it provides `Plugin.define`). `zod` declares the
tool input schemas.

### Project-local (one repo only)

```
<repo>\.opencode\plugins\opencode-sessions.ts
```

with a `package.json` **next to the plugin** (same directory, i.e.
`<repo>\.opencode\plugins\package.json`) declaring the same two dependencies.
opencode runs `bun install` in that folder at startup.

### Load order

Global config → project config → global plugins dir → project plugins dir. A
project-local copy of this plugin would shadow the global one for that project.

## Tools

All five tools are callable by the parent agent. `sessionId` values are the child
session ids returned by `spawn_session`.

### `spawn_session`

| arg | type | default | meaning |
| --- | --- | --- | --- |
| `prompt` | string (required) | — | The child's first user message (the brief). |
| `title` | string | derived from prompt | Human title; a `[spawned:<shortid>]` prefix is prepended. |
| `agent` | string | inherited | Agent name; validated against `client.app.agents()`. |
| `model` | string `"providerID/modelID"` | inherited | Validated against `client.config.providers()`. |
| `wait` | boolean | `false` | If true, wait for the child to go idle before returning. |
| `timeoutSec` | number | `900` | Wait timeout; clamped to the hard cap. |
| `schema` | object (JSON Schema) | — | Request structured output. |

Behavior:

- Creates a real child session with `parentID` set to the caller's session and a
  title of the form `[spawned:<shortid>] <title>`.
- Starts the turn with `session.promptAsync` (fire-and-forget) and returns
  immediately.
- `wait:false` returns `{ sessionId, status: "running" }` plus a note.
- `wait:true` returns the formatted outcome once the child goes idle.

### `session_result`

`{ sessionId, wait?, timeoutSec? }` — status of a child plus, when idle, its final
assistant text and/or `structured_output`. `wait:true` blocks (non-loop-blocking)
until terminal or timeout.

### `session_send`

`{ sessionId, text, noReply? }` — inject a follow-up turn. With `noReply:true` it
injects context **without** triggering a reply.

### `session_cancel`

`{ sessionId }` — calls `session.abort`, marks the child `cancelled`, resolves any
waiter, and notifies the parent.

### `session_permission`

`{ sessionId, permissionId?, response? }` — answer a permission prompt raised by
a tracked child (`"once"` / `"always"` / `"reject"`, default `"once"`) so it does
not stall. Auto-answered first when `autoApprovePermissions` is set.

### `session_handoff`

`{ brief?, title?, messageLimit?, agent?, model?, directory?, wait?, timeoutSec? }` —
capture a transcript of the current session, spawn a brand-new session briefed
with that context plus the handoff note, and start it. The new session is a real
session, so it shows up in the Desktop session switcher as if opened with `+` —
continue the work there seamlessly.

### `list_sessions`

`{ all? }` — lists children created by this plugin. `all:false` (default) scopes to
the current parent. Combine the in-memory map with `session.children(parentID)`
filtered by the title prefix.

## Config knobs

Plugin `options` (or the matching env var) are read at load time and clamped:

| option | env var | default | notes |
| --- | --- | --- | --- |
| `maxConcurrentSessions` | `OPENCODE_SESSIONS_MAX_CONCURRENT` | `3` | Global cap across all parents. |
| `maxSessionsPerParent` | `OPENCODE_SESSIONS_MAX_PER_PARENT` | `3` | Per-parent cap. |
| `defaultTimeoutSec` | `OPENCODE_SESSIONS_TIMEOUT_SEC` | `900` | Default wait timeout. |
| `hardTimeoutSec` | `OPENCODE_SESSIONS_HARD_TIMEOUT_SEC` | `1800` | Upper bound for any wait. |
| `titlePrefix` | — | `[spawned` | Correlation marker in child titles. |
| `autoInjectParent` | — | `true` | Post a completion note to the parent when no waiter is attached. |
| `maxInjectChars` | — | `4000` | Truncation for injected text. |
| `injectPermissionNotices` | — | `true` | Post a notice when a tracked child is blocked on a permission. |

## Why it doesn't block the event loop (reentrancy)

A plugin runs *inside* the opencode server process. Awaiting a long
`client.session.prompt(...)` inside `tool.execute` would hold that request open and
stall the agent loop. This plugin instead:

1. Starts the child turn with `session.prompt` (returns the inbox entry once
   queued) and returns immediately.
2. Observes completion through `event.subscribe`: `session.idle` /
   `session.execution.succeeded` / `session.execution.failed` /
   `session.execution.interrupted`.
3. Resolves a pending `wait:true` promise from that loop (with a `setTimeout` that
   sets state `timeout` and calls `session.interrupt`).

Result data is read back with `session.context` (the last assistant message).
See "Structured output" below for why that matters.

Correlation is strict: only sessions present in the module-level `Map` are ever
touched or injected into. A child is mapped at creation and keyed by its server id.

## Parent linkage

Children record the caller's session in their `metadata.parentSessionID` (v2
`session.create` accepts no `parentID`) and carry a `[spawned:<shortid>]` title
prefix, so `hydrate` can re-adopt them after a restart via `session.get`. The
in-memory `Map` remains the source of truth for state. Note: the v2 session
domain exposes no server-side child enumeration, so `list_sessions` only shows
sessions tracked in the current process.

## Permissions

If a tracked child hits a permission prompt, the `permission.updated` (a.k.a.
`permission.asked`) event is matched against the tracked map and — when
`injectPermissionNotices` is on — a notice is posted to the parent:

```
[spawned:<id>] child <sessionId> is waiting on a permission prompt: "<title>".
It will stall until answered in that session; call session_cancel("<sessionId>") to abort.
```

The plugin does **not** auto-answer prompts. Aborting is the escape hatch.

## Structured output

`spawn_session` accepts an optional `schema` and appends it as a plain-text
instruction (v2 `session.prompt` has no native `format` field), then parses JSON
out of the child's final message. The result surfaces as `structured_output`.

### Version caveat (important)

- Plugin types are `@opencode/plugin` **2.0.11** (promise API).
- `session.context` is the result read path; completion is observed via
  `event.subscribe` (`session.idle`, `session.execution.*`).

## Known limitations

- The end-to-end harness loads the plugin source directly (Node strips the TS types)
  and drives its tools against a real server. This is complemented by a real loader
  check (see "Verification"): the plugin was dropped into a running opencode server's
  plugins directory, the server logged the load, and all five tools appeared in the
  live tool registry.
- Permission prompts are surfaced, and optionally auto-answered via
  `autoApprovePermissions` (`never` by default).
- `list_sessions` shows children tracked in the current process (the v2 session
  domain has no server-side child enumeration to discover older ones); title-
  marked sessions are re-adopted via `hydrate` when touched directly.
- No persistence: the `Map` is in-memory and cleared on cleanup.
- Concurrency and timeouts are per-process; there is no cross-process budget.

## Verification (v2)

Type-check (only the pre-existing `.ts`-extension notice shared by every local
plugin, which the opencode loader resolves at runtime):

```powershell
npx tsc --noEmit -p opencode-sessions
```

Unit tests (helpers, no server needed):

```powershell
node --test opencode-sessions\unit.test.mjs
```

Observed: 8/8 passing.

Mock-context registration check (no server needed): `setup` against a stub
context registers all seven tools (`spawn_session`, `session_result`,
`session_send`, `session_cancel`, `session_permission`, `session_handoff`,
`list_sessions`) and the returned cleanup runs clean.

Loader check (plugin installed into a running server's plugins dir):

1. `node opencode-sessions\sync.mjs` installs the repo copy to
   `<config>/plugins/opencode-sessions.ts`; (re)start opencode.
2. All seven tools appear in the live tool registry with no
   `failed to load plugin` WARN in the server log.
3. `list_sessions` executes live against the server.

Observed: all seven tools registered live; `list_sessions` returned
"No sessions created by this plugin." against the running server.

Note: the old `e2e.mjs` harness drove the v1 SDK and is not shipped; the checks
above replace it for now.

## References

- opencode plugins: <https://opencode.ai/docs/plugins>
- opencode SDK types: `@opencode/plugin@2.0.11` (local `node_modules`).
- Events used: `session.idle`, `session.execution.succeeded`,
  `session.execution.failed`, `session.execution.interrupted`,
  `permission.asked`.
