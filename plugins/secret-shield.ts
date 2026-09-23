import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import {
  RULES,
  buildAllowList,
  collectFindings,
  isScanTruncated,
  readAllowFile,
  applyFindings,
  type AllowList,
  type Finding,
} from "../lib/redact.ts";

/**
 * secret-shield
 *
 * A v2-native secret detector/redactor. opencode-vibeguard (the closest peer)
 * ships an artifact with no default export, so on the v2 plugin API it silently
 * no-ops — this plugin exists to actually work there. Where peers stop at prompt
 * text, secret-shield also scrubs the *outbound HTTP body* (session-title,
 * compaction and generate calls carry the raw first message), mutates tool
 * arguments and results, and scrubs child-process environments.
 *
 * Modes:
 *   observe (default) — detect + audit only; nothing is ever mutated.
 *   redact            — replace matches with hardened per-session placeholders.
 *   block             — redact everywhere, plus deny reads/edits of protected
 *                       secret files (best-effort; only active in this mode).
 *
 * Matching is intentionally linear-time: every rule uses bounded, non-nested
 * quantifiers and no backreferences, so no input can trigger catastrophic
 * backtracking. A keyword prefilter gates the context-style rules and a Shannon
 * entropy fallback (gated by stopwords) catches unlabelled high-entropy tokens.
 *
 * All hooks are wrapped in try/catch and can never break a request.
 */

type Mode = "observe" | "redact" | "block";

type ShieldConfig = {
  enabled: boolean;
  mode: Mode;
  entropy: boolean;
  allow: string[];
  blockEnvReads: boolean;
  log: boolean;
  installDir: string;
  auditPath: string;
};

// (Rule/Finding types moved to ../lib/redact.ts — H4.)

const MODES: ReadonlyArray<Mode> = ["observe", "redact", "block"];

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asMode(value: unknown, fallback: Mode): Mode {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if ((MODES as ReadonlyArray<string>).includes(v)) return v as Mode;
  }
  return fallback;
}

type ConfigResult = {
  cfg: ShieldConfig;
  problems: string[];
  enabledExplicit: boolean;
};

/** Best-effort read of an optional JSON config next to the audit log. */
function readConfigFile(installDir: string): { data: Record<string, unknown>; error: string | null } {
  const path = join(installDir, "config.json");
  if (!existsSync(path)) return { data: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, error: null };
    }
    return { data: {}, error: `config.json at ${path} is not a JSON object` };
  } catch (err) {
    return { data: {}, error: `config.json at ${path} is unreadable: ${String(err)}` };
  }
}

function resolveConfig(options: Record<string, unknown> | undefined): ConfigResult {
  const installDir = join(homedir(), ".opencode-plugins", "secret-shield");
  const auditPath = join(installDir, "audit.jsonl");
  const { data: file, error } = readConfigFile(installDir);
  const o: Record<string, unknown> = { ...file, ...(options ?? {}) };
  const env = (key: string): string | undefined => process.env[key];
  const problems: string[] = [];
  if (error) problems.push(error);

  const rawMode = o.mode ?? env("OPENCODE_SECRET_SHIELD_MODE");
  const modeValid =
    rawMode === undefined ||
    (MODES as ReadonlyArray<string>).includes(String(rawMode).trim().toLowerCase());
  if (!modeValid) {
    problems.push(
      `invalid mode ${JSON.stringify(rawMode)} (expected one of ${MODES.join(", ")}); using "observe"`,
    );
  }
  const mode = asMode(rawMode, "observe");

  const enabledExplicit =
    o.enabled !== undefined || env("OPENCODE_SECRET_SHIELD_ENABLED") !== undefined;

  const cfg: ShieldConfig = {
    enabled: asBool(o.enabled ?? env("OPENCODE_SECRET_SHIELD_ENABLED"), true),
    mode,
    entropy: asBool(o.entropy ?? env("OPENCODE_SECRET_SHIELD_ENTROPY"), true),
    allow: [
      ...asList(o.allow),
      ...asList(env("OPENCODE_SECRET_SHIELD_ALLOW")),
    ],
    blockEnvReads: asBool(
      o.blockEnvReads ?? env("OPENCODE_SECRET_SHIELD_BLOCK_ENV_READS"),
      true,
    ),
    log: asBool(o.log ?? env("OPENCODE_SECRET_SHIELD_LOG"), false),
    installDir,
    auditPath,
  };
  return { cfg, problems, enabledExplicit };
}

