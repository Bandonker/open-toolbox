import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "fs";
import { promises as fsPromises } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { extname, isAbsolute, join, relative, resolve, sep } from "path";
import {
  openDatabase,
  applyPragmas,
  isCorruption,
  latestValidBackup,
  checkOpenDb,
  dbUnavailable,
  clampLimit,
  copyBackupIntoPlace,
  truncateStored,
  STORE_CAPS,
  type AnyDatabase,
} from "../lib/sqlite.ts";
import { collectFindings, type Finding as SecretFinding, type Severity } from "../lib/redact.ts";
import { formatAge } from "../lib/format.ts";
import { asBool, asInt } from "../lib/config.ts";

const DB_DIR = join(homedir(), ".opencode-plugins", "code-review");
const DB_PATH = join(DB_DIR, "code-review.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;

const HELP = [
  "code-review — review code for security issues, bugs, style, and performance.",
  "",
  "  /code-review                        show this help",
  "  /code-review file <path>            review a specific file",
  "  /code-review diff                   review the current git diff",
  "  /code-review project [path]         review the entire project (default: current directory)",
  "  /code-review fix-all [reviewId]     spawn fixer agents for a review's findings",
  "  /code-review deep [path]            deep LLM-only review of a whole codebase",
  "  /code-review history [limit]        show past reviews",
  "  /code-review stats [reviewId]       show statistics",
  "  /code-review trends [limit]         show trend analysis",
  "  /code-review fix <reviewId> [findingId]  print auto-fix hints for a finding",
  "  /code-review rules                  list custom rules",
  "  /code-review config                 show configuration",
  "",
  "  /deep-code-review [path]            standalone deep review command",
  "",
  "Reviews persist to the local database. `file`, `diff`, `project` and `deep`",
  "auto-spawn fixer subagents on a free model (falling back to asking you before",
  "using the cheapest paid model). Set options.agentFixes=false to only report.",
  "",
  "Examples:",
  "  /code-review file src/index.ts",
  "  /code-review diff",
  "  /code-review project",
  "  /code-review fix-all",
  "  /code-review deep",
  "  /code-review history 10",
  "  /code-review stats",
  "  /code-review trends 5",
  "  /code-review fix 3",
  "  /code-review fix 3 7",
].join("\n");

// --- Types ---

type ReviewSeverity = "low" | "medium" | "high";
type ReviewCategory = "security" | "bugs" | "style" | "performance";

interface ReviewFinding {
  file: string;
  line: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  message: string;
  suggestion: string;
  confidence: number;
  autoFix?: string;
  ruleId: string;
}

interface ReviewResult {
  findings: ReviewFinding[];
  filesReviewed: number;
  durationMs: number;
  stats?: ReviewStats;
  /** CR-8: files the scanner refused to read (oversized), surfaced in the report. */
  skipped?: string[];
}

interface ReviewStats {
  totalFindings: number;
  bySeverity: Record<ReviewSeverity, number>;
  byCategory: Record<ReviewCategory, number>;
  byFile: Record<string, number>;
  byRule: Record<string, number>;
  avgConfidence: number;
  fixableCount: number;
}

interface TrendData {
  direction: "improving" | "worsening" | "stable";
  changePercent: number;
  previousCount: number;
  currentCount: number;
  message: string;
  /** False when the window held a single review, so nothing was compared. */
  comparable: boolean;
}

interface CustomRule {
  id: string;
  name: string;
  pattern: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  message: string;
  suggestion: string;
  enabled: boolean;
}

interface CodeReviewConfig {
  enabled: boolean;
  severity: ReviewSeverity;
  maxFiles: number;
  maxFindingsPerFile: number;
  rules: {
    security: boolean;
    bugs: boolean;
    style: boolean;
    performance: boolean;
  };
  excludePatterns: string[];
  includePatterns: string[];
  customRules: CustomRule[];
  severityOverrides: Record<string, ReviewSeverity>;
  focusAreas: ReviewCategory[];
  enableAutoFix: boolean;
  enableTrendAnalysis: boolean;
  enableConfidenceScoring: boolean;
  /** Spawn fixer subagents for findings after a targeted review. */
  enableAgentFixes: boolean;
  /** When the static scan is sparse, hand the target to a free LLM reviewer. */
  enableLlmFallback: boolean;
  /** Findings below this count trigger the free-LLM fallback pass. */
  llmFallbackThreshold: number;
  /** Pinned `providerID/modelID` for fixer children ("" = auto: free, else ask). */
  fixModel: string;
  /** Pinned `providerID/modelID` for the free-LLM fallback reviewer ("" = auto). */
  reviewModel: string;
  /** Maximum fixer children allowed to run at once. */
  maxFixAgents: number;
  /** Expose the /deep-code-review command. */
  deepReview: boolean;
  /** "agent": hand a brief to the current agent; "direct": spawn children from the plugin. */
  spawnMode: "agent" | "direct";
  /** Seconds to wait for a direct-mode reviewer child before using its partial output. */
  directReviewTimeoutSec: number;
}

// --- File walking ---

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".bzr",
  "vendor", "bower_components", "deps", "pods",
  "dist", "build", ".next", ".nuxt", ".output", "out",
  "target", "bin", "obj", "_build", "elm-stuff",
  "coverage", ".nyc_output", ".cache", "cache",
  "__pycache__", ".venv", "venv", "virtualenv",
  ".opencode-plugins",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
  ".ds_store", "thumbs.db", ".directory", "desktop.ini",
]);

const DEFAULT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
  ".swift", ".kt", ".rb", ".php",
  ".css", ".scss", ".less", ".sass",
  ".html", ".htm", ".xml", ".json", ".yaml", ".yml", ".toml",
  ".md", ".sql", ".graphql", ".proto",
  ".sh", ".bash", ".zsh",
  ".tf", ".hcl",
]);

const BASENAME_ALLOW = new Set([
  "dockerfile", "makefile", "gemfile", "rakefile", "vagrantfile",
  "jenkinsfile", "cmakelists.txt",
]);

/**
 * Walk-time include/exclude filtering.
 *
 * These were applied after the walk, so every excluded file was still read,
 * stat-ed and yielded, and `maxFiles` spent its budget on files the caller was
 * about to throw away — a review capped at 10 files could read 200 and keep 3.
 * The patterns are substring tests against the project-relative path, so the
 * same decision can be made during the walk.
 */
interface WalkFilter {
  /** Walk root, used to build the relative path the patterns are matched against. */
  root: string;
  excludePatterns: string[];
  includePatterns: string[];
}

function buildWalkFilter(rootPath: string, cfg: CodeReviewConfig): WalkFilter {
  return { root: rootPath, excludePatterns: cfg.excludePatterns, includePatterns: cfg.includePatterns };
}

/** Project-relative, separator-normalized path — the form the patterns are written against. */
function walkRelPath(filter: WalkFilter, fullPath: string): string {
  return relative(filter.root, fullPath).split(sep).join("/");
}

/**
 * Excludes are substring tests, so a matching directory only ever matches by
 * itself: every descendant's relative path contains the directory's, so pruning
 * it here yields exactly the files the old post-walk filter would have kept.
 * Includes are not prunable — a directory can miss the pattern while a file
 * inside it matches — so they only ever filter files.
 */
function excludedByWalkFilter(filter: WalkFilter, fullPath: string): boolean {
  if (filter.excludePatterns.length === 0) return false;
  const rel = walkRelPath(filter, fullPath);
  return filter.excludePatterns.some((p) => rel.includes(p));
}

/** Both rules, as `reviewProject` used to apply them after the walk. */
function keptByWalkFilter(filter: WalkFilter, fullPath: string): boolean {
  if (excludedByWalkFilter(filter, fullPath)) return false;
  if (filter.includePatterns.length === 0) return true;
  const rel = walkRelPath(filter, fullPath);
  return filter.includePatterns.some((p) => rel.includes(p));
}

function* walkDir(dir: string, seen = new Set<string>(), filter?: WalkFilter): Generator<string> {
  try {
    const realPath = realpathSync(dir);
    if (seen.has(realPath)) return;
    seen.add(realPath);
  } catch {}
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith(".")) continue;
        if (filter && excludedByWalkFilter(filter, fullPath)) continue;
        yield* walkDir(fullPath, seen, filter);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!DEFAULT_EXTS.has(ext) && (ext !== "" || !BASENAME_ALLOW.has(entry.name.toLowerCase()))) continue;
        if (filter && !keptByWalkFilter(filter, fullPath)) continue;
        yield fullPath;
      } else {
        try {
          const st = statSync(fullPath);
          if (st.isFile()) {
            if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
            const ext = extname(entry.name).toLowerCase();
            if (!DEFAULT_EXTS.has(ext) && (ext !== "" || !BASENAME_ALLOW.has(entry.name.toLowerCase()))) continue;
            if (filter && !keptByWalkFilter(filter, fullPath)) continue;
            yield fullPath;
          } else if (st.isDirectory()) {
            if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
            if (entry.name.startsWith(".")) continue;
            if (filter && excludedByWalkFilter(filter, fullPath)) continue;
            yield* walkDir(fullPath, seen, filter);
          }
        } catch {
          // broken symlink or vanished
        }
      }
    }
  } catch {}
}

// --- Config resolution ---

function resolveConfig(options: Record<string, unknown> | undefined): CodeReviewConfig {
  const o: Record<string, unknown> = options ?? {};
  const env = (key: string): string | undefined => process.env[key];
  const asList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string") {
      return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  const rawSeverity = o.severity ?? env("OPENCODE_CODE_REVIEW_SEVERITY");
  const severity: ReviewSeverity =
    rawSeverity === "low" || rawSeverity === "medium" || rawSeverity === "high"
      ? rawSeverity
      : "medium";

  const rawRules = (o.rules ?? {}) as Record<string, unknown>;

  // Parse custom rules from config
  const rawCustomRules = Array.isArray(o.customRules) ? o.customRules : [];
  const customRules: CustomRule[] = rawCustomRules
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      id: String(r.id ?? `custom-${Math.random().toString(36).slice(2, 8)}`),
      name: String(r.name ?? "Custom rule"),
      pattern: String(r.pattern ?? ""),
      category: (["security", "bugs", "style", "performance"].includes(String(r.category))
        ? r.category
        : "bugs") as ReviewCategory,
      severity: (["low", "medium", "high"].includes(String(r.severity))
        ? r.severity
        : "medium") as ReviewSeverity,
      message: String(r.message ?? "Custom rule match"),
      suggestion: String(r.suggestion ?? "Review this code"),
      enabled: asBool(r.enabled, true),
    }))
    .filter((r) => r.pattern.length > 0);

  // Parse severity overrides
  const rawOverrides = (o.severityOverrides ?? {}) as Record<string, unknown>;
  const severityOverrides: Record<string, ReviewSeverity> = {};
  for (const [key, val] of Object.entries(rawOverrides)) {
    if (val === "low" || val === "medium" || val === "high") {
      severityOverrides[key] = val;
    }
  }

  // Parse focus areas
  const rawFocus = Array.isArray(o.focusAreas) ? o.focusAreas : [];
  const focusAreas: ReviewCategory[] = rawFocus
    .filter((v): v is ReviewCategory =>
      ["security", "bugs", "style", "performance"].includes(String(v)),
    );

  return {
    enabled: asBool(o.enabled ?? env("OPENCODE_CODE_REVIEW_ENABLED"), true),
    severity,
    maxFiles: asInt(o.maxFiles ?? env("OPENCODE_CODE_REVIEW_MAX_FILES"), 50),
    maxFindingsPerFile: asInt(o.maxFindingsPerFile ?? env("OPENCODE_CODE_REVIEW_MAX_FINDINGS_PER_FILE"), 20),
    rules: {
      security: asBool(rawRules.security ?? env("OPENCODE_CODE_REVIEW_RULES_SECURITY"), true),
      bugs: asBool(rawRules.bugs ?? env("OPENCODE_CODE_REVIEW_RULES_BUGS"), true),
      style: asBool(rawRules.style ?? env("OPENCODE_CODE_REVIEW_RULES_STYLE"), true),
      performance: asBool(rawRules.performance ?? env("OPENCODE_CODE_REVIEW_RULES_PERFORMANCE"), true),
    },
    excludePatterns: asList(o.excludePatterns ?? env("OPENCODE_CODE_REVIEW_EXCLUDE_PATTERNS")),
    includePatterns: asList(o.includePatterns ?? env("OPENCODE_CODE_REVIEW_INCLUDE_PATTERNS")),
    customRules,
    severityOverrides,
    focusAreas,
    enableAutoFix: asBool(o.enableAutoFix ?? env("OPENCODE_CODE_REVIEW_ENABLE_AUTOFIX"), true),
    enableTrendAnalysis: asBool(o.enableTrendAnalysis ?? env("OPENCODE_CODE_REVIEW_ENABLE_TRENDS"), true),
    enableConfidenceScoring: asBool(o.enableConfidenceScoring ?? env("OPENCODE_CODE_REVIEW_ENABLE_CONFIDENCE"), true),
    enableAgentFixes: asBool(o.enableAgentFixes ?? env("OPENCODE_CODE_REVIEW_AGENT_FIXES"), true),
    enableLlmFallback: asBool(o.enableLlmFallback ?? env("OPENCODE_CODE_REVIEW_LLM_FALLBACK"), true),
    llmFallbackThreshold: asInt(o.llmFallbackThreshold ?? env("OPENCODE_CODE_REVIEW_LLM_FALLBACK_THRESHOLD"), 5),
    fixModel: String(o.fixModel ?? env("OPENCODE_CODE_REVIEW_FIX_MODEL") ?? "").trim(),
    reviewModel: String(o.reviewModel ?? env("OPENCODE_CODE_REVIEW_REVIEW_MODEL") ?? "").trim(),
    maxFixAgents: Math.max(1, asInt(o.maxFixAgents ?? env("OPENCODE_CODE_REVIEW_MAX_FIX_AGENTS"), 6)),
    deepReview: asBool(o.deepReview ?? env("OPENCODE_CODE_REVIEW_DEEP"), true),
    spawnMode:
      String(o.spawnMode ?? env("OPENCODE_CODE_REVIEW_SPAWN_MODE") ?? "agent").toLowerCase() === "direct"
        ? "direct"
        : "agent",
    directReviewTimeoutSec: Math.max(
      30,
      asInt(o.directReviewTimeoutSec ?? env("OPENCODE_CODE_REVIEW_DIRECT_REVIEW_TIMEOUT_SEC"), 300),
    ),
  };
}

function severityRank(s: ReviewSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function meetsSeverity(finding: ReviewSeverity, threshold: ReviewSeverity): boolean {
  return severityRank(finding) >= severityRank(threshold);
}

// --- Review rules ---

interface Rule {
  id: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  confidence: number;
  /** CR-3: how many lines before / after the target the check reads. 0 = single-line rule. */
  contextBefore?: number;
  contextAfter?: number;
  /** CR-3: check scans to the end of the file — a diff hunk can never satisfy it. */
  wholeFile?: boolean;
  check: (line: string, lineNumber: number, lines: string[]) => { message: string; suggestion: string; autoFix?: string } | null;
}

/** CR-8: files bigger than this are skipped rather than read and line-split synchronously. */
const MAX_REVIEW_BYTES = 1024 * 1024;

/** CR-7: user-supplied patterns only ever see this many leading characters of a line. */
const MAX_PATTERN_SCAN_CHARS = 2000;

/** CR-7: user-supplied patterns longer than this are refused outright. */
const MAX_PATTERN_CHARS = 500;

/** CR-10: how far back SHADOWED_VARIABLE looks for an enclosing declaration. */
const SHADOW_SCAN_LINES = 400;

/** CR-10: how far ahead UNUSED_VARIABLE scans for a single usage before giving up. */
const UNUSED_SCAN_LINES = 500;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CR-10/CR-8: `\bname\b` matchers compiled once per identifier instead of once
 * per declaration×line pair (the old code rebuilt the RegExp inside the line loop).
 */
const WORD_RE_CACHE = new Map<string, RegExp>();

function wordRegex(name: string): RegExp {
  let re = WORD_RE_CACHE.get(name);
  if (!re) {
    if (WORD_RE_CACHE.size > 1000) WORD_RE_CACHE.clear();
    re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    WORD_RE_CACHE.set(name, re);
  }
  return re;
}

const DECL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

/**
 * CR-7 / CR-12: crude nested-quantifier detector (the shape behind catastrophic
 * backtracking: `(a+)+`, `(.*)*`, `(x*){2,}`). Shared by the REGEX_DOS rule and
 * by custom-rule validation so both use the same heuristic.
 */
function hasNestedQuantifier(pattern: string): boolean {
  if (/\((?:[^()\\]|\\.)*[*+][^()]*\)\s*[*+{]/.test(pattern)) return true;
  if (/\((?:[^()\\]|\\.)*\)[*+]\s*[*+{]/.test(pattern)) return true;
  if (/\[[^\]]*\+[^]]*\+\]/.test(pattern)) return true;
  return false;
}

/** CR-7: result of compiling a user/agent-supplied pattern once per review. */
type CompiledPattern = { ok: true; re: RegExp } | { ok: false; reason: string };

/** Compiled user patterns, reused across reviews; cleared when a rule is
 * written so an edited pattern never picks up a stale compile. */
const USER_PATTERN_CACHE = new Map<string, CompiledPattern>();
function invalidateUserPatternCache(): void {
  USER_PATTERN_CACHE.clear();
}

/**
 * CR-7: compile a user pattern once, defensively. Invalid regexes are rejected
 * (they used to be accepted and silently never matched); nested-quantifier
 * suspects are refused too, because a 46-char line is enough for `(a+)+$` to
 * block the host for minutes — a length cap alone would not help.
 */
function compileUserPattern(pattern: string): CompiledPattern {
  const cached = USER_PATTERN_CACHE.get(pattern);
  if (cached) return cached;
  const result = compileUserPatternUncached(pattern);
  USER_PATTERN_CACHE.set(pattern, result);
  return result;
}

function compileUserPatternUncached(pattern: string): CompiledPattern {
  if (pattern.length === 0) return { ok: false, reason: "pattern is empty" };
  if (pattern.length > MAX_PATTERN_CHARS) {
    return { ok: false, reason: `pattern is longer than ${MAX_PATTERN_CHARS} characters` };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { ok: false, reason: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (hasNestedQuantifier(pattern)) {
    return { ok: false, reason: "nested quantifiers detected (ReDoS risk); rewrite the pattern without (x+)+ / (x*)* groups" };
  }
  return { ok: true, re };
}

/**
 * Cheap sound prefilter for rule regexes. Extracts the literals that a regex
 * must contain to match (runs of literal characters not inside a character
 * class, group with alternation, or quantified/optional atom). If every match
 * of the pattern contains these tokens, a line that lacks any of them can
 * never match, so the rule is skipped for that line. When extraction cannot
 * prove a required literal, returns null and the rule always runs.
 */
function requiredLiterals(pattern: string): { tokens: string[]; ci: boolean } | null {
  const tokens: string[] = [];
  let current = "";
  let inClass = false;
  // One entry per open group: whether it has a top-level alternation, and how
  // many tokens were already committed when it opened.
  const groups: Array<{ alt: boolean; startLen: number }> = [];
  const anyAltGroup = () => groups.some((g) => g.alt);
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined && /[dDwWsSbBfnrtv]/.test(next)) {
        flushRun();
        i++;
      } else if (next === "x") {
        flushRun();
        i += 3; // skip \xHH
      } else if (next === "u") {
        flushRun();
        i += pattern[i + 2] === "{" ? pattern.indexOf("}", i) - i : 5;
      } else if (next === "0" || next === "c" || next === "k" || next === "p" || next === "P") {
        flushRun();
        i++;
      } else if (!inClass && next !== undefined && /[^a-zA-Z]/.test(next)) {
        // Escaped literal candidate: part of the literal run (e.g. "\(").
        if (!anyAltGroup()) current += next;
        i++;
      } else {
        flushRun();
        i++;
      }
      continue;
    }
    if (inClass) {
      if (c === "\\") { i++; continue; }
      if (c === "]") inClass = false;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        flushRun();
        break;
      case "(": {
        flushRun();
        const two = pattern.slice(i + 1, i + 3);
        if (two === "?>" || two === "?:" ) {
          groups.push({ alt: false, startLen: tokens.length });
          i += 2;
        } else if (two === "?=" || two === "?!") {
          // Lookaround contents must NOT become required tokens.
          groups.push({ alt: true, startLen: tokens.length });
          i += 2;
        } else if (pattern.slice(i + 1, i + 4) === "?<=" || pattern.slice(i + 1, i + 4) === "?<!") {
          groups.push({ alt: true, startLen: tokens.length });
          i += 3;
        } else if (pattern[i + 1] === "?" && pattern[i + 2] === "<") {
          // Named group (?<name>
          const close = pattern.indexOf(">", i + 3);
          groups.push({ alt: false, startLen: tokens.length });
          i = close === -1 ? i + 1 : close;
        } else {
          groups.push({ alt: false, startLen: tokens.length });
        }
        break;
      }
      case ")": {
        flushRun();
        const g = groups.pop();
        const optional = pattern[i + 1] === "?" || pattern[i + 1] === "*" || pattern[i + 1] === "{";
        if (g && (g.alt || optional)) {
          tokens.length = g.startLen;
        }
        if (optional) i++;
        break;
      }
      case "|":
        if (groups.length > 0) {
          const top = groups[groups.length - 1];
          top.alt = true;
          // Nothing inside an alternation group is mandatory.
          tokens.length = top.startLen;
          current = "";
        } else {
          return null; // top-level alternation: nothing is mandatory
        }
        break;
      case "^":
      case "$":
      case ".":
        flushRun();
        break;
      case "*":
      case "?":
        discardRun();
        break;
      case "+":
        flushRun();
        break;
      case "{": {
        // Treat {m,...} like '*' unless it is known to require at least one.
        const close = pattern.indexOf("}", i);
        const spec = close === -1 ? "" : pattern.slice(i + 1, close);
        const min = Number.parseInt(spec.split(",")[0].trim() || "0", 10);
        if (min >= 1) flushRun();
        else discardRun();
        if (close !== -1) i = close;
        break;
      }
      default:
        if (!anyAltGroup()) current += c;
    }
  }
  flushRun();
  return tokens.length > 0 ? { tokens, ci: false } : null;

  function flushRun(): void {
    if (current.length >= 2) tokens.push(current);
    current = "";
  }
  function discardRun(): void {
    current = "";
  }
}

