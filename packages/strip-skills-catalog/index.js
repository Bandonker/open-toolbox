import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { asBool } from "./lib/helpers.js";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
/**
 * Strip the <available_skills>...</available_skills> block from the system
 * prompt sent to the LLM. The `skill` tool itself remains registered and
 * callable, so agents can still load skills on demand by name.
 *
 * Discovery path for agents: run `opencode debug skill` to list all
 * registered skill names + descriptions, then call the `skill` tool with
 * the desired name.
 *
 * Savings scale with installed skill count -- roughly 100-200 tokens per
 * skill in the catalog. Set OPENCODE_STRIP_SKILLS_LOG=1 to log how many
 * bytes are stripped on each turn.
 */
export default Plugin.define({
    id: "strip-skills-catalog",
    async setup(ctx) {
        const hook = await ctx.session.hook("context", (event) => {
            // SC-1: never let a stripping bug break prompt building — fail open
            // (leave the prompt intact) and report loudly instead of throwing.
            try {
                stripSkills(event);
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[strip-skills-catalog] strip failed, leaving prompt intact: ${String(err)}`);
            }
        });
        // E73: dry-run tool — returns the prompt text with the skills block removed.
        const toolRegistration = await ctx.tool.transform((editor) => {
            editor.add({
                name: "strip_skills_dry_run",
                description: "Preview what the system prompt looks like with the skills catalog stripped. Returns the modified prompt text without modifying the actual prompt.",
                input: z.object({
                    promptText: z.string().describe("The system prompt text to preview"),
                }),
                execute: async (input) => {
                    const args = input;
                    const event = {
                        system: [{ type: "text", text: args.promptText }],
                    };
                    stripSkills(event);
                    const result = event.system[0].text;
                    return { content: result };
                },
            });
            // E75: stats tool — returns total bytes stripped, prompts modified, etc.
            editor.add({
                name: "strip_skills_stats",
                description: "Show statistics about skills catalog stripping: total bytes stripped, prompts modified, etc.",
                input: z.object({}),
                execute: async () => {
                    return {
                        content: [
                            `strip-skills-catalog stats:`,
                            `  total bytes stripped: ${stats.totalStripped}`,
                            `  prompts modified: ${stats.totalPrompts}`,
                            `  last stripped: ${stats.lastStrippedAt ?? "never"}`,
                        ].join("\n"),
                    };
                },
            });
            // E77: restore tool — reads the most recent backup file and returns its content.
            editor.add({
                name: "strip_skills_restore",
                description: "Restore the most recent backup of the original system prompt (before skills stripping).",
                input: z.object({}),
                execute: async () => {
                    const backupDir = process.env.OPENCODE_STRIP_SKILLS_BACKUP_DIR;
                    if (!backupDir) {
                        return {
                            content: "OPENCODE_STRIP_SKILLS_BACKUP_DIR is not set — no backups available.",
                        };
                    }
                    try {
                        const files = readdirSync(backupDir)
                            .filter((f) => f.startsWith("prompt-backup-") && f.endsWith(".txt"))
                            // SK-1: file names are content hashes now — "latest" is mtime.
                            .map((f) => {
                            let mtimeMs = 0;
                            try {
                                mtimeMs = statSync(join(backupDir, f)).mtimeMs;
                            }
                            catch {
                                /* ignore */
                            }
                            return { f, mtimeMs };
                        })
                            .sort((a, b) => a.mtimeMs - b.mtimeMs);
                        if (files.length === 0) {
                            return { content: `No backup files found in ${backupDir}.` };
                        }
                        const latest = files[files.length - 1].f;
                        const content = readFileSync(join(backupDir, latest), "utf8");
                        return {
                            content: [
                                `Most recent backup: ${latest}`,
                                `Restored prompt (${content.length} chars):`,
                                ``,
                                content,
                            ].join("\n"),
                        };
                    }
                    catch (err) {
                        return { content: `strip_skills_restore failed: ${String(err)}` };
                    }
                },
            });
        });
        // SC-4: return a dispose handle so the host can unsubscribe the hook.
        return async () => {
            try {
                await hook?.dispose?.();
            }
            catch {
                // Dispose is best-effort.
            }
            try {
                await toolRegistration?.dispose?.();
            }
            catch {
                // Dispose is best-effort.
            }
        };
    },
});
/** Bounded fallback: how far past a dangling lead marker we strip (SC-2). */
const DANGLING_LEAD_MAX_CHARS = 2000;
/** Bound for the "## Available Skills" fallback strip, in lines (SC-3). */
const FALLBACK_MAX_LINES = 100;
/** E75: module-level stats counter for total bytes stripped. */
const stats = {
    totalStripped: 0,
    totalPrompts: 0,
    lastStrippedAt: null,
};
/** SK-1: retention cap for original-prompt backup files. */
const MAX_PROMPT_BACKUPS = 50;
/** SK-1: content hashes already backed up this process — one file per distinct content. */
const backedUpHashes = new Set();
/**
 * E76/SK-1: back up the original prompt — ONLY when a strip will actually
 * happen (the strip branches call this), ONCE per distinct content hash
 * (filename = hash, so per-turn re-backup of the same prompt is a no-op),
 * owner-only mode 0600 (system prompts carry paths and can carry secrets —
 * the old every-turn, world-readable, unbounded backup was both a leak
 * surface and a disk leak), pruned to the newest MAX_PROMPT_BACKUPS files.
 * Best-effort — failures are logged but never throw.
 */
function backupOriginalPrompt(text) {
    const backupDir = process.env.OPENCODE_STRIP_SKILLS_BACKUP_DIR;
    if (!backupDir)
        return;
    try {
        const hash = createHash("sha256").update(text).digest("hex");
        const path = join(backupDir, `prompt-backup-${hash}.txt`);
        if (backedUpHashes.has(hash) || existsSync(path)) {
            backedUpHashes.add(hash);
            return;
        }
        mkdirSync(backupDir, { recursive: true });
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
        // L88: writeFileSync mode is only applied on POSIX and only on create.
        // Explicitly chmod to ensure correct permissions.
        try {
            chmodSync(path, 0o600);
        }
        catch {
            /* best effort */
        }
        backedUpHashes.add(hash);
        if (backedUpHashes.size > 4 * MAX_PROMPT_BACKUPS) {
            // Bounded bookkeeping; the existsSync probe still prevents duplicates
            // after the in-memory reset.
            backedUpHashes.clear();
        }
        pruneBackups(backupDir);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] backup failed: ${String(err)}`);
    }
}
/** SK-1: keep only the newest MAX_PROMPT_BACKUPS backup files. */
function pruneBackups(backupDir) {
    try {
        const files = readdirSync(backupDir)
            .filter((f) => f.startsWith("prompt-backup-") && f.endsWith(".txt"))
            .map((f) => {
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(join(backupDir, f)).mtimeMs;
            }
            catch {
                /* vanished mid-listing */
            }
            return { f, mtimeMs };
        })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const entry of files.slice(MAX_PROMPT_BACKUPS)) {
            try {
                rmSync(join(backupDir, entry.f), { force: true });
            }
            catch {
                /* best effort */
            }
        }
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] backup prune failed: ${String(err)}`);
    }
}
/**
 * E74: parse the allowlist from OPENCODE_STRIP_SKILLS_ALLOWLIST env var.
 * Comma-separated skill names that should NOT be stripped.
 */
function getAllowlist() {
    const raw = process.env.OPENCODE_STRIP_SKILLS_ALLOWLIST || "";
    return new Set(raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean));
}
/**
 * E74: filter <skill>...</skill> entries from the skills block content,
 * preserving only allowlisted skills. Returns the filtered content.
 */
function filterSkillsByAllowlist(blockContent, allowlist) {
    if (allowlist.size === 0)
        return blockContent;
    // Split into individual <skill>...</skill> entries.
    const entries = blockContent.match(/<skill>[\s\S]*?<\/skill>/g) || [];
    if (entries.length === 0)
        return blockContent;
    const preserved = [];
    for (const entry of entries) {
        // Extract skill name from <skill>name</skill> or <skill name="...">.
        const nameMatch = entry.match(/<skill\s+name="([^"]+)"/i) || entry.match(/<skill>([^<]+)<\/skill>/i);
        if (nameMatch) {
            const skillName = nameMatch[1].trim();
            if (allowlist.has(skillName)) {
                preserved.push(entry);
            }
        }
        else {
            // Can't determine name — preserve to be safe.
            preserved.push(entry);
        }
    }
    return preserved.join("\n");
}
function stripSkills(event) {
    let removedBytes = 0;
    const allowlist = getAllowlist();
    for (const part of event.system) {
        if (part.type !== "text" || typeof part.text !== "string")
            continue;
        // SystemPart.text is typed readonly; the prompt builder hands us a
        // mutable object, so mutate through a widened view.
        const mutable = part;
        const text = part.text;
        // Remove the entire skill prompt block produced by SystemPrompt.skills.
        // Layout in the binary (Cz_ formatter, verbose mode):
        //   "Skills provide specialized instructions and workflows for specific tasks.\n"
        //   "Use the skill tool to load a skill when a task matches its description.\n"
        //   "<available_skills>\n  <skill>...</skill>\n  ...\n</available_skills>"
        const lead = "Skills provide specialized instructions and workflows for specific tasks.";
        const tail = "</available_skills>";
        const leadIdx = text.indexOf(lead);
        const tailIdx = text.indexOf(tail);
        if (leadIdx >= 0 && tailIdx > leadIdx) {
            const before = text.slice(0, leadIdx);
            const after = text.slice(tailIdx + tail.length);
            if (allowlist.size > 0) {
                // E74: preserve allowlisted skills.
                const blockContent = text.slice(leadIdx + lead.length, tailIdx);
                const filtered = filterSkillsByAllowlist(blockContent, allowlist);
                if (filtered.trim().length > 0) {
                    // Rebuild the block with only allowlisted skills.
                    const newBlock = lead + "\n" + filtered + "\n" + tail;
                    mutable.text = before.trimEnd() + "\n\n" + newBlock + after.replace(/^\s*\n/, "");
                }
                else {
                    // All skills stripped — remove the entire block.
                    mutable.text = before.trimEnd() + after.replace(/^\s*\n/, "");
                }
            }
            else {
                mutable.text = before.trimEnd() + after.replace(/^\s*\n/, "");
            }
            // SK-1: back up the original ONLY when this strip actually changed
            // the prompt (once per distinct content hash).
            if (mutable.text !== text)
                backupOriginalPrompt(text);
            removedBytes += verifyWrite(text, mutable.text, "paired");
            continue;
        }
        if (leadIdx >= 0) {
            // SC-2: lead present but no closing tail — strip a bounded span after
            // the lead instead of leaving the whole block in the prompt.
            const before = text.slice(0, leadIdx).trimEnd();
            const window = text.slice(leadIdx + lead.length, leadIdx + lead.length + DANGLING_LEAD_MAX_CHARS);
            const cut = window.search(/\n\s*\n/);
            const rest = (cut >= 0 ? text.slice(leadIdx + lead.length + cut) : "").replace(/^\s*\n/, "");
            mutable.text = before + (rest ? "\n\n" + rest : "");
            if (mutable.text !== text)
                backupOriginalPrompt(text);
            removedBytes += verifyWrite(text, mutable.text, "dangling-lead");
            continue;
        }
        // Also strip the standalone "## Available Skills\n- **name**: ..." form
        // (subagent fmt mode, in case future opencode swaps to it).
        const hdr = "## Available Skills";
        const hdrIdx = text.indexOf(hdr);
        if (hdrIdx >= 0) {
            const before = text.slice(0, hdrIdx).trimEnd();
            const rest = text.slice(hdrIdx);
            const lines = rest.split("\n");
            // SC-3: bound the fallback strip — without a cap, a header with no
            // blank line after it would eat the remainder of the prompt.
            const head = lines.slice(0, FALLBACK_MAX_LINES);
            const remainder = lines.slice(FALLBACK_MAX_LINES);
            const joined = head.join("\n");
            const blank = joined.search(/\n\s*\n/);
            const after = blank >= 0
                ? joined.slice(blank).replace(/^\s*\n/, "") + (remainder.length ? "\n" + remainder.join("\n") : "")
                : remainder.join("\n");
            mutable.text = before + (after ? "\n\n" + after : "");
            if (mutable.text !== text)
                backupOriginalPrompt(text);
            removedBytes += verifyWrite(text, mutable.text, "fallback");
        }
    }
    // E75: update module-level stats
    if (removedBytes > 0) {
        stats.totalStripped += removedBytes;
        stats.totalPrompts++;
        stats.lastStrippedAt = new Date().toISOString();
    }
    // SC-5: asBool semantics — "0"/"false" must not enable the log gate.
    if (removedBytes > 0 && asBool(process.env.OPENCODE_STRIP_SKILLS_LOG, false)) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] removed ${removedBytes} bytes from system prompt`);
    }
}
/**
 * SC-1: verify the write took effect (a frozen part would silently ignore
 * the assignment). Returns the removed byte count, or 0 with a loud warning
 * when the write did not stick.
 */
function verifyWrite(before, after, mode) {
    if (after === before) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] WARNING: ${mode} strip matched but the write did not take effect`);
        return 0;
    }
    return before.length - after.length;
}
