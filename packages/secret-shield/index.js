import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { RULES, buildAllowList, collectFindings, readAllowFile, applyFindings, } from "./lib/redact.js";
// (Rule/Finding types moved to ../lib/redact.ts — H4.)
const MODES = ["observe", "redact", "block"];
function asBool(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string")
        return /^(1|true|yes|on)$/i.test(value.trim());
    return fallback;
}
/** E333: parse a positive float; non-numeric/non-positive values fall back. */
function asFloat(value, fallback) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    return n;
}
/** E336: parse a positive integer; non-numeric/non-positive values fall back. */
function asInt(value, fallback) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    return Math.trunc(n);
}
function asList(value) {
    if (Array.isArray(value))
        return value.filter((v) => typeof v === "string");
    if (typeof value === "string") {
        return value
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}
function asMode(value, fallback) {
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (MODES.includes(v))
            return v;
    }
    return fallback;
}
/** Best-effort read of an optional JSON config next to the audit log. */
function readConfigFile(installDir) {
    const path = join(installDir, "config.json");
    if (!existsSync(path))
        return { data: {}, error: null };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { data: parsed, error: null };
        }
        return { data: {}, error: `config.json at ${path} is not a JSON object` };
    }
    catch (err) {
        return { data: {}, error: `config.json at ${path} is unreadable: ${String(err)}` };
    }
}
function resolveConfig(options) {
    const installDir = join(homedir(), ".opencode-plugins", "secret-shield");
    const auditPath = join(installDir, "audit.jsonl");
    const { data: file, error } = readConfigFile(installDir);
    const o = { ...file, ...(options ?? {}) };
    const env = (key) => process.env[key];
    const problems = [];
    if (error)
        problems.push(error);
    const rawMode = o.mode ?? env("OPENCODE_SECRET_SHIELD_MODE");
    const modeValid = rawMode === undefined ||
        MODES.includes(String(rawMode).trim().toLowerCase());
    if (!modeValid) {
        problems.push(`invalid mode ${JSON.stringify(rawMode)} (expected one of ${MODES.join(", ")}); using "observe"`);
    }
    const mode = asMode(rawMode, "observe");
    const enabledExplicit = o.enabled !== undefined || env("OPENCODE_SECRET_SHIELD_ENABLED") !== undefined;
    // E327: per-rule disable — comma-separated rule ids from config.json or env.
    const disabledRules = [
        ...asList(o.disabledRules),
        ...asList(env("OPENCODE_SECRET_SHIELD_DISABLED_RULES")),
    ].map((id) => id.trim());
    for (const id of disabledRules) {
        if (!RULES.some((r) => r.id === id)) {
            problems.push(`unknown disabled rule id ${JSON.stringify(id)} (known: ${RULES.map((r) => r.id).join(", ")})`);
        }
    }
    const cfg = {
        enabled: asBool(o.enabled ?? env("OPENCODE_SECRET_SHIELD_ENABLED"), true),
        mode,
        entropy: asBool(o.entropy ?? env("OPENCODE_SECRET_SHIELD_ENTROPY"), true),
        // E333: configurable entropy threshold (default 3.3).
        entropyThreshold: asFloat(o.entropyThreshold ?? env("OPENCODE_SECRET_SHIELD_ENTROPY_THRESHOLD"), 3.3),
        allow: [
            ...asList(o.allow),
            ...asList(env("OPENCODE_SECRET_SHIELD_ALLOW")),
        ],
        disabledRules,
        blockEnvReads: asBool(o.blockEnvReads ?? env("OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS"), true),
        log: asBool(o.log ?? env("OPENCODE_SECRET_SHIELD_LOG"), false),
        installDir,
        auditPath,
        // E326: custom user-defined rules (only from options, not env/file)
        customRules: Array.isArray(o.customRules) ? o.customRules : [],
        // E331: baseline mode — suppress findings for known/accepted secrets
        baseline: asBool(o.baseline ?? env("OPENCODE_SECRET_SHIELD_BASELINE"), false),
        baselinePath: String(o.baselinePath ?? env("OPENCODE_SECRET_SHIELD_BASELINE_PATH") ?? join(installDir, "baseline.json")),
        // E336: configurable scan cap (default 2 MB)
        maxScanChars: asInt(o.maxScanChars ?? env("OPENCODE_SECRET_SHIELD_MAX_SCAN"), 2 * 1024 * 1024),
    };
    return { cfg, problems, enabledExplicit };
}
// --- audit trail ------------------------------------------------------------
/** Per-install HMAC key; only hashes are ever persisted, never raw secrets. */
function loadHmacKey(installDir) {
    const path = join(installDir, "hmac.key");
    try {
        if (existsSync(path)) {
            const txt = readFileSync(path, "utf8").trim();
            if (/^[0-9a-f]{32,}$/i.test(txt))
                return Buffer.from(txt, "hex");
        }
    }
    catch {
        /* fall through and mint a new key */
    }
    const key = randomBytes(32);
    try {
        mkdirSync(installDir, { recursive: true });
        writeFileSync(path, key.toString("hex"), { mode: 0o600 });
        // L88: writeFileSync mode is only applied on POSIX and only if the file
        // doesn't already exist. Explicitly chmod to ensure correct permissions.
        chmodSync(path, 0o600);
    }
    catch {
        /* best effort */
    }
    return key;
}
function createAudit(cfg) {
    const key = loadHmacKey(cfg.installDir);
    const stats = {
        findings: 0,
        byRule: new Map(),
        byLocation: new Map(),
        byAction: new Map(),
    };
    const bump = (map, k) => {
        map.set(k, (map.get(k) ?? 0) + 1);
    };
    const hash = (value) => createHmac("sha256", key).update(value).digest("hex");
    const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
    const MAX_ROTATED_AUDITS = 5;
    // H6: rotate the audit log instead of growing it unbounded. Best-effort —
    // auditing must never break a request.
    // L89: if renameSync fails (e.g. cross-device), fall back to truncating
    // the audit file so it doesn't grow unbounded.
    const rotateAudit = () => {
        try {
            if (!existsSync(cfg.auditPath))
                return;
            if (statSync(cfg.auditPath).size < MAX_AUDIT_BYTES)
                return;
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            try {
                renameSync(cfg.auditPath, join(cfg.installDir, `audit-${stamp}.jsonl`));
            }
            catch {
                // L89: rename failed — truncate the audit file as a fallback.
                writeFileSync(cfg.auditPath, "");
            }
            const old = readdirSync(cfg.installDir)
                .filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
                .sort();
            for (const f of old.slice(0, Math.max(0, old.length - MAX_ROTATED_AUDITS))) {
                rmSync(join(cfg.installDir, f));
            }
        }
        catch {
            /* ignore rotation failures */
        }
    };
    const record = (findings, location, action) => {
        if (!findings.length)
            return;
        const ts = new Date().toISOString();
        const lines = [];
        for (const f of findings) {
            stats.findings += 1;
            bump(stats.byRule, f.rule);
            bump(stats.byLocation, location);
            bump(stats.byAction, action);
            lines.push(JSON.stringify({
                ts,
                rule: f.rule,
                category: f.category,
                location,
                action,
                valueHash: hash(f.value),
            }));
        }
        try {
            mkdirSync(cfg.installDir, { recursive: true });
            rotateAudit();
            appendFileSync(cfg.auditPath, `${lines.join("\n")}\n`, { mode: 0o600 });
        }
        catch {
            /* auditing must never break a request */
        }
    };
    // SS-1: expose the FULL 64-hex HMAC as well. Baseline entries store the
    // full fingerprint — the 16-hex truncation is a display form only (and a
    // legacy baseline-file form matched as a hash prefix).
    return {
        record,
        stats,
        fingerprint: (v) => hash(v).slice(0, 16),
        fingerprintFull: (v) => hash(v),
    };
}
// --- protected paths (block mode only) --------------------------------------
const SELF_FILES = new Set([
    "audit.jsonl",
    ".secret-shield-allow",
    "secret-shield.json",
    "hmac.key",
    "config.json",
]);
function isProtectedPath(rawPath) {
    const b = basename(rawPath.replace(/\\/g, "/")).toLowerCase();
    if (!b)
        return false;
    if (SELF_FILES.has(b))
        return true;
    if (b === ".env" || (b.startsWith(".env.") && b !== ".env.example" && b !== ".env.schema")) {
        return true;
    }
    // L87: block .pem/.key files — intentionally broad. A file named
    // `monkey.key` or `happiness.pem` is unlikely in normal code, and the
    // false-positive cost (a write blocked) is lower than the false-negative
    // cost (a real key leaked). Users can use .secret-shield-allow to exempt.
    if (b.endsWith(".pem") || b.endsWith(".key"))
        return true;
    if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(b))
        return true;
    return false;
}
const PATH_KEYS = new Set([
    "filePath", "path", "file", "filename", "file_path", "target", "targetPath",
    "dir", "directory",
]);
// SS-8: tool parameters that carry shell one-liners rather than paths
// (`command: "cat .env"`). Scanned for protected basenames in block mode.
const COMMAND_KEYS = new Set(["command", "script", "cmd", "commands"]);
function commandMentionsProtected(cmd) {
    // L85: `=` is included in the split character class so that `KEY=VALUE`
    // style assignments are scanned. This means a VALUE that happens to be a
    // protected basename (e.g. `export KEY=id_rsa`) would trigger a false
    // positive. This is intentional — the cost of a false positive (a blocked
    // write) is lower than the cost of a false negative (a leaked secret).
    for (const tok of cmd.split(/[\s;&|'"`$(){}<>\[\],=]+/)) {
        const t = tok.trim().replace(/^[^\w.~-]+|[^\w.~-]+$/g, "");
        if (!t)
            continue;
        if (isProtectedPath(t))
            return t;
        const b = basename(t.replace(/\\/g, "/"));
        if (b && b !== t && isProtectedPath(b))
            return t;
    }
    return null;
}
/** SS-8: find the first shell one-liner token naming a protected file. */
function findCommandHit(value, depth = 0, seen) {
    if (depth > 6 || value === null || typeof value !== "object")
        return null;
    const s = seen ?? new WeakSet();
    if (s.has(value))
        return null;
    s.add(value);
    try {
        if (Array.isArray(value)) {
            for (const v of value) {
                const hit = findCommandHit(v, depth + 1, s);
                if (hit)
                    return hit;
            }
            return null;
        }
        for (const [k, v] of Object.entries(value)) {
            if (COMMAND_KEYS.has(k)) {
                const strs = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
                for (const item of strs) {
                    if (typeof item !== "string")
                        continue;
                    const hit = commandMentionsProtected(item);
                    if (hit)
                        return hit;
                }
                // A command payload need not be a flat string: `{ command: { script } }`
                // or `{ commands: [{ command }] }` shapes would otherwise skip the
                // protected-file denial entirely, so recurse into anything the flat
                // scan did not cover.
                if (v !== null && typeof v === "object") {
                    const hit = findCommandHit(v, depth + 1, s);
                    if (hit)
                        return hit;
                }
            }
            else if (v !== null && typeof v === "object") {
                const hit = findCommandHit(v, depth + 1, s);
                if (hit)
                    return hit;
            }
        }
        return null;
    }
    finally {
        s.delete(value);
    }
}
/**
 * H2: tools that may receive original placeholder values back. Restoring a
 * placeholder puts the raw secret into the tool call — that must never reach
 * a shell (argv / process logs). Fail closed: shell-type tools and unknown
 * tools are deliberately absent from this allow-list.
 *
 * SS-3: the generic verbs `create`, `update`, `insert` and `apply` were
 * dropped — they collide with common MCP tool names (Linear/Notion/GitHub
 * expose bare `create`/`update`/`insert` that post to third-party APIs), so
 * a collision restored the RAW secret into a payload whose http.request
 * scrub had already been skipped. Only specific built-in file/edit tool
 * names belong here; `apply_patch` (a concrete tool name) stays.
 */
const RESTORE_SAFE_TOOLS = new Set([
    "read", "write", "edit", "multiedit", "notebookedit", "patch",
    "apply_patch", "str_replace",
    "list", "glob", "grep", "ls", "tree", "stat", "head", "tail",
]);
function extractPaths(value, out, depth = 0) {
    if (depth > 6 || value === null || typeof value !== "object")
        return;
    for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string" && PATH_KEYS.has(k))
            out.push(v);
        else if (typeof v === "object" && v !== null)
            extractPaths(v, out, depth + 1);
    }
}
export default Plugin.define({
    id: "secret-shield",
    async setup(ctx) {
        const { cfg, problems, enabledExplicit } = resolveConfig(ctx.options);
        const log = (message) => {
            if (!cfg.log)
                return;
            try {
                console.error(`[secret-shield] ${message}`);
            }
            catch {
                /* ignore */
            }
        };
        // Never silently no-op: when the user explicitly enabled the plugin but the
        // configuration could not be read/validated, say so loudly.
        if (problems.length && (!enabledExplicit || cfg.enabled)) {
            const loud = enabledExplicit && cfg.enabled;
            for (const p of problems) {
                if (loud) {
                    try {
                        console.error(`[secret-shield] config problem: ${p}`);
                    }
                    catch {
                        /* ignore */
                    }
                }
                else {
                    log(`config warning: ${p}`);
                }
            }
        }
        const allow = buildAllowList([...cfg.allow, ...readAllowFile()]);
        // E327: filter disabled rules out of RULES at startup so every detection
        // path (hooks + tools) sees the same effective rule set.
        const disabled = new Set(cfg.disabledRules);
        const activeRules = [...RULES.filter((r) => !disabled.has(r.id)), ...cfg.customRules];
        const audit = createAudit(cfg);
        // E331/SS-1: baseline mode — suppress findings for known/accepted secrets.
        // Entries carry the FULL 64-hex fingerprint (written by
        // secret_shield_false_positive going forward); legacy files hold 16-hex
        // truncations, which are matched as a prefix of the full hash so old
        // baselines keep working. Suppression runs BEFORE audit and redaction in
        // every detection path (processText, http.request, shell env, scan).
        const baselineFull = new Set();
        const baselineLegacy = new Set();
        const addBaselineEntry = (raw) => {
            const h = raw.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(h))
                baselineFull.add(h);
            else if (/^[0-9a-f]{16}$/.test(h))
                baselineLegacy.add(h);
        };
        if (cfg.baseline && existsSync(cfg.baselinePath)) {
            try {
                const data = JSON.parse(readFileSync(cfg.baselinePath, "utf8"));
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (typeof item === "string")
                            addBaselineEntry(item);
                        else if (item && typeof item === "object" && typeof item.hash === "string") {
                            addBaselineEntry(item.hash);
                        }
                    }
                }
            }
            catch {
                /* ignore baseline parse errors */
            }
        }
        const isBaselined = (value) => {
            if (baselineFull.size === 0 && baselineLegacy.size === 0)
                return false;
            const fp = audit.fingerprintFull(value);
            return baselineFull.has(fp) || baselineLegacy.has(fp.slice(0, 16));
        };
        const dropBaselined = (findings) => findings.filter((f) => !isBaselined(f.value));
        // SS-2: truncation detection against the CONFIGURED cap. lib/redact's
        // isScanTruncated()/scanGaps() hardcode its own 2 MB default (LIB-8),
        // which silently disagrees with a custom maxScanChars — compute the
        // head/tail window gap here so it matches the cap collectFindings is
        // actually passed below.
        const scanGapsFor = (text) => {
            const cap = cfg.maxScanChars;
            if (text.length <= cap)
                return [];
            const half = Math.floor(cap / 2);
            return [[half, text.length - half]];
        };
        // SS-2: fail-closed gap splice — drop the unscanned middle so every
        // char that survives was actually scanned. JSON-shaped payloads get a
        // plain drop: the marker carries raw newlines, and injecting it mid
        // string would corrupt JSON tool args / request bodies.
        const spliceGaps = (text, gaps, counter) => {
            const jsonish = /^\s*[[{]/.test(text);
            let out = text;
            for (const [s, e] of [...gaps].sort((a, b) => b[0] - a[0])) {
                // SS-7: one redaction unit per spliced gap. counter.redacted counts
                // findings per finding; adding the spliced CHAR count here (old
                // behaviour) mixed units — a 1 MB gap outranked every finding.
                if (counter)
                    counter.redacted += 1;
                out = jsonish
                    ? out.slice(0, s) + out.slice(e)
                    : `${out.slice(0, s)}\n[secret-shield: ${e - s} unscanned chars removed]\n${out.slice(e)}`;
            }
            return out;
        };
        // Per-session placeholder nonce; the map lets execute.before restore the
        // original value for trusted local tools when the agent echoes it back.
        const nonce = randomBytes(4).toString("hex");
        const originals = new Map();
        // SS-3: cap the restore map — every redacted secret was retained for the
        // process lifetime. FIFO-evict the oldest placeholder past the cap.
        const MAX_ORIGINALS = 5000;
        const placeholderRe = new RegExp(`\\[SS:${nonce}:([A-Za-z0-9_\\-]+)\\]`, "g");
        let seq = 0;
        const makePlaceholder = (rule, value) => {
            const p = `[SS:${nonce}:${rule}-${seq++}]`;
            // FIFO eviction: when the map is full, evict the oldest placeholder.
            // Note: if a tool result still contains the evicted placeholder, it
            // will not be restored — this is a known limitation of the simple
            // FIFO policy. A more sophisticated LRU policy would track access
            // order, but FIFO is sufficient for the common case where placeholders
            // are consumed in order.
            if (originals.size >= MAX_ORIGINALS) {
                const oldest = originals.keys().next();
                if (!oldest.done)
                    originals.delete(oldest.value);
            }
            originals.set(p, value);
            return p;
        };
        /** Detect and (in redact/block) rewrite a text blob. */
        const processText = (text, location, action, counter) => {
            // SS-2/SS-5: oversize input is scanned in head/tail windows against the
            // configured cap — report the skipped middle instead of silently
            // covering just the prefix.
            let out = text;
            const gaps = scanGapsFor(out);
            let gapSpliced = false;
            if (gaps.length) {
                log(`scan truncated to head/tail windows at ${location} (input ${out.length} chars, skipped ${JSON.stringify(gaps)})`);
                if (cfg.mode !== "observe") {
                    // Fail closed: a secret sitting in the unscanned middle would
                    // otherwise flow to the provider verbatim. Splice the gap out
                    // before scanning so every surviving char is actually scanned.
                    out = spliceGaps(out, gaps, counter);
                    gapSpliced = true;
                }
            }
            // SS-1: baseline-accepted values are dropped before audit and redaction.
            // SS-2: pass the configured cap so the windowing matches scanGapsFor.
            const findings = dropBaselined(collectFindings(out, location, { entropy: cfg.entropy, rules: activeRules, entropyThreshold: cfg.entropyThreshold, maxScanChars: cfg.maxScanChars }, allow));
            if (!findings.length)
                return gapSpliced ? out : text;
            audit.record(findings, location, cfg.mode === "observe" ? "detected" : action);
            if (cfg.mode === "observe")
                return text;
            if (counter)
                counter.redacted += findings.length;
            return applyFindings(out, findings, makePlaceholder);
        };
        /** Restore plugin placeholders, then redact any remaining raw secrets. */
        const processRestoreThenRedact = (text, location, counter) => {
            if (!originals.size)
                return processText(text, location, "redacted", counter);
            const parts = text.split(placeholderRe);
            let out = "";
            for (let i = 0; i < parts.length; i++) {
                if (i % 2 === 1) {
                    const full = `[SS:${nonce}:${parts[i]}]`;
                    out += originals.get(full) ?? full;
                }
                else {
                    out += processText(parts[i], location, "redacted", counter);
                }
            }
            return out;
        };
        // SS-1: depth-capped (20) cycle-safe walker, mirroring extractPaths' cap.
        // Objects/arrays are scrubbed in place; the counter reports how many
        // findings were redacted (see SS-2 at the execute.before call site).
        const SCRUB_MAX_DEPTH = 20;
        const scrub = (node, location, useRestore, depth = 0, seen, counter) => {
            if (typeof node === "string") {
                return useRestore
                    ? processRestoreThenRedact(node, location, counter)
                    : processText(node, location, "redacted", counter);
            }
            if (depth >= SCRUB_MAX_DEPTH)
                return node;
            const s = seen ?? new WeakSet();
            if (Array.isArray(node)) {
                if (s.has(node))
                    return node;
                s.add(node);
                try {
                    for (let i = 0; i < node.length; i++) {
                        node[i] = scrub(node[i], location, useRestore, depth + 1, s, counter);
                    }
                }
                finally {
                    s.delete(node);
                }
                return node;
            }
            if (node && typeof node === "object") {
                if (s.has(node))
                    return node;
                s.add(node);
                try {
                    const obj = node;
                    for (const k of Object.keys(obj)) {
                        obj[k] = scrub(obj[k], location, useRestore, depth + 1, s, counter);
                    }
                }
                finally {
                    s.delete(node);
                }
                return node;
            }
            return node;
        };
        // --- hooks --------------------------------------------------------------
        // Backstop: covers primary, title, compaction and generate bodies — the raw
        // first message leaks through auxiliary LLM calls if this is missing.
        await ctx.session.hook("http.request", async (event) => {
            try {
                if (!cfg.enabled)
                    return;
                const req = event.request;
                const method = (req.method || "GET").toUpperCase();
                if (method === "GET" || method === "HEAD")
                    return;
                const ct = req.headers.get("content-type") ?? "";
                if (ct && !/json|text|urlencoded/i.test(ct))
                    return;
                let body = "";
                try {
                    body = await req.clone().text();
                }
                catch {
                    return;
                }
                if (!body)
                    return;
                const location = `http.request:${event.kind}`;
                // SS-2: same config-aware gap handling as processText — an oversized
                // body's unscanned middle must not leave verbatim. Fail closed: in
                // redact/block the middle is spliced out (JSON bodies get a plain
                // drop, so no mid-token marker) and only the surviving head/tail is
                // sent. In observe mode the body is untouched, as everywhere.
                let current = body;
                const gaps = scanGapsFor(current);
                let gapSpliced = false;
                if (gaps.length) {
                    log(`scan truncated to head/tail windows at ${location} (body ${current.length} chars, skipped ${JSON.stringify(gaps)})`);
                    if (cfg.mode !== "observe") {
                        current = spliceGaps(current, gaps);
                        gapSpliced = true;
                    }
                }
                // SS-1 + SS-2: baseline-accepted values suppressed; configured cap honored.
                const findings = dropBaselined(collectFindings(current, location, { entropy: cfg.entropy, rules: activeRules, entropyThreshold: cfg.entropyThreshold, maxScanChars: cfg.maxScanChars }, allow));
                if (!findings.length && !gapSpliced)
                    return;
                audit.record(findings, location, cfg.mode === "observe" ? "detected" : "redacted");
                if (cfg.mode === "observe")
                    return;
                const redacted = applyFindings(current, findings, makePlaceholder);
                // H1: rebuild Content-Length — the redacted body's byte length
                // differs, and carrying the original header makes strict servers
                // hang or reject the request.
                const headers = new Headers(req.headers);
                headers.delete("content-length");
                headers.set("content-length", String(Buffer.byteLength(redacted, "utf8")));
                // SS-6: preserve the request semantics the old minimal rebuild
                // dropped; fall back to the minimal shape if the runtime rejects
                // any propagated property (e.g. mode "navigate").
                try {
                    event.request = new Request(req.url, {
                        method: req.method,
                        headers,
                        body: redacted,
                        redirect: req.redirect,
                        credentials: req.credentials,
                        integrity: req.integrity,
                        keepalive: req.keepalive,
                        cache: req.cache,
                        mode: req.mode,
                        // Runtime-supported (undici) but absent from TS 5.8's DOM lib.
                        ...{ duplex: "half" },
                    });
                }
                catch {
                    event.request = new Request(req.url, {
                        method: req.method,
                        headers,
                        body: redacted,
                    });
                }
            }
            catch (err) {
                log(`http.request hook skipped: ${String(err)}`);
            }
        });
        await ctx.session.hook("prompt", (event) => {
            try {
                if (!cfg.enabled)
                    return;
                const prompt = event.prompt;
                if (typeof prompt.text !== "string")
                    return;
                const next = processText(prompt.text, "prompt", "redacted");
                if (next !== prompt.text)
                    prompt.text = next;
            }
            catch (err) {
                log(`prompt hook skipped: ${String(err)}`);
            }
        });
        const ENV_KEY_RE = /(?:^|[_-])(?:key|token|secret|password|passwd|pwd|credential|auth)(?:$|[_-])|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret/i;
        // Values we never rewrite, even in redact/block mode: clobbering these would
        // break the child process (PATH is the classic footgun). Looked up
        // lower-cased, so entries must be lower-case.
        //
        // This list used to be Windows-only apart from PATH/HOME/TMP/SHELL/TERM, so
        // on Linux and macOS a rewrite could strip the dynamic-loader or session
        // variables a child needs to start at all. Findings are still audited
        // above this check; this only governs whether the value is replaced.
        const CRITICAL_ENV = new Set([
            // Portable / POSIX shell
            "path", "home", "pwd", "oldpwd", "shell", "term", "term_size", "colorterm",
            "lang", "lc_all", "lc_ctype", "tmpdir", "temp", "tmp", "tz",
            // Linux/BSD dynamic loader — a child cannot exec without these
            "ld_preload", "ld_library_path", "ld_audit", "libpath",
            // Linux/BSD session, display and IPC
            "xdg_config_home", "xdg_data_home", "xdg_state_home", "xdg_cache_home",
            "xdg_runtime_dir", "xdg_config_dirs", "xdg_data_dirs", "xdg_session_type",
            "xdg_session_id", "xdg_session_class", "xdg_session_desktop",
            "display", "wayland_display", "xauthority", "session_manager",
            "dbus_session_bus_address", "dbus_system_bus_address",
            "virtual_desktop", "desktop_session", "ssh_auth_sock", "gpg_tty",
            // macOS dynamic loader (same hazard as LD_*) and Homebrew prefix
            "dyld_insert_libraries", "dyld_library_path", "dyld_fallback_library_path",
            "dyld_frameworks_path", "homebrew_prefix", "homebrew_cellar",
            // Toolchain roots: clobbering these breaks the very commands we guard
            "java_home", "sdkman_root", "gradle_home", "nvm_dir", "pnpm_home",
            "volta_home", "cargo_home", "rustup_home", "goroot", "gopath",
            // Windows shell and system locations
            "pathext", "systemroot", "windir", "comspec", "userprofile",
            "systemdrive", "psmodulepath", "number_of_processors",
            "programfiles", "programfiles(x86)", "programw6432",
            "commonprogramfiles", "commonprogramfiles(x86)", "allusersprofile", "public",
        ]);
        await ctx.shell.hook("create.before", (event) => {
            try {
                if (!cfg.enabled)
                    return;
                const env = event.env;
                for (const key of Object.keys(env)) {
                    const value = env[key];
                    if (typeof value !== "string" || !value)
                        continue;
                    const location = `shell.create.before:${key}`;
                    // SS-2: configured cap; SS-1: baseline-accepted findings dropped
                    // before audit/redaction.
                    const findings = dropBaselined(collectFindings(value, location, { entropy: cfg.entropy, rules: activeRules, entropyThreshold: cfg.entropyThreshold, maxScanChars: cfg.maxScanChars }, allow));
                    const named = findings.filter((f) => f.category !== "entropy");
                    const keyLooksSecret = ENV_KEY_RE.test(key);
                    const action = cfg.mode === "observe" ? "detected" : "redacted";
                    if (named.length) {
                        audit.record(named, location, action);
                    }
                    else if (keyLooksSecret && !isBaselined(value)) {
                        // SS-1: an accepted (baselined) env value skips the whole-value
                        // synthetic finding too. A secret-looking variable name with no
                        // pattern hit: flag the whole value (entropy hit or not), but
                        // only trust entropy when the name itself looks like a secret.
                        const finding = findings.length > 0
                            ? findings
                            : [{ rule: "SS_ENV_KEY", category: "env", start: 0, end: value.length, value, severity: "high" }];
                        audit.record(finding, location, action);
                    }
                    else {
                        // Entropy-only hits on ordinary variables (PATH, *_DIRS, ...) are
                        // false positives; ignore them.
                        continue;
                    }
                    if (cfg.mode === "observe")
                        continue;
                    if (CRITICAL_ENV.has(key.toLowerCase()))
                        continue;
                    env[key] = `[SS:${nonce}:ENV]`;
                }
            }
            catch (err) {
                log(`shell.create.before hook skipped: ${String(err)}`);
            }
        });
        await ctx.tool.hook("execute.before", (event) => {
            // Protected-file denial must reach the agent, so throw outside the catch.
            try {
                if (cfg.enabled && cfg.mode === "block" && cfg.blockEnvReads) {
                    const paths = [];
                    extractPaths(event.input, paths);
                    const hit = paths.find(isProtectedPath);
                    // SS-8: PATH_KEYS alone missed shell one-liners like
                    // `command: "cat .env"` — scan command-style strings too.
                    const cmdHit = hit ? null : findCommandHit(event.input);
                    const blocked = hit ?? cmdHit;
                    if (blocked) {
                        throw new Error(hit
                            ? `[secret-shield] blocked access to protected secret file "${hit}" (block mode). ` +
                                `Use secret_shield_shape or secret_shield_keys to inspect it without exposing ` +
                                `values, or secret_shield_scan to check a specific value.`
                            : `[secret-shield] blocked shell command referencing protected secret "${blocked}" (block mode). ` +
                                `Use secret_shield_shape or secret_shield_keys to inspect the file without exposing ` +
                                `values, or secret_shield_scan to check a specific value.`);
                    }
                }
            }
            catch (err) {
                if (err instanceof Error && err.message.startsWith("[secret-shield]"))
                    throw err;
                log(`execute.before path check skipped: ${String(err)}`);
            }
            try {
                if (!cfg.enabled)
                    return;
                const before = event.input;
                // SS-2: scrub() mutates objects/arrays in place and returns the same
                // reference, so `after !== before` could never be true — gate the
                // assignment on the redaction count instead.
                // H2: fail closed — only allow-listed local file tools get the raw
                // values back; shells (and unknown tools) keep the placeholders so
                // secrets never hit argv/env/logs.
                const counter = { redacted: 0 };
                const after = scrub(before, `tool.execute.before:${event.tool}`, RESTORE_SAFE_TOOLS.has(event.tool), 0, undefined, counter);
                if (counter.redacted > 0)
                    event.input = after;
            }
            catch (err) {
                log(`execute.before redaction skipped: ${String(err)}`);
            }
        });
        await ctx.tool.hook("execute.after", (event) => {
            try {
                if (!cfg.enabled || event.status !== "completed")
                    return;
                const location = `tool.execute.after:${event.tool}`;
                // SS-4: scrub the whole result — the old top-level content/output
                // handling missed nested structures. The return value must be written
                // back: scrub mutates objects/arrays in place but returns a new value
                // for primitives, so a top-level string result would otherwise keep
                // flowing to the transcript unredacted.
                event.result = scrub(event.result, location, false);
            }
            catch (err) {
                log(`execute.after hook skipped: ${String(err)}`);
            }
        });
        // --- tools --------------------------------------------------------------
        const scanReport = (text, location = "tool.secret_shield_scan") => {
            // SS-2: cap-aware truncation flag (lib's isScanTruncated hardcodes its
            // own default and would lie when maxScanChars is configured); SS-1:
            // accepted values stay suppressed in reports too, matching "future
            // detections of this value are suppressed".
            const truncated = scanGapsFor(text).length > 0;
            const findings = dropBaselined(collectFindings(text, location, { entropy: cfg.entropy, rules: activeRules, entropyThreshold: cfg.entropyThreshold, maxScanChars: cfg.maxScanChars }, allow));
            const suffix = truncated ? ` (input truncated to ${cfg.maxScanChars} chars for scan)` : "";
            if (!findings.length)
                return `No secrets detected.${suffix}`;
            const lines = findings.map((f) => `${f.rule} [${f.category}] offset=${f.start} length=${f.end - f.start}`);
            return `Detected ${findings.length} finding(s) (values withheld)${suffix}:\n${lines.join("\n")}`;
        };
        // E325: scan a file without its contents ever entering the transcript —
        // the file is read here and only the report (rule ids, offsets, lengths)
        // is returned, exactly like secret_shield_scan.
        const scanFileReport = (path) => {
            let text;
            try {
                text = readFileSync(path, "utf8");
            }
            catch (err) {
                return `Could not read ${path}: ${String(err)}`;
            }
            return scanReport(text, "tool.secret_shield_scan_file");
        };
        const statsReport = () => {
            const fmt = (m) => [...m.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "(none)";
            return [
                `mode: ${cfg.mode}`,
                `enabled: ${cfg.enabled}`,
                `entropy: ${cfg.entropy}`,
                `entropy threshold: ${cfg.entropyThreshold}`,
                `rules: ${activeRules.length} of ${RULES.length} active${cfg.disabledRules.length ? ` (disabled: ${cfg.disabledRules.join(", ")})` : ""}`,
                `allow entries: ${cfg.allow.length + readAllowFile().length}`,
                `originals: ${originals.size}`,
                `audit: ${cfg.auditPath}`,
                `findings: ${audit.stats.findings}`,
                `by rule: ${fmt(audit.stats.byRule)}`,
                `by location: ${fmt(audit.stats.byLocation)}`,
                `by action: ${fmt(audit.stats.byAction)}`,
            ].join("\n");
        };
        const parseSecretFile = (path) => {
            if (!existsSync(path))
                return { error: `File not found: ${path}` };
            let text;
            try {
                text = readFileSync(path, "utf8");
            }
            catch (err) {
                return { error: `Unreadable: ${String(err)}` };
            }
            const rows = [];
            for (const line of text.split(/\r?\n/)) {
                const t = line.trim();
                if (!t || t.startsWith("#"))
                    continue;
                const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
                if (!m)
                    continue;
                const value = m[2].trim().replace(/^["']|["']$/g, "");
                rows.push({ key: m[1], len: value.length, fp: audit.fingerprint(value) });
            }
            return { rows };
        };
        const shapeReport = (path) => {
            const parsed = parseSecretFile(path);
            if ("error" in parsed)
                return parsed.error;
            if (!parsed.rows.length)
                return `No KEY=VALUE entries found in ${path}.`;
            const width = Math.max(...parsed.rows.map((r) => r.key.length));
            const lines = parsed.rows.map((r) => `${r.key.padEnd(width)}  len=${r.len}  fp=${r.fp}`);
            return `Shape of ${path} (${parsed.rows.length} keys, no values):\n${lines.join("\n")}`;
        };
        const keysReport = (path) => {
            const parsed = parseSecretFile(path);
            if ("error" in parsed)
                return parsed.error;
            if (!parsed.rows.length)
                return `No KEY=VALUE entries found in ${path}.`;
            return `Keys in ${path} (${parsed.rows.length}):\n${parsed.rows
                .map((r) => r.key)
                .join("\n")}`;
        };
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "secret_shield_scan",
                description: "Scan a string for secrets. Returns rule ids, categories and offsets only — never the secret values.",
                input: z.object({ text: z.string() }),
                execute: async (args) => ({ content: scanReport(args.text) }),
            });
            editor.add({
                name: "secret_shield_scan_file",
                description: "Scan a file for secrets without reading it into the transcript. Returns rule ids, categories and offsets only — never the secret values.",
                input: z.object({ path: z.string() }),
                execute: async (args) => ({ content: scanFileReport(args.path) }),
            });
            editor.add({
                name: "secret_shield_stats",
                description: "Show secret-shield mode, rule count, audit path and finding totals by rule/location/action.",
                input: z.object({}),
                execute: async () => ({ content: statsReport() }),
            });
            editor.add({
                name: "secret_shield_shape",
                description: "Describe the safe shape of a secret file: key names, value lengths and a non-reversible fingerprint. Never returns values.",
                input: z.object({ path: z.string() }),
                execute: async (args) => ({ content: shapeReport(args.path) }),
            });
            editor.add({
                name: "secret_shield_keys",
                description: "List the key names in a secret file. Never returns values.",
                input: z.object({ path: z.string() }),
                execute: async (args) => ({ content: keysReport(args.path) }),
            });
            editor.add({
                name: "secret_shield_config",
                description: "Show the effective secret-shield configuration: resolved settings, active rules, config problems, set env vars, and allow-list sources.",
                input: z.object({}),
                execute: async () => {
                    const ENV_KEYS = [
                        "OPENCODE_SECRET_SHIELD_ENABLED",
                        "OPENCODE_SECRET_SHIELD_MODE",
                        "OPENCODE_SECRET_SHIELD_ENTROPY",
                        "OPENCODE_SECRET_SHIELD_ENTROPY_THRESHOLD",
                        "OPENCODE_SECRET_SHIELD_ALLOW",
                        "OPENCODE_SECRET_SHIELD_DISABLED_RULES",
                        "OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS",
                        "OPENCODE_SECRET_SHIELD_LOG",
                    ];
                    const setEnv = ENV_KEYS.filter((k) => process.env[k] !== undefined);
                    const allowFileEntries = readAllowFile().length;
                    const lines = [
                        `enabled: ${cfg.enabled}`,
                        `mode: ${cfg.mode}`,
                        `entropy: ${cfg.entropy}`,
                        `entropyThreshold: ${cfg.entropyThreshold}`,
                        `rules: ${activeRules.length} of ${RULES.length} active`,
                        `disabledRules: ${cfg.disabledRules.length ? cfg.disabledRules.join(", ") : "(none)"}`,
                        `allow: ${cfg.allow.length} entries (config.json + OPENCODE_SECRET_SHIELD_ALLOW) + ${allowFileEntries} from .secret-shield-allow`,
                        `blockEnvReads: ${cfg.blockEnvReads}`,
                        `log: ${cfg.log}`,
                        `installDir: ${cfg.installDir}`,
                        `auditPath: ${cfg.auditPath}`,
                        `hmacKey: <redacted>`,
                        `env vars set: ${setEnv.length ? setEnv.join(", ") : "(none)"}`,
                        `config problems: ${problems.length ? problems.join(" | ") : "(none)"}`,
                    ];
                    return { content: lines.join("\n") };
                },
            });
            // E328: audit log query tool
            editor.add({
                name: "secret_shield_audit",
                description: "Query the secret-shield audit log. Filter by rule, location, action, or date range. Returns matching entries (values are hashed).",
                input: z.object({
                    rule: z.string().optional().describe("Filter by rule id."),
                    location: z.string().optional().describe("Filter by location (substring match)."),
                    action: z.string().optional().describe("Filter by action."),
                    since: z.string().optional().describe("Only entries at or after this ISO date."),
                    until: z.string().optional().describe("Only entries at or before this ISO date."),
                    limit: z.number().int().positive().optional().describe("Max entries to return (default 100)."),
                }),
                execute: async (args) => {
                    const { rule, location, action, since, until, limit } = args;
                    if (!existsSync(cfg.auditPath)) {
                        return { content: "No audit log found." };
                    }
                    const sinceMs = since ? Date.parse(since) : null;
                    const untilMs = until ? Date.parse(until) : null;
                    const entries = [];
                    try {
                        const text = readFileSync(cfg.auditPath, "utf8");
                        for (const line of text.split("\n")) {
                            const t = line.trim();
                            if (!t)
                                continue;
                            try {
                                const entry = JSON.parse(t);
                                if (!entry || typeof entry !== "object")
                                    continue;
                                const e = entry;
                                if (rule && e.rule !== rule)
                                    continue;
                                if (location && !String(e.location ?? "").includes(location))
                                    continue;
                                if (action && e.action !== action)
                                    continue;
                                const ts = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
                                if (sinceMs !== null && !Number.isNaN(sinceMs) && !Number.isNaN(ts) && ts < sinceMs)
                                    continue;
                                if (untilMs !== null && !Number.isNaN(untilMs) && !Number.isNaN(ts) && ts > untilMs)
                                    continue;
                                entries.push(t);
                            }
                            catch {
                                /* skip malformed lines */
                            }
                        }
                    }
                    catch {
                        return { content: "Could not read audit log." };
                    }
                    const max = limit ?? 100;
                    const sliced = entries.slice(-max);
                    if (!sliced.length) {
                        return { content: "No matching audit entries." };
                    }
                    return { content: `Audit entries (${sliced.length} of ${entries.length} matching):\n${sliced.join("\n")}` };
                },
            });
            // E332: project-wide scan tool
            editor.add({
                name: "secret_shield_scan_project",
                description: "Scan an entire project directory for secrets. Walks all files, scans each for findings, and returns a summary (file, rule, category, offset, length). Never returns secret values.",
                input: z.object({
                    path: z.string().optional().describe("Project root (default: current directory)."),
                    maxFiles: z.number().int().positive().optional().describe("Max files to scan (default 1000)."),
                }),
                execute: async (args) => {
                    const { path, maxFiles } = args;
                    const root = path || process.cwd();
                    if (!existsSync(root)) {
                        return { content: `Path not found: ${root}` };
                    }
                    const { readdirSync, statSync } = await import("fs");
                    const { join, relative, extname } = await import("path");
                    const SKIP_DIRS = new Set(["node_modules", ".git", ".opencode", "dist", "build", ".next", ".nuxt", "vendor", "__pycache__", ".venv", "venv"]);
                    const SKIP_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".avi", ".mov", ".pdf", ".zip", ".tar", ".gz", ".rar", ".7z", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3"]);
                    const results = [];
                    let scanned = 0;
                    const max = maxFiles ?? 1000;
                    const walk = (dir) => {
                        if (scanned >= max)
                            return;
                        let entries;
                        try {
                            entries = readdirSync(dir);
                        }
                        catch {
                            return;
                        }
                        for (const entry of entries) {
                            if (scanned >= max)
                                return;
                            const full = join(dir, entry);
                            let stat;
                            try {
                                stat = statSync(full);
                            }
                            catch {
                                continue;
                            }
                            if (stat.isDirectory()) {
                                if (SKIP_DIRS.has(entry))
                                    continue;
                                walk(full);
                            }
                            else if (stat.isFile()) {
                                if (SKIP_EXTS.has(extname(entry).toLowerCase()))
                                    continue;
                                if (stat.size > 1024 * 1024)
                                    continue; // skip files > 1MB
                                scanned++;
                                try {
                                    const text = readFileSync(full, "utf8");
                                    // SS-2: configured cap; SS-1: baseline-accepted findings
                                    // are suppressed here too.
                                    const findings = dropBaselined(collectFindings(text, `project:${relative(root, full)}`, { entropy: cfg.entropy, rules: activeRules, entropyThreshold: cfg.entropyThreshold, maxScanChars: cfg.maxScanChars }, allow));
                                    for (const f of findings) {
                                        results.push(`${relative(root, full)}: ${f.rule} [${f.category}] offset=${f.start} length=${f.end - f.start}`);
                                    }
                                }
                                catch {
                                    /* skip unreadable files */
                                }
                            }
                        }
                    };
                    walk(root);
                    if (!results.length) {
                        return { content: `No secrets found in ${root} (${scanned} files scanned).` };
                    }
                    return { content: `Found ${results.length} finding(s) in ${scanned} files:\n${results.join("\n")}` };
                },
            });
            // E334: false-positive feedback tool
            editor.add({
                name: "secret_shield_false_positive",
                description: "Mark a finding as a false positive. The value hash is stored in the baseline file and future detections of the same value will be suppressed.",
                input: z.object({
                    value: z.string().describe("The secret value that was a false positive."),
                    rule: z.string().optional().describe("The rule that triggered the finding."),
                }),
                execute: async (args) => {
                    const { value, rule } = args;
                    // SS-1: record the FULL 64-hex fingerprint — that is the form the
                    // suppression lookup uses (legacy 16-hex entries in an existing
                    // baseline.json keep working via prefix match). Re-recording an
                    // accepted value is a no-op instead of a duplicate entry.
                    const hash = audit.fingerprintFull(value);
                    if (isBaselined(value)) {
                        return { content: `Already recorded as a false positive (hash: ${hash}).` };
                    }
                    try {
                        mkdirSync(cfg.installDir, { recursive: true });
                        let existing = [];
                        if (existsSync(cfg.baselinePath)) {
                            try {
                                const data = JSON.parse(readFileSync(cfg.baselinePath, "utf8"));
                                if (Array.isArray(data))
                                    existing = data;
                            }
                            catch {
                                /* start fresh */
                            }
                        }
                        existing.push({ hash, rule: rule ?? "unknown", at: new Date().toISOString() });
                        writeFileSync(cfg.baselinePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
                        // L88: writeFileSync mode is only applied on POSIX and only if
                        // the file doesn't already exist. Explicitly chmod to ensure
                        // correct permissions after a rewrite.
                        try {
                            chmodSync(cfg.baselinePath, 0o600);
                        }
                        catch {
                            /* best effort */
                        }
                        // Also add to the in-memory baseline.
                        addBaselineEntry(hash);
                        const note = cfg.baseline
                            ? " Future detections of this value will be suppressed."
                            : " Note: baseline mode is off (set baseline: true / OPENCODE_SECRET_SHIELD_BASELINE=1) — suppression is not active.";
                        return { content: `Recorded false positive (hash: ${hash}).${note}` };
                    }
                    catch (err) {
                        return { content: `Could not record false positive: ${String(err)}` };
                    }
                },
            });
            // E335: audit log export tool
            editor.add({
                name: "secret_shield_audit_export",
                description: "Export the secret-shield audit log to a file. Returns the path to the exported file.",
                input: z.object({
                    dest: z.string().optional().describe("Export file path (default: <installDir>/audit-export.jsonl)."),
                }),
                execute: async (args) => {
                    const { dest } = args;
                    if (!existsSync(cfg.auditPath)) {
                        return { content: "No audit log found." };
                    }
                    const target = dest || join(cfg.installDir, `audit-export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
                    try {
                        mkdirSync(cfg.installDir, { recursive: true });
                        const { copyFileSync } = await import("fs");
                        copyFileSync(cfg.auditPath, target);
                        return { content: `Audit log exported to ${target}` };
                    }
                    catch (err) {
                        return { content: `Could not export audit log: ${String(err)}` };
                    }
                },
            });
        });
    },
});
