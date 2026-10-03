import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyPragmas, type AnyDatabase } from "../lib/sqlite.ts";
import { envStr, asInt } from "../lib/config.ts";
import { registerCommand } from "../lib/command-registry.ts";

/**
 * deep-research
 *
 * Autonomous multi-agent research, in the spirit of ChatGPT's Deep Research.
 *
 * How it works:
 *   1. PLAN      — the topic is fanned out across a fixed taxonomy of research
 *                  ANGLES (definition, current state, alternatives, risks,
 *                  evidence, prior art, economics, constraints, adoption,
 *                  benchmarks). Each angle becomes one independent brief.
 *   2. FAN OUT   — every brief runs as its own real child session, in
 *                  parallel, briefed with a strict output contract so the
 *                  results parse reliably.
 *   3. COLLECT   — each child is polled until it goes idle or hits its
 *                  deadline (interrupted, never abandoned mid-burn), and its
 *                  findings are parsed into structured claims.
 *   4. ITERATE   — children report the gaps they hit; those become the next
 *                  round's briefs, deduplicated against what is already
 *                  covered, until the round or child budget runs out.
 *   5. SYNTHESISE— the collected claims are deduped, ranked, and conflicting
 *                  claims flagged, then handed back to the parent session so
 *                  the model writes the narrative report. The digest is also
 *                  written to disk and stored in SQLite for later recall.
 *
 * The orchestration (fan-out, budgets, deadlines, collection, dedup) is
 * deterministic code; the actual research and the final narrative are done by
 * the model. Nothing here assumes a particular model or provider.
 */

const DB_NAME = "deep-research.db";

type Depth = "quick" | "standard" | "deep";

type Budget = {
  /** Angles fanned out in the first round. */
  fanout: number;
  /** Hard ceiling on child sessions across all rounds. */
  maxChildren: number;
  /** Gap-driven follow-up rounds after the first. */
  maxRounds: number;
  /** Per-child wall clock before we interrupt it. */
  perChildSec: number;
  /** Whole-run wall clock. */
  totalSec: number;
};

const BUDGETS: Record<Depth, Budget> = {
  quick: { fanout: 4, maxChildren: 6, maxRounds: 1, perChildSec: 180, totalSec: 420 },
  standard: { fanout: 7, maxChildren: 14, maxRounds: 2, perChildSec: 300, totalSec: 1200 },
  deep: { fanout: 10, maxChildren: 24, maxRounds: 3, perChildSec: 480, totalSec: 3000 },
};

/** How many taxonomy angles a depth covers, used by inline mode. */
const budgetAngleCount = (depth: Depth): number => BUDGETS[depth].fanout;

/**
 * The angle taxonomy. Deterministic by design: it guarantees breadth without
 * spending a model turn on decomposition, and every angle is a genuinely
 * different way to attack a topic rather than a reworded question.
 */
const ANGLES: Array<{ id: string; brief: string }> = [
  { id: "definition", brief: "What exactly is it, how is it defined, and what does it explicitly exclude?" },
  { id: "current-state", brief: "How does this work today in practice, and what is the current mainstream approach?" },
  { id: "alternatives", brief: "What are the credible alternatives, and how do they compare on the dimensions that matter?" },
  { id: "risks", brief: "What are the main risks, failure modes, and known problems? Include what breaks under load or at scale." },
  { id: "evidence", brief: "What evidence, data, or measurements support the claims? Separate measured facts from assertions." },
  { id: "prior-art", brief: "What prior art, related work, or adjacent fields have solved part of this, and what can be borrowed?" },
  { id: "economics", brief: "What does it cost — money, time, compute, or engineering effort — and how does that scale?" },
  { id: "constraints", brief: "What are the hard constraints: legal, regulatory, technical, organisational, or ecosystem?" },
  { id: "adoption", brief: "Who is actually using this, at what scale, and what does adoption look like in the wild?" },
  { id: "benchmarks", brief: "What benchmarks, metrics, or evaluations exist, and what would a good score look like?" },
];

type Claim = {
  angle: string;
  text: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
};

type ChildResult = {
  angle: string;
  brief: string;
  claimCount: number;
  claims: Claim[];
  summary: string;
  gaps: string[];
  ok: boolean;
  error?: string;
  ms: number;
};

type RunRow = {
  id: string;
  topic: string;
  depth: Depth;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
  rounds: number;
  children: number;
  claims: number;
  reportPath: string | null;
  summary: string;
};

/* ------------------------------------------------------------------ config */

type Config = {
  enabled: boolean;
  dir: string;
  maxConcurrent: number;
  /** Explicit "provider/model" override for research children. */
  model?: string;
};

function defaultDir(): string {
  const home = homedir();
  return process.platform === "win32"
    ? join(process.env.USERPROFILE ?? home, ".opencode-plugins", "deep-research")
    : join(home, ".opencode-plugins", "deep-research");
}

function loadConfig(raw?: Record<string, unknown>): Config {
  const o = raw ?? {};
  return {
    enabled: process.env.OPENCODE_DEEP_RESEARCH_ENABLED !== "0",
    dir: typeof o.dir === "string" && o.dir ? o.dir : envStr("OPENCODE_DEEP_RESEARCH_DIR") ?? defaultDir(),
    maxConcurrent: Math.min(
      8,
      Math.max(1, asInt(o.maxConcurrent, asInt(envStr("OPENCODE_DEEP_RESEARCH_CONCURRENCY"), 4))),
    ),
    model: (typeof o.model === "string" && o.model) || envStr("OPENCODE_DEEP_RESEARCH_MODEL") || undefined,
  };
}

/* ------------------------------------------------------------------ schema */

