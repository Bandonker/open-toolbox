import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, join } from "path";

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

type Rule = {
  id: string;
  category: string;
  re: RegExp;
  group: number;
  /** When true the rule only runs if a related keyword appears in the text. */
  keyword?: boolean;
};

type Finding = {
  rule: string;
  category: string;
  start: number;
  end: number;
  value: string;
};

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

/**
 * Curated, high-precision rule set. Each pattern is linear-time (bounded,
 * non-nested quantifiers, no backreferences). `group` is the capture that holds
 * the secret; 0 means the whole match is the secret. `keyword: true` rules are
 * only evaluated when a related keyword appears in the text (prefilter).
 */
const RULES: ReadonlyArray<Rule> = [
  // --- AWS ---
  { id: "AWS_ACCESS_KEY_ID", category: "aws", group: 0, re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/gd },
  { id: "AWS_SECRET_ACCESS_KEY", category: "aws", group: 1, keyword: true, re: /\baws[_\-\s]{0,10}(?:secret|access)[_\-\s]{0,10}key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gdi },
  // --- GitHub ---
  { id: "GITHUB_GHP", category: "github", group: 0, re: /\bghp_[A-Za-z0-9]{36,255}\b/g },
  { id: "GITHUB_GHO", category: "github", group: 0, re: /\bgho_[A-Za-z0-9]{36,255}\b/g },
  { id: "GITHUB_GHS", category: "github", group: 0, re: /\bghs_[A-Za-z0-9]{36,255}\b/g },
  { id: "GITHUB_GHR", category: "github", group: 0, re: /\bghr_[A-Za-z0-9]{36,255}\b/g },
  { id: "GITHUB_GHU", category: "github", group: 0, re: /\bghu_[A-Za-z0-9]{36,255}\b/g },
  { id: "GITHUB_PAT", category: "github", group: 0, re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  // --- GitLab ---
  { id: "GITLAB_PAT", category: "gitlab", group: 0, re: /\bglpat-[A-Za-z0-9_\-]{20,255}\b/g },
  { id: "GITLAB_PIPELINE", category: "gitlab", group: 0, re: /\bglptt-[A-Za-z0-9_\-]{20,255}\b/g },
  { id: "GITLAB_RUNNER", category: "gitlab", group: 0, re: /\bglrt-[A-Za-z0-9_\-]{20,255}\b/g },
  // --- OpenAI / Anthropic ---
  { id: "OPENAI_PROJECT_KEY", category: "openai", group: 0, re: /\bsk-proj-[A-Za-z0-9_\-]{20,255}\b/g },
  { id: "OPENAI_API_KEY", category: "openai", group: 0, re: /\bsk-(?!ant-)[A-Za-z0-9_\-]{16,255}\b/g },
  { id: "ANTHROPIC_API_KEY", category: "anthropic", group: 0, re: /\bsk-ant-[A-Za-z0-9_\-]{20,255}\b/g },
  // --- Stripe ---
  { id: "STRIPE_LIVE", category: "stripe", group: 0, re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,255}\b/g },
  { id: "STRIPE_TEST", category: "stripe", group: 0, re: /\b(?:sk|rk)_test_[A-Za-z0-9]{20,255}\b/g },
  { id: "STRIPE_WEBHOOK", category: "stripe", group: 0, re: /\bwhsec_[A-Za-z0-9]{20,255}\b/g },
  // --- Slack ---
  { id: "SLACK_TOKEN", category: "slack", group: 0, re: /\bxox[baprs]-[A-Za-z0-9\-]{10,255}\b/g },
  { id: "SLACK_WEBHOOK", category: "slack", group: 0, re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_\-]{20,255}/g },
  // --- package registries ---
  { id: "NPM_TOKEN", category: "npm", group: 0, re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "PYPI_TOKEN", category: "pypi", group: 0, re: /\bpypi-[A-Za-z0-9_\-]{50,255}\b/g },
  // --- messaging ---
  { id: "SENDGRID_KEY", category: "sendgrid", group: 0, re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g },
  { id: "TELEGRAM_BOT_TOKEN", category: "telegram", group: 0, re: /\b\d{8,10}:[A-Za-z0-9_\-]{35}\b/g },
  { id: "DISCORD_BOT_TOKEN", category: "discord", group: 0, re: /\b[MN][A-Za-z\d]{23}\.[A-Za-z\d_\-]{6}\.[A-Za-z\d_\-]{27,}\b/g },
  { id: "DISCORD_WEBHOOK", category: "discord", group: 0, re: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_\-]{60,}/g },
  // --- tokens / keys ---
  { id: "JWT", category: "jwt", group: 0, re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { id: "PEM_PRIVATE_KEY", category: "private-key", group: 0, re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "OPENSSH_PRIVATE_KEY", category: "private-key", group: 0, re: /(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256) AAAA[A-Za-z0-9+/=]{40,}/g },
  // --- connection strings ---
  { id: "BASIC_AUTH_URL", category: "url", group: 0, re: /\b[a-zA-Z][a-zA-Z0-9+.\-]{1,15}:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "POSTGRES_URI", category: "database", group: 0, re: /\bpostgres(?:ql)?:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "MYSQL_URI", category: "database", group: 0, re: /\bmysql:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "MONGODB_URI", category: "database", group: 0, re: /\bmongodb(?:\+srv)?:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "REDIS_URI", category: "database", group: 0, re: /\brediss?:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "AMQP_URI", category: "database", group: 0, re: /\bamqps?:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,128}@/g },
  { id: "JDBC_PASSWORD", category: "database", group: 1, keyword: true, re: /jdbc:[a-zA-Z]+:\/\/[^\s]*?password=([^\s;&"']{3,})/gdi },
  // --- keyword-labelled generic ---
  { id: "GENERIC_PASSWORD", category: "generic", group: 1, keyword: true, re: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"',;]{6,})/gdi },
  { id: "GENERIC_SECRET", category: "generic", group: 1, keyword: true, re: /(?:client[_-]?secret|secret[_-]?key|app[_-]?secret)\s*[:=]\s*["']?([^\s"',;]{6,})/gdi },
  { id: "GENERIC_API_KEY", category: "generic", group: 1, keyword: true, re: /(?:api[_-]?key|apikey|access[_-]?key[_-]?id)\s*[:=]\s*["']?([^\s"',;]{6,})/gdi },
  { id: "GENERIC_TOKEN", category: "generic", group: 1, keyword: true, re: /(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token)\s*[:=]\s*["']?([^\s"',;]{6,})/gdi },
  { id: "AUTHORIZATION_HEADER", category: "generic", group: 1, keyword: true, re: /authorization\s*[:=]\s*["']?([^\s"',;]{6,})/gdi },
  { id: "BEARER_TOKEN", category: "generic", group: 1, keyword: true, re: /\bbearer\s+([A-Za-z0-9_\-\.=]{16,})/gdi },
  { id: "BASIC_AUTH_HEADER", category: "generic", group: 1, keyword: true, re: /authorization\s*:\s*basic\s+([A-Za-z0-9+/=]{16,})/gdi },
  { id: "ENV_SECRET_LINE", category: "generic", group: 1, re: /[A-Z][A-Z0-9_]{2,40}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)\s*=\s*["']?([^\s"'#]{6,})/gd },
  // --- cloud / SaaS ---
  { id: "GOOGLE_API_KEY", category: "cloud", group: 0, re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { id: "GCP_SERVICE_ACCOUNT", category: "cloud", group: 0, re: /"type"\s*:\s*"service_account"/g },
  { id: "AZURE_STORAGE_KEY", category: "cloud", group: 1, keyword: true, re: /AccountKey=([A-Za-z0-9+/=]{80,100})/gd },
  { id: "AZURE_SAS_TOKEN", category: "cloud", group: 0, keyword: true, re: /\bsig=[A-Za-z0-9%+/=]{20,}/gd },
  { id: "DIGITALOCEAN_TOKEN", category: "cloud", group: 0, re: /\bdop_v1_[a-f0-9]{64}\b/g },
  { id: "SHOPIFY_TOKEN", category: "saas", group: 0, re: /\bshpat_[a-f0-9]{32}\b/g },
  { id: "SHOPIFY_SHARED_SECRET", category: "saas", group: 0, re: /\bshpss_[a-f0-9]{32}\b/g },
  { id: "SQUARE_ACCESS_TOKEN", category: "saas", group: 0, re: /\bsq0atp-[0-9A-Za-z_\-]{22}\b/g },
  { id: "SQUARE_OAUTH_SECRET", category: "saas", group: 0, re: /\bEAAA[A-Za-z0-9_\-]{60}\b/g },
  { id: "MAILCHIMP_KEY", category: "saas", group: 0, re: /\b[0-9a-f]{32}-us\d{1,2}\b/g },
  { id: "MAILGUN_KEY", category: "saas", group: 0, re: /\bkey-[0-9a-zA-Z]{32}\b/g },
  { id: "NETLIFY_TOKEN", category: "saas", group: 0, re: /\bnfp_[A-Za-z0-9]{40}\b/g },
  { id: "HUGGINGFACE_TOKEN", category: "saas", group: 0, re: /\bhf_[A-Za-z0-9]{34,255}\b/g },
  { id: "LINEAR_API_KEY", category: "saas", group: 0, re: /\blin_api_[A-Za-z0-9]{40}\b/g },
  { id: "NOTION_TOKEN", category: "saas", group: 0, re: /\bsecret_[A-Za-z0-9]{43}\b/g },
  { id: "NEW_RELIC_KEY", category: "saas", group: 0, re: /\bNRAK-[A-Z0-9]{27}\b/g },
  { id: "POSTMAN_API_KEY", category: "saas", group: 0, re: /\bPMAK-[A-Za-z0-9]{24}-[A-Za-z0-9]{34}\b/g },
  { id: "BITBUCKET_TOKEN", category: "saas", group: 0, re: /\bATBB[A-Za-z0-9]{32}\b/g },
  { id: "DATADOG_API_KEY", category: "saas", group: 1, keyword: true, re: /\bdd[_-]?api[_-]?key\s*[:=]\s*["']?([0-9a-f]{32})/gdi },
  { id: "SONAR_TOKEN", category: "saas", group: 0, re: /\bsqp_[a-f0-9]{40}\b/g },
  { id: "GRAFANA_TOKEN", category: "saas", group: 0, re: /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/g },
  { id: "TAILSCALE_KEY", category: "saas", group: 0, re: /\btskey-[a-z0-9]{1,20}-[A-Za-z0-9]{16,}\b/g },
  { id: "FIREBASE_KEY", category: "cloud", group: 0, re: /\bAAAA[A-Za-z0-9_\-]{7}:[A-Za-z0-9_\-]{100,}\b/g },
  { id: "DOCKER_AUTH", category: "cloud", group: 1, keyword: true, re: /"auth"\s*:\s*"([A-Za-z0-9+/=]{16,})"/gd },
  { id: "TWILIO_KEY", category: "saas", group: 0, re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: "SENTRY_DSN", category: "saas", group: 0, re: /https:\/\/[0-9a-f]{32}@[a-z0-9.\-]+\.ingest\.sentry\.io\/\d+/g },
];

/** Substrings that must appear before keyword-gated rules are evaluated. */
const KEYWORDS: ReadonlyArray<string> = [
  "password", "passwd", "pwd", "secret", "token", "api", "apikey", "key",
  "auth", "bearer", "credential", "aws", "accountkey", "dsn", "sig=",
  "webhook", "private", "database_url", "connectionstring",
];

const STOPWORDS: ReadonlyArray<string> = [
  "example", "test", "dummy", "localhost", "changeme", "sample", "your_",
  "placeholder", "redacted", "xxxxxxxx", "foobar", "notreal",
];

// --- detection engine -------------------------------------------------------

/** Hard cap on how much text a single scan will examine (keeps work bounded). */
const MAX_SCAN = 2_000_000;

type MatchWithIndices = RegExpMatchArray & {
  indices?: ReadonlyArray<readonly [number, number] | undefined>;
};

function groupRange(m: RegExpMatchArray, group: number): [number, number] | null {
  const indices = (m as MatchWithIndices).indices;
  const hit = indices ? indices[group] : undefined;
  if (hit) return [hit[0], hit[1]];
  const value = m[group];
  if (typeof value !== "string" || value.length === 0) return null;
  const rel = m[0].indexOf(value);
  if (rel < 0) return null;
  const base = m.index ?? 0;
  return [base + rel, base + rel + value.length];
}

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

type AllowList = {
  literals: Set<string>;
  regexes: RegExp[];
  globs: RegExp[];
  rules: Set<string>;
};

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** Compile allow entries: `rule:ID`, `re:...` or `/.../`, glob, or literal. */
function buildAllowList(entries: ReadonlyArray<string>): AllowList {
  const literals = new Set<string>();
  const regexes: RegExp[] = [];
  const globs: RegExp[] = [];
  const rules = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("rule:")) {
      rules.add(entry.slice(5).trim());
      continue;
    }
    if (entry.startsWith("re:")) {
      try {
        regexes.push(new RegExp(entry.slice(3).trim()));
      } catch {
        literals.add(entry);
      }
      continue;
    }
    const slash = entry.match(/^\/(.+)\/([a-z]*)$/);
    if (slash) {
      try {
        regexes.push(new RegExp(slash[1], slash[2]));
      } catch {
        literals.add(entry);
      }
      continue;
    }
    if (RULES.some((r) => r.id === entry)) {
      rules.add(entry);
      continue;
    }
    if (/[*?]/.test(entry)) {
      globs.push(globToRegExp(entry));
      continue;
    }
    literals.add(entry);
  }
  return { literals, regexes, globs, rules };
}

/** Optional project allow file: `<cwd>/.secret-shield-allow`. */
function readAllowFile(): string[] {
  const path = join(process.cwd(), ".secret-shield-allow");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  } catch {
    return [];
  }
}

const INLINE_ALLOW = /(?:#|\/\/)\s*secret-shield:allow/;

function isAllowed(finding: Finding, allow: AllowList, location: string): boolean {
  if (allow.rules.has(finding.rule)) return true;
  if (allow.literals.has(finding.value)) return true;
  for (const re of allow.regexes) {
    re.lastIndex = 0;
    if (re.test(finding.value)) return true;
  }
  for (const re of allow.globs) {
    if (re.test(location)) return true;
  }
  return false;
}

/** Keep-filter that drops findings on a line carrying an inline allow marker. */
function inlineKeepFilter(text: string): (f: Finding) => boolean {
  const ranges: Array<[number, number]> = [];
  let idx = 0;
  for (const line of text.split("\n")) {
    if (INLINE_ALLOW.test(line)) ranges.push([idx, idx + line.length]);
    idx += line.length + 1;
  }
  if (!ranges.length) return () => true;
  return (f) => !ranges.some(([a, b]) => f.start >= a && f.start <= b);
}

/**
 * Run every rule plus (optionally) the entropy fallback over `text`. Findings
 * are de-duplicated by first-match precedence and filtered through the
 * allowlist. Linear in text length for a fixed rule set.
 */
function collectFindings(
  text: string,
  location: string,
  cfg: ShieldConfig,
  allow: AllowList,
): Finding[] {
  const findings: Finding[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number): boolean =>
    taken.some(([a, b]) => s < b && e > a);
  if (text.length > MAX_SCAN) return findings;

  const lower = text.toLowerCase();
  const hasKeyword = KEYWORDS.some((k) => lower.includes(k));

  for (const rule of RULES) {
    if (rule.keyword && !hasKeyword) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === "") rule.re.lastIndex += 1;
      const range = groupRange(m, rule.group);
      if (!range) continue;
      const [s, e] = range;
      if (e <= s || overlaps(s, e)) continue;
      findings.push({
        rule: rule.id,
        category: rule.category,
        start: s,
        end: e,
        value: text.slice(s, e),
      });
      taken.push([s, e]);
    }
  }

  if (cfg.entropy) {
    const gapRe = /[A-Za-z0-9+/=_\-]{24,}/g;
    let g: RegExpExecArray | null;
    while ((g = gapRe.exec(text)) !== null) {
      const s = g.index;
      const e = s + g[0].length;
      if (overlaps(s, e)) continue;
      const value = g[0];
      const lv = value.toLowerCase();
      if (STOPWORDS.some((w) => lv.includes(w))) continue;
      if (shannonEntropy(value) < 3.3) continue;
      findings.push({ rule: "SS_ENTROPY", category: "entropy", start: s, end: e, value });
      taken.push([s, e]);
    }
  }

  const keep = inlineKeepFilter(text);
  return findings
    .filter((f) => !isAllowed(f, allow, location))
    .filter(keep)
    .sort((a, b) => a.start - b.start);
}

/** Replace each finding (in reverse order) with a placeholder. */
function applyFindings(
  text: string,
  findings: ReadonlyArray<Finding>,
  makePlaceholder: (rule: string, value: string) => string,
): string {
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + makePlaceholder(f.rule, f.value) + out.slice(f.end);
  }
  return out;
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
        event.request = new Request(req.url, {
          method: req.method,
          headers: req.headers,
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
        const after = scrub(before, `tool.execute.before:${event.tool}`, true);
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
      const findings = collectFindings(text, "tool.secret_shield_scan", cfg, allow);
      if (!findings.length) return "No secrets detected.";
      const lines = findings.map(
        (f) => `${f.rule} [${f.category}] offset=${f.start} length=${f.end - f.start}`,
      );
      return `Detected ${findings.length} finding(s) (values withheld):\n${lines.join("\n")}`;
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





