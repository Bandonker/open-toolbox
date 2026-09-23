/**
 * The deterministic synthetic coding session both savings benchmarks replay, so
 * an apples-to-apples comparison always sees the same bytes.
 *
 * A growing, realistic log: big reads, re-reads of the same file (superseded +
 * duplicate), an errored command, small stale outputs, and assistant prose.
 */
export const CHARS_PER_TOKEN = 3.6;

const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda".split(" ");

/** Deterministic filler so every run measures the same thing. */
export function filler(chars) {
  let out = "";
  let i = 0;
  while (out.length < chars) {
    out += `${WORDS[i % WORDS.length]}${(i * 2654435761) % 97} `;
    i++;
  }
  return out.slice(0, chars);
}

export function transcript(turn) {
  const messages = [];
  for (let t = 0; t <= turn; t++) {
    messages.push({
      id: `u${t}`,
      role: "user",
      content: [{ type: "text", id: `utxt${t}`, text: `Request ${t}: ${filler(300)}` }],
    });
    messages.push({
      id: `a${t}`,
      role: "assistant",
      content: [
        { type: "text", id: `atxt${t}`, text: `Working on step ${t}: ${filler(2600)}` },
        { type: "tool-call", id: `call_read_${t}`, name: "read", input: { filePath: `src/file${t % 4}.ts` } },
      ],
    });
    messages.push({
      id: `r${t}`,
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: `call_read_${t}`,
          name: "read",
          result: { type: "text", value: `export const file${t % 4} = {\n${filler(3800 + (t % 3) * 1700)}\n};` },
        },
      ],
    });
    if (t % 3 === 0) {
      messages.push({
        id: `rb${t}`,
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: `call_bash_${t}`,
            name: "bash",
            result: { type: "error", value: `Error: command failed with exit code 1\n${filler(900)}` },
          },
        ],
      });
    }
    messages.push({
      id: `rs${t}`,
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: `call_grep_${t}`,
          name: "grep",
          result: { type: "text", value: `matches in ${t % 5} files:\n${filler(600)}` },
        },
      ],
    });
  }
  return messages;
}

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