function initSchema(db: AnyDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deep_research_runs (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      depth TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      rounds INTEGER NOT NULL DEFAULT 0,
      children INTEGER NOT NULL DEFAULT 0,
      claims INTEGER NOT NULL DEFAULT 0,
      report_path TEXT,
      summary TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_dr_started ON deep_research_runs(started_at DESC);
  `);
  // Additive migrations for databases created by older versions.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(deep_research_runs)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  for (const [name, decl] of [
    ["rounds", "INTEGER NOT NULL DEFAULT 0"],
    ["children", "INTEGER NOT NULL DEFAULT 0"],
    ["claims", "INTEGER NOT NULL DEFAULT 0"],
    ["report_path", "TEXT"],
    ["summary", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE deep_research_runs ADD COLUMN ${name} ${decl}`);
      } catch {
        /* concurrent open already added it */
      }
    }
  }
}

/* --------------------------------------------------------------- utilities */

const log = (msg: string): void => {
  console.error(`[deep-research] ${msg}`);
};

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function assistantTextOf(message: unknown): string {
  if (typeof message === "string") return message.trim();
  const m = (message ?? {}) as Record<string, unknown>;

  // Content may be a plain string, an array of typed parts, a single part, or
  // absent while the text lives under `parts`/`text` instead. Being strict here
  // made every real assistant message read as empty.
  const collect = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") {
            const po = p as Record<string, unknown>;
            if (typeof po.text === "string") return po.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    if (content && typeof content === "object") {
      const co = content as Record<string, unknown>;
      if (typeof co.text === "string") return co.text.trim();
    }
    return "";
  };

  return collect(m.content) || collect(m.parts) || (typeof m.text === "string" ? m.text.trim() : "");
}

function newestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { type?: string };
    if (m?.type !== "assistant") continue;
    const text = assistantTextOf(m);
    if (text) return text;
  }
  return "";
}

/**
 * Normalise whatever session.context() returned into a message array.
 *
 * Hosts differ: some return the array directly, others wrap it as
 * {messages: [...]} or {data: [...]}. Treating a non-array as "no output"
 * (the previous behaviour) made every child look like it had produced nothing
 * for its entire deadline.
 */
function extractMessages(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["messages", "data", "items", "parts"]) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/** Short description of an unexpected shape, for failure reporting. */
function describeShape(raw: unknown): string {
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (raw && typeof raw === "object") {
    return `object{${Object.keys(raw as Record<string, unknown>).slice(0, 6).join(",")}}`;
  }
  return typeof raw;
}

/** Best-effort idle detection; unknown shapes simply mean "keep waiting". */
function looksIdle(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const o = info as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status.toLowerCase() : "";
  if (status === "idle" || status === "completed" || status === "done") return true;
  const time = o.time as { completed?: unknown } | undefined;
  if (time && typeof time === "object" && typeof time.completed === "number") return true;
  return false;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "how", "does", "are", "was",
  "into", "their", "they", "them", "its", "his", "her", "our", "your", "have", "has", "had",
  "about", "which", "when", "where", "who", "why", "can", "will", "would", "should", "could",
]);

/** Content words of a question, used to dedup overlapping follow-up briefs. */
function keywords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9+]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard overlap — above the threshold we treat two briefs as the same. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/* ------------------------------------------------------------------ prompts */

function childBrief(topic: string, angle: { id: string; brief: string }, round: number): string {
  return [
    `You are one member of a deep-research team investigating: ${topic}`,
    "",
    `Your assigned angle — ${angle.id}:`,
    angle.brief,
    round > 0
      ? "This is a follow-up round. Go deeper than the obvious answer, and resolve the specific gap you were pointed at."
      : "",
    "",
    "Work independently and autonomously. Use your tools to actually investigate rather than relying on recall alone.",
    "Prefer primary sources. If you cannot verify something, say so explicitly rather than asserting it.",
    "",
    "Return your findings in EXACTLY this format and nothing else after it:",
    "",
    "FINDINGS:",
    '<json array>["{\\"angle\\":\\"' + angle.id + '\\",\\"text\\":\\"one specific claim\\",\\"evidence\\":\\"source, measurement, or why this is well established\\",\\"confidence\\":\\"high|medium|low\\"}"]</json array>',
    "",
    "SUMMARY:",
    "Two or three sentences on what you found for this angle.",
    "",
    "GAPS:",
    "- <something you could not resolve, or a question this angle opened that another angle should chase>",
    "- <omit this line entirely if you had no gaps>",
    "",
    `Aim for 3-8 findings. Be specific and non-generic; every finding must be something you would defend.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function synthesisPrompt(
  topic: string,
  depth: Depth,
  digest: string,
  stats: { children: number; claims: number; rounds: number; failures: number },
): string {
  return [
    `Deep research complete for: **${topic}**`,
    "",
    `A team of ${stats.children} research agents worked this topic across ${stats.rounds} round(s) and produced ${stats.claims} findings` +
      (stats.failures > 0 ? ` (${stats.failures} agent(s) failed or timed out)` : "") +
      `.`,
    "",
    "Below is the deduplicated, evidence-annotated digest of their findings. Conflicts between agents are marked.",
    "",
    "---",
    digest,
    "---",
    "",
    "Write the final report. Requirements:",
    "- Open with a direct 3-5 sentence answer to the question, not a preamble.",
    "- Organise by theme, not by which agent found what.",
    "- Cite the evidence inline for every substantive claim; where agents disagree, present the disagreement rather than silently picking a side.",
    "- State clearly what could not be established, and what would need to be checked to settle it.",
    "- No filler, no restating the digest's structure. This is depth=" + depth + " — write to that standard.",
    "",
    "Then add a short `## Open questions` section listing the gaps the agents reported.",
  ].join("\n");
}

/* ------------------------------------------------------------------- parsing */

