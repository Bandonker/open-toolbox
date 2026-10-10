/**
 * Install the toolbox into opencode. One command, no paths to edit.
 *
 * What a machine needs, none of which it can get by cloning the repo alone:
 *
 *   1. the plugin packages built            scripts/build-packages.mjs
 *   2. a runtime npm project in the toolbox that supplies @opencode/plugin
 *      and zod, so the plugins' imports resolve from where opencode loads them
 *   3. that project installed              (creates toolbox/node_modules)
 *   4. opencode.jsonc listing every plugin by absolute path
 *   5. an @opencode/plugin exports patch, without which the loader cannot
 *      resolve the package at all on Linux
 *
 * Run it from the repo:
 *
 *   npm run setup            build + install + configure
 *   node scripts/setup.mjs --no-build   skip the rebuild
 *   node scripts/setup.mjs --check      only verify, change nothing
 *
 * Everything is derived, not assumed: the repo path comes from where this
 * script lives, the toolbox paths from $HOME, and the file: dependencies from
 * `path.relative` between the two. Nothing here is valid on one machine only.
 *
 * Idempotent — running it twice is a no-op, and it never removes a plugin the
 * user added themselves. The exports patch is copied from the repo rather than
 * inlined, so there is one source of truth for it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const packagesRoot = join(root, "packages");

const CONFIG = join(homedir(), ".config", "opencode");
const TOOLBOX = join(CONFIG, "toolbox");
const CONFIG_PKG = join(CONFIG, "package.json");
const OPENCODE_JSONC = join(CONFIG, "opencode.jsonc");
const PATCH_SRC = join(root, "scripts", "patch-plugin-exports.mjs");
const PATCH_DST = join(CONFIG, "scripts", "patch-plugin-exports.mjs");
const DEPLOY_SCRIPT = join(root, "scripts", "deploy-toolbox.mjs");

const flags = new Set(process.argv.slice(2));
const noBuild = flags.has("--no-build");
const checkOnly = flags.has("--check");

/** Where the plugin dir names come from — the built packages, which is authoritative. */
function pluginNames() {
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesRoot, e.name, "index.js")))
    .map((e) => e.name)
    .sort();
}

const die = (msg) => {
  console.error(`setup: ${msg}`);
  process.exit(1);
};

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

/** Strip comments and trailing commas so a JSONC array can be handed to JSON.parse. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Locate the `"plugins": [ ... ]` block, returning the inner text and its span. */
function findPluginsArray(text) {
  const key = /"plugins"\s*:\s*\[/g;
  let m;
  while ((m = key.exec(text))) {
    const start = m.index + m[0].length;
    // Walk forward respecting strings to find the matching `]`.
    let depth = 1;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) return { inner: text.slice(start, i), open: start, close: i };
      }
    }
  }
  return null;
}

/** The toolbox path for a plugin, as opencode.jsonc spells it. */
const pluginPath = (name) => join(TOOLBOX, name);

/**
 * Merge the toolbox plugin paths into an existing plugins array.
 *
 * Minimal by construction: when nothing is missing it returns the original text
 * untouched, and when something is missing it *appends* to the original rather
 * than reserialising the whole block. Reformatting an existing array would
 * rewrite the user's config for no semantic gain, and it is how an earlier
 * version of this emitted a duplicated `"plugins": [` and a stray `]`.
 *
 * An entry already present is the user's — including an options object they
 * hand-tuned — and is never touched, so `npm run setup` cannot clobber config.
 */
function mergePluginsArray(existing, names) {
  const inner = existing ?? "";
  // Parse defensively wrapper-free: the body is not valid JSON on its own.
  let entries = [];
  if (inner.trim() !== "") {
    try {
      entries = JSON.parse(`[${parseJsonc(inner)}]`);
    } catch (err) {
      die(`could not parse the existing "plugins" array: ${err.message}`);
    }
  }

  const present = new Set();
  for (const entry of entries) {
    const key = typeof entry === "string" ? entry : entry?.package;
    if (typeof key === "string") present.add(resolve(key));
  }

  const missing = [];
  for (const name of names) {
    const path = pluginPath(name);
    // An entry already present is the user's — including an options object they
    // hand-tuned — so only the absent ones are appended.
    if (present.has(resolve(path))) continue;
    missing.push(path);
  }

  if (missing.length === 0) return { text: inner, added: 0, entries };

  // Append, preserving the original bytes: the existing inner text keeps its own
  // indentation and formatting, and only the new lines are added. The join adds
  // the comma *between* additions; the comma after the last existing entry comes
  // from `sep` below. (An earlier version joined with "", which silently produced
  // a malformed array the moment anything was added.)
  const head = inner.replace(/\s*$/, "");
  const sep = head === "" ? "" : /,\s*$/.test(head) ? "" : ",";
  const additions = missing.map((p) => `\n    ${JSON.stringify(p)}`).join(",");
  const merged = `${head}${sep}${additions}\n  `;
  return { text: merged, added: missing.length, entries: [...entries, ...missing] };
}

