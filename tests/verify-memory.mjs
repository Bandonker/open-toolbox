/**
 * Mock-context verification for the memory plugin.
 *
 * Runs the real plugin source against a stub context (no opencode server) and
 * exercises remember/dedupe/recall/forget/scope/auto-recall/stats against a
 * throwaway SQLite database.
 *
 *   node tests/verify-memory.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin resolves its database under os.homedir() at import time. Point
// that at a throwaway sandbox so this never touches the real memory DB.
const sandbox = join(tmpdir(), "opencode-toolbox-verify-memory-home");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
process.env.USERPROFILE = sandbox; // Windows
process.env.HOME = sandbox; // POSIX
process.env.OPENCODE_MEMORY_SCOPE = "project";
process.env.OPENCODE_MEMORY_TOP_K = "3";
process.env.OPENCODE_MEMORY_BUDGET_CHARS = "400";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const mod = await import(new URL("../plugins/memory.ts", import.meta.url));
check("memory exposes a default plugin", mod.default.id === "memory" && typeof mod.default.setup === "function");

const tools = {};
const hooks = {};
const toolCtx = { sessionID: "ses_mem", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} };

await mod.default.setup({
  options: {},
  location: { directory: join(sandbox, "project") },
  tool: {
    transform: async (cb) => {
      cb({ add: (t) => { tools[t.name] = t; } });
      return { dispose: async () => {} };
    },
  },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
});

const expectedTools = ["memory_remember", "memory_recall", "memory_forget", "memory_list", "memory_stats"];
check("registers all memory tools", expectedTools.every((n) => typeof tools[n]?.execute === "function"));
check("registers the context hook", typeof hooks.context === "function");

const run = (name, args) => tools[name].execute(args, toolCtx);
const idOf = (content) => Number(/#(\d+)/.exec(content ?? "")?.[1]);

// ------------------------------------------------------- remember + dedupe
const first = await run("memory_remember", { text: "The build uses bun, not npm." });
const id1 = idOf(first.content);
check("memory_remember inserts and returns an id", Number.isInteger(id1) && id1 > 0 && /Remembered/.test(first.content), first.content);

const dup = await run("memory_remember", { text: "  the build uses   bun, not npm.  " });
check("duplicate text returns the same id (dedupe)", idOf(dup.content) === id1 && /Already remembered/.test(dup.content), dup.content);

// ------------------------------------------------------- recall + forget
const recalled = await run("memory_recall", { query: "build bun" });
check("memory_recall finds the stored memory", recalled.content.includes(`#${id1}`) && /bun/i.test(recalled.content), recalled.content);

const forgot = await run("memory_forget", { id: id1 });
const afterForget = await run("memory_recall", { query: "build bun" });
check("memory_forget by id removes it", /Forgot #/.test(forgot.content) && !afterForget.content.includes(`#${id1}`), forgot.content);

// ------------------------------------------------------- scope filtering
await run("memory_remember", { text: "Shared mascot note GLOBAL", scope: "global" });
await run("memory_remember", { text: "Shared mascot note PROJECT", scope: "project" });
const globalHits = await run("memory_recall", { query: "mascot", scope: "global" });
const projectHits = await run("memory_recall", { query: "mascot", scope: "project" });
const allHits = await run("memory_recall", { query: "mascot" });
check("scope=global returns only global memories", globalHits.content.includes("GLOBAL") && !globalHits.content.includes("PROJECT"));
check("scope=project returns only project memories", projectHits.content.includes("PROJECT") && !projectHits.content.includes("GLOBAL"));
check("unscoped recall spans scopes", allHits.content.includes("GLOBAL") && allHits.content.includes("PROJECT"));

// ------------------------------------------------------- forget by query
await run("memory_remember", { text: "Quokka fact one alpha", scope: "global" });
await run("memory_remember", { text: "Quokka fact two beta", scope: "global" });
const forgotQuery = await run("memory_forget", { query: "quokka" });
check("memory_forget by query removes matches", /Forgot 2 memories/.test(forgotQuery.content), forgotQuery.content);

// ------------------------------------------------------- auto-recall
await run("memory_remember", { text: "Zebra deployment uses the blue pipeline", scope: "global", importance: 8 });
const messages = [{ role: "user", content: [{ type: "text", text: "remind me about the zebra deployment pipeline" }] }];
hooks.context({ messages, system: [], tools: {}, options: {}, sessionID: "ses_auto", model: {}, agent: "build" });
const injected = messages.filter((m) => m.role === "system");
check("auto-recall appends exactly one system message", injected.length === 1, `got ${injected.length}`);
const injectedText = injected[0]?.content?.[0]?.text ?? "";
check("auto-recall injects the matching memory", /zebra/i.test(injectedText), injectedText.slice(0, 80));
check("auto-recall respects budgetChars", injectedText.length > 0 && injectedText.length <= 400, `${injectedText.length} chars`);

const messages2 = [{ role: "user", content: [{ type: "text", text: "remind me about the zebra deployment pipeline" }] }];
hooks.context({ messages: messages2, system: [], tools: {}, options: {}, sessionID: "ses_auto", model: {}, agent: "build" });
check("second identical context call does not re-inject", messages2.filter((m) => m.role === "system").length === 0);

// ------------------------------------------------------- stats
const stats = await run("memory_stats", {});
check("memory_stats returns a string with totals + db path", typeof stats.content === "string" && /db:/.test(stats.content), stats.content.split("\n")[0]);

// Best effort: the SQLite handle stays open, so a locked file may survive rm.
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
