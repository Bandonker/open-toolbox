/**
 * lib/redact — the pack's shared secret-detection core (H4).
 *
 * Extracted from secret-shield so session-export (and any other plugin)
 * scrub with exactly the same strength as the shield plugin itself; the
 * shield keeps its audit trail / HMAC fingerprinting / hooks and imports
 * the engine from here.
 *
 * Matching is intentionally linear-time: every rule uses bounded, non-nested
 * quantifiers and no backreferences, so no input can trigger catastrophic
 * backtracking. A keyword prefilter gates the context-style rules and a
 * Shannon entropy fallback (gated by stopwords and a benign-shape allowlist,
 * H3) catches unlabelled high-entropy tokens.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Rule = {
  id: string;
  category: string;
  re: RegExp;
  group: number;
  /** When true the rule only runs if a related keyword appears in the text. */
  keyword?: boolean;
};

export type Finding = {
  rule: string;
  category: string;
  start: number;
  end: number;
  value: string;
};

export type AllowList = {
  literals: Set<string>;
  regexes: RegExp[];
  globs: RegExp[];
  rules: Set<string>;
};

/**
 * Curated, high-precision rule set. Each pattern is linear-time (bounded,
 * non-nested quantifiers, no backreferences). `group` is the capture that
 * holds the secret; 0 means the whole match is the secret. `keyword: true`
 * rules are only evaluated when a related keyword appears in the text.
 */
export const RULES: ReadonlyArray<Rule> = [
  // --- AWS ---
  { id: "AWS_ACCESS_KEY_ID", category: "aws", group: 0, re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/gd },
  { id: "AWS_SECRET_ACCESS_KEY", category: "aws", group: 1, keyword: true, re: /\baws[\-\s]{0,10}(?:secret|access)[\-\s]{0,10}key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gdi },
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

/**
 * H3: shapes that are high-entropy by construction but are not secrets —
 * hex digests (md5/sha*), UUIDs, file paths, http(s) URLs, digit-only
 * runs (hashes/ids), hex colours and repeated-character padding. Without
 * this allowlist the entropy fallback corrupted ordinary hex/paths in
 * redact mode.
 */
function looksLikeBenignShape(value: string): boolean {
  if (/^[0-9a-fA-F]{32,128}$/.test(value)) return true; // md5/sha hex digests
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    return true; // uuid
  }
  if (/^\d+$/.test(value)) return true; // digit-only ids/hashes
  if (/^https?:\/\//i.test(value)) return true; // URLs
  // H9: a path needs a separator AND a structural cue base64 cannot produce (a dot, colon,
  // backslash, tilde or space). base64/base64url tokens legitimately contain "/", so requiring a
  // separator alone silently suppressed the entropy fallback for base64 secrets that happened to
  // include one.
  if (
    /[\\/]/.test(value) &&
    /^[A-Za-z0-9_.\-\/\\:% ~]+$/.test(value) &&
    /[.:\\~ ]/.test(value)
  ) {
    return true; // paths
  }
  if (/^(.)\1+$/.test(value)) return true; // repeated-char padding
  if (/^#?[0-9a-fA-F]{6}$/.test(value)) return true; // hex colour
  return false;
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** Compile allow entries: `rule:ID`, `re:...` or `/.../`, glob, or literal. */
export function buildAllowList(entries: ReadonlyArray<string>): AllowList {
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
export function readAllowFile(): string[] {
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
export function isScanTruncated(text: string): boolean {
  return text.length > MAX_SCAN;
}

export function collectFindings(
  text: string,
  location: string,
  opts: { entropy: boolean },
  allow: AllowList,
): Finding[] {
  const findings: Finding[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number): boolean =>
    taken.some(([a, b]) => s < b && e > a);
  // H5: never silently skip oversize input — scan the head so secrets near
  // the start are still caught. Callers use isScanTruncated() to surface the
  // truncation instead of dropping everything.
  const haystack = isScanTruncated(text) ? text.slice(0, MAX_SCAN) : text;

  const lower = haystack.toLowerCase();
  const hasKeyword = KEYWORDS.some((k) => lower.includes(k));

  for (const rule of RULES) {
    if (rule.keyword && !hasKeyword) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(haystack)) !== null) {
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
        value: haystack.slice(s, e),
      });
      taken.push([s, e]);
    }
  }

  if (opts.entropy) {
    const gapRe = /[A-Za-z0-9+/=_\-]{24,}/g;
    let g: RegExpExecArray | null;
    while ((g = gapRe.exec(haystack)) !== null) {
      const s = g.index;
      const e = s + g[0].length;
      if (overlaps(s, e)) continue;
      const value = g[0];
      const lv = value.toLowerCase();
      if (STOPWORDS.some((w) => lv.includes(w))) continue;
      if (shannonEntropy(value) < 3.3) continue;
      // H3: skip shapes that are high-entropy by construction (hex digests,
      // UUIDs, paths, URLs, digit runs) — flagging them corrupted ordinary
      // content in redact mode.
      if (looksLikeBenignShape(value)) continue;
      findings.push({ rule: "SS_ENTROPY", category: "entropy", start: s, end: e, value });
      taken.push([s, e]);
    }
  }

  const keep = inlineKeepFilter(haystack);
  return findings
    .filter((f) => !isAllowed(f, allow, location))
    .filter(keep)
    .sort((a, b) => a.start - b.start);
}

/** Replace each finding (in reverse order) with a placeholder. */
export function applyFindings(
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

/**
 * Drop-in redactor for plugins that just need "strip secrets from this
 * text": the full rule set + entropy fallback with the H3 benign-shape
 * allowlist. Inline `secret-shield:allow` markers are honoured.
 */
export function redactSecrets(text: string, allow?: AllowList): string {
  if (!text) return text;
  const list = allow ?? buildAllowList([]);
  const findings = collectFindings(text, "lib.redact", { entropy: true }, list);
  if (findings.length === 0) return text;
  return applyFindings(text, findings, (rule) => `[redacted ${rule}]`);
}

