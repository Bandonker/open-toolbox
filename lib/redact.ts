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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Severity = "critical" | "high" | "medium" | "low";

export type Rule = {
  id: string;
  category: string;
  re: RegExp;
  group: number;
  /** When true the rule only runs if a related keyword appears in the text. */
  keyword?: boolean;
  severity?: Severity;
};

/**
 * E34: derive a severity for a rule when one isn't set explicitly.
 * Private keys and connection strings with embedded credentials are critical;
 * test keys and generic patterns are medium; everything else is high.
 * Entropy findings are always low.
 */
function ruleSeverity(rule: Rule): Severity {
  if (rule.severity) return rule.severity;
  if (rule.category === "private-key") return "critical";
  if (rule.category === "database") return "critical";
  if (rule.id === "AWS_SECRET_ACCESS_KEY") return "critical";
  if (rule.id === "STRIPE_LIVE") return "critical";
  if (rule.id === "GCP_SERVICE_ACCOUNT") return "critical";
  if (rule.id === "AZURE_STORAGE_KEY") return "critical";
  if (rule.id === "BASIC_AUTH_URL") return "critical";
  if (rule.id === "STRIPE_TEST") return "medium";
  if (rule.category === "generic") return "medium";
  return "high";
}

export type Finding = {
  rule: string;
  category: string;
  start: number;
  end: number;
  value: string;
  severity: Severity;
  /** E7: line number (1-based) where the finding starts. */
  line?: number;
  /** E7: column number (1-based) where the finding starts. */
  column?: number;
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
  { id: "PEM_PRIVATE_KEY", category: "private-key", group: 0, re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "OPENSSH_PRIVATE_KEY", category: "private-key", group: 0, re: /(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256) AAAA[A-Za-z0-9+/=]{40,}/g },
  // --- cloud / SaaS API tokens ---
  // LIB-1: context-gated like the GENERIC_* rules. The bare UUID regex matched
  // every request/pod/trace UUID in keyword-adjacent text and irreversibly
  // rewrote it at rest. Now a key/token/secret label must sit immediately
  // before the UUID (e.g. `HEROKU_API_KEY=…-uuid`); a bare UUID in prose is
  // left alone. group 1 captures just the UUID so the label survives redaction.
  { id: "HEROKU_API_KEY", category: "cloud", group: 1, keyword: true, re: /(?<![A-Za-z0-9])(?:api[_-]?key|apikey|key[_-]?id|key|token|secret)["'\s]{0,8}[:=]["'\s]{0,8}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gid },
  { id: "DATABRICKS_TOKEN", category: "saas", group: 0, re: /\bdapi[0-9a-f]{32}\b/g },
  { id: "SUPABASE_TOKEN", category: "saas", group: 0, re: /\bsbp_[0-9a-f]{32}\b/g },
  { id: "GROQ_API_KEY", category: "saas", group: 0, re: /\bgsk_[0-9a-zA-Z]{32,}\b/g },
  { id: "PERPLEXITY_API_KEY", category: "saas", group: 0, re: /\bpplx-[0-9a-zA-Z]{32,}\b/g },
  { id: "AIRTABLE_TOKEN", category: "saas", group: 0, re: /\bpat[0-9a-zA-Z]{20,}\b/g },
  { id: "VERCEL_TOKEN", category: "saas", group: 0, re: /\bvc_[0-9a-zA-Z]{24}\b/g },
  { id: "COHERE_API_KEY", category: "saas", group: 1, keyword: true, re: /\bcohere[_-]?api[_-]?key\s*[:=]\s*["']?([0-9a-zA-Z]{20,})/gdi },
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
  // LIB-1 (scope note): capture class widened with `#_$*:` so OAuth-style
  // bearer tokens containing those chars are captured whole instead of
  // truncating at the first exotic char. Deliberately NOT applied to the
  // other generic rules — wider classes there are workload-risky.
  { id: "BEARER_TOKEN", category: "generic", group: 1, keyword: true, re: /\bbearer\s+([A-Za-z0-9_\-\.=#_$*:]{16,})/gdi },
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

// E34: precompute each built-in rule's severity once at module init so the
// per-finding path (ruleSeverity calls) is a single property read instead of
// a comparison chain.
for (const r of RULES) {
  if (r.severity === undefined) r.severity = ruleSeverity(r);
}

/** Substrings that must appear before keyword-gated rules are evaluated. */
const KEYWORDS: ReadonlyArray<string> = [
  "password", "passwd", "pwd", "secret", "token", "api", "apikey", "key",
  "auth", "bearer", "credential", "aws", "accountkey", "dsn", "sig=",
  "webhook", "private", "database_url", "connectionstring",
];

/**
 * LIB-1: the keyword prefilter is word-boundary aware — "key" no longer
 * opens the gate for "keyboard"/"monkey"/"keyword". Boundaries use
 * [A-Za-z0-9] only (underscore counts as a boundary char) so env-style
 * labels like HEROKU_API_KEY still pass, and keywords whose edges are
 * non-alphanumeric ("sig=") only require a boundary on their word edge.
 */
const keywordReCache = new Map<string, RegExp>();

const KEYWORD_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const KEYWORD_ALPHA_START_RE = /^[A-Za-z0-9]/;
const KEYWORD_ALPHA_END_RE = /[A-Za-z0-9]$/;

function compileKeywords(keywords: ReadonlyArray<string>): RegExp {
  const key = keywords.join("\u0000");
  let re = keywordReCache.get(key);
  if (!re) {
    const parts = keywords.map((k) => {
      const esc = k.replace(KEYWORD_ESCAPE_RE, "\\$&");
      const lead = KEYWORD_ALPHA_START_RE.test(k) ? "(?<![A-Za-z0-9])" : "";
      const trail = KEYWORD_ALPHA_END_RE.test(k) ? "(?![A-Za-z0-9])" : "";
      return `${lead}${esc}${trail}`;
    });
    re = new RegExp(parts.join("|"), "i");
    if (keywordReCache.size > 64) keywordReCache.clear();
    keywordReCache.set(key, re);
  }
  return re;
}

const STOPWORD_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

const STOPWORDS: ReadonlyArray<string> = [
  "example", "test", "dummy", "localhost", "changeme", "sample", "your_",
  "placeholder", "redacted", "xxxxxxxx", "foobar", "notreal",
];

// Hoisted: previously a fresh regex literal per window scan.
const ENTROPY_GAP_RE = /[A-Za-z0-9+/=_\-]{24,}/g;

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

// Reusable per-call scratch: avoids a fresh Map<string, number> allocation
// for every entropy candidate token. Tokens are ASCII by construction
// ([A-Za-z0-9+/=_-]); any exotic char falls into the last bucket, which is
// only reachable outside the intended call sites.
const entropyCounts = new Uint32Array(256);

function shannonEntropy(s: string): number {
  if (!s) return 0;
  entropyCounts.fill(0);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    entropyCounts[c < 256 ? c : 255]++;
  }
  let h = 0;
  for (let i = 0; i < entropyCounts.length; i++) {
    const c = entropyCounts[i];
    if (c === 0) continue;
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
const BENIGN_HEX_RE = /^[0-9a-fA-F]{32,128}$/;
const BENIGN_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BENIGN_DIGITS_RE = /^\d+$/;
const BENIGN_URL_RE = /^https?:\/\//i;
const BENIGN_PATH_SEP_RE = /[\\/]/;
const BENIGN_PATH_CHARS_RE = /^[A-Za-z0-9_.\-\/\\:% ~]+$/;
const BENIGN_PATH_CUE_RE = /[.:\\~ ]/;
const BENIGN_REPEATED_RE = /^(.)\1+$/;
const BENIGN_HEXCOLOR_RE = /^#?[0-9a-fA-F]{6}$/;

function looksLikeBenignShape(value: string): boolean {
  if (BENIGN_HEX_RE.test(value)) return true; // md5/sha hex digests
  if (BENIGN_UUID_RE.test(value)) {
    return true; // uuid
  }
  if (BENIGN_DIGITS_RE.test(value)) return true; // digit-only ids/hashes
  if (BENIGN_URL_RE.test(value)) return true; // URLs
  // H9: a path needs a separator AND a structural cue base64 cannot produce (a dot, colon,
  // backslash, tilde or space). base64/base64url tokens legitimately contain "/", so requiring a
  // separator alone silently suppressed the entropy fallback for base64 secrets that happened to
  // include one.
  if (
    BENIGN_PATH_SEP_RE.test(value) &&
    BENIGN_PATH_CHARS_RE.test(value) &&
    BENIGN_PATH_CUE_RE.test(value)
  ) {
    return true; // paths
  }
  if (BENIGN_REPEATED_RE.test(value)) return true; // repeated-char padding
  if (BENIGN_HEXCOLOR_RE.test(value)) return true; // hex colour
  return false;
}

const GLOB_ESCAPE_RE = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(GLOB_ESCAPE_RE, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

const SLASH_ENTRY_RE = /^\/(.+)\/([a-z]*)$/;
const GLOB_META_RE = /[*?]/;

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
    const slash = entry.match(SLASH_ENTRY_RE);
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
    if (GLOB_META_RE.test(entry)) {
      globs.push(globToRegExp(entry));
      continue;
    }
    literals.add(entry);
  }
  return { literals, regexes, globs, rules };
}

/** Optional project allow file: `<cwd>/.secret-shield-allow`. */
// SS-7: cached — the file is read+parsed once and only re-read when its
// path or mtime changes, instead of on every invocation.
let allowFileCache: { path: string; mtimeMs: number; entries: string[] } | null = null;

const LINE_BREAK_RE = /\r?\n/;

function parseAllowFile(text: string): string[] {
  return text
    .split(LINE_BREAK_RE)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
}

export function readAllowFile(): string[] {
  const path = join(process.cwd(), ".secret-shield-allow");
  try {
    if (!existsSync(path)) {
      allowFileCache = { path, mtimeMs: -1, entries: [] };
      return [];
    }
    const mtimeMs = statSync(path).mtimeMs;
    if (allowFileCache && allowFileCache.path === path && allowFileCache.mtimeMs === mtimeMs) {
      return [...allowFileCache.entries];
    }
    const entries = parseAllowFile(readFileSync(path, "utf8"));
    allowFileCache = { path, mtimeMs, entries };
    return [...entries];
  } catch {
    if (allowFileCache && allowFileCache.path === path) return [...allowFileCache.entries];
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
export function isScanTruncated(text: string, maxScan: number = MAX_SCAN): boolean {
  return text.length > maxScan;
}

/**
 * SS-5: byte ranges of `text` that collectFindings does NOT scan. Oversize
 * input is covered by head/tail windows; the middle is skipped and reported
 * here so callers can surface it (log/audit) instead of silently covering
 * just the prefix. Empty for input within the scan cap.
 * LIB-8: `maxScan` mirrors collectFindings' `maxScanChars` option — callers
 * with a configured cap must pass it or truncation is reported incorrectly.
 */
export function scanGaps(text: string, maxScan: number = MAX_SCAN): Array<[number, number]> {
  if (!isScanTruncated(text, maxScan)) return [];
  const half = Math.floor(maxScan / 2);
  return [[half, text.length - half]];
}

export function collectFindings(
  text: string,
  location: string,
  opts: {
    entropy: boolean;
    rules?: ReadonlyArray<Rule>;
    entropyThreshold?: number;
    /** E20: max chars to scan (default 2 MB). */
    maxScanChars?: number;
    /** E21: user-defined rules merged with the built-in set. */
    customRules?: ReadonlyArray<Rule>;
    /** E24: only return findings in these categories. */
    categories?: ReadonlyArray<string>;
    /** E7: include line/column info in findings. */
    includeLocation?: boolean;
    /** E8: additional keywords to gate context-style rules. */
    keywords?: ReadonlyArray<string>;
    /** E8: additional stopwords to exclude from entropy fallback. */
    stopwords?: ReadonlyArray<string>;
    /** E9: rule IDs to disable. */
    disabledRules?: ReadonlyArray<string>;
  },
  allow: AllowList,
): Finding[] {
  const findings: Finding[] = [];
  // Taken ranges, kept sorted by start via binary-search insertion. Because
  // every accepted finding is non-overlapping, both the starts and the ends
  // are monotone, so an overlap query only needs to inspect the two ranges
  // adjacent to the candidate (predecessor + successor) — O(log n).
  const taken: Array<[number, number]> = [];
  const takenLo = (s: number): number => {
    let lo = 0;
    let hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (taken[mid]![0] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const overlaps = (s: number, e: number): boolean => {
    const i = takenLo(s);
    if (i < taken.length) {
      const [a, b] = taken[i]!;
      if (s < b && e > a) return true;
    }
    if (i > 0) {
      const [a, b] = taken[i - 1]!;
      if (s < b && e > a) return true;
    }
    return false;
  };
  const addTaken = (s: number, e: number): void => {
    taken.splice(takenLo(s), 0, [s, e]);
  };
  // E20: configurable max scan size (default 2 MB).
  const maxScan = opts.maxScanChars ?? MAX_SCAN;
  // SS-5: oversize input is scanned in head/tail windows (absolute offsets
  // are preserved so applyFindings still applies to the original text) and
  // the skipped middle is exposed via scanGaps(). Callers use
  // isScanTruncated()/scanGaps() to surface the truncation.
  const half = Math.floor(maxScan / 2);
  const windows: Array<{ text: string; base: number }> = text.length > maxScan
    ? [
        { text: text.slice(0, half), base: 0 },
        { text: text.slice(text.length - half), base: text.length - half },
      ]
    : [{ text, base: 0 }];

  const lower = text.toLowerCase();
  // E8: merge custom keywords with the built-in set.
  // LIB-1: word-boundary aware matching (see compileKeywords).
  const allKeywords = opts.keywords?.length ? [...KEYWORDS, ...opts.keywords] : KEYWORDS;
  const hasKeyword = compileKeywords(allKeywords).test(lower);

  // E21: merge custom rules with the active rule set.
  const baseRules = opts.rules ?? RULES;
  const rules = opts.customRules?.length ? [...baseRules, ...opts.customRules] : baseRules;
  // E9: rule enable/disable by ID.
  const disabledSet = opts.disabledRules?.length ? new Set(opts.disabledRules) : null;
  // E24: category filter.
  const categorySet = opts.categories?.length ? new Set(opts.categories) : null;
  const entropyThreshold = opts.entropyThreshold ?? 3.3;
  // E8: merge custom stopwords with the built-in set.
  const allStopwords = opts.stopwords?.length ? [...STOPWORDS, ...opts.stopwords] : STOPWORDS;
  // Hoisted alternation: one regex test replaces allStopwords.some(lv.includes).
  // Literal subexpressions match as substrings, so this is equivalent to the
  // previous any-includes check (same case-sensitivity since lv is lowered
  // and no "i" flag is used).
  const stopwordRe = new RegExp(
    allStopwords.map((w) => w.replace(STOPWORD_ESCAPE_RE, "\\$&")).join("|"),
  );
  // E34: bake the derived severity onto every rule once per scan instead of
  // recomputing the comparison chain on every finding.
  for (const r of rules) {
    if (r.severity === undefined) r.severity = ruleSeverity(r);
  }

  // LIB-9 / E7: line and column are computed ONLY when includeLocation is set.
  // Previously every finding paid a `text.slice(0, absStart)` + regex scan
  // (O(findings x text)) even when the location was discarded. Now: one pass
  // over `text` recording newline positions (built lazily, only if a location
  // is actually requested), then a binary search per finding.
  let newlinePositions: number[] | null = null;
  const locationAt = (offset: number): { line: number; column: number } => {
    if (newlinePositions === null) {
      newlinePositions = [];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
        newlinePositions.push(i);
      }
    }
    let lo = 0;
    let hi = newlinePositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlinePositions[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    const lastNl = lo === 0 ? -1 : newlinePositions[lo - 1]!;
    return { line: lo + 1, column: lastNl === -1 ? offset + 1 : offset - lastNl };
  };

  for (const { text: haystack, base } of windows) {
    const local: Finding[] = [];
    for (const rule of rules) {
      // E9: skip disabled rules.
      if (disabledSet?.has(rule.id)) continue;
      if (rule.keyword && !hasKeyword) continue;
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(haystack)) !== null) {
        if (m[0] === "") rule.re.lastIndex += 1;
        const range = groupRange(m, rule.group);
        if (!range) continue;
        const [s, e] = range;
        if (e <= s || overlaps(s + base, e + base)) continue;
        const absStart = s + base;
        const absEnd = e + base;
        local.push({
          rule: rule.id,
          category: rule.category,
          start: absStart,
          end: absEnd,
          value: haystack.slice(s, e),
          severity: ruleSeverity(rule),
          ...(opts.includeLocation ? locationAt(absStart) : {}),
        });
        addTaken(absStart, absEnd);
      }
    }

    if (opts.entropy) {
      ENTROPY_GAP_RE.lastIndex = 0;
      let g: RegExpExecArray | null;
      while ((g = ENTROPY_GAP_RE.exec(haystack)) !== null) {
        const s = g.index;
        const e = s + g[0].length;
        if (overlaps(s + base, e + base)) continue;
        const value = g[0];
        const lv = value.toLowerCase();
        if (stopwordRe.test(lv)) continue;
        if (shannonEntropy(value) < entropyThreshold) continue;
        // H3: skip shapes that are high-entropy by construction (hex digests,
        // UUIDs, paths, URLs, digit runs) — flagging them corrupted ordinary
        // content in redact mode.
        if (looksLikeBenignShape(value)) continue;
        const absStart = s + base;
        const absEnd = e + base;
        local.push({
          rule: "SS_ENTROPY",
          category: "entropy",
          start: absStart,
          end: absEnd,
          value,
          severity: "low" as Severity,
          ...(opts.includeLocation ? locationAt(absStart) : {}),
        });
        addTaken(absStart, absEnd);
      }
    }

    const keep = inlineKeepFilter(haystack);
    for (const f of local) {
      // Inline markers are window-relative; absolutized offsets above.
      if (keep({ ...f, start: f.start - base, end: f.end - base }) && !isAllowed(f, allow, location)) {
        // E24: category filter.
        if (categorySet && !categorySet.has(f.category)) continue;
        findings.push(f);
      }
    }
  }

  return findings.sort((a, b) => a.start - b.start);
}

/**
 * Replace each finding (in reverse order) with a placeholder.
 *
 * E23: `mode: "partial"` shows the first few characters of the secret followed
 * by `***`, so the value is still identifiable without being fully exposed.
 * `mode: "full"` (default) replaces the entire secret.
 */
export function applyFindings(
  text: string,
  findings: ReadonlyArray<Finding>,
  makePlaceholder: (rule: string, value: string) => string,
  mode: "full" | "partial" = "full",
): string {
  const effectivePlaceholder =
    mode === "partial"
      ? (rule: string, value: string) => {
          const prefix = value.slice(0, Math.min(4, value.length));
          return `${prefix}***`;
        }
      : makePlaceholder;
  // Single-pass build: findings are non-overlapping (collectFindings enforces
  // via `taken`), so walking them in ascending start order and emitting one
  // joined string replaces the old reverse-order splice-per-finding loop
  // (which allocated a fresh string per finding).
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const f of sorted) {
    if (f.start > cursor) out += text.slice(cursor, f.start);
    out += effectivePlaceholder(f.rule, f.value);
    cursor = f.end > cursor ? f.end : cursor;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Drop-in redactor for plugins that just need "strip secrets from this
 * text": the full rule set + entropy fallback with the H3 benign-shape
 * allowlist. Inline `secret-shield:allow` markers are honoured.
 *
 * E21: `customRules` are merged with the built-in rule set.
 */
export function redactSecrets(text: string, allow?: AllowList, customRules?: ReadonlyArray<Rule>): string {
  if (!text) return text;
  const list = allow ?? buildAllowList([]);
  const findings = collectFindings(text, "lib.redact", { entropy: true, customRules }, list);
  if (findings.length === 0) return text;
  return applyFindings(text, findings, (rule) => `[redacted ${rule}]`);
}

/* ------------------------------------------------------------------ *
 * E10: Audit trail / structured logging
 * ------------------------------------------------------------------ */

export type AuditEvent = {
  timestamp: string;
  action: "scan" | "redact" | "block" | "allow";
  location: string;
  findingCount: number;
  rules: string[];
  durationMs: number;
};

/**
 * E10: Create an audit logger that records scan events.
 * Returns a function that logs an audit event to the specified sink.
 */
export function createAuditLogger(
  sink: (event: AuditEvent) => void = (e) => console.log(JSON.stringify(e)),
): (event: Omit<AuditEvent, "timestamp">) => void {
  return (event) => {
    sink({ ...event, timestamp: new Date().toISOString() });
  };
}

/**
 * E10: Log a scan event to the audit trail.
 */
export function logAuditEvent(
  log: (event: Omit<AuditEvent, "timestamp">) => void,
  event: Omit<AuditEvent, "timestamp">,
): void {
  log(event);
}