/** Pull the structured findings out of a child reply, tolerating noise. */
function parseChild(text: string, angle: { id: string; brief: string }, ms: number): ChildResult {
  const result: ChildResult = {
    angle: angle.id,
    brief: angle.brief,
    claimCount: 0,
    claims: [],
    summary: "",
    gaps: [],
    ok: false,
    ms,
  };
  if (!text.trim()) {
    result.error = "no assistant text";
    return result;
  }

  const summary = text.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*GAPS:|$)/i);
  if (summary) result.summary = summary[1]!.trim();

  const gapsBlock = text.match(/GAPS:\s*([\s\S]*)$/i);
  if (gapsBlock) {
    result.gaps = gapsBlock[1]!
      .split("\n")
      .map((l) => l.replace(/^[\s\-*·]+/, "").trim())
      .filter((l) => l.length > 8)
      .slice(0, 6);
  }

  // Findings: prefer the fenced json array, then any bracketed array.
  const fenced = text.match(/<json array>\s*(\[[\s\S]*?\])\s*<\/json array>/i);
  const raw = fenced?.[1] ?? text.match(/(\[\s*\{[\s\S]*?\}\s*\])/)?.[1];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          const text_ = String(e.text ?? e.claim ?? "").trim();
          if (!text_) continue;
          const conf = String(e.confidence ?? "").toLowerCase();
          result.claims.push({
            angle: angle.id,
            text: text_,
            evidence: String(e.evidence ?? "").trim(),
            confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "medium",
          });
        }
      }
    } catch {
      /* fall through to the prose fallback below */
    }
  }

  // Prose fallback: a child that ignored the contract still contributed text.
  if (result.claims.length === 0) {
    const prose = text
      .replace(/<json array>[\s\S]*?<\/json array>/gi, "")
      .replace(/^(FINDINGS|SUMMARY|GAPS)\s*:?\s*$/gim, "")
      .trim();
    const lines = prose
      .split("\n")
      .map((l) => l.replace(/^[\s\-*·]+\s*/, "").trim())
      .filter((l) => l.length > 24);
    // Only trust prose if it has some shape to it, not a stray sentence.
    if (lines.length >= 2) {
      for (const l of lines.slice(0, 6)) {
        result.claims.push({ angle: angle.id, text: l, evidence: "", confidence: "low" });
      }
    }
  }

  result.claimCount = result.claims.length;
  result.ok = result.claims.length > 0 || result.summary.length > 0;
  if (!result.ok) result.error = "reply contained no parsable findings";
  return result;
}

