#!/usr/bin/env node
// WORKAROUND for an opencode v2.0.16 packaging gap -- remove once upstream is fixed.
//
// @opencode/plugin@2.0.16 declares an "exports" map for its root entry that
// publishes only the "import" and "types" conditions:
//
//   ".": { "import": "./dist/promise/index.js", "types": "./dist/promise/index.d.ts" }
//
// There is no "require" and no "default" condition. A resolver that does not
// select "import" therefore finds no match at all and reports the package as
// missing, even though the files are present and on disk. That is exactly what
// opencode's own plugin loader does on Linux:
//
//   failed to load plugin
//   cause="Cause([Die(ResolveMessage: Cannot find package '@opencode/plugin'
//            imported from ~/.config/opencode/plugins/<name>.ts)])"
//
// Verified on this machine: the same 15 plugins load under Node v24 and under
// Bun 1.4.2 from this exact directory, and `npm ls` is clean -- so the install
// is fine and the gap is in the published condition map.
//
// The fix is to add a "default" condition pointing at the same ESM entry, which
// makes the package resolvable under any condition set. Idempotent, and a no-op
// if a future release of @opencode/plugin ships the condition itself.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const pkgPath = join(
  homedir(),
  ".config/opencode/node_modules/@opencode/plugin/package.json",
)

if (!existsSync(pkgPath)) {
  // Nothing installed yet (fresh clone, or install still in progress).
  process.exit(0)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
} catch {
  process.exit(0)
}

const root = pkg?.exports?.["."]
if (!root || typeof root !== "object") process.exit(0)
if (root.default) process.exit(0) // already patched, or fixed upstream

const target = root.import
if (typeof target !== "string") process.exit(0)

root.default = target
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
console.log(
  `patched @opencode/plugin@${pkg.version}: added "default": "${target}" to exports["."]`,
)
