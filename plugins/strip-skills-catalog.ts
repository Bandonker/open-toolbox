import { Plugin } from "@opencode/plugin"
import { asBool } from "../opencode-sessions/helpers.ts"

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
        stripSkills(event)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] strip failed, leaving prompt intact: ${String(err)}`)
      }
    })
    // SC-4: return a dispose handle so the host can unsubscribe the hook.
    return async () => {
      try {
        await (hook as unknown as { dispose?: () => unknown })?.dispose?.()
      } catch {
        // Dispose is best-effort.
      }
    }
  },
})

/** Bounded fallback: how far past a dangling lead marker we strip (SC-2). */
const DANGLING_LEAD_MAX_CHARS = 2000

/** Bound for the "## Available Skills" fallback strip, in lines (SC-3). */
const FALLBACK_MAX_LINES = 100

function stripSkills(event: { system: Array<{ type: string; text?: unknown }> }): void {
  let removedBytes = 0
  for (const part of event.system) {
    if (part.type !== "text" || typeof part.text !== "string") continue
    // SystemPart.text is typed readonly; the prompt builder hands us a
    // mutable object, so mutate through a widened view.
    const mutable = part as { text: string }
    const text = part.text
    // Remove the entire skill prompt block produced by SystemPrompt.skills.
    // Layout in the binary (Cz_ formatter, verbose mode):
    //   "Skills provide specialized instructions and workflows for specific tasks.\n"
    //   "Use the skill tool to load a skill when a task matches its description.\n"
    //   "<available_skills>\n  <skill>...</skill>\n  ...\n</available_skills>"
    const lead = "Skills provide specialized instructions and workflows for specific tasks."
    const tail = "</available_skills>"
    const leadIdx = text.indexOf(lead)
    const tailIdx = text.indexOf(tail)
    if (leadIdx >= 0 && tailIdx > leadIdx) {
      const before = text.slice(0, leadIdx)
      const after = text.slice(tailIdx + tail.length)
      mutable.text = before.trimEnd() + after.replace(/^\s*\n/, "")
      removedBytes += verifyWrite(text, mutable.text, "paired")
      continue
    }
    if (leadIdx >= 0) {
      // SC-2: lead present but no closing tail — strip a bounded span after
      // the lead instead of leaving the whole block in the prompt.
      const before = text.slice(0, leadIdx).trimEnd()
      const window = text.slice(leadIdx + lead.length, leadIdx + lead.length + DANGLING_LEAD_MAX_CHARS)
      const cut = window.search(/\n\s*\n/)
      const rest = (cut >= 0 ? text.slice(leadIdx + lead.length + cut) : "").replace(/^\s*\n/, "")
      mutable.text = before + (rest ? "\n\n" + rest : "")
      removedBytes += verifyWrite(text, mutable.text, "dangling-lead")
      continue
    }
    // Also strip the standalone "## Available Skills\n- **name**: ..." form
    // (subagent fmt mode, in case future opencode swaps to it).
    const hdr = "## Available Skills"
    const hdrIdx = text.indexOf(hdr)
    if (hdrIdx >= 0) {
      const before = text.slice(0, hdrIdx).trimEnd()
      const rest = text.slice(hdrIdx)
      const lines = rest.split("\n")
      // SC-3: bound the fallback strip — without a cap, a header with no
      // blank line after it would eat the remainder of the prompt.
      const head = lines.slice(0, FALLBACK_MAX_LINES)
      const remainder = lines.slice(FALLBACK_MAX_LINES)
      const joined = head.join("\n")
      const blank = joined.search(/\n\s*\n/)
      const after =
        blank >= 0
          ? joined.slice(blank).replace(/^\s*\n/, "") + (remainder.length ? "\n" + remainder.join("\n") : "")
          : remainder.join("\n")
      mutable.text = before + (after ? "\n\n" + after : "")
      removedBytes += verifyWrite(text, mutable.text, "fallback")
    }
  }
  // SC-5: asBool semantics — "0"/"false" must not enable the log gate.
  if (removedBytes > 0 && asBool(process.env.OPENCODE_STRIP_SKILLS_LOG, false)) {
    // eslint-disable-next-line no-console
    console.error(`[strip-skills-catalog] removed ${removedBytes} bytes from system prompt`)
  }
}

/**
 * SC-1: verify the write took effect (a frozen part would silently ignore
 * the assignment). Returns the removed byte count, or 0 with a loud warning
 * when the write did not stick.
 */
function verifyWrite(before: string, after: string, mode: string): number {
  if (after === before) {
    // eslint-disable-next-line no-console
    console.error(`[strip-skills-catalog] WARNING: ${mode} strip matched but the write did not take effect`)
    return 0
  }
  return before.length - after.length
}
