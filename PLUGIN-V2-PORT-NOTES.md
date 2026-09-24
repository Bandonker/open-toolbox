# opencode local plugins — V1 → V2 port notes

Ported 2026-09-21 for opencode v2 (`@opencode/plugin@2.0.11`).

## Why

v2 rejects every V1 plugin with
`PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function`. V1 `export const X: Plugin = async (ctx) => ({...})`
does not run at all in v2.

## V1 → V2 mapping actually used

| V1 | V2 |
| --- | --- |
| `import { type Plugin, tool } from "@opencode-ai/plugin"` | `import { Plugin } from "@opencode/plugin"` |
| `export const X: Plugin = async (ctx) => ({...})` | `export default Plugin.define({ id: "x", async setup(ctx) { ... } })` |
| `return { tool: { name: tool({ args, execute }) } }` | `await ctx.tool.transform((editor) => editor.add({ name, description, input, execute }))` |
| `tool.schema.*` (zod re-export) | `import { z } from "zod"` |
| `execute(args, ctx)` -> returns `string` | `execute(input, toolCtx)` -> returns `{ content: string }` |
| `ctx.sessionID` (tool ctx) | `toolCtx.sessionID` |
| `ctx.directory` (tool ctx) | `toolCtx.directory` (fallback: `ctx.location.directory`) |
| `"experimental.chat.system.transform"` hook | `ctx.session.hook("context", (event) => { ... mutate event.system[i].text ... })` |
| `output.system: string[]` | `event.system: SystemPart[]` where each part is `{ type: "text", text, cache?, metadata? }` |
| `event` hook returning handler | `ctx.event.subscribe({ signal })` async iterator |
| `dispose: async () => {}` | return a cleanup fn from `setup(ctx)` |
| `client.app.log({ body })` | no v2 equivalent on `ctx.app` (only `name`/`version`/`channel`) — use console/rpc |
| `client.app.agents()` | `ctx.agent.list()` (AgentDomain extends AgentApi) |
| `client.config.providers()` | `ctx.provider.list()` / `ctx.provider.transform` |
| `client.postSessionIdPermissionsPermissionId` | `ctx.permission.reply(...)` |

## Shared helper: `lib/sqlite.ts`

Lives **outside** `plugins/` on purpose — every export of a file in `plugins/` is
treated as a plugin factory by the loader.

Provides:
- `openDatabase(path)` — uses `bun:sqlite` when available, else `node:sqlite`
  wrapped in a small shim so both expose `exec` / `query` / `prepare` / `close`
  and `.get` / `.all` / `.run`. The shim translates `BEGIN TRANSACTION` -> `BEGIN`
  (node:sqlite rejects the former) and derives `lastInsertRowid` after writes.
- `applyPragmas(db)`, `maybeBackupDb(opts)`, `listBackups(dir)`, `latestBackup(dir)`
- `isCorruption(err)`, `quoteFtsQuery(query)`

Note: the node shim deliberately does **not** swallow statement errors — an earlier
version caught in `.get()` and returned `null`, which made failures look like
"not indexed" instead of surfacing.

## Ported and verified (6 of 6)

| plugin | id | tools | state |
| --- | --- | --- | --- |
| strip-skills-catalog.ts | `strip-skills-catalog` | – (1 session hook) | ported |
| snippet-library.ts | `snippet-library` | 5 | ported |
| error-journal.ts | `error-journal` | 5 | ported |
| decision-log.ts | `decision-log` | 5 | ported |
| codebase-index.ts | `codebase-index` | 4 | ported |
| opencode-sessions.ts | `opencode-sessions` | 7 | ported |

Verification: each module imports cleanly into node, exposes exactly one `default`
with an `id`, and a mock-context smoke test exercises every tool end to end
(incl. FTS5 search and the sqlite shim) — 12/12 passing. opencode-sessions
additionally registers all 7 tools against a mock context and its `list_sessions`
tool executes live against the running server.

## opencode-sessions v2 deltas (vs the V1 design above)

- No `format` field on the v2 `session.prompt` input, so there is no native
  `json_schema` path: `schema` is appended as a plain-text instruction and the
  result is parsed out of the final message. `retryWithoutFormat` is gone.
- The v2 session domain has no `children()` / `status()` / `abort()`:
  `list_sessions` is tracked-map-only (+ `hydrate` via `session.get`),
  liveness comes from `event.subscribe`, cancel/timeout use
  `session.interrupt`.
- Parent completion notes and `session_send(noReply:true)` use
  `session.synthetic` so they never trigger a reply turn.
- Results are read with `session.context` (no per-part event capture map).
- Every created session is a real opencode session, so spawned and handoff
  sessions appear in the Desktop session switcher as if opened with `+`.
  Parent linkage is kept in session `metadata.parentSessionID` plus the title
  prefix (v2 `session.create` accepts no `parentID`).
