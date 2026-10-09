import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { asBool, asInt } from "./lib/config.js";
/* --------------------------------------------------------------- constants */
const STORE_PREFIX = "goal.v1.";
const MARK = "[goal-plugin]";
/** GO-6: unique sentinel marking reminders this plugin injected, so the
 * context hook only strips its own output — never user/system text that
 * merely mentions the plugin. */
const REMINDER_SENTINEL = "[goal-plugin:reminder:v1]";
const MAX_PROGRESS = 20;
const HELP = [
    "goal — keep working until an objective is reached.",
    "",
    "  /goal <objective>        set the goal and start working",
    "  /goal set <objective>    same, when the objective starts with a keyword",
    "  /goal status             show status, budget and recent progress",
    "  /goal pause              stop auto-continuing (the current turn finishes)",
    "  /goal resume             resume an auto-continuing goal",
    "  /goal done               mark the goal complete yourself",
    "  /goal clear              forget the goal",
    "  /goal history            list all past goals",
    "  /goal budget <n> [min]   update iteration/time budget",
    "  /goal criteria [text]    add or list success criteria",
    "  /goal objective [text]   show or update the objective",
    "  /goal log                show recent log messages",
    "  /goal stats              show aggregate goal statistics",
    "  /goal export             export goal as JSON",
    "  /goal import <json>      restore a goal from JSON",
    "  /goal pause_all          pause all active goals",
    "  /goal resume_all         resume all paused goals",
    "",
    "Tip: follow the objective with '- ' lines to list success criteria, e.g.",
    "  /goal Ship the login fix",
    "  - the failing test passes",
    "  - no new type errors",
    "",
    "Examples:",
    "  /goal Ship the login fix - tests pass - no type errors",
    "  /goal Refactor the auth module",
    "  /goal Fix all TypeScript errors in the codebase",
].join("\n");
const NO_GOAL = "[goal-plugin] No goal is set for this session. Use `/goal <objective>` to set one.";
const STATUS_LABEL = {
    active: "active",
    paused: "paused",
    complete: "complete",
    blocked: "blocked",
    failed: "stopped (repeated errors)",
    timeout: "stopped (time budget reached)",
    budget: "stopped (attempt budget reached)",
    stalled: "stopped (no progress detected)",
};
/* ----------------------------------------------------------------- config */
function toBool(value, fallback) {
    if (typeof value === "number")
        return value !== 0;
    return asBool(value, fallback);
}
function toInt(value, fallback, min, max) {
    const n = asInt(value, fallback);
    return Math.min(max, Math.max(min, n));
}
function resolveConfig(options) {
    const pick = (key, env) => options?.[key] ?? process.env[env];
    return {
        enabled: toBool(pick("enabled", "OPENCODE_GOAL_ENABLED"), true),
        maxIterations: toInt(pick("maxIterations", "OPENCODE_GOAL_MAX_ITERATIONS"), 30, 1, 100000),
        // GO-10: 0 = no wall-clock deadline (deadlineAt stays null).
        maxMinutes: toInt(pick("maxMinutes", "OPENCODE_GOAL_MAX_MINUTES"), 180, 0, 100000),
        stallLimit: toInt(pick("stallLimit", "OPENCODE_GOAL_STALL_LIMIT"), 3, 1, 1000),
        maxFailures: toInt(pick("maxFailures", "OPENCODE_GOAL_MAX_FAILURES"), 3, 1, 1000),
        requireEvidence: toBool(pick("requireEvidence", "OPENCODE_GOAL_REQUIRE_EVIDENCE"), true),
        maxInjectChars: toInt(pick("maxInjectChars", "OPENCODE_GOAL_MAX_INJECT_CHARS"), 1600, 200, 20000),
        notify: toBool(pick("notify", "OPENCODE_GOAL_NOTIFY"), true),
        log: toBool(pick("log", "OPENCODE_GOAL_LOG"), false),
        // E128: per-turn timeout.
        maxTurnMinutes: toInt(pick("maxTurnMinutes", "OPENCODE_GOAL_MAX_TURN_MINUTES"), 30, 1, 100000),
    };
}
/* ------------------------------------------------------------------ utils */
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function truncate(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}
function textOf(message) {
    const parts = Array.isArray(message?.content) ? message.content : [];
    return parts
        .map((p) => {
        if (p?.type === "text" && typeof p.text === "string")
            return p.text;
        // GO-8: non-text parts (image/tool/file) fall back to a capped
        // stringify so the turn is never an "empty signature" stall
        // false-positive just because it carried no text.
        if (p && typeof p === "object") {
            try {
                return `[part type=${String(p.type ?? "unknown")}: ${truncate(JSON.stringify(p), 200)}]`;
            }
            catch {
                return `[part type=${String(p.type ?? "unknown")}: unstringifiable]`;
            }
        }
        return "";
    })
        .filter(Boolean)
        .join("\n");
}
/** A stable fingerprint of an assistant turn, used to detect stalls. */
function signature(text) {
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized)
        return "(empty)";
    if (normalized.length <= 600)
        return normalized;
    return `${normalized.slice(0, 300)}~${normalized.slice(-300)}`;
}
/** Split `/goal` arguments into an objective and optional success criteria. */
function parseGoalText(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const objective = [];
    const criteria = [];
    for (const line of lines) {
        const bullet = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet && bullet[1])
            criteria.push(bullet[1].trim());
        else
            objective.push(line);
    }
    // E123: preserve line breaks in multi-line objectives.
    const head = objective.join("\n").trim();
    if (!head && criteria.length > 0)
        return { objective: criteria.join("; "), criteria: [] };
    return { objective: head, criteria };
}
const VERBS = new Set(["help", "status", "pause", "resume", "done", "clear", "set"]);
function parseCommand(raw) {
    const text = raw.trim();
    if (!text)
        return { verb: "help", arg: "" };
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const head = (match?.[1] ?? "").toLowerCase();
    const rest = (match?.[2] ?? "").trim();
    if (head === "set")
        return { verb: "set", arg: rest };
    if (VERBS.has(head))
        return { verb: head, arg: rest };
    return { verb: "set", arg: text };
}
/* --------------------------------------------------------------- rendering */
function buildPrompt(st, cfg, opts) {
    const now = Date.now();
    const remaining = Math.max(0, st.maxIterations - st.iterations);
    const elapsedMin = Math.max(0, Math.round((now - st.startedAt) / 60000));
    const budgetMin = st.deadlineAt
        ? Math.max(0, Math.round((st.deadlineAt - now) / 60000))
        : cfg.maxMinutes;
    const lines = [
        opts.kickoff
            ? `${MARK} Goal set. Begin working on it now.`
            : `${MARK} Continue toward the goal (attempt ${st.iterations}/${st.maxIterations}, ${remaining} left, ${elapsedMin} min elapsed, about ${budgetMin} min of wall-clock budget remaining).`,
    ];
    if (opts.note)
        lines.push(opts.note);
    lines.push("", `OBJECTIVE\n${truncate(st.objective, 2000)}`);
    if (st.criteria.length > 0) {
        // E114: show criteria completion count.
        const doneCount = st.criteriaDone?.filter(Boolean).length ?? 0;
        lines.push("", `SUCCESS CRITERIA (${doneCount}/${st.criteria.length} complete)\n${st.criteria.map((c, i) => {
            const done = st.criteriaDone?.[i] ? "✓" : " ";
            return `${i + 1}. [${done}] ${truncate(c, 500)}`;
        }).join("\n")}`);
    }
    if (st.progress.length > 0) {
        lines.push("", `PROGRESS SO FAR\n${st.progress
            .slice(-5)
            .map((p) => `- ${p.text}`)
            .join("\n")}`);
    }
    lines.push("", "Work autonomously until the objective and every criterion is achieved and verified.", "Do not repeat work that is already done; take the single next concrete step.", "- When it is genuinely done, call `goal_complete` with a summary and concrete evidence (the exact checks you ran and their observed results).", "- If you cannot proceed, call `goal_blocked` with the reason and what you need from me.", "- Otherwise call `goal_progress` to record each milestone, then keep going.", "A turn that ends without one of those calls will be resumed automatically, so never stop mid-task.");
    return lines.join("\n");
}
function buildReminder(st, cfg) {
    const remaining = Math.max(0, st.maxIterations - st.iterations);
    const lines = [
        "ACTIVE GOAL — keep working until it is reached.",
        `Objective: ${st.objective}`,
    ];
    if (st.criteria.length > 0)
        lines.push(`Success criteria: ${st.criteria.join(" | ")}`);
    lines.push(`Budget: attempt ${st.iterations}/${st.maxIterations} (${remaining} left).`);
    // E126: failure count in reminder.
    lines.push(`Failures: ${st.failures}/${cfg.maxFailures}`);
    if (st.progress.length > 0) {
        lines.push(`Latest milestone: ${st.progress[st.progress.length - 1].text}`);
    }
    lines.push("Finish by calling `goal_complete` with evidence, or `goal_blocked` if stuck; use `goal_progress` for milestones.");
    return truncate(lines.join("\n"), cfg.maxInjectChars);
}
function statusText(st, cfg) {
    const now = Date.now();
    const remaining = Math.max(0, st.maxIterations - st.iterations);
    const elapsedMin = Math.max(0, Math.round((now - st.startedAt) / 60000));
    const budgetMin = st.deadlineAt
        ? Math.max(0, Math.round((st.deadlineAt - now) / 60000))
        : cfg.maxMinutes > 0
            ? Math.max(0, cfg.maxMinutes - elapsedMin)
            : null;
    const lines = [`${MARK} Goal (${STATUS_LABEL[st.status]})`, `Objective: ${truncate(st.objective, 2000)}`];
    if (st.criteria.length > 0) {
        lines.push(`Success criteria:\n${st.criteria.map((c, i) => `  ${i + 1}. ${truncate(c, 500)}`).join("\n")}`);
    }
    lines.push(`Attempts: ${st.iterations}/${st.maxIterations} (${remaining} left) · ${elapsedMin} min elapsed · ${budgetMin === null ? "no wall-clock deadline" : `~${budgetMin} min budget left`}`);
    // E116: stall count.
    lines.push(`Stall count: ${st.stallCount}/${cfg.stallLimit}`);
    // E117: failure count.
    lines.push(`Failures: ${st.failures}/${cfg.maxFailures}`);
    // E118: last signature.
    if (st.lastSignature)
        lines.push(`Last reply signature: ${truncate(st.lastSignature, 100)}`);
    if (st.progress.length > 0) {
        lines.push(`Recent progress:\n${st.progress
            .slice(-3)
            .map((p) => `  - ${truncate(p.text, 500)}`)
            .join("\n")}`);
    }
    if (st.lastSummary)
        lines.push(`Last summary: ${truncate(st.lastSummary, 1000)}`);
    if (st.evidence)
        lines.push(`Evidence: ${truncate(st.evidence, 500)}`);
    if (st.blockedReason)
        lines.push(`Blocked: ${truncate(st.blockedReason, 500)}`);
    if (st.stoppedReason)
        lines.push(`Stopped: ${truncate(st.stoppedReason, 500)}`);
    return lines.join("\n");
}
/* ---------------------------------------------------------------- plugin */
export default Plugin.define({
    id: "goal",
    async setup(ctx) {
        const c = ctx;
        if (!c.storage?.get ||
            !c.storage?.set ||
            !c.storage?.remove ||
            !c.session ||
            !c.event?.subscribe) {
            console.error("[goal] required plugin APIs are unavailable; the goal loop is disabled.");
            return;
        }
        const cfg = resolveConfig(c.options);
        const live = new Map();
        // G6: in-flight loads are joined by concurrent callers instead of
        // silently returning undefined (which used to make commands no-op).
        const loading = new Map();
        const inFlight = new Set();
        const toolActivity = new Set();
        // E120: recent tool call signatures per session for duplicate detection.
        const toolCallSigs = new Map();
        // GO-6: wall-clock start of the turn currently in flight, so evaluate()
        // can tell a turn that ran past maxTurnMinutes from a quick one. Stamped
        // when the plugin queues a turn (kick) and by the first tool call of a
        // turn (the tool hook); consumed — not left behind — at the top of
        // evaluate, exactly like `toolActivity` (GO-1), so an early return cannot
        // leak a stale stamp into the next turn.
        const turnStartedAt = new Map();
        /** GO-4: drop every per-session scratch map entry for a session whose goal
         * is finished (stop/clear/teardown — and any terminal transition, which
         * save() routes through here for non-active states). */
        const dropSessionScratch = (sessionID) => {
            toolCallSigs.delete(sessionID);
            toolActivity.delete(sessionID);
            turnStartedAt.delete(sessionID);
        };
        /** GO-3/CR-5: session-keyed state is capped with oldest-first (FIFO)
         * eviction so a long-lived process cannot grow it without bound.
         * Related entries are evicted together to avoid half-state.
         * GO-4: `toolCallSigs` belongs to that family too — it was the one session
         * map left out of the cap, so a process that only ever ran the tool hook
         * (sessions that never stored a goal) grew it without bound, and stop /
         * teardown never dropped it. */
        const MAX_SESSION_STATES = 500;
        const evictSessionStateIfFull = () => {
            while (live.size >= MAX_SESSION_STATES) {
                const oldest = live.keys().next();
                if (oldest.done)
                    break;
                const sid = oldest.value;
                live.delete(sid);
                loading.delete(sid);
                inFlight.delete(sid);
                toolActivity.delete(sid);
                toolCallSigs.delete(sid);
                turnStartedAt.delete(sid);
            }
            while (loading.size > MAX_SESSION_STATES) {
                const oldest = loading.keys().next();
                if (oldest.done)
                    break;
                loading.delete(oldest.value);
            }
            while (toolActivity.size > MAX_SESSION_STATES) {
                const oldest = toolActivity.values().next();
                if (oldest.done)
                    break;
                toolActivity.delete(oldest.value);
            }
            while (toolCallSigs.size > MAX_SESSION_STATES) {
                const oldest = toolCallSigs.keys().next();
                if (oldest.done)
                    break;
                toolCallSigs.delete(oldest.value);
            }
            while (turnStartedAt.size > MAX_SESSION_STATES) {
                const oldest = turnStartedAt.keys().next();
                if (oldest.done)
                    break;
                turnStartedAt.delete(oldest.value);
            }
        };
        const disposers = [];
        const track = (registration) => {
            if (registration && typeof registration.dispose === "function") {
                disposers.push(() => registration.dispose?.());
            }
        };
        // E119: in-memory ring buffer of recent log messages.
        const logBuffer = [];
        const MAX_LOG_BUFFER = 100;
        const log = (message) => {
            logBuffer.push(`[${new Date().toISOString()}] ${message}`);
            if (logBuffer.length > MAX_LOG_BUFFER)
                logBuffer.shift();
            if (cfg.log)
                console.error(`[goal] ${message}`);
        };
        const note = async (sessionID, text) => {
            if (!cfg.notify)
                return;
            // GO-6: E124's per-goal override is now actually read (it was declared
            // on GoalState and never consulted). A goal that carries notify:false
            // (e.g. restored through `/goal import`) gets no plugin chatter; goals
            // without the field keep the global default.
            const override = live.get(sessionID)?.notify;
            if (override === false)
                return;
            try {
                await c.session?.synthetic?.({ sessionID, text });
            }
            catch (err) {
                log(`failed to post note to ${sessionID}: ${describeError(err)}`);
            }
        };
        const save = async (st) => {
            evictSessionStateIfFull();
            live.set(st.sessionID, st);
            // GO-4: stop() is only one of the terminal paths — goals that finish
            // through goal_complete / goal_blocked / `/goal done` set the status and
            // save directly, and used to leave their tool-call signatures and turn
            // stamp behind, where the NEXT goal in the same session read them as a
            // duplicate-tool stall. Any non-active save means the loop is done
            // driving this session, so the scratch state goes with it.
            if (st.status !== "active")
                dropSessionScratch(st.sessionID);
            try {
                await c.storage?.set?.(STORE_PREFIX + st.sessionID, st);
            }
            catch (err) {
                // GO-7: persistence loss must never be silent — the goal would look
                // set and vanish on reload. Always error, and surface it in the note
                // when notifications are on.
                const message = `failed to persist goal for ${st.sessionID}: ${describeError(err)}`;
                console.error(`[goal] ${message}`);
                if (cfg.notify) {
                    try {
                        await c.session?.synthetic?.({ sessionID: st.sessionID, text: `[goal-plugin] Warning: ${message}` });
                    }
                    catch {
                        /* note is best-effort */
                    }
                }
            }
        };
        const load = async (sessionID) => {
            const cached = live.get(sessionID);
            if (cached)
                return cached;
            const inflight = loading.get(sessionID);
            if (inflight)
                return inflight;
            const read = (async () => {
                try {
                    const raw = (await c.storage?.get?.(STORE_PREFIX + sessionID));
                    if (raw && typeof raw === "object" && typeof raw.objective === "string" && raw.status) {
                        // GO-4: lastHandledMessageID compared both by value and by type
                        // (dedupe/evaluate). Normalise to a string on load so a stored
                        // number can never disagree with a string message id.
                        raw.lastHandledMessageID =
                            typeof raw.lastHandledMessageID === "string"
                                ? raw.lastHandledMessageID
                                : typeof raw.lastHandledMessageID === "number"
                                    ? String(raw.lastHandledMessageID)
                                    : "";
                        evictSessionStateIfFull();
                        live.set(sessionID, raw);
                        return raw;
                    }
                    return undefined;
                }
                catch (err) {
                    log(`failed to read goal for ${sessionID}: ${describeError(err)}`);
                    return undefined;
                }
            })();
            loading.set(sessionID, read);
            try {
                return await read;
            }
            finally {
                loading.delete(sessionID);
            }
        };
        const clear = async (sessionID) => {
            live.delete(sessionID);
            // GO-4: the goal is gone, so is the scratch state that only made sense
            // while it was being driven.
            dropSessionScratch(sessionID);
            try {
                await c.storage?.remove?.(STORE_PREFIX + sessionID);
            }
            catch (err) {
                log(`failed to clear goal for ${sessionID}: ${describeError(err)}`);
            }
        };
        const newGoal = (sessionID, objective, criteria) => {
            const now = Date.now();
            return {
                sessionID,
                objective,
                criteria,
                status: "active",
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                // GO-10: maxMinutes 0 means no wall-clock deadline.
                deadlineAt: cfg.maxMinutes > 0 ? now + cfg.maxMinutes * 60_000 : null,
                maxIterations: cfg.maxIterations,
                iterations: 0,
                failures: 0,
                stallCount: 0,
                lastSignature: "",
                lastHandledMessageID: "",
                progress: [],
            };
        };
        const kick = async (st, noteText, kickoff) => {
            // G2: re-validate identity/status — queued events must not resurrect a
            // goal that was cleared, replaced, or paused in the meantime.
            if (live.get(st.sessionID) !== st || st.status !== "active")
                return;
            // GO-6: the plugin knows when it starts a turn, so stamp the wall-clock
            // start of the turn it is about to run; evaluate() measures against it.
            turnStartedAt.set(st.sessionID, Date.now());
            try {
                await c.session?.prompt?.({
                    sessionID: st.sessionID,
                    text: buildPrompt(st, cfg, { kickoff, note: noteText }),
                });
            }
            catch (err) {
                // G7: a queue failure (provider down, session gone) counts toward the
                // failure budget instead of silently stalling the loop.
                log(`failed to queue continuation for ${st.sessionID}: ${describeError(err)}`);
                st.failures += 1;
                st.updatedAt = Date.now();
                await save(st);
                if (st.failures >= cfg.maxFailures) {
                    await stop(st, "failed", `${st.failures} consecutive continuation-queue errors.`);
                }
            }
        };
        const stop = async (st, status, reason) => {
            if (st.status !== "active")
                return;
            st.status = status;
            st.stoppedReason = reason;
            st.updatedAt = Date.now();
            st.lastHandledMessageID = "";
            st.lastHandledAt = 0;
            st.recentSignatures = [];
            st.lastSignature = "";
            // GO-4: the loop is over — drop the per-session scratch state along with
            // it instead of keeping stale signatures/turn stamps around until the
            // FIFO cap happens to reach them.
            dropSessionScratch(st.sessionID);
            await save(st);
            await note(st.sessionID, `${MARK} Goal ${STATUS_LABEL[status]}: ${reason}\nObjective: ${st.objective}\nAttempts: ${st.iterations}/${st.maxIterations}. Use \`/goal resume\` to continue or \`/goal clear\` to forget it.`);
            log(`goal for ${st.sessionID} stopped: ${status} (${reason})`);
        };
        const lastTurn = async (sessionID) => {
            let messages;
            try {
                messages = (await c.session?.context?.({ sessionID })) ?? [];
            }
            catch (err) {
                log(`session.context failed for ${sessionID}: ${describeError(err)}`);
                return { id: "", text: "", userText: "", threw: true };
            }
            let aiIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m?.role === "assistant" || m?.type === "assistant") {
                    aiIdx = i;
                    break;
                }
            }
            let userText = "";
            for (let i = aiIdx >= 0 ? aiIdx - 1 : messages.length - 1; i >= 0; i--) {
                if (messages[i]?.role === "user") {
                    userText = textOf(messages[i]);
                    break;
                }
            }
            if (aiIdx < 0)
                return { id: "", text: "", userText, threw: false };
            // An assistant message with no id is still a real turn — only its id is
            // unknown, which G12 handles by time-based dedupe.
            return { id: String(messages[aiIdx].id ?? ""), text: textOf(messages[aiIdx]), userText, threw: false };
        };
        const evaluate = async (sessionID, failed) => {
            if (!cfg.enabled || inFlight.has(sessionID))
                return;
            inFlight.add(sessionID);
            const toolsRan = toolActivity.delete(sessionID);
            // GO-6: consumed up-front, exactly like toolsRan (GO-1) — every early
            // return below must not leave a stamp behind for the next turn.
            const turnStart = turnStartedAt.get(sessionID);
            turnStartedAt.delete(sessionID);
            try {
                const st = await load(sessionID);
                if (!st || st.status !== "active")
                    return;
                const now = Date.now();
                if (st.iterations >= st.maxIterations) {
                    await stop(st, "budget", `reached the attempt budget (${st.maxIterations}).`);
                    return;
                }
                if (st.deadlineAt && now >= st.deadlineAt) {
                    await stop(st, "timeout", `reached the time budget (${cfg.maxMinutes} min).`);
                    return;
                }
                const last = await lastTurn(sessionID);
                // GO-5/H2: only a *failed context read* may bail before the failure
                // accounting below — the old `last.id === ""` test also swallowed "no
                // assistant turn yet" and "assistant message without an id", so
                // session.execution.failed never accrued st.failures in those cases
                // and maxFailures could never trip (the loop stranded "active").
                if (last.threw)
                    return;
                // G1: failure accounting runs BEFORE the dedup early-return so a
                // duplicate idle/failed pair can never swallow failures (which used
                // to let maxFailures never accrue and the loop stall silently).
                if (failed) {
                    st.failures += 1;
                    st.updatedAt = now;
                    await save(st);
                    if (st.failures >= cfg.maxFailures) {
                        await stop(st, "failed", `${st.failures} consecutive execution errors.`);
                        return;
                    }
                }
                // G12: an empty assistant id is an unknown turn — dedupe it briefly by
                // time instead of double-counting the paired idle/succeeded events.
                // GO-5: this block is reachable again (the id check above no longer
                // returns on an empty id), which is what it was written for.
                const knownID = last.id !== "";
                if (knownID) {
                    if (last.id === st.lastHandledMessageID)
                        return;
                    st.lastHandledMessageID = last.id;
                }
                else {
                    const fresh = st.lastHandledMessageID !== "(unknown)" ||
                        now - (st.lastHandledAt ?? 0) > 15_000;
                    if (!fresh)
                        return;
                    st.lastHandledMessageID = "(unknown)";
                }
                st.lastHandledAt = now;
                // A new assistant turn without an execution error means the previous
                // failures are behind us.
                if (!failed)
                    st.failures = 0;
                // G9: only goal-originated turns (prompt carries MARK) continue the
                // loop — if the user took over, say so once and leave the goal alone.
                if (!last.userText.includes(MARK)) {
                    if (!st.userTookOver) {
                        st.userTookOver = true;
                        st.updatedAt = now;
                        await save(st);
                        await note(sessionID, `${MARK} You took over this session, so the goal loop is not continuing automatically. Use \`/goal resume\` to keep working toward the objective.`);
                    }
                    else {
                        st.updatedAt = now;
                        await save(st);
                    }
                    return;
                }
                st.userTookOver = false;
                // GO-6: maxTurnMinutes is now enforced (it was resolved, reported by
                // goal_config, and checked nowhere). A single turn that runs past the
                // per-turn budget ends the loop instead of continuing on, so one hung
                // or looping turn cannot burn the whole wall-clock budget.
                // Deliberately evaluated AFTER the G9 takeover check above: the budget
                // bounds the turns *this plugin drives*, and a user who spends five
                // minutes on their own turn must not have their goal stopped for it.
                if (cfg.maxTurnMinutes > 0 && turnStart !== undefined) {
                    const turnMs = now - turnStart;
                    if (turnMs > cfg.maxTurnMinutes * 60_000) {
                        await stop(st, "timeout", `turn exceeded maxTurnMinutes (${Math.round(turnMs / 1000)}s > ${cfg.maxTurnMinutes} min).`);
                        return;
                    }
                }
                // G10: stall = no tools this turn AND the reply repeats something
                // recent (catches A/B/A/B alternation, not just exact A/A repeats).
                // toolsRan was consumed at the top of evaluate so user-takeover and
                // other early returns cannot leak it into the next turn (GO-1).
                const sig = signature(last.text);
                const ring = st.recentSignatures ?? [];
                if (toolsRan) {
                    st.stallCount = 0;
                    ring.length = 0;
                }
                else if (ring.includes(sig)) {
                    st.stallCount += 1;
                }
                else {
                    st.stallCount = 0;
                }
                ring.push(sig);
                if (ring.length > 6)
                    ring.shift();
                st.recentSignatures = ring;
                st.lastSignature = sig;
                // E120: duplicate tool call detection — consecutive identical tool
                // calls count as a stall even when tools are running.
                const toolSigs = toolCallSigs.get(sessionID) ?? [];
                if (toolSigs.length >= 2 && toolSigs[toolSigs.length - 1] === toolSigs[toolSigs.length - 2]) {
                    st.stallCount += 1;
                }
                if (st.stallCount >= cfg.stallLimit) {
                    await stop(st, "stalled", `${st.stallCount} turns with no tool use and no change in the reply.`);
                    return;
                }
                st.iterations += 1;
                st.updatedAt = now;
                await save(st);
                await kick(st, failed ? "The previous attempt failed with an execution error; recover or change approach." : "", false);
            }
            catch (err) {
                log(`evaluate failed for ${sessionID}: ${describeError(err)}`);
            }
            finally {
                inFlight.delete(sessionID);
            }
        };
        const interrupt = async (sessionID, reason = "") => {
            const st = await load(sessionID);
            if (!st || st.status !== "active")
                return;
            st.status = "paused";
            st.pausedAt = Date.now();
            st.updatedAt = Date.now();
            await save(st);
            log(`goal paused for ${sessionID} (interrupt reason: ${reason || "unspecified"})`);
            await note(sessionID, `${MARK} Goal paused (the turn was interrupted${reason ? `: ${reason}` : ""}). Use \`/goal resume\` to keep going.`);
        };
        /** GO-3: put the wall-clock budget back in the future when a goal resumes.
         * Normal case (G3): extend the deadline by the paused span so a long pause
         * does not instantly trip the timeout. But a goal that stopped *at* the
         * deadline (status "timeout"), or whose extended deadline is still <= now,
         * must get a fresh `maxMinutes` window — extending a deadline that is
         * already in the past left the next evaluate() stopping the goal again, so
         * each resume bought exactly one turn before "reached the time budget"
         * returned and the loop stranded the goal in "active". */ const refreshDeadlineOnResume = (st) => {
            if (!st.deadlineAt)
                return;
            const now = Date.now();
            const extended = st.deadlineAt + Math.max(0, now - (st.pausedAt ?? st.updatedAt));
            if (st.status === "timeout" || extended <= now) {
                st.deadlineAt = cfg.maxMinutes > 0 ? now + cfg.maxMinutes * 60_000 : null;
            }
            else {
                st.deadlineAt = extended;
            }
        };
        /* --------------------------------------------------------- registration */
        // GO-11: each registration is guarded so one failure is logged and
        // setup continues with the rest instead of aborting the plugin.
        if (c.tool?.transform) {
            try {
                track(await c.tool.transform((editor) => {
                    editor.add({
                        name: "goal_complete",
                        description: "Session-scoped: no-ops without an active goal in this session. Declare the active goal complete. Only call this when the objective and every success criterion is genuinely achieved and verified; include the checks you ran and their observed results as evidence.",
                        input: z.object({
                            summary: z.string().min(1).describe("One-line summary of what was accomplished."),
                            evidence: z
                                .string()
                                .optional()
                                .describe("The exact commands/tests you ran and their results."),
                        }),
                        execute: (async (args, toolCtx) => {
                            const sessionID = toolCtx?.sessionID ?? "";
                            const st = await load(sessionID);
                            if (!st)
                                return { content: "No goal is set for this session." };
                            if (st.status !== "active") {
                                return { content: `The goal is already ${STATUS_LABEL[st.status]}; nothing to complete.` };
                            }
                            const evidence = (args.evidence ?? "").trim();
                            if (cfg.requireEvidence && !evidence) {
                                return {
                                    content: "Refused: `goal_complete` needs `evidence` — the exact commands/tests you ran and their observed results. Verify the goal first, then call again.",
                                };
                            }
                            st.status = "complete";
                            st.lastSummary = args.summary.trim();
                            if (evidence)
                                st.evidence = evidence;
                            st.updatedAt = Date.now();
                            await save(st);
                            return {
                                content: "Goal marked complete; the goal loop has stopped. Give the user a concise final summary now.",
                            };
                        }),
                    });
                    editor.add({
                        name: "goal_blocked",
                        description: "Session-scoped: no-ops without an active goal in this session. Declare that the active goal cannot be completed without the user. Explains why the loop should stop.",
                        input: z.object({
                            reason: z.string().min(1).describe("Why you cannot proceed."),
                            needs: z.string().optional().describe("What you need from the user to continue."),
                        }),
                        execute: (async (args, toolCtx) => {
                            const sessionID = toolCtx?.sessionID ?? "";
                            const st = await load(sessionID);
                            if (!st)
                                return { content: "No goal is set for this session." };
                            if (st.status !== "active") {
                                return { content: `The goal is already ${STATUS_LABEL[st.status]}; nothing to block.` };
                            }
                            st.status = "blocked";
                            st.blockedReason = [args.reason.trim(), args.needs ? `Needs: ${args.needs.trim()}` : ""]
                                .filter(Boolean)
                                .join(" — ");
                            st.updatedAt = Date.now();
                            await save(st);
                            return {
                                content: "Goal marked blocked; the goal loop has stopped. Tell the user the reason and what you need from them.",
                            };
                        }),
                    });
                    editor.add({
                        name: "goal_progress",
                        description: "Session-scoped: no-ops without an active goal in this session. Record a milestone while working toward the active goal. Keeps the user informed and tells the goal loop that real progress is happening.",
                        input: z.object({
                            note: z.string().min(1).describe("What you just accomplished or learned."),
                        }),
                        execute: (async (args, toolCtx) => {
                            const sessionID = toolCtx?.sessionID ?? "";
                            const st = await load(sessionID);
                            if (!st)
                                return { content: "No goal is set for this session." };
                            if (st.status !== "active") {
                                return { content: `The goal is ${STATUS_LABEL[st.status]}; progress was not recorded.` };
                            }
                            st.progress.push({ at: Date.now(), text: args.note.trim() });
                            if (st.progress.length > MAX_PROGRESS) {
                                st.progress.splice(0, st.progress.length - MAX_PROGRESS);
                            }
                            st.updatedAt = Date.now();
                            await save(st);
                            return {
                                content: `Progress recorded (attempt ${st.iterations}/${st.maxIterations}). Keep going.`,
                            };
                        }),
                    });
                    // E115: criteria completion tracking tool.
                    editor.add({
                        name: "goal_criteria_done",
                        description: "Session-scoped: no-ops without an active goal in this session. Mark a success criterion as complete by its 1-based index.",
                        input: z.object({
                            index: z.number().int().min(1).describe("1-based criterion index to mark complete."),
                        }),
                        execute: (async (args, toolCtx) => {
                            const sessionID = toolCtx?.sessionID ?? "";
                            const st = await load(sessionID);
                            if (!st)
                                return { content: "No goal is set for this session." };
                            if (st.status !== "active") {
                                return { content: `The goal is ${STATUS_LABEL[st.status]}; criteria cannot be updated.` };
                            }
                            if (args.index < 1 || args.index > st.criteria.length) {
                                return { content: `Invalid criterion index ${args.index}. There are ${st.criteria.length} criteria.` };
                            }
                            if (!st.criteriaDone)
                                st.criteriaDone = st.criteria.map(() => false);
                            st.criteriaDone[args.index - 1] = true;
                            st.updatedAt = Date.now();
                            await save(st);
                            return { content: `Criterion ${args.index} marked complete.` };
                        }),
                    });
                    // E311: config tool.
                    editor.add({
                        name: "goal_config",
                        description: "Show the current goal plugin configuration.",
                        input: z.object({}),
                        execute: (async () => {
                            return {
                                content: [
                                    `enabled: ${cfg.enabled}`,
                                    `maxIterations: ${cfg.maxIterations}`,
                                    `maxMinutes: ${cfg.maxMinutes}`,
                                    `stallLimit: ${cfg.stallLimit}`,
                                    `maxFailures: ${cfg.maxFailures}`,
                                    `requireEvidence: ${cfg.requireEvidence}`,
                                    `maxInjectChars: ${cfg.maxInjectChars}`,
                                    `notify: ${cfg.notify}`,
                                    `log: ${cfg.log}`,
                                    `maxTurnMinutes: ${cfg.maxTurnMinutes}`,
                                ].join("\n"),
                            };
                        }),
                    });
                }));
            }
            catch (err) {
                console.error(`[goal] tool.transform registration failed: ${describeError(err)}`);
            }
        }
        if (c.tool?.hook) {
            try {
                track(await c.tool.hook("execute.before", (event) => {
                    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
                    if (!sessionID)
                        return;
                    const tool = typeof event?.tool === "string" ? event.tool : "";
                    // G11: goal's own tools are not "progress" — counting them made
                    // every turn look like tool activity and hid stalls.
                    if (tool === "goal_complete" || tool === "goal_blocked" || tool === "goal_progress") {
                        return;
                    }
                    // GO-3/CR-5: cap toolActivity with the same FIFO eviction.
                    evictSessionStateIfFull();
                    toolActivity.add(sessionID);
                    // GO-6: a tool call proves a turn is running. Stamp its start when
                    // nothing stamped it yet (kick() covers the loop's own turns; this
                    // catches turns that began outside the plugin, e.g. after a
                    // takeover + resume) so maxTurnMinutes measures a real span.
                    if (!turnStartedAt.has(sessionID))
                        turnStartedAt.set(sessionID, Date.now());
                    // E120: track tool call signatures for duplicate detection.
                    const argsStr = event?.args ? JSON.stringify(event.args) : "";
                    const sig = `${tool}:${argsStr}`;
                    const arr = toolCallSigs.get(sessionID) ?? [];
                    arr.push(sig);
                    if (arr.length > 10)
                        arr.shift();
                    toolCallSigs.set(sessionID, arr);
                }));
            }
            catch (err) {
                console.error(`[goal] tool.hook registration failed: ${describeError(err)}`);
            }
        }
        if (c.session.hook) {
            // GO-11: a failed registration must not abort setup - log and continue.
            try {
                track(await c.session.hook("context", (event) => {
                    if (!cfg.enabled)
                        return;
                    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
                    if (!sessionID)
                        return;
                    const messages = Array.isArray(event.messages) ? event.messages : [];
                    // G4: ALWAYS strip stale goal reminders first — a paused, cleared,
                    // or completed goal must not keep steering the model from context.
                    // GO-6: strip only our own stale reminders — the unique sentinel
                    // this hook injects, or a system message opening with the MARK
                    // line (the legacy reminder format). Non-system text is never
                    // inspected, so user text that merely mentions the plugin
                    // survives.
                    for (let i = messages.length - 1; i >= 0; i--) {
                        const text = messages[i]?.role === "system" ? textOf(messages[i]) : "";
                        if (text.includes(REMINDER_SENTINEL) ||
                            text === MARK ||
                            text.startsWith(MARK + "\n")) {
                            messages.splice(i, 1);
                        }
                    }
                    const st = live.get(sessionID);
                    if (!st) {
                        // GO-5: the first context call after a reload misses the reminder
                        // by design — live state is empty until the storage read above
                        // resolves, so this miss pre-warms it and the NEXT request
                        // injects. A goal is never lost, just one request late.
                        if (!live.has(sessionID))
                            void load(sessionID).catch((err) => log(`pre-warm load failed for ${sessionID}: ${describeError(err)}`));
                        return;
                    }
                    if (st.status !== "active")
                        return;
                    messages.push({
                        role: "system",
                        content: [{ type: "text", text: `${REMINDER_SENTINEL}\n${MARK}\n${buildReminder(st, cfg)}` }],
                    });
                }));
            }
            catch (err) {
                console.error(`[goal] session.hook registration failed: ${describeError(err)}`);
            }
        }
        if (c.command?.transform) {
            // GO-11: a failed registration must not abort setup - log and continue.
            try {
                track(await c.command.transform((editor) => {
                    editor.add({
                        name: "goal",
                        description: "Set and manage an objective the model works toward until it is reached.",
                        execute: async ({ sessionID, prompt }) => {
                            if (!cfg.enabled) {
                                await note(sessionID, `${MARK} The goal plugin is disabled (enabled=false).`);
                                return;
                            }
                            const { verb, arg } = parseCommand(prompt?.text ?? "");
                            switch (verb) {
                                case "help":
                                    await note(sessionID, HELP);
                                    return;
                                case "status": {
                                    const st = await load(sessionID);
                                    await note(sessionID, st ? statusText(st, cfg) : NO_GOAL);
                                    return;
                                }
                                case "pause": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    if (st.status !== "active") {
                                        return void (await note(sessionID, `${MARK} Goal is already ${STATUS_LABEL[st.status]}.`));
                                    }
                                    st.status = "paused";
                                    st.pausedAt = Date.now();
                                    st.updatedAt = Date.now();
                                    await save(st);
                                    await note(sessionID, `${MARK} Paused. The current turn will finish but the loop will not continue. Use \`/goal resume\` to keep going.`);
                                    return;
                                }
                                case "resume": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    // GO-2 (was H1): only a goal that is active AND still under
                                    // plugin control has nothing to resume. G9 leaves status
                                    // "active" when the user takes over and tells them to run
                                    // `/goal resume`, so the bare active-check made that
                                    // documented recovery a silent no-op — the guard has to let
                                    // the takeover case through (and the flag is cleared below
                                    // before the kick).
                                    if (st.status === "active" && !st.userTookOver)
                                        return;
                                    // G3/GO-3: put the wall-clock budget back in the future
                                    // (fresh window when it already ran out).
                                    refreshDeadlineOnResume(st);
                                    // GO-9: remove the key instead of assigning undefined, so
                                    // persisted state never carries a pausedAt field.
                                    delete st.pausedAt;
                                    // GO-3: the goal is running again — a resume that left the
                                    // old stop reason in the state made exported status output
                                    // claim the goal was still timed out/failed.
                                    delete st.stoppedReason;
                                    st.status = "active";
                                    st.failures = 0;
                                    st.stallCount = 0;
                                    st.userTookOver = false;
                                    st.updatedAt = Date.now();
                                    await save(st);
                                    await note(sessionID, `${MARK} Resumed.`);
                                    await kick(st, "The goal was resumed by the user.", false);
                                    return;
                                }
                                case "done": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    st.status = "complete";
                                    st.lastSummary = "Marked complete by the user.";
                                    st.updatedAt = Date.now();
                                    await save(st);
                                    await note(sessionID, `${MARK} Goal marked complete; the loop is stopped.`);
                                    return;
                                }
                                case "clear": {
                                    await clear(sessionID);
                                    await note(sessionID, `${MARK} Goal cleared.`);
                                    return;
                                }
                                // E110: history command.
                                case "history": {
                                    const keys = await c.storage?.keys?.() ?? [];
                                    const goalKeys = keys.filter((k) => k.startsWith(STORE_PREFIX));
                                    if (goalKeys.length === 0) {
                                        await note(sessionID, "No past goals found.");
                                        return;
                                    }
                                    const entries = [];
                                    for (const key of goalKeys) {
                                        const raw = await c.storage?.get?.(key);
                                        if (raw && typeof raw === "object") {
                                            const st = raw;
                                            entries.push(`#${st.sessionID} [${st.status}] ${truncate(st.objective, 100)}`);
                                        }
                                    }
                                    await note(sessionID, `Past goals:\n${entries.join("\n")}`);
                                    return;
                                }
                                // E111: budget command.
                                case "budget": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    if (st.status !== "active") {
                                        return void (await note(sessionID, `${MARK} Goal is already ${STATUS_LABEL[st.status]}.`));
                                    }
                                    const parts = arg.split(/\s+/);
                                    const iterations = Number.parseInt(parts[0], 10);
                                    if (!Number.isFinite(iterations) || iterations <= 0) {
                                        return void (await note(sessionID, `${MARK} Usage: /goal budget <iterations> [minutes]`));
                                    }
                                    st.maxIterations = iterations;
                                    if (parts[1]) {
                                        const minutes = Number.parseInt(parts[1], 10);
                                        if (Number.isFinite(minutes) && minutes > 0) {
                                            st.deadlineAt = Date.now() + minutes * 60_000;
                                        }
                                    }
                                    st.updatedAt = Date.now();
                                    await save(st);
                                    await note(sessionID, `${MARK} Budget updated: ${st.maxIterations} iterations${st.deadlineAt ? `, deadline in ${Math.round((st.deadlineAt - Date.now()) / 60000)} min` : ""}.`);
                                    return;
                                }
                                // E112: criteria command.
                                case "criteria": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    if (arg) {
                                        st.criteria.push(arg);
                                        if (st.criteriaDone)
                                            st.criteriaDone.push(false);
                                        st.updatedAt = Date.now();
                                        await save(st);
                                        await note(sessionID, `${MARK} Criterion added: ${arg}`);
                                    }
                                    else {
                                        if (st.criteria.length === 0) {
                                            await note(sessionID, "No criteria set.");
                                        }
                                        else {
                                            const lines = st.criteria.map((c, i) => {
                                                const done = st.criteriaDone?.[i] ? "✓" : " ";
                                                return `  ${i + 1}. [${done}] ${truncate(c, 200)}`;
                                            });
                                            await note(sessionID, `Criteria:\n${lines.join("\n")}`);
                                        }
                                    }
                                    return;
                                }
                                // E113: objective command.
                                case "objective": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    if (!arg) {
                                        await note(sessionID, `Objective: ${st.objective}`);
                                        return;
                                    }
                                    st.objective = arg;
                                    st.updatedAt = Date.now();
                                    await save(st);
                                    await note(sessionID, `${MARK} Objective updated.`);
                                    return;
                                }
                                // E119: log command.
                                case "log": {
                                    if (logBuffer.length === 0) {
                                        await note(sessionID, "No log messages yet.");
                                    }
                                    else {
                                        await note(sessionID, `Recent log:\n${logBuffer.slice(-20).join("\n")}`);
                                    }
                                    return;
                                }
                                // E131: stats command.
                                case "stats": {
                                    const keys = await c.storage?.keys?.() ?? [];
                                    const goalKeys = keys.filter((k) => k.startsWith(STORE_PREFIX));
                                    let total = 0;
                                    let active = 0;
                                    let complete = 0;
                                    let blocked = 0;
                                    let failed = 0;
                                    let totalIterations = 0;
                                    let totalFailures = 0;
                                    for (const key of goalKeys) {
                                        const raw = await c.storage?.get?.(key);
                                        if (raw && typeof raw === "object") {
                                            const st = raw;
                                            total += 1;
                                            if (st.status === "active")
                                                active += 1;
                                            if (st.status === "complete")
                                                complete += 1;
                                            if (st.status === "blocked")
                                                blocked += 1;
                                            if (st.status === "failed")
                                                failed += 1;
                                            totalIterations += st.iterations;
                                            totalFailures += st.failures;
                                        }
                                    }
                                    await note(sessionID, [
                                        `Goal statistics:`,
                                        `  Total: ${total}`,
                                        `  Active: ${active}`,
                                        `  Complete: ${complete}`,
                                        `  Blocked: ${blocked}`,
                                        `  Failed: ${failed}`,
                                        `  Total iterations: ${totalIterations}`,
                                        `  Total failures: ${totalFailures}`,
                                    ].join("\n"));
                                    return;
                                }
                                // E127: export command.
                                case "export": {
                                    const st = await load(sessionID);
                                    if (!st)
                                        return void (await note(sessionID, NO_GOAL));
                                    await note(sessionID, `Goal state JSON:\n\`\`\`json\n${JSON.stringify(st, null, 2)}\n\`\`\``);
                                    return;
                                }
                                // E127: import command.
                                case "import": {
                                    if (!arg)
                                        return void (await note(sessionID, `${MARK} Usage: /goal import <json>`));
                                    try {
                                        const parsed = JSON.parse(arg);
                                        if (!parsed.objective || !parsed.sessionID) {
                                            await note(sessionID, `${MARK} Invalid goal state JSON.`);
                                            return;
                                        }
                                        parsed.sessionID = sessionID;
                                        await save(parsed);
                                        await note(sessionID, `${MARK} Goal imported.`);
                                    }
                                    catch {
                                        await note(sessionID, `${MARK} Failed to parse goal JSON.`);
                                    }
                                    return;
                                }
                                // E121: pause_all command.
                                case "pause_all": {
                                    const keys = [...live.keys()];
                                    for (const sid of keys) {
                                        const st = live.get(sid);
                                        if (st && st.status === "active") {
                                            st.status = "paused";
                                            st.pausedAt = Date.now();
                                            st.updatedAt = Date.now();
                                            await save(st);
                                        }
                                    }
                                    await note(sessionID, `${MARK} Paused ${keys.length} goal(s).`);
                                    return;
                                }
                                // E121: resume_all command.
                                case "resume_all": {
                                    const keys = [...live.keys()];
                                    for (const sid of keys) {
                                        const st = live.get(sid);
                                        if (st && st.status === "paused") {
                                            // GO-3: same deadline handling as a single resume, so a
                                            // paused goal whose window already lapsed gets a fresh
                                            // one instead of stopping on its first turn back.
                                            refreshDeadlineOnResume(st);
                                            delete st.pausedAt;
                                            delete st.stoppedReason;
                                            st.status = "active";
                                            st.failures = 0;
                                            st.stallCount = 0;
                                            st.userTookOver = false;
                                            st.updatedAt = Date.now();
                                            await save(st);
                                        }
                                    }
                                    await note(sessionID, `${MARK} Resumed ${keys.length} goal(s).`);
                                    return;
                                }
                                default: {
                                    const goal = parseGoalText(arg);
                                    if (!goal.objective)
                                        return void (await note(sessionID, HELP));
                                    // E122: objective length validation.
                                    if (goal.objective.length < 10) {
                                        return void (await note(sessionID, `${MARK} Objective too short (min 10 chars).`));
                                    }
                                    const st = newGoal(sessionID, goal.objective, goal.criteria);
                                    await save(st);
                                    await note(sessionID, `${MARK} Goal set.\nObjective: ${st.objective}\nBudget: ${st.maxIterations} attempts${cfg.maxMinutes > 0 ? ` / ${cfg.maxMinutes} min` : " (no wall-clock deadline)"}.`);
                                    await kick(st, "", true);
                                    return;
                                }
                            }
                        },
                    });
                }));
            }
            catch (err) {
                console.error(`[goal] command registration failed: ${describeError(err)}`);
            }
        }
        if (cfg.log) {
            console.error(`[goal] ready (max ${cfg.maxIterations} attempts, ${cfg.maxMinutes} min, stall limit ${cfg.stallLimit}).`);
        }
        /* ------------------------------------------------------------ event loop */
        const abort = new AbortController();
        void (async () => {
            try {
                for await (const event of c.event.subscribe({ signal: abort.signal })) {
                    if (!cfg.enabled)
                        continue;
                    const type = String(event?.type ?? "");
                    const data = (event?.data ?? {});
                    const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
                    if (!sessionID)
                        continue;
                    if (type === "session.execution.interrupted") {
                        // G5: branch on the interrupt reason so superseded/inactivity
                        // interrupts are visible in the pause note and logs.
                        const reason = typeof data.reason === "string" ? data.reason : "";
                        void interrupt(sessionID, reason).catch((err) => console.error(`[goal] interrupt failed for ${sessionID}: ${describeError(err)}`));
                    }
                    else if (type === "session.idle" || type === "session.execution.succeeded") {
                        void evaluate(sessionID, false).catch((err) => console.error(`[goal] evaluate failed for ${sessionID}: ${describeError(err)}`));
                    }
                    else if (type === "session.execution.failed") {
                        void evaluate(sessionID, true).catch((err) => console.error(`[goal] evaluate failed for ${sessionID}: ${describeError(err)}`));
                    }
                }
            }
            catch (err) {
                if (!abort.signal.aborted)
                    console.error(`[goal] event stream ended: ${describeError(err)}`);
            }
        })();
        return async () => {
            abort.abort();
            for (const dispose of disposers) {
                try {
                    await dispose();
                }
                catch {
                    /* best effort */
                }
            }
            // GO-4: teardown released the registrations but left the session-keyed
            // scratch maps populated until the process died (and the FIFO cap only
            // ever trims `live`-driven keys, never tool-hook-only sessions).
            toolCallSigs.clear();
            toolActivity.clear();
            turnStartedAt.clear();
        };
    },
});