/** Dedup claims, flag near-duplicate contradictions, rank by confidence. */
function digestClaims(all: Claim[]): { digest: string; unique: number; conflicts: number } {
  const kept: Claim[] = [];
  for (const c of all) {
    const kw = keywords(c.text);
    const dup = kept.some((k) => overlap(keywords(k.text), kw) > 0.72);
    if (!dup) kept.push(c);
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  kept.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  let conflicts = 0;
  const lines: string[] = [];
  for (const c of kept) {
    const kw = keywords(c.text);
    // A same-angle, high-similarity pair that reads differently is a conflict.
    if (
      c.confidence !== "low" &&
      kept.some(
        (o) =>
          o !== c &&
          o.angle === c.angle &&
          rank[o.confidence] !== rank[c.confidence] &&
          overlap(keywords(o.text), kw) > 0.45 &&
          o.text !== c.text,
      )
    ) {
      conflicts += 1;
      lines.push(`- **[${c.angle}] ${c.text}** (${c.confidence}) ^conflict`);
    } else {
      lines.push(`- **[${c.angle}] ${c.text}** (${c.confidence})${c.evidence ? ` — ${c.evidence}` : ""}`);
    }
  }
  return { digest: lines.join("\n"), unique: kept.length, conflicts };
}

/* --------------------------------------------------------------- child run */

type ChildSpec = { angle: { id: string; brief: string }; prompt: string };

/** Agent/model a child session is created with. */
type Resolved = {
  agent?: string;
  model?: { modelID: string; providerID: string };
};

/**
 * Decide what agent/model the research children run under.
 *
 * An explicit override wins over inheritance: the user asked for a specific
 * model, and inheriting the parent's spends the parent's quota — which is how
 * a 10-agent run died against an exhausted key. Otherwise inherit the parent's
 * model so research costs what the conversation does, then fall back to the
 * first model the host reports.
 */
async function resolveAgentModel(c: any, cfg: Config, parent: ParentInfo): Promise<Resolved> {
  const out: Resolved = {};
  if (parent?.agent) out.agent = String(parent.agent);
  if (cfg.model) {
    const slash = cfg.model.indexOf("/");
    if (slash > 0) {
      out.model = { providerID: cfg.model.slice(0, slash), modelID: cfg.model.slice(slash + 1) };
      return out;
    }
  }
  if (parent?.model?.modelID && parent?.model?.providerID) {
    out.model = { modelID: parent.model.modelID, providerID: parent.model.providerID };
    return out;
  }
  try {
    const list = (await withTimeout(c.model?.list?.(), 10_000, "model.list")) as
      | { data?: Array<Record<string, unknown>> }
      | undefined;
    const first = list?.data?.[0];
    if (first) {
      const raw = String(first.id ?? "");
      const modelID = String(first.modelID ?? raw);
      const providerID = String(first.providerID ?? (raw.includes("/") ? raw.split("/")[0] : ""));
      if (modelID && providerID) out.model = { modelID, providerID };
    }
  } catch {
    /* leave the choice to the host */
  }
  return out;
}

type ParentInfo = {
  model?: { modelID?: string; providerID?: string };
  agent?: string;
};

/**
 * Re-read `config.json` from the plugin dir at the start of each run.
 *
 * Env vars and host plugin config are both read once at setup, so changing
 * which model research uses required restarting opencode. This file is read per
 * run, so pinning research to a free or cheaper model takes effect immediately.
 */
function runtimeOverrides(cfg: Config): Partial<Config> {
  try {
    const path = join(cfg.dir, "config.json");
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Partial<Config> = {};
    if (typeof raw.model === "string" && raw.model) out.model = raw.model;
    if (typeof raw.maxConcurrent === "number" && raw.maxConcurrent > 0) {
      out.maxConcurrent = Math.min(8, Math.max(1, Math.floor(raw.maxConcurrent)));
    }
    return out;
  } catch {
    return {};
  }
}

type ChildHandle = {
  spec: ChildSpec;
  id: string;
  title: string;
};

async function runChild(
  c: any,
  spec: ChildSpec,
  parentID: string,
  deadlineMs: number,
  perChildMs: number,
  resolved: Resolved,
): Promise<ChildResult> {
  const started = Date.now();
  let childID: string;
  try {
    const created = (await withTimeout(
      c.session.create({
        title: `deep-research:${spec.angle.id}`,
        // A child created without an explicit agent/model does not reliably
        // pick one up: the sessions plugin always passes both, and without
        // them the child sits idle and never produces a reply.
        ...(resolved.agent ? { agent: resolved.agent } : {}),
        ...(resolved.model
          ? { model: { id: resolved.model.modelID, providerID: resolved.model.providerID } }
          : {}),
        metadata: { parentSessionID: parentID, spawnedBy: "deep-research" },
      }),
      15_000,
      "session.create",
    )) as { id?: string };
    if (!created?.id) throw new Error("session.create returned no id");
    childID = created.id;
  } catch (err) {
    return {
      angle: spec.angle.id,
      brief: spec.angle.brief,
      claimCount: 0,
      claims: [],
      summary: "",
      gaps: [],
      ok: false,
      error: `create failed: ${String(err)}`,
      ms: Date.now() - started,
    };
  }

  try {
    await withTimeout(
      c.session.prompt({ sessionID: childID, text: spec.prompt }),
      Math.max(1_000, Math.min(perChildMs, deadlineMs - Date.now())),
      "session.prompt",
    );
  } catch (err) {
    log(`child ${spec.angle.id}: prompt failed: ${String(err)}`);
  }

  // Poll until the child goes idle, finishes its reply, or the deadline hits.
  const hardStop = Math.min(deadlineMs, started + perChildMs);
  let text = "";
  let lastLen = -1;
  let stableSince = 0;
  let lastPollError = "";
  let shapeSample = "";
  let consecutivePollErrors = 0;
  while (Date.now() < hardStop) {
    try {
      const info = await withTimeout(c.session.get({ sessionID: childID }), 10_000, "session.get");
      const messages = await withTimeout(
        c.session.context({ sessionID: childID }),
        10_000,
        "session.context",
      );
      consecutivePollErrors = 0;
      text = newestAssistantText(extractMessages(messages));
      // Keep a shape sample so an empty result is diagnosable: whether the
      // child produced nothing, or context() returned a shape we mis-parse.
      if (!text) shapeSample = describeShape(messages);
      if (!text && Array.isArray(messages)) {
        const a = [...messages].reverse().find((m) => (m as { type?: string })?.type === "assistant");
        if (a && typeof a === "object") {
          const keys = Object.keys(a as Record<string, unknown>);
          shapeSample += ` | assistant keys: ${keys.slice(0, 10).join(",")}`;
          for (const k of keys.slice(0, 10)) {
            const v = (a as Record<string, unknown>)[k];
            shapeSample += ` [${k}=${Array.isArray(v) ? "array" + v.length : typeof v}]`;
          }
        }
      }
      // A child is done when it emits the contract's GAPS: section, or the
      // host reports it idle. Empty output is NOT done — a freshly prompted
      // child has not produced anything yet, and treating that as completion
      // made every child exit on its first poll and return nothing.
      const looksDone = /\bGAPS\s*:/i.test(text);
      // A just-prompted child can report idle before work starts, so give the
      // status probe a grace period before trusting it.
      if (looksDone || (Date.now() - started > 2_000 && looksIdle(info))) break;
      // Growing text that has stopped moving is a reasonable secondary exit,
      // but only after it has been stable for a few polls.
      if (text.length === lastLen && text.length > 0) {
        if (stableSince === 0) stableSince = Date.now();
        else if (Date.now() - stableSince > 15_000) break;
      } else {
        stableSince = 0;
      }
      lastLen = text.length;
    } catch (err) {
      // A child that has only just been prompted commonly rejects the first
      // context reads. Breaking here discarded every agent within a second and
      // orphaned the sessions, so keep polling until the deadline instead and
      // only give up if the reads keep failing outright.
      lastPollError = String(err);
      consecutivePollErrors += 1;
      if (consecutivePollErrors === 1) {
        log(`child ${spec.angle.id}: poll failed, retrying: ${lastPollError}`);
      }
      if (consecutivePollErrors > 8) break;
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (Date.now() >= hardStop) {
    // Never leave a child burning tokens past its budget.
    try {
      await withTimeout(c.session.interrupt({ sessionID: childID }), 8_000, "session.interrupt");
      log(`child ${spec.angle.id}: deadline reached, interrupted`);
    } catch {
      /* best effort */
    }
  }

  const parsed = parseChild(text, spec.angle, Date.now() - started);
  // Surface why a child produced nothing: a bare "no assistant text" hides
  // whether the session never started, the reads failed, or the model ignored
  // the output contract.
  if (!parsed.ok) {
    const extra = [lastPollError ? `poll error: ${lastPollError}` : "", shapeSample]
      .filter(Boolean)
      .join(" | ");
    parsed.error = `${parsed.error ?? "no findings"}${extra ? ` (${extra})` : ""}`;
  }
  return parsed;
}

/** Run a batch with a concurrency ceiling, aborting cleanly on cancellation. */
async function runBatch(
  c: any,
  specs: ChildSpec[],
  parentID: string,
  deadlineMs: number,
  perChildMs: number,
  limit: number,
  resolved: Resolved,
): Promise<ChildResult[]> {
  const out: ChildResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, specs.length)) }, async () => {
    while (next < specs.length) {
      if (Date.now() >= deadlineMs) return;
      const spec = specs[next++]!;
      out.push(await runChild(c, spec, parentID, deadlineMs, perChildMs, resolved));
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ storage */

function storeRun(db: AnyDatabase, row: RunRow): void {
  db.prepare(
    `INSERT INTO deep_research_runs
       (id, topic, depth, status, started_at, finished_at, rounds, children, claims, report_path, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       finished_at = excluded.finished_at,
       rounds = excluded.rounds,
       children = excluded.children,
       claims = excluded.claims,
       report_path = excluded.report_path,
       summary = excluded.summary`,
  ).run(
    row.id,
    row.topic,
    row.depth,
    row.status,
    row.startedAt,
    row.finishedAt,
    row.rounds,
    row.children,
    row.claims,
    row.reportPath,
    row.summary,
  );
}

/** Filesystem-safe folder name for a topic. */
function topicSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/**
 * Research lives under the project's docs/research/<topic>/, not in the plugin
 * data dir, so findings sit next to the code they concern and can be committed.
 * Every level is created on demand: the user should not have to pre-create
 * docs/, research/, or the topic folder.
 */
function researchRoot(c: any): string {
  // ctx.location.directory is the project's root (the shape codebase-index and
  // session-export use). ctx.directory is not part of the API, so reading it
  // silently fell through to process.cwd() and wrote into the home directory.
  const candidates = [c?.location?.directory, c?.app?.path?.cwd, c?.project?.root];
  const base =
    candidates.find((v) => typeof v === "string" && v.trim().length > 0) ?? process.cwd();
  return join(base, "docs", "research");
}

function topicDir(c: any, topic: string): string {
  return join(researchRoot(c), topicSlug(topic));
}

const FINDINGS_FILE = "findings.md";
const DELIBERATION_FILE = "deliberation.md";
const REPORT_FILE = "report.md";

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** How many questions are already in a deliberation log. */
function countQuestions(deliberation: string): number {
  return (deliberation.match(/^### Q\d+:/gm) ?? []).length;
}

function appendDeliberation(c: any, topic: string, block: string): string {
  const dir = topicDir(c, topic);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DELIBERATION_FILE);
  const existing = readIfExists(path);
  writeFileSync(path, (existing ?? `# Deliberation: ${topic}\n\n`) + block, "utf8");
  return path;
}

function writeReport(
  cfg: Config,
  runId: string,
  topic: string,
  depth: Depth,
  results: ChildResult[],
  digest: string,
  stats: { children: number; claims: number; rounds: number; failures: number; ms: number },
): string {
  mkdirSync(cfg.dir, { recursive: true });
  const path = join(cfg.dir, `${runId}.md`);
  const lines: string[] = [
    `# Deep research: ${topic}`,
    "",
    `- run: \`${runId}\``,
    `- depth: ${depth}`,
    `- agents: ${stats.children} across ${stats.rounds} round(s)`,
    `- findings: ${stats.claims} (${stats.failures} agent failure(s))`,
    `- elapsed: ${Math.round(stats.ms / 1000)}s`,
    "",
    "## Findings",
    "",
    digest || "_No findings were returned._",
    "",
    "## Per-agent summaries",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.angle}`);
    lines.push("");
    lines.push(`*Brief:* ${r.brief}`);
    lines.push("");
    if (r.ok) {
      if (r.summary) lines.push(r.summary);
      for (const g of r.gaps) lines.push(`- gap: ${g}`);
    } else {
      lines.push(`_Failed: ${r.error ?? "unknown"}_`);
    }
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

/**
 * Write the same digest into the project's docs/research/<topic>/ as
 * findings.md, creating docs/, research/ and the topic folder as needed.
 */
function writeTopicFindings(
  c: any,
  topic: string,
  depth: Depth,
  results: ChildResult[],
  digest: string,
  stats: { children: number; claims: number; rounds: number; failures: number; ms: number },
): string {
  const dir = topicDir(c, topic);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FINDINGS_FILE);
  const lines: string[] = [
    `# Findings: ${topic}`,
    "",
    `- depth: ${depth}`,
    `- mode: ${stats.children > 0 ? `parallel (${stats.children} agents, ${stats.rounds} round(s))` : "inline"}`,
    `- findings: ${stats.claims} (${stats.failures} agent failure(s))`,
    `- generated: ${new Date().toISOString()}`,
    "",
    "## Findings",
    "",
    digest || "_No findings were returned._",
    "",
    "## Per-agent detail",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.angle}`, "", `*Angle:* ${r.brief}`, "");
    if (r.ok) {
      if (r.summary) lines.push(r.summary, "");
      for (const g of r.gaps) lines.push(`- gap: ${g}`);
      if (!r.gaps.length) lines.push("- no gaps reported");
    } else {
      lines.push(`_Failed: ${r.error ?? "unknown"}_`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "",
    "Ask follow-up questions with `deep_research_deliberate`; they and their answers are",
    "recorded in deliberation.md. Then `deep_research_consolidate` merges both into report.md.",
    "",
  );
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

/* -------------------------------------------------------------------- plugin */

export default Plugin.define({
  id: "deep-research",
  async setup(c: any) {
    const cfg = loadConfig(
      (await (c as { config?: () => Promise<Record<string, unknown>> }).config?.()) ?? undefined,
    );
    if (!cfg.enabled) {
      log("disabled via OPENCODE_DEEP_RESEARCH_ENABLED=0");
      return;
    }

    mkdirSync(cfg.dir, { recursive: true });
    let db: AnyDatabase | null = null;
    const getDb = (): AnyDatabase => {
      if (db) return db;
      db = openDatabase(join(cfg.dir, DB_NAME));
      applyPragmas(db);
      initSchema(db);
      return db;
    };

    const cancelled = new Set<string>();

    const inlineBrief = (topic: string, depth: Depth): string => {
      const n = Math.min(budgetAngleCount(depth), ANGLES.length);
      return [
        `Deep research brief: **${topic}**`,
        "",
        `Work through these ${n} angles in order, in this session. Use your tools to actually investigate`,
        "rather than answering from recall, and prefer primary sources. For each angle, state what you",
        "established, what evidence supports it, and what you could not resolve.",
        "",
        ...ANGLES.slice(0, n).map((a, i) => `${i + 1}. **${a.id}** — ${a.brief}`),
        "",
        "Finish with a section `## Open questions` listing everything you could not establish and what",
        "would be needed to settle it. Cite evidence inline for every substantive claim, and where sources",
        "disagree, present the disagreement rather than picking a side.",
        "",
        `Depth: ${depth}. Write to that standard.`,
      ].join("\n");
    };

    const orchestrator = async (
      topic: string,
      depth: Depth,
      parentID: string,
      parentInfo?: ParentInfo,
    ): Promise<{ runId: string; text: string; claims: number; failureDetail: string }> => {
      const budget = BUDGETS[depth];
      const runId = randomUUID().replace(/-/g, "").slice(0, 8);
      const startedAt = Date.now();
      const deadline = startedAt + budget.totalSec * 1000;
      // Resolve once per run so every child is comparable and the model list is
      // not re-fetched per agent.
      // Resolve once per run so every child is comparable and the model list is
      // not re-fetched per agent. A config.json override is applied here so the
      // model can be changed without restarting the host.
      const rcfg: Config = { ...cfg, ...runtimeOverrides(cfg) };
      const resolved = await resolveAgentModel(c, rcfg, parentInfo ?? {});
      log(
        `run ${runId}: children will use ${resolved.model ? `${resolved.model.providerID}/${resolved.model.modelID}` : "host default"}`,
      );
      storeRun(getDb(), {
        id: runId,
        topic,
        depth,
        status: "running",
        startedAt,
        finishedAt: null,
        rounds: 0,
        children: 0,
        claims: 0,
        reportPath: null,
        summary: "",
      });
      log(`run ${runId} start: ${JSON.stringify(topic)} depth=${depth}`);

      const results: ChildResult[] = [];
      const covered: Set<string>[] = [];
      let childrenSpawned = 0;

      for (let round = 1; round <= budget.maxRounds; round++) {
        if (cancelled.has(parentID)) break;
        const remaining = budget.maxChildren - childrenSpawned;
        if (remaining <= 0 || Date.now() >= deadline) break;

        // Round 1: fixed taxonomy, truncated to the fan-out budget.
        // Later rounds: gaps the agents reported, deduped against coverage.
        let specs: ChildSpec[];
        if (round === 1) {
          specs = ANGLES.slice(0, Math.min(budget.fanout, remaining)).map((a) => ({
            angle: a,
            prompt: childBrief(topic, a, 1),
          }));
        } else {
          const seen = [...covered];
          const gapAngles: ChildSpec[] = [];
          const gapText: string[] = [];
          for (const r of results) {
            for (const g of r.gaps) {
              const kw = keywords(g);
              if (seen.some((s) => overlap(s, kw) > 0.5)) continue;
              const spec = {
                angle: { id: `${r.angle}#${gapText.length + 1}`, brief: g },
                prompt: childBrief(topic, { id: "gap", brief: g }, round),
              };
              gapAngles.push(spec);
              gapText.push(g);
              covered.push(kw);
              if (gapAngles.length >= Math.min(4, remaining)) break;
            }
            if (gapAngles.length >= Math.min(4, remaining)) break;
          }
          specs = gapAngles;
        }

        if (specs.length === 0) {
          log(`run ${runId}: round ${round} produced no new briefs, stopping`);
          break;
        }

        log(`run ${runId}: round ${round} fanning out ${specs.length} agent(s)`);
        childrenSpawned += specs.length;
        const batch = await runBatch(
          c,
          specs,
          parentID,
          deadline,
          budget.perChildSec * 1000,
          rcfg.maxConcurrent,
          resolved,
        );
        results.push(...batch);
        for (const b of batch) covered.push(keywords(`${b.angle} ${b.brief}`));

        const failures = batch.filter((b) => !b.ok).length;
        log(
          `run ${runId}: round ${round} done — ${batch.length - failures}/${batch.length} ok, ` +
            `${batch.reduce((s, b) => s + b.claimCount, 0)} findings`,
        );
        // A round where nothing worked will not improve with more rounds.
        if (failures === batch.length) break;
      }

      const allClaims = results.flatMap((r) => r.claims);
      const { digest, unique, conflicts } = digestClaims(allClaims);
      const failures = results.filter((r) => !r.ok).length;
      const stats = {
        children: results.length,
        claims: unique,
        rounds: results.length > 0 ? 1 : 0,
        failures,
        ms: Date.now() - startedAt,
      };

      const reportPath = writeReport(cfg, runId, topic, depth, results, digest, stats);
      // Also persist into the project so findings live next to the code, can be
      // committed, and are readable for later deliberation.
      const findingsPath = writeTopicFindings(c, topic, depth, results, digest, stats);
      const headline = `${unique} findings, ${conflicts} conflict(s), ${failures} failure(s)`;
      storeRun(getDb(), {
        id: runId,
        topic,
        depth,
        status: cancelled.has(parentID) ? "cancelled" : "done",
        startedAt,
        finishedAt: Date.now(),
        rounds: Math.max(1, budget.maxRounds === 1 ? 1 : 2),
        children: results.length,
        claims: unique,
        reportPath,
        summary: headline,
      });
      log(`run ${runId} complete: ${headline} in ${Math.round(stats.ms / 1000)}s -> ${reportPath}`);

      const text = synthesisPrompt(topic, depth, digest, {
        children: results.length,
        claims: unique,
        rounds: stats.rounds,
        failures,
      });
      const failureDetail = results
        .filter((r) => !r.ok)
        .map((r) => `- ${r.angle}: ${r.error ?? "unknown"}`)
        .join("\n");
      return { runId, text, claims: unique, failureDetail };
    };

    c.tool?.transform?.(
      async (editor: { add: (t: unknown) => void }) => {
        editor.add({
          name: "deep_research",
          description:
            "Run autonomous multi-agent research on a topic. Fans out to parallel research agents across a taxonomy of angles, iterates on the gaps they report, then hands the synthesised findings back for a written report. Returns a run id and the digest; the final narrative is written into this session.",
          input: z.object({
            topic: z.string().min(3).describe("What to research"),
            depth: z
              .enum(["quick", "standard", "deep"])
              .optional()
              .describe("quick=4 angles, standard=7, deep=10"),
            mode: z
              .enum(["inline", "parallel"])
              .optional()
              .describe(
                "inline (default): this session does the research itself, no child sessions. parallel: fan out to N child sessions, which is the only way to get true concurrency.",
              ),
          }),
          execute: async (input: any, toolCtx: any) => {
            const topic = String(input.topic ?? "").trim();
            const depth = (input.depth ?? "standard") as Depth;
            if (topic.length < 3) return { content: "deep_research failed: topic is too short" };
            const parentID = toolCtx.sessionID;
            const mode = (input.mode ?? "inline") as "inline" | "parallel";
            // Inline mode: no child sessions at all. The brief goes to this
            // session and the model does the work here, which is what the user
            // asked for by default. It cannot be parallel — session.create is
            // the only concurrency primitive the plugin API offers — so the
            // angles are worked in sequence.
            if (mode === "inline") {
              const runId = randomUUID().replace(/-/g, "").slice(0, 8);
              storeRun(getDb(), {
                id: runId,
                topic,
                depth,
                status: "done",
                startedAt: Date.now(),
                finishedAt: Date.now(),
                rounds: 1,
                children: 0,
                claims: 0,
                reportPath: null,
                summary: "inline (no child sessions)",
              });
              // Create the topic folder and seed findings.md so deliberation
              // works for inline runs too — otherwise there is nothing on disk
              // to question.
              const dir = topicDir(c, topic);
              mkdirSync(dir, { recursive: true });
              const n = budgetAngleCount(depth);
              writeFileSync(
                join(dir, FINDINGS_FILE),
                [
                  "# Findings: " + topic,
                  "",
                  "- depth: " + depth,
                  "- mode: inline (researched in this session, no child agents)",
                  "- generated: " + new Date().toISOString(),
                  "",
                  "## Angles covered",
                  "",
                  ...ANGLES.slice(0, n).map((a, i) => (i + 1) + ". **" + a.id + "** — " + a.brief),
                  "",
                  "## Findings",
                  "",
                  "_Pending: the answer for this topic has not been written to this file yet._",
                  "",
                  "Ask follow-up questions with `deep_research_deliberate`; they and their answers are",
                  "recorded in deliberation.md. Then `deep_research_consolidate` merges both into report.md.",
                  "",
                ].join("\n"),
                "utf8",
              );
              await c.session.prompt({ sessionID: parentID, text: inlineBrief(topic, depth) });
              return {
                content: [
                  `deep research brief delivered: ${runId}`,
                  `topic: ${topic}`,
                  `depth: ${depth} · mode: inline (no child sessions created)`,
                  "",
                  "The research brief is in this session. Answer it here — angles are worked in sequence,",
                  "since parallel agents require separate sessions.",
                ].join("\n"),
              };
            }
            try {
              const { runId, text, claims, failureDetail } = await orchestrator(topic, depth, parentID, {
                model: toolCtx?.model,
                agent: toolCtx?.agent,
              });
              // Handing the session an empty digest produces a confident report
              // with nothing behind it. Report the failure instead.
              if (claims === 0) {
                return {
                  content: [
                    `deep research produced no findings: ${runId}`,
                    `topic: ${topic}`,
                    "",
                    "Per-agent results:",
                    failureDetail || "(none recorded)",
                    "",
                    `No findings were handed to this session. Report: ${join(cfg.dir, runId + ".md")}`,
                  ].join("\n"),
                };
              }
              await c.session.prompt({ sessionID: parentID, text });
              return {
                content: [
                  `deep research complete: ${runId}`,
                  `topic: ${topic}`,
                  `depth: ${depth}`,
                  "",
                  "The findings have been handed to this session for the final write-up.",
                ].join("\n"),
              };
            } catch (err) {
              log(`failed: ${String(err)}`);
              return { content: `deep_research failed: ${String(err)}` };
            }
          },
        });

        editor.add({
          name: "deep_research_deliberate",
          description:
            "Ask a follow-up question about a research topic. The question is recorded in the topic folder and answered against the stored findings; record the answer with deep_research_answer so the discussion accumulates.",
          input: z.object({
            topic: z.string().min(3).describe("The research topic, matching the original run"),
            question: z.string().min(3).describe("What you want to know about the findings"),
          }),
          execute: async (input: any, toolCtx: any) => {
            const topic = String(input.topic ?? "").trim();
            const question = String(input.question ?? "").trim();
            const dir = topicDir(c, topic);
            const findings = readIfExists(join(dir, FINDINGS_FILE));
            if (!findings) {
              return {
                content:
                  'No findings for "' +
                  topic +
                  '" at ' +
                  join(dir, FINDINGS_FILE) +
                  ". Run deep_research for this topic first.",
              };
            }
            const n = countQuestions(readIfExists(join(dir, DELIBERATION_FILE)) ?? "");
            appendDeliberation(c, topic, "### Q" + (n + 1) + ": " + question + "\n\n_(awaiting answer)_\n\n");
            await c.session.prompt({
              sessionID: toolCtx.sessionID,
              text: [
                "The user is questioning the deep-research findings on: " + topic,
                "",
                "Their question:",
                question,
                "",
                "Answer it from the findings below. Where the findings do not settle it, say so and say",
                "what would settle it. Do not fill the gap with recall presented as evidence.",
                "",
                "Then record your answer with:",
                "deep_research_answer({ topic: " +
                  JSON.stringify(topic) +
                  ", question: " +
                  JSON.stringify(question) +
                  ', answer: "<your answer>" })',
                "",
                "--- findings.md ---",
                findings,
              ].join("\n"),
            });
            return {
              content:
                "Question recorded as Q" +
                (n + 1) +
                " in " +
                join(dir, DELIBERATION_FILE) +
                " and sent to this session for answering.",
            };
          },
        });

        editor.add({
          name: "deep_research_answer",
          description:
            "Record the answer to a deep_research_deliberate question, so the Q&A lands in the topic folder.",
          input: z.object({ topic: z.string().min(3), question: z.string().min(3), answer: z.string().min(1) }),
          execute: async (input: any) => {
            const topic = String(input.topic ?? "").trim();
            const question = String(input.question ?? "").trim();
            const answer = String(input.answer ?? "").trim();
            const path = join(topicDir(c, topic), DELIBERATION_FILE);
            const existing = readIfExists(path);
            if (existing === null) {
              return { content: "No deliberation log for " + topic + " at " + path + "." };
            }
            const idx = existing.indexOf(question);
            if (idx >= 0) {
              // Replace the placeholder under the matching question heading.
              const head = existing.lastIndexOf("### Q", idx);
              const after = existing.indexOf("_(awaiting answer)_", idx);
              if (head >= 0 && after >= 0) {
                const end = after + "_(awaiting answer)_".length;
                const updated = existing.slice(0, after) + answer + existing.slice(end);
                writeFileSync(path, updated, "utf8");
                return { content: "Answer recorded in " + path + "." };
              }
            }
            writeFileSync(path, existing + "\n" + answer + "\n\n", "utf8");
            return { content: "Answer appended to " + path + "." };
          },
        });

        editor.add({
          name: "deep_research_consolidate",
          description:
            "Merge a topic's findings and its deliberation Q&A into one report.md in the topic folder. Send the brief, then write the file with deep_research_write_report.",
          input: z.object({ topic: z.string().min(3) }),
          execute: async (input: any, toolCtx: any) => {
            const topic = String(input.topic ?? "").trim();
            const dir = topicDir(c, topic);
            const findings = readIfExists(join(dir, FINDINGS_FILE));
            if (!findings) {
              return { content: "No findings for " + topic + " at " + join(dir, FINDINGS_FILE) + "." };
            }
            const deliberation = readIfExists(join(dir, DELIBERATION_FILE)) ?? "_No questions asked yet._";
            await c.session.prompt({
              sessionID: toolCtx.sessionID,
              text: [
                'Consolidate the deep research on "' + topic + '" into a single report.',
                "",
                "Write it with:",
                "deep_research_write_report({ topic: " +
                  JSON.stringify(topic) +
                  ', report: "<the full markdown report>" })',
                "",
                "Fold the answers into the narrative rather than appending a Q&A appendix. Where the",
                "findings and a later answer disagree, show the disagreement. End with what is still open.",
                "",
                "--- findings.md ---",
                findings,
                "",
                "--- deliberation.md ---",
                deliberation,
              ].join("\n"),
            });
            return {
              content:
                "Consolidation brief sent to this session. Write the result with deep_research_write_report.",
            };
          },
        });

        editor.add({
          name: "deep_research_write_report",
          description: "Write the consolidated report.md for a research topic.",
          input: z.object({ topic: z.string().min(3), report: z.string().min(20) }),
          execute: async (input: any) => {
            const topic = String(input.topic ?? "").trim();
            const report = String(input.report ?? "").trim();
            const dir = topicDir(c, topic);
            mkdirSync(dir, { recursive: true });
            const path = join(dir, REPORT_FILE);
            const body = report.startsWith("#") ? report : "# Research report: " + topic + "\n\n" + report;
            writeFileSync(path, body.endsWith("\n") ? body : body + "\n", "utf8");
            return { content: "Report written to " + path + "." };
          },
        });

        editor.add({
          name: "deep_research_runs",
          description: "List recent deep-research runs, newest first, with their status and report paths.",
          input: z.object({ limit: z.number().int().positive().max(50).optional() }),
          execute: async (input: any) => {
            try {
              const limit = Math.min(50, Math.max(1, Number(input.limit ?? 10)));
              const rows = getDb()
                .prepare(
                  `SELECT id, topic, depth, status, started_at, finished_at, children, claims, report_path, summary
                   FROM deep_research_runs ORDER BY started_at DESC LIMIT ?`,
                )
                .all(limit) as Array<Record<string, unknown>>;
              if (rows.length === 0) return { content: "No deep-research runs recorded yet." };
              const lines = rows.map((r) => {
                const secs =
                  typeof r.finished_at === "number"
                    ? `${Math.round((r.finished_at - Number(r.started_at)) / 1000)}s`
                    : "—";
                return [
                  `## ${r.id} · ${r.status}`,
                  `topic: ${r.topic}`,
                  `depth: ${r.depth} · agents: ${r.children} · claims: ${r.claims} · ${secs}`,
                  r.report_path ? `report: ${r.report_path}` : "",
                  r.summary ? `summary: ${r.summary}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
              });
              return { content: lines.join("\n\n") };
            } catch (err) {
              return { content: `deep_research_runs failed: ${String(err)}` };
            }
          },
        });
      },
    );

    c.tool?.hook?.("chat.message", async (event: any, output: any) => {
      const parentID = event?.properties?.sessionID;
      const text = String(output?.text ?? "");
      if (parentID && /^\s*\/?cancel-research\b/i.test(text)) cancelled.add(parentID);
    });

    registerCommand("deep-research", {
      description:
        "Autonomous multi-agent research on a topic. Usage: /deep-research <topic> [depth=quick|standard|deep]",
      requires: [],
      build: (args) => {
        const raw = args.trim();
        if (!raw) {
          return [
            "The user invoked `/deep-research` with no topic.",
            "",
            "Ask them what to research, then call the `deep_research` tool with that topic.",
            "Suggest appending `depth=quick|standard|deep` (standard if they do not say).",
          ].join("\n");
        }
        const m = raw.match(
          /^(.*?)(?:\s+depth\s*=\s*(quick|standard|deep))?(?:\s+mode\s*=\s*(inline|parallel))?$/is,
        );
        const topic = (m?.[1] ?? raw).trim();
        const depth = m?.[2] ?? "standard";
        const mode = m?.[3] ?? "inline";
        return [
          `The user wants deep research on this topic:`,
          "",
          topic,
          "",
          `Call the \`deep_research\` tool with topic=${JSON.stringify(topic)}, depth=${JSON.stringify(depth)} and mode=${JSON.stringify(mode)}.`,
          mode === "parallel"
            ? "Use mode=parallel: the tool dispatches research agents in parallel child sessions and returns their findings for you to synthesise."
            : "Use mode=inline: answer the research brief yourself in this session, working the angles in sequence. Do not spawn child sessions.",
          "Do not answer from memory.",
        ].join("\n");
      },
    });

    log("ready (tools: deep_research, deep_research_runs; command: /deep-research)");
  },
});