/** Sound token gate for a rule. Custom rules derive from their pattern;
 * built-in rules derive from guard regexes visible in their check source
 * (only `if (!/re/.test(line)) return null` / `line.match` + `if (!m)`
 * shapes are accepted, because a finding necessarily passes those guards). */
function ruleGate(pattern: string | undefined, checkSrc?: string): { tokens: string[]; ci: boolean } | null {
  if (pattern !== undefined) {
    const lit = requiredLiterals(pattern);
    return lit ? { ...lit, ci: false } : null;
  }
  if (checkSrc === undefined) return null;
  const guards: Array<{ tokens: string[]; ci: boolean }> = [];
  const guardRe = /if \(!\s*\/((?:[^/\\]|\\.)+)\/([a-z]*)\.test\(line\)\s*\)\s*return null/g;
  let m: RegExpExecArray | null;
  while ((m = guardRe.exec(checkSrc)) !== null) {
    const r = requiredLiterals(m[1]);
    if (!r) return null;
    guards.push({ tokens: r.tokens, ci: m[2].includes("i") });
  }
  const matchRe = /line\.match\(\s*\/((?:[^/\\]|\\.)+)\/([a-z]*)\)[^;]*;[\s\S]{0,80}?if \(!m\)\s*return null/g;
  while ((m = matchRe.exec(checkSrc)) !== null) {
    const r = requiredLiterals(m[1]);
    if (!r) return null;
    guards.push({ tokens: r.tokens, ci: m[2].includes("i") });
  }
  if (guards.length === 0) return null;
  return { tokens: guards.flatMap((g) => g.tokens), ci: guards.some((g) => g.ci) };
}

/**
 * CR-10: which declarations in `lines` shadow an enclosing one, keyed
 * `${lineIndex0Based}:${name}`. Brace depth is tracked so two sibling
 * function-scope declarations of the same name no longer collide, and
 * `for (let i …)` loop headers are exempt (their scope ends with the loop).
 * Cached per array so the cost is one pass per file, not per declaration.
 */
const SHADOW_CACHE = new WeakMap<string[], Set<string>>();