// --- audit trail ------------------------------------------------------------

/** Per-install HMAC key; only hashes are ever persisted, never raw secrets. */
function loadHmacKey(installDir: string): Buffer {
  const path = join(installDir, "hmac.key");
  try {
    if (existsSync(path)) {
      const txt = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f]{32,}$/i.test(txt)) return Buffer.from(txt, "hex");
    }
  } catch {
    /* fall through and mint a new key */
  }
  const key = randomBytes(32);
  try {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  } catch {
    /* best effort */
  }
  return key;
}

type AuditStats = {
  findings: number;
  byRule: Map<string, number>;
  byLocation: Map<string, number>;
  byAction: Map<string, number>;
};

function createAudit(cfg: ShieldConfig): {
  record: (findings: ReadonlyArray<Finding>, location: string, action: string) => void;
  stats: AuditStats;
  fingerprint: (value: string) => string;
} {
  const key = loadHmacKey(cfg.installDir);
  const stats: AuditStats = {
    findings: 0,
    byRule: new Map(),
    byLocation: new Map(),
    byAction: new Map(),
  };
  const bump = (map: Map<string, number>, k: string): void => {
    map.set(k, (map.get(k) ?? 0) + 1);
  };
  const hash = (value: string): string =>
    createHmac("sha256", key).update(value).digest("hex");

  const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
  const MAX_ROTATED_AUDITS = 5;

  // H6: rotate the audit log instead of growing it unbounded. Best-effort —
  // auditing must never break a request.
  const rotateAudit = (): void => {
    try {
      if (!existsSync(cfg.auditPath)) return;
      if (statSync(cfg.auditPath).size < MAX_AUDIT_BYTES) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(cfg.auditPath, join(cfg.installDir, `audit-${stamp}.jsonl`));
      const old = readdirSync(cfg.installDir)
        .filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - MAX_ROTATED_AUDITS))) {
        rmSync(join(cfg.installDir, f));
      }
    } catch {
      /* ignore rotation failures */
    }
  };

  const record = (
    findings: ReadonlyArray<Finding>,
    location: string,
    action: string,
  ): void => {
    if (!findings.length) return;
    const ts = new Date().toISOString();
    const lines: string[] = [];
    for (const f of findings) {
      stats.findings += 1;
      bump(stats.byRule, f.rule);
      bump(stats.byLocation, location);
      bump(stats.byAction, action);
      lines.push(
        JSON.stringify({
          ts,
          rule: f.rule,
          category: f.category,
          location,
          action,
          valueHash: hash(f.value),
        }),
      );
    }
    try {
      mkdirSync(cfg.installDir, { recursive: true });
      rotateAudit();
      appendFileSync(cfg.auditPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      /* auditing must never break a request */
    }
  };

  return { record, stats, fingerprint: (v) => hash(v).slice(0, 16) };
}

// --- protected paths (block mode only) --------------------------------------

const SELF_FILES = new Set([
  "audit.jsonl",
  ".secret-shield-allow",
  "secret-shield.json",
  "hmac.key",
  "config.json",
]);

function isProtectedPath(rawPath: string): boolean {
  const b = basename(rawPath.replace(/\\/g, "/")).toLowerCase();
  if (!b) return false;
  if (SELF_FILES.has(b)) return true;
  if (b === ".env" || (b.startsWith(".env.") && b !== ".env.example" && b !== ".env.schema")) {
    return true;
  }
  if (b.endsWith(".pem") || b.endsWith(".key")) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(b)) return true;
  return false;
}

const PATH_KEYS = new Set([
  "filePath", "path", "file", "filename", "file_path", "target", "targetPath",
  "dir", "directory",
]);

/**
 * H2: tools that may receive original placeholder values back. Restoring a
 * placeholder puts the raw secret into the tool call — that must never reach
 * a shell (argv / process logs). Fail closed: shell-type tools and unknown
 * tools are deliberately absent from this allow-list.
 */
