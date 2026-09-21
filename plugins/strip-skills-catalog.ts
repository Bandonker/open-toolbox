import { Plugin } from "@opencode/plugin"

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
    await ctx.session.hook("context", (event) => {
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
          removedBytes += text.length - mutable.text.length
          continue
        }
        // Also strip the standalone "## Available Skills\n- **name**: ..." form
        // (subagent fmt mode, in case future opencode swaps to it).
        const hdr = "## Available Skills"
        const hdrIdx = text.indexOf(hdr)
        if (hdrIdx >= 0) {
          // Strip from "## Available Skills" to the next blank line or EOS.
          const before = text.slice(0, hdrIdx).trimEnd()
          const rest = text.slice(hdrIdx)
          // Strip until the next double newline or end of string.
          const blank = rest.search(/\n\s*\n/)
          const after = blank >= 0 ? rest.slice(blank).replace(/^\s*\n/, "") : ""
          mutable.text = before + (after ? "\n\n" + after : "")
          removedBytes += text.length - mutable.text.length
        }
      }
      if (removedBytes > 0 && process.env.OPENCODE_STRIP_SKILLS_LOG) {
        // eslint-disable-next-line no-console
        console.error(`[strip-skills-catalog] removed ${removedBytes} bytes from system prompt`)
      }
    })
  },
})

