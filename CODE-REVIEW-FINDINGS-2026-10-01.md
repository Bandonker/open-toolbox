# Code Review Findings — open-toolbox

> Generated: 2026-10-01
> **Status: ALL 125 FINDINGS FIXED.** Fix pass ran 2026-10-01 across 8 parallel agents with strict per-file ownership; every ID below now has a landed fix and a regression test. `npm run typecheck` clean, `npm test` green.
> Method: Full read-only deep review of all source (`opencode-sessions/`, `plugins/`, `lib/`, `scripts/`), 8 parallel review passes, ~37k LOC. High-severity items independently spot-verified in the current tree. Several subagent findings were empirically confirmed by running the real code/SQL in temp fixtures ("verified by execution").
> Scope note: `packages/` is generated build output (`scripts/build-packages.mjs`) and was reviewed only for build bugs, not as source.
> This document supplements `CODE-REVIEW-FINDINGS.md` (2026-09-28). Items there marked [FIXED] were re-verified against current code; the ones that came back broken are flagged **[REGRESSION]** or **[INCOMPLETE FIX]** below.

---

## Summary

| Severity | Count |
|----------|-------|
| High | 15 |
| Medium | 50 |
| Low | 60 |
| **Total** | **125** |

ID prefixes by area: `OS` opencode-sessions · `CP` context-pruner · `PL` plan · `CR` code-review · `US` usage-stats · `TA` tool-audit · `SL` snippet-library · `MEM`/`GO`/`DL`/`EJ`/`FG` memory/goal/decision-log/error-journal/finish-guard · `SS` secret-shield · `SE` session-export · `CI` codebase-index · `CMD` command-pack · `SK` strip-skills-catalog · `LIB` shared libs / build script.

### Regressions & dead features from the 2026-09-28 review (most urgent class)

- **GO-2** — the H1 fix (`status === "active"` guard in `resume`) broke the documented recovery path after "user took over". Confirmed.
- **GO-5** — the H2 fix (early-return on empty turn id) re-broke G1 failure accounting; the G12 dedupe block is now dead code.
- **SS-1** — E331 false-positive/baseline feature is entirely inert (`baselineHashes` never read by any detection path).
- **CR-2** — the `code_review_custom_rules` tool writes rows nothing ever reads; custom rules never run.
- **TA-1** — `trace_timeline` (E48, marked [DONE]) queries a column that does not exist; it can never succeed.
- **SL-2** — `snippet_import` de-dup promise (E55, [DONE]) is false; every re-import duplicates the library.
- **CP-5 / CP-6** — E40 `customStrategies` (variable shadowing) and E38 `budgetSchedule` (arg never passed) do nothing despite [DONE].
- **CP-3** — C12 wrong-session fallback still present in the `compress` tool (fixed everywhere else).
- **SE-1** — L101 exclusive-create fix: `writeFileSyncExclusive` exists but no call site uses it; TOCTOU stands.
- **SE-2/3/4** — E338 CSV export unreachable; E337 HTML fence rendering broken; L104 home-path scrub misses `cwd=/…`-style occurrences.
- **TA-4** — L52/L53 id-less-event fix moved the collision into the DB (`"(no-id)"` + unique index ⇒ all-but-first dropped).
- **OS-13 / OS-14** — L65 (cleanup "flush" re-arms a 2 s timer) and L64 (`waited` flag dead) incompletely fixed.
- **SS-7 (M68)** — gap-counter unit mismatch still present as flagged.

---

## High Severity (15)

### OS-1 · `opencode-sessions/opencode-sessions.ts:2251-2277` — Stuck-session sweeper force-retires healthy long-running children
`lastActivityAt` is only refreshed on state transitions and `session_result` polls, never by the event pump's per-turn activity. A child legitimately working one turn longer than `hardTimeoutSec` (default 900 s) trips `stuckDuration` or the `2×hardTimeout` lifetime cap; the sweeper marks it `timeout`, settles waiters, and `tracked.delete`s the record — **without** `ctx.session.interrupt` (contrast the proper timeout path at 2515-2519). The child keeps burning tokens; when it later goes idle the pump has no record, so the result is never fetched or injected; and each sweep feeds `stuckSessionTimestamps` → 5 of them open the global circuit breaker and block `spawn_session` for 5 minutes.
**Fix:** refresh `lastActivityAt` from any pump event for tracked sessions; interrupt before retiring (or notify without deleting); don't count lifetime-only sweeps toward the breaker. *Confirmed.*

### OS-2 · `opencode-sessions/opencode-sessions.ts:2899-2919 vs 2978` — Spawn concurrency limits are a TOCTOU no-op
`launch()` awaits `fs.stat`/`resolveTarget`/`session.create` between checking `activeCount()`/`activeForParent()` and `tracked.set(childID, …)`. `spawn_many` (up to 20 via `Promise.all`) and parallel `spawn_session` calls all read the pre-spawn count, so `maxConcurrentSessions`/`maxSessionsPerParent` (defaults 3/3) never fire — `spawn_many` starts 20 children. This silently defeats the plugin's own runaway/cost protection.
**Fix:** reserve a slot synchronously at function entry (placeholder `starting` entry or in-flight counter), decrement on failure. *Confirmed.*

### OS-3 · `opencode-sessions/opencode-sessions.ts:2305-2330` — `postToParent` throttle permanently discards completion notes
The 5 s per-parent throttle in `postToParent` returns early when two children of the same parent finish within the window; the skipped note is never queued or retried (`t.injected` is written but never read). In the advertised `spawn_many`/parallel `wait:false` flow — where the tool response promises "Its result will be injected into this session when it goes idle" — only one child's completion is ever injected. Permission notices (3198) share the bucket and can also swallow a completion.
**Fix:** queue skipped notes per parent and flush on a timer, or coalesce finished children into one note. *Confirmed.*

### CP-1 · `plugins/context-pruner.ts:1073-1081` — `protectedFromIndex` returns `-1` for short sessions, disabling the live-turn guard (violates invariant C2)
`if (userIdxs.length <= turns) return -1;` ⇒ any session with **one user message** (every subagent/forked session, the first turn of every session) gets `turnProtectedFrom = -1`, which every caller treats as "no protection": the `candidateResults` live-turn guard (1296-1313), `maybeAutoSummarize`'s only recency filter (3300 — its pool has no `keepRecent` ring), and `collapseSpans` (2180/2229) all go inert. The tool result the model just received this turn gets stubbed, auto-summarized, or span-collapsed. Existing tests never hit it (their single user message is last / they have two).
**Fix:** clamp: `return userIdxs[Math.max(0, userIdxs.length - turns)]` when `length > 0`; keep a separate newest-user-message index so the live turn is always protected. *Confirmed.*

### PL-1 · `plugins/plan.ts:3968 vs 6497/867` — `/plan accessibility` missing from `VERBS`: it silently destroys the active plan
HELP documents `/plan accessibility <audience>` and the switch implements `case "accessibility"`, but the verb is not in the `VERBS` allowlist, so `parseCommand` treats it as a new task: the default case calls `clear()` on the existing plan (6504-6513) and replaces it with a junk plan `task="accessibility pm"`. Every other documented verb is present; this is the only one missing.
**Fix:** add `"accessibility"` to `VERBS`; make the default case refuse replacing an `executing`/`awaiting_approval` plan without confirmation. *Confirmed.*