function writeOpenCodeConfig(names) {
  const before = existsSync(OPENCODE_JSONC) ? readFileSync(OPENCODE_JSONC, "utf8") : null;

  if (before === null) {
    // A machine that has never run opencode. Create a config with just the
    // plugin list; opencode fills in its own defaults around it.
    const body = names.map((n) => `    ${JSON.stringify(pluginPath(n))}`).join(",\n");
    writeFileSync(
      OPENCODE_JSONC,
      `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [\n${body}\n  ]\n}\n`,
    );
    return "created";
  }

  const block = findPluginsArray(before);
  if (!block) {
    // No plugins key at all — append one before the final brace, keeping every
    // comment and key the user already has. `lastIndexOf("}")` is the outermost
    // close for a well-formed object file, so this lands at the top level.
    const merged = mergePluginsArray(null, names);
    const idx = before.lastIndexOf("}");
    if (idx < 0) die(`${OPENCODE_JSONC} has no closing brace`);
    const head = before.slice(0, idx).replace(/\s*$/, "");
    const sep = head === "" ? "" : /[,[{]\s*$/.test(head) ? "" : ",";
    // mergePluginsArray returns the array body, so the key is added here.
    const body = merged.text.replace(/\s*$/, "");
    writeFileSync(OPENCODE_JSONC, `${head}${sep}\n  "plugins": [${body}\n  ]\n}\n`);
    return `added plugins key (${merged.added})`;
  }

  const merged = mergePluginsArray(block.inner, names);

  // Nothing to add, and nothing else to change: leave the file alone. Writing
  // here would reformat the block for no semantic gain, and an earlier version
  // did exactly that — plus, when reconstructing around the array span, it emitted
  // a duplicated `"plugins": [` and a stray `]` that made the config invalid.
  if (merged.added === 0) return "already up to date";

  const after = before.slice(0, block.open) + innerWith(merged.text) + before.slice(block.close);
  writeFileSync(OPENCODE_JSONC, after);
  return `updated (${merged.added} added)`;
}

/** Rebuild the array body inside its original brackets without reserialising it. */
function innerWith(body) {
  return body.replace(/\s*$/, "");
}

/** The runtime project: relative file: links into this repo, plus the two real deps. */
function writeToolboxPackageJson(names) {
  const deps = {
    "@opencode/plugin": "^2.0.11",
    zod: "4.1.8",
  };
  // Only plugins that ship an actual package get a file: link; the rest are
  // reached through opencode.jsonc by absolute path.
  for (const name of names) {
    const pkgJson = join(packagesRoot, name, "package.json");
    if (!existsSync(pkgJson)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@")) continue;
    // Derived from the two paths, so this file is correct on any machine and
    // in any clone location — nothing in it is valid on one box only.
    deps[manifest.name] = `file:${relative(TOOLBOX, packagesRoot).replaceAll("\\", "/")}/${name}`;
  }
  const pkg = {
    name: "open-toolbox-runtime",
    private: true,
    type: "module",
    // Runs the exports patch every time this project is installed: without it
    // the v2 loader cannot resolve @opencode/plugin on Linux at all. The path is
    // relative inside the config dir, so it carries no repo location.
    scripts: {
      postinstall: "node ../scripts/patch-plugin-exports.mjs",
    },
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = JSON.stringify(pkg, null, 2) + "\n";
  const path = join(TOOLBOX, "package.json");
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  return Object.keys(deps).length;
}

/**
 * The config-root project. Deliberately says nothing about the repo: it exists
 * so `~/.config/opencode/node_modules` has the shared deps and so the patch runs
 * after any install that reinstalls them. No path to the toolbox is hardcoded,
 * because this file outlives any particular checkout.
 */
function writeConfigPackageJson() {
  const pkg = existsSync(CONFIG_PKG) ? JSON.parse(readFileSync(CONFIG_PKG, "utf8")) : {};
  const next = {
    name: "opencode",
    version: pkg.version ?? "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      ...(pkg.dependencies ?? {}),
      "@opencode/plugin": "^2.0.11",
      zod: "4.1.8",
    },
    scripts: {
      ...(pkg.scripts ?? {}),
      postinstall: "node scripts/patch-plugin-exports.mjs",
    },
  };
  if (existsSync(CONFIG_PKG)) {
    const before = readFileSync(CONFIG_PKG, "utf8");
    const after = JSON.stringify(next, null, 2) + "\n";
    if (before === after) return;
    writeFileSync(CONFIG_PKG, after);
    return;
  }
  writeFileSync(CONFIG_PKG, JSON.stringify(next, null, 2) + "\n");
}

/** The two imports every built plugin needs, installed where it is loaded from. */
function runtimeInstalled() {
  for (const dep of ["@opencode/plugin", "zod"]) {
    if (!existsSync(join(TOOLBOX, "node_modules", dep, "package.json"))) return false;
  }
  return true;
}

async function verify(names) {
  let ok = 0;
  const failed = [];
  for (const name of names) {
    const entry = join(TOOLBOX, name, "index.js");
    if (!existsSync(entry)) {
      failed.push(`${name}: missing`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(entry).href + `?v=${Date.now()}`);
      if (!mod?.default) throw new Error("no plugin default export");
      ok += 1;
    } catch (err) {
      failed.push(`${name}: ${err.message.split("\n")[0]}`);
    }
  }
  return { ok, failed };
}

async function main() {
  if (!existsSync(PATCH_SRC)) die(`missing ${PATCH_SRC}`);
  const names = pluginNames();
  if (names.length === 0) die(`no built plugins under ${packagesRoot} — run the build first`);

  if (checkOnly) {
    const { ok, failed } = await verify(names);
    for (const f of failed) console.log(`  FAIL  ${f}`);
    console.log(`\n${ok}/${names.length} plugins load from ${TOOLBOX}`);
    process.exit(failed.length ? 1 : 0);
  }

  // 1. Build.
  if (!noBuild) {
    console.log("1/5  building packages…");
    sh("node", [join("scripts", "build-packages.mjs")], root);
  } else {
    console.log("1/5  skipping build");
  }

  // 2. Install the deployed plugins (symlink mode) and the runtime deps.
  console.log("2/5  linking toolbox…");
  mkdirSync(CONFIG, { recursive: true });
  mkdirSync(TOOLBOX, { recursive: true });
  sh("node", [DEPLOY_SCRIPT, "--no-build"], root);

  // 3. The exports patch must be in place before anything is installed: the
  // toolbox's own postinstall runs it, and without it the loader cannot resolve
  // @opencode/plugin on Linux at all.
  console.log("3/5  installing the @opencode/plugin patch…");
  mkdirSync(dirname(PATCH_DST), { recursive: true });
  copyFileSync(PATCH_SRC, PATCH_DST);

  // 4. The runtime project: @opencode/plugin and zod, installed where the
  // plugins are loaded from. Its postinstall runs the patch just copied.
  console.log("4/5  installing the runtime dependencies…");
  const depCount = writeToolboxPackageJson(names);
  const rel = relative(TOOLBOX, root).replaceAll("\\", "/");
  console.log(`      ${depCount} dependencies, linked from ${rel || "."}`);
  // The slow step, and the only one that talks to the network. Skipped when the
  // runtime is already installed, which is what makes this safe to run from
  // `prepare` on every `npm install` rather than once on a new machine.
  if (runtimeInstalled()) {
    console.log("      already installed, skipping npm install");
  } else {
    sh("npm", ["install", "--no-audit", "--no-fund"], TOOLBOX);
  }

  // 5. Config: the plugin list, and the config-root project's own deps.
  console.log("5/5  configuring opencode…");
  const status = writeOpenCodeConfig(names);
  console.log(`      opencode.jsonc: ${status}`);
  writeConfigPackageJson();
  sh("node", [PATCH_SRC], CONFIG);

  const { ok, failed } = await verify(names);
  console.log(`\n${ok}/${names.length} plugins load from ${TOOLBOX}`);
  for (const f of failed) console.log(`  FAIL  ${f}`);
  console.log(
    failed.length
      ? `\nSetup finished with failures. Re-run with --check to retry verification.`
      : `\nDone. Restart opencode.`,
  );
  process.exit(failed.length ? 1 : 0);
}

main();