const RESTORE_SAFE_TOOLS = new Set([
  "read", "write", "edit", "multiedit", "notebookedit", "patch", "apply",
  "apply_patch", "create", "update", "str_replace", "insert",
  "list", "glob", "grep", "ls", "tree", "stat", "head", "tail",
]);

function extractPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && PATH_KEYS.has(k)) out.push(v);
    else if (typeof v === "object" && v !== null) extractPaths(v, out, depth + 1);
  }
}

export default Plugin.define({
  id: "secret-shield",
  async setup(ctx) {
    const { cfg, problems, enabledExplicit } = resolveConfig(
      ctx.options as unknown as Record<string, unknown> | undefined,
    );
    const log = (message: string): void => {
      if (!cfg.log) return;
      try {
        console.error(`[secret-shield] ${message}`);
      } catch {
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
          } catch {
            /* ignore */
          }
        } else {
          log(`config warning: ${p}`);
        }
      }
    }

    const allow = buildAllowList([...cfg.allow, ...readAllowFile()]);
    const audit = createAudit(cfg);

    // Per-session placeholder nonce; the map lets execute.before restore the
    // original value for trusted local tools when the agent echoes it back.
    const nonce = randomBytes(4).toString("hex");
    const originals = new Map<string, string>();
    const placeholderRe = new RegExp(`\\[SS:${nonce}:([A-Za-z0-9_\\-]+)\\]`, "g");
    let seq = 0;
    const makePlaceholder = (rule: string, value: string): string => {
      const p = `[SS:${nonce}:${rule}-${seq++}]`;
      originals.set(p, value);
      return p;
    };

    /** Detect and (in redact/block) rewrite a text blob. */
    const processText = (text: string, location: string, action: string): string => {
      // H5: oversize input is scanned head-only (see lib/redact.ts) — say so
      // instead of silently covering just the prefix.
      if (isScanTruncated(text)) {
        log(`scan truncated to 2M chars at ${location} (input ${text.length} chars)`);
      }
      const findings = collectFindings(text, location, cfg, allow);
      if (!findings.length) return text;
      audit.record(findings, location, cfg.mode === "observe" ? "detected" : action);
      if (cfg.mode === "observe") return text;
      return applyFindings(text, findings, makePlaceholder);
    };

    /** Restore plugin placeholders, then redact any remaining raw secrets. */
    const processRestoreThenRedact = (text: string, location: string): string => {
      if (!originals.size) return processText(text, location, "redacted");
      const parts = text.split(placeholderRe);
      let out = "";
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          const full = `[SS:${nonce}:${parts[i]}]`;
          out += originals.get(full) ?? full;
        } else {
          out += processText(parts[i], location, "redacted");
        }
      }
      return out;
    };

    const scrub = (node: unknown, location: string, useRestore: boolean): unknown => {
      if (typeof node === "string") {
        return useRestore
          ? processRestoreThenRedact(node, location)
          : processText(node, location, "redacted");
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = scrub(node[i], location, useRestore);
        return node;
      }
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        for (const k of Object.keys(obj)) obj[k] = scrub(obj[k], location, useRestore);
        return obj;
      }
      return node;
    };

    // --- hooks --------------------------------------------------------------

    // Backstop: covers primary, title, compaction and generate bodies — the raw
    // first message leaks through auxiliary LLM calls if this is missing.
    await ctx.session.hook("http.request", async (event) => {
      try {
        if (!cfg.enabled) return;
        const req = event.request;
        const method = (req.method || "GET").toUpperCase();
        if (method === "GET" || method === "HEAD") return;
        const ct = req.headers.get("content-type") ?? "";
        if (ct && !/json|text|urlencoded/i.test(ct)) return;
        let body = "";
        try {
          body = await req.clone().text();
        } catch {
          return;
        }
        if (!body) return;
        const location = `http.request:${event.kind}`;
        const findings = collectFindings(body, location, cfg, allow);
        if (!findings.length) return;
        audit.record(findings, location, cfg.mode === "observe" ? "detected" : "redacted");
        if (cfg.mode === "observe") return;
        const redacted = applyFindings(body, findings, makePlaceholder);
        // H1: rebuild Content-Length — the redacted body's byte length
        // differs, and carrying the original header makes strict servers
        // hang or reject the request.
        const headers = new Headers(req.headers);
        headers.delete("content-length");
        headers.set("content-length", String(Buffer.byteLength(redacted, "utf8")));
        event.request = new Request(req.url, {
          method: req.method,
          headers,
          body: redacted,
        });
      } catch (err) {
        log(`http.request hook skipped: ${String(err)}`);
      }
    });

    await ctx.session.hook("prompt", (event) => {
      try {
        if (!cfg.enabled) return;
        const prompt = event.prompt as { text?: unknown };
        if (typeof prompt.text !== "string") return;
        const next = processText(prompt.text, "prompt", "redacted");
        if (next !== prompt.text) prompt.text = next;
      } catch (err) {
        log(`prompt hook skipped: ${String(err)}`);
      }
    });

    const ENV_KEY_RE =
      /(?:^|[_-])(?:key|token|secret|password|passwd|pwd|credential|auth)(?:$|[_-])|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret/i;

    // Values we never rewrite, even in redact/block mode: clobbering these would
    // break the child process (PATH is the classic footgun).
    const CRITICAL_ENV = new Set([
      "path", "pathext", "systemroot", "windir", "comspec", "home", "userprofile",
      "temp", "tmp", "shell", "term", "lang", "pwd", "oldpwd", "psmodulepath",
    ]);

    await ctx.shell.hook("create.before", (event) => {
      try {
        if (!cfg.enabled) return;
        const env = event.env;
        for (const key of Object.keys(env)) {
          const value = env[key];
          if (typeof value !== "string" || !value) continue;
          const location = `shell.create.before:${key}`;
          const findings = collectFindings(value, location, cfg, allow);
          const named = findings.filter((f) => f.category !== "entropy");
          const keyLooksSecret = ENV_KEY_RE.test(key);
          const action = cfg.mode === "observe" ? "detected" : "redacted";
          if (named.length) {
            audit.record(named, location, action);
          } else if (keyLooksSecret) {
            // A secret-looking variable name with no pattern hit: flag the whole
            // value (entropy hit or not), but only trust entropy when the name
            // itself looks like a secret.
            const finding =
              findings.length > 0
                ? findings
                : [{ rule: "SS_ENV_KEY", category: "env", start: 0, end: value.length, value }];
            audit.record(finding, location, action);
          } else {
            // Entropy-only hits on ordinary variables (PATH, *_DIRS, ...) are
            // false positives; ignore them.
            continue;
          }
          if (cfg.mode === "observe") continue;
          if (CRITICAL_ENV.has(key.toLowerCase())) continue;
          env[key] = `[SS:${nonce}:ENV]`;
        }
      } catch (err) {
        log(`shell.create.before hook skipped: ${String(err)}`);
      }
    });

    await ctx.tool.hook("execute.before", (event) => {
      // Protected-file denial must reach the agent, so throw outside the catch.
      try {
        if (cfg.enabled && cfg.mode === "block" && cfg.blockEnvReads) {
          const paths: string[] = [];
          extractPaths(event.input, paths);
          const hit = paths.find(isProtectedPath);
          if (hit) {
            throw new Error(
              `[secret-shield] blocked access to protected secret file "${hit}" (block mode). ` +
                `Use secret_shield_shape or secret_shield_keys to inspect it without exposing ` +
                `values, or secret_shield_scan to check a specific value.`,
            );
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[secret-shield]")) throw err;
        log(`execute.before path check skipped: ${String(err)}`);
      }
      try {
        if (!cfg.enabled) return;
        const before = event.input;
        // H2: fail closed — only allow-listed local file tools get the raw
        // values back; shells (and unknown tools) keep the placeholders so
        // secrets never hit argv/env/logs.
        const after = scrub(
          before,
          `tool.execute.before:${event.tool}`,
          RESTORE_SAFE_TOOLS.has(event.tool),
        );
        if (after !== before) event.input = after;
      } catch (err) {
        log(`execute.before redaction skipped: ${String(err)}`);
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (!cfg.enabled || event.status !== "completed") return;
        const location = `tool.execute.after:${event.tool}`;
        const result = event.result as unknown as { content?: unknown; output?: unknown };
        if (typeof result.content === "string") {
          result.content = processText(result.content, location, "redacted");
        } else if (Array.isArray(result.content)) {
          for (const part of result.content as Array<Record<string, unknown>>) {
            for (const key of ["text", "value"]) {
              if (typeof part[key] === "string") {
                part[key] = processText(part[key] as string, location, "redacted");
              }
            }
          }
        }
        if (typeof result.output === "string") {
          result.output = processText(result.output, location, "redacted");
        }
      } catch (err) {
        log(`execute.after hook skipped: ${String(err)}`);
      }
    });

    // --- tools --------------------------------------------------------------

    const scanReport = (text: string): string => {
      const truncated = isScanTruncated(text);
      const findings = collectFindings(text, "tool.secret_shield_scan", cfg, allow);
      const suffix = truncated ? " (input truncated to 2M chars for scan)" : "";
      if (!findings.length) return `No secrets detected.${suffix}`;
      const lines = findings.map(
        (f) => `${f.rule} [${f.category}] offset=${f.start} length=${f.end - f.start}`,
      );
      return `Detected ${findings.length} finding(s) (values withheld)${suffix}:\n${lines.join("\n")}`;
    };

    const statsReport = (): string => {
      const fmt = (m: Map<string, number>): string =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "(none)";
      return [
        `mode: ${cfg.mode}`,
        `enabled: ${cfg.enabled}`,
        `entropy: ${cfg.entropy}`,
        `rules: ${RULES.length}`,
        `allow entries: ${cfg.allow.length + readAllowFile().length}`,
        `audit: ${cfg.auditPath}`,
        `findings: ${audit.stats.findings}`,
        `by rule: ${fmt(audit.stats.byRule)}`,
        `by location: ${fmt(audit.stats.byLocation)}`,
        `by action: ${fmt(audit.stats.byAction)}`,
      ].join("\n");
    };

    type SecretRow = { key: string; len: number; fp: string };

    const parseSecretFile = (path: string): { rows: SecretRow[] } | { error: string } => {
      if (!existsSync(path)) return { error: `File not found: ${path}` };
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        return { error: `Unreadable: ${String(err)}` };
      }
      const rows: SecretRow[] = [];
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^["']|["']$/g, "");
        rows.push({ key: m[1], len: value.length, fp: audit.fingerprint(value) });
      }
      return { rows };
    };

    const shapeReport = (path: string): string => {
      const parsed = parseSecretFile(path);
      if ("error" in parsed) return parsed.error;
      if (!parsed.rows.length) return `No KEY=VALUE entries found in ${path}.`;
      const width = Math.max(...parsed.rows.map((r) => r.key.length));
      const lines = parsed.rows.map((r) => `${r.key.padEnd(width)}  len=${r.len}  fp=${r.fp}`);
      return `Shape of ${path} (${parsed.rows.length} keys, no values):\n${lines.join("\n")}`;
    };

    const keysReport = (path: string): string => {
      const parsed = parseSecretFile(path);
      if ("error" in parsed) return parsed.error;
      if (!parsed.rows.length) return `No KEY=VALUE entries found in ${path}.`;
      return `Keys in ${path} (${parsed.rows.length}):\n${parsed.rows
        .map((r) => r.key)
        .join("\n")}`;
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "secret_shield_scan",
        description:
          "Scan a string for secrets. Returns rule ids, categories and offsets only — never the secret values.",
        input: z.object({ text: z.string() }),
        execute: async (args) => ({ content: scanReport(args.text) }),
      });
      editor.add({
        name: "secret_shield_stats",
        description:
          "Show secret-shield mode, rule count, audit path and finding totals by rule/location/action.",
        input: z.object({}),
        execute: async () => ({ content: statsReport() }),
      });
      editor.add({
        name: "secret_shield_shape",
        description:
          "Describe the safe shape of a secret file: key names, value lengths and a non-reversible fingerprint. Never returns values.",
        input: z.object({ path: z.string() }),
        execute: async (args) => ({ content: shapeReport(args.path) }),
      });
      editor.add({
        name: "secret_shield_keys",
        description: "List the key names in a secret file. Never returns values.",
        input: z.object({ path: z.string() }),
        execute: async (args) => ({ content: keysReport(args.path) }),
      });
    });
  },
});