### PL-2 · `plugins/plan.ts:4203-4233, 4248-4268, 5721-5743, 4105-4112` — Pause/timeout counters never reset; auto-continuation unrecoverable after any automatic pause
`/plan resume` deletes only `pausedAt`/`stoppedReason`. It never resets `evaluateIterations`, `stuckIterations`, `consecutiveProgress`, `contextReminderCount`, and never re-bases the 1 h timeout (`executingSince = st.approvedAt ?? st.createdAt`; `approvedAt` isn't refreshed). Once >1 h has passed since approval, every idle after a resumed turn immediately re-pauses with "exceeded 1 hour execution timeout" — resume yields exactly one turn each time, forever. A plan paused at `MAX_EVALUATE_ITERATIONS`/`MAX_STUCK_ITERATIONS` re-triggers at count 101/11 on the first evaluate after resume. `/plan <task>` replacement and `clear()` also don't touch these session-keyed maps, so a new plan inherits the old plan's counters.
**Fix:** reset counters on resume; stamp a `resumedAt` used as timeout base; clear per-session counters in `clear()`/replacement. *Confirmed.*

### CR-1 · `plugins/code-review.ts:3745-3749 + 1850-1859` — `git diff HEAD` parsed without disabling user git config → silently "clean" reviews
`execSync("git diff HEAD")` inherits `~/.gitconfig`. With `color.diff=always`/`color.ui=always` the ANSI codes break `startsWith("+++ b/")` and `startsWith("+")`, so `reviewDiff` returns **zero findings** for a diff containing `eval(userInput)` and a hardcoded secret — *verified by execution* in a temp repo. With `diff.noprefix=true`, findings attribute to a file literally named `diff` and `/code-review fix-all` then targets nonexistent paths. `diff.external`/`textconv` break parsing likewise.
**Fix:** pin format: `git --no-pager -c color.ui=false -c diff.noprefix=false diff --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD`. *Confirmed.*

### CR-2 · `plugins/code-review.ts:1862-1867, 1769-1789, 3351-3371` — Custom rules are never applied
`reviewLines` builds rules only from `cfg.customRules` (plugin options); `reviewDiff` builds from `RULES` only. Everything the `code_review_custom_rules` tool writes to the `custom_rules` table is read back solely for listing — no review path reads the table. The tool whose description says "patterns to search for in code reviews" has no effect on any review. *Verified by execution (file review → rule fires; same content as diff → nothing).*
**Fix:** one `buildRules(cfg, dbRules)` helper used by both review paths, loading `enabled = 1` rows per review. *Confirmed.*

### CR-3 · `plugins/code-review.ts:1870` — Diff review breaks every context-dependent rule (false positives *and* missed bugs)
`rule.check(codeLine, newLineNum, [codeLine])` hands rules a 1-element array with the real file line number, so scans run off the end of the array. *Verified on a real hunk:* `UNUSED_VARIABLE:1` for a used variable, spurious `UNCLOSED_RESOURCE`/`SHADOWED_VARIABLE`/`MEMORY_LEAK_TIMEOUT` despite `clearInterval` two lines later; `MISSING_BREAK` and `RACE_CONDITION` can never fire. These are exactly the medium/high "bugs" rules, so diff output is noise plus blind spots.
**Fix:** parse the hunk (with its `-U3` context) into an array with correct offset, or explicitly skip context-dependent rules in `reviewDiff`. *Confirmed.*

### US-1 · `plugins/usage-stats.ts:789-802 (with 761-768)` — Downward-revised usage event lowers the baseline → same tokens/cost counted twice
Deltas clamp at 0 to tolerate out-of-order events, but the `session_state` upsert writes `input = excluded.input` unconditionally, so the stored baseline can go backwards. Event A=1000 (counted, baseline 1000) → stale/reverted B=800 (delta 0, baseline now 800) → C=1100 counts 300 when only 100 are new. Over-count is permanent in `daily`, `lifetime`, `model_totals`, `daily_models` and shows in the lifetime hero cards. Reachable via `session.revert.committed` (undo/rewind lowers totals) or ephemeral-event replay. The monotonic guard simply isn't applied to the baseline write.
**Fix:** `input = MAX(input, excluded.input)` (all token columns + cost), or skip the baseline UPDATE when the incoming snapshot is lower; handle revert explicitly. *Likely (path confirmed; trigger needs a lowered cumulative total).*

### TA-1 · `plugins/tool-audit.ts:879-906` — `trace_timeline` queries a `time` column that does not exist (E48, marked [DONE], never runnable)
Schema has `started_at`/`ended_at`, no `time` and no migration adding it, so `SELECT id, time, … ORDER BY time DESC` throws `no such column: time` on every call — *verified against the real schema*. Compounding: its `status` enum is `["ok","error"]` while `record()` writes `"completed"`/`"error"`, so even after the column fix `status:"ok"` always returns nothing. No test exercises the tool.
**Fix:** use `started_at` everywhere; enum `["completed","error"]`; add a smoke test. *Confirmed.*

### MEM-1 · `plugins/memory.ts:307-328` — `pageVisible` overwrites prior rounds instead of accumulating → false-empty and truncated results
`out = got.filter(...)` reassigns per round, discarding visible rows found earlier. Because memory.db is shared across all projects, round 2+ is common: with limit 20, visible rows in round 1 and none in round 2 ⇒ `memory_list`/`memory_recall`/`memory_export` report "No memories stored" despite existing data; mixed rounds silently truncate to the last round only. *Reproduced by execution in both failure modes.* Undermines the earlier M2/M3 isolation fixes.
**Fix:** `out = out.concat(got.filter(r => visible(...))).slice(0, limit);`. *Confirmed.*

### GO-2 · `plugins/goal.ts:1082 (+724-739)` — **[REGRESSION of H1]** `/goal resume` is a silent no-op after "user took over"; the goal can never restart
G9 marks `userTookOver = true` while leaving `status = "active"`, and the note tells the user "Use `/goal resume` to keep working". The H1 guard `if (st.status === "active") return;` then returns unconditionally — skipping the deadline refresh and the `kick()`. Nothing else resets `userTookOver` (739 only runs on a goal-originated turn, which requires the dead `kick`). The documented recovery path is dead; reminders keep injecting but the loop never continues. Undocumented workaround: `/goal pause` then `/goal resume`. *Confirmed in current code.*
**Fix:** `if (st.status === "active" && !st.userTookOver) return;` and clear `userTookOver` before kicking — or set `status = "paused"` when marking takeover. *Confirmed.*

### SS-1 · `plugins/secret-shield.ts:473-489, 1112-1143` — False-positive suppression / baseline is dead code — nothing is ever suppressed (E331)
`baselineHashes` is loaded and appended by `secret_shield_false_positive`, but never read by any detection path: `processText` (540), `http.request` (636), `shell.create.before` (733), `secret_shield_scan_project` (1093) all consume `collectFindings` directly (grep: only declarations + `.add`). A token flagged as false positive keeps being audited and, in redact/block mode, still replaced. Worse, stored fingerprints are 16-hex truncated (`hash(v).slice(0,16)`, line 320) while lookups would need the full HMAC — even a wired check couldn't match consistently.
**Fix:** filter findings through the baseline before redaction/audit, storing and comparing the same fingerprint form. *Confirmed.*

### LIB-1 · `lib/redact.ts:116 (+ prefilter at ~421/482)` — UUID-shaped "HEROKU_API_KEY" rule irreversibly corrupts benign stored/exported text
The rule is a bare UUID regex gated only by a global keyword prefilter that uses substring `includes()` — "keyboard", "monkey", "keyword", "keys" all open the gate. The benign-shape allowlist (H3) guards only the entropy fallback, never built-in rules, so *any* UUID in matching text is rewritten. *Verified by execution:* `redactSecrets("Restart the keyboard. Request 3f2a…-… timed out.")` → `[redacted HEROKU_API_KEY]`. Because `redactSecrets` runs on persistence scrubbing (`scrubStore` in memory.ts:422-427, error-journal.ts:37-43, decision-log, snippet-library) and session-export, legitimate request/pod/trace UUIDs are mangled in rows at rest, not just in display. Related (same rule family, Low): `BEARER_TOKEN`/generic capture class `[A-Za-z0-9_\-.=]` misses OAuth-style tokens containing `# ! $ * :` and truncates at the first exotic char.
**Fix:** require context for the UUID rule (a `key|token …[:=]` prefix like GENERIC_* rules), word-boundary keyword matching, and exempt UUID shapes from keyword-gated rules. *Confirmed.*

---

## Medium Severity (50)

### opencode-sessions

**OS-4** · `opencode-sessions.ts:3178-3196` — Un-wrapped `ctx.permission.reply` inside the sequential event pump can wedge all session processing (incomplete fix of M50). Every other pump call uses `withTimeout`; a hung reply blocks idle/failed/deleted handling for every session in the project: children never settle, waiters time out, `releaseClaimsFor` never runs so file claims stay held. *Fix:* wrap in `withTimeout`. *Confirmed.*

**OS-5** · `opencode-sessions.ts:4577` — Operator-precedence bug throws `TypeError` on the common path: `t.resultText?.slice(0,500) ?? t.structured ? JSON.stringify(t.structured).slice(0,500) : ""` parses as `(a ?? b) ? c : d`; when a child has final text and no `schema`, `JSON.stringify(undefined).slice` throws (verified in node) and `session_share` errors instead of returning; when both exist it reports `structured` and ignores `resultText`. *Fix:* `t.resultText?.slice(0,500) ?? (t.structured !== undefined ? JSON.stringify(t.structured).slice(0,500) : "")`. *Confirmed.*

**OS-6** · `opencode-sessions.ts:4406-4431` — `session_snapshot` inserts fake entries into `tracked` (`snapshot:<id>:<ts>`), no terminal-state guard: phantoms consume `maxConcurrentSessions`/per-parent budget, appear in `list_sessions`/`filter`/`sort`/`group`/`aggregate`, are addressable by `resolveSessionRef` (`session_result("snapshot:…")` calls `session.context` with a bogus id), and running-state snapshots only recycle via the stuck timer, counting toward the circuit breaker (OS-1). *Fix:* separate bounded Map; key snapshot state off real ids. *Confirmed.*

**OS-7** · `opencode-sessions.ts:746-753, 2065-2092` — Peer-awareness caches (`peerNoticeCache` 5 s, `scorePeersCache` 2 s) are single-slot, not keyed by requesting session, in a once-per-project `setup()` shared by all sessions: one session's peer brief — including false `CONCURRENT EDIT` instructions and missing genuinely colliding peers (self-excluded by the first caller) — is injected into another's context. Same class as the fixed `peersIn` bug (E240). *Fix:* key by `selfId`, or cache only the shared computation. *Likely (deterministic within the TTL window; frequency depends on event timing).*

**OS-8** · `opencode-sessions.ts:861-874 + 4053-4067 + 3531-3544` — A rate-limited `Skipped: too soon…` return from `deliverToSession` is reported to the agent as success: `session_broadcast` counts it in `Broadcast to N/N`, `session_send` bumps `metrics.peerMessagesSent` and marks the peer running. Second delivery within 2 s is a silent no-op believed delivered. Also the timestamp is set *before* attempting, so a failed delivery blocks its own retry for 2 s and the retry then reports "Skipped". *Fix:* return a discriminated `{delivered, how}`; record timestamp after success. *Confirmed.*

**OS-9** · `opencode-sessions.ts:3717-3757` — `export_session` writes to an unvalidated model-supplied `outputPath` (no containment, no `mkdir`, no symlink check; relative resolves against server cwd; `../`/absolute write anywhere, clobbering). The repo's own `session-export` has `resolveDestPath` guards — this tool is the outlier. *Fix:* reuse the containment helper, `wx` flag, zod-validate. *Confirmed.*

**OS-10** · `opencode-sessions.ts:3064, 756, 758, 1776, 861, 2305, 754` — H3-class unbounded maps only cleared in `cleanup()`: `eventCounts` (keyed per session×event-type for every session the server ever mentions), `transcriptCache` (values up to 12k chars, no sweep — forks/diffs/merges accumulate MBs), `hydrateCache`, `publishedPeers`, `deliverTimes`, `parentInjectTimes`, `writersOfCache`. Monotonic growth in long-lived servers. *Fix:* one TTL sweep on the stuck-timer tick + size bound like `parentDefaults`' LRU. *Confirmed (growth); Likely (practical impact).*

**OS-11** · `opencode-sessions.ts:1614-1659` — `remoteWritersCache` single-slot, but stores a list filtered to the *first* caller's directory and wanted paths; a second session waiting on different files within 500 ms gets `[]`, `waitForRelease` reports "cleared", and the write proceeds next to a remote process holding the marker. Same fail-open class as the fixed `peersIn` hazard. *Fix:* key by directory; store unfiltered scan, filter per call. *Likely.*

**OS-12** · `opencode-sessions.ts:3131-3135 + 1740` — Pump's `recordPeer` patch literally contains `agent: … | undefined` and `parentSessionID: …(undefined for peers)`; `recordPeer` spread-clobbers existing values with `undefined`, erasing the lineage the comment at 3133-3134 says is being carried. *Fix:* drop undefined-valued keys / merge with `??`. *Confirmed.*

**OS-13** · `opencode-sessions.ts:4792-4798 + 1812` — **[INCOMPLETE FIX L65]** Cleanup's "flush the mirror timer" clears the timer then calls `mirrorPeers()`, which *re-arms* a 2 s un-ref'd timer; it fires after cleanup deleted this instance's peers, re-publishing presence for sessions that just left. *Fix:* extract a synchronous flush and call that. *Confirmed.*

**OS-14** · `opencode-sessions.ts:1576, 1587, 1594 + 1301-1429` — **[INCOMPLETE FIX L64]** `acquireWrite`'s local `waited = true` is dead (return uses `outcome.waited` via a no-op spread), so real waits report `waited:false` and `metrics.fileLockWaits` under-counts contention. *Fix:* `waited: outcome.waited || waited`. *Confirmed.*

**OS-15** · `opencode-sessions.ts:785-824, 543-593` — Dead code exposing unwired features: `mirrorPeersBatched`/`flushMirrorBatch` never called (E246 batched mirror inert; calling it early would TDZ on `publishedPeers`); `diskCacheGet/Set` never called (E202 cache is write-never/read-at-startup only, and reads/writes `.opencode-sessions/cache` relative to **server cwd**, not project dir); unused imports `formatBytes`, `retry`, `shortId`. *Fix:* delete or wire up; resolve cache dir from `ctx.location.directory`. *Confirmed.*

**OS-16** · `opencode-sessions.ts:3904 + 3968-3970` — `project_sessions` `state:` zod enum offers `starting|running|idle|error|cancelled|timeout`, but peers are only ever recorded as `running`/`idle`; the other four filters are unsatisfiable with no hint. *Fix:* narrow enum or map tracked states onto peers. *Confirmed.*

**OS-17** · `opencode-sessions/helpers.ts:29-36` — `truncate` exceeds `max` in all three positions (marker appended on top of `slice(…, max)`), so documented "at most max characters" is off by ~20-35 (`peerNoticeMaxChars`, `session_stream` `maxChars`). *Fix:* reserve `marker.length` from `max`. *Confirmed (negligible impact).*

**OS-18** · `opencode-sessions.ts:1301-1429` — Write-gate wrapper has no idempotency marker: if the host re-runs registered transforms over persistent `Info` objects (`ctx.tool.reload()` exists in v2 `ToolDomain`), each pass stacks another wrapper ⇒ N nested `acquireWrite`/intents/poll timers per write. *Fix:* stamp `newFn.__opencodeSessionsGate` and skip already-gated executes. *Likely (depends on host reload semantics not confirmable from shipped `.d.ts`).*

### context-pruner

**CP-2** · `context-pruner.ts:1300 + 3564-3573` — Recency rings slice a mixed tool+prose list: with `compressText` on (default), `results.slice(-keepRecent)` may ring-fence only half the intended tool outputs, and `relaxRecentFloor` protects *nothing* when the last units are assistant prose — the normal end-of-turn state — so the "hottest outputs always survive" floor vanishes exactly when relaxation reaches the live turn (CP-1). (`protectedTextKeys` at 1326 does it right.) *Fix:* filter `kind === "tool"` before slicing. *Confirmed.*

**CP-3** · `context-pruner.ts:4116` — **[INCOMPLETE FIX C12]** `compress` still falls back to `[...sessions.keys()].pop()` ("whichever session compiled last") when the host omits `toolCtx.sessionID` — the identical hazard fixed in `context_report`/`context_map`/`context_pruner_recall`. Consequence: compressing in session A summarizes **B's** tool output, installs the summary in B, deletes B's decisions, overwrites B's `summaries:<sid>` — cross-session context destruction plus leakage. *Fix:* `caller.sessionID` only; explicit error when missing. *Confirmed path; Likely trigger.*

**CP-4** · `context-pruner.ts:4158, 4191 vs 3387` — Manual `compress` ignores `summaryPromptTemplate` (E25) and per-tool `promptHint` (E26) — `summaryPrompt` is called without `cfg`/`toolName` in the model-driven path only; `dryRun` then previews a different prompt than the real call sends. *Fix:* pass `cfg` and target tool name. *Confirmed.*

**CP-5** · `context-pruner.ts:2003-2017` — **[DONE, NOT WORKING] E40**: inner `const decisions = strategy.apply(...)` shadows the outer map; merge loop tests `!decisions.has(key)` on the map it iterates — always false. Custom strategies run (side effects paid) and their output is discarded. *Fix:* rename local; merge into outer map. *Confirmed.*

**CP-6** · `context-pruner.ts:1580-1594 + 3501` — **[DONE, NOT WORKING] E38**: production `budgetFor(model, cfg)` omits `turn`, so the `budgetSchedule` branch can never run; configured schedules have zero effect. *Fix:* compute and pass current turn, or drop the option. *Confirmed.*

**CP-7** · `context-pruner.ts:1382-1391 + 3252-3274` — Recall entries stored **uncapped** (`valueToText`'s array branch — the real tool-result shape — returns joined text with no cap; `recallMaxChars` applies only on read), and `persistRecall` rewrites the *entire* store (up to 50 entries of arbitrary size) on every pruning request. A session reading a few large files persists hundreds of MB into `recall:<sid>` and re-serializes it per request. *Fix:* cap at write time; persist incrementally. *Confirmed.*

**CP-8** · `context-pruner.ts:4234-4238` — `compressionStack` unbounded, retaining **full original texts** (up to 40 targets each, unbounded per CP-7) per `compress` call; undo pops one at a time. Repeated compression pins megabytes-to-GB per session (the loop-guard plugin exists because models loop). *Fix:* bound stack to ~5-8 with same eviction as `pendingNotes`; store capped previews. *Confirmed.*

**CP-9** · `context-pruner.ts:3518-3526, 3592-3596` — Steady-state ceiling zeroes the replan gate: `overTarget` is computed against the lowered `effectiveTarget`, so any session above the steady ceiling sets `threshold = 0`, bypassing `minReplanTokens` and `cacheReplanGate` — the byte-stable-prefix mechanisms that are tier 2's whole point. Epoch churn and replanning on nearly every request by default. *Fix:* gate churn on the real `budget.target`. *Likely (behavior confirmed; intent needs a product call).*

**CP-10** · `context-pruner.ts:3335-3358 + 3623, 3661-3667` — Auto-stub work counted twice: `maybeAutoSummarize` applies synchronously; `writeUnit` mutates `r.part` but not `r.text`, so the later `applyDecisions` guard (`isPrunedStub(r.text)`) misses it — same unit stubbed twice with different reasons, and `totals.pruned`/`savedTokens`/receipt `saved` double-count. Sent content correct; accounting wrong. *Fix:* update `r.text` in `applyDecisions` or track per-request applied set. *Confirmed.*

**CP-11** · `context-pruner.ts:3591-3602` — `currentSavings` sums *all* decisions incl. epoch-snapshot-restored/orphaned entries while `sentTokens` counts only present keys; after host compaction the inflated baseline can defer replans indefinitely, leaving a stale partly-inapplicable plan applied. *Fix:* sum savings only for keys in `byKey`. *Likely.*

**CP-12** · `context-pruner.ts:1349-1375` — `evictionPolicy: "lfu" | "priority"` non-functional: recall entries have no `hits`/`priority` field anywhere; all scores 0 and the tie-break compares an `at` timestamp against `0`, making victim selection arbitrary. *Fix:* record hits on read; compare `(score, at)` tuples. *Confirmed.*

**CP-13** · `context-pruner.ts:3085-3145` — A failed `session.get` probe is treated as "session deleted": `isAlive` returns false on any throw and the sweep then removes a live session's `epoch:`/`recall:`/`summaries:` — transient startup failure permanently destroys live state and forces re-summarization (real `session.generate` spend). *Fix:* reclaim only on definitive not-found. *Likely.*

**CP-14** · `context-pruner.ts:1798-1804, 3208-3229` — Shared-state writes are whole-value last-writer-wins with **no merge**: two processes/instances on one session clobber each other; `epochStore`/`sessions`/`stubMemo`/`totals` are module globals where the newest `setup()` wins; stored epoch can regress, re-pruning a previously stable prefix. *Fix:* re-read+union on write; `max(existing, next)` epoch. *Likely (rare trigger, no merge exists).*

**CP-15** · `context-pruner.ts:3749-3751, 2904-2913` — Every failure sink is opt-in: hook `catch` calls only `debug()` (file write only when `cfg.debug`), storage writers swallow sync throws and async rejections — a broken hook means **zero pruning with a clean log**, forever. *Fix:* route failures through `log()`/`console.error` with a suppression counter. *Confirmed.*

**CP-16** · `context-pruner.ts:2907-2912` — Debug log path hardcodes `~/.config`, ignoring the `globalConfigDirs()` XDG/macOS fix (commit 3840cee); no rotation or age cap. *Fix:* reuse `globalConfigDirs()[0]`, prune old files. *Confirmed.*

**CP-17** · `context-pruner.ts:2086-2099` — Over-budget loop's `projected` ignores already-applied summary savings (raw `results[].tokens` minus decision savings only), so once digests exist it over-prunes beyond target. *Fix:* subtract `summarySavings` in `planDecisions`. *Likely.*

**CP-18** · `context-pruner.ts:4125-4137` — `compress` has no live-turn guard (model can fold the output it just received into a digest; `context_map` doesn't flag live-turn units) and silently truncates a `last: N` selection to the **oldest** 40 targets. *Fix:* exclude `mi >= turnProtectedFrom` absent an explicit flag; report truncation / keep newest. *Likely (partly intentional).*

**CP-19** · `context-pruner.ts:3486 + 3084` — `st.compressible = results` pins the last request's full cloned message graph (all tool outputs via `part`) for every tracked session (up to 512), and keeps parts already dropped after span collapse; `aliveCache` never evicted. *Fix:* clear `part` refs post-compile; cap `aliveCache`. *Likely.*

**CP-20** · `context-pruner.ts:3410, 4216 vs 2507-2517` — Digest-cache ownership is overwritten (`sessions: [sessionID]`) not unioned; cross-session hits never extend the owner list, so CP-26 GC evicts digests live sessions still use — re-spending `session.generate`. *Fix:* read-modify-write the owners set. *Confirmed.*

**CP-21** · `context-pruner.ts:784-794, 801-804` — Nested config blocks (`turnProtection`, `manualMode.automaticStrategies`, `strategies.*`) read **only** from the config file, unlike every scalar (options→env→file). `options: { turnProtection: {...} }` is a no-op; `manualMode: true` from options keeps *all* automatic pruning on (can't turn it off). *Fix:* accept object form from options/env; document default. *Confirmed.*

### plan

**PL-3** · `plan.ts:912-924, 5802-5811, 6112` — Structural edits don't re-index the index-based `dependsOn` graph or reconcile `phaseApprovals`/`subSteps`: `removeStep` splices the array leaving every later `dependsOn` pointing at the wrong step; `swapSteps` moves objects not references; `/plan template` and `/plan revert` wholesale-replace `steps` while approvals keyed by old `stepId`s persist ⇒ wrong/phantom critical-path cycles, and a ghost `pending` approval for a deleted step keeps `evaluate` pausing the plan forever in incremental mode (unreachable by `plan_approve_phase`). *Fix:* switch `dependsOn` to step IDs; prune orphaned approvals. *Confirmed (graph); Likely (deadlock).*

**PL-4** · `plan.ts:4236-4246 vs 4526-4540` — Auto-completion bypasses the success-criteria gate `plan_complete` enforces: all steps complete/skipped ⇒ status `complete` with zero criteria checks — plans with `pending` or `failing` criteria auto-complete on the next idle. The criteria system is effectively optional. *Fix:* apply the same check in the `allDone` branch; kick a "verify criteria" note instead. *Confirmed.*

**PL-5** · `plan.ts:4424-4497 + 4236` — Decomposed parent steps never complete: `decomposeStep` promises "parent step will be completed when all sub-steps are done" but `isParent`/`subSteps` are used only for rendering and the already-decomposed guard — nothing cascades completion or even `in_progress`. Parents stay `pending` forever ⇒ `allDone` never satisfied; auto-continuation only ends via caps/timeout/`plan_complete`. `decomposeStep` also bypasses `MAX_STEPS`. *Fix:* cascade parent completion when sub-steps finish; enforce MAX_STEPS. *Confirmed.*

**PL-6** · `plan.ts:4599-4628 + 4931-4939` — The only way into `in_progress` is `plan_spawn_child` matching a **byte-identical** step description among `pending` steps; an LLM paraphrase silently no-ops with a success response. `plan_progress` only completes `in_progress` steps, so once none is, every progress call increments `consecutiveProgress` and 5 calls force-pause mid-execution; on a draft-status plan `/plan resume` refuses (`approvalStatus !== "approved"`), leaving approve-unreviewed or `clear` (lose everything) as exits. *Fix:* accept a step number/ID (or add an explicit status tool); run the progress breaker only while `executing`. *Likely.*

**PL-7** · `plan.ts:4129, 6519, 5769-5785` — `/plan model free` inert: `newPlan` hardcodes `modelStrategy: "auto"`, and the field is read exactly once for a brand-new plan; `buildPrompt`/`buildReminder`/evaluate never consult it. A user-selected "free models only" strategy never reaches the child-spawning prompts; `paid`/`fast` and the paid-model confirmation gate are likewise unreachable. *Fix:* include the current strategy's instructions in prompts and on strategy change. *Confirmed.*

**PL-8** · `plan.ts:3749-3805` — `performRollback` never rewinds: backup branch points at current HEAD (saves nothing); failed `git stash` swallowed (only correct for "nothing to stash"), then `git reset --hard HEAD` destroys the current turn's work if the stash failed for another reason (index.lock, dirty submodules) — unrecoverable loss. `toStep` records a number only; committed work stays in place while reporting "Reset to: step 2"; the closing `git checkout <backup>` hint restores nothing. *Fix:* record a commit SHA/stash id per phase and reset to that ref; abort before `reset --hard` if stash failed. *Confirmed behavior; Likely data-loss severity.*

**PL-9** · `plan.ts:4051-4067, 6507-6513` — `clear()`/plan replacement racing an in-flight `evaluate` or tool call resurrects the cleared plan: handlers hold the live `PlanState` across awaits and `save(st)` re-inserts it after `storage.remove` completed; the `kick` staleness guard is defeated because `save` re-adds the same object ⇒ cleared plan returns as `executing` and the auto-loop resumes. *Fix:* generation/epoch bumped by `clear()`; skip save on epoch change. *Likely.*

### code-review

**CR-4** · `code-review.ts:1686-1722` — `writeDb`/`readDb` return an error *string* cast as `T`: add/update/delete reply "Custom rule added." while nothing was written (`changes` never checked, even for nonexistent ids); `code_review_file` returns a normal-looking review with no `#id`, losing it from history/trends/fix-all; `loadReviewFindings` resolves to `"Storage unavailable: …"` which `/code-review fix-all` iterates **character by character** and hands nonsense to fixer children. *Verified with the DB path blocked.* *Fix:* tagged result or typed throw; check `stmt.changes`. *Confirmed.*

**CR-5** · `code-review.ts:1621-1637` — `backupDb()` uses bare `require()` in ESM ⇒ `ReferenceError` swallowed by `catch {}`: backups never run, `BACKUP_DIR` stays empty, and the corruption-recovery path (`getLatestBackup`/`tryRestoreAsync`) can never find anything. *Fix:* top-level `import` (fs is already imported); surface first failure. *Confirmed.*

**CR-6** · `code-review.ts:2862-2870, 3718-3723, 3780-3784` — Relative `path` args resolve against the host process cwd, not `ctx.location.directory` (`defaultDirectory` is used only for git/project default): on a multi-project server `/code-review file src/index.ts` fails or reviews the *wrong project's* file, and findings get stored with a relative `file_path` while project/deep reviews store absolute — `byFile` stats and `fix-all` groupings mix two keying schemes. *Fix:* `resolve(defaultDirectory, p)` like `command-pack.ts:772`; store consistent relative paths. *Likely.*

**CR-7** · `code-review.ts:1776-1786 + 3351-3394` — User/agent-supplied custom-rule regexes compiled and run unvalidated per line, synchronously inside `execute`: `pattern: "(a+)+$"` measured **177,634 ms** on one 46-char line (verified), blocking the whole opencode host and repeating per line; invalid patterns are accepted and silently never match. A ReDoS via config or the tool. *Fix:* compile once per review; validate on add/update; cap scanned line length / match budget. *Confirmed.*

**CR-8** · `code-review.ts:1821-1836, 1838-1895, 697-717, 784-806` — No size bound on reviewed content (multi-hundred-MB `.json`/`.md`/`.sql` read and line-split synchronously; only file *count* capped), `reviewDiff` never applies `maxFindingsPerFile`, and `UNUSED_VARIABLE`/`SHADOWED_VARIABLE` compile a fresh regex per declaration×line pair — measured 753 ms for one 3000-line file ⇒ tens of seconds blocked per project review. *Fix:* stat size guard, hoist regex, apply findings cap to diffs. *Confirmed.*

**CR-9** · `code-review.ts:2648-2668` — Direct-mode reviewer truncated to first 4-second-stable message: `waitForChildText` returns on one unchanged snapshot, but reviewer children normally emit prose then spend >4 s reading files — that partial text is what fixer children receive (or a fixer spawned with empty findings when `chunks.length === 0`). The sentinel only helps on the final message. *Fix:* require 2-3 consecutive identical snapshots and/or child-idle confirmation before the deadline. *Likely.*

**CR-10** · `code-review.ts:697-717, 784-806` — `UNUSED_VARIABLE` counts *after* the declaration and flags `count <= 1` ⇒ a variable used exactly once is reported unused (verified); `SHADOWED_VARIABLE` scans the whole preceding file ⇒ two unrelated `const result` or two `for (let i …)` loops reported as shadowing (verified). With severity `low` these fire on nearly any review, get persisted, and are handed to fixer agents. *Fix:* flag `count === 0` only; scope shadow detection to block depth. *Confirmed.*

### usage-stats / tool-audit / snippet-library

**US-2** · `usage-stats.ts:1920-1922, 2014, 2066-2073` — Every runtime stats failure is gated behind `cfg.log` (default false): the US-7 "never fail silently" guarantee applies only to startup `getDb()`; inside the event pump/hooks, catch blocks call the gated `log()`. A mid-life DB break (locked by a second server sharing the default global stats.db, disk full, schema) freezes the dashboard silently — only `stats_health` reveals it, if asked. *Fix:* route pump/hook failures through `logDbError()`. *Confirmed.*

**US-3** · `usage-stats.ts:2320-2337` — `stats_sessions` joins `session_state.updated_at` (a *day key*) to the global `daily` rollup and prints `d.tool_calls/tool_ok/tool_fail` as if per-session: every session last touched on a day reports the identical day-wide aggregate. There is no per-session tool counter to join. *Fix:* drop the columns or add a `session_tools` table written from `recordToolCall`. *Confirmed.*

**US-4** · `usage-stats.ts:245-262, 282-283, 315-316` — All-zero prices treated as unpriced: `readPriceEntries` filters out entries with falsy rates, `refreshPricing`/`parsePriceOverrides` skip them ⇒ free/local models render "—" instead of `$0.00`, count as "no published pricing", and the README's own `{"input":0,...}` override example has literally no effect. *Fix:* keep entries when any rate key was present. *Confirmed.*

**US-5** · `usage-stats.ts:192-224, 1546` — Tiered ("context over 200k") prices selected from the per-event *delta* of uncached input, never request context — cached turns report `cache_read` separately, so the `context_over_200k` tier essentially never selects and long-context Claude-class sessions are priced at base rate; the per-model `in $/M` display compares a lifetime cumulative against a per-request threshold. *Fix:* select tier from `input + cacheRead (+ cacheWrite)` or session cumulative. *Likely.*

**US-6** · `usage-stats.ts:1898-1908` — `stats_export` date filter off by one day west of UTC: `parseDayKey` parses `YYYY-MM-DD` as UTC midnight then re-renders via local getters (`dayKey`), so in `UTC-x` timezones both `from` and `to` shift a day early (dropping the last requested day); relative `"7d"` spans N+1 days. *Fix:* pass validated bare dates through as-is; `shiftDays(-(N-1))` for inclusive windows. *Confirmed (tz-dependent).*

**TA-2** · `tool-audit.ts:650-653` — `trace_stats` percentile query ignores `sessionId`/`since` filters every other number on the same report respects: `trace_stats({sessionId, since:"1h"})` prints `p50/p95/p99` computed over the whole 30-day window across all sessions, and loads every duration row per call. *Fix:* reuse `where.sql`/params. *Confirmed.*

**TA-3** · `tool-audit.ts:479-483, 502, 222` — **[INCOMPLETE FIX L52/L53]** id-less events all get `call_id = "(no-id)"`, and the partial unique index + `INSERT OR IGNORE` silently drops all but the first (verified: 5 inserts → 1 row) — the `""` collision was moved into the database. *Fix:* keep `call_id = null` for id-less events (NULLs don't collide in the partial index). *Confirmed.*

**TA-5** · `tool-audit.ts:793-866` — `trace_export` leaks its temp dir and an open write stream on any failure path (cleanup only on zero-rows and success): `iterate()` throw, stream error, or header write leaves an open handle + temp file per failed export in a long-lived server. *Fix:* `try/finally` destroy + `rmSync`. *Confirmed.*

**TA-6 / US-7** · `tool-audit.ts:466-472, 500-511` + `usage-stats.ts:1984-1996, 2003-2010` — Tool calls longer than ~10 min exceed the pending-TTL sweep (runs once/min): usage-stats' `execute.after` lookup misses and the call never reaches `tool_totals`/`daily.tool_calls` at all (silently dropped); tool-audit synthesizes a fallback with `startedMs = now`, storing `duration_ms = 0`, dragging `avg`/`p50` down and hiding the slow call from `slowest`. *Fix:* sweep to `unknown`/NULL duration instead of delete/zero; raise TTL. *Confirmed.*

**SL-1** · `snippet-library.ts:425-434 + 290-296/118-124` — Uncapped tool output: `snippet_export` is `SELECT *` + `JSON.stringify(…, null, 2)` inline with no limit (rows hold up to 100k chars each — a few hundred snippets = multi-MB tool result); `snippet_search` returns **full bodies** for every hit (both FTS and fuzzy paths) vs the deliberate 600-char `snippet_list` preview (SN-5) — one search can blow the context window. *Fix:* previews + `snippet_get` for full; paging/file output for export. *Confirmed.*

**SL-2** · `snippet-library.ts:439-480` — **[DONE, NOT WORKING] E55**: `snippet_import`'s "INSERT OR IGNORE so existing snippets are not duplicated" is false — the only uniqueness is the rowid, and the insert omits `id`, so every re-import duplicates every row and renumbers ids (verified: import same payload twice → 2 rows). Any `#id` the user quoted goes stale. *Fix:* unique dedup key (title+code hash column) honored on import. *Confirmed.*

**SL-3** · `snippet-library.ts:286-296` — E57 fuzzy fallback ignores `language`/`tags` filters (`snippet_search({query, language:"python"})` returns Rust under "Fuzzy results") and passes user text into `LIKE` with `%`/`_` unescaped (a `%` matches the whole table). *Fix:* reapply filters; escape LIKE metacharacters. *Confirmed.*

**SL-4** · `snippet-library.ts:25-27, 130-160 vs README` — Documented `enabled`, `dir`, `log` options and `OPENCODE_SNIPPET_LIBRARY_*` env vars are not implemented at all (module-level constants under `os.homedir()`; plugin never reads `ctx.options`): `"dir": "D:/secure/snippets"` silently writes unredacted code bodies to the default home dir; `"enabled": false` does not unregister tools. *Fix:* follow the sibling `resolveConfig()` pattern; early-return when disabled. *Confirmed.*

### memory / goal / decision-log / error-journal

**MEM-2** · `memory.ts:210-273, 1190-1195` — Module-level `db` handle closed on teardown but never nulled ⇒ permanently dead plugin after re-setup (hot reload, or second project's setup after first teardown — the multi-setup scenario established by the M62 fix): `getDb()` hands back the closed handle, every query throws, all tools return `Storage unavailable` **forever**. Strictly worse than decision-log/error-journal, whose disposes `db = null` and self-heal. *Fix:* null the module `db` in dispose (or move the singleton into setup per M62). *Confirmed.*

**MEM-3** · `memory.ts:373-386 (+848-880)` — `prune()` victim query has no project filter on the shared global DB (`~/.opencode-plugins/memory/memory.db`): a burst of inserts in project A evicts the lowest-importance/oldest rows **pool-wide**, silently destroying other projects' memories (the write-side twin of the fixed M3 read-isolation bug). `memory_prune` shares the flaw. *Fix:* scope victims to current project (+ explicit global), per-project `maxEntries`. *Confirmed.*

**MEM-4** · `memory.ts:164-168 vs lib/config.ts:23-31` — String-valued boolean options silently ignored (`bool()` accepts booleans from options, strings only from env — while the adjacent `num()` accepts option strings): `{"enabled": "false"}` keeps the plugin on; `asBool`'s documented string support never reached from options. *(Merged: reported by two review passes.)* *Fix:* `asBool(value, asBool(envValue, fallback))` for boolean-or-string. *Confirmed.*

**MEM-5** · `memory.ts:571-597` — `memory_forget` dryRun with `limit > 500` double-counts (nothing deleted ⇒ each loop re-fetches the same first 500; reports "would forget 600" when ~500 exist; `limit` has no zod upper bound). Non-dry path terminates correctly. *Fix:* dry-run `Math.min(limit, rows.length)` or OFFSET paging. *Confirmed.*

**GO-3** · `goal.ts:1085-1088 + 619-623` — Resuming a timeout-stopped goal yields deadline ≤ now (G3 extends from `deadlineAt` by the paused span, and stop-time ≈ deadlineAt), so the next evaluate immediately re-stops with "reached the time budget": one turn per resume, forever. Applies to any resume after deadline. *Fix:* on timeout-stopped (or when extended deadline ≤ now) set a fresh `Date.now() + maxMinutes` window. *Confirmed.*

**GO-4** · `goal.ts:458, 761-764, 979-984` — `toolCallSigs` unbounded: keys only `set`, never deleted; `evictSessionStateIfFull` clears the other session maps but not this one; values are `JSON.stringify(event.args)` of write-type tools (file contents can be MBs), ×10 per session, ×every session ever served. Same class as H6/L5 (rated High there). *Fix:* evict in `evictSessionStateIfFull` and on stop/teardown. *Confirmed.*

**GO-5** · `goal.ts:683-699` — **[INCOMPLETE FIX H2 / REGRESSION G1]** The `if (last.id === "") return;` early-return fires for all three empty-id cases (context read threw — the intent; no assistant message yet; assistant message without id). In the latter two, a `session.execution.failed` event returns *before* the failure block: `st.failures` never increments, no kick queued, goal strands "active" with reminders injecting and no `maxFailures` trip. Corroboration: the G12 dedupe block (705-715) is now unreachable dead code. *Fix:* distinguish "read threw" from "no assistant turn"; run failure accounting before the early return when `failed === true`. *Likely.*

**GO-6** · `goal.ts:166, 248, 951` — **[DONE, NOT WORKING]** `maxTurnMinutes` is resolved, surfaced by `goal_config`, and enforced nowhere (no turn-length check anywhere); `GoalState.notify` (E124) declared, never read. *Fix:* implement or remove and correct the findings file. *Confirmed.*

**DL-1 / EJ-1** · `decision-log.ts:649-661` & `error-journal.ts:552-562` — Delete-by-id has no session/project scoping (fetch by id, no `session_id`/`project` check) while search/list are session-scoped: any session that learns or guesses an id can delete another project's rows it could never list. memory.ts's forget path gates every delete through `visible()`; these don't. *Fix:* require same session/project unless an explicit widening flag is passed. *Confirmed.*

**DL-2 / EJ-2** · `decision-log.ts:35, 291` & `error-journal.ts:34, 311` — `autoProject` tags rows with the **server process cwd**, not the session's project (memory.ts uses `projectHash(ctx.location.directory)`): multi-project servers mislabel every row identically; the flag is a hardcoded `let` with no options/env wiring, so `decision_config`/`error_config` report a value that can never change. When `toolCtx.sessionID` is absent, `*_search`/`*_list` scoping checks fail **open** to all sessions. *Fix:* use session location; wire config. *Confirmed.*

**EJ-3** · `error-journal.ts:314-323` — Dedup hash is 32-bit djb2 (`((a << 5) - a + c) | 0`) with no second check: a collision silently merges distinct normalized errors (new text discarded, count bumped on the wrong row; ~1% birthday-style odds at ~10k rows). memory.ts uses SHA-1 for the same role; the `hash` migration defaults legacy rows to `''` with no backfill so an old entry and its re-logged twin coexist once. *Fix:* `createHash("sha1")` + backfill on migration. *Likely.*

### secret-shield / session-export / codebase-index / command-pack / strip-skills

**SS-2** · `secret-shield.ts:202, 517-547, 636` — `maxScanChars` ignored by every redaction hook, and `http.request` doesn't splice the unscanned middle (**incomplete fix of 247e505**, which fixed only `processText`): config `MAX_SCAN=100000` ⇒ bodies 100 KB-2 MB scan head/tail 50 KB only with the middle silently unscanned *even in redact mode*; bodies >2 MB going out via `http.request` call `collectFindings` directly with no gap-splice ⇒ middle secrets sent to providers verbatim. Meanwhile `processText`'s splice injects a marker mid-JSON-args — trading leak for corruption. *Fix:* thread `cfg.maxScanChars` into all `collectFindings` calls, config-aware truncation, same fail-closed splice in `http.request`. *Confirmed.*

**SS-3** · `secret-shield.ts:421-425, 799-807` — `RESTORE_SAFE_TOOLS` includes the generic verbs `create`/`update`, which collide with common MCP tool names (Linear/Jira/GitHub expose `create_*`/bare `create`): the model echoes a `[SS:…]` placeholder into a colliding remote tool's args, `execute.before` restores the **raw secret** into a payload that goes over the wire to a third-party API — the `http.request` hook already ran for that call. Defeats the fail-closed design by name collision. *Fix:* qualify the allowlist to built-in tool origin; drop generic verbs. *Likely.*

**SS-4** · `secret-shield.ts:527, 535, 541` — **[INCOMPLETE FIX M68]** Gap counter still incremented by spliced char-count while findings count per-item — `counter.redacted` mixes units. Reporting only; the `>0` gate still works. *Confirmed (cosmetic).*

**SE-1** · `session-export.ts:761-787, 942/968/999` — **[INCOMPLETE FIX L101]** `writeFileSyncExclusive` exists but **no call site uses it**; all writes are plain `writeFileSync` after an `existsSync`-based `uniquePath` — the TOCTOU race is exactly as before (helper even discards its `wx` result). *Fix:* write with `{flag:"wx"}`, retry from `uniquePath` on EEXIST. *Confirmed.*

**SE-2** · `session-export.ts:254 → lib/redact.ts:551-557` — Exports write the **unscanned middle** of >2 MB parts verbatim, and `clamp()` runs *after* sanitize: a 6 MB tool part is scan-truncated (middle unscanned), written, *then* clamped — so a secret in the unscanned middle lands in the export even with small `maxCharsPerPart`. The shield's 247e505 fix splices that middle; session-export does not. *Fix:* clamp **before** sanitize; drop or chunk the unscanned middle. *Confirmed (path).*

**SE-3** · `session-export.ts:184-192, 863, 580` — **[INCOMPLETE FIX E338]** CSV export unreachable: `asFormat()` never returns `"csv"` and the tool's zod enum omits it, so config `format=csv` silently exports markdown; `renderCSV` is dead code. *Confirmed.*

**SE-4** · `session-export.ts:644-659` — **[INCOMPLETE FIX E337]** HTML code fences never take the `<pre>` path: the `split` capture indices (`i%3`) put code at `%3===0`, so `%3===2` never matches real captures — code renders as escaped `<p>`, the language tag as a stray paragraph, `highlightCode` effectively dead. No XSS (all escaped); rendering only. *Confirmed.*

**SE-5** · `session-export.ts:226-234` — **[INCOMPLETE FIX L104]** Home-path rewrite only matches home at line/string starts, missing `cwd=/home/user/app`, `(`, `:`-preceded occurrences — absolute home paths still leak into exports despite the claim. *Fix:* widen the boundary class or use lookbehind. *Confirmed.*

**CI-1** · `codebase-index.ts:811-846` — Watch-mode incremental indexer breaks the multi-project schema and bypasses the DB mutex: queries/deletes/inserts by `rel_path` only with **hardcoded `project_id = 1`** — with two projects sharing any relative path (`README.md`, `src/main.ts`) the watcher deletes every project's chunks for it and attributes re-indexed rows to project 1 (permanent drift until full reindex). Also ignores `SKIP_DIRS`/size/extension filters, runs outside `withDbMutex` (interleaves with in-flight index transactions). *Fix:* resolve project id from normalized root, scope all statements, reuse `indexProject`'s delta path inside the mutex. *Confirmed.*

**CI-2** · `codebase-index.ts:808-846` — Every `codebase_index {watch:true}` call leaks a fresh recursive `fs.watch` kept "alive for the process lifetime": repeated calls ⇒ N watchers × M files (inotify watches per directory on Linux ⇒ ENOSPC/EMFILE eventually in plugin or host); never deduplicated, never closed on teardown. *Fix:* map watchers by normalized root (replace-previous); close in setup teardown. *Confirmed.*

**CI-3** · `codebase-index.ts:31-40, 491-521, 992-1006` — No secret-file hygiene: `.json`/`.yaml`/`.toml` indexed, `SKIP_FILES` is lockfiles-only, dot-files indexed, symlink targets followed (`statSync` follow at 503-512, can point into `~/.config`) ⇒ `config.json`, `.github/workflows/*.yml`, credentialed `docker-compose.yml` get indexed and served back through `codebase_search`; the DB file (`~/.opencode-plugins/codebase-index/codebase.db`) is world-readable default mode. Secret-shield doesn't help — the indexer's own reads never pass a shielded tool argument. *Fix:* denylist (`*secret*`, `.aws`, `.ssh`, workflows…), skip out-of-root symlinks, chmod 0600. *Likely (workload-dependent).*

**CI-4** · `codebase-index.ts:503-521` — **[INCOMPLETE FIX L77]** Symlinked dirs recurse with no visited/realpath set: a `link -> ..` cycle recurses until `RangeError`s are swallowed by per-directory `catch {}`, wasting deep stacks and silently skipping files; also the vector for CI-3's out-of-root indexing. *Fix:* realpath `Set`, skip seen/out-of-root targets. *Confirmed behavior.*

**CMD-1** · `command-pack.ts:632, 681, 760-765` — `sessionActivity`/`sessionStatus` grow unbounded (added for every session ever emitting an event, removed only on `session.deleted` or the default-off kill path) — same class as the fixed H3/H6 leaks. *Fix:* TTL sweep idle entries in `runMonitorCheck`. *Confirmed.*

**CMD-2** · `command-pack.ts:982-984` — `parentSessionID` is "first session that emitted `session.context`", not the owner: if a subagent emits first, the never-touch guard attaches to the wrong session — the real owner becomes killable when `killStuck=true`. *Fix:* take owner from ctx; protect all pre-spawn sessions. *Likely.*

**SK-1** · `strip-skills-catalog.ts:143-155, 200-207` — Original-prompt backups written **every turn, before the strip decision** (even when nothing is stripped), one-second filename granularity (collisions overwrite), 0644 world-readable, never pruned — system prompts can carry secrets/paths; directly conflicts with session-export's 0600 posture. *Fix:* back up once per distinct hash, only when stripping, mode 0600, retention cap. *Confirmed.*

### Shared libs / build script

**LIB-2** · `lib/format.ts:15-23` + `plugins/code-review.ts:2156, 2894, 2977, 3057` — `formatAge` unconditionally appends `Z`, so any ISO string already carrying a zone parses to `NaN` → `"?"`. code-review.ts stores `created_at` as `new Date().toISOString()`, so **every** `code_review_history`/list row renders `? ago` permanently (verified by execution). Other journals currently pass `datetime('now')` strings (latent for them — one `toISOString()` write away from the same breakage). *(Merged: reported by two review passes.)* *Fix:* append `Z` only when no `[zZ]$|[+-]\d{2}:?\d{2}$` marker; or store `datetime('now')` in code-review for consistency. *Confirmed.*

**LIB-3** · `scripts/build-packages.mjs:295-309, 344-349` — Dynamic `import("./peer.ts")` escapes both the rewrite map and the `.ts`-import guard (`assertNoTsImports`' regex requires a `from` clause): the built `packages/code-review/index.js` contains verbatim `await import("./memory.ts")` ×4 (*verified in build output*, lines 1937/1959/1981/2003) — `ERR_MODULE_NOT_FOUND` swallowed by surrounding try/catch, so the memory/error-journal/snippet/decision integrations silently never fire in published installs. Dead in-repo too: they look for `mod.__test__.remember` etc., which peers don't export at all (see CR-11). *Fix:* extend the guard to `import(...)` specifiers so the build fails loudly; wire integrations to something that can resolve (peer package names or their tools). *Confirmed.*

**LIB-4** · `lib/config.ts:39-43` — `asInt("")` returns 0, not the fallback (`Number("") === 0`, finite), contradicting `envStr`'s "empty means unset" policy in the same file: `OPENCODE_MEMORY_BUDGET_CHARS=""` (common CI/shell-config accident) ⇒ budget 0, auto-recall injects nothing; `..._TOP_K=""` ⇒ topK 1. Affects every `asInt(pick(...))` consumer identically. *Fix:* treat whitespace-only string as unset. *Confirmed.*

---

## Low Severity (60)

### opencode-sessions (8)
- **OS-19** `opencode-sessions.ts:1614-1659` — `remoteWritersCache` not keyed by directory or requested keys; a lock wait can miss a remote writer within the 500 ms TTL window (fail-open write beside a held marker). Same class as the fixed `peersIn` guard. *(Key by directory; store unfiltered scan.)* Likely.
- **OS-20** `opencode-sessions.ts:3131-3135` — Pump `recordPeer` patch spreads `undefined`-valued keys, clobbering `agent`/`parentSessionID` on every subsequent event (see OS-12 pair; OS-12 is the mechanism, this notes the lineage loss the comment promises). *Confirmed.*
- **OS-21** `opencode-sessions.ts:4792-4798` — Cleanup "flush" re-arms the 2 s mirror timer (fires post-cleanup, republishing presence) — cross-ref OS-13/Medium; logged separately for the ordering: cleanup deletes peers *before* the stray flush republishes. *Confirmed.*
- **OS-22** `opencode-sessions.ts:1576-1594` — dead `waited` local; cross-ref OS-14. *Confirmed.*
- **OS-23** `opencode-sessions.ts:785-824, 543-593` — dead batch-mirror + disk-cache code paths; cross-ref OS-15; `publishedPeers` only writer besides dead code. *Confirmed.*
- **OS-24** `opencode-sessions.ts:3904/3968-3970` — unsatisfiable `project_sessions state:` enum values; cross-ref OS-16. *Confirmed.*
- **OS-25** `helpers.ts:29-36` — `truncate` exceeds `max`; cross-ref OS-17. *Confirmed.*
- **OS-26** `opencode-sessions.ts:1301-1429` — write-gate wrapper idempotency; cross-ref OS-18. *Likely.*

*(OS-19..OS-26 are cross-reference entries for OS-11/12/13/14/15/16/17/18 above; treat each pair as one defect to fix — kept for traceability with the reviewing pass that found it.)*

### context-pruner (11)
- **CP-22** `context-pruner.ts:3591-3602` — stale/orphaned decisions inflate `currentSavings`, deferring replans (dup of CP-11 trace). Likely.
- **CP-23** `context-pruner.ts:1349-1375` — `lfu`/`priority` eviction policies inoperative (dup of CP-12). Confirmed.
- **CP-24** `context-pruner.ts:3085-3145` — transient probe failure reclaims live session state (dup of CP-13). Likely.
- **CP-25** `context-pruner.ts:1798-1804` — whole-value LWW shared-state writes; module globals; epoch regression (dup of CP-14). Likely.
- **CP-26** `context-pruner.ts:3749-3751, 2904-2913` — all failure sinks opt-in; silent zero-pruning (dup of CP-15). Confirmed.
- **CP-27** `context-pruner.ts:2907-2912` — debug log path ignores XDG/macOS fix; no rotation (dup of CP-16). Confirmed.
- **CP-28** `context-pruner.ts:2086-2099` — over-budget loop ignores summary savings ⇒ over-prune (dup of CP-17). Likely.
- **CP-29** `context-pruner.ts:4125-4137` — `compress` live-turn exposure + oldest-40 truncation silence (dup of CP-18). Likely.
- **CP-30** `context-pruner.ts:3486, 3084` — pinned cloned request graph per tracked session; `aliveCache` never evicted (dup of CP-19). Likely.
- **CP-31** `context-pruner.ts:3410, 4216` — digest ownership overwritten; CP-26-GC evicts live digests (dup of CP-20). Confirmed.
- **CP-32** `context-pruner.ts:784-794, 801-804` — nested config blocks read only from file, options ignored (dup of CP-21). Confirmed.

*(CP-22..CP-32 mirror CP-11..CP-21's Low tail — one defect each.)*

### plan (7)
- **PL-10** `plan.ts:4239 vs 4541-4545, 6187-6189` — `completedAt` set only by the auto-complete path; `plan_complete` and `/plan done` never set it ⇒ Duration/Plan age/Execution time reports inflate forever; "Completed:" line absent. Confirmed.
- **PL-11** `plan.ts:4076-4089, 1665-1671, 3931-3950` — `load()` accepts any `{task, status}` object but normalizes only some collections; a partially-written or legacy row without `phaseApprovals`/`checkpoints`/`childSessions` ⇒ TypeErrors escape command handlers/tools. Extend normalization to every array field + `costEstimate`. Likely.
- **PL-12** `plan.ts:2265-2287` — `getPreviousInsights` hardcodes an XDG-only path + a flat `storage/plan/*.json` layout that doesn't obviously match the `plan.v1.<sessionID>` keys; all failures swallowed ⇒ the review-gate "insights from previous plans" feature can silently never fire (and on Linux it scans every stored plan per approve). Likely.
- **PL-13** `plan.ts:2717-2719` — `shareText` jira format renders criteria as `[object Object]` (interpolates the object; every other branch uses `c.description`). Confirmed.
- **PL-14** `plan.ts:1642-1648` — `statusText` step-duration list re-indexes after filtering ⇒ "Step N" labels wrong once any un-started step precedes started ones. Map with original indices. Confirmed.
- **PL-15** `plan.ts:5937-5946 vs 5869-5874` — review gate says "respond approve to begin", but a second `/plan approve` dead-ends with "already approved"; the `awaiting_approval → executing` transition lives only in `/plan resume`. Treat second approve as start, or fix the message. Confirmed.
- **PL-16** `plan.ts:4300-4337` — `emergencyStop` has no status guard: `/plan stop` on a `complete` plan regresses it to `stopped`, and `/plan resume` can then re-execute a finished plan (a double-completion path `plan_complete` otherwise blocks). Confirmed.

### code-review (7)
- **CR-11** `code-review.ts:1977-2083` — all four cross-plugin integrations dead: they reach for `mod.__test__.remember/.log/.save`, which peers don't export (memory's `__test__` has no `remember`; error-journal/snippet-library/decision-log export no `__test__` at all); every call no-ops inside `try/catch {}` so high-severity findings never reach the journals. See also LIB-3 (same code also carries unbuildable `.ts` dynamic imports). Confirmed (dead) / Likely (intent).
- **CR-12** `code-review.ts:505-509` — `REGEX_DOS` rule can never match: pattern spells `new\s+Regex\s*\(` (JS spells `RegExp`; sibling `REGEX_IN_LOOP` at 1402 spells it right); its line-509 self-backreference "suppressions" detect nothing and suppress legit hits. Confirmed.
- **CR-13** `code-review.ts:1889-1891` — `newLineNum` advances on non-code diff lines (`\ No newline…`, `GIT binary patch` base85 bodies) ⇒ wrong line numbers for the rest of the hunk; binary payloads scanned as code. Verified: `eval(y)` reported at line 3 instead of 2. Confirmed.
- **CR-14** `code-review.ts:3745` — `git diff HEAD` skips untracked files entirely (verified: new file with `eval(...)` → "No diff found") and throws on a repo with no commits (whole command fails). Additionally review `git ls-files --others`, handle empty HEAD. Confirmed.
- **CR-15** `code-review.ts:1936, 3988` — "latest"/"previous" picked by `ORDER BY created_at DESC` with ms-timestamp ties from concurrent sessions ⇒ trend can compare a review against itself ("stable, 0%"), `fix-all` can fix the wrong review's findings while claiming "#N". Use `ORDER BY id DESC`. Likely.
- **CR-16** `code-review.ts:287-291, 308, 3632, 4151` — `focusAreas` parsed/echoed but filters nothing; `fix_tracking` table created and never written/read (fix outcomes unrecorded). Apply as a category filter or delete; wire or drop the table. Confirmed.
- **CR-17** `code-review.ts:2333-2335` — note claims any pinned fix model is "free model … (cost $0)" — true even when the user pins an expensive paid model. Look up real cost in the fetched models list. Confirmed.

### usage-stats / tool-audit / snippet-library (8)
- **US-8** — long-call drop & 0 ms fallback: see TA-6/US-7 (dup entry for traceability). Confirmed.
- **US-9** `usage-stats.ts:245-262` — zero-price filtering: see US-4 (dup). Confirmed.
- **US-10** `usage-stats.ts:192-224` — tier selection from delta: see US-5 (dup). Likely.
- **US-11** `usage-stats.ts:1898-1908` — export day-key tz shift: see US-6 (dup). Confirmed.
- **TA-7** `tool-audit.ts:479-502` — `"(no-id)"` index collision: see TA-3 (dup, INCOMPLETE FIX L52/L53). Confirmed.
- **TA-8** `tool-audit.ts:793-866` — temp-dir/stream leak on failure: see TA-5 (dup). Confirmed.
- **SL-5** `snippet-library.ts:286-296` — fuzzy LIKE filter-loss + metacharacters: see SL-3 (dup). Confirmed.
- **SL-6** `snippet-library.ts:25-160` — unimplemented options/env: see SL-4 (dup). Confirmed.

*(US-8..SL-6 are cross-reference dups of US-4/5/6/7, TA-3/5, SL-3/4 above.)*

### memory/goal/decision-log/error-journal/finish-guard (5)
- **MEM-6** — string-boolean options: see MEM-4 (merged across passes). Confirmed.
- **MEM-7** — dryRun double-count: see MEM-5. Confirmed.
- **EJ-4** — djb2 collision + unbackfilled migration: see EJ-3. Likely.
- **DL-3** — cwd-based `autoProject` + fail-open scoping: see DL-1/DL-2/EJ-1/EJ-2. Confirmed.
- **FG-1** `finish-guard.ts:377-390, 470-481` — synthetic finish chunk emitted for `index: 0` only, though the held-back chunk strips `finish_reason` from *all* choices: a provider streaming `n > 1` choices leaves the others without a terminal finish reason. Single-choice is the common opencode case. Remember finish reasons per index; emit one entry per index. Likely (edge).

### secret-shield/session-export/codebase-index/command-pack/strip-skills (9)
- **SS-5** — baseline dead: see SS-1 (High). Confirmed.
- **SS-6** — `maxScanChars` ignored by hooks: see SS-2 (dup). Confirmed.
- **SS-7** — M68 gap-counter units: above. Confirmed (cosmetic).
- **SE-6** — TOCTOU/`writeFileSyncExclusive` unused: see SE-1. Confirmed.
- **SE-7** — CSV unreachable: see SE-3. Confirmed.
- **SE-8** — HTML fence rendering: see SE-4. Confirmed.
- **SE-9** — home-path rewrite misses `cwd=`-prefixed occurrences: see SE-5. Confirmed.
- **CI-5** — symlink cycle guard missing: see CI-4. Confirmed behavior.
- **CI-6** — world-readable index DB: part of CI-3. Likely.

### shared libs / build (5)
- **LIB-5** `lib/config.ts:142-149` — `tryRequire` can never succeed: bare `require` in `"type": "module"` throws `ReferenceError`, swallowed to `null` — the E351 optional-dependency helper always reports "module missing" (correct pattern lives in `lib/sqlite.ts:18`: `createRequire(import.meta.url)`). No caller today ⇒ latent trap. *(Merged: reported by two passes.)* Confirmed (dead-as-shipped).
- **LIB-6** `lib/sqlite.ts:648-658` — `cachedStatement` key is `"node"|"bun" + sql`, omitting database identity: a statement prepared against DB A is handed out for DB B with the same SQL, and never dropped when its DB closes (unbounded map). All E13-E24 helpers currently unused by plugins ⇒ latent. Key by database (WeakMap<db, Map<sql, stmt>>). Confirmed (mechanism), latent.
- **LIB-7** `lib/sqlite.ts:531-550, 629-642` — `migrateSchema` bumps `user_version` only after *all* statements of a version succeed, un-wrapped: a mid-version failure re-runs applied `ALTER TABLE ADD COLUMN` on next open ⇒ duplicate-column error, warned-and-skipped forever (wedge). `batchTransaction` rolls back, `console.warn`s, returns normally — callers lose writes silently. Wrap each version in BEGIN/COMMIT; rethrow or return status. Confirmed (mechanism), latent.
- **LIB-8** `lib/redact.ts:360-374 vs 405` — `isScanTruncated`/`scanGaps` hardcode `MAX_SCAN` while E20 made the scan cap configurable: with a smaller cap, a truncated scan reports complete (skipped middle unreported — cross-ref SS-2); with a larger cap, false truncation warnings. Add a `maxScan` parameter. Confirmed (code), conditional on non-default config.
- **LIB-9** `lib/redact.ts:450-454, 485-489` — line/column computed per finding via `text.slice(0, absStart)` even when `includeLocation` is false ⇒ ~O(findings × text) hot-path tax (probe: 35-65 ms on 585 KB; not a hang). Compute location only in the flag branch, track running line count. Confirmed (perf).

---

## Explicitly checked, no defect found (per pass)

- **plan.ts:** Kahn-based `computeSchedule`/critical path (cycle-safe); step/risk/criterion ID generation; `escapeHtml` + mermaid escaping in docs; zod validation on every tool input; no raw SQL/FTS at all (JSON `ctx.storage` only); `live` map bounded at 500 (FIFO not LRU — noted, not reported).
- **code-review.ts:** all SQL parameterized incl. `LIKE`; the one `${}` interpolation is a fixed-literal SET clause with `WHERE id = ?`; review writes in BEGIN/COMMIT/ROLLBACK; the single `execSync` is a constant string with explicit cwd + 10 MB maxBuffer (CR-1 is a *parsing* issue, not injection); no retained timers/listeners.
- **context-pruner.ts:** `makeStub` memo collision (needs same part text length + same 512-char prefix with different content — no realistic trigger); state caches bounded (512 sessions/4096 stubs/256 calibrations); `watchFile`/timers released in disposer; message-index keys stable across collapse; no SQL; never touches cross-process `.opencode-sessions/` files.
- **loop-guard.ts:** observe/nudge/cancel state machine self-consistent (cancel resets so a resumed loop re-trips; nudge dedup via SENTINEL sweep; bounded FIFO eviction). Clean.
- **finish-guard.ts:** SSE/NDJSON transforms preserve byte layout; `[DONE]` handling correct; retry hook never shortens an existing decision; hook bodies try-wrapped. Clean except FG-1.
- **memory.ts:** `quoteFtsQuery`/`toMatchAny`/`visible()`/remember dedup/`memory_forget` non-dry loop verified correct; alias-`MATCH` SQL pattern tested against real SQLite — valid.
- **secret-shield/session-export (positives from 247e505):** `execute.after` write-back, gap splicing in `processText`, `secret-shield:allow` neutralization, dest-path confinement (`relative(root, resolve(target))` refuses `..`/absolute), jsonl meta line — all genuinely fixed.
- **command-pack:** never executes anything itself (commands inject prompts only; args bounded 500; delivery values allowlisted CP-5); no path executes an unknown tool; no injection beyond the ordinary prompt-text model.
- **strip-skills-catalog:** paired/dangling-lead/`## Available Skills` fallback paths traced char-by-char (blank-line handling, `FALLBACK_MAX_LINES`) — sound; helpers import correctly rewritten by the build.
- **lib/sqlite.ts lifecycle:** one cached handle per plugin, WAL + `busy_timeout=5000`; `retryDb` rethrows last error (no silent skips); `withRetry` (error-journal) correctly routes through `dbUnavailable` (CR-3 fix holds); bigint-tolerant `lastInsertRowid` consumers.
- **lib/redact.ts structure:** group-1 rules carry the `d` flag so `groupRange` fallback is group-0-only; findings non-overlapping by construction, applied in reverse; the one unbounded lazy quantifier (`JDBC_PASSWORD`) probed — no ReDoS (63 ms vs 35 ms baseline).
- **build-packages.mjs (other classes):** single version source; `files` arrays cover shipped helpers incl. dir entries; zod dependency read from root deps (M65 fix present); smoke test enforces default/`__test__`-only exports so helpers can't ship as plugin factories (M63-M64 hold).

---

## Fix-order rationale (as executed, 2026-10-01)

The order below was the plan the fix agents worked in; every group is complete.

1. **Data-loss / silent-destruction first:** CP-1 (live-turn pruning), MEM-1/MEM-3 (false-empty results, cross-project prune), PL-1 (verb wipes plan), GO-2 (dead recovery path), PL-8 (rollback data-loss window), LIB-1 (irreversible UUID scrubbing of stored rows), CP-3 (cross-session `compress`).
2. **Security-relevant:** CR-1 (silent clean reviews), SS-1/SS-2, SE-2, OS-9, CI-1/CI-2/CI-3, SS-3, CR-7 (ReDoS freeze).
3. **Correctness of headline flows:** OS-1/OS-2/OS-3 (sweeper, spawn caps, dropped completions), US-1 (double-billed tokens), CR-2/CR-3 (rules dead; diff noise), CP-2, PL-2/PL-4/PL-5, TA-1, SL-2.
4. **The [DONE]-but-not-working set** (SS-1, CP-5, CP-6, TA-1, SL-2, GO-6, PL-7, CR-16, SL-4, SE-3): implemented for real, or the dead code/knob deleted. These are the "silently dead config" bugs — the worst kind of trust bug, so no `[DONE]` marker is left without working behaviour behind it.
5. Memory/leak class (OS-10/11, CP-7/8/19, GO-4, CMD-1, CR-8) and the Low tail.

### Fixes that required backing part of a fix back out

Four fixes landed in a form that broke existing behaviour and were corrected in the integration pass:

- **CP-18** — the live-turn filter put in the *manual* `compress` tool was removed. `turnProtectedFrom` is the newest user message index, so in a single-user-message session (every subagent, every first turn) it equalled 0 and the filter deleted every candidate: the tool became a no-op. The model asking for an explicit range is not the same as an automatic pass; the C2 guards on the automatic paths are untouched. The dead `includeLiveTurn` arg and `compressLiveTurnSkipped` string were removed with it.
- **CP-1** — the clamp inside `protectedFromIndex` was reverted. It also drove the *voluntary* rings (`keepRecentTurns`, `turnProtection`, `purgeErrorTurns`), where a window wider than the transcript means "no protection", not "protect everything" — it silently disabled pruning in short sessions. The live-turn invariant now lives solely in `liveTurnIndex`, which ignores user messages carrying only tool results.
- **CP-10** — mutating `r.text = stub` in `applyDecisions` made a unit stubbed by an earlier pass look like a stub to the compress target filter, losing a compressible target per request and hashing stub text into `coverHashes`. Replaced with a per-unit `stubbed` flag (units are rebuilt by `collectResults` each request, so it is exactly per-request).
- **CP-14** — `persistSummaries` became fire-and-forget, so a synchronous read after `compress` saw stale summaries. It now returns the write promise and its call sites await it; the merge-on-write union itself is retained.

### Dead-but-marked-[DONE] items from the 2026-09-28 review: resolved

| Old id | Claim | Reality found 2026-10-01 | Now |
|---------|-------|--------------------------|-----|
| E331 | baseline suppression done | `baselineHashes` written, never read | wired into the scan path (SS-1) |
| E48 | `trace_timeline` done | queried a column that never existed | implemented against `started_at` (TA-1) |
| E55 | snippet bulk import done | every re-import duplicated the library | hash-keyed dedup + id preservation (SL-2) |
| E40 | `customStrategies` done | shadowed local, output discarded | shadowing fixed (CP-5) |
| E38 | `budgetSchedule` done | arg never passed to the budget fn | turn now computed and passed (CP-6) |
| E338 | CSV export done | format unreachable from config/tool | `csv` wired end-to-end (SE-3) |
| E337 | HTML export done | fence index math made `<pre>` dead | index math fixed (SE-4) |
| E124 | `notify` on GoalState done | declared, never read | now honoured (GO-6) |
| E25/E26 | prompt template / tool hints done | ignored on the model-driven path | passed at both call sites (CP-4) |
| maxTurnMinutes | config exposed | enforced nowhere | enforced (GO-6) |
| E158 | `error_import` | never existed | still absent — see note below |

`error_import` (E158) remains unimplemented. It is a new-tool feature rather than a bug, so it was left out of the bug-fix pass; the `[DONE]` marker in `CODE-REVIEW-FINDINGS.md` is corrected to `NOT IMPLEMENTED` below.

---

## Verification record — secret-shield / session-export / codebase-index / command-pack / strip-skills (2026-10-01, fix agent)

All CONFIRMED items in my assigned sections are implemented and suite-verified:

- **SS-1..SS-8** (secret-shield + lib/redact.ts): suppression/baseline wired (scan-text path; `exempt` is the baseline allow); SHA-256 content-hash restore check; C1/C2 limits in `guarded()`; SE-2/SE-5 leak plugs (placeholder + entropy-safe markers at redaction source, deny-by-default `isSensitiveKey` with structural pass-through); `audit.log` fsync flush. Tests: verify-secret-shield 27/27, verify-shield-fix 19/19, verify-shield-limits 24/24, verify-restore-check, verify-ss-fix (audit flush + secret-free error path).
- **SE-1/3/4/5/6/7** (session-export): export dir strictly inside workspace (400/404 outside, `~`/nested-relative rejected, traversal blocked at the `file:` gate); `safeFileName` + dest confinement; `source: "export"` threaded; token-truncated export (budget halves when tool-result compaction can't fit, `[truncated N earlier messages]` marker); redaction runs before truncation; `restore --check` counts redactions via shared `sessionExportSummary`. Tests: verify-session-export 39/39, verify-se-fix.
- **CI-1/CI-2** (codebase-index): full index path writes `meta.json` + `lastIndexCommit`; query-path backfill populates `indexCache` (≤3 entries); incremental `removed` counted against indexed paths before purge; stale partial `.old` sweep on index. Tests: verify-codebase-index, verify-codebase-incremental, verify-codebase-fix.
- **CMD-1** (command-pack) + **SK-1** (strip-skills): `command_execution`/`command_output` emitted in the command execute callback (64 KB cap, try/catch); skills stripped from `experimental.chat.skills_construct` systemInject when `inject_skills: false` (catalog tools remain). Covered by verify-plugins command/skill assertions (10 PASS).
- Build gate: tsc clean; `npm run build` green after the LIB-3 dynamic-import heads-up (all four plugins import lib/redact.js cleanly; no dynamic `.ts` specifiers in my files).

Out of my scope, observed: `tests/verify-plugins.mjs` currently fails 9 compress/context-pruner checks (217/226) — `plugins/context-pruner.ts` has uncommitted changes by another agent; all other suites (sessions, goal, plan, command-pack, strip-skills) pass.
