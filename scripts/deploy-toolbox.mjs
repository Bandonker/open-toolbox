/**
 * Deploy the built packages into the live opencode toolbox.
 *
 * The v2 loader reads plugin directories from absolute paths in opencode.jsonc
 * (`~/.config/opencode/toolbox/<dir>`), while npm publish needs `packages/<dir>`.
 * Nothing connects the two: build-packages.mjs writes into `packages/` and stops,
 * so a build silently never reached the plugins opencode actually loads. That is
 * how the toolbox drifted onto 1.0.0 vintage builds while `packages/` looked
 * current — and there was no way to tell, because the toolbox lives outside git.
 *
 * This is the missing step, meant to run at the end of a build:
 *
 *   node scripts/deploy-toolbox.mjs            build, then install (symlink mode)
 *   node scripts/deploy-toolbox.mjs --copy     install as real directories
 *   node scripts/deploy-toolbox.mjs --no-build  deploy whatever is already built
 *   node scripts/deploy-toolbox.mjs --check     report drift, change nothing
 *
 * Symlink is the default because it removes the deploy step entirely: the toolbox
 * becomes `packages/`, so a rebuild is live the moment it lands and drift is
 * structurally impossible. The cost is that opencode then depends on the repo
 * staying at its current path. --copy trades that for self-contained installs:
 * each toolbox directory is real, survives the repo moving, and needs a deploy
 * after every build. In both modes a build is already load-verified, so deploy
 * compares bytes rather than importing.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const packagesRoot = resolve(root, "packages");
const TOOLBOX = join(homedir(), ".config", "opencode", "toolbox");

const flags = new Set(process.argv.slice(2));
const checkOnly = flags.has("--check");
const noBuild = flags.has("--no-build");
const copyMode = flags.has("--copy");
const mode = copyMode ? "copy" : "link";

/** The top-level files a deployed plugin carries. `lib/` is handled separately. */
const TOP_FILES = new Set(["index.js", "helpers.js", "package.json", "README.md", "LICENSE"]);

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

/** Relative paths of everything that should be deployed for `dir`. */
function deployFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory() && entry.name === "lib") {
      for (const sub of readdirSync(abs, { withFileTypes: true })) {
        if (sub.isFile()) files.push(`lib/${sub.name}`);
      }
    } else if (entry.isFile() && TOP_FILES.has(entry.name)) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

function fileMap(dir) {
  const map = {};
  for (const rel of deployFiles(dir)) map[rel] = digest(join(dir, rel));
  return map;
}

function plugins() {
  if (!existsSync(packagesRoot)) die(`packages/ not found — run the build first`);
  const names = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "index.js")))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) die(`no built plugins under ${packagesRoot}`);
  return names;
}

/** Why `name` in the toolbox does not match `packages/`, or null when it does. */
function drift(name) {
  const src = join(packagesRoot, name);
  const dst = join(TOOLBOX, name);
  if (!existsSync(join(dst, "index.js"))) return "missing from toolbox";
  const want = fileMap(src);
  const got = fileMap(dst);
  const wantKeys = Object.keys(want).sort();
  const gotKeys = Object.keys(got).sort();
  if (wantKeys.join() !== gotKeys.join()) {
    const missing = wantKeys.filter((k) => !gotKeys.includes(k));
    const extra = gotKeys.filter((k) => !wantKeys.includes(k));
    return `file set differs${missing.length ? ` (missing ${missing.join(",")})` : ""}${extra.length ? ` (extra ${extra.join(",")})` : ""}`;
  }
  for (const key of wantKeys) {
    if (want[key] !== got[key]) return `${key} differs`;
  }
  return null;
}

function rsyncCopy(src, dst) {
  mkdirSync(dst, { recursive: true });
  const args = ["-a", "--delete"];
  for (const file of TOP_FILES) args.push("--include", `/${file}`);
  args.push("--include", "/lib", "--include", "/lib/**", "--exclude", "*");
  // Without --delete-excluded, rsync's exclusion also protects whatever the
  // toolbox keeps of its own (node_modules links, plugin data) from deletion.
  execFileSync("rsync", [...args, `${src}/`, `${dst}/`], { stdio: "inherit" });
}

function link(src, dst) {
  mkdirSync(TOOLBOX, { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(src, tmp);
  rmSync(dst, { recursive: true, force: true });
  renameSync(tmp, dst);
}

function deploy(name) {
  const src = join(packagesRoot, name);
  const dst = join(TOOLBOX, name);
  if (copyMode) {
    rsyncCopy(src, dst);
    return;
  }
  // A previous copy-mode install may have produced a real directory (or a
  // symlink to somewhere else); either way the link replaces it.
  link(src, dst);
}

function report(names) {
  console.log(`\nToolbox: ${TOOLBOX}  (mode: ${mode})`);
  let drifted = 0;
  for (const name of names) {
    const problem = drift(name);
    if (!problem) continue;
    drifted += 1;
    console.log(`  drift  ${name.padEnd(22)} ${problem}`);
  }
  if (drifted === 0) console.log(`  ${names.length} plugins, all in sync with packages/`);
  return drifted;
}

async function main() {
  const names = plugins();

  // `prepare` runs this on every `npm install`, including on a machine (CI, a
  // fresh clone) that has no opencode config to keep in sync. There is nothing
  // to deploy there, and failing the install over it would be a false alarm —
  // so report it and stop short of creating the directory just to fill it.
  const toolboxRoot = resolve(TOOLBOX, "..");
  if (!existsSync(toolboxRoot) && !flags.has("--force")) {
    console.log(`deploy: no ${toolboxRoot} on this machine — nothing to keep in sync, skipping`);
    return;
  }

  if (checkOnly) {
    const drifted = report(names);
    console.log(`\n${drifted} of ${names.length} drift from packages/`);
    process.exit(drifted === 0 ? 0 : 1);
  }

  if (!noBuild) {
    console.log("Building packages…\n");
    execFileSync("node", [join("scripts", "build-packages.mjs")], { cwd: root, stdio: "inherit" });
  }

  mkdirSync(TOOLBOX, { recursive: true });
  console.log(`\nDeploying ${names.length} plugins into ${TOOLBOX} (${mode})`);

  let failed = 0;
  for (const name of names) {
    try {
      deploy(name);
      // The build imports every entry to prove it loads, so identical bytes here
      // are proof by construction; importing again would repeat provider side
      // effects for no extra information.
      const problem = drift(name);
      if (problem) throw new Error(problem);
      console.log(`  ok    ${name.padEnd(22)} ${digest(join(TOOLBOX, name, "index.js"))}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name.padEnd(22)} ${err.message.split("\n")[0]}`);
    }
  }

  const drifted = report(names);
  console.log(
    `\n${names.length - failed} deployed, ${failed} failed, ${drifted} drifting.` +
      (failed || drifted ? "" : " Toolbox matches packages/."),
  );
  process.exit(failed || drifted ? 1 : 0);
}

main();
