# opencode-sessions (v2)

An opencode plugin that lets the current agent **spawn fresh child sessions**, brief
them, wait for them, read their results, send follow-ups, **hand off the current
working point into a new session**, and cancel them — **without
blocking the server event loop**.

Every session created here is a real opencode session, so it appears in the
Desktop session list / tab switcher exactly as if the user had hit `+`.

It registers nine tools on the parent agent (`spawn_session`, `session_result`,
`session_send`, `session_cancel`, `session_permission`, `session_handoff`,
`list_sessions`, `project_sessions`, `session_broadcast`) and does all
completion tracking through the server's event stream. The first seven are
about sessions this plugin spawned; the last two are about *other* sessions
working in the same project.

- Plugin source: `opencode-sessions/opencode-sessions.ts`
- Dev + verification: `opencode-sessions/` (this folder)

## Install

### Global (every project)

Place the plugin as a flat `.ts` file in the global plugins directory:

| Platform | Path |
| --- | --- |
| Linux / BSD | `~/.config/opencode/plugins/opencode-sessions.ts` |
| macOS | `~/Library/Application Support/opencode/plugins/opencode-sessions.ts` |
| Windows | `%USERPROFILE%\.config\opencode\plugins\opencode-sessions.ts` |

(`~` is your home directory. The plugin itself resolves this with
`os.homedir()`, and honors `XDG_CONFIG_HOME` on Linux if you have relocated
your config.)

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
<repo>/.opencode/plugins/opencode-sessions.ts
```

with a `package.json` in the **`.opencode` directory above it** (i.e.
`<repo>/.opencode/package.json`) declaring the same two dependencies:

```bash
cp /path/to/open-toolbox/package.json          .opencode/package.json
cd .opencode && npm install
```

The `.opencode` root is the right place, not `.opencode/plugins/`: a plugin in
`.opencode/plugins/` importing `zod` walks up to `.opencode/node_modules`, so
the dependency resolves from the config root the same way the global layout
does. opencode runs `bun install` in that folder at startup.

### Load order

Global config → project config → global plugins dir → project plugins dir. A
project-local copy of this plugin would shadow the global one for that project.

## Tools

All nine tools are callable by the parent agent. `sessionId` values are the child
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

## Project presence

The seven tools above only know about sessions this plugin spawned. Two windows
open on the same repo, each running its own agent, had no way to learn about each
other — so an agent that found a file it had not touched had nothing to go on
except inventing a reason.

opencode exposes no `session.list()` (`ctx.session` is a `Pick` of `SessionApi`
without `list`, `ctx.app` is only `{name, version, channel}`, `ctx.rpc` is only
`{register}`), so peers are discovered **passively from the event stream**. Every
session event on the server-wide stream carries `data.sessionID` and
`location.directory`, which is enough to group sessions by project with no server
round-trip. Peers are also announced by the session itself on its first turn, so a
brand-new idle session is visible before it does anything.

Presence is mirrored through `ctx.storage`, so a session in a standalone
`opencode` process sees peers from the Desktop app (and vice versa). Each peer
gets **its own key** rather than sharing one array: a single key is
last-writer-wins, so two processes would overwrite each other's view of who
exists. The registry is re-read on a heartbeat, not once at startup, so a session
opened after this process started still turns up.

### `project_sessions`

`{ task?, forget? }` — lists other sessions in this session's project directory,
with each peer's state (`running`/`idle`), how long since it was last active, any
task it declared, and any files it is currently editing. Passing `task` declares
what *this* session is working on; it is also the claim path for a session that
only ever uses tools.

`forget` takes session ids (comma-separated) and drops them from the registry, so a
session you closed or deleted stops being listed **and** stops being a message
target. The plugin also does this by itself on `session.deleted`; `forget` is for
the cases the event stream cannot see — a session deleted before the plugin
loaded, or one ghosted in from another process.

A peer that has gone quiet is **verified, not assumed**. `session.get` is used to
ask the server whether it still exists, which distinguishes the two cases a timer
cannot: a session mid-way through one long command (alive, and worth messaging)
versus one that was deleted or crashed (gone). Confirmed-gone peers are dropped
from the registry on the spot, so asking a question about the list heals it.
`session.deleted` does the same for the common case, and `forget` covers what the
event stream cannot see. Verdict wording is deliberate: `alive, idle` is a fact,
not a guess.

### `session_broadcast`

`{ text, noReply? }` — sends one message to every **reachable** session in
the project. Use before a wide-reaching change so peers do not duplicate or fight
the work. Prefer `session_send` when you mean one specific session. Peers
confirmed gone are dropped and named in the result; peers confirmed alive but
idle are messaged and named as woken.

### `session_send` on peers

`session_send` now accepts any session in the project, not just spawned
children: `ctx.session.synthetic` and `ctx.session.prompt` address any session, so
the old refusal was a plugin-level restriction rather than a platform one.
Spawned children still route through `startTurn` so a failed send is reported. An
id that is neither a spawned child nor a known peer is still refused, and so is a
stale peer (see above).

### Concurrent-edit awareness

Every session in a project can be editing at once, and two agents writing the same
file produce a diff that belongs to neither. The plugin records which file each
session is writing from the `tool.execute.before` seam — server-wide, so a write by
a spawned child counts just as much as one by a hand-opened session — and the
awareness brief then says so:

```
[1 relevant session in this project]
- ses_aaaaaa | idle | 40s ago | refactoring auth | editing src/auth.ts
CONCURRENT EDIT: you and ses_aaaaaa both hold src/auth.ts. Only one of you should write it — wait for them to release it, or session_send to agree who takes it.
```

A claim is an observation, not a lease — it expires after `claimStaleSec` and is
released the moment the session goes idle — so a session that dies mid-edit cannot
block its peers forever. Paths are compared project-relative and case-folded where
the filesystem requires it, so `src/auth.ts` and `./src/auth.ts` collide, and so do
`README.md` and `readme.md` on macOS and Windows.

#### Making the wait real

The brief above depends on the model obeying it, and a model that has already
decided to edit will edit. `fileLocks: "enforce"` removes that dependency: the
plugin wraps the host's own file-mutating tools (`edit`, `write`, `patch`, …) and,
on a collision, the write **waits** for the other write to finish.

Two different questions need two different records, which is why the wait is short
by construction:

| record | question | used for |
| --- | --- | --- |
| `Peer.claims` | did this session write this file *during its current turn*? | the awareness brief |
| in-flight | is a write to this file happening *right now*? | the lock |

Keying the lock to the turn-scoped record instead would block a writer for the
whole remainder of the other session's turn — and a turn continues well past the
edit, into tests and output — so the waiter would routinely time out against a
session that was no longer touching the file. The lock is keyed to the real tool
lifecycle instead: marked in flight before the call, cleared in a `finally` so
even a failed write cannot keep a file locked.

The wait is still bounded by `lockWaitSec`, but that budget now only covers a
write that *itself* never returns — a wedged tool call. On expiry the call
**fails loudly**, naming the holder and the file: `Gave up waiting 60s for
another session to finish writing src/auth.ts. Still being written by ses_aaaaaa.
Do not edit it anyway: either wait and retry, or session_send that session to
agree who takes this file.` The wait is cancellable, so an interrupted turn leaves
no timer running.

`advise` (the default) only tracks and briefs; `off` tracks nothing. The gate is
installed on the pre-existing tool set, never on this plugin's own tools.

#### Across processes

`ctx.storage` is shared by every opencode process on the same config directory,
so an in-flight write is also published there — one key per session, found via
`storage.scan`, so two processes writing different files cannot clobber each
other's marker. A standalone `opencode` run alongside the Desktop app is
therefore covered too.

Be clear about what this is: a **best-effort signal, not a distributed lock.**
The store offers no compare-and-set, so a lost update is corrected by the
holder's next publish, and a process that dies mid-write leaves a marker that
only expires. It fails *open* — a missed marker means no wait, never a wait on a
lie — and `inflightTtlSec` bounds how long a crash can hold a file.

#### When a write cannot proceed

A write covering **more than one file** can deadlock: `a` holds `f1` and wants
`f2`, `b` holds `f2` and wants `f1`. Waiting cannot break that, because a write
covers all its paths in one call and there is no compare-and-set to acquire them
one at a time. A single-file write can never invert.

So it is not papered over with a generic timeout. A blocked write publishes what
it is trying to acquire, and on timeout checks whether the peer holding it is
itself waiting on something this write holds. If so the failure says so:

> `Deadlock: you and ses_wrb_ are each holding a file the other is trying to write (src/f1.ts, src/f2.ts), so neither can proceed. Do not retry the same set. Either write one file at a time, or session_send to agree which of you takes which file.`

An intent is dropped as soon as the write gets what it wanted, and left to expire
only when it did not — two sessions in a cycle time out milliseconds apart, and
the first to report would otherwise erase the evidence the second needs.

### Ambient awareness

Beyond the tools, the plugin injects a short notice into each request — but only
about the peers that bear on *this* session, never a roster of the whole project. A
peer is surfaced when it holds a file this session is writing, is in this session's
lineage (its parent, its children, its siblings), is mid-turn right now, or declared
a task sharing a content word with this session's. Everything else is counted in
one line and left out:

```
[2 of 5 relevant sessions in this project; 1 unrelated]
- ses_aaaaaa | running | 40s ago | refactoring auth
- ses_bbbbbb | idle | 6m ago | auth module cleanup (related task)
Changes here may be theirs, not yours. project_sessions for the full list, session_send to coordinate, session_broadcast to warn everyone.
```

When nothing is relevant, nothing is injected at all. When the brief has not
changed, the previous copy is left where it is rather than re-appended, so a stable
roster costs no tokens and does not churn the cached prompt prefix.

It hooks `context` (so it survives compaction), strips its own previous injection
by sentinel, and is **removed** when its peers are gone rather than going stale.
Set `peerAwareness: false` to keep the tools but drop the injection.

> Task matching is deliberately conservative. `taskTokens` drops a stopword list
> that includes the everyday verbs agents put in a task string ("updating",
> "fixing"), so a shared verb is not mistaken for shared work. A false positive
> costs one line of context; a false negative costs a clobbered edit.

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
| `peerAwareness` | `OPENCODE_SESSIONS_PEER_AWARENESS` | `true` | Inject the peer notice into requests. Tools still work when off. |
| `peerStaleSec` | `OPENCODE_SESSIONS_PEER_STALE_SEC` | `900` | Drop peers unheard from for this long. |
| `maxPeers` | `OPENCODE_SESSIONS_MAX_PEERS` | `4` | Cap peers in the injected notice. The rest are counted, not listed. |
| `peerTaskChars` | `OPENCODE_SESSIONS_PEER_TASK_CHARS` | `120` | Truncation for a declared task. |
| `peerHeartbeatSec` | `OPENCODE_SESSIONS_PEER_HEARTBEAT_SEC` | `60` | How often a session refreshes its presence. |
| `maxClaimedPeers` | `OPENCODE_SESSIONS_MAX_CLAIMED_PEERS` | `2000` | Bound on the registry. |
| `fileLocks` | `OPENCODE_SESSIONS_FILE_LOCKS` | `advise` | `advise` records writes and briefs collisions; `enforce` also makes a colliding write wait; `off` tracks nothing. |
| `lockWaitSec` | `OPENCODE_SESSIONS_LOCK_WAIT_SEC` | `60` | Cap on how long an enforced write waits for another write *in progress* to finish. Only a wedged tool call reaches this. |
| `inflightTtlSec` | `OPENCODE_SESSIONS_INFLIGHT_TTL_SEC` | `3` | How long another opencode process's in-flight marker is honoured. Only reached if that process dies mid-write. |
| `claimStaleSec` | `OPENCODE_SESSIONS_CLAIM_STALE_SEC` | `600` | A file claim older than this is treated as released. |
| `maxClaimPathsInNotice` | `OPENCODE_SESSIONS_MAX_CLAIM_PATHS` | `3` | Files named per peer in the brief before summarising the rest. |
| `peerLiveSec` | `OPENCODE_SESSIONS_PEER_LIVE_SEC` | `90` | Below this a peer is "quiet" and gets verified with `session.get` before anything is sent. |

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

```bash
npx tsc --noEmit -p opencode-sessions
```

Unit tests (helpers, no server needed):

```bash
node --test opencode-sessions/unit.test.mjs
```

Observed: 8/8 passing.

Mock-context registration check (no server needed): `setup` against a stub
context registers all seven tools (`spawn_session`, `session_result`,
`session_send`, `session_cancel`, `session_permission`, `session_handoff`,
`list_sessions`) and the returned cleanup runs clean.

Loader check (plugin installed into a running server's plugins dir):

1. Copy `opencode-sessions/opencode-sessions.ts` into your global or project
   plugins dir (and keep `helpers.ts` beside it, outside the plugins dir so the
   loader never treats it as a plugin), then (re)start opencode.
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
