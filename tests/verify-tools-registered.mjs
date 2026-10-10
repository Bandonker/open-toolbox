/**
 * Every plugin must register its tools after install.
 *
 * A plugin that throws during setup, or that never reaches `ctx.tool.transform`,
 * still installs cleanly — opencode just runs without its tools. Nothing else
 * fails loudly, so "installed" and "usable" can silently diverge. This is the
 * check that keeps them the same: load each installed plugin through a faithful
 * opencode Context and confirm its tools actually got added.
 *
 * Run it against the *installed* toolbox, not packages/, because that is what
 * opencode loads:
 *
 *   node tests/verify-tools-registered.mjs
 *
 * The Context is a no-op stand-in. That is deliberate and sufficient: the point
 * is that setup() completes and `editor.add` is reached, not that the domains
 * behave. A plugin that needs a real domain to survive will fail here and say so.
 */
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const TOOLBOX = join(root, "..", "..", ".config", "opencode", "toolbox");

if (!existsSync(TOOLBOX)) {
  console.log(`toolbox not found at ${TOOLBOX} — run \`npm run setup\` first`);
  process.exit(0);
}

/** A registration opencode would hand back; dispose is all any test needs. */
const registration = () => ({ dispose: async () => {} });

const editor = (tools) => ({
  add: (tool) => {
    tools[tool.name] = tool;
    return registration();
  },
  list: () => [],
  get: () => undefined,
  namespace: () => {},
  update: () => {},
  remove: () => {},
});

/** Every domain a plugin may reach for, each a no-op that never throws. */
const domain = () => ({
  hook: async () => registration(),
  transform: async (cb) => {
    cb(editor({}));
    return registration();
  },
});

/** One Context, faithful in shape: every key the plugin API declares. */
function makeContext(tools) {
  return {
    app: { log: async () => {}, error: async () => {} },
    options: {},
    location: { directory: root, worktree: root },
    agent: domain(),
    aisdk: domain(),
    command: domain(),
    event: { subscribe: async function* () {}, ...domain() },
    experimental: { terminal: domain() },
    integration: domain(),
    mcp: domain(),
    model: domain(),
    generate: async () => ({}),
    permission: domain(),
    plugin: { list: async () => [] },
    provider: domain(),
    reference: domain(),
    rpc: domain(),
    session: { hook: async () => registration(), ...domain() },
    shell: domain(),
    skill: domain(),
    storage: domain(),
    tool: {
      transform: async (cb) => {
        cb(editor(tools));
        return registration();
      },
      hook: async () => registration(),
      reload: async () => {},
      list: async () => [],
    },
    vcs: domain(),
    websearch: domain(),
    worktree: domain(),
  };
}

// Link mode makes each toolbox entry a symlink, so statSync — which follows
// links — decides membership rather than the dirent type.
const plugins = readdirSync(TOOLBOX, { withFileTypes: true })
  .filter((entry) => {
    try {
      return statSync(join(TOOLBOX, entry.name)).isDirectory() && entry.name !== "node_modules";
    } catch {
      return false;
    }
  })
  .map((entry) => entry.name)
  .sort();

assert.ok(plugins.length > 0, `no plugins found under ${TOOLBOX}`);

let failed = 0;
let totalTools = 0;
const report = [];

for (const name of plugins) {
  const entry = join(TOOLBOX, name, "index.js");
  const tools = {};
  try {
    const mod = await import(entry);
    assert.equal(typeof mod.default?.setup, "function", `${name}: no setup()`);
    await mod.default.setup(makeContext(tools));
    const names = Object.keys(tools);
    totalTools += names.length;
    report.push(`ok   ${name.padEnd(22)} ${String(names.length).padStart(3)} tools`);
  } catch (err) {
    failed += 1;
    report.push(`FAIL ${name.padEnd(22)} ${String(err.message).split("\n")[0]}`);
  }
}

for (const line of report) console.log(`  ${line}`);
console.log(
  `\n${plugins.length} plugins, ${totalTools} tools registered, ${failed} failed to load.`,
);

if (failed > 0) process.exit(1);
console.log("verify-tools: all plugins register their tools");
// Plugin setups can leave timers, DB handles or async iterators open, so the
// process would otherwise never exit. The result is already known here.
process.exit(0);
