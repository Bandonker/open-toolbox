# Opencode v2 plugin watchlist

All 16 npm plugins from `opencode.jsonc` fail under opencode v2 as of 2026-09-21
with `PluginModule.LoadError: Plugin must export a default definition with an id
and an effect or setup function`. They were removed from the active config in
this commit. Re-check each for a v2-compatible release (look for dependency on
`@opencode/plugin` replacing `@opencode-ai/plugin`, or a `Plugin.define({ id,
setup })` default export), re-add individually, and restart opencode to verify
the `failed to load plugin` WARN is gone from
`~/.local/share/opencode/log/opencode.log`.

## Likely to get v2 support (check first)

- [ ] oh-my-opencode (had 4.19.4, updated 2026-09-20 — check for newer/beta)
      repo: https://github.com/code-yeongyu/oh-my-openagent
- [ ] @tarquinen/opencode-dcp (3.2.0 attempted dual v1+v2 export 2026-09-20
      but v2 still rejects it — watch for 3.2.1+)
      repo: https://github.com/tarquinen/opencode-dcp (verify)
- [ ] github:JRedeker/opencode-morph-fast-apply (GitHub dep — check repo for v2 branch)
      repo: https://github.com/JRedeker/opencode-morph-fast-apply
      NOTE: `instructions` entry
      `node_modules/opencode-morph-fast-apply/instructions/morph-tools.md`
      in opencode.jsonc depends on this package being installed.

## Probably waiting on maintainer (check occasionally)

- [ ] @prevalentware/opencode-goal-plugin (0.1.49, still V1-only dep 2026-09-14)
- [ ] @ramtinj95/opencode-tokenscope (1.8.1, Jul 2026)
- [ ] opencode-pty (0.4.0 exists but still V1 deps — watch for next release)
- [ ] magic-compact (1.2.2, Aug 2026)
- [ ] opencode-wakatime (1.3.9, Jul 2026)
- [ ] opencode-easy-vision (1.6.1, Jul 2026)

## Likely abandoned (no update in 6+ months as of Sep 2026 — check rarely)

- [ ] opencode-notify (0.3.1, Feb 2026)
- [ ] opencode-background-agents (0.1.1, Mar 2026)
- [ ] opencode-worktree (0.4.1, Mar 2026 — ALSO had `entrypoint not found`,
      may be unpublished/renamed)
- [ ] opencode-vibeguard (0.1.0, Feb 2026)
- [ ] opencode-websearch-cited (1.2.0, Jan 2026)
- [ ] opencode-openai-codex-auth (4.4.0, Jan 2026)
- [ ] opencode-convodump (0.0.3, Feb 2026)

## How to re-check one

1. `npm view <pkg> version time.modified` — new release since Sep 2026?
2. `npm view <pkg> dependencies` — `@opencode/plugin` present (good) vs only
   `@opencode-ai/plugin` (still V1, skip).
3. Re-add to `plugins` in opencode.jsonc, restart opencode, grep log for
   `failed to load plugin.*<pkg>`. No WARN = it loads.