function shadowedDeclarations(lines: string[]): Set<string> {
  const cached = SHADOW_CACHE.get(lines);
  if (cached) return cached;
  const out = new Set<string>();
  const scopes: Array<Map<string, number>> = [new Map()];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    for (let k = 0; k < closes && scopes.length > 1; k++) scopes.pop();
    for (let k = 0; k < opens; k++) scopes.push(new Map());
    const m = DECL_RE.exec(line);
    if (!m) continue;
    const before = line.slice(0, m.index);
    // `for (let i = …)` / `while (let …)` headers are scoped to the statement.
    if (/\b(?:for|while|if|switch|catch)\s*\($/.test(before.trim()) || /\b(?:for|while)\s*\(/.test(before)) continue;
    const name = m[1];
    if (scopes.some((s) => s.has(name))) out.add(`${i}:${name}`);
    scopes[scopes.length - 1].set(name, i);
  }
  SHADOW_CACHE.set(lines, out);
  return out;
}

const RULES: Rule[] = [
  // --- Security ---
  {
    id: "SQL_INJECTION",
    category: "security",
    severity: "high",
    confidence: 0.85,
    check: (line) => {
      const m = line.match(/(?:execute|query|exec)\s*\(\s*(?:`[^`]*\$\{[^}]*\}[^`]*`|"[^"]*"\s*\+|\+\s*"[^"]*"\s*\+)/i);
      if (!m) return null;
      return {
        message: "Possible SQL injection via string concatenation",
        suggestion: "Use parameterized queries or prepared statements instead of string concatenation",
        autoFix: "// Instead of: db.query(\"SELECT * FROM users WHERE id = \" + userId)\n// Use: db.query(\"SELECT * FROM users WHERE id = ?\", [userId])",
      };
    },
  },
  {
    id: "XSS_INNER_HTML",
    category: "security",
    severity: "high",
    confidence: 0.8,
    check: (line) => {
      if (!/innerHTML\s*=/.test(line)) return null;
      if (/innerHTML\s*=\s*["'][^"']*["']/.test(line) && !/\$\{/.test(line) && !/\+/.test(line)) return null;
      return {
        message: "Potential XSS via innerHTML assignment",
        suggestion: "Use textContent or sanitize HTML with a library like DOMPurify before setting innerHTML",
        autoFix: "// Instead of: element.innerHTML = userInput\n// Use: element.textContent = userInput\n// Or: element.innerHTML = DOMPurify.sanitize(userInput)",
      };
    },
  },
  {
    id: "EVAL_USAGE",
    category: "security",
    severity: "high",
    confidence: 0.95,
    check: (line) => {
      if (!/\beval\s*\(/.test(line)) return null;
      return {
        message: "Use of eval() is a security risk",
        suggestion: "Avoid eval(); use JSON.parse for data or a safe evaluation alternative",
        autoFix: "// Instead of: eval(userInput)\n// Use: JSON.parse(userInput) // for JSON data",
      };
    },
  },
  {
    id: "HARDCODED_SECRET",
    category: "security",
    severity: "high",
    confidence: 0.9,
    check: (line) => {
      const m = line.match(/(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth)\s*[:=]\s*["']([^"']{8,})["']/i);
      if (!m) return null;
      const key = m[0].split(/[:=]/)[0].toLowerCase();
      if (key.includes("placeholder") || key.includes("example") || key.includes("test") || key.includes("dummy")) return null;
      return {
        message: `Hardcoded secret detected: ${key.trim()}`,
        suggestion: "Move secrets to environment variables or a secrets manager",
        autoFix: `// Instead of: const apiKey = "${m[1]}"\n// Use: const apiKey = process.env.API_KEY`,
      };
    },
  },
  {
    id: "PATH_TRAVERSAL",
    category: "security",
    severity: "high",
    confidence: 0.75,
    check: (line) => {
      if (!/(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream|createWriteStream)\s*\(/.test(line)) return null;
      if (!/\.\.\//.test(line) && !/\$\{.*\}/.test(line) && !/\+/.test(line)) return null;
      return {
        message: "Potential path traversal in file operation",
        suggestion: "Validate and sanitize file paths; use path.resolve and check the result stays within the allowed directory",
        autoFix: "import path from 'path';\nconst safePath = path.resolve(baseDir, userPath);\nif (!safePath.startsWith(baseDir)) throw new Error('Invalid path');",
      };
    },
  },
  {
    id: "WEAK_CRYPTO",
    category: "security",
    severity: "medium",
    confidence: 0.85,
    check: (line) => {
      if (!/\b(?:md5|sha1)\s*\(/.test(line) && !/["'](?:md5|sha1)["']/.test(line)) return null;
      return {
        message: "Weak cryptographic hash function detected",
        suggestion: "Use SHA-256 or stronger for hashing; use bcrypt/argon2 for passwords",
        autoFix: "// Instead of: crypto.createHash('md5')\n// Use: crypto.createHash('sha256')\n// For passwords: bcrypt.hash(password, 10)",
      };
    },
  },
  {
    id: "DISABLED_TLS",
    category: "security",
    severity: "high",
    confidence: 0.95,
    check: (line) => {
      if (!/rejectUnauthorized\s*:\s*false/.test(line)) return null;
      return {
        message: "TLS certificate validation disabled",
        suggestion: "Set rejectUnauthorized: true (or remove the option) to prevent man-in-the-middle attacks",
        autoFix: "// Remove or change to:\nrejectUnauthorized: true",
      };
    },
  },
  {
    id: "CHILD_PROCESS",
    category: "security",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      if (!/exec\s*\(|execSync\s*\(|spawn\s*\(/.test(line)) return null;
      if (/exec\s*\(\s*["'`]/.test(line) && !/\$\{/.test(line) && !/\+/.test(line)) return null;
      return {
        message: "Shell command with possible user input",
        suggestion: "Use execFile or spawn with argument arrays to avoid shell injection",
        autoFix: "// Instead of: exec(`ls ${dir}`)\n// Use: execFile('ls', [dir])",
      };
    },
  },
  {
    id: "INSECURE_RANDOM",
    category: "security",
    severity: "medium",
    confidence: 0.8,
    check: (line) => {
      if (!/Math\.random\s*\(/.test(line)) return null;
      if (/crypto|randomBytes|randomUUID/.test(line)) return null;
      return {
        message: "Math.random() is not cryptographically secure",
        suggestion: "Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive random values",
        autoFix: "// Instead of: Math.random().toString(36).slice(2)\n// Use: crypto.randomBytes(16).toString('hex')",
      };
    },
  },
  {
    id: "PROTOTYPE_POLLUTION",
    category: "security",
    severity: "high",
    confidence: 0.7,
    check: (line) => {
      if (!/\[\s*["']__proto__["']\s*\]/.test(line) && !/Object\.assign\s*\(\s*\{\s*\}/.test(line)) return null;
      if (/Object\.create\(null\)|Object\.freeze/.test(line)) return null;
      return {
        message: "Potential prototype pollution vulnerability",
        suggestion: "Use Object.create(null) for safe objects, or validate keys before assignment",
        autoFix: "// Instead of: obj[key] = value\n// Use: Object.defineProperty(obj, key, { value, writable: true })\n// Or use a Map instead of a plain object",
      };
    },
  },
  {
    id: "REGEX_DOS",
    category: "security",
    severity: "medium",
    confidence: 0.6,
    check: (line) => {
      // CR-12: the old pattern spelled `new Regex(` and could never match real
      // code, and its "suppressions" (a backreference against the matched
      // substring) only ever hid legitimate hits. Same heuristic as CR-7.
      const m = line.match(/new\s+RegExp\s*\(\s*["'`]([^"'`]*)["'`]/);
      if (!m) return null;
      if (!hasNestedQuantifier(m[1])) return null;
      return {
        message: "Potential ReDoS: regex with nested quantifiers",
        suggestion: "Simplify the regex pattern or use a regex engine with linear-time guarantees",
      };
    },
  },

  // --- Bugs ---
  {
    id: "NULL_DEREFERENCE",
    category: "bugs",
    severity: "high",
    confidence: 0.6,
    check: (line) => {
      const m = line.match(/(\w+(?:\.\w+)+)\s*\(/);
      if (!m) return null;
      const obj = m[1];
      if (line.includes(`${obj}?.`) || line.includes(`${obj} &&`)) return null;
      return {
        message: `Possible null dereference: ${obj} may be null/undefined`,
        suggestion: "Add null checks or use optional chaining (?.) before accessing properties",
        autoFix: `// Instead of: ${obj}.method()\n// Use: ${obj}?.method()`,
      };
    },
  },
  {
    id: "UNHANDLED_PROMISE",
    category: "bugs",
    severity: "medium",
    confidence: 0.75,
    check: (line) => {
      if (!/\.then\s*\(/.test(line)) return null;
      if (line.includes(".catch(") || line.includes("try {") || line.includes("await ")) return null;
      return {
        message: "Promise .then() without .catch() — unhandled rejection possible",
        suggestion: "Add .catch() handler or use async/await with try/catch",
        autoFix: "// Instead of: promise.then(result => ...)\n// Use: promise.then(result => ...).catch(err => console.error(err))\n// Or: try { const result = await promise; } catch (err) { ... }",
      };
    },
  },
  {
    id: "MISSING_AWAIT",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    contextBefore: 1,
    check: (line, _ln, lines) => {
      const m = line.match(/(\w+)\s*\.\s*(?:then|catch)\s*\(/);
      if (!m) return null;
      const prevLine = lines[_ln - 2] ?? "";
      if (prevLine.includes("await ") || prevLine.includes("return ")) return null;
      return {
        message: "Async operation may be missing await",
        suggestion: "Add await before the promise chain or return it to the caller",
        autoFix: "// Instead of: promise.then(result => ...)\n// Use: const result = await promise.then(result => ...)",
      };
    },
  },
  {
    id: "OFF_BY_ONE",
    category: "bugs",
    severity: "medium",
    confidence: 0.65,
    check: (line) => {
      const m = line.match(/(\w+)\.length\s*([<>]=?)\s*(\d+)/);
      if (!m) return null;
      const op = m[2];
      const num = parseInt(m[3], 10);
      if (op === "<" && num === 0) return null;
      if (op === "<=" && num === 0) return null;
      if (op === ">" && num === 0) return null;
      if (op === ">=" && num === 1) return null;
      if (op === "<" && num > 1) {
        return {
          message: `Possible off-by-one: length comparison with ${num}`,
          suggestion: "Verify the comparison operator and boundary value are correct",
        };
      }
      return null;
    },
  },
  {
    id: "RACE_CONDITION",
    category: "bugs",
    severity: "medium",
    confidence: 0.6,
    contextAfter: 1,
    check: (line, _ln, lines) => {
      if (!/readFile|readFileSync/.test(line)) return null;
      const nextLine = lines[_ln] ?? "";
      if (!/writeFile|writeFileSync/.test(nextLine)) return null;
      return {
        message: "Potential race condition: read followed by write without atomicity",
        suggestion: "Use atomic write patterns (write to temp file then rename) or file locking",
      };
    },
  },
  {
    id: "EMPTY_CATCH",
    category: "bugs",
    severity: "medium",
    confidence: 0.85,
    check: (line) => {
      if (!/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) return null;
      return {
        message: "Empty catch block swallows errors silently",
        suggestion: "Log the error or rethrow it; at minimum add a comment explaining why it's safe to ignore",
        autoFix: "// Instead of: catch (e) {}\n// Use: catch (e) { console.error('Operation failed:', e); }",
      };
    },
  },
  {
    id: "VAR_USAGE",
    category: "bugs",
    severity: "medium",
    confidence: 0.9,
    check: (line) => {
      if (!/^\s*var\s+/.test(line)) return null;
      return {
        message: "Use of var — function-scoped and hoisted",
        suggestion: "Use const by default, let when reassignment is needed",
        autoFix: line.replace(/^\s*var\s+/, "const "),
      };
    },
  },
  {
    id: "LOOSE_EQUALITY",
    category: "bugs",
    severity: "low",
    confidence: 0.85,
    check: (line) => {
      if (!/[^=!<>]==[^=]/.test(line)) return null;
      if (/===/.test(line)) return null;
      return {
        message: "Loose equality (==) can cause unexpected type coercion",
        suggestion: "Use strict equality (===) unless intentional type coercion is needed",
        autoFix: line.replace(/([^=!<>])==([^=])/g, "$1===$2"),
      };
    },
  },
  {
    id: "UNREACHABLE_CODE",
    category: "bugs",
    severity: "medium",
    confidence: 0.8,
    contextAfter: 1,
    check: (line, _ln, lines) => {
      if (!/^\s*return\b/.test(line)) return null;
      const nextLine = lines[_ln] ?? "";
      if (!nextLine.trim() || nextLine.trim().startsWith("//") || nextLine.trim().startsWith("}")) return null;
      if (/^\s*(?:return|throw|break|continue)\b/.test(nextLine)) return null;
      return {
        message: "Unreachable code after return statement",
        suggestion: "Remove the unreachable code or fix the control flow",
      };
    },
  },
  {
    id: "MISSING_BREAK",
    category: "bugs",
    severity: "high",
    confidence: 0.75,
    contextAfter: 15,
    check: (line, _ln, lines) => {
      if (!/^\s*case\s+/.test(line)) return null;
      // Look ahead for break/return/throw before next case
      for (let i = _ln; i < Math.min(_ln + 15, lines.length); i++) {
        const l = lines[i] ?? "";
        if (/^\s*(?:case\s+|default\s*:)/.test(l)) {
          // Check if previous non-empty line has break/return/throw
          for (let j = i - 1; j >= _ln; j--) {
            const prev = (lines[j] ?? "").trim();
            if (!prev || prev.startsWith("//")) continue;
            if (/^\s*(?:break|return|throw)\b/.test(prev)) return null;
            break;
          }
          return {
            message: "Missing break in switch case — fall-through may be unintended",
            suggestion: "Add break at the end of the case, or add a comment if fall-through is intentional",
            autoFix: "case 'value':\n  doSomething();\n  break; // Add this",
          };
        }
        if (/^\s*(?:break|return|throw)\b/.test(l)) return null;
      }
      return null;
    },
  },
  {
    id: "UNUSED_VARIABLE",
    category: "bugs",
    severity: "low",
    confidence: 0.6,
    wholeFile: true,
    check: (line, _ln, lines) => {
      const m = DECL_RE.exec(line);
      if (!m) return null;
      const varName = m[1];
      // CR-10: only a variable never mentioned again is unused. The old code
      // counted `<= 1` and therefore flagged every write-once variable.
      // CR-8: matcher hoisted out of the line loop (was one RegExp per pair).
      const re = wordRegex(varName);
      const end = Math.min(lines.length, _ln + UNUSED_SCAN_LINES);
      for (let i = _ln; i < end; i++) {
        const l = lines[i] ?? "";
        if (l.includes(varName) && re.test(l)) return null;
      }
      // Unknown beyond the scan window: assume a use exists further down.
      if (_ln + UNUSED_SCAN_LINES < lines.length) return null;
      return {
        message: `Unused variable: ${varName} is declared but never used`,
        suggestion: "Remove the unused variable or use it",
      };
    },
  },
  {
    id: "ANY_CAST",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      if (!/as\s+any\b/.test(line) && !/:\s*any\b/.test(line)) return null;
      if (/:\s*any\[\]/.test(line)) return null;
      return {
        message: "Use of 'any' type defeats TypeScript type safety",
        suggestion: "Use a specific type or unknown with type narrowing",
        autoFix: "// Instead of: const data: any = response\n// Use: const data: unknown = response\n// Then narrow: if (typeof data === 'string') { ... }",
      };
    },
  },
  {
    id: "FLOATING_PROMISE",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      if (!/\b(?:fetch|axios|request|http)\s*\(/.test(line)) return null;
      if (/await\s+|return\s+|\.then\s*\(|void\s+/.test(line)) return null;
      return {
        message: "Floating promise — async operation not awaited or returned",
        suggestion: "Add await, return the promise, or use void if intentionally fire-and-forget",
        autoFix: "// Instead of: fetch(url)\n// Use: await fetch(url)\n// Or: return fetch(url)\n// Or if intentional: void fetch(url)",
      };
    },
  },
  {
    id: "UNCLOSED_RESOURCE",
    category: "bugs",
    severity: "medium",
    confidence: 0.65,
    contextAfter: 20,
    check: (line, _ln, lines) => {
      if (!/\.connect\s*\(|\.open\s*\(|createConnection/.test(line)) return null;
      // Check if close/disconnect is called within next 20 lines
      for (let i = _ln; i < Math.min(_ln + 20, lines.length); i++) {
        if (/\.close\s*\(|\.disconnect\s*\(|\.end\s*\(/.test(lines[i] ?? "")) return null;
      }
      return {
        message: "Resource may not be properly closed",
        suggestion: "Ensure connections/files are closed in a finally block or using try-with-resources",
      };
    },
  },
  {
    id: "INFINITE_LOOP",
    category: "bugs",
    severity: "high",
    confidence: 0.6,
    contextAfter: 15,
    check: (line, _ln, lines) => {
      if (!/while\s*\(\s*true\s*\)/.test(line)) return null;
      // Check for break within next 15 lines
      for (let i = _ln; i < Math.min(_ln + 15, lines.length); i++) {
        if (/\bbreak\b/.test(lines[i] ?? "")) return null;
      }
      return {
        message: "Potential infinite loop: while(true) without visible break",
        suggestion: "Ensure there is a break condition or use a bounded loop",
      };
    },
  },
  {
    id: "SHADOWED_VARIABLE",
    category: "bugs",
    severity: "low",
    confidence: 0.55,
    wholeFile: true,
    check: (line, _ln, lines) => {
      const m = DECL_RE.exec(line);
      if (!m) return null;
      const varName = m[1];
      // CR-10: brace-depth scoping (computed once per file, cached) so two
      // separate function-scope `const result` declarations, or two
      // `for (let i …)` loops, are no longer reported as shadowing.
      if (!shadowedDeclarations(lines).has(`${_ln - 1}:${varName}`)) return null;
      return {
        message: `Variable shadowing: ${varName} is redeclared`,
        suggestion: "Use a different variable name to avoid confusion",
      };
    },
  },

  // --- Style ---
  {
    id: "CONSOLE_LOG",
    category: "style",
    severity: "low",
    confidence: 0.9,
    check: (line) => {
      if (!/console\.(log|debug|info)\s*\(/.test(line)) return null;
      return {
        message: "console.log/debug/info left in code",
        suggestion: "Remove debug logging or use a proper logging library with level control",
        autoFix: "// Remove or replace with:\n// logger.debug('message')",
      };
    },
  },
  {
    id: "TODO_COMMENT",
    category: "style",
    severity: "low",
    confidence: 0.95,
    check: (line) => {
      if (!/\/\/\s*(?:TODO|FIXME|HACK|XXX)/i.test(line)) return null;
      return {
        message: "TODO/FIXME comment found",
        suggestion: "Track this in an issue tracker; remove the comment when resolved",
      };
    },
  },
  {
    id: "LONG_LINE",
    category: "style",
    severity: "low",
    confidence: 0.95,
    check: (line) => {
      if (line.length <= 120) return null;
      return {
        message: `Line exceeds 120 characters (${line.length})`,
        suggestion: "Break long lines for readability",
      };
    },
  },
  {
    id: "MISSING_SEMICOLON",
    category: "style",
    severity: "low",
    confidence: 0.7,
    check: (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return null;
      if (trimmed.endsWith("{") || trimmed.endsWith("}") || trimmed.endsWith(",") || trimmed.endsWith("(") || trimmed.endsWith(")")) return null;
      if (trimmed.endsWith(";") || trimmed.endsWith("`") || trimmed.endsWith("'") || trimmed.endsWith('"')) return null;
      if (/^\s*(?:if|for|while|switch|catch|function|class|interface|type|enum|import|export)\b/.test(trimmed)) return null;
      return {
        message: "Missing semicolon at end of statement",
        suggestion: "Add a semicolon for consistency",
        autoFix: line + ";",
      };
    },
  },

  // --- Performance ---
  {
    id: "N_PLUS_ONE",
    category: "performance",
    severity: "medium",
    confidence: 0.65,
    contextAfter: 1,
    check: (line, _ln, lines) => {
      if (!/for\s*\(|forEach\s*\(|map\s*\(|filter\s*\(/.test(line)) return null;
      const nextLine = lines[_ln] ?? "";
      if (!/await\s+|fetch\s*\(|query\s*\(|find\s*\(|get\s*\(/.test(nextLine)) return null;
      return {
        message: "Potential N+1 query pattern: loop with async call inside",
        suggestion: "Batch the async operations or use Promise.all for concurrent execution",
        autoFix: "// Instead of: for (const id of ids) { await db.get(id); }\n// Use: await Promise.all(ids.map(id => db.get(id)));",
      };
    },
  },
  {
    id: "MEMORY_LEAK_LISTENER",
    category: "performance",
    severity: "medium",
    confidence: 0.6,
    contextAfter: 1,
    check: (line, _ln, lines) => {
      if (!/\.on\s*\(\s*["']/.test(line) && !/\.addListener\s*\(/.test(line)) return null;
      const nextLine = lines[_ln] ?? "";
      if (nextLine.includes(".off(") || nextLine.includes(".removeListener(")) return null;
      return {
        message: "Event listener added without corresponding removal",
        suggestion: "Ensure listeners are removed with .off() or .removeListener() to prevent memory leaks",
      };
    },
  },
  {
    id: "INNER_HTML_LOOP",
    category: "performance",
    severity: "medium",
    confidence: 0.7,
    contextBefore: 1,
    check: (line, _ln, lines) => {
      if (!/innerHTML\s*[+]?=/.test(line)) return null;
      const prevLine = lines[_ln - 2] ?? "";
      if (!/for\s*\(|forEach\s*\(|map\s*\(|while\s*\(/.test(prevLine)) return null;
      return {
        message: "DOM manipulation inside a loop causes layout thrashing",
        suggestion: "Build a string or DocumentFragment and update the DOM once after the loop",
      };
    },
  },
  {
    id: "SYNC_FS_IN_ASYNC",
    category: "performance",
    severity: "medium",
    confidence: 0.85,
    check: (line) => {
      if (!/readFileSync|writeFileSync|existsSync|statSync|readdirSync/.test(line)) return null;
      return {
        message: "Synchronous file I/O blocks the event loop",
        suggestion: "Use the async versions (readFile, writeFile, etc.) in async contexts",
        autoFix: line.replace(/readFileSync/g, "readFile").replace(/writeFileSync/g, "writeFile").replace(/existsSync/g, "exists").replace(/statSync/g, "stat").replace(/readdirSync/g, "readdir"),
      };
    },
  },
  {
    id: "MEMORY_LEAK_TIMEOUT",
    category: "performance",
    severity: "medium",
    confidence: 0.6,
    contextAfter: 20,
    check: (line, _ln, lines) => {
      if (!/setInterval\s*\(/.test(line)) return null;
      // Check if clearInterval is called within next 20 lines
      for (let i = _ln; i < Math.min(_ln + 20, lines.length); i++) {
        if (/clearInterval\s*\(/.test(lines[i] ?? "")) return null;
      }
      return {
        message: "setInterval without visible clearInterval — potential memory leak",
        suggestion: "Store the interval ID and clear it when no longer needed",
        autoFix: "const intervalId = setInterval(() => { ... }, 1000);\n// Later: clearInterval(intervalId);",
      };
    },
  },
  {
    id: "MISSING_DEBOUNCE",
    category: "performance",
    severity: "low",
    confidence: 0.5,
    check: (line) => {
      if (!/addEventListener\s*\(\s*["'](?:input|change|scroll|resize)/.test(line)) return null;
      if (/debounce|throttle/.test(line)) return null;
      return {
        message: "Event listener on high-frequency event without debounce/throttle",
        suggestion: "Add debounce or throttle to reduce the number of handler invocations",
      };
    },
  },

  // ------------------------------------------------------------------
  // Expanded security rules
  // ------------------------------------------------------------------
  {
    id: "FUNCTION_CONSTRUCTOR",
    category: "security",
    severity: "high",
    confidence: 0.85,
    check: (line) => {
      if (!/\bnew\s+Function\s*\(/.test(line)) return null;
      return {
        message: "new Function() executes code from a string — equivalent to eval()",
        suggestion: "Avoid dynamic code generation; use a lookup table or a normal function",
      };
    },
  },
  {
    id: "UNSAFE_DESERIALIZE",
    category: "security",
    severity: "high",
    confidence: 0.8,
    check: (line) => {
      if (/yaml\.safe_load|safeLoad|SafeLoader/.test(line)) return null;
      if (/\bpickle\.loads?\s*\(|\byaml\.load\s*\(|\bunserialize\s*\(|\bMarshal\.load\s*\(/.test(line)) {
        return {
          message: "Deserialization of untrusted data can lead to remote code execution",
          suggestion: "Use a safe format (JSON) or a safe loader (yaml.safe_load / SafeLoader)",
        };
      }
      return null;
    },
  },
  {
    id: "TLS_VERIFY_DISABLED",
    category: "security",
    severity: "high",
    confidence: 0.8,
    check: (line) => {
      if (/\bverify\s*[:=]\s*False\b|\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0/.test(line)) {
        return {
          message: "TLS certificate verification is disabled",
          suggestion: "Keep certificate verification enabled; install the correct CA instead",
        };
      }
      return null;
    },
  },
  {
    id: "INSECURE_COOKIE",
    category: "security",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      if (/secure\s*[:=]\s*false|\bhttpOnly\s*[:=]\s*false|\bSecure\s*=\s*False/.test(line)) {
        return {
          message: "Cookie created without secure/httpOnly flags",
          suggestion: "Set secure: true and httpOnly: true on session cookies",
        };
      }
      return null;
    },
  },
  {
    id: "CORS_WILDCARD",
    category: "security",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      if (/origin\s*[:=]\s*["']\*["']|Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/.test(line)) {
        if (/credentials\s*:\s*true/i.test(line)) {
          return {
            message: "CORS allows any origin together with credentials",
            suggestion: "Reflect an explicit allow-list of origins, never '*' with credentials",
          };
        }
        return {
          message: "CORS wildcard origin allows any site to read responses",
          suggestion: "Restrict Access-Control-Allow-Origin to trusted origins",
        };
      }
      return null;
    },
  },
  {
    id: "DEBUG_MODE_ENABLED",
    category: "security",
    severity: "medium",
    confidence: 0.65,
    check: (line) => {
      if (/\b(?:debug|DEBUG)\s*[:=]\s*(?:true|True|1)\b|app\.run\s*\([^)]*debug\s*=\s*True/.test(line)) {
        return {
          message: "Debug mode enabled — exposes stack traces and an interactive debugger",
          suggestion: "Disable debug mode in production configuration",
        };
      }
      return null;
    },
  },
  {
    id: "WORLD_WRITABLE_PERMS",
    category: "security",
    severity: "medium",
    confidence: 0.75,
    check: (line) => {
      if (/chmod\s*\(?[^)]*0?777|0o777|\bchmod\s+777\b/.test(line)) {
        return {
          message: "World-writable permissions (777) grant every user write access",
          suggestion: "Grant the minimum required permissions (e.g. 0644 files, 0755 dirs)",
        };
      }
      return null;
    },
  },
  {
    id: "CURL_PIPE_SHELL",
    category: "security",
    severity: "high",
    confidence: 0.8,
    check: (line) => {
      if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/.test(line)) {
        return {
          message: "Piping a downloaded script directly into a shell",
          suggestion: "Download, verify the checksum/signature, inspect, then execute",
        };
      }
      return null;
    },
  },
  {
    id: "XXE_PARSER",
    category: "security",
    severity: "medium",
    confidence: 0.5,
    check: (line) => {
      if (/etree\.parse\s*\(|XMLParser\s*\(|DocumentBuilderFactory|libxml_disable_entity_loader\s*\(\s*false/.test(line)) {
        return {
          message: "XML parser may be vulnerable to XXE if the input is untrusted",
          suggestion: "Disable external entities / DTDs on the parser",
        };
      }
      return null;
    },
  },
  {
    id: "ENV_SECRET_LOGGED",
    category: "security",
    severity: "medium",
    confidence: 0.6,
    check: (line) => {
      if (/(?:console\.log|logger?\.\w+|print)\s*\([^)]*(?:process\.env|os\.environ)/.test(line)) {
        return {
          message: "Environment variables (which often hold secrets) are being logged",
          suggestion: "Log only the specific non-sensitive value, or redact secrets",
        };
      }
      return null;
    },
  },
  {
    id: "UNSAFE_QUERY_RAW",
    category: "security",
    severity: "high",
    confidence: 0.7,
    check: (line) => {
      if (/\bqueryRawUnsafe\s*\(|\$queryRawUnsafe\s*\(|\brawQuery\s*\(/.test(line)) {
        return {
          message: "Raw/unsafe query API called — input interpolation enables SQL injection",
          suggestion: "Use parameterized queries or the safe tagged-template variant",
        };
      }
      return null;
    },
  },

  // ------------------------------------------------------------------
  // Expanded bug rules
  // ------------------------------------------------------------------
  {
    id: "DEBUGGER_STATEMENT",
    category: "bugs",
    severity: "medium",
    confidence: 0.9,
    check: (line) => {
      if (!/^\s*debugger\s*;?\s*$/.test(line)) return null;
      return {
        message: "debugger statement left in the code",
        suggestion: "Remove the debugger statement before committing",
      };
    },
  },
  {
    id: "ASSIGNMENT_IN_CONDITION",
    category: "bugs",
    severity: "high",
    confidence: 0.6,
    check: (line) => {
      if (!/\b(?:if|while)\s*\([^)]*[^=!<>]=[^=]/.test(line)) return null;
      // Reject the common intentional form `while ((line = read()) !== null)`.
      if (/\(\s*[A-Za-z_$][\w$.]*\s*=\s*[^)]+\)\s*[=!<>]/.test(line)) return null;
      return {
        message: "Assignment (=) used where a comparison (==/===) was likely intended",
        suggestion: "Use === for comparison, or wrap the assignment in extra parentheses if intentional",
      };
    },
  },
  {
    id: "SELF_ASSIGNMENT",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      const m = /^\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:this\.)?\1\s*;?\s*$/.exec(line);
      if (!m) return null;
      return {
        message: `Self-assignment of "${m[1]}" has no effect`,
        suggestion: "Remove the redundant assignment",
      };
    },
  },
  {
    id: "SELF_COMPARISON",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      const m = /\b([A-Za-z_$][\w$.]*)\s*===?\s*\1\b/.exec(line);
      if (!m) return null;
      if (/\bNaN\b/.test(m[0])) return null;
      return {
        message: `Expression compares "${m[1]}" with itself — always true`,
        suggestion: "Compare against the intended other value",
      };
    },
  },
  {
    id: "COMPARE_WITH_NAN",
    category: "bugs",
    severity: "medium",
    confidence: 0.85,
    check: (line) => {
      if (/[=!]==?\s*NaN\b|\bNaN\s*[=!]==?/.test(line)) {
        return {
          message: "NaN never compares equal to anything, even itself",
          suggestion: "Use Number.isNaN(x) instead of x === NaN",
        };
      }
      return null;
    },
  },
  {
    id: "PARSEINT_NO_RADIX",
    category: "bugs",
    severity: "low",
    confidence: 0.6,
    check: (line) => {
      if (!/\bparseInt\s*\(/.test(line)) return null;
      if (/\bparseInt\s*\([^,)]*,[^)]*\)/.test(line)) return null;
      return {
        message: "parseInt called without a radix",
        suggestion: "Pass radix 10: parseInt(value, 10)",
      };
    },
  },
  {
    id: "ASYNC_PROMISE_EXECUTOR",
    category: "bugs",
    severity: "medium",
    confidence: 0.75,
    check: (line) => {
      if (!/\bnew\s+Promise\s*\(\s*async\b/.test(line)) return null;
      return {
        message: "async function passed to the Promise constructor — errors are swallowed",
        suggestion: "Reject explicitly, or make the executor synchronous and return a Promise",
      };
    },
  },
  {
    id: "DOUBLE_AWAIT",
    category: "bugs",
    severity: "low",
    confidence: 0.7,
    check: (line) => {
      if (!/\bawait\s+await\b/.test(line)) return null;
      return {
        message: "Double await — the second await is redundant or a bug",
        suggestion: "Remove the extra await",
      };
    },
  },
  {
    id: "ASYNC_FOR_EACH",
    category: "bugs",
    severity: "medium",
    confidence: 0.75,
    check: (line) => {
      if (!/\.forEach\s*\(\s*async\b/.test(line)) return null;
      return {
        message: "async callback passed to forEach — iterations are not awaited",
        suggestion: "Use a for...of loop with await, or Promise.all(items.map(...))",
      };
    },
  },
  {
    id: "OFF_BY_ONE_LENGTH_INDEX",
    category: "bugs",
    severity: "high",
    confidence: 0.7,
    check: (line) => {
      const m = /\[\s*([A-Za-z_$][\w$.]*)\s*\.length\s*\]/.exec(line);
      if (!m) return null;
      // `arr[arr.length] = x` is the legitimate append idiom; skip it.
      if (/\[\s*[A-Za-z_$][\w$.]*\s*\.length\s*\]\s*=[^=]/.test(line)) return null;
      return {
        message: `Index [${m[1]}.length] is always one past the last element`,
        suggestion: `Use [${m[1]}.length - 1] or restructure to avoid the off-by-one`,
      };
    },
  },
  {
    id: "SETTIMEOUT_STRING",
    category: "bugs",
    severity: "high",
    confidence: 0.75,
    check: (line) => {
      if (!/\bsetTimeout\s*\(\s*["'`]/.test(line) && !/\bsetInterval\s*\(\s*["'`]/.test(line)) return null;
      return {
        message: "Timer callbacks passed as strings are evaluated with eval semantics",
        suggestion: "Pass a function instead of a string",
      };
    },
  },
  {
    id: "THROW_STRING",
    category: "bugs",
    severity: "low",
    confidence: 0.6,
    check: (line) => {
      if (!/^\s*throw\s+["'`]/.test(line)) return null;
      return {
        message: "Throwing a string loses the stack trace and the Error type",
        suggestion: "Throw an Error object: throw new Error('...')",
      };
    },
  },
  {
    id: "JSON_PARSE_UNGUIARDED",
    category: "bugs",
    severity: "medium",
    confidence: 0.55,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/JSON\.parse\s*\(/.test(line)) return null;
      if (/\btry\s*\{/.test(line)) return null;
      // Look a few lines up for a try block.
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        if (/\btry\s*\{/.test(lines[i] ?? "")) return null;
      }
      return {
        message: "JSON.parse can throw on malformed input and is not guarded",
        suggestion: "Wrap in try/catch or validate the input before parsing",
      };
    },
  },
  {
    id: "DUPLICATE_OBJECT_KEY",
    category: "bugs",
    severity: "medium",
    confidence: 0.7,
    check: (line) => {
      const objMatch = line.match(/\{([^{}]*)\}/);
      if (!objMatch) return null;
      const keys = objMatch[1].match(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g);
      if (!keys) return null;
      const seen = new Set<string>();
      for (const raw of keys) {
        const name = raw.replace(/^[,\s]*/, "").replace(/\s*:$/, "");
        if (seen.has(name)) {
          return {
            message: `Duplicate object key "${name}" — the later value silently wins`,
            suggestion: "Remove the duplicate key",
          };
        }
        seen.add(name);
      }
      return null;
    },
  },
  {
    id: "EMPTY_CONDITIONAL_BLOCK",
    category: "bugs",
    severity: "low",
    confidence: 0.8,
    check: (line) => {
      if (!/\bif\s*\([^)]*\)\s*\{\s*\}\s*(?:else\b)?/.test(line) && !/\belse\s*\{\s*\}\s*$/.test(line)) return null;
      return {
        message: "Empty conditional block does nothing",
        suggestion: "Remove the empty block or implement the intended logic",
      };
    },
  },

  // ------------------------------------------------------------------
  // Expanded performance rules
  // ------------------------------------------------------------------
  {
    id: "AWAIT_IN_LOOP",
    category: "performance",
    severity: "medium",
    confidence: 0.55,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/\bawait\b/.test(line)) return null;
      if (/^\s*(?:\/\/|\*)/.test(line)) return null;
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        const prev = lines[i] ?? "";
        if (/\b(?:for|while)\s*\(|\.map\s*\(|\.forEach\s*\(/.test(prev)) {
          return {
            message: "await inside a loop runs iterations sequentially",
            suggestion: "Collect the promises and await Promise.all(...), or batch the work",
          };
        }
      }
      return null;
    },
  },
  {
    id: "STRING_CONCAT_IN_LOOP",
    category: "performance",
    severity: "low",
    confidence: 0.5,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/\+=\s*["'`]|\+\s*=\s*[A-Za-z_$]/.test(line)) return null;
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        if (/\b(?:for|while)\s*\(/.test(lines[i] ?? "")) {
          return {
            message: "String concatenation inside a loop is O(n²) in many engines",
            suggestion: "Push parts into an array and join(), or use a StringBuilder",
          };
        }
      }
      return null;
    },
  },
  {
    id: "REGEX_IN_LOOP",
    category: "performance",
    severity: "low",
    confidence: 0.6,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/\bnew\s+RegExp\s*\(/.test(line)) return null;
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        if (/\b(?:for|while)\s*\(/.test(lines[i] ?? "")) {
          return {
            message: "RegExp compiled inside a loop",
            suggestion: "Hoist the RegExp out of the loop and reuse it",
          };
        }
      }
      return null;
    },
  },
  {
    id: "DOM_QUERY_IN_LOOP",
    category: "performance",
    severity: "medium",
    confidence: 0.6,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/document\.(?:querySelector(?:All)?|getElementById|getElementsBy\w+)\s*\(/.test(line)) return null;
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        if (/\b(?:for|while)\s*\(/.test(lines[i] ?? "")) {
          return {
            message: "DOM queried inside a loop — O(n) per iteration",
            suggestion: "Query once outside the loop and cache the result",
          };
        }
      }
      return null;
    },
  },
  {
    id: "JSON_DEEP_CLONE",
    category: "performance",
    severity: "low",
    confidence: 0.6,
    check: (line) => {
      if (!/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/.test(line)) return null;
      return {
        message: "JSON round-trip deep clone is slow and drops types (Date, Map, functions)",
        suggestion: "Use structuredClone() or a targeted copy",
      };
    },
  },
  {
    id: "ARRAY_UNSHIFT_IN_LOOP",
    category: "performance",
    severity: "low",
    confidence: 0.55,
    contextBefore: 5,
    check: (line, ln, lines) => {
      if (!/\.unshift\s*\(/.test(line)) return null;
      for (let i = Math.max(0, ln - 6); i < ln - 1; i++) {
        if (/\b(?:for|while)\s*\(/.test(lines[i] ?? "")) {
          return {
            message: "Array.unshift inside a loop is O(n) per call",
            suggestion: "Push and reverse once, or use a deque",
          };
        }
      }
      return null;
    },
  },

  // ------------------------------------------------------------------
  // Expanded style rules
  // ------------------------------------------------------------------
  {
    id: "ALERT_USAGE",
    category: "style",
    severity: "low",
    confidence: 0.75,
    check: (line) => {
      if (!/\b(?:alert|confirm)\s*\(/.test(line)) return null;
      if (/\bfunction\b/.test(line)) return null;
      return {
        message: "Browser alert/confirm blocks the UI thread",
        suggestion: "Use a non-blocking in-app notification or dialog",
      };
    },
  },
  {
    id: "COMMENTED_OUT_CODE",
    category: "style",
    severity: "low",
    confidence: 0.5,
    check: (line) => {
      if (!/^\s*\/\/\s*(?:const|let|var|function|class|if|for|while|return|import|export)\b/.test(line)) return null;
      return {
        message: "Commented-out code should be removed (git remembers it)",
        suggestion: "Delete the commented code or replace it with an explanatory comment",
      };
    },
  },
  {
    id: "DEEP_INDENTATION",
    category: "style",
    severity: "low",
    confidence: 0.6,
    check: (line) => {
      const m = /^( +)\S/.exec(line);
      if (!m) return null;
      const levels = Math.floor(m[1].length / 4);
      if (levels < 6) return null;
      return {
        message: `Deeply nested code (~${levels} levels) is hard to follow`,
        suggestion: "Extract nested logic into a helper or return early",
      };
    },
  },
  {
    id: "MIXED_INDENTATION",
    category: "style",
    severity: "low",
    confidence: 0.7,
    check: (line) => {
      if (!/^\t+ +\S|^ +\t+\S/.test(line)) return null;
      return {
        message: "Line mixes tabs and spaces for indentation",
        suggestion: "Use one indentation style consistently",
      };
    },
  },
];

// --- Database ---

let db: AnyDatabase | null = null;
let lastBackupTime = 0;

function getDb(): AnyDatabase {
  if (!db) {
    try {
      if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
      db = openDatabase(DB_PATH);
      applyPragmas(db);
      db.exec("PRAGMA foreign_keys=ON");
      initSchema(db);
    } catch (e) {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      throw e;
    }
  }
  return db;
}

function initSchema(database: AnyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      finding_count INTEGER NOT NULL,
      summary TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      suggestion TEXT,
      confidence REAL DEFAULT 0.5,
      rule_id TEXT,
      auto_fix TEXT,
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
    )
  `);

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_findings_review ON review_findings(review_id)"
  );

  // Custom rules table
  database.exec(`
    CREATE TABLE IF NOT EXISTS custom_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      suggestion TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Fix tracking table
  //
  // CR-16: a `fix_tracking` table used to be created here and was never
  // written or read by anything, so fix outcomes were recorded nowhere. The
  // dead schema is gone instead of pretending to track fixes.
}

/** CR-5: the first backup failure is surfaced once instead of vanishing into `catch {}`. */
let backupFailureReported = false;

async function backupDb(): Promise<boolean> {
  const now = Date.now();
  if (now - lastBackupTime < 300000) return true;
  const database = db;
  if (!database) return false;
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // CR-5: this used `require("node:fs")`, which does not exist in an ES
    // module — every backup threw ReferenceError into the empty catch below, so
    // BACKUP_DIR stayed empty and the corruption-recovery path could never
    // find a backup to restore. `fs` is imported at the top of this module.
    // The checkpoint+copy now run off the write mutex's sync path: the copy
    // itself is async (fsPromises.copyFile), and the caller awaits it after
    // commit instead of blocking on copyFileSync.
    await fsPromises.copyFile(DB_PATH, join(BACKUP_DIR, `${ts}.db`));
    const files = readdirSync(BACKUP_DIR)
      .filter((f: string) => f.endsWith(".db"))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_BACKUPS)) {
      rmSync(join(BACKUP_DIR, f), { force: true });
    }
    lastBackupTime = now;
    return true;
  } catch (err) {
    if (!backupFailureReported) {
      backupFailureReported = true;
      console.error(
        `[code-review] database backup failed (corruption recovery has no backups to restore): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return false;
  }
}

function getLatestBackup(): string | null {
  return latestValidBackup(BACKUP_DIR);
}

let restorePromise: Promise<boolean> | null = null;
function tryRestoreAsync(): Promise<boolean> {
  if (restorePromise) return restorePromise;
  restorePromise = (async (): Promise<boolean> => {
    try {
      const backup = getLatestBackup();
      if (!backup) return false;
      if (db) {
        try { db.close(); } catch {}
        db = null;
      }
      copyBackupIntoPlace(DB_PATH, backup);
      getDb();
      if (!db || !checkOpenDb(db)) {
        try { db?.close(); } catch {}
        db = null;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  })();
  const inFlight = restorePromise;
  const clear = () => { if (restorePromise === inFlight) restorePromise = null; };
  inFlight.then(clear, clear);
  return inFlight;
}

let dbMutex: Promise<void> = Promise.resolve();
async function withDbMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = dbMutex;
  let release!: () => void;
  dbMutex = new Promise<void>((res) => { release = res; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * CR-4: a storage failure, surfaced as a typed error instead of the old
 * `dbUnavailable(err) as T` cast that let a write tool answer "Custom rule
 * added." while nothing had been written, and let `/code-review fix-all`
 * iterate the string "Storage unavailable: …" character by character.
 */
class StorageUnavailableError extends Error {
  readonly storageUnavailable = true;
  constructor(err: unknown) {
    super(dbUnavailable(err));
    this.name = "StorageUnavailableError";
    this.cause = err;
  }
}

/** True for the typed storage failure (used by callers that must degrade politely). */
function isStorageFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { storageUnavailable?: unknown }).storageUnavailable === true;
}

async function writeDb<T>(fn: () => T | Promise<T>): Promise<T> {
  return withDbMutex(async () => {
    try {
      const result = await fn();
      try { await backupDb(); } catch {}
      return result;
    } catch (err) {
      if (isCorruption(err) && await tryRestoreAsync()) {
        try {
          const result = await fn();
          try { await backupDb(); } catch {}
          return result;
        } catch (retryErr) {
          throw new StorageUnavailableError(retryErr);
        }
      }
      throw new StorageUnavailableError(err);
    }
  });
}

async function readDb<T>(fn: () => T | Promise<T>): Promise<T> {
  return withDbMutex(async () => {
    try {
      return await fn();
    } catch (err) {
      if (isCorruption(err) && await tryRestoreAsync()) {
        try {
          return await fn();
        } catch (restoreErr) {
          throw new StorageUnavailableError(restoreErr);
        }
      }
      throw new StorageUnavailableError(err);
    }
  });
}

// --- Review engine ---

function computeStats(findings: ReviewFinding[]): ReviewStats {
  const bySeverity: Record<ReviewSeverity, number> = { high: 0, medium: 0, low: 0 };
  const byCategory: Record<ReviewCategory, number> = { security: 0, bugs: 0, style: 0, performance: 0 };
  const byFile: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  let totalConfidence = 0;
  let fixableCount = 0;

  for (const f of findings) {
    bySeverity[f.severity]++;
    byCategory[f.category]++;
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    totalConfidence += f.confidence;
    if (f.autoFix) fixableCount++;
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    byCategory,
    byFile,
    byRule,
    avgConfidence: findings.length > 0 ? totalConfidence / findings.length : 0,
    fixableCount,
  };
}

/** A rule after config filtering and pattern compilation (CR-2/CR-7). */
interface PreparedRule {
  id: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  confidence: number;
  /** CR-3: surrounding lines the check reads; 0 means it only sees its own line. */
  contextBefore: number;
  contextAfter: number;
  /** CR-3: check scans to the end of the file, which a diff hunk can never provide. */
  wholeFile: boolean;
  check: (line: string, lineNumber: number, lines: string[]) => { message: string; suggestion: string; autoFix?: string } | null;
  /** Cheap per-line gate: these literal substrings must all appear in a line
   * for `check` to have any chance of matching. null/empty = no gate, the
   * rule always runs. Sound: only built from required literal runs. */
  gate: { tokens: string[]; ci: boolean } | null;
}

/** CR-16: `focusAreas` narrows which categories are reviewed at all. */
function inFocus(cfg: CodeReviewConfig, category: ReviewCategory): boolean {
  return cfg.focusAreas.length === 0 || cfg.focusAreas.includes(category);
}

/**
 * CR-2: build the effective rule set for ONE review. Custom rules come from
 * BOTH the plugin options and the `custom_rules` table — DB rows used to be
 * listed by `code_review_custom_rules` but never applied to any review.
 * CR-7: user patterns are compiled exactly once here (they used to be rebuilt
 * per line, and an invalid one silently never matched); unsafe ones are dropped.
 * CR-16: `focusAreas` filters categories, in both review paths, since both use this.
 */
function buildRules(cfg: CodeReviewConfig, dbRules: CustomRule[] = [], severityFilter?: ReviewSeverity): PreparedRule[] {
  const prepared: PreparedRule[] = [];
  for (const rule of RULES) {
    if (!cfg.rules[rule.category]) continue;
    if (!inFocus(cfg, rule.category)) continue;
    const severity = cfg.severityOverrides[rule.id] ?? rule.severity;
    if (severityFilter && !meetsSeverity(severity, severityFilter)) continue;
    prepared.push({
      id: rule.id,
      category: rule.category,
      severity,
      confidence: rule.confidence,
      contextBefore: rule.contextBefore ?? 0,
      contextAfter: rule.contextAfter ?? 0,
      wholeFile: rule.wholeFile === true,
      check: rule.check,
      gate: ruleGate(undefined, rule.check.toString()),
    });
  }

  const seen = new Set<string>();
  for (const custom of [...cfg.customRules, ...dbRules]) {
    if (!custom || typeof custom.id !== "string" || !custom.enabled || !custom.pattern) continue;
    if (seen.has(custom.id)) continue; // plugin options win over DB rows sharing an id
    seen.add(custom.id);
    if (!cfg.rules[custom.category] || !inFocus(cfg, custom.category)) continue;
    const severity = cfg.severityOverrides[custom.id] ?? custom.severity;
    if (severityFilter && !meetsSeverity(severity, severityFilter)) continue;
    const compiled = compileUserPattern(custom.pattern);
    if (!compiled.ok) {
      console.warn(`[code-review] custom rule ${custom.id} skipped: ${compiled.reason}`);
      continue;
    }
    const re = compiled.re;
    const message = custom.message ?? `Custom rule ${custom.name || custom.id} matched`;
    const suggestion = custom.suggestion ?? "Review this match against the rule intent";
    prepared.push({
      id: custom.id,
      category: custom.category,
      severity,
      confidence: 0.7,
      contextBefore: 0,
      contextAfter: 0,
      wholeFile: false,
      // CR-7: pre-compiled, and only ever shown a bounded slice of the line.
      check: (line: string) =>
        re.test(line.length > MAX_PATTERN_SCAN_CHARS ? line.slice(0, MAX_PATTERN_SCAN_CHARS) : line)
          ? { message, suggestion }
          : null,
      gate: ruleGate(custom.pattern),
    });
  }
  return prepared;
}

function ruleFinding(
  rule: PreparedRule,
  cfg: CodeReviewConfig,
  filePath: string,
  lineNumber: number,
  result: { message: string; suggestion: string; autoFix?: string },
): ReviewFinding {
  return {
    file: filePath,
    line: lineNumber,
    severity: rule.severity,
    category: rule.category,
    message: result.message,
    suggestion: result.suggestion,
    confidence: cfg.enableConfidenceScoring ? rule.confidence : 0.5,
    autoFix: cfg.enableAutoFix ? result.autoFix : undefined,
    ruleId: rule.id,
  };
}

function reviewLines(
  lines: string[],
  filePath: string,
  cfg: CodeReviewConfig,
  severityFilter?: ReviewSeverity,
  dbRules: CustomRule[] = [],
  preparedRules?: PreparedRule[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const allRules = preparedRules ?? buildRules(cfg, dbRules, severityFilter);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    for (const rule of allRules) {
      // Literal-token prefilter: if a rule requires literals that are not
      // all present in this line, its regex cannot match it.
      const gate = rule.gate;
      if (gate && gate.tokens.length > 0) {
        if (gate.ci) {
          const lower = line.toLowerCase();
          if (!gate.tokens.every((t) => lower.includes(t.toLowerCase()))) continue;
        } else if (!gate.tokens.every((t) => line.includes(t))) {
          continue;
        }
      }
      try {
        const result = rule.check(line, lineNumber, lines);
        if (result) {
          findings.push(ruleFinding(rule, cfg, filePath, lineNumber, result));
          if (findings.length >= cfg.maxFindingsPerFile) return findings;
        }
      } catch {
        // Rule threw — skip it
      }
    }
  }

  return findings;
}

/** CR-8: human size for skip notes (a 1.06 MB file must not read as "1 MB > 1 MB"). */
function fmtMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function reviewFile(
  filePath: string,
  cfg: CodeReviewConfig,
  severityFilter?: ReviewSeverity,
  dbRules: CustomRule[] = [],
  // CR-8: oversized/unreadable files are reported instead of silently dropped.
  skipped?: string[],
  preparedRules?: PreparedRule[],
): ReviewFinding[] {
  let content: string;
  try {
    // CR-8: stat before read — a multi-hundred-MB .json/.md/.sql used to be
    // read and line-split synchronously inside the host process.
    const size = statSync(filePath).size;
    if (size > MAX_REVIEW_BYTES) {
      skipped?.push(`${filePath} (${fmtMiB(size)} > ${fmtMiB(MAX_REVIEW_BYTES)} limit)`);
      return [];
    }
    content = readFileSync(filePath, "utf-8") as string;
  } catch {
    return [];
  }
  if (content.includes("\0")) return [];
  content = content.replace(/^(\uFEFF)+/, "");
  const lines = content.split("\n");
  return reviewLines(lines, filePath, cfg, severityFilter, dbRules, preparedRules);
}

/** One parsed hunk: the body lines git showed, and which of them are additions. */
interface DiffHunk {
  /** new-file line number of the first body line */
  start: number;
  /** body lines (context + added), in file order */
  body: string[];
  /** indices into `body` that are added lines */
  added: number[];
}

interface DiffFile {
  path: string;
  binary: boolean;
  hunks: DiffHunk[];
}

/** CR-13: strip git's `b/` target prefix (pinned by CR-1, tolerant without it). */
function stripDiffPrefix(target: string): string {
  const t = target.replace(/\t.*$/, "").trim(); // "+++ b/file<TAB>100644"
  if (t.startsWith("b/")) return t.slice(2);
  return t;
}

/**
 * CR-13: parse the unified diff into files/hunks instead of advancing a line
 * counter on every non-code line. Git's `\ No newline…` marker, binary patch
 * payloads and header lines no longer shift the reported line numbers, and
 * binary files are dropped instead of scanned as code.
 */
function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const file = (): DiffFile => {
    if (!current) {
      current = { path: "diff", binary: false, hunks: [] };
      files.push(current);
    }
    return current;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("diff --git ")) {
      current = { path: "diff", binary: false, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (/^Binary files /.test(raw) || raw === "GIT binary patch") {
      // CR-13: everything below a binary marker is patch data, not source.
      if (current) current.binary = true;
      hunk = null;
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      hunk = { start: Number(header[1]), body: [], added: [] };
      file().hunks.push(hunk);
      continue;
    }
    if (hunk !== null) {
      if (raw.startsWith("+")) {
        hunk.body.push(raw.slice(1));
        hunk.added.push(hunk.body.length - 1);
        continue;
      }
      if (raw.startsWith("-")) continue; // deleted line: not part of the new file
      if (raw.startsWith(" ")) {
        hunk.body.push(raw.slice(1));
        continue;
      }
      hunk = null; // anything else ends the hunk
      continue;
    }
    // Outside a hunk: only headers live here. Checking them only in this state
    // keeps content lines such as "+++ not important" from being read as one.
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null") continue; // pure deletion: nothing added to scan
      file().path = stripDiffPrefix(target);
      continue;
    }
    if (/^(?:---|index|similarity|rename|old mode|new mode|deleted file|new file|copy) /.test(raw)) continue;
  }

  return files.filter((f) => !f.binary && f.hunks.length > 0);
}

function reviewDiff(
  diff: string,
  cfg: CodeReviewConfig,
  severityFilter?: ReviewSeverity,
  dbRules: CustomRule[] = [],
  preparedRulesArg?: PreparedRule[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const rules = preparedRulesArg ?? buildRules(cfg, dbRules, severityFilter);

  for (const file of parseUnifiedDiff(diff)) {
    let fileFindings = 0;
    for (const hunk of file.hunks) {
      // CR-3: rebuild the lines the hunk actually shows (its -U3 context plus
      // the additions), indexed by NEW-file line number, so context-dependent
      // rules read their real neighbours instead of a 1-element array.
      const lines: string[] = [];
      for (let j = 0; j < hunk.body.length; j++) lines[hunk.start - 1 + j] = hunk.body[j];

      for (const idx of hunk.added) {
        const newLineNum = hunk.start + idx;
        const availableBefore = idx;
        const availableAfter = hunk.body.length - 1 - idx;
        for (const rule of rules) {
          // CR-3: skip a rule whose declared context need exceeds what this
          // hunk shows — guessing from one line produced false positives and
          // hid real bugs.
          if (rule.wholeFile || rule.contextBefore > availableBefore || rule.contextAfter > availableAfter) {
            continue;
          }
          try {
            // Convention shared with reviewLines: lines[i] holds file line i+1,
            // so a rule reading lines[ln - 2] / lines[ln] sees the neighbours.
            const result = rule.check(lines[newLineNum - 1] ?? "", newLineNum, lines);
            if (!result) continue;
            findings.push(ruleFinding(rule, cfg, file.path, newLineNum, result));
            // CR-8: maxFindingsPerFile applied to files and projects but never to diffs.
            if (++fileFindings >= cfg.maxFindingsPerFile) break;
          } catch {
            // Rule threw — skip
          }
        }
        if (fileFindings >= cfg.maxFindingsPerFile) break;
      }
      if (fileFindings >= cfg.maxFindingsPerFile) break;
    }
  }

  return findings;
}

function reviewProject(
  rootPath: string,
  cfg: CodeReviewConfig,
  severityFilter?: ReviewSeverity,
  maxFiles?: number,
  dbRules: CustomRule[] = [],
): ReviewResult {
  const startTime = Date.now();
  const max = maxFiles ?? cfg.maxFiles;
  const allFindings: ReviewFinding[] = [];
  // CR-8: files the scanner refused to read, reported instead of silently skipped.
  const skipped: string[] = [];
  let filesReviewed = 0;
  // Build the prepared rule array once for the whole project instead of per file.
  const preparedRules = buildRules(cfg, dbRules, severityFilter);

  for (const filePath of walkDir(rootPath, new Set<string>(), buildWalkFilter(rootPath, cfg))) {
    if (filesReviewed >= max) break;

    const findings = reviewFile(filePath, cfg, severityFilter, dbRules, skipped, preparedRules);
    allFindings.push(...findings);
    filesReviewed++;
  }

  return {
    findings: allFindings,
    filesReviewed,
    durationMs: Date.now() - startTime,
    stats: computeStats(allFindings),
    skipped,
  };
}

// --- Working-tree diff collection (the /code-review diff command) ---

/**
 * CR-1: the flags are pinned so a user's git config cannot corrupt what we
 * parse. Without them, `color.ui=always` injects ANSI escapes (every changed
 * line then reads as context, so reviews came back silently "clean"),
 * `diff.noprefix`/`diff.external`/`textconv` changed or replaced the headers,
 * and a pager could swallow the output entirely.
 */
const GIT_DIFF_COMMAND =
  "git --no-pager -c color.ui=false -c diff.noprefix=false -c core.pager=cat diff " +
  "--no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD";

/** CR-14: how many untracked files are folded into a diff review. */
const MAX_UNTRACKED_FILES = 50;

/** CR-14: how many lines of one untracked file are turned into `+` lines. */
const MAX_UNTRACKED_LINES = 5000;

function gitOutput(args: string, dir: string, maxBuffer = 10 * 1024 * 1024): string | null {
  try {
    return execSync(args, { cwd: dir, encoding: "utf-8", maxBuffer });
  } catch {
    return null;
  }
}

/** CR-14: turn a file git does not track into the diff `reviewDiff` would expect. */
function synthesizedFileDiff(relPath: string, absolutePath: string): string | null {
  try {
    if (statSync(absolutePath).size > MAX_REVIEW_BYTES) return null;
    const content = readFileSync(absolutePath, "utf-8");
    if (content.includes("\0")) return null; // binary
    const lines = content.replace(/^(\uFEFF)+/, "").split("\n").slice(0, MAX_UNTRACKED_LINES);
    const body = lines.map((l) => `+${l}`).join("\n");
    return `diff --git a/${relPath} b/${relPath}\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  } catch {
    return null;
  }
}

/** CR-14: an untracked path is reviewable when its extension/basename is allowed. */
function untrackedIsReviewable(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((s) => SKIP_DIRS.has(s.toLowerCase()))) return false;
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (SKIP_FILES.has(base)) return false;
  const ext = extname(base);
  return DEFAULT_EXTS.has(ext) || (ext === "" && BASENAME_ALLOW.has(base));
}

/**
 * CR-1 + CR-14: collect the diff the `diff` verb reviews. Tracked changes come
 * from the pinned `git diff` invocation; brand-new untracked files (which
 * `git diff HEAD` never shows) are appended as synthesized patches; and a repo
 * without a first commit degrades to reviewing those instead of throwing.
 */
function collectWorkingTreeDiff(dir: string): { diff: string; notes: string[] } {
  const notes: string[] = [];
  const parts: string[] = [];

  const hasHead = gitOutput("git rev-parse --verify HEAD", dir, 1024 * 1024) !== null;
  if (hasHead) {
    const tracked = gitOutput(GIT_DIFF_COMMAND, dir);
    if (tracked === null) {
      notes.push("git diff failed — the repository may need `git gc`; reviewing new files only");
    } else if (tracked.trim()) {
      parts.push(tracked);
    }
  } else {
    notes.push("repository has no commits yet — reviewing new/untracked files only");
  }

  const listed = gitOutput("git --no-pager ls-files --others --exclude-standard -z", dir, 4 * 1024 * 1024);
  if (listed === null) {
    notes.push("untracked-file scan failed (not a git repository?)");
  } else {
    let used = 0;
    let capped = false;
    for (const rel of listed.split("\0").filter(Boolean)) {
      if (used >= MAX_UNTRACKED_FILES) {
        capped = true;
        break;
      }
      if (!untrackedIsReviewable(rel)) continue;
      const patch = synthesizedFileDiff(rel, resolve(dir, rel));
      if (patch) {
        parts.push(patch);
        used++;
      }
    }
    if (capped) notes.push(`untracked files capped at ${MAX_UNTRACKED_FILES} (raise with a project review)`);
  }

  return { diff: parts.join("\n"), notes };
}

// --- Trend analysis ---

/**
 * CR-15: one trend definition, shared by `code_review_trends`,
 * `/code-review trends` and the line a finished review appends.
 *
 * Two computations used to disagree. The tool compared the newest review in its
 * window against the oldest, while `getTrendData` compared the count handed to
 * it against a single previous row (`LIMIT 1 OFFSET 1`) — and it was called
 * after the current review was stored, so that row was often the review being
 * reported, which made a review compare against itself. The window semantics
 * are the definition: the newest stored review is the current one, the oldest
 * review in the window is the baseline.
 */
const TREND_WINDOW_DEFAULT = 10;
const TREND_WINDOW_MAX = 50;

/** Findings may move this far either way before it counts as a trend. */
const TREND_FLAT_PERCENT = 10;

interface TrendRow {
  id: number;
  created_at: string;
  finding_count: number;
  file_count: number;
}

interface TrendReport {
  /** Reviews in the window, newest first. */
  rows: TrendRow[];
  /** The window's comparison; `comparable` is false when it holds one review. */
  overall: TrendData;
  /** category/severity counts for the newest review in the window. */
  breakdown: Array<{ category: string; severity: string; cnt: number }>;
}

async function readTrendReport(limit: number): Promise<TrendReport | null> {
  try {
    const window = clampLimit(limit, TREND_WINDOW_DEFAULT, TREND_WINDOW_MAX);
    return await readDb(() => {
      const database = getDb();
      const rows = database
        .query("SELECT id, created_at, finding_count, file_count FROM reviews ORDER BY id DESC LIMIT ?")
        .all(window) as TrendRow[];

      const currentCount = rows[0]?.finding_count ?? 0;
      const previousCount = rows.length >= 2 ? rows[rows.length - 1].finding_count : 0;
      const comparable = rows.length >= 2;
      const changePercent =
        comparable && previousCount > 0 ? Math.round(((currentCount - previousCount) / previousCount) * 100) : 0;

      let direction: TrendData["direction"] = "stable";
      if (comparable && changePercent > TREND_FLAT_PERCENT) direction = "worsening";
      else if (comparable && changePercent < -TREND_FLAT_PERCENT) direction = "improving";

      const span = `the last ${rows.length} reviews`;
      const message = !comparable
        ? "No previous review data for comparison"
        : direction === "improving"
          ? `Findings decreased by ${Math.abs(changePercent)}% across ${span}`
          : direction === "worsening"
            ? `Findings increased by ${changePercent}% across ${span}`
            : `Findings stable across ${span}`;

      const breakdown = rows[0]
        ? (database
            .query(
              "SELECT category, severity, COUNT(*) as cnt FROM review_findings WHERE review_id = ? GROUP BY category, severity",
            )
            .all(rows[0].id) as Array<{ category: string; severity: string; cnt: number }>)
        : [];

      return {
        rows,
        overall: { direction, changePercent, previousCount, currentCount, comparable, message },
        breakdown,
      };
    });
  } catch {
    return null;
  }
}

/** The `code_review_trends` report — rendered once, for the tool and the command alike. */
function renderTrendReport(report: TrendReport): string {
  if (report.rows.length === 0) return "No review history found.";

  const lines: string[] = [`## Code Review Trends (last ${report.rows.length} reviews)`];

  if (report.overall.comparable) {
    const { direction, changePercent } = report.overall;
    if (direction === "improving") {
      lines.push(`\nOverall: Improving (${Math.abs(changePercent)}% decrease in findings)`);
    } else if (direction === "worsening") {
      lines.push(`\nOverall: Worsening (${changePercent}% increase in findings)`);
    } else {
      lines.push(`\nOverall: Stable`);
    }
  }

  lines.push(`\n### Review History`);
  for (const r of report.rows) {
    lines.push(`  #${r.id}  ${formatAge(r.created_at)} ago  —  ${r.finding_count} findings in ${r.file_count} files`);
  }

  if (report.breakdown.length > 0) {
    const byCat: Record<string, number> = {};
    const bySev: Record<string, number> = {};
    for (const f of report.breakdown) {
      byCat[f.category] = (byCat[f.category] ?? 0) + f.cnt;
      bySev[f.severity] = (bySev[f.severity] ?? 0) + f.cnt;
    }
    lines.push(`\n### Latest Review Breakdown`);
    lines.push(`  By category: ${Object.entries(byCat).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    lines.push(`  By severity: ${Object.entries(bySev).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  return lines.join("\n");
}

// --- Formatting helpers ---

function formatFinding(f: ReviewFinding): string {
  const sev = f.severity.toUpperCase();
  const cat = f.category;
  const conf = f.confidence > 0 ? ` [${Math.round(f.confidence * 100)}%]` : "";
  const fix = f.autoFix ? `\n    Auto-fix: ${f.autoFix}` : "";
  return `  [${sev}] ${f.file}:${f.line} — ${f.message}${conf}\n    Suggestion: ${f.suggestion}${fix}`;
}

function formatReviewResult(result: ReviewResult, title: string, reviewId?: number): string {
  const idPrefix = reviewId ? `#${reviewId} ` : "";
  const lines: string[] = [`## ${idPrefix}${title}`];
  lines.push(`Files reviewed: ${result.filesReviewed}`);
  lines.push(`Findings: ${result.findings.length}`);
  lines.push(`Duration: ${result.durationMs}ms`);

  if (result.stats) {
    lines.push(`\n### Summary`);
    lines.push(`  High: ${result.stats.bySeverity.high}  |  Medium: ${result.stats.bySeverity.medium}  |  Low: ${result.stats.bySeverity.low}`);
    lines.push(`  Security: ${result.stats.byCategory.security}  |  Bugs: ${result.stats.byCategory.bugs}  |  Style: ${result.stats.byCategory.style}  |  Performance: ${result.stats.byCategory.performance}`);
    if (result.stats.fixableCount > 0) {
      lines.push(`  Auto-fixable: ${result.stats.fixableCount}`);
    }
    if (result.stats.avgConfidence > 0) {
      lines.push(`  Avg confidence: ${Math.round(result.stats.avgConfidence * 100)}%`);
    }
  }

  if (result.skipped && result.skipped.length > 0) {
    // CR-8: oversized files are refused, and the review says so out loud.
    lines.push(`\n### Skipped (${result.skipped.length})`);
    for (const s of result.skipped.slice(0, 20)) lines.push(`  ${s}`);
    if (result.skipped.length > 20) lines.push(`  … and ${result.skipped.length - 20} more`);
  }

  if (result.findings.length === 0) {
    lines.push("\nNo issues found.");
    return lines.join("\n");
  }

  // Group by severity
  const bySeverity = new Map<ReviewSeverity, ReviewFinding[]>();
  for (const f of result.findings) {
    const list = bySeverity.get(f.severity) ?? [];
    list.push(f);
    bySeverity.set(f.severity, list);
  }

  for (const sev of ["high", "medium", "low"] as ReviewSeverity[]) {
    const group = bySeverity.get(sev);
    if (!group || group.length === 0) continue;
    lines.push(`\n### ${sev.toUpperCase()} (${group.length})`);
    for (const f of group) {
      lines.push(formatFinding(f));
    }
  }

  return lines.join("\n");
}

// --- Review persistence (shared by tools and the /code-review command) ---

/** CR-6: a path argument is relative to the project dir, never to the host process cwd. */
function resolveTarget(baseDir: string, path: string): string {
  return isAbsolute(path) || !baseDir ? path : resolve(baseDir, path);
}

/**
 * CR-6: findings used to be stored as absolute paths from file/project reviews
 * but as repo-relative paths from diff reviews, so `byFile` stats and fix-all
 * groupings mixed two keying schemes. Absolute paths inside the project are
 * stored project-relative; anything outside stays absolute, and diff paths
 * (already relative) pass through untouched.
 */
function toStoredPath(baseDir: string, filePath: string): string {
  if (!baseDir || !isAbsolute(filePath)) return filePath;
  const rel = relative(baseDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return filePath;
  return rel.split(sep).join("/");
}

/** CR-6: apply toStoredPath across a finding set (used before storing and formatting). */
function localizeFindings(baseDir: string, findings: ReviewFinding[]): ReviewFinding[] {
  // Single pass: rewrite f.file in place, avoiding the extra map pass over
  // findings when the result is assigned back to the same array.
  for (const f of findings) f.file = toStoredPath(baseDir, f.file);
  return findings;
}

function reviewSummary(result: ReviewResult, noun = `${result.filesReviewed} file(s)`): string {
  // Reuse stored severity counts when available; otherwise count once.
  let high = 0, medium = 0, low = 0;
  const sev = result.stats?.bySeverity;
  if (sev) {
    high = sev.high;
    medium = sev.medium;
    low = sev.low;
  } else {
    for (const f of result.findings) {
      if (f.severity === "high") high++;
      else if (f.severity === "medium") medium++;
      else low++;
    }
  }
  return (
    `Reviewed ${noun}, found ${result.findings.length} issues ` +
    `(${high} high, ${medium} medium, ${low} low)`
  );
}

/** CR-4: outcome of a store attempt — a caller may never assume success. */
interface StoreOutcome {
  reviewId: number | null;
  error?: string;
}

/**
 * CR-4: insert one review plus its findings, checking the affected-row count of
 * every statement. Previously a storage failure could come back as a string
 * that callers ignored, so `code_review_file` returned a normal-looking review
 * with no `#id` and the findings silently vanished from history, trends and
 * fix-all.
 */
async function storeReview(result: ReviewResult, summary: string): Promise<StoreOutcome> {
  try {
    return await writeDb<StoreOutcome>(() => {
      const database = getDb();
      database.exec("BEGIN TRANSACTION");
      try {
        const inserted = database
          .query("INSERT INTO reviews (created_at, file_count, finding_count, summary) VALUES (?, ?, ?, ?)")
          .run(
            new Date().toISOString(),
            result.filesReviewed,
            result.findings.length,
            truncateStored(summary, STORE_CAPS.decisionBody),
          ) as { changes?: number; lastInsertRowid?: number | bigint | string };
        if (Number(inserted?.changes ?? 0) !== 1) throw new Error("review insert affected no rows");
        const rawId =
          inserted?.lastInsertRowid !== undefined && Number(inserted.lastInsertRowid) > 0
            ? Number(inserted.lastInsertRowid)
            : (database.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
        const reviewId = Number(rawId);
        if (!Number.isInteger(reviewId) || reviewId <= 0) throw new Error("review insert returned no id");

        // Batch finding inserts in multi-row INSERTs (chunks of 100) inside
        // the same transaction, instead of one prepared-statement run per row.
        const CHUNK = 100;
        const COLS =
          "review_id, file_path, line_number, severity, category, message, suggestion, confidence, rule_id, auto_fix";
        let stored = 0;
        for (let start = 0; start < result.findings.length; start += CHUNK) {
          const chunk = result.findings.slice(start, start + CHUNK);
          const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
          const params: unknown[] = [];
          for (const f of chunk) {
            params.push(
              reviewId,
              f.file,
              f.line,
              f.severity,
              f.category,
              truncateStored(f.message, STORE_CAPS.errorField),
              truncateStored(f.suggestion, STORE_CAPS.errorField),
              f.confidence,
              f.ruleId,
              f.autoFix ? truncateStored(f.autoFix, STORE_CAPS.snippetCode) : null,
            );
          }
          const res = database
            .query(`INSERT INTO review_findings (${COLS}) VALUES ${placeholders}`)
            .run(...params) as { changes?: number };
          stored += Number(res?.changes ?? 0);
        }
        if (stored !== result.findings.length) {
          throw new Error(`only ${stored}/${result.findings.length} findings were stored`);
        }
        database.exec("COMMIT");
        return { reviewId };
      } catch (err) {
        try { database.exec("ROLLBACK"); } catch {}
        throw err;
      }
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // CR-4: name a storage failure as such, so the caller's warning is honest.
    return { reviewId: null, error: isStorageFailure(err) ? `${raw} (store: ${DB_PATH})` : raw };
  }
}

async function persistReview(result: ReviewResult): Promise<number | null> {
  const outcome = await storeReview(result, reviewSummary(result));
  if (outcome.error) console.error(`[code-review] could not store review: ${outcome.error}`);
  return outcome.reviewId;
}

/** CR-4: callers must be able to tell "no findings" from "cannot read them". */
async function loadReviewFindings(reviewId: number): Promise<ReviewFinding[]> {
  const rows = await readDb(() => {
    const database = getDb();
    return database
      .query(
        "SELECT file_path, line_number, severity, category, message, suggestion, confidence, rule_id, auto_fix FROM review_findings WHERE review_id = ? ORDER BY line_number ASC",
      )
      .all(reviewId) as Array<Record<string, unknown>>;
  });
  if (!Array.isArray(rows)) {
    throw new Error(`stored findings for review ${reviewId} are unreadable (not a list)`);
  }
  return rows.map((r) => ({
    file: String(r.file_path ?? ""),
    line: Number(r.line_number ?? 0),
    severity: (r.severity === "high" || r.severity === "medium" || r.severity === "low"
      ? r.severity
      : "medium") as ReviewSeverity,
    category: (["security", "bugs", "style", "performance"].includes(String(r.category))
      ? r.category
      : "bugs") as ReviewCategory,
    message: String(r.message ?? ""),
    suggestion: String(r.suggestion ?? ""),
    confidence: Number(r.confidence ?? 0.5),
    ruleId: String(r.rule_id ?? ""),
    autoFix: r.auto_fix ? String(r.auto_fix) : undefined,
  }));
}

/**
 * CR-2: read the enabled `custom_rules` rows so rules added through
 * `code_review_custom_rules` are actually applied by the scanner (they used to
 * be stored and listed, never used). A read failure degrades to config-only
 * rules with a warning instead of failing the whole review.
 */
async function loadCustomRules(): Promise<CustomRule[]> {
  try {
    const rows = await readDb(() =>
      getDb()
        .query(
          "SELECT id, name, pattern, category, severity, message, suggestion, enabled FROM custom_rules WHERE enabled = 1",
        )
        .all() as Array<Record<string, unknown>>,
    );
    if (!Array.isArray(rows)) return [];
    const categories = ["security", "bugs", "style", "performance"];
    const severities = ["low", "medium", "high"];
    return rows.flatMap((r) => {
      const category = String(r.category ?? "");
      const severity = String(r.severity ?? "");
      const pattern = String(r.pattern ?? "");
      if (!r.id || !pattern || !categories.includes(category) || !severities.includes(severity)) return [];
      return [
        {
          id: String(r.id),
          name: String(r.name ?? r.id),
          pattern,
          category: category as ReviewCategory,
          severity: severity as ReviewSeverity,
          message: String(r.message ?? ""),
          suggestion: String(r.suggestion ?? ""),
          enabled: Number(r.enabled ?? 1) === 1,
        },
      ];
    });
  } catch (err) {
    console.warn(
      `[code-review] stored custom rules could not be read; reviewing with configured rules only: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
}

// --- Free / cheapest model resolution for spawned agents ---

interface ModelInfo {
  providerID: string;
  modelID: string;
  input: number;
  output: number;
  /** False when the registry published no cost object at all. */
  costKnown: boolean;
}

interface ModelResolution {
  /** `providerID/modelID` the fixers should use, or "" when the user must choose. */
  fixModel: string;
  /** A free reviewer model ref, or "" if none/pinned. */
  reviewModel: string;
  freeAvailable: boolean;
  cheapest?: { model: string; input: number; output: number };
  /** True when no free model was found, so the user must approve a paid model. */
  needsApproval: boolean;
  /** True when the registry returned no models at all. */
  noModels: boolean;
  note: string;
}

function costNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function readModelCost(model: Record<string, unknown>): { input: number; output: number } | null {
  let cost: unknown = model.cost;
  if (Array.isArray(cost)) cost = cost[0];
  if (!cost || typeof cost !== "object") return null;
  const c = cost as Record<string, unknown>;
  const tier = (c.tier && typeof c.tier === "object" ? c.tier : c) as Record<string, unknown>;
  return { input: costNumber(tier.input), output: costNumber(tier.output) };
}

function parseModelList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: Array<Record<string, unknown>> }).data;
  }
  return [];
}

async function listAvailableModels(ctx: unknown): Promise<ModelInfo[]> {
  try {
    const api = (ctx as { model?: { list?: (input?: unknown) => unknown } })?.model;
    if (!api || typeof api.list !== "function") return [];
    const list = parseModelList(await api.list());
    const out: ModelInfo[] = [];
    for (const m of list) {
      const providerID = typeof m.providerID === "string" ? m.providerID : "";
      const modelID =
        typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : "";
      if (!providerID || !modelID) continue;
      const cost = readModelCost(m);
      out.push({
        providerID,
        modelID,
        input: cost?.input ?? 0,
        output: cost?.output ?? 0,
        costKnown: cost !== null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Free gateways first, so a $0 "go"/"opencode" model wins over an obscure free one. */
const FREE_PROVIDER_PREFERENCE = ["opencode-go", "opencode", "cline-pass", "zen"];

function isFreeModel(m: ModelInfo): boolean {
  return m.costKnown && m.input <= 0 && m.output <= 0;
}

function pickFreeModel(models: ModelInfo[]): ModelInfo | null {
  const free = models.filter(isFreeModel);
  if (free.length === 0) return null;
  for (const pref of FREE_PROVIDER_PREFERENCE) {
    const hit = free.find((m) => m.providerID === pref);
    if (hit) return hit;
  }
  return free[0];
}

function pickCheapestModel(models: ModelInfo[]): ModelInfo | null {
  const paid = models.filter((m) => m.costKnown && !isFreeModel(m));
  if (paid.length === 0) return null;
  return paid
    .slice()
    .sort((a, b) => a.input + a.output - (b.input + b.output) || a.input - b.input)[0];
}

function modelRef(m: ModelInfo | null): string {
  return m ? `${m.providerID}/${m.modelID}` : "";
}

/** CR-17: locate a pinned `provider/model` in the list the registry actually returned. */
function findModelByRef(models: ModelInfo[], ref: string): ModelInfo | undefined {
  const parsed = parseModelRef(ref);
  if (parsed) {
    const exact = models.find((m) => m.providerID === parsed.providerID && m.modelID === parsed.modelID);
    if (exact) return exact;
  }
  return models.find((m) => m.modelID === ref);
}

/** CR-17: how a model's price is described to the user. */
function costPhrase(m: ModelInfo): string {
  return m.costKnown
    ? `$${m.input}/$${m.output} per 1M in/out tokens`
    : "pricing was not published";
}

async function resolveAgentModels(ctx: unknown, cfg: CodeReviewConfig): Promise<ModelResolution> {
  const models = await listAvailableModels(ctx);
  const free = pickFreeModel(models);
  const cheapest = pickCheapestModel(models);

  let fixModel = cfg.fixModel;
  if (!fixModel && free) fixModel = modelRef(free);

  let reviewModel = cfg.reviewModel;
  if (!reviewModel && free) reviewModel = modelRef(free);

  const needsApproval = !fixModel;
  const pinnedFix = cfg.fixModel ? findModelByRef(models, cfg.fixModel) : undefined;
  // CR-17: a pinned model used to be reported as "free model … (cost $0)" even
  // when the user pinned something expensive. Report the fetched price, and say
  // plainly when it could not be verified.
  let note: string;
  if (cfg.fixModel) {
    note = pinnedFix
      ? `pinned model ${cfg.fixModel} (${costPhrase(pinnedFix)})`
      : `pinned model ${cfg.fixModel} (cost not verified)`;
    if (free && modelRef(free) !== cfg.fixModel) note += `; free model ${modelRef(free)} also available`;
  } else if (fixModel) {
    note = `free model ${fixModel} (cost $0)`;
  } else if (cheapest) {
    note = `no free model; cheapest is ${modelRef(cheapest)} (~$${cheapest.input}/$${cheapest.output} per 1M in/out tokens)`;
  } else {
    note = models.length > 0 ? "no free model and no published pricing" : "no model list available";
  }

  return {
    fixModel,
    reviewModel,
    freeAvailable: Boolean(free) || Boolean(cfg.fixModel),
    cheapest: cheapest ? { model: modelRef(cheapest), input: cheapest.input, output: cheapest.output } : undefined,
    needsApproval,
    noModels: models.length === 0,
    note,
  };
}

/** Whether the opencode-sessions `spawn_session` tool is present in this session. */
async function hasTool(ctx: unknown, id: string): Promise<boolean> {
  try {
    const api = (ctx as { tool?: { list?: () => unknown } })?.tool;
    if (!api || typeof api.list !== "function") return false;
    const tools = await api.list();
    return Array.isArray(tools) && tools.some((t) => (t as { id?: string })?.id === id);
  } catch {
    return false;
  }
}

// --- Agent orchestration briefs ---

/** Sentinel a reviewer child appends to its final message so direct mode can stop waiting. */
const REVIEW_DONE_SENTINEL = "[[REVIEW_DONE]]";

const REVIEWER_PROMPT = (target: string, exhaustive: boolean): string => [
  `You are a relentless senior code reviewer. Perform ${exhaustive ? "an EXHAUSTIVE deep review" : "a focused review"} of: ${target}.`,
  "",
  "Goal: find every REAL bug — not style nits. Cover:",
  "- logic errors, wrong operators, inverted conditions, off-by-one",
  "- null/undefined dereferences and unchecked return values",
  "- race conditions, unawaited/floating promises, async ordering",
  "- resource leaks (files, sockets, timers, event listeners)",
  "- error handling gaps: swallowed errors, wrong error types, missing cleanup",
  "- security: injection, authz gaps, SSRF, path traversal, unsafe deserialization, secret handling",
  "- cross-file contract violations (caller/callee mismatch, schema drift)",
  "- edge cases: empty/boundary/large/unicode input, concurrency",
  "- data loss/corruption, retry/idempotency hazards",
  "",
  "Method:",
  "- Read the actual files; never guess. Use codebase_search / glob / grep to enumerate.",
  "- Trace data flow across files before claiming a bug.",
  "- Verify each claim by re-reading the code. Do not report speculation.",
  "- For each finding give: file:line, severity (high/medium/low), category, why it is a bug, and a concrete minimal fix.",
  "",
  "Return a numbered list of findings, most severe first. If a file is clean, say so briefly.",
  "",
  `End your final reply with the exact line ${REVIEW_DONE_SENTINEL} on its own line.`,
].join("\n");

function fixerPrompt(target: string, findings: ReviewFinding[]): string {
  const list = findings
    .map((f, i) => `${i + 1}. [${f.severity}/${f.category}] ${f.file}:${f.line} — ${f.message}\n   Fix: ${f.suggestion}${f.autoFix ? `\n   Auto-fix hint: ${f.autoFix}` : ""}`)
    .join("\n");
  return [
    `You are a focused bug-fixing agent working in ${target}.`,
    "Fix ONLY the findings below, minimally and safely.",
    "",
    list,
    "",
    "Rules:",
    "- Read each file before editing.",
    "- Make the smallest correct change; do not refactor unrelated code.",
    "- Preserve existing behavior unless it is the bug.",
    "- If tests exist, run the relevant ones after your edits.",
    "- If a finding is a false positive, say so with evidence and skip it.",
    "- Never edit generated or vendored files.",
    "",
    "Return, per finding: index, status (fixed/skipped), files changed, and a one-line description of the change.",
  ].join("\n");
}

interface AgentBriefInput {
  mode: "targeted" | "deep";
  targetLabel: string;
  targetPath: string;
  reviewId: number | null;
  findings: ReviewFinding[];
  cfg: CodeReviewConfig;
  model: ModelResolution;
  canSpawn: boolean;
  needFallbackReview: boolean;
}

function buildAgentTaskBrief(input: AgentBriefInput): string {
  const { mode, targetLabel, targetPath, reviewId, findings, cfg, model, canSpawn } = input;
  const lines: string[] = [];

  lines.push(`## ${mode === "deep" ? "DEEP CODEBASE REVIEW" : "CODE REVIEW"} — AGENT BRIEF`);
  lines.push(
    reviewId
      ? `Review #${reviewId} on ${targetLabel}. You MUST now act on it — do not just summarize.`
      : `Target: ${targetLabel}. You MUST now act on it — do not just summarize.`,
  );

  // One unambiguous first action so even weak models comply.
  const firstAction = !canSpawn
    ? "Fix the findings below directly in this session now, then report what you changed."
    : model.fixModel
      ? `Call the \`spawn_session\` tool NOW with model \`"${model.fixModel}"\` to create the first fixer child.`
      : model.noModels
        ? "Call the `spawn_session` tool NOW (no model parameter) to create the first fixer child."
        : "Ask the user for approval first (see the model policy below); spawn nothing until they answer.";
  lines.push("");
  lines.push(`**FIRST ACTION:** ${firstAction} Do not reply with a plan, a summary, or a confirmation — act.`);

  // Model policy -----------------------------------------------------
  lines.push("");
  lines.push("### Model policy for any spawned agents");
  if (!canSpawn) {
    lines.push(
      "`spawn_session` is NOT available (the opencode-sessions plugin is not installed). " +
        "Fix the findings directly in this session instead of spawning children, then report what you changed.",
    );
  } else if (model.fixModel) {
    lines.push(
      `Use the model parameter \`"${model.fixModel}"\` (${model.note}) on EVERY spawn_session call. ` +
        "Do not omit it and do not substitute another model.",
    );
  } else if (!model.noModels) {
    const price = model.cheapest
      ? `the cheapest paid model ${model.cheapest.model} (~$${model.cheapest.input}/$${model.cheapest.output} per 1M in/out tokens)`
      : "the cheapest available model (pricing was not published)";
    lines.push(
      "No free model is available. STOP and ask the user, verbatim: " +
        `"No free model is available. Use ${price} to fix these findings? (yes/no)". ` +
        "Do NOT spawn anything until the user answers. If (and only if) they say yes, use that model for " +
        "every spawn_session call (omit the model parameter only if no model id could be determined).",
    );
  } else {
    lines.push(
      "No model list could be resolved. Spawn children without a model parameter (they inherit this " +
        "session's model) and tell the user that no free or cheap model could be resolved.",
    );
  }

  // Step 1 -----------------------------------------------------------
  lines.push("");
  if (mode === "deep") {
    lines.push("### Step 1 — Deep review (LLM pass)");
    if (canSpawn && model.reviewModel) {
      lines.push(
        `Spawn ONE deep-review child with spawn_session using model \`"${model.reviewModel}"\`, ` +
          `wait: true, timeoutSec: 1800, tags: ["code-review","reviewer"]. Prompt it with:`,
      );
      lines.push("```text");
      lines.push(REVIEWER_PROMPT(targetPath, true));
      lines.push("```");
      lines.push(
        "Collect every bug it reports. Read its output carefully and discard obvious false positives. " +
          "If the child fails or times out, do the deep review yourself before continuing.",
      );
    } else {
      lines.push(
        "Do the deep review yourself. Read the actual source files (use codebase_search / glob / grep and read), " +
          "then run the review brief below over the whole codebase:",
      );
      lines.push("```text");
      lines.push(REVIEWER_PROMPT(targetPath, true));
      lines.push("```");
    }
  } else {
    lines.push("### Step 1 — Static findings");
    lines.push(
      findings.length > 0
        ? `The static scan found ${findings.length} finding(s) listed below.`
        : "The static scan found no findings.",
    );
    if (input.needFallbackReview) {
      lines.push("");
      lines.push(
        "Because the static scan is sparse, ALSO spawn ONE free-LLM reviewer child with spawn_session " +
          `using model \`"${model.reviewModel || model.fixModel}"\`, wait: true, timeoutSec: 900, ` +
          `tags: ["code-review","reviewer"]. Prompt it with:`,
      );
      lines.push("```text");
      lines.push(REVIEWER_PROMPT(targetPath, false));
      lines.push("```");
      lines.push(
        "Merge its findings with the static findings below (drop duplicates and obvious false positives).",
      );
    }
  }

  // Findings list ----------------------------------------------------
  if (findings.length > 0) {
    lines.push("");
    lines.push("### Static findings");
    lines.push("```text");
    for (const f of findings) {
      lines.push(`[${f.severity}/${f.category}] ${f.file}:${f.line} — ${f.message}`);
      lines.push(`  Fix: ${f.suggestion}`);
      if (f.autoFix) lines.push(`  Auto-fix hint: ${f.autoFix}`);
    }
    lines.push("```");
  }

  // Step 2: fix ------------------------------------------------------
  lines.push("");
  lines.push("### Step 2 — Spawn fixers");
  lines.push(
    "Take the confirmed bug list (static + any reviewer findings; for deep mode, the bugs you found). " +
      "Group them by file. For each file (or independent chunk), spawn one fixer child with spawn_session " +
      '(model per the policy above, wait: false, directory the repo root, tags: ["code-review","fixer"]) using this prompt:',
  );
  lines.push("```text");
  lines.push(fixerPrompt(targetPath, findings.length > 0 ? findings : []));
  lines.push("```");
  lines.push(
    `Run at most ${cfg.maxFixAgents} fixer(s) at a time. Keep going until every bug has a fixer. ` +
      "Use session_result to collect each child's summary as it finishes.",
  );

  // Step 3: verify ---------------------------------------------------
  lines.push("");
  lines.push("### Step 3 — Verify and report");
  lines.push(
    "After the fixers finish: (1) run the project's test suite, (2) re-run the static scan " +
      "(`code_review_diff` for a diff, or `/code-review project` for a tree) to confirm the findings are gone. " +
      "If a fix failed or regressed, use session_send to give that fixer a follow-up. " +
      "Finally, summarize: bugs found, bugs fixed, any skipped (with why), and any remaining risk.",
  );

  return lines.join("\n");
}

// --- Direct spawn mode (the plugin creates the children itself) ---

interface DirectSessionApi {
  create?: (input: {
    title?: string;
    model?: { id: string; providerID: string };
    location?: { directory: string };
    metadata?: Record<string, unknown>;
  }) => unknown;
  prompt?: (input: { sessionID: string; text: string }) => unknown;
  context?: (input: { sessionID: string }) => unknown;
  /** CR-9: optional status probe; used to confirm a child really stopped working. */
  status?: (input: { sessionID: string }) => unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split `providerID/modelID`, tolerating ids that contain slashes. */
function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i >= ref.length - 1) return null;
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

function assistantTextOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => String((p as { text?: unknown }).text ?? ""))
      .join("\n")
      .trim();
  }
  return "";
}

function newestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: string };
    if (m?.type !== "assistant") continue;
    const text = assistantTextOf(m);
    if (text) return text;
  }
  return "";
}

async function createChildSession(
  api: DirectSessionApi,
  opts: {
    title: string;
    model: { providerID: string; modelID: string };
    directory: string;
    prompt: string;
  },
): Promise<string> {
  if (typeof api.create !== "function" || typeof api.prompt !== "function") return "";
  try {
    const created = (await api.create({
      title: opts.title,
      model: { id: opts.model.modelID, providerID: opts.model.providerID },
      ...(opts.directory ? { location: { directory: opts.directory } } : {}),
      metadata: { spawnedBy: "code-review" },
    })) as { id?: string } | undefined;
    const id = created?.id;
    if (!id) return "";
    await api.prompt({ sessionID: id, text: opts.prompt });
    return id;
  } catch {
    return "";
  }
}

/** CR-9: unchanged reads that stand in for a completion signal the host cannot give. */
const STABLE_SNAPSHOTS = 3;

/** CR-9: the poll starts this short and doubles up to the caller's ceiling. */
const MIN_POLL_MS = 250;

/** CR-9: interpret an optional session-status probe as "this child is done". */
function childLooksIdle(status: unknown): boolean {
  if (!status) return false;
  if (typeof status === "string") {
    return ["idle", "completed", "done", "finished"].includes(status.toLowerCase());
  }
  if (typeof status !== "object") return false;
  const s = status as Record<string, unknown>;
  const raw = String(s.status ?? s.state ?? s.type ?? "").toLowerCase();
  return ["idle", "completed", "done", "finished"].includes(raw);
}

/**
 * CR-9: does this snapshot read like a finished answer rather than the
 * paragraph a child pauses on mid-review?
 *
 * Only used when the host cannot report a child's status at all, where the sole
 * other evidence is that the text stopped changing — which a "thinking" child
 * does for tens of seconds. A finished answer ends with sentence punctuation, a
 * closing bracket/backtick or a fence; anything else is treated as truncated.
 */
function looksFinished(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return true;
  if (trimmed.endsWith("```")) return true;
  return /[.!?:;)\]}`>'"]$/u.test(trimmed);
}

/**
 * Poll a direct-mode child until its final message appears.
 *
 * CR-9: three things used to make every review pay 8-12 s of pure latency and
 * still truncate. The fixed 4 s tick meant a child that finished in 2 s was only
 * noticed on the third tick, and `stable >= 3` was checked *before* the status
 * probe, so a reviewer that paused mid-thought ("thinking" between two tool
 * calls) read stable three times and its truncated paragraph — the very thing
 * the fixers were handed — came back as final.
 *
 * Completion is now ranked by signal strength, and only ever by signal:
 * 1. the reviewer sentinel `[[REVIEW_DONE]]`, which REVIEWER_PROMPT already
 *    requires on its own final line — a pause can never contain it;
 * 2. the host reporting the child idle/completed, probed *before* any fallback;
 * 3. only when the host exposes no status at all: STABLE_SNAPSHOTS unchanged
 *    reads *and* a snapshot that looks finished.
 *
 * "The text stopped changing" alone is never enough, and the deadline always
 * wins. Polling backs off from MIN_POLL_MS to the caller's ceiling so a prompt
 * finish is caught in a fraction of the old latency instead of a full tick.
 */
async function waitForChildText(
  api: DirectSessionApi,
  sessionID: string,
  timeoutMs: number,
  pollMs = 4000,
): Promise<string> {
  if (typeof api.context !== "function") return "";
  const statusProbe = typeof api.status === "function" ? api.status : null;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stable = 0;
  let interval = Math.max(1, Math.min(MIN_POLL_MS, pollMs));
  while (Date.now() < deadline) {
    await delay(Math.max(1, Math.min(interval, deadline - Date.now())));
    interval = Math.min(pollMs, interval * 2);

    let messages: unknown;
    try {
      messages = await api.context({ sessionID });
    } catch {
      continue;
    }
    const text = newestAssistantText(messages);
    if (text) {
      if (text.includes(REVIEW_DONE_SENTINEL)) {
        return text.split(REVIEW_DONE_SENTINEL)[0].trim();
      }
      if (text === last) stable++;
      else {
        last = text;
        stable = 1;
      }
    }

    // Signal 2: the host saying the child stopped working. Probed first, so a
    // child that is demonstrably still busy can never exit on stability.
    let statusKnown = false;
    if (statusProbe) {
      try {
        statusKnown = true;
        // `.call(api, …)`: the host may hand us a method that reads `this`.
        if (childLooksIdle(await statusProbe.call(api, { sessionID }))) return last;
      } catch {
        statusKnown = false;
        /* status is best-effort */
      }
    }

    // Signal 3: stability, and only where there is no status to read. It is
    // deliberately paired with looksFinished — an unchanged paragraph is what a
    // mid-thought pause looks like, and returning it is the bug this replaced.
    if (!statusKnown && stable >= STABLE_SNAPSHOTS && looksFinished(last)) return last;
  }
  return last;
}

/** Group findings by file, merging into at most `maxGroups` chunks. */
function groupFindingsByFile(findings: ReviewFinding[], maxGroups: number): ReviewFinding[][] {
  const byFile = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const groups = [...byFile.values()];
  const cap = Math.max(1, maxGroups);
  if (groups.length <= cap) return groups;
  const merged: ReviewFinding[][] = Array.from({ length: cap }, () => []);
  groups.forEach((g, i) => merged[i % cap].push(...g));
  return merged.filter((g) => g.length > 0);
}

function buildDeepFixerPrompt(target: string, reviewerText: string): string {
  if (reviewerText) {
    return [
      `You are a focused bug-fixing agent working in ${target}.`,
      "A deep reviewer examined this codebase and reported the issues below. Verify each by reading the code, then fix every real bug minimally and safely; skip false positives with a one-line note.",
      "",
      reviewerText,
      "",
      "Rules: read before editing; smallest correct change; preserve behavior; run relevant tests; never edit generated or vendored files.",
      "Return: each issue, status (fixed/skipped), and the files changed.",
    ].join("\n");
  }
  return [
    `You are a deep review-and-fix agent working in ${target}.`,
    "Audit the whole codebase for real bugs (logic, null derefs, async/races, resource leaks, error handling, security, edge cases).",
    "For each real bug: verify it, then fix it minimally and safely. Read files before editing; run relevant tests; never edit generated or vendored files.",
    "Return: bugs found, fixed, and skipped (with reasons).",
  ].join("\n");
}

async function runDirectSpawn(
  ctx: unknown,
  cfg: CodeReviewConfig,
  opts: {
    mode: "targeted" | "deep";
    targetLabel: string;
    targetPath: string;
    reviewId: number | null;
    findings: ReviewFinding[];
  },
  needFallbackReview: boolean,
  callbacks: { note: (text: string) => Promise<void>; say: (text: string) => Promise<void> },
): Promise<void> {
  const api = (ctx as { session?: DirectSessionApi })?.session;
  const model = await resolveAgentModels(ctx, cfg);

  // No session API here: fall back to the agent brief rather than doing nothing.
  if (!api || typeof api.create !== "function" || typeof api.prompt !== "function") {
    await callbacks.note("spawnMode=direct needs session.create/prompt; falling back to the agent brief.");
    const canSpawn = await hasTool(ctx, "spawn_session");
    await callbacks.say(buildAgentTaskBrief({ ...opts, cfg, model, canSpawn, needFallbackReview }));
    return;
  }

  // Never spend silently: no free model means stop and tell the user what to do.
  if (!model.fixModel) {
    await callbacks.note(
      `spawnMode=direct: no free model available (${model.note}). Nothing was spawned. ` +
        `Set code-review \`fixModel\` to approve a paid model, or use spawnMode="agent" to be asked interactively.`,
    );
    return;
  }

  const fixRef = parseModelRef(model.fixModel);
  const reviewRef = parseModelRef(model.reviewModel || model.fixModel);
  if (!fixRef) {
    await callbacks.note(`spawnMode=direct: could not parse fix model "${model.fixModel}". Nothing was spawned.`);
    return;
  }

  const spawned: string[] = [];

  // Phase 1: reviewer child (bounded wait) when sparse or deep.
  let reviewerText = "";
  if ((opts.mode === "deep" || needFallbackReview) && reviewRef) {
    const rid = await createChildSession(api, {
      title: "code-review: reviewer",
      model: reviewRef,
      directory: opts.targetPath,
      prompt: REVIEWER_PROMPT(opts.targetPath, opts.mode === "deep"),
    });
    if (rid) {
      spawned.push(rid);
      reviewerText = await waitForChildText(api, rid, cfg.directReviewTimeoutSec * 1000);
    }
  }

  // Phase 2: fixer children.
  if (opts.mode === "deep") {
    const fid = await createChildSession(api, {
      title: "code-review: deep fixer",
      model: fixRef,
      directory: opts.targetPath,
      prompt: buildDeepFixerPrompt(opts.targetPath, reviewerText),
    });
    if (fid) spawned.push(fid);
  } else {
    let chunks = groupFindingsByFile(opts.findings, cfg.maxFixAgents);
    if (chunks.length === 0 && reviewerText) chunks = [[]];
    for (const chunk of chunks) {
      const prompt =
        fixerPrompt(opts.targetPath, chunk) +
        (reviewerText ? `\n\nA deep reviewer also reported these issues to fix:\n${reviewerText}` : "");
      const fid = await createChildSession(api, {
        title: `code-review: fix ${chunk[0]?.file ?? "reviewer findings"}`,
        model: fixRef,
        directory: opts.targetPath,
        prompt,
      });
      if (fid) spawned.push(fid);
    }
  }

  await callbacks.note(
    spawned.length
      ? `spawnMode=direct: spawned ${spawned.length} child session(s) on ${model.fixModel}` +
          `${opts.mode === "deep" ? " (deep review + fix)" : ""}: ${spawned.join(", ")}.`
      : "spawnMode=direct: nothing was spawned (session.create/prompt failed).",
  );
}

/**
 * Resolve the fix model, build the brief, and inject it so the current agent
 * spawns the fixer children. `note`/`say` are the caller's session writers.
 */
async function injectAgentFixFlow(
  ctx: unknown,
  cfg: CodeReviewConfig,
  sessionID: string,
  opts: {
    mode: "targeted" | "deep";
    targetLabel: string;
    targetPath: string;
    reviewId: number | null;
    findings: ReviewFinding[];
  },
  callbacks: { note: (text: string) => Promise<void>; say: (text: string) => Promise<void> },
): Promise<void> {
  if (!cfg.enableAgentFixes) return;
  const needFallbackReview =
    opts.mode === "targeted" &&
    cfg.enableLlmFallback &&
    opts.findings.length < cfg.llmFallbackThreshold;
  if (opts.mode === "targeted" && opts.findings.length === 0 && !needFallbackReview) return;

  if (cfg.spawnMode === "direct") {
    await runDirectSpawn(ctx, cfg, opts, needFallbackReview, callbacks);
    return;
  }

  const canSpawn = await hasTool(ctx, "spawn_session");
  const model = await resolveAgentModels(ctx, cfg);
  const brief = buildAgentTaskBrief({ ...opts, cfg, model, canSpawn, needFallbackReview });
  await callbacks.note(
    `Agent fixes enabled — handing ${opts.findings.length} static finding(s) to fixer ` +
      `${canSpawn ? "subagents" : "(spawn_session unavailable, fixing inline)"}. ${model.note}.`,
  );
  await callbacks.say(brief);
}

// --- Plugin definition ---

export default Plugin.define({
  id: "code-review",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as unknown as Record<string, unknown> | undefined);
    const defaultDirectory = ctx.location.directory;

    if (!cfg.enabled) {
      return;
    }

    await ctx.tool.transform((editor) => {
      // --- code_review_file ---
      editor.add({
        name: "code_review_file",
        description:
          "Review a single file for security issues, bugs, style problems, and performance concerns. Returns findings with severity, line number, message, suggestion, confidence score, and auto-fix where available.",
        input: z.object({
          path: z.string().describe("Path to the file to review"),
          severity: z.enum(["low", "medium", "high"]).optional().describe("Minimum severity to report (default: from config)"),
        }),
        execute: async (input) => {
          const args = input as { path: string; severity?: ReviewSeverity };
          try {
            // CR-6: a relative path means "relative to this project", not
            // "relative to whatever directory the opencode host was started in".
            const target = resolveTarget(defaultDirectory, args.path);
            if (!existsSync(target)) {
              return { content: `File not found: ${args.path}` };
            }
            const stat = statSync(target);
            if (!stat.isFile()) {
              return { content: `Not a file: ${args.path}` };
            }

            // CR-2: rules saved through code_review_custom_rules now apply too.
            const dbRules = await loadCustomRules();
            const skipped: string[] = [];
            // CR-6: findings are keyed relative to the project dir, like every other path.
            const findings = localizeFindings(
              defaultDirectory,
              reviewFile(target, cfg, args.severity ?? cfg.severity, dbRules, skipped),
            );
            const result: ReviewResult = {
              findings,
              filesReviewed: 1,
              durationMs: 0,
              stats: computeStats(findings),
              skipped,
            };

            const outcome = await storeReview(result, reviewSummary(result, "1 file"));
            const reviewId = outcome.reviewId ?? undefined;

            return {
              content:
                formatReviewResult(result, `Reviewed: ${args.path}`, reviewId) +
                // CR-4: an unstored review is invisible to history/trends/fix-all.
                (outcome.error
                  ? `\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it: ${outcome.error}`
                  : ""),
            };
          } catch (err) {
            return { content: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_diff ---
      editor.add({
        name: "code_review_diff",
        description:
          "Review a diff/patch for security issues, bugs, style problems, and performance concerns. Analyzes only the added lines. Returns findings with severity, line number, message, suggestion, confidence score, and auto-fix where available.",
        input: z.object({
          diff: z.string().describe("The diff/patch text to review"),
          severity: z.enum(["low", "medium", "high"]).optional().describe("Minimum severity to report (default: from config)"),
        }),
        execute: async (input) => {
          const args = input as { diff: string; severity?: ReviewSeverity };
          try {
            if (!args.diff.trim()) {
              return { content: "Empty diff provided." };
            }

            const dbRules = await loadCustomRules();
            const findings = reviewDiff(args.diff, cfg, args.severity ?? cfg.severity, dbRules);
            const result: ReviewResult = {
              findings,
              filesReviewed: 1,
              durationMs: 0,
              stats: computeStats(findings),
            };

            const outcome = await storeReview(result, reviewSummary(result, "diff"));
            const reviewId = outcome.reviewId ?? undefined;

            return {
              content:
                formatReviewResult(result, "Reviewed: diff", reviewId) +
                // CR-4: an unstored review is invisible to history/trends/fix-all.
                (outcome.error
                  ? `\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it: ${outcome.error}`
                  : ""),
            };
          } catch (err) {
            return { content: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_project ---
      editor.add({
        name: "code_review_project",
        description:
          "Review an entire project for security issues, bugs, style problems, and performance concerns. Walks all source files, reviews each, and returns a summary of findings across all files with statistics and trend analysis.",
        input: z.object({
          path: z.string().optional().describe("Project root path (default: current project directory)"),
          severity: z.enum(["low", "medium", "high"]).optional().describe("Minimum severity to report (default: from config)"),
          maxFiles: z.number().int().positive().optional().describe("Maximum files to review (default: from config, max 200)"),
        }),
        execute: async (input) => {
          const args = input as { path?: string; severity?: ReviewSeverity; maxFiles?: number };
          try {
            // CR-6: relative project paths resolve against this project's directory.
            const rootPath = args.path ? resolveTarget(defaultDirectory, args.path) : defaultDirectory;
            if (!rootPath || !existsSync(rootPath)) {
              return { content: `Path not found: ${rootPath}` };
            }

            const maxFiles = Math.min(args.maxFiles ?? cfg.maxFiles, 200);
            const dbRules = await loadCustomRules();
            const result = reviewProject(rootPath, cfg, args.severity ?? cfg.severity, maxFiles, dbRules);
            // CR-6: store findings keyed relative to the project dir.
            result.findings = localizeFindings(defaultDirectory, result.findings);

            const outcome = await storeReview(result, reviewSummary(result, `${result.filesReviewed} files`));
            const reviewId = outcome.reviewId ?? undefined;

            // CR-15: the same windowed trend the tool reports, read after storing.
            let trendLine = "";
            if (cfg.enableTrendAnalysis) {
              const report = await readTrendReport(TREND_WINDOW_DEFAULT);
              if (report) {
                const trend = report.overall;
                trendLine = `\n\n### Trend\n  ${trend.message} (${trend.previousCount} → ${trend.currentCount})`;
              }
            }

            return {
              content:
                formatReviewResult(result, `Reviewed: ${rootPath}`, reviewId) +
                trendLine +
                // CR-4: an unstored review is invisible to history/trends/fix-all.
                (outcome.error
                  ? `\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it: ${outcome.error}`
                  : ""),
            };
          } catch (err) {
            return { content: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_history ---
      editor.add({
        name: "code_review_history",
        description:
          "Show past code reviews with timestamp, file count, and finding count. Results are stored locally in SQLite.",
        input: z.object({
          limit: z.number().int().positive().optional().describe("Maximum number of past reviews to return (default 20, max 100)"),
        }),
        execute: async (input) => {
          const args = input as { limit?: number };
          try {
            const limit = clampLimit(args.limit ?? 20, 20, 100);
            const out = await readDb(() => {
              const database = getDb();
              const rows = database
                .query("SELECT * FROM reviews ORDER BY id DESC LIMIT ?")
                .all(limit) as Array<{
                  id: number;
                  created_at: string;
                  file_count: number;
                  finding_count: number;
                  summary: string;
                }>;

              if (rows.length === 0) {
                return "No review history found.";
              }

              const lines: string[] = [`Past reviews (${rows.length}):`];
              for (const r of rows) {
                lines.push(
                  `  #${r.id}  ${formatAge(r.created_at)} ago  —  ${r.file_count} files, ${r.finding_count} findings  —  ${r.summary}`
                );
              }
              return lines.join("\n");
            });
            return { content: out };
          } catch (err) {
            return { content: `Failed to read review history: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_trends ---
      editor.add({
        name: "code_review_trends",
        description:
          "Show trend analysis of code review findings over time. Compares recent reviews to show if code quality is improving or worsening.",
        input: z.object({
          limit: z.number().int().positive().optional().describe("Number of recent reviews to analyze (default 10, max 50)"),
        }),
        execute: async (input) => {
          const args = input as { limit?: number };
          try {
            // CR-15: same windowed report as `/code-review trends`.
            const report = await readTrendReport(args.limit ?? TREND_WINDOW_DEFAULT);
            if (!report) return { content: "Failed to read trends." };
            return { content: renderTrendReport(report) };
          } catch (err) {
            return { content: `Failed to read trends: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_fix ---
      editor.add({
        name: "code_review_fix",
        description:
          "Get the auto-fix for a specific finding. Returns the suggested code fix that can be applied to resolve the issue.",
        input: z.object({
          reviewId: z.number().int().positive().describe("The review ID from code_review_history"),
          findingId: z.number().int().positive().optional().describe("Specific finding ID to fix (omit for all fixable findings)"),
        }),
        execute: async (input) => {
          const args = input as { reviewId: number; findingId?: number };
          try {
            const out = await readDb(() => {
              const database = getDb();
              let rows: Array<{
                id: number;
                file_path: string;
                line_number: number;
                severity: string;
                category: string;
                message: string;
                suggestion: string;
                auto_fix: string | null;
                rule_id: string;
              }>;

              if (args.findingId) {
                rows = database
                  .query("SELECT * FROM review_findings WHERE id = ? AND review_id = ?")
                  .all(args.findingId, args.reviewId) as typeof rows;
              } else {
                rows = database
                  .query("SELECT * FROM review_findings WHERE review_id = ? AND auto_fix IS NOT NULL")
                  .all(args.reviewId) as typeof rows;
              }

              if (rows.length === 0) {
                return "No fixable findings found for this review.";
              }

              const lines: string[] = [`## Auto-Fixes (${rows.length} findings)`];
              for (const r of rows) {
                lines.push(`\n### Finding #${r.id}: ${r.message}`);
                lines.push(`  File: ${r.file_path}:${r.line_number}`);
                lines.push(`  Severity: ${r.severity}  |  Category: ${r.category}`);
                lines.push(`  Suggestion: ${r.suggestion}`);
                if (r.auto_fix) {
                  lines.push(`  Auto-fix:\n\`\`\`\n${r.auto_fix}\n\`\`\``);
                }
              }
              return lines.join("\n");
            });
            return { content: out };
          } catch (err) {
            return { content: `Failed to get fixes: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_custom_rules ---
      editor.add({
        name: "code_review_custom_rules",
        description:
          "Manage custom review rules. Add, list, update, or delete user-defined patterns to search for in code reviews.",
        input: z.object({
          action: z.enum(["list", "add", "update", "delete"]).describe("Action to perform"),
          id: z.string().optional().describe("Rule ID (required for update/delete)"),
          name: z.string().optional().describe("Rule name (required for add)"),
          pattern: z.string().optional().describe("Regex pattern to match (required for add)"),
          category: z.enum(["security", "bugs", "style", "performance"]).optional().describe("Rule category"),
          severity: z.enum(["low", "medium", "high"]).optional().describe("Rule severity"),
          message: z.string().optional().describe("Message to show when pattern matches"),
          suggestion: z.string().optional().describe("Suggestion for fixing the issue"),
          enabled: z.boolean().optional().describe("Whether the rule is enabled"),
        }),
        execute: async (input) => {
          const args = input as {
            action: "list" | "add" | "update" | "delete";
            id?: string;
            name?: string;
            pattern?: string;
            category?: ReviewCategory;
            severity?: ReviewSeverity;
            message?: string;
            suggestion?: string;
            enabled?: boolean;
          };
          try {
            if (args.action === "list") {
              const out = await readDb(() => {
                const database = getDb();
                const rows = database
                  .query("SELECT * FROM custom_rules ORDER BY created_at DESC")
                  .all() as Array<{
                    id: string;
                    name: string;
                    pattern: string;
                    category: string;
                    severity: string;
                    message: string;
                    suggestion: string;
                    enabled: number;
                    created_at: string;
                  }>;

                if (rows.length === 0) {
                  return "No custom rules defined.";
                }

                const lines: string[] = [`Custom rules (${rows.length}):`];
                for (const r of rows) {
                  const status = r.enabled ? "enabled" : "disabled";
                  lines.push(`  [${r.id}] ${r.name} (${r.severity}, ${r.category}, ${status})`);
                  lines.push(`    Pattern: ${r.pattern}`);
                  lines.push(`    Message: ${r.message}`);
                }
                return lines.join("\n");
              });
              return { content: out };
            }

            if (args.action === "add") {
              if (!args.name || !args.pattern) {
                return { content: "Name and pattern are required to add a rule." };
              }
              // CR-7: a pattern is compiled before it is stored. An invalid one
              // used to be accepted and then silently never matched anything; a
              // nested-quantifier one is refused outright — measured on a 46-char
              // line, `(a+)+$` blocked the whole host for 177 s, so a warning next
              // to a stored, per-line-executable pattern would not be enough.
              const compiled = compileUserPattern(args.pattern);
              if (!compiled.ok) {
                return { content: `Rejected: pattern ${compiled.reason}.` };
              }
              const id = `custom-${Date.now().toString(36)}`;
              const stored = await writeDb(() => {
                const database = getDb();
                const res = database.query(
                  "INSERT INTO custom_rules (id, name, pattern, category, severity, message, suggestion, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                ).run(
                  id,
                  args.name,
                  args.pattern,
                  args.category ?? "bugs",
                  args.severity ?? "medium",
                  args.message ?? "Custom rule match",
                  args.suggestion ?? "Review this code",
                  args.enabled === false ? 0 : 1,
                ) as { changes?: number };
                // CR-4: claim success only if a row really went in.
                if (Number(res?.changes ?? 0) !== 1) throw new Error("insert affected no rows");
                return true;
              });
              invalidateUserPatternCache();
              if (stored !== true) {
                return { content: "Custom rule was NOT stored (storage unavailable)." };
              }
              return { content: `Custom rule added with ID: ${id}` };
            }

            if (args.action === "update") {
              if (!args.id) {
                return { content: "ID is required to update a rule." };
              }
              // CR-7: same validation as add — an updated pattern must compile.
              if (args.pattern !== undefined) {
                const compiled = compileUserPattern(args.pattern);
                if (!compiled.ok) {
                  return { content: `Rejected: pattern ${compiled.reason}.` };
                }
              }
              const changes = await writeDb(() => {
                const database = getDb();
                const updates: string[] = [];
                const params: unknown[] = [];
                if (args.name !== undefined) { updates.push("name = ?"); params.push(args.name); }
                if (args.pattern !== undefined) { updates.push("pattern = ?"); params.push(args.pattern); }
                if (args.category !== undefined) { updates.push("category = ?"); params.push(args.category); }
                if (args.severity !== undefined) { updates.push("severity = ?"); params.push(args.severity); }
                if (args.message !== undefined) { updates.push("message = ?"); params.push(args.message); }
                if (args.suggestion !== undefined) { updates.push("suggestion = ?"); params.push(args.suggestion); }
                if (args.enabled !== undefined) { updates.push("enabled = ?"); params.push(args.enabled ? 1 : 0); }
                if (updates.length === 0) {
                  throw new Error("No fields to update");
                }
                params.push(args.id);
                // CR-4: report how many rows the UPDATE actually touched.
                const res = database.query(`UPDATE custom_rules SET ${updates.join(", ")} WHERE id = ?`).run(...params) as {
                  changes?: number;
                };
                return Number(res?.changes ?? 0);
              });
              invalidateUserPatternCache();
              if (typeof changes !== "number") {
                return { content: `Custom rule ${args.id} was NOT updated (storage unavailable).` };
              }
              if (changes === 0) {
                return { content: `No custom rule with ID ${args.id} was changed (no such rule, or no change).` };
              }
              return { content: `Custom rule ${args.id} updated.` };
            }

            if (args.action === "delete") {
              if (!args.id) {
                return { content: "ID is required to delete a rule." };
              }
              const removed = await writeDb(() => {
                const database = getDb();
                // CR-4: deleting a nonexistent id used to answer "deleted."
                const res = database.query("DELETE FROM custom_rules WHERE id = ?").run(args.id) as { changes?: number };
                return Number(res?.changes ?? 0);
              });
              invalidateUserPatternCache();
              if (typeof removed !== "number") {
                return { content: `Custom rule ${args.id} was NOT deleted (storage unavailable).` };
              }
              if (removed === 0) {
                return { content: `No custom rule with ID ${args.id} exists (nothing deleted).` };
              }
              return { content: `Custom rule ${args.id} deleted.` };
            }

            return { content: "Unknown action." };
          } catch (err) {
            return { content: `Failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_stats ---
      editor.add({
        name: "code_review_stats",
        description:
          "Show detailed statistics about code review findings across all stored reviews. Includes breakdowns by severity, category, file, and rule.",
        input: z.object({
          reviewId: z.number().int().positive().optional().describe("Specific review ID to analyze (omit for all reviews)"),
        }),
        execute: async (input) => {
          const args = input as { reviewId?: number };
          try {
            const out = await readDb(() => {
              const database = getDb();

              let findings: Array<{
                severity: string;
                category: string;
                file_path: string;
                rule_id: string;
                confidence: number;
                auto_fix: string | null;
              }>;

              if (args.reviewId) {
                findings = database
                  .query("SELECT severity, category, file_path, rule_id, confidence, auto_fix FROM review_findings WHERE review_id = ?")
                  .all(args.reviewId) as typeof findings;
              } else {
                findings = database
                  .query("SELECT severity, category, file_path, rule_id, confidence, auto_fix FROM review_findings")
                  .all() as typeof findings;
              }

              if (findings.length === 0) {
                return "No findings data available.";
              }

              const bySeverity: Record<string, number> = {};
              const byCategory: Record<string, number> = {};
              const byFile: Record<string, number> = {};
              const byRule: Record<string, number> = {};
              let totalConf = 0;
              let fixable = 0;

              for (const f of findings) {
                bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
                byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
                byFile[f.file_path] = (byFile[f.file_path] ?? 0) + 1;
                byRule[f.rule_id] = (byRule[f.rule_id] ?? 0) + 1;
                totalConf += f.confidence;
                if (f.auto_fix) fixable++;
              }

              const lines: string[] = [`## Code Review Statistics (${findings.length} findings)`];

              lines.push(`\n### By Severity`);
              for (const [k, v] of Object.entries(bySeverity).sort((a, b) => b[1] - a[1])) {
                lines.push(`  ${k}: ${v}`);
              }

              lines.push(`\n### By Category`);
              for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
                lines.push(`  ${k}: ${v}`);
              }

              lines.push(`\n### By Rule`);
              for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
                lines.push(`  ${k}: ${v}`);
              }

              lines.push(`\n### Top Files`);
              const sortedFiles = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10);
              for (const [k, v] of sortedFiles) {
                lines.push(`  ${k}: ${v} findings`);
              }

              lines.push(`\n### Confidence`);
              lines.push(`  Average: ${Math.round((totalConf / findings.length) * 100)}%`);
              lines.push(`  Auto-fixable: ${fixable}`);

              return lines.join("\n");
            });
            return { content: out };
          } catch (err) {
            return { content: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_get (backward compatibility) ---
      editor.add({
        name: "code_review_get",
        description: "Get a specific review by its ID.",
        input: z.object({
          id: z.number().int().positive().describe("The review ID"),
        }),
        execute: async (input) => {
          const args = input as { id: number };
          try {
            const out = await readDb(() => {
              const database = getDb();
              const review = database
                .query("SELECT * FROM reviews WHERE id = ?")
                .get(args.id) as {
                  id: number;
                  created_at: string;
                  file_count: number;
                  finding_count: number;
                  summary: string;
                } | null;

              if (!review) {
                return `Review #${args.id} not found.`;
              }

              const findings = database
                .query("SELECT * FROM review_findings WHERE review_id = ?")
                .all(args.id) as Array<{
                  id: number;
                  file_path: string;
                  line_number: number;
                  severity: string;
                  category: string;
                  message: string;
                  suggestion: string;
                  confidence: number;
                  rule_id: string;
                  auto_fix: string | null;
                }>;

              const lines: string[] = [`#${review.id} — ${review.created_at}`];
              lines.push(`Files: ${review.file_count}  |  Findings: ${review.finding_count}`);
              lines.push(`Summary: ${review.summary}`);

              if (findings.length > 0) {
                lines.push(`\n### Findings`);
                for (const f of findings) {
                  lines.push(`  [${f.severity.toUpperCase()}] ${f.file_path}:${f.line_number} — ${f.message}`);
                  if (f.suggestion) lines.push(`    Suggestion: ${f.suggestion}`);
                }
              }

              return lines.join("\n");
            });
            return { content: out };
          } catch (err) {
            return { content: `Failed to get review: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_search (backward compatibility) ---
      editor.add({
        name: "code_review_search",
        description: "Search review history by content.",
        input: z.object({
          query: z.string().describe("Search query"),
          all: z.boolean().optional().describe("Search across all projects"),
        }),
        execute: async (input) => {
          const args = input as { query: string; all?: boolean };
          try {
            const out = await readDb(() => {
              const database = getDb();
              const rows = database
                .query(
                  `SELECT r.id, r.created_at, r.file_count, r.finding_count, r.summary
                   FROM reviews r
                   WHERE r.summary LIKE ? OR r.id IN (
                     SELECT review_id FROM review_findings WHERE message LIKE ? OR suggestion LIKE ?
                   )
                   ORDER BY r.id DESC LIMIT 20`
                )
                .all(`%${args.query}%`, `%${args.query}%`, `%${args.query}%`) as Array<{
                  id: number;
                  created_at: string;
                  file_count: number;
                  finding_count: number;
                  summary: string;
                }>;

              if (rows.length === 0) {
                return "No reviews found.";
              }

              const lines: string[] = [`Search results (${rows.length}):`];
              for (const r of rows) {
                lines.push(`  #${r.id}  ${formatAge(r.created_at)} ago  —  ${r.file_count} files, ${r.finding_count} findings  —  ${r.summary}`);
              }
              return lines.join("\n");
            });
            return { content: out };
          } catch (err) {
            return { content: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // --- code_review_config (backward compatibility) ---
      editor.add({
        name: "code_review_config",
        description: "Show current code review configuration.",
        input: z.object({}),
        execute: async () => {
          try {
            const lines: string[] = [`## Code Review Configuration`];
            lines.push(`  db: ${DB_PATH}`);
            lines.push(`  enabled: ${cfg.enabled}`);
            lines.push(`  severity: ${cfg.severity}`);
            lines.push(`  maxFiles: ${cfg.maxFiles}`);
            lines.push(`  maxFindingsPerFile: ${cfg.maxFindingsPerFile}`);
            lines.push(`  rules: security=${cfg.rules.security}, bugs=${cfg.rules.bugs}, style=${cfg.rules.style}, performance=${cfg.rules.performance}`);
            lines.push(`  excludePatterns: ${cfg.excludePatterns.join(", ") || "(none)"}`);
            lines.push(`  includePatterns: ${cfg.includePatterns.join(", ") || "(none)"}`);
            lines.push(`  customRules: ${cfg.customRules.length}`);
            lines.push(`  severityOverrides: ${Object.keys(cfg.severityOverrides).length}`);
            lines.push(`  focusAreas: ${cfg.focusAreas.join(", ") || "(none)"}`);
            lines.push(`  enableAutoFix: ${cfg.enableAutoFix}`);
            lines.push(`  enableTrendAnalysis: ${cfg.enableTrendAnalysis}`);
            lines.push(`  enableConfidenceScoring: ${cfg.enableConfidenceScoring}`);
            lines.push(`  enableAgentFixes: ${cfg.enableAgentFixes}`);
            lines.push(`  enableLlmFallback: ${cfg.enableLlmFallback}`);
            lines.push(`  llmFallbackThreshold: ${cfg.llmFallbackThreshold}`);
            lines.push(`  fixModel: ${cfg.fixModel || "(auto: free, else ask)"}`);
            lines.push(`  reviewModel: ${cfg.reviewModel || "(auto: free)"}`);
            lines.push(`  maxFixAgents: ${cfg.maxFixAgents}`);
            lines.push(`  deepReview: ${cfg.deepReview}`);
            lines.push(`  spawnMode: ${cfg.spawnMode}`);
            lines.push(`  directReviewTimeoutSec: ${cfg.directReviewTimeoutSec}`);
            lines.push(`  rulesLoaded: ${RULES.length}`);
            return { content: lines.join("\n") };
          } catch (err) {
            return { content: `Failed to get config: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });
    });

    // --- Command registration ---

    if (ctx.command?.transform) {
      try {
        await ctx.command.transform((editor) => {
          editor.add({
            name: "code-review",
            description: "Review code for security issues, bugs, style problems, and performance concerns.",
            execute: async ({ sessionID, prompt }) => {
              const text = prompt?.text ?? "";
              const trimmed = text.trim();

              const sessionApi = ctx.session as unknown as {
                synthetic?: (input: { sessionID: string; text: string }) => unknown;
                prompt?: (input: { sessionID: string; text: string }) => unknown;
              };

              const note = async (text: string): Promise<void> => {
                try {
                  await sessionApi.synthetic?.({ sessionID, text });
                } catch (err) {
                  console.error(`[code-review] failed to post note: ${err instanceof Error ? err.message : String(err)}`);
                }
              };

              const say = async (text: string): Promise<void> => {
                try {
                  await sessionApi.prompt?.({ sessionID, text });
                } catch (err) {
                  console.error(`[code-review] failed to inject agent brief: ${err instanceof Error ? err.message : String(err)}`);
                }
              };

              // Spawn the fix flow: the current agent gets a brief and calls
              // spawn_session itself (free model first, else it asks the user).
              const runFixFlow = async (opts: {
                mode: "targeted" | "deep";
                targetLabel: string;
                targetPath: string;
                reviewId: number | null;
                findings: ReviewFinding[];
              }): Promise<void> => {
                await injectAgentFixFlow(ctx, cfg, sessionID, opts, { note, say });
              };

              if (!trimmed) {
                await note(HELP);
                return;
              }

              const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
              const verb = (match?.[1] ?? "").toLowerCase();
              const arg = (match?.[2] ?? "").trim();

              switch (verb) {
                case "help":
                  await note(HELP);
                  return;

                case "file": {
                  if (!arg) {
                    await note("Please provide a file path: /code-review file <path>");
                    return;
                  }
                  try {
                    // CR-6: resolve relative paths against this project, not the
                    // directory the opencode host process happens to run in.
                    const target = resolveTarget(defaultDirectory, arg);
                    if (!existsSync(target)) {
                      await note(`File not found: ${arg}`);
                      return;
                    }
                    // CR-2: stored custom rules apply to command reviews as well.
                    const dbRules = await loadCustomRules();
                    const skipped: string[] = [];
                    const findings = localizeFindings(
                      defaultDirectory,
                      reviewFile(target, cfg, cfg.severity, dbRules, skipped),
                    );
                    const result: ReviewResult = {
                      findings,
                      filesReviewed: 1,
                      durationMs: 0,
                      stats: computeStats(findings),
                      skipped,
                    };
                    const reviewId = await persistReview(result);
                    await note(
                      formatReviewResult(result, `Reviewed: ${arg}`, reviewId ?? undefined) +
                        // CR-4: say so when the review never reached the database.
                        (reviewId === null
                          ? "\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it."
                          : ""),
                    );
                    await runFixFlow({
                      mode: "targeted",
                      targetLabel: arg,
                      targetPath: target,
                      reviewId,
                      findings,
                    });
                  } catch (err) {
                    await note(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "diff": {
                  try {
                    // CR-1/CR-14: pinned git flags, untracked files included,
                    // and a repo without commits no longer fails the verb.
                    const { diff, notes } = collectWorkingTreeDiff(defaultDirectory);
                    if (!diff.trim()) {
                      await note(
                        `No diff found. Make sure you have uncommitted changes.${notes.length ? `\n(${notes.join("; ")})` : ""}`,
                      );
                      return;
                    }
                    const dbRules = await loadCustomRules();
                    const findings = reviewDiff(diff, cfg, cfg.severity, dbRules);
                    const result: ReviewResult = {
                      findings,
                      filesReviewed: new Set(findings.map((f) => f.file)).size || 1,
                      durationMs: 0,
                      stats: computeStats(findings),
                    };
                    const reviewId = await persistReview(result);
                    await note(
                      formatReviewResult(result, "Reviewed: current diff", reviewId ?? undefined) +
                        (notes.length ? `\n\nNote: ${notes.join("; ")}` : "") +
                        (reviewId === null
                          ? "\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it."
                          : ""),
                    );
                    await runFixFlow({
                      mode: "targeted",
                      targetLabel: "the current working-tree diff",
                      targetPath: defaultDirectory,
                      reviewId,
                      findings,
                    });
                  } catch (err) {
                    await note(`Diff review failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "project": {
                  try {
                    // CR-6: relative project paths resolve against this project's dir.
                    const rootPath = arg ? resolveTarget(defaultDirectory, arg) : defaultDirectory;
                    if (!rootPath || !existsSync(rootPath)) {
                      await note(`Path not found: ${rootPath}`);
                      return;
                    }
                    const dbRules = await loadCustomRules();
                    const result = reviewProject(rootPath, cfg, cfg.severity, cfg.maxFiles, dbRules);
                    // CR-6: one keying scheme for stored findings.
                    result.findings = localizeFindings(defaultDirectory, result.findings);
                    const reviewId = await persistReview(result);
                    await note(
                      formatReviewResult(result, `Reviewed: ${rootPath}`, reviewId ?? undefined) +
                        (reviewId === null
                          ? "\n\n⚠ This review was NOT stored, so history, trends and fix-all cannot see it."
                          : ""),
                    );
                    await runFixFlow({
                      mode: "targeted",
                      targetLabel: rootPath,
                      targetPath: rootPath,
                      reviewId,
                      findings: result.findings,
                    });
                  } catch (err) {
                    await note(`Project review failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "history": {
                  try {
                    const limit = arg ? parseInt(arg, 10) : 20;
                    const out = await readDb(() => {
                      const database = getDb();
                      const rows = database
                        .query("SELECT * FROM reviews ORDER BY id DESC LIMIT ?")
                        .all(clampLimit(limit, 20, 100)) as Array<{
                          id: number;
                          created_at: string;
                          file_count: number;
                          finding_count: number;
                          summary: string;
                        }>;

                      if (rows.length === 0) {
                        return "No review history found.";
                      }

                      const lines: string[] = [`Past reviews (${rows.length}):`];
                      for (const r of rows) {
                        lines.push(
                          `  #${r.id}  ${formatAge(r.created_at)} ago  —  ${r.file_count} files, ${r.finding_count} findings  —  ${r.summary}`
                        );
                      }
                      return lines.join("\n");
                    });
                    await note(out);
                  } catch (err) {
                    await note(`Failed to read history: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "stats": {
                  try {
                    const reviewId = arg ? parseInt(arg, 10) : undefined;
                    const out = await readDb(() => {
                      const database = getDb();

                      let findings: Array<{
                        severity: string;
                        category: string;
                        file_path: string;
                        rule_id: string;
                        confidence: number;
                        auto_fix: string | null;
                      }>;

                      if (reviewId) {
                        findings = database
                          .query("SELECT severity, category, file_path, rule_id, confidence, auto_fix FROM review_findings WHERE review_id = ?")
                          .all(reviewId) as typeof findings;
                      } else {
                        findings = database
                          .query("SELECT severity, category, file_path, rule_id, confidence, auto_fix FROM review_findings")
                          .all() as typeof findings;
                      }

                      if (findings.length === 0) {
                        return "No findings data available.";
                      }

                      const bySeverity: Record<string, number> = {};
                      const byCategory: Record<string, number> = {};
                      const byFile: Record<string, number> = {};
                      const byRule: Record<string, number> = {};
                      let totalConf = 0;
                      let fixable = 0;

                      for (const f of findings) {
                        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
                        byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
                        byFile[f.file_path] = (byFile[f.file_path] ?? 0) + 1;
                        byRule[f.rule_id] = (byRule[f.rule_id] ?? 0) + 1;
                        totalConf += f.confidence;
                        if (f.auto_fix) fixable++;
                      }

                      const lines: string[] = [`## Code Review Statistics (${findings.length} findings)`];

                      lines.push(`\n### By Severity`);
                      for (const [k, v] of Object.entries(bySeverity).sort((a, b) => b[1] - a[1])) {
                        lines.push(`  ${k}: ${v}`);
                      }

                      lines.push(`\n### By Category`);
                      for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
                        lines.push(`  ${k}: ${v}`);
                      }

                      lines.push(`\n### By Rule`);
                      for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
                        lines.push(`  ${k}: ${v}`);
                      }

                      lines.push(`\n### Top Files`);
                      const sortedFiles = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10);
                      for (const [k, v] of sortedFiles) {
                        lines.push(`  ${k}: ${v} findings`);
                      }

                      lines.push(`\n### Confidence`);
                      lines.push(`  Average: ${Math.round((totalConf / findings.length) * 100)}%`);
                      lines.push(`  Auto-fixable: ${fixable}`);

                      return lines.join("\n");
                    });
                    await note(out);
                  } catch (err) {
                    await note(`Failed to get stats: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "trends": {
                  try {
                    // CR-15: same windowed report as the code_review_trends tool.
                    const report = await readTrendReport(arg ? parseInt(arg, 10) : TREND_WINDOW_DEFAULT);
                    await note(report ? renderTrendReport(report) : "Failed to read trends.");
                  } catch (err) {
                    await note(`Failed to read trends: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "fix-all": {
                  try {
                    let reviewId = arg ? parseInt(arg, 10) : NaN;
                    if (!reviewId) {
                      const latest = await readDb(() => {
                        const row = getDb()
                          .query("SELECT id FROM reviews ORDER BY id DESC LIMIT 1")
                          .get() as { id: number } | null;
                        return row?.id ?? null;
                      });
                      if (!latest) {
                        await note("No reviews found. Run /code-review file|diff|project first.");
                        return;
                      }
                      reviewId = latest;
                    }
                    // CR-4: loadReviewFindings throws on a storage failure, and a
                    // non-list result would have been iterated character by
                    // character and handed to the fixer children as findings.
                    const loaded = await loadReviewFindings(reviewId);
                    if (!Array.isArray(loaded)) {
                      await note(`Review #${reviewId}'s stored findings are unreadable; nothing was fixed.`);
                      return;
                    }
                    const findings = loaded;
                    if (findings.length === 0) {
                      await note(`Review #${reviewId} has no findings to fix.`);
                      return;
                    }
                    await note(`Spawning fixers for ${findings.length} finding(s) from review #${reviewId}…`);
                    await runFixFlow({
                      mode: "targeted",
                      targetLabel: `review #${reviewId}`,
                      targetPath: defaultDirectory,
                      reviewId,
                      findings,
                    });
                  } catch (err) {
                    await note(`Fix-all failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "deep": {
                  if (!cfg.deepReview) {
                    await note("Deep review is disabled (enableDeep/deepReview). Use /code-review project instead.");
                    return;
                  }
                  try {
                    // CR-6: relative deep-review paths resolve against this project's dir.
                    const rootPath = arg ? resolveTarget(defaultDirectory, arg) : defaultDirectory;
                    if (!rootPath || !existsSync(rootPath)) {
                      await note(`Path not found: ${rootPath}`);
                      return;
                    }
                    await note(`Starting deep LLM review over ${rootPath} (no static pass)…`);
                    await runFixFlow({
                      mode: "deep",
                      targetLabel: rootPath,
                      targetPath: rootPath,
                      reviewId: null,
                      findings: [],
                    });
                  } catch (err) {
                    await note(`Deep review failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "fix": {
                  try {
                    const parts = arg.split(/\s+/);
                    const reviewId = parseInt(parts[0], 10);
                    const findingId = parts[1] ? parseInt(parts[1], 10) : undefined;

                    if (!reviewId) {
                      await note("Usage: /code-review fix <reviewId> [findingId]");
                      return;
                    }

                    const out = await readDb(() => {
                      const database = getDb();
                      let rows: Array<{
                        id: number;
                        file_path: string;
                        line_number: number;
                        severity: string;
                        category: string;
                        message: string;
                        suggestion: string;
                        auto_fix: string | null;
                        rule_id: string;
                      }>;

                      if (findingId) {
                        rows = database
                          .query("SELECT * FROM review_findings WHERE id = ? AND review_id = ?")
                          .all(findingId, reviewId) as typeof rows;
                      } else {
                        rows = database
                          .query("SELECT * FROM review_findings WHERE review_id = ? AND auto_fix IS NOT NULL")
                          .all(reviewId) as typeof rows;
                      }

                      if (rows.length === 0) {
                        return "No fixable findings found for this review.";
                      }

                      const lines: string[] = [`## Auto-Fixes (${rows.length} findings)`];
                      for (const r of rows) {
                        lines.push(`\n### Finding #${r.id}: ${r.message}`);
                        lines.push(`  File: ${r.file_path}:${r.line_number}`);
                        lines.push(`  Severity: ${r.severity}  |  Category: ${r.category}`);
                        lines.push(`  Suggestion: ${r.suggestion}`);
                        if (r.auto_fix) {
                          lines.push(`  Auto-fix:\n\`\`\`\n${r.auto_fix}\n\`\`\``);
                        }
                      }
                      return lines.join("\n");
                    });
                    await note(out);
                  } catch (err) {
                    await note(`Failed to get fixes: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "rules": {
                  try {
                    const out = await readDb(() => {
                      const database = getDb();
                      const rows = database
                        .query("SELECT * FROM custom_rules ORDER BY created_at DESC")
                        .all() as Array<{
                          id: string;
                          name: string;
                          pattern: string;
                          category: string;
                          severity: string;
                          message: string;
                          suggestion: string;
                          enabled: number;
                          created_at: string;
                        }>;

                      if (rows.length === 0) {
                        return "No custom rules defined.";
                      }

                      const lines: string[] = [`Custom rules (${rows.length}):`];
                      for (const r of rows) {
                        const status = r.enabled ? "enabled" : "disabled";
                        lines.push(`  [${r.id}] ${r.name} (${r.severity}, ${r.category}, ${status})`);
                        lines.push(`    Pattern: ${r.pattern}`);
                        lines.push(`    Message: ${r.message}`);
                      }
                      return lines.join("\n");
                    });
                    await note(out);
                  } catch (err) {
                    await note(`Failed to list rules: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                case "config": {
                  try {
                    const lines: string[] = [`## Code Review Configuration`];
                    lines.push(`  db: ${DB_PATH}`);
                    lines.push(`  enabled: ${cfg.enabled}`);
                    lines.push(`  severity: ${cfg.severity}`);
                    lines.push(`  maxFiles: ${cfg.maxFiles}`);
                    lines.push(`  maxFindingsPerFile: ${cfg.maxFindingsPerFile}`);
                    lines.push(`  rules: security=${cfg.rules.security}, bugs=${cfg.rules.bugs}, style=${cfg.rules.style}, performance=${cfg.rules.performance}`);
                    lines.push(`  excludePatterns: ${cfg.excludePatterns.join(", ") || "(none)"}`);
                    lines.push(`  includePatterns: ${cfg.includePatterns.join(", ") || "(none)"}`);
                    lines.push(`  customRules: ${cfg.customRules.length}`);
                    lines.push(`  severityOverrides: ${Object.keys(cfg.severityOverrides).length}`);
                    lines.push(`  focusAreas: ${cfg.focusAreas.join(", ") || "(none)"}`);
                    lines.push(`  enableAutoFix: ${cfg.enableAutoFix}`);
                    lines.push(`  enableTrendAnalysis: ${cfg.enableTrendAnalysis}`);
                    lines.push(`  enableConfidenceScoring: ${cfg.enableConfidenceScoring}`);
                    await note(lines.join("\n"));
                  } catch (err) {
                    await note(`Failed to get config: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }

                default:
                  await note(HELP);
                  return;
              }
            },
          });

          if (cfg.deepReview) {
            editor.add({
              name: "deep-code-review",
              description:
                "Exhaustive LLM-only deep review of the whole codebase: hunts for every bug, then spawns free fixer subagents (free model first, else asks before using the cheapest paid model).",
              execute: async ({ sessionID, prompt }) => {
                const arg = (prompt?.text ?? "").trim();
                const sessionApi = ctx.session as unknown as {
                  synthetic?: (input: { sessionID: string; text: string }) => unknown;
                  prompt?: (input: { sessionID: string; text: string }) => unknown;
                };
                const note = async (text: string): Promise<void> => {
                  try { await sessionApi.synthetic?.({ sessionID, text }); } catch {}
                };
                const say = async (text: string): Promise<void> => {
                  try { await sessionApi.prompt?.({ sessionID, text }); } catch {}
                };
                const rootPath = arg || defaultDirectory;
                if (!rootPath || !existsSync(rootPath)) {
                  await note(`Path not found: ${rootPath}`);
                  return;
                }
                await note(`Starting deep LLM review over ${rootPath} (no static pass)…`);
                await injectAgentFixFlow(
                  ctx,
                  cfg,
                  sessionID,
                  {
                    mode: "deep",
                    targetLabel: rootPath,
                    targetPath: rootPath,
                    reviewId: null,
                    findings: [],
                  },
                  { note, say },
                );
              },
            });
          }
        });
      } catch (err) {
        console.error(`[code-review] command registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
});

/** Test hooks: unit access without a database. */
export const __test__ = {
  reviewLines,
  reviewFile,
  reviewDiff,
  reviewProject,
  buildRules,
  parseUnifiedDiff,
  compileUserPattern,
  hasNestedQuantifier,
  shadowedDeclarations,
  collectWorkingTreeDiff,
  GIT_DIFF_COMMAND,
  resolveTarget,
  toStoredPath,
  localizeFindings,
  storeReview,
  reviewSummary,
  waitForChildText,
  childLooksIdle,
  findModelByRef,
  resolveConfig,
  RULES,
  walkDir,
  formatReviewResult,
  computeStats,
  readTrendReport,
  renderTrendReport,
  persistReview,
  loadReviewFindings,
  listAvailableModels,
  pickFreeModel,
  pickCheapestModel,
  resolveAgentModels,
  buildAgentTaskBrief,
  injectAgentFixFlow,
  runDirectSpawn,
  groupFindingsByFile,
  parseModelRef,
  assistantTextOf,
};
