/**
 * Keeps the installed plugin and this repo copy in sync.
 *
 *   node sync.mjs        install: opencode-sessions/opencode-sessions.ts -> plugins/opencode-sessions.ts
 *                       (helpers.ts lives ONLY here at opencode-sessions/helpers.ts;
 *                        the installed plugin imports it via ../opencode-sessions/helpers.ts
 *                        so opencode's loader never treats it as a plugin)
 *   node sync.mjs pull   pull:    plugins/opencode-sessions.ts -> opencode-sessions/
 *
 * This folder is the source of truth; the file under plugins/ is the artifact
 * opencode actually loads. Run `install` after editing here, `pull` after editing
 * the installed file directly. Also fixes the import rewrite on install.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, "..", "plugins");

const mode = process.argv[2] === "pull" ? "pull" : "install";

const repoFile = resolve(here, "opencode-sessions.ts");
const installedFile = resolve(pluginsDir, "opencode-sessions.ts");

if (mode === "pull") {
  if (!existsSync(installedFile)) {
    console.error(`sync: source not found: ${installedFile}`);
    process.exit(1);
  }
  let src = readFileSync(installedFile, "utf8");
  // Normalize the installed import back to the repo-local form.
  src = src.replace(/from\s+["']\.\.\/opencode-sessions\/helpers\.ts["']/g, 'from "./helpers.ts"');
  mkdirSync(dirname(repoFile), { recursive: true });
  writeFileSync(repoFile, src);
  const same = readFileSync(installedFile, "utf8").replace(/from\s+["']\.\.\/opencode-sessions\/helpers\.ts["']/g, 'from "./helpers.ts"') === src;
  console.log(`sync(pull): opencode-sessions.ts  ${same ? "identical (modulo import)" : "MISMATCH"}`);
  if (!same) process.exit(1);
} else {
  if (!existsSync(repoFile)) {
    console.error(`sync: source not found: ${repoFile}`);
    process.exit(1);
  }
  if (!existsSync(resolve(here, "helpers.ts"))) {
    console.error(`sync: helpers missing: ${resolve(here, "helpers.ts")} (must live here, NOT in plugins/)`);
    process.exit(1);
  }
  let src = readFileSync(repoFile, "utf8");
  src = src.replace(/from\s+["']\.\/helpers\.ts["']/g, 'from "../opencode-sessions/helpers.ts"');
  mkdirSync(dirname(installedFile), { recursive: true });
  writeFileSync(installedFile, src);
  console.log(`sync(install): opencode-sessions.ts  installed (import -> ../opencode-sessions/helpers.ts)`);
  // Safety: a stale helpers.ts in plugins/ breaks every startup (loader treats
  // each named export as a plugin factory -> "prompt.split is not a function"
  // + cascading "config hook failed" / provider-list errors). Remove it.
  //
  // Swept case-insensitively rather than probing one exact name: on Windows and
  // default macOS `existsSync(plugins/helpers.ts)` also matches a file actually
  // named `Helpers.ts`, but on Linux it does not, so the stale copy would
  // survive the very cleanup meant to remove it and break startup there.
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === "helpers.ts") {
      rmSync(resolve(pluginsDir, entry.name), { force: true });
      console.log(`sync(install): removed stale plugins/${entry.name}`);
    }
  }
}
