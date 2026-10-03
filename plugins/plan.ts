import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { execSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as os from "node:os";

/**
 * plan
 *
 * Registers a `/plan` command that guides the agent through a thorough
 * planning phase before execution, with full persistence and resumability.
 *
 * Workflow:
 *   1. The agent researches the task (web search for best practices)
 *   2. The agent asks the user clarifying questions
 *   3. The agent presents a detailed end-to-end plan
 *   4. Once the user approves, the agent spawns child sessions to execute
 *      - Prefers free ("go") models first
 *      - Falls back to paid ("zen") models if no free ones are available
 *
 * State lives in plugin storage keyed by session, so a plan survives a
 * plugin reload and can be resumed. The workflow:
 *
 *   - `/plan <task>`       starts planning; if an existing plan is found,
 *                          the agent is told to resume or replace it
 *   - `/plan status`       shows phase, progress, child sessions, blockers
 *   - `/plan resume`       continues an interrupted execution from storage
 *   - `/plan done`         marks the plan complete
 *   - `/plan clear`        forgets the plan
 *
 * Subcommands are parsed by the plugin (verb dispatch) so the agent receives
 * a single prompt with the appropriate context for each subcommand.
 */

/* ------------------------------------------------------------------ types */

interface RawMessage {
  id?: string;
  role?: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ContextEvent {
  sessionID?: string;
  messages?: RawMessage[];
}

interface ToolEvent {
  sessionID?: string;
  tool?: string;
}

interface EventEnvelope {
  type?: string;
  data?: Record<string, unknown>;
}

interface Disposable {
  dispose?: () => void | Promise<void>;
}

interface PlanCtx {
  options?: Record<string, unknown>;
  storage?: {
    get?: (key: string) => Promise<unknown>;
    set?: (key: string, value: unknown) => Promise<void>;
    remove?: (key: string) => Promise<void>;
  };
  event?: {
    subscribe?: (opts: { signal: AbortSignal }) => AsyncIterable<EventEnvelope>;
  };
  tool?: {
    transform?: (cb: (editor: { add: (def: AnyToolDef) => void }) => void) => Promise<Disposable>;
    hook?: (name: "execute.before", cb: (event: ToolEvent) => void) => Promise<Disposable>;
  };
  session?: {
    hook?: (name: "context", cb: (event: ContextEvent) => void) => Promise<Disposable>;
    prompt?: (input: { sessionID: string; text: string; delivery?: unknown }) => Promise<unknown>;
    synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<RawMessage[]>;
    interrupt?: (input: { sessionID: string }) => Promise<unknown>;
  };
  command?: {
    transform?: (
      cb: (editor: { add: (def: AnyCommandDef) => void }) => void,
    ) => Promise<Disposable>;
  };
}

// The tool/command editors are typed through zod elsewhere; the plugin only
// needs the structural shape here.
type AnyToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: never, toolCtx: { sessionID?: string }) => Promise<{ content: string }>;
};
type AnyCommandDef = {
  name: string;
  description: string;
  execute: (input: {
    sessionID: string;
    prompt?: { text?: string };
    delivery?: unknown;
  }) => Promise<void>;
};

type PlanStatus =
  | "researching"
  | "clarifying"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "paused"
  | "stopped"
  | "complete"
  | "blocked"
  | "failed";

type ChildSessionState = "running" | "pending" | "completed" | "cancelled" | "failed";

type Confidence = "high" | "medium" | "low";

interface ChildSession {
  sessionID: string;
  task: string;
  status: ChildSessionState;
  spawnedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
  confidence: Confidence;
  childSessionID?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  // PL-3: step IDs (was array indices pre-1.2); legacy index rows are
  // migrated by migratePlan() at load time.
  dependsOn?: string[];
  estimatedDurationMin?: number;
  estimatedAt?: number;
  linkedDecisions?: number[];
  linkedErrors?: number[];
  linkedSnippets?: string[];
  isParent?: boolean;
  subSteps?: string[];
  comments?: { text: string; at: number }[];
}

interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  estimatedAt: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualCostUsd?: number;
  estimatedTokens?: number;
  actualTokens?: number;
}

interface PlanVersion {
  version: number;
  timestamp: number;
  steps: PlanStep[];
  planText: string;
  note: string;
}

interface SuccessCriterion {
  id: string;
  description: string;
  metric: string;
  status: "pending" | "passing" | "failing" | "unverifiable";
  result?: string;
  checkedAt?: number;
  attempts: number;
  maxAttempts: number;
}

interface ResearchSource {
  url: string;
  title: string;
  snippet?: string;
  accessedAt: number;
}

interface ResearchResult {
  query: string;
  domain: string;
  summary: string;
  sources: ResearchSource[];
  keyFindings: string[];
  cached: boolean;
  searchedAt: number;
}

type RiskLikelihood = 1 | 2 | 3 | 4 | 5;
type RiskImpact = 1 | 2 | 3 | 4 | 5;
type RiskStatus = "open" | "mitigated" | "accepted" | "realized";

interface Risk {
  id: string;
  description: string;
  likelihood: RiskLikelihood;
  impact: RiskImpact;
  category?: string;
  mitigation?: string;
  contingency?: string;
  status: RiskStatus;
  identifiedAt: number;
  updatedAt: number;
  stepId?: string;
  notes?: string;
}

type PhaseApprovalStatus = "pending" | "approved" | "rejected";
type ExecutionMode = "batch" | "incremental";
type ModelStrategy = "free" | "paid" | "auto" | "fast";

interface PhaseApproval {
  stepId: string;
  stepDescription: string;
  status: PhaseApprovalStatus;
  approvedAt?: number;
  approvedBy?: string;
}

interface Checkpoint {
  id: string;
  stepId: string;
  stepDescription: string;
  timestamp: number;
  summary: string;
  result?: string;
}

interface RollbackState {
  rolledBackAt: number;
  toStep?: number;
  backupBranch: string;
  gitAvailable: boolean;
  // PL-8: the commit SHA recorded before the rollback touched anything.
  fromCommit?: string;
  reason: string;
}

interface PlanState {
  sessionID: string;
  task: string;
  planText: string;
  approvalStatus: "draft" | "approved" | "rejected";
  status: PlanStatus;
  steps: PlanStep[];
  childSessions: ChildSession[];
  partialResults: string[];
  risks: Risk[];
  criteria: SuccessCriterion[];
  insights: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  approvedAt?: number;
  approvedBy?: string;
  completedAt?: number;
  pausedAt?: number;
  // PL-2: stamped on resume; base for the per-run 1h execution timeout so a
  // resumed plan gets a fresh deadline instead of inheriting elapsed time.
  resumedAt?: number;
  stoppedReason?: string;
  blockedReason?: string;
  lastSummary?: string;
  evidence?: string;
  costEstimate?: CostEstimate;
  version: number;
  history: PlanVersion[];
  research?: ResearchResult[];
  phaseApprovals: PhaseApproval[];
  checkpoints: Checkpoint[];
  rollback?: RollbackState;
  executionMode: ExecutionMode;
  modelStrategy: ModelStrategy;
  projects: PlanProject[];
}

interface PlanProject {
  name: string;
  path: string;
  relationship: "dependency" | "related" | "blocks";
}

/* --------------------------------------------------------------- constants */

const STORE_PREFIX = "plan.v1.";
const MARK = "[plan-plugin]";
const REMINDER_SENTINEL = "[plan-plugin:reminder:v1]";

/* ------------------------------------------------------- resource checking */

type ResourceStatus = "ok" | "warning" | "critical";

interface ResourceCheck {
  name: string;
  status: ResourceStatus;
  value: string;
  detail?: string;
}

interface ResourceReport {
  checks: ResourceCheck[];
  missingDeps: string[];
  recommendations: string[];
  hasCritical: boolean;
  timestamp: number;
}

function checkDiskSpace(): ResourceCheck {
  try {
    const cwd = process.cwd();
    const stats = statfsSync(cwd);
    const availableGB = Number((stats.bavail * stats.bsize) / (1024 ** 3)).toFixed(1);
    const totalGB = Number(((stats.blocks * stats.bsize) / (1024 ** 3)).toFixed(1));
    const usedPercent = Number((((stats.blocks - stats.bavail) / stats.blocks) * 100).toFixed(1));
    let status: ResourceStatus = "ok";
    if (usedPercent > 95) status = "critical";
    else if (usedPercent > 85) status = "warning";
    return {
      name: "Disk Space",
      status,
      value: `${availableGB} GB free of ${totalGB} GB (${usedPercent}% used)`,
    };
  } catch {
    return { name: "Disk Space", status: "warning", value: "Unable to determine" };
  }
}

function checkMemory(): ResourceCheck {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const totalGB = Number((totalMem / (1024 ** 3)).toFixed(1));
    const freeGB = Number((freeMem / (1024 ** 3)).toFixed(1));
    const usedPercent = Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1));
    let status: ResourceStatus = "ok";
    if (usedPercent > 95) status = "critical";
    else if (usedPercent > 85) status = "warning";
    return {
      name: "Memory",
      status,
      value: `${freeGB} GB free of ${totalGB} GB (${usedPercent}% used)`,
    };
  } catch {
    return { name: "Memory", status: "warning", value: "Unable to determine" };
  }
}

function checkCpuLoad(): ResourceCheck {
  try {
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const numCpus = cpus.length;
    const load1Min = loadAvg[0];
    const loadPerCpu = numCpus > 0 ? load1Min / numCpus : load1Min;
    let status: ResourceStatus = "ok";
    if (loadPerCpu > 2) status = "critical";
    else if (loadPerCpu > 1) status = "warning";
    return {
      name: "CPU Load",
      status,
      value: `Load average (1m): ${load1Min.toFixed(2)} across ${numCpus} CPUs`,
    };
  } catch {
    return { name: "CPU Load", status: "warning", value: "Unable to determine" };
  }
}

function checkNetwork(): ResourceCheck {
  try {
    // Use a simpler sync check - try to get network interfaces
    const interfaces = os.networkInterfaces();
    const hasInterface = Object.keys(interfaces).some(
      (name) => name !== "lo" && interfaces[name]?.some((addr) => addr && !addr.internal)
    );
    if (hasInterface) {
      return { name: "Network", status: "ok", value: "Network interface available" };
    }
    return { name: "Network", status: "warning", value: "No external network interface detected" };
  } catch {
    return { name: "Network", status: "warning", value: "Unable to determine" };
  }
}

function checkGit(): ResourceCheck {
  try {
    const cwd = process.cwd();
    const gitDir = join(cwd, ".git");
    if (!existsSync(gitDir)) {
      return { name: "Git", status: "warning", value: "Not a git repository" };
    }
    // Check if clean
    try {
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 5000 });
      if (status.trim().length === 0) {
        return { name: "Git", status: "ok", value: "Repository clean" };
      }
      return { name: "Git", status: "warning", value: "Uncommitted changes present" };
    } catch {
      return { name: "Git", status: "warning", value: "Unable to check status" };
    }
  } catch {
    return { name: "Git", status: "warning", value: "Unable to determine" };
  }
}

const REQUIRED_TOOLS = ["node", "npm", "git"];
const OPTIONAL_TOOLS = ["docker", "python3", "go", "rustc"];

// Cache PATH lookups: re-walking PATH for every tool on every resources
// check is wasteful, and PATH rarely changes within a session.
const toolPathCache = new Map<string, boolean>();
function whichCached(tool: string): boolean {
  const hit = toolPathCache.get(tool);
  if (hit !== undefined) return hit;
  let found = false;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, tool), fsConstants.X_OK);
      found = true;
      break;
    } catch {
      /* try next dir */
    }
  }
  toolPathCache.set(tool, found);
  return found;
}

function checkDependencies(): { checks: ResourceCheck[]; missing: string[] } {
  const checks: ResourceCheck[] = [];
  const missing: string[] = [];

  for (const tool of REQUIRED_TOOLS) {
    if (whichCached(tool)) {
      checks.push({ name: `Dependency: ${tool}`, status: "ok", value: "Installed" });
    } else {
      checks.push({ name: `Dependency: ${tool}`, status: "critical", value: "Not installed" });
      missing.push(tool);
    }
  }

  for (const tool of OPTIONAL_TOOLS) {
    if (whichCached(tool)) {
      checks.push({ name: `Dependency: ${tool}`, status: "ok", value: "Installed" });
    } else {
      checks.push({ name: `Dependency: ${tool}`, status: "warning", value: "Not installed (optional)" });
    }
  }

  return { checks, missing };
}

// checkResources spawns git/statfs/etc.; cache the report briefly so
// repeated calls (status renders, events) don't re-run every probe.
let resourcesCache: { at: number; report: ResourceReport } | undefined;
const RESOURCES_CACHE_MS = 30_000;
let gitCache: { at: number; cwd: string; result: ResourceCheck } | undefined;

function checkGitCached(): ResourceCheck {
  const now = Date.now();
  const cwd = process.cwd();
  if (gitCache && gitCache.cwd === cwd && now - gitCache.at < RESOURCES_CACHE_MS) return gitCache.result;
  const result = checkGit();
  gitCache = { at: now, cwd, result };
  return result;
}

function checkResources(): ResourceReport {
  const now = Date.now();
  if (resourcesCache && now - resourcesCache.at < RESOURCES_CACHE_MS) return resourcesCache.report;
  const report = buildResources();
  resourcesCache = { at: now, report };
  return report;
}

function buildResources(): ResourceReport {
  const checks: ResourceCheck[] = [];
  const recommendations: string[] = [];

  // Disk space
  const disk = checkDiskSpace();
  checks.push(disk);
  if (disk.status === "critical") {
    recommendations.push("Free up disk space before starting execution");
  }

  // Memory
  const memory = checkMemory();
  checks.push(memory);
  if (memory.status === "critical") {
    recommendations.push("Close unused applications to free memory");
  }

  // CPU
  const cpu = checkCpuLoad();
  checks.push(cpu);
  if (cpu.status === "critical") {
    recommendations.push("System under heavy load - consider waiting before starting");
  }

  // Network
  const network = checkNetwork();
  checks.push(network);
  if (network.status !== "ok") {
    recommendations.push("Check internet connectivity for research and dependency downloads");
  }

  // Git (cached ~30s so repeated resources checks skip the execSync)
  const git = checkGitCached();
  checks.push(git);
  if (git.status !== "ok") {
    recommendations.push("Commit or stash changes before starting to enable rollback");
  }

  // Dependencies
  const { checks: depChecks, missing } = checkDependencies();
  checks.push(...depChecks);
  if (missing.length > 0) {
    recommendations.push(`Install missing required tools: ${missing.join(", ")}`);
  }

  // Check for docker specifically for container steps
  const dockerCheck = depChecks.find((c) => c.name === "Dependency: docker");
  if (dockerCheck && dockerCheck.status !== "ok") {
    recommendations.push("Install Docker for container-based steps");
  }

  const hasCritical = checks.some((c) => c.status === "critical");

  return {
    checks,
    missingDeps: missing,
    recommendations,
    hasCritical,
    timestamp: Date.now(),
  };
}

function formatResourceReport(report: ResourceReport): string {
  const lines: string[] = [];
  lines.push("Resource Availability Report");
  lines.push("=".repeat(40));
  lines.push("");

  for (const check of report.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗";
    lines.push(`${icon} ${check.name}: ${check.value}`);
    if (check.detail) {
      lines.push(`  ${check.detail}`);
    }
  }

  if (report.missingDeps.length > 0) {
    lines.push("");
    lines.push(`Missing required dependencies: ${report.missingDeps.join(", ")}`);
  }

  if (report.recommendations.length > 0) {
    lines.push("");
    lines.push("Recommendations:");
    for (const rec of report.recommendations) {
      lines.push(`  • ${rec}`);
    }
  }

  if (report.hasCritical) {
    lines.push("");
    lines.push("⚠ CRITICAL: Some resources are critically low or missing.");
    lines.push("  Execution may fail. Address critical issues before proceeding.");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------- safety limits */

const MAX_EVALUATE_ITERATIONS = 100;
const PLAN_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONSECUTIVE_PROGRESS_WITHOUT_STEP = 5;
const MAX_STEPS = 50;
const MAX_STUCK_ITERATIONS = 10;
const MAX_CONTEXT_REMINDERS = 20;
const MAX_HISTORY = 20;
const MAX_CHECKPOINTS = 100;
const MAX_CHILD_SESSIONS = 100;
const MAX_RESEARCH = 100;
const MAX_COMMENTS_PER_STEP = 50;
const MAX_PARTIAL_RESULTS = 100;

/* --------------------------------------------------------- plan templates */

interface PlanTemplate {
  name: string;
  description: string;
  steps: string[];
}

const PLAN_TEMPLATES: Record<string, PlanTemplate> = {
  "add-feature": {
    name: "add-feature",
    description: "Add a new feature to the codebase",
    steps: [
      "Research existing patterns and architecture",
      "Design the feature API and data flow",
      "Implement core logic",
      "Add tests",
      "Update documentation",
    ],
  },
  "fix-bug": {
    name: "fix-bug",
    description: "Fix a bug in the codebase",
    steps: [
      "Reproduce the bug and identify root cause",
      "Research similar issues and fixes",
      "Implement the fix",
      "Add regression tests",
      "Verify the fix",
    ],
  },
  refactor: {
    name: "refactor",
    description: "Refactor existing code",
    steps: [
      "Analyze current code structure",
      "Identify refactoring opportunities",
      "Plan the refactoring steps",
      "Execute refactoring",
      "Run tests and verify",
    ],
  },
  "add-api-endpoint": {
    name: "add-api-endpoint",
    description: "Add a new API endpoint to the application",
    steps: [
      "Research existing API patterns and routing structure",
      "Design the endpoint API (request/response schema, validation)",
      "Implement the endpoint handler",
      "Add request validation and error handling",
      "Write tests for the endpoint",
      "Update API documentation",
    ],
  },
  "write-tests": {
    name: "write-tests",
    description: "Write tests for existing code",
    steps: [
      "Analyze the code to be tested and identify testable units",
      "Research existing test patterns and conventions",
      "Write unit tests for core logic",
      "Write integration tests for key workflows",
      "Run tests and verify coverage",
      "Update test documentation",
    ],
  },
};

/* -------------------------------------------------- research strategies */

interface DomainStrategy {
  domain: string;
  keywords: string[];
  queries: string[];
}

const DOMAIN_STRATEGIES: DomainStrategy[] = [
  {
    domain: "react",
    keywords: ["react", "jsx", "tsx", "component", "hook", "usestate", "useeffect", "props"],
    queries: [
      "React hooks best practices 2025",
      "React component patterns and anti-patterns",
      "React state management guide",
    ],
  },
  {
    domain: "typescript",
    keywords: ["typescript", "ts", "type", "interface", "generic", "enum"],
    queries: [
      "TypeScript best practices 2025",
      "TypeScript advanced types guide",
      "TypeScript common pitfalls",
    ],
  },
  {
    domain: "nodejs",
    keywords: ["node", "nodejs", "express", "fastify", "npm", "api", "rest", "graphql"],
    queries: [
      "Node.js best practices 2025",
      "Node.js performance optimization guide",
      "REST API design best practices",
    ],
  },
  {
    domain: "database",
    keywords: ["database", "sql", "postgres", "mysql", "sqlite", "query", "index", "schema"],
    queries: [
      "PostgreSQL indexing guide",
      "Database schema design best practices",
      "SQL query optimization techniques",
    ],
  },
  {
    domain: "python",
    keywords: ["python", "django", "flask", "fastapi", "pandas", "numpy", "pip"],
    queries: [
      "Python best practices 2025",
      "Python project structure guide",
      "Python performance optimization",
    ],
  },
  {
    domain: "devops",
    keywords: ["docker", "kubernetes", "ci", "cd", "deploy", "aws", "gcp", "azure", "terraform"],
    queries: [
      "Docker best practices 2025",
      "CI/CD pipeline design guide",
      "Cloud deployment strategies",
    ],
  },
  {
    domain: "security",
    keywords: ["security", "auth", "oauth", "jwt", "encrypt", "vulnerability", "xss", "csrf"],
    queries: [
      "Web application security best practices",
      "OAuth 2.0 implementation guide",
      "Common security vulnerabilities and prevention",
    ],
  },
  {
    domain: "testing",
    keywords: ["test", "jest", "vitest", "mocha", "cypress", "playwright", "coverage"],
    queries: [
      "Testing best practices 2025",
      "Unit vs integration testing guide",
      "Test-driven development patterns",
    ],
  },
  {
    domain: "css",
    keywords: ["css", "style", "tailwind", "sass", "layout", "flexbox", "grid", "responsive"],
    queries: [
      "CSS best practices 2025",
      "Responsive design patterns",
      "CSS architecture and naming conventions",
    ],
  },
  {
    domain: "performance",
    keywords: ["performance", "optimize", "speed", "latency", "cache", "bundle", "lazy"],
    queries: [
      "Web performance optimization guide",
      "Frontend performance best practices",
      "Caching strategies and patterns",
    ],
  },
];

function detectDomains(task: string): string[] {
  const lower = task.toLowerCase();
  const domains: string[] = [];
  for (const strategy of DOMAIN_STRATEGIES) {
    if (strategy.keywords.some((kw) => lower.includes(kw))) {
      domains.push(strategy.domain);
    }
  }
  return domains;
}

function getSearchQueries(task: string): string[] {
  const lower = task.toLowerCase();
  const queries: string[] = [];
  for (const strategy of DOMAIN_STRATEGIES) {
    if (strategy.keywords.some((kw) => lower.includes(kw))) {
      queries.push(...strategy.queries);
    }
  }
  return queries;
}

function buildResearchPrompt(task: string): string {
  const domains = detectDomains(task);
  const queries = getSearchQueries(task);
  if (domains.length === 0 || queries.length === 0) {
    return "";
  }
  const lines = [
    "",
    `RESEARCH CONTEXT`,
    `Detected domains: ${domains.join(", ")}`,
    `Suggested search queries:`,
    ...queries.map((q) => `  - "${q}"`),
    `Use websearch to find current best practices, official documentation, and common pitfalls for these topics.`,
  ];
  return lines.join("\n");
}

// PL-7: shared so planPrompt, buildPrompt, buildReminder and the /plan model
// command all issue the SAME instructions text for a strategy.
const MODEL_STRATEGY_INSTRUCTIONS: Record<ModelStrategy, string> = {
  free: `Only use free models (providerID or modelID containing 'go'). Free models have unlimited use. If no free models are available, stop and report that no free models are available — do NOT fall back to paid models.`,
  paid: `Only use paid models (providerID or modelID containing 'zen').`,
  auto: `FIRST try to spawn with free models (providerID or modelID containing 'go'). If no free models are available, fall back to paid models (providerID or modelID containing 'zen').`,
  fast: `Use the fastest available model regardless of cost.`,
};

function planPrompt(maxParallelChildren: number, modelStrategy: ModelStrategy): string {
  const modelInstructions = MODEL_STRATEGY_INSTRUCTIONS;
  return `You are now in PLANNING MODE. Follow this process exactly:

## Phase 1: Research
- Search the internet for the best way to accomplish this task
- Look for official documentation, best practices, and common pitfalls
- Consider multiple approaches and their trade-offs
- Use the suggested search queries below to guide your research
- Record key findings and sources for each domain-specific search

## Phase 2: Clarify
- Ask the user specific questions about their requirements, constraints, and preferences
- Cover: scope, priorities, constraints, success criteria, and any ambiguities
- Wait for answers before proceeding

## Phase 3: Plan
Present a detailed end-to-end plan with:
- Clear phases/steps
- What each step accomplishes
- Which tools or approaches will be used
- Any risks or trade-offs
- Estimated complexity
- Estimated token/cost budget (input tokens, output tokens, approximate cost in USD)

## Phase 3b: Risk Assessment
After presenting the plan, identify risks using plan_add_risk:
- For each risk: description, likelihood (1-5), impact (1-5), mitigation strategy, contingency plan
- Focus on high-likelihood, high-impact risks first
- Link risks to specific steps when relevant
- Use plan_update_risk to track mitigation progress during execution

## Phase 4: Review Gate (after user approves the plan)
Once the user approves the plan, show an execution summary before spawning child sessions:
- "This plan will use ~N tokens across M sessions. Approve execution?"
- If the plan will fall back to paid models, add a second confirmation: "This will use paid models (~$X). Confirm?"
- Wait for explicit user confirmation before proceeding to execution

## Phase 5: Execute (only after execution approval)
Once the user confirms execution, execute the plan by spawning child sessions:

1. **Model selection strategy:**
   - ${modelInstructions[modelStrategy]}
   - Use the spawn_session tool with the appropriate model parameter

2. **Execution approach:**
   - Break the plan into independent tasks that can run in parallel
   - Spawn child sessions for each task using spawn_session
   - Limit concurrency to at most ${maxParallelChildren} child session(s) at a time
   - Use session_result to collect results
   - Use session_send for any follow-up coordination between sessions
   - Synthesize results and report back to the user

3. **During execution:**
   - Monitor progress and report to the user
   - Handle failures by retrying or adjusting approach
    - Keep the user informed of significant milestones

Begin now: research the task, then ask the user your first set of clarifying questions.`;
}

const HELP = [
  "plan — plan a task end-to-end, then execute it via child sessions.",
  "",
  "  /plan <task>          start planning a task (use '/plan replace <task>' to overwrite an executing/awaiting plan)",
  "  /plan template <name>  load a template's steps into the plan (add-feature, fix-bug, refactor)",
  "  /plan export [format]  export the plan (markdown, json, mermaid, github)",
  "  /plan resume           continue an interrupted plan execution",
  "  /plan status           show phase, progress, child sessions, blockers, linked items",
  "  /plan step <n>         show or update a specific step (includes confidence level)",
  "  /plan cost             show current cost estimate and actuals",
  "  /plan optimize         analyze costs and suggest optimizations",
  "  /plan test-strategy     generate testing strategy for plan steps",
  "  /plan learn             analyze completed plan and generate insights",
  "  /plan docs [format]     generate documentation (markdown, html, json)",
  "  /plan dependencies      auto-detect dependencies between steps",
  "  /plan decompose <n>     decompose a complex step into sub-steps",
  "  /plan risks            show the risk matrix (likelihood vs impact)",
  "  /plan research         show research findings, sources, and key insights",
  "  /plan schedule         show execution order with parallel/sequential groups",
  "  /plan model [strategy]  show or set model strategy: free, paid, auto (free-then-paid), fast",
  "  /plan mode [batch|incremental]  show or set execution mode: incremental pauses for approval between phases, batch runs all phases without per-phase approval",
  "  /plan pause            pause execution between phases",
  "  /plan approve-phase <n> approve a specific phase for execution",
  "  /plan approve          approve the plan and begin execution",
  "  /plan reject           reject the plan and return to planning",
  "  /plan rollback [step]  rollback to a previous state using git",
  "  /plan edit <change>    modify plan steps (e.g. 'remove step 3', 'swap steps 4 and 5', 'make authentication simpler', 'use PostgreSQL instead of MySQL')",
  "  /plan diff [from] [to] show changes between plan versions",
  "  /plan criteria         manage success criteria",
  "  /plan time             show time tracking",
  "  /plan estimate          show estimated vs actual duration",
  "  /plan metrics           show execution metrics and analytics",
  "  /plan share [tool]      share plan via PM tool (jira, linear, github, slack)",
  "  /plan comment <n> <text>  add a comment to a step",
  "  /plan compare <text>    compare current plan with an alternative",
  "  /plan review            review code changes made during execution",
  "  /plan done             mark the plan complete yourself",
  "  /plan clear            forget the plan",
  "  /plan resources        check resource availability before execution",
  "  /plan projects         show linked projects and their status",
  "  /plan accessibility <audience>  generate plan for different audiences (executive, technical, pm)",
].join("\n");

const NO_PLAN = "[plan-plugin] No plan exists for this session. Use `/plan <task>` to create one.";

const STATUS_LABEL: Record<PlanStatus, string> = {
  researching: "researching",
  clarifying: "clarifying",
  planning: "planning",
  awaiting_approval: "awaiting approval",
  executing: "executing",
  paused: "paused",
  stopped: "stopped",
  complete: "complete",
  blocked: "blocked",
  failed: "stopped (failed)",
};

/* ------------------------------------------------------------------ utils */

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function estimateDuration(description: string): number {
  const lower = description.toLowerCase();
  if (lower.includes("test")) return 15;
  if (lower.includes("research") || lower.includes("analyze")) return 20;
  if (lower.includes("implement") || lower.includes("create") || lower.includes("add") || lower.includes("build")) return 30;
  if (lower.includes("refactor") || lower.includes("migrate")) return 45;
  if (lower.includes("review") || lower.includes("audit")) return 20;
  if (lower.includes("document") || lower.includes("write docs")) return 25;
  if (lower.includes("deploy") || lower.includes("release")) return 20;
  if (lower.includes("fix") || lower.includes("bug")) return 20;
  return 25;
}

/* ------------------------------------------------------- step manipulation */

// PL-3: dependsOn and subSteps reference steps by stable ID, so removals and
// swaps never renumber references. Removing a step still has to drop anything
// that pointed at it: other steps' dependsOn/subSteps and its phase approvals
// (phase numbering follows the surviving steps).
function dropStepReferences(st: PlanState, stepId: string): void {
  for (const s of st.steps) {
    if (s.dependsOn) s.dependsOn = s.dependsOn.filter((id) => id !== stepId);
    if (s.subSteps) s.subSteps = s.subSteps.filter((id) => id !== stepId);
  }
  st.phaseApprovals = st.phaseApprovals.filter((p) => p.stepId !== stepId);
}

// PL-3: after wholesale step replacement (template load, revert), reconcile
// phase approvals and sub-step references against the surviving step IDs.
function reconcileStepRefs(st: PlanState): void {
  const ids = new Set(st.steps.map((s) => s.id));
  st.phaseApprovals = st.phaseApprovals.filter((p) => ids.has(p.stepId));
  for (const s of st.steps) {
    if (Array.isArray(s.dependsOn)) s.dependsOn = s.dependsOn.filter((id) => ids.has(id) && id !== s.id);
    if (Array.isArray(s.subSteps)) s.subSteps = s.subSteps.filter((id) => ids.has(id) && id !== s.id);
  }
}

function removeStep(st: PlanState, index: number): boolean {
  if (index < 0 || index >= st.steps.length) return false;
  const [removed] = st.steps.splice(index, 1);
  if (removed) dropStepReferences(st, removed.id);
  return true;
}

function swapSteps(st: PlanState, i: number, j: number): boolean {
  // PL-3: dependsOn/subSteps are ID-based, so swapping step objects leaves all
  // references intact; nothing to renumber.
  if (i < 0 || i >= st.steps.length || j < 0 || j >= st.steps.length) return false;
  const tmp = st.steps[i];
  st.steps[i] = st.steps[j];
  st.steps[j] = tmp;
  return true;
}

function modifyStep(st: PlanState, index: number, newDescription: string): boolean {
  if (index < 0 || index >= st.steps.length) return false;
  st.steps[index].description = newDescription.trim();
  return true;
}

// PL-3: dependsOn/subSteps hold step IDs. These helpers resolve them to
// current array positions; references to steps that no longer exist resolve
// away (index -1 / no entry) instead of silently pointing at a shifted step.
function stepIndexOf(steps: PlanStep[], id: string): number {
  return steps.findIndex((s) => s.id === id);
}

// Resolved numeric dependencies of steps[i]: valid, non-self indices.
function resolvedDeps(steps: PlanStep[], i: number): number[] {
  const out: number[] = [];
  for (const id of steps[i]?.dependsOn ?? []) {
    const idx = stepIndexOf(steps, id);
    if (idx >= 0 && idx !== i && !out.includes(idx)) out.push(idx);
  }
  return out;
}

// PL-6: resolve an optional step reference given as a 1-based number ("3") or
// a step ID ("step-..."). Returns matched=false when nothing matches so
// callers can warn instead of silently no-opping.
function resolveStepRef(
  steps: PlanStep[],
  ref: number | string | undefined,
): { index: number; step?: PlanStep; matched: boolean } {
  if (ref === undefined || ref === null || String(ref).trim() === "") {
    return { index: -1, matched: false };
  }
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const idx = parseInt(s, 10) - 1;
    if (idx >= 0 && idx < steps.length) return { index: idx, step: steps[idx], matched: true };
    return { index: -1, matched: false };
  }
  const idx = stepIndexOf(steps, s);
  if (idx >= 0) return { index: idx, step: steps[idx], matched: true };
  const num = Number(s);
  if (Number.isInteger(num) && num >= 1 && num <= steps.length) {
    return { index: num - 1, step: steps[num - 1], matched: true };
  }
  return { index: -1, matched: false };
}

// PL-5: keep parent steps in sync with their sub-steps. Completing or
// skipping the last open sub-step completes the parent; starting the first
// sub-step puts the parent in_progress. Returns true when anything changed.
function syncParentSteps(st: PlanState): boolean {
  const now = Date.now();
  let changed = false;
  for (const parent of st.steps) {
    if (!parent.isParent || !parent.subSteps || parent.subSteps.length === 0) continue;
    if (parent.status === "complete" || parent.status === "skipped") continue;
    const subs = parent.subSteps
      .map((id) => st.steps[stepIndexOf(st.steps, id)])
      .filter((s): s is PlanStep => !!s);
    if (subs.length === 0) continue;
    const allDone = subs.every((s) => s.status === "complete" || s.status === "skipped");
    if (allDone) {
      parent.status = "complete";
      if (!parent.startedAt) parent.startedAt = now;
      parent.completedAt = now;
      changed = true;
      continue;
    }
    if (parent.status === "pending" && subs.some((s) => s.status !== "pending")) {
      const firstStart = subs.reduce<number | undefined>(
        (earliest, s) => (s.startedAt !== undefined && (earliest === undefined || s.startedAt < earliest) ? s.startedAt : earliest),
        undefined,
      );
      parent.status = "in_progress";
      parent.startedAt = firstStart ?? now;
      changed = true;
    }
  }
  return changed;
}

// PL-3: legacy rows (pre-ID migration) stored dependsOn/subSteps as array
// indices. Normalize at load time: numeric entries — or bare numeric strings
// that are not known step IDs — translate through the persisted step array;
// entries that resolve to nothing are dropped. Also defaults every array
// field and costEstimate (PL-11) so a partially-written row can't crash
// later handlers.
function migratePlan(raw: PlanState): PlanState {
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  raw.steps = arr<PlanStep>(raw.steps);
  for (const s of raw.steps) if (s && typeof s === "object") normalizeStep(s);
  raw.childSessions = arr(raw.childSessions);
  raw.partialResults = arr(raw.partialResults);
  raw.risks = arr(raw.risks);
  raw.criteria = arr(raw.criteria);
  raw.insights = arr(raw.insights);
  raw.research = arr(raw.research);
  raw.history = arr(raw.history);
  raw.phaseApprovals = arr(raw.phaseApprovals);
  raw.checkpoints = arr(raw.checkpoints);
  raw.projects = arr(raw.projects);
  if (!raw.costEstimate || typeof raw.costEstimate !== "object") {
    raw.costEstimate = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      estimatedAt: raw.createdAt ?? Date.now(),
    };
  }
  const ids = new Set(raw.steps.map((s) => s?.id).filter(Boolean));
  const translate = (refs: unknown, selfId: string): string[] | undefined => {
    if (!Array.isArray(refs)) return undefined;
    const out: string[] = [];
    for (const ref of refs) {
      let id: string | undefined;
      if (typeof ref === "number") id = raw.steps[ref]?.id;
      else if (typeof ref === "string" && ids.has(ref)) id = ref;
      else if (typeof ref === "string" && /^\d+$/.test(ref)) id = raw.steps[Number(ref)]?.id;
      if (id && id !== selfId && !out.includes(id)) out.push(id);
    }
    return out;
  };
  for (const s of raw.steps) {
    if (!s || typeof s !== "object") continue;
    if (s.dependsOn !== undefined) {
      const deps = translate(s.dependsOn, s.id);
      if (deps && deps.length > 0) s.dependsOn = deps;
      else delete s.dependsOn;
    }
    if (s.subSteps !== undefined) {
      const subs = translate(s.subSteps, s.id);
      if (subs && subs.length > 0) s.subSteps = subs;
      else {
        delete s.subSteps;
        delete s.isParent;
      }
    }
  }
  // Legacy history snapshots may carry index-based refs too; translate them
  // against their own snapshot so revert restores a consistent step set.
  for (const h of raw.history) {
    if (h && Array.isArray(h.steps)) {
      const hids = new Set(h.steps.map((s) => s?.id).filter(Boolean));
      for (const s of h.steps) {
        if (!s || typeof s !== "object") continue;
        const translateH = (refs: unknown): string[] | undefined => {
          if (!Array.isArray(refs)) return undefined;
          const out: string[] = [];
          for (const ref of refs) {
            let id: string | undefined;
            if (typeof ref === "number") id = h.steps[ref]?.id;
            else if (typeof ref === "string" && hids.has(ref)) id = ref;
            else if (typeof ref === "string" && /^\d+$/.test(ref)) id = h.steps[Number(ref)]?.id;
            if (id && id !== s.id && !out.includes(id)) out.push(id);
          }
          return out;
        };
        if (s.dependsOn !== undefined) {
          const deps = translateH(s.dependsOn);
          if (deps && deps.length > 0) s.dependsOn = deps;
          else delete s.dependsOn;
        }
        if (s.subSteps !== undefined) {
          const subs = translateH(s.subSteps);
          if (subs && subs.length > 0) s.subSteps = subs;
          else {
            delete s.subSteps;
            delete s.isParent;
          }
        }
      }
    }
  }
  return raw;
}

function snapshotVersion(st: PlanState, note: string): void {
  st.history.push({
    version: st.version,
    timestamp: Date.now(),
    steps: structuredClone(st.steps),
    planText: st.planText,
    note,
  });
  st.version++;
  while (st.history.length > MAX_HISTORY) st.history.shift();
}

/* --------------------------------------------------------- scheduling */

interface ScheduleGroup {
  parallel: boolean;
  steps: Array<{ index: number; step: PlanStep }>;
}

interface ScheduleResult {
  groups: ScheduleGroup[];
  executionOrder: number[];
  hasCycle: boolean;
  cycleNodes: number[];
}

function computeSchedule(steps: PlanStep[]): ScheduleResult {
  const n = steps.length;
  const indegree = new Array(n).fill(0);
  const dependents: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    // PL-3: dependsOn holds step IDs; resolve them to current indices.
    for (const dep of resolvedDeps(steps, i)) {
      indegree[i]++;
      dependents[dep].push(i);
    }
  }

  // Kahn's algorithm for topological sort
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indegree[i] === 0) queue.push(i);
  }

  const executionOrder: number[] = [];
  const groups: ScheduleGroup[] = [];
  let processed = 0;

  while (queue.length > 0) {
    const level: number[] = [];
    const levelSize = queue.length;
    for (let i = 0; i < levelSize; i++) {
      const node = queue.shift()!;
      level.push(node);
      executionOrder.push(node);
      processed++;
    }

    const isParallel = level.length > 1;
    groups.push({
      parallel: isParallel,
      steps: level.map((idx) => ({ index: idx, step: steps[idx] })),
    });

    for (const node of level) {
      for (const dep of dependents[node]) {
        indegree[dep]--;
        if (indegree[dep] === 0) queue.push(dep);
      }
    }
  }

  const hasCycle = processed < n;
  const cycleNodes: number[] = [];
  if (hasCycle) {
    for (let i = 0; i < n; i++) {
      if (indegree[i] > 0) cycleNodes.push(i);
    }
  }

  return { groups, executionOrder, hasCycle, cycleNodes };
}

function computeCriticalPath(steps: PlanStep[]): number[] {
  const n = steps.length;
  if (n === 0) return [];

  const schedule = computeSchedule(steps);
  if (schedule.hasCycle) return [];

  // dp[i] = length of longest path ending at step i
  const dp = new Array(n).fill(1);
  // prev[i] = previous step index on the longest path ending at i
  const prev = new Array(n).fill(-1);

  for (const idx of schedule.executionOrder) {
    // PL-3: dependsOn holds step IDs; resolve them to current indices.
    for (const dep of resolvedDeps(steps, idx)) {
      if (dp[dep] + 1 > dp[idx]) {
        dp[idx] = dp[dep] + 1;
        prev[idx] = dep;
      }
    }
  }

  // Find the step with the longest path
  let endIdx = 0;
  for (let i = 1; i < n; i++) {
    if (dp[i] > dp[endIdx]) endIdx = i;
  }

  // Reconstruct the path
  const path: number[] = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.unshift(cur);
    cur = prev[cur];
  }
  return path;
}

function renderDependencyGraph(steps: PlanStep[]): string {
  const n = steps.length;
  if (n === 0) return "(no steps)";

  const lines: string[] = [];
  const schedule = computeSchedule(steps);

  if (schedule.hasCycle) {
    lines.push("WARNING: Dependency cycle detected!");
    lines.push(`Cycle involves steps: ${schedule.cycleNodes.map((i) => i + 1).join(", ")}`);
    lines.push("");
  }

  // Build adjacency for rendering (PL-3: resolve step-ID deps to indices)
  const deps: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const dep of resolvedDeps(steps, i)) deps[dep].push(i);
  }

  // Render each step with its dependencies
  for (let i = 0; i < n; i++) {
    const step = steps[i];
    const statusIcon = step.status === "complete" ? "✓" : step.status === "in_progress" ? "→" : step.status === "failed" ? "✗" : step.status === "skipped" ? "○" : "·";
    const depList = resolvedDeps(steps, i);
    const depStr = depList.length > 0 ? ` ← [${depList.map((d) => d + 1).join(", ")}]` : "";
    lines.push(`  ${statusIcon} Step ${i + 1}: ${truncate(step.description, 60)}${depStr}`);
  }

  // Render ASCII graph
  lines.push("");
  lines.push("Dependency Graph:");
  lines.push("");

  // Simple layered graph rendering
  const levels: number[][] = [];
  const nodeLevel = new Array(n).fill(-1);
  const visited = new Array(n).fill(false);

  // BFS to assign levels
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const hasDeps = resolvedDeps(steps, i).length > 0;
    if (!hasDeps) {
      queue.push(i);
      nodeLevel[i] = 0;
      visited[i] = true;
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const dep of deps[node]) {
      if (!visited[dep]) {
        visited[dep] = true;
        nodeLevel[dep] = nodeLevel[node] + 1;
        queue.push(dep);
      }
    }
  }

  // Handle cycles - assign remaining nodes
  for (let i = 0; i < n; i++) {
    if (nodeLevel[i] === -1) nodeLevel[i] = 0;
  }

  const maxLevel = Math.max(...nodeLevel);
  for (let l = 0; l <= maxLevel; l++) {
    const levelNodes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (nodeLevel[i] === l) levelNodes.push(i);
    }
    levels.push(levelNodes);
  }

  // Render layers
  for (let l = 0; l < levels.length; l++) {
    const nodes = levels[l];
    const nodeStrs = nodes.map((i) => `[${i + 1}]`);
    lines.push(`  ${"  ".repeat(l)}${nodeStrs.join("  ")}`);
    if (l < levels.length - 1) {
      lines.push(`  ${"  ".repeat(l)}  |`);
    }
  }

  return lines.join("\n");
}

function renderDependencyGraphMermaid(steps: PlanStep[]): string {
  const n = steps.length;
  if (n === 0) return "(no steps)";

  const lines: string[] = ["graph TD"];

  for (let i = 0; i < n; i++) {
    const desc = (steps[i].description ?? "").replace(/"/g, "&quot;");
    lines.push(`  step${i + 1}["Step ${i + 1}: ${desc}"]`);
  }

  for (let i = 0; i < n; i++) {
    // PL-3: dependsOn holds step IDs; edges reference current step numbers.
    for (const dep of resolvedDeps(steps, i)) {
      lines.push(`  step${dep + 1} --> step${i + 1}`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------- dependency auto-detection */

interface DetectedDependency {
  step: number; // 1-based step number that has the dependency
  dependsOn: number; // 1-based step number it depends on
  reason: string; // human-readable explanation
}

const DEPENDENCY_STOP_WORDS = new Set([
  "step", "steps", "the", "and", "for", "with", "this", "that", "from", "into", "then",
  "after", "before", "using", "use", "all", "new", "out", "via", "per", "each", "when",
  "while", "where", "which", "their", "there", "here", "will", "should", "would",
  "could", "also", "other", "some", "such", "than", "them", "they", "what", "your",
  "have", "has", "had", "been", "being", "were", "was", "are", "its", "our", "you",
  "not", "but", "can", "may", "must", "about", "over", "under", "again", "once",
]);

const DEPENDENCY_PRODUCER_VERBS = [
  "create", "implement", "build", "add", "design", "setup", "set up", "write",
  "define", "generate", "scaffold", "configure", "install", "migrate", "establish",
  "initialize", "research", "analyze", "plan", "identify", "reproduce",
];

const DEPENDENCY_CONSUMER_VERBS = [
  "test", "verify", "validate", "update", "extend", "refactor", "use", "run",
  "deploy", "document", "review", "optimize", "fix", "query", "integrate",
  "exercise", "check", "lint", "benchmark", "profile", "cover", "execute",
];

function dependencySignificantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !DEPENDENCY_STOP_WORDS.has(w)),
  );
}

function dependencyStartsWithVerb(desc: string, verbs: string[]): boolean {
  const lower = desc.toLowerCase().trim();
  return verbs.some(
    (v) => lower === v || lower.startsWith(v + " ") || lower.startsWith(v + " the "),
  );
}

function dependencyExtractObjectWords(desc: string): Set<string> {
  const lower = desc.toLowerCase().trim();
  let cleaned = lower;
  const allVerbs = [...DEPENDENCY_PRODUCER_VERBS, ...DEPENDENCY_CONSUMER_VERBS].sort(
    (a, b) => b.length - a.length,
  );
  for (const verb of allVerbs) {
    if (cleaned === verb) {
      cleaned = "";
      break;
    }
    if (cleaned.startsWith(verb + " ")) {
      cleaned = cleaned.slice(verb.length).trim();
      break;
    }
  }
  return dependencySignificantWords(cleaned);
}

function detectDependencies(steps: PlanStep[]): DetectedDependency[] {
  const detected: DetectedDependency[] = [];
  const n = steps.length;
  if (n < 2) return detected;

  // Precompute tokenized object words once per step instead of re-tokenizing
  // for every (i, j) pair below.
  const consumerWordsByIdx = new Map<number, Set<string>>();
  const producerWordsByIdx = new Map<number, Set<string>>();
  for (let k = 0; k < n; k++) {
    consumerWordsByIdx.set(k, dependencyExtractObjectWords(steps[k].description));
    producerWordsByIdx.set(k, dependencyExtractObjectWords(steps[k].description));
  }

  // Rule 1: explicit references — "step N", "the previous step", "after step N"
  const explicitPatterns: Array<{
    re: RegExp;
    resolve: (m: RegExpExecArray, selfIdx: number) => number | null;
  }> = [
    {
      re: /\bstep\s+(\d+)\b/i,
      resolve: (m) => {
        const num = parseInt(m[1], 10);
        return num >= 1 && num <= n ? num - 1 : null;
      },
    },
    {
      re: /\bthe\s+previous\s+step\b/i,
      resolve: (_m, selfIdx) => (selfIdx > 0 ? selfIdx - 1 : null),
    },
    {
      re: /\bthe\s+above\s+step\b/i,
      resolve: (_m, selfIdx) => (selfIdx > 0 ? selfIdx - 1 : null),
    },
    {
      re: /\bthe\s+prior\s+step\b/i,
      resolve: (_m, selfIdx) => (selfIdx > 0 ? selfIdx - 1 : null),
    },
    {
      re: /\bafter\s+step\s+(\d+)\b/i,
      resolve: (m) => {
        const num = parseInt(m[1], 10);
        return num >= 1 && num <= n ? num - 1 : null;
      },
    },
  ];

  for (let i = 0; i < n; i++) {
    const desc = steps[i].description;
    for (const { re, resolve } of explicitPatterns) {
      const m = re.exec(desc);
      if (!m) continue;
      const target = resolve(m, i);
      if (target === null || target === i) continue;
      detected.push({
        step: i + 1,
        dependsOn: target + 1,
        reason: `explicitly references step ${target + 1}`,
      });
    }
  }

  // Rule 2: producer/consumer concept matching
  // "test X" / "verify X" depends on "implement X" / "create X" / "build X"
  for (let i = 0; i < n; i++) {
    if (!dependencyStartsWithVerb(steps[i].description, ["test", "verify", "validate", "check", "cover"])) continue;
    const consumerWords = consumerWordsByIdx.get(i)!;
    if (consumerWords.size === 0) continue;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (!dependencyStartsWithVerb(steps[j].description, DEPENDENCY_PRODUCER_VERBS)) continue;
      const producerWords = producerWordsByIdx.get(j)!;
      if (producerWords.size === 0) continue;
      const overlap = [...consumerWords].filter((w) => producerWords.has(w));
      if (overlap.length >= 1) {
        detected.push({
          step: i + 1,
          dependsOn: j + 1,
          reason: `tests "${overlap.join(", ")}" produced in step ${j + 1}`,
        });
      }
    }
  }

  // Rule 3: general producer/consumer — consumer step shares significant concepts with producer step
  for (let i = 0; i < n; i++) {
    if (!dependencyStartsWithVerb(steps[i].description, DEPENDENCY_CONSUMER_VERBS)) continue;
    // Skip if already caught by rule 2
    if (dependencyStartsWithVerb(steps[i].description, ["test", "verify", "validate", "check", "cover"])) continue;
    const consumerWords = consumerWordsByIdx.get(i)!;
    if (consumerWords.size < 2) continue;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (!dependencyStartsWithVerb(steps[j].description, DEPENDENCY_PRODUCER_VERBS)) continue;
      const producerWords = producerWordsByIdx.get(j)!;
      if (producerWords.size === 0) continue;
      const overlap = [...consumerWords].filter((w) => producerWords.has(w));
      if (overlap.length >= 2) {
        detected.push({
          step: i + 1,
          dependsOn: j + 1,
          reason: `uses "${overlap.join(", ")}" from step ${j + 1}`,
        });
      }
    }
  }

  // Deduplicate: keep first detection per (step, dependsOn) pair
  const seen = new Set<string>();
  return detected.filter((d) => {
    const key = `${d.step}:${d.dependsOn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dependenciesText(st: PlanState, detected: DetectedDependency[]): string {
  const lines: string[] = [
    `${MARK} Dependency Detection`,
    ``,
  ];
  if (detected.length === 0) {
    lines.push(`No dependencies detected between steps.`);
  } else {
    lines.push(`Detected ${detected.length} dependency/dependencies:`);
    for (const d of detected) {
      lines.push(`  Step ${d.step} → depends on Step ${d.dependsOn} (${d.reason})`);
    }
  }
  lines.push(``);
  lines.push(renderDependencyGraph(st.steps));
  return lines.join("\n");
}

function scheduleText(st: PlanState): string {
  if (st.steps.length === 0) {
    return `${MARK} No steps to schedule.`;
  }

  const schedule = computeSchedule(st.steps);
  const lines: string[] = [
    `${MARK} Execution Schedule`,
    ``,
  ];

  if (schedule.hasCycle) {
    lines.push(`ERROR: Dependency cycle detected involving steps: ${schedule.cycleNodes.map((i) => i + 1).join(", ")}`);
    lines.push(`Resolve the cycle before executing.`);
    return lines.join("\n");
  }

  lines.push(`Total steps: ${st.steps.length}`);
  lines.push(`Parallel groups: ${schedule.groups.filter((g) => g.parallel).length}`);
  lines.push(`Sequential groups: ${schedule.groups.filter((g) => !g.parallel).length}`);
  lines.push(``);

  // Critical path
  const criticalPath = computeCriticalPath(st.steps);
  const criticalSet = new Set(criticalPath);

  // Execution order
  lines.push(`Execution Order:`);
  for (let i = 0; i < schedule.executionOrder.length; i++) {
    const idx = schedule.executionOrder[i];
    const step = st.steps[idx];
    const statusIcon = step.status === "complete" ? "✓" : step.status === "in_progress" ? "→" : step.status === "failed" ? "✗" : step.status === "skipped" ? "○" : "·";
    // PL-3: dependsOn holds step IDs; show their current step numbers.
    const deps = resolvedDeps(st.steps, idx);
    const depStr = deps.length > 0 ? ` (after: ${deps.map((d) => d + 1).join(", ")})` : "";
    const star = criticalSet.has(idx) ? " ★" : "";
    lines.push(`  ${i + 1}. ${statusIcon} Step ${idx + 1}: ${truncate(step.description, 50)}${depStr}${star}`);
  }

  // Critical path summary
  if (criticalPath.length > 0) {
    const pathStr = criticalPath.map((i) => `Step ${i + 1}`).join(" → ");
    lines.push(``);
    lines.push(`Critical path: ${pathStr} (${criticalPath.length} steps)`);
  }

  // Parallel/Sequential groups
  lines.push(``);
  lines.push(`Execution Groups:`);
  for (let i = 0; i < schedule.groups.length; i++) {
    const group = schedule.groups[i];
    const mode = group.parallel ? "PARALLEL" : "SEQUENTIAL";
    lines.push(``);
    lines.push(`  Group ${i + 1} [${mode}]:`);
    for (const { index, step } of group.steps) {
      const statusIcon = step.status === "complete" ? "✓" : step.status === "in_progress" ? "→" : step.status === "failed" ? "✗" : step.status === "skipped" ? "○" : "·";
      lines.push(`    ${statusIcon} Step ${index + 1}: ${truncate(step.description, 50)}`);
    }
  }

  // Dependency graph
  lines.push(``);
  lines.push(renderDependencyGraph(st.steps));

  // Mermaid diagram
  lines.push(``);
  lines.push(`Mermaid Diagram:`);
  lines.push("```mermaid");
  lines.push(renderDependencyGraphMermaid(st.steps));
  lines.push("```");

  return lines.join("\n");
}

/* ------------------------------------------------------------ edit parsing */

interface EditCommand {
  action: "remove" | "swap" | "modify" | "skip";
  params: Record<string, unknown>;
}

function parseEditCommand(arg: string): EditCommand | null {
  const text = arg.trim().toLowerCase();

  // "Remove step 3" or "remove step 3"
  const removeMatch = /^remove\s+step\s+(\d+)$/.exec(text);
  if (removeMatch) {
    return { action: "remove", params: { index: parseInt(removeMatch[1], 10) - 1 } };
  }

  // "Swap steps 4 and 5" or "swap step 4 and 5"
  const swapMatch = /^swap\s+steps?\s+(\d+)\s+and\s+(\d+)$/.exec(text);
  if (swapMatch) {
    return { action: "swap", params: { i: parseInt(swapMatch[1], 10) - 1, j: parseInt(swapMatch[2], 10) - 1 } };
  }

  // "Add error handling to step 2" or "modify step 2 to add error handling"
  const modifyMatch = /^(?:add|modify|change|update)\s+(.+?)\s+to\s+step\s+(\d+)$/.exec(text);
  if (modifyMatch) {
    return { action: "modify", params: { index: parseInt(modifyMatch[2], 10) - 1, description: modifyMatch[1] } };
  }

  // "Change step 2 description to X"
  const changeMatch = /^change\s+step\s+(\d+)\s+description\s+to\s+(.+)$/.exec(text);
  if (changeMatch) {
    return { action: "modify", params: { index: parseInt(changeMatch[1], 10) - 1, description: changeMatch[2] } };
  }

  return null;
}

function parseNaturalEditCommand(arg: string): EditCommand | null {
  const text = arg.trim().toLowerCase();

  // "skip step N" or "skip X"
  const skipStepMatch = /^skip\s+step\s+(\d+)$/.exec(text);
  if (skipStepMatch) {
    return { action: "skip", params: { index: parseInt(skipStepMatch[1], 10) - 1 } };
  }
  const skipMatch = /^skip\s+(.+)$/.exec(text);
  if (skipMatch) {
    return { action: "skip", params: { match: skipMatch[1] } };
  }

  // "make X simpler" or "simplify X"
  const simplerMatch = /^make\s+(.+?)\s+simpler$/.exec(text);
  if (simplerMatch) {
    return { action: "modify", params: { match: simplerMatch[1], note: "simplified" } };
  }
  const simplifyMatch = /^simplify\s+(.+)$/.exec(text);
  if (simplifyMatch) {
    return { action: "modify", params: { match: simplifyMatch[1], note: "simplified" } };
  }

  // "use X instead of Y"
  const useInsteadMatch = /^use\s+(.+?)\s+instead\s+of\s+(.+)$/.exec(text);
  if (useInsteadMatch) {
    return { action: "modify", params: { match: useInsteadMatch[2], replace: useInsteadMatch[1] } };
  }

  // "change X to Y"
  const changeToMatch = /^change\s+(.+?)\s+to\s+(.+)$/.exec(text);
  if (changeToMatch) {
    return { action: "modify", params: { match: changeToMatch[1], replace: changeToMatch[2] } };
  }

  // "focus on X"
  const focusMatch = /^focus\s+on\s+(.+)$/.exec(text);
  if (focusMatch) {
    return { action: "modify", params: { match: focusMatch[1], note: "high priority" } };
  }

  // "add X to step N" or "add X"
  const addToStepMatch = /^add\s+(.+?)\s+to\s+step\s+(\d+)$/.exec(text);
  if (addToStepMatch) {
    return { action: "modify", params: { index: parseInt(addToStepMatch[2], 10) - 1, add: addToStepMatch[1] } };
  }
  const addMatch = /^add\s+(.+)$/.exec(text);
  if (addMatch) {
    return { action: "modify", params: { match: addMatch[1], add: addMatch[1] } };
  }

  // "remove X from step N" or "remove X"
  const removeFromStepMatch = /^remove\s+(.+?)\s+from\s+step\s+(\d+)$/.exec(text);
  if (removeFromStepMatch) {
    return { action: "modify", params: { index: parseInt(removeFromStepMatch[2], 10) - 1, remove: removeFromStepMatch[1] } };
  }
  const removeMatch = /^remove\s+(.+)$/.exec(text);
  if (removeMatch) {
    return { action: "modify", params: { match: removeMatch[1], remove: removeMatch[1] } };
  }

  return null;
}

/* ------------------------------------------------------------------ config */

interface PlanConfig {
  enabled: boolean;
  notify: boolean;
  log: boolean;
  maxParallelChildren: number;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function toNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveConfig(options: Record<string, unknown> | undefined): PlanConfig {
  const pick = (key: string, env: string): unknown => options?.[key] ?? process.env[env];
  return {
    enabled: toBool(pick("enabled", "OPENCODE_PLAN_ENABLED"), true),
    notify: toBool(pick("notify", "OPENCODE_PLAN_NOTIFY"), true),
    log: toBool(pick("log", "OPENCODE_PLAN_LOG"), false),
    maxParallelChildren: toNum(pick("maxParallelChildren", "OPENCODE_PLAN_MAX_PARALLEL_CHILDREN"), 3, 1, 10),
  };
}

/* --------------------------------------------------------------- rendering */

/* Derived aggregates.
 *
 * statusText, metricsText, buildReminder, buildPrompt and evaluate() all walk
 * st.steps/st.risks/st.criteria/st.childSessions to recompute the same handful
 * of counts. metricsText alone did six full st.steps.filter passes, and one
 * turn asking for `/plan status` twice (or a context event plus a command)
 * re-walked every array on each call. Compute them in a single pass and memoise
 * behind st.updatedAt — the same change token save() and evaluate() already
 * dedupe on — so repeated reads inside one turn cost one pass.
 *
 * Only values that are a pure function of the plan data are cached. Anything
 * derived from the current clock (elapsed minutes, in-flight durations, plan
 * age) is recomputed per call from the cached startedAt lists, so a stale
 * reading can never leak into the output.
 *
 * No timers and no debounce: the cache is a WeakMap keyed by the live PlanState,
 * so it is purely synchronous, always consistent with whatever state the caller
 * holds, and a cleared or discarded plan is collected with its entry. */
type PlanAggregates = {
  /* steps */
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  skipped: number;
  failed: number;
  /** complete + skipped — the "how far along" figure used for stuck detection */
  done: number;
  /** Math.round(completed / total * 100), 0 when the plan has no steps */
  pct: number;
  /** first step still pending or in progress, else undefined */
  nextPending: PlanStep | undefined;
  /** sum of estimatedDurationMin over every step */
  totalEstimatedMin: number;
  /** earliest startedAt across every step, else undefined */
  firstStepStart: number | undefined;
  /** complete steps whose duration is fully settled (startedAt + completedAt) */
  settledCompletedCount: number;
  settledCompletedMs: number;
  /** complete steps missing completedAt — their duration needs the clock */
  looseCompletedStartedAt: number[];
  /** summed per-step rounded minutes for steps that have a completedAt */
  settledActualMin: number;
  /** startedAt of steps still in flight (started, no completedAt) */
  runningStartedAt: number[];
  /* risks */
  riskTotal: number;
  risksMitigated: number;
  risksOccurred: number;
  risksOpen: number;
  risksAccepted: number;
  /** highest riskScore across open risks, 0 when nothing is open */
  maxOpenRiskScore: number;
  /** open risks scoring >= 8 (high or critical) */
  openHighRisks: Risk[];
  /* success criteria */
  criteriaTotal: number;
  criteriaPassing: number;
  criteriaFailing: number;
  criteriaPending: number;
  criteriaUnverifiable: number;
  /* child sessions */
  childTotal: number;
  childCompleted: number;
  childFailed: number;
  childRunning: number;
};

function computeAggregates(st: PlanState): PlanAggregates {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let skipped = 0;
  let failed = 0;
  let totalEstimatedMin = 0;
  let firstStepStart: number | undefined;
  let settledCompletedCount = 0;
  let settledCompletedMs = 0;
  let settledActualMin = 0;
  let nextPending: PlanStep | undefined;
  const looseCompletedStartedAt: number[] = [];
  const runningStartedAt: number[] = [];

  for (const s of st.steps) {
    switch (s.status) {
      case "complete":
        completed++;
        break;
      case "in_progress":
        inProgress++;
        break;
      case "pending":
        pending++;
        break;
      case "skipped":
        skipped++;
        break;
      case "failed":
        failed++;
        break;
      default:
        break;
    }
    if (nextPending === undefined && (s.status === "pending" || s.status === "in_progress")) {
      nextPending = s;
    }
    totalEstimatedMin += s.estimatedDurationMin ?? 0;
    if (s.startedAt) {
      if (firstStepStart === undefined || s.startedAt < firstStepStart) firstStepStart = s.startedAt;
      if (s.completedAt !== undefined) {
        settledActualMin += Math.max(0, Math.round((s.completedAt - s.startedAt) / 60000));
        if (s.status === "complete") {
          settledCompletedCount++;
          settledCompletedMs += Math.max(0, s.completedAt - s.startedAt);
        }
      } else {
        runningStartedAt.push(s.startedAt);
        if (s.status === "complete") looseCompletedStartedAt.push(s.startedAt);
      }
    }
  }

  let risksMitigated = 0;
  let risksOccurred = 0;
  let risksOpen = 0;
  let risksAccepted = 0;
  let maxOpenRiskScore = 0;
  const openHighRisks: Risk[] = [];
  for (const r of st.risks) {
    if (r.status === "mitigated") risksMitigated++;
    else if (r.status === "realized") risksOccurred++;
    else if (r.status === "accepted") risksAccepted++;
    else if (r.status === "open") {
      risksOpen++;
      const score = riskScore(r);
      if (score > maxOpenRiskScore) maxOpenRiskScore = score;
      if (score >= 8) openHighRisks.push(r);
    }
  }

  let criteriaPassing = 0;
  let criteriaFailing = 0;
  let criteriaPending = 0;
  let criteriaUnverifiable = 0;
  for (const c of st.criteria) {
    if (c.status === "passing") criteriaPassing++;
    else if (c.status === "failing") criteriaFailing++;
    else if (c.status === "pending") criteriaPending++;
    else if (c.status === "unverifiable") criteriaUnverifiable++;
  }

  let childCompleted = 0;
  let childFailed = 0;
  let childRunning = 0;
  for (const cs of st.childSessions) {
    if (cs.status === "completed") childCompleted++;
    else if (cs.status === "failed") childFailed++;
    else if (cs.status === "running" || cs.status === "pending") childRunning++;
  }

  const total = st.steps.length;
  return {
    total,
    completed,
    inProgress,
    pending,
    skipped,
    failed,
    done: completed + skipped,
    pct: total > 0 ? Math.round((completed / total) * 100) : 0,
    nextPending,
    totalEstimatedMin,
    firstStepStart,
    settledCompletedCount,
    settledCompletedMs,
    looseCompletedStartedAt,
    settledActualMin,
    runningStartedAt,
    riskTotal: st.risks.length,
    risksMitigated,
    risksOccurred,
    risksOpen,
    risksAccepted,
    maxOpenRiskScore,
    openHighRisks,
    criteriaTotal: st.criteria.length,
    criteriaPassing,
    criteriaFailing,
    criteriaPending,
    criteriaUnverifiable,
    childTotal: st.childSessions.length,
    childCompleted,
    childFailed,
    childRunning,
  };
}

const aggregatesCache = new WeakMap<PlanState, { key: string; agg: PlanAggregates }>();

function aggregatesOf(st: PlanState): PlanAggregates {
  // st.updatedAt is the plan's change token (every mutating tool bumps it).
  // The array lengths ride along so a step/risk/criterion/child added in the
  // same Date.now() millisecond as the previous bump still invalidates.
  const key = `${st.updatedAt}|${st.steps.length}|${st.risks.length}|${st.criteria.length}|${st.childSessions.length}`;
  const hit = aggregatesCache.get(st);
  if (hit && hit.key === key) return hit.agg;
  const agg = computeAggregates(st);
  aggregatesCache.set(st, { key, agg });
  return agg;
}

function statusText(st: PlanState): string {
  const now = Date.now();
  const elapsedMin = Math.max(0, Math.round((now - st.createdAt) / 60000));
  const { completed, total, pct } = aggregatesOf(st);

  const lines = [
    `${MARK} Plan (${STATUS_LABEL[st.status]})`,
    `Task: ${st.task}`,
    `Phase: ${STATUS_LABEL[st.status]} (planning)`,
    `Approval: ${st.approvalStatus}`,
    `Progress: ${completed}/${total} steps complete (${pct}%) · ${elapsedMin} min elapsed`,
  ];
  if (st.costEstimate) {
    const ce = st.costEstimate;
    const estCost = `$${ce.estimatedCostUsd.toFixed(4)}`;
    const actualCost = ce.actualCostUsd !== undefined ? `$${ce.actualCostUsd.toFixed(4)}` : "—";
    lines.push(
      `Cost: ~${ce.estimatedCostUsd.toFixed(4)} est (${ce.inputTokens.toLocaleString()} in / ${ce.outputTokens.toLocaleString()} out) · actual ${actualCost}`,
    );
  }
  lines.push(`Version: ${st.version}`);
  if (st.approvedAt) {
    const approvedBy = st.approvedBy ? ` by ${st.approvedBy}` : "";
    lines.push(`Approved: ${new Date(st.approvedAt).toISOString()}${approvedBy}`);
  }
  if (st.childSessions.length > 0) {
    lines.push(`Child sessions: ${st.childSessions.map((cs) => `${cs.sessionID} (${cs.status})`).join(", ")}`);
  }
  if (st.steps.length > 0) {
    const stepLines = st.steps.map((s, i) => {
      const icon = s.status === "complete" ? "✓" : s.status === "in_progress" ? "→" : s.status === "failed" ? "✗" : s.status === "skipped" ? "○" : "·";
      const conf = s.confidence ?? "medium";
      const confIcon = confidenceIcon(conf);
      let line = `  ${icon} Step ${i + 1}: ${s.description} [${confIcon} ${conf}]`;
      if (s.error) line += ` — ${truncate(s.error, 80)}`;
      const links: string[] = [];
      if (s.linkedDecisions && s.linkedDecisions.length > 0) links.push(`decisions: ${s.linkedDecisions.join(", ")}`);
      if (s.linkedErrors && s.linkedErrors.length > 0) links.push(`errors: ${s.linkedErrors.join(", ")}`);
      if (s.linkedSnippets && s.linkedSnippets.length > 0) links.push(`snippets: ${s.linkedSnippets.join(", ")}`);
      if (links.length > 0) line += ` [${links.join("; ")}]`;
      if (s.comments && s.comments.length > 0) {
        line += ` (${s.comments.length} comment${s.comments.length > 1 ? "s" : ""})`;
      }
      return line;
    });
    // Insert sub-step lines after parent steps
    const finalStepLines: string[] = [];
    for (let i = 0; i < st.steps.length; i++) {
      finalStepLines.push(stepLines[i]);
      const s = st.steps[i];
      if (s.isParent && s.subSteps && s.subSteps.length > 0) {
        for (const subId of s.subSteps) {
          // PL-3: subSteps hold step IDs; resolve to the current list.
          const subIdx = stepIndexOf(st.steps, subId);
          const subStep = subIdx >= 0 ? st.steps[subIdx] : undefined;
          if (!subStep) continue;
          const subIcon = subStep.status === "complete" ? "✓" : subStep.status === "in_progress" ? "→" : subStep.status === "failed" ? "✗" : subStep.status === "skipped" ? "○" : "·";
          const subConf = subStep.confidence ?? "medium";
          const subConfIcon = confidenceIcon(subConf);
          let subLine = `    ${subIcon} Step ${subIdx + 1}: ${subStep.description} [${subConfIcon} ${subConf}]`;
          if (subStep.error) subLine += ` — ${truncate(subStep.error, 80)}`;
          const subLinks: string[] = [];
          if (subStep.linkedDecisions && subStep.linkedDecisions.length > 0) subLinks.push(`decisions: ${subStep.linkedDecisions.join(", ")}`);
          if (subStep.linkedErrors && subStep.linkedErrors.length > 0) subLinks.push(`errors: ${subStep.linkedErrors.join(", ")}`);
          if (subStep.linkedSnippets && subStep.linkedSnippets.length > 0) subLinks.push(`snippets: ${subStep.linkedSnippets.join(", ")}`);
          if (subLinks.length > 0) subLine += ` [${subLinks.join("; ")}]`;
          finalStepLines.push(subLine);
        }
      }
    }
    lines.push(`Steps:\n${finalStepLines.join("\n")}`);
    lines.push(`Plan confidence: ${confidenceSummary(st.steps)} (✓ high · – medium · ✗ low)`);
    // PL-14: keep the ORIGINAL step numbers — map first, then filter, so the
    // numbering doesn't shift when un-started steps drop out.
    const durationLines = st.steps
      .map((s, i) => ({ s, n: i + 1 }))
      .filter(({ s }) => s.startedAt)
      .map(({ s, n }) => {
        const end = s.completedAt ?? now;
        const durMin = Math.max(0, Math.round((end - (s.startedAt ?? end)) / 60000));
        return `  Step ${n}: ${durMin} min`;
      });
    if (durationLines.length > 0) {
      lines.push(`Step durations:\n${durationLines.join("\n")}`);
    }
  }
  if (st.blockedReason) lines.push(`Blocked: ${st.blockedReason}`);
  if (st.stoppedReason) lines.push(`Stopped: ${st.stoppedReason}`);
  if (st.lastSummary) lines.push(`Last summary: ${st.lastSummary}`);
  if (st.risks.length > 0) {
    const open = st.risks.filter((r) => r.status === "open");
    const high = open.filter((r) => riskScore(r) >= 8);
    lines.push(`Risks: ${open.length} open (${high.length} high-risk)`);
  }
  if (st.research && st.research.length > 0) {
    const totalSources = st.research.reduce((sum, r) => sum + r.sources.length, 0);
    lines.push(`Research: ${st.research.length} queries, ${totalSources} sources`);
  }
  if (st.phaseApprovals.length > 0) {
    const approved = st.phaseApprovals.filter((p) => p.status === "approved").length;
    const pending = st.phaseApprovals.filter((p) => p.status === "pending").length;
    lines.push(`Phase approvals: ${approved}/${st.phaseApprovals.length} approved, ${pending} pending`);
  }
  if (st.checkpoints.length > 0) {
    lines.push(`Checkpoints: ${st.checkpoints.length} recorded`);
  }
  if (st.projects && st.projects.length > 0) {
    lines.push(`Linked projects: ${st.projects.map((p) => `${p.name} (${p.relationship})`).join(", ")}`);
  }
  return lines.join("\n");
}

function planExport(st: PlanState, format: "markdown" | "json" | "mermaid" | "github" = "markdown"): string {
  if (format === "json") {
    return JSON.stringify(st, null, 2);
  }
  if (format === "mermaid") {
    const lines: string[] = ["graph TD"];
    for (const [i, s] of st.steps.entries()) {
      const desc = s.description.replace(/"/g, '\\"');
      lines.push(`  step${i + 1}["Step ${i + 1}: ${desc}"]`);
    }
    for (let i = 0; i < st.steps.length; i++) {
      // PL-3: dependsOn holds step IDs; resolve to current step numbers.
      for (const dep of resolvedDeps(st.steps, i)) {
        lines.push(`  step${dep + 1} --> step${i + 1}`);
      }
    }
    return lines.join("\n");
  }
  if (format === "github") {
    const lines: string[] = [
      "## Task",
      st.task,
      "",
      "## Plan",
    ];
    const now = Date.now();
    for (const [i, s] of st.steps.entries()) {
      const icon = s.status === "complete" ? "✓" : s.status === "in_progress" ? "→" : s.status === "failed" ? "✗" : s.status === "skipped" ? "○" : "·";
      lines.push(`${i + 1}. ${icon} ${s.description}`);
      if (s.result) lines.push(`   - Result: ${s.result}`);
      if (s.error) lines.push(`   - Error: ${s.error}`);
      if (s.startedAt) {
        const end = s.completedAt ?? now;
        const durMin = Math.max(0, Math.round((end - s.startedAt) / 60000));
        lines.push(`   - Duration: ${durMin} min`);
      }
    }
    lines.push("", "## Steps", "");
    for (const [i, s] of st.steps.entries()) {
      const checked = s.status === "complete" || s.status === "skipped" ? "x" : " ";
      lines.push(`- [${checked}] Step ${i + 1}: ${s.description}`);
    }
    if (st.risks.length > 0) {
      lines.push("", "## Risks", "");
      for (const r of st.risks) {
        lines.push(`- ${r.description} (L${r.likelihood}×I${r.impact} — ${r.status})`);
      }
    }
    if (st.criteria.length > 0) {
      lines.push("", "## Success Criteria", "");
      for (const c of st.criteria) {
        lines.push(`- ${c.description} (${c.metric})`);
      }
    }
    return lines.join("\n");
  }
  // markdown (default)
  const now = Date.now();
  const lines: string[] = [
    `# Plan: ${st.task}`,
    "",
    `**Status:** ${STATUS_LABEL[st.status]}`,
    `**Approval:** ${st.approvalStatus}`,
    `**Created:** ${new Date(st.createdAt).toISOString()}`,
    `**Version:** ${st.version}`,
    "",
    "## Steps",
    "",
  ];
  for (const [i, s] of st.steps.entries()) {
    const icon = s.status === "complete" ? "✓" : s.status === "in_progress" ? "→" : s.status === "failed" ? "✗" : s.status === "skipped" ? "○" : "·";
    lines.push(`${i + 1}. ${icon} ${s.description}`);
    if (s.result) lines.push(`   - Result: ${s.result}`);
    if (s.error) lines.push(`   - Error: ${s.error}`);
    if (s.startedAt) {
      const end = s.completedAt ?? now;
      const durMin = Math.max(0, Math.round((end - s.startedAt) / 60000));
      lines.push(`   - Duration: ${durMin} min`);
    }
  }
  if (st.risks.length > 0) {
    lines.push("", "## Risks", "");
    for (const r of st.risks) {
      lines.push(`- **${r.description}** (L${r.likelihood}/I${r.impact} — ${r.status})`);
      if (r.mitigation) lines.push(`  - Mitigation: ${r.mitigation}`);
      if (r.contingency) lines.push(`  - Contingency: ${r.contingency}`);
    }
  }
  if (st.research && st.research.length > 0) {
    lines.push("", "## Research", "");
    for (const r of st.research) {
      lines.push(`### ${r.query}`);
      lines.push(r.summary);
      if (r.keyFindings.length > 0) {
        lines.push("");
        for (const f of r.keyFindings) lines.push(`- ${f}`);
      }
      lines.push("");
    }
  }
  if (st.criteria.length > 0) {
    lines.push("## Success Criteria", "");
    for (const c of st.criteria) {
      const icon = c.status === "passing" ? "✓" : c.status === "failing" ? "✗" : c.status === "unverifiable" ? "?" : "·";
      lines.push(`- ${icon} ${c.description} (${c.metric}) — ${c.status}`);
      if (c.result) lines.push(`  - Result: ${c.result}`);
    }
  }
  if (st.costEstimate) {
    const ce = st.costEstimate;
    lines.push("", "## Cost", "");
    lines.push(`- Estimated: $${ce.estimatedCostUsd.toFixed(4)}`);
    if (ce.actualCostUsd !== undefined) {
      lines.push(`- Actual: $${ce.actualCostUsd.toFixed(4)}`);
    }
  }
  return lines.join("\n");
}

function costText(st: PlanState): string {
  const ce = st.costEstimate;
  if (!ce) return `${MARK} No cost estimate available.`;
  const lines = [
    `${MARK} Cost Estimate`,
    `Estimated: $${ce.estimatedCostUsd.toFixed(4)} (${ce.inputTokens.toLocaleString()} input / ${ce.outputTokens.toLocaleString()} output tokens)`,
    `Estimated at: ${new Date(ce.estimatedAt).toISOString()}`,
  ];
  if (ce.actualCostUsd !== undefined) {
    const diff = ce.actualCostUsd - ce.estimatedCostUsd;
    const pct = ce.estimatedCostUsd > 0 ? ((diff / ce.estimatedCostUsd) * 100).toFixed(1) : "0.0";
    lines.push(
      `Actual: $${ce.actualCostUsd.toFixed(4)} (${(ce.actualInputTokens ?? 0).toLocaleString()} input / ${(ce.actualOutputTokens ?? 0).toLocaleString()} output tokens)`,
    );
    lines.push(`Variance: ${diff >= 0 ? "+" : ""}$${diff.toFixed(4)} (${pct}%)`);
  } else {
    lines.push("Actual: not yet available");
  }
  return lines.join("\n");
}

function metricsText(st: PlanState): string {
  const now = Date.now();
  const a = aggregatesOf(st);
  const lines: string[] = [
    `${MARK} Plan Metrics & Analytics`,
    ``,
  ];

  // --- Step counts ---
  const { total, completed, inProgress, pending, skipped, failed, pct } = a;

  lines.push(`## Steps`);
  lines.push(`  Total:     ${total}`);
  lines.push(`  Completed: ${completed}`);
  lines.push(`  In progress: ${inProgress}`);
  lines.push(`  Pending:   ${pending}`);
  lines.push(`  Skipped:   ${skipped}`);
  lines.push(`  Failed:    ${failed}`);
  lines.push(`  Completion: ${pct}%`);
  lines.push(``);

  // --- Duration ---
  // Settled durations come from the cache; only the still-running steps and the
  // rare complete-without-completedAt ones need the current clock.
  const completedStepCount = a.settledCompletedCount + a.looseCompletedStartedAt.length;
  let completedDurationMs = a.settledCompletedMs;
  for (const startedAt of a.looseCompletedStartedAt) completedDurationMs += Math.max(0, now - startedAt);
  const avgDurationMin =
    completedStepCount > 0 ? Math.round((completedDurationMs / completedStepCount / 60000) * 10) / 10 : 0;

  const totalEstimatedMin = a.totalEstimatedMin;
  let totalActualMin = a.settledActualMin;
  for (const startedAt of a.runningStartedAt) totalActualMin += Math.max(0, Math.round((now - startedAt) / 60000));

  lines.push(`## Duration`);
  lines.push(`  Avg step duration: ${avgDurationMin} min (${completedStepCount} completed steps)`);
  lines.push(`  Total estimated:  ${totalEstimatedMin} min`);
  lines.push(`  Total actual:     ${totalActualMin} min`);
  if (totalEstimatedMin > 0) {
    const variancePct = Math.round(((totalActualMin - totalEstimatedMin) / totalEstimatedMin) * 100);
    const varianceStr =
      variancePct > 0
        ? `+${variancePct}% over estimate`
        : variancePct < 0
          ? `${variancePct}% under estimate`
          : "on target";
    lines.push(`  Variance:         ${varianceStr}`);
  }
  lines.push(``);

  // --- Tokens & Cost ---
  const ce = st.costEstimate;
  const estInputTokens = ce?.inputTokens ?? 0;
  const estOutputTokens = ce?.outputTokens ?? 0;
  const estCost = ce?.estimatedCostUsd ?? 0;
  const actualInputTokens = ce?.actualInputTokens ?? 0;
  const actualOutputTokens = ce?.actualOutputTokens ?? 0;
  const actualCost = ce?.actualCostUsd ?? 0;
  const totalTokens = actualInputTokens + actualOutputTokens;

  lines.push(`## Tokens & Cost`);
  lines.push(`  Estimated tokens: ${estInputTokens.toLocaleString()} in / ${estOutputTokens.toLocaleString()} out`);
  lines.push(`  Actual tokens:   ${actualInputTokens.toLocaleString()} in / ${actualOutputTokens.toLocaleString()} out`);
  lines.push(`  Total tokens:    ${totalTokens.toLocaleString()}`);
  lines.push(`  Estimated cost:  $${estCost.toFixed(4)}`);
  lines.push(`  Actual cost:     $${actualCost.toFixed(4)}`);
  if (estCost > 0 && actualCost > 0) {
    const costVariance = actualCost - estCost;
    const costPct = Math.round((costVariance / estCost) * 100);
    lines.push(`  Cost variance:   ${costVariance >= 0 ? "+" : ""}$${costVariance.toFixed(4)} (${costPct >= 0 ? "+" : ""}${costPct}%)`);
  }
  lines.push(``);

  // --- Child sessions ---
  lines.push(`## Child Sessions`);
  lines.push(`  Spawned:   ${a.childTotal}`);
  lines.push(`  Completed: ${a.childCompleted}`);
  lines.push(`  Running:   ${a.childRunning}`);
  lines.push(`  Failed:    ${a.childFailed}`);
  lines.push(``);

  // --- Risks ---
  lines.push(`## Risks`);
  lines.push(`  Identified: ${a.riskTotal}`);
  lines.push(`  Mitigated:  ${a.risksMitigated}`);
  lines.push(`  Occurred:   ${a.risksOccurred}`);
  lines.push(`  Open:       ${a.risksOpen}`);
  lines.push(`  Accepted:   ${a.risksAccepted}`);
  lines.push(``);

  // --- Success criteria ---
  lines.push(`## Success Criteria`);
  lines.push(`  Defined:      ${a.criteriaTotal}`);
  lines.push(`  Passed:       ${a.criteriaPassing}`);
  lines.push(`  Failed:       ${a.criteriaFailing}`);
  lines.push(`  Pending:      ${a.criteriaPending}`);
  lines.push(`  Unverifiable: ${a.criteriaUnverifiable}`);
  lines.push(``);

  // --- Time ---
  const planAgeMs = now - st.createdAt;
  const planAgeMin = Math.round((planAgeMs / 60000) * 10) / 10;
  const firstStepStart = a.firstStepStart;
  const executionTimeMin =
    firstStepStart !== undefined ? Math.round(((now - firstStepStart) / 60000) * 10) / 10 : 0;

  lines.push(`## Time`);
  lines.push(`  Plan age:        ${planAgeMin} min`);
  lines.push(`  Execution time:  ${executionTimeMin} min${firstStepStart === undefined ? " (no steps started)" : ""}`);
  lines.push(``);

  // --- Plan info ---
  lines.push(`## Plan Info`);
  lines.push(`  Status:     ${STATUS_LABEL[st.status]}`);
  lines.push(`  Version:    ${st.version}`);
  lines.push(`  Created:    ${new Date(st.createdAt).toISOString()}`);
  if (st.approvedAt) lines.push(`  Approved:   ${new Date(st.approvedAt).toISOString()}`);
  if (st.completedAt) lines.push(`  Completed:  ${new Date(st.completedAt).toISOString()}`);

  return lines.join("\n");
}

function optimizeText(st: PlanState): string {
  const ce = st.costEstimate;
  const lines: string[] = [
    `${MARK} Cost Optimization Report`,
    ``,
  ];

  // --- Current Costs ---
  lines.push(`## Current Costs`);
  if (!ce) {
    lines.push(`  No cost estimate available.`);
  } else {
    const estCost = ce.estimatedCostUsd;
    const actualCost = ce.actualCostUsd;
    const inputTokens = ce.actualInputTokens ?? ce.inputTokens;
    const outputTokens = ce.actualOutputTokens ?? ce.outputTokens;
    const totalTokens = inputTokens + outputTokens;
    lines.push(`  Input tokens:  ${inputTokens.toLocaleString()}`);
    lines.push(`  Output tokens: ${outputTokens.toLocaleString()}`);
    lines.push(`  Total tokens:  ${totalTokens.toLocaleString()}`);
    lines.push(`  Estimated cost: $${estCost.toFixed(4)}`);
    if (actualCost !== undefined) {
      lines.push(`  Actual cost:    $${actualCost.toFixed(4)}`);
      const diff = actualCost - estCost;
      const pct = estCost > 0 ? ((diff / estCost) * 100).toFixed(1) : "0.0";
      lines.push(`  Variance:       ${diff >= 0 ? "+" : ""}$${diff.toFixed(4)} (${pct}%)`);
    }
  }
  lines.push(``);

  // --- Recommendations ---
  lines.push(`## Recommendations`);
  const recommendations: string[] = [];
  let potentialSavingsTokens = 0;
  let potentialSavingsCost = 0;

  if (st.steps.length === 0) {
    lines.push(`  No steps to analyze.`);
  } else {
    // 1. Steps with high token usage relative to description length
    const avgDescLen = st.steps.reduce((sum, s) => sum + s.description.length, 0) / st.steps.length;
    // Indexed collection: indexOf() inside a map() is O(n) per element, which
    // made this whole report O(n^2) on long plans.
    const longStepNums: number[] = [];
    for (let i = 0; i < st.steps.length; i++) {
      if (st.steps[i].description.length > avgDescLen * 2) longStepNums.push(i + 1);
    }
    if (longStepNums.length > 0) {
      const stepNums = longStepNums.map((n) => `Step ${n}`).join(", ");
      recommendations.push(
        `Steps with unusually long descriptions (${stepNums}) — consider splitting into smaller, more focused steps to reduce per-step token overhead.`,
      );
    }

    // 2. Steps that could be merged (similar descriptions)
    const mergeCandidates: Array<[number, number]> = [];
    for (let i = 0; i < st.steps.length; i++) {
      for (let j = i + 1; j < st.steps.length; j++) {
        const descI = st.steps[i].description.toLowerCase();
        const descJ = st.steps[j].description.toLowerCase();
        const wordsI = new Set(descI.split(/\s+/).filter((w) => w.length > 3));
        const wordsJ = new Set(descJ.split(/\s+/).filter((w) => w.length > 3));
        const shared = [...wordsI].filter((w) => wordsJ.has(w));
        const similarity = shared.length / Math.max(wordsI.size, wordsJ.size, 1);
        if (similarity >= 0.5) {
          mergeCandidates.push([i, j]);
        }
      }
    }
    if (mergeCandidates.length > 0) {
      for (const [i, j] of mergeCandidates) {
        recommendations.push(
          `Step ${i + 1} and Step ${j + 1} have similar descriptions — consider merging: "${truncate(st.steps[i].description, 40)}" + "${truncate(st.steps[j].description, 40)}"`,
        );
        potentialSavingsTokens += 500;
        potentialSavingsCost += 0.01;
      }
    }

    // 3. Steps that could run in parallel but are currently sequential
    const parallelizable: Array<[number, number]> = [];
    for (let i = 0; i < st.steps.length; i++) {
      for (let j = i + 1; j < st.steps.length; j++) {
        // PL-3: dependsOn holds step IDs.
        const depsI = st.steps[i].dependsOn ?? [];
        const depsJ = st.steps[j].dependsOn ?? [];
        if (!depsI.includes(st.steps[j].id) && !depsJ.includes(st.steps[i].id)) {
          parallelizable.push([i, j]);
        }
      }
    }
    if (parallelizable.length > 0) {
      const pairs = parallelizable.slice(0, 5).map(([i, j]) => `Steps ${i + 1}-${j + 1}`);
      recommendations.push(
        `${parallelizable.length} step pairs have no dependencies and could run in parallel: ${pairs.join(", ")}`,
      );
      potentialSavingsTokens += parallelizable.length * 300;
      potentialSavingsCost += parallelizable.length * 0.005;
    }

    // 4. Steps with low confidence that might need re-planning
    const lowConfStepNums: number[] = [];
    for (let i = 0; i < st.steps.length; i++) {
      if (st.steps[i].confidence === "low") lowConfStepNums.push(i + 1);
    }
    if (lowConfStepNums.length > 0) {
      const stepNums = lowConfStepNums.map((n) => `Step ${n}`).join(", ");
      recommendations.push(
        `Steps with low confidence (${stepNums}) — consider re-planning before execution to avoid costly retries.`,
      );
      potentialSavingsTokens += lowConfStepNums.length * 1000;
      potentialSavingsCost += lowConfStepNums.length * 0.02;
    }

    // 5. Skipped steps that might be unnecessary
    const skippedStepNums: number[] = [];
    for (let i = 0; i < st.steps.length; i++) {
      if (st.steps[i].status === "skipped") skippedStepNums.push(i + 1);
    }
    if (skippedStepNums.length > 0) {
      const stepNums = skippedStepNums.map((n) => `Step ${n}`).join(", ");
      recommendations.push(
        `${skippedStepNums.length} step(s) were skipped (${stepNums}) — consider removing them from the plan to reduce clutter.`,
      );
    }
  }

  if (recommendations.length === 0) {
    lines.push(`  No optimization opportunities found. The plan looks efficient.`);
  } else {
    for (let i = 0; i < recommendations.length; i++) {
      lines.push(`  ${i + 1}. ${recommendations[i]}`);
    }
  }
  lines.push(``);

  // --- Potential Savings ---
  lines.push(`## Potential Savings`);
  if (potentialSavingsTokens > 0 || potentialSavingsCost > 0) {
    lines.push(`  Token savings: ~${potentialSavingsTokens.toLocaleString()} tokens`);
    lines.push(`  Cost savings:  ~$${potentialSavingsCost.toFixed(4)}`);
    if (ce && ce.estimatedCostUsd > 0) {
      const savingsPct = Math.round((potentialSavingsCost / ce.estimatedCostUsd) * 100);
      lines.push(`  Savings as % of estimated cost: ~${savingsPct}%`);
    }
  } else {
    lines.push(`  No significant savings identified.`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------- learning */

function learnText(st: PlanState): string {
  const now = Date.now();
  const lines: string[] = [
    `${MARK} Plan Learning Report`,
    ``,
  ];

  // --- Duration analysis: steps that took longer than estimated ---
  const overdueSteps: Array<{ step: number; desc: string; est: number; actual: number }> = [];
  for (const [i, s] of st.steps.entries()) {
    if (!s.startedAt) continue;
    const end = s.completedAt ?? now;
    const actualMin = Math.max(0, Math.round((end - s.startedAt) / 60000));
    const estMin = s.estimatedDurationMin ?? estimateDuration(s.description);
    if (actualMin > estMin * 1.5 && actualMin > estMin + 5) {
      overdueSteps.push({ step: i + 1, desc: s.description, est: estMin, actual: actualMin });
    }
  }
  if (overdueSteps.length > 0) {
    lines.push(`## Steps That Took Longer Than Estimated`);
    for (const o of overdueSteps) {
      const ratio = o.est > 0 ? (o.actual / o.est).toFixed(1) : "?";
      lines.push(`  - Step ${o.step}: ${truncate(o.desc, 60)} — ${o.actual} min actual vs ${o.est} min estimated (${ratio}x)`);
    }
    lines.push(``);
  }

  // --- Failure analysis ---
  const failedSteps = st.steps.filter((s) => s.status === "failed");
  if (failedSteps.length > 0) {
    lines.push(`## Failed Steps`);
    for (const s of failedSteps) {
      lines.push(`  - Step ${st.steps.indexOf(s) + 1}: ${truncate(s.description, 60)}`);
      if (s.error) lines.push(`    Error: ${truncate(s.error, 100)}`);
    }
    lines.push(``);
  }

  // --- Dependency problems ---
  // PL-3: dependsOn holds step IDs; resolve them via id lookup.
  const depProblemSteps = st.steps.filter((s) => {
    if (s.status !== "failed" && s.status !== "complete") return false;
    return (s.dependsOn ?? []).some((d) => {
      const dep = st.steps.find((x) => x.id === d);
      return dep && dep.status === "failed";
    });
  });
  if (depProblemSteps.length > 0) {
    lines.push(`## Dependency Problems`);
    for (const s of depProblemSteps) {
      const failedDeps = (s.dependsOn ?? [])
        .map((d) => ({ d, idx: stepIndexOf(st.steps, d) }))
        .filter(({ idx }) => idx >= 0 && st.steps[idx].status === "failed")
        .map(({ idx }) => `Step ${idx + 1}`);
      lines.push(`  - Step ${st.steps.indexOf(s) + 1}: ${truncate(s.description, 60)} — depends on failed: ${failedDeps.join(", ")}`);
    }
    lines.push(``);
  }

  // --- Risks that materialized ---
  const realizedRisks = st.risks.filter((r) => r.status === "realized");
  if (realizedRisks.length > 0) {
    lines.push(`## Risks That Materialized`);
    for (const r of realizedRisks) {
      lines.push(`  - ${r.description} (L${r.likelihood}×I${r.impact})`);
    }
    lines.push(``);
  }

  // --- Success criteria difficulties ---
  const difficultCriteria = st.criteria.filter((c) => c.status === "failing" || c.status === "unverifiable" || c.attempts > 1);
  if (difficultCriteria.length > 0) {
    lines.push(`## Success Criteria Difficulties`);
    for (const c of difficultCriteria) {
      lines.push(`  - ${c.description} (${c.metric}) — ${c.status}, ${c.attempts} attempt(s)`);
      if (c.result) lines.push(`    Result: ${truncate(c.result, 100)}`);
    }
    lines.push(``);
  }

  // --- Generate insights ---
  const insights: string[] = [];

  if (overdueSteps.length > 0) {
    const categories = new Set<string>();
    for (const o of overdueSteps) {
      const desc = o.desc.toLowerCase();
      if (desc.includes("database") || desc.includes("schema") || desc.includes("migration")) categories.add("database changes");
      if (desc.includes("api") || desc.includes("endpoint") || desc.includes("integration")) categories.add("API integration");
      if (desc.includes("auth") || desc.includes("login") || desc.includes("oauth")) categories.add("authentication");
      if (desc.includes("test") || desc.includes("spec")) categories.add("testing");
      if (desc.includes("deploy") || desc.includes("release")) categories.add("deployment");
      if (desc.includes("refactor")) categories.add("refactoring");
    }
    if (categories.size > 0) {
      insights.push(`Steps involving ${[...categories].join(", ")} took longer than estimated`);
    } else {
      insights.push(`${overdueSteps.length} step(s) took significantly longer than estimated`);
    }
  }

  if (failedSteps.length > 0) {
    const lowConfFailed = failedSteps.filter((s) => s.confidence === "low");
    if (lowConfFailed.length > 0) {
      insights.push(`Steps with low confidence are more likely to fail (${lowConfFailed.length} of ${failedSteps.length} failures)`);
    }
    const authFailures = failedSteps.filter((s) => {
      const err = (s.error ?? "").toLowerCase();
      const desc = s.description.toLowerCase();
      return err.includes("auth") || err.includes("token") || err.includes("credential") || desc.includes("auth") || desc.includes("login");
    });
    if (authFailures.length > 0) {
      insights.push("API integration steps frequently fail due to authentication issues");
    }
  }

  if (realizedRisks.length > 0) {
    insights.push(`${realizedRisks.length} identified risk(s) materialized during execution`);
  }

  if (difficultCriteria.length > 0) {
    insights.push(`${difficultCriteria.length} success criterion/criteria were difficult to meet`);
  }

  // Parallel execution insight
  const schedule = computeSchedule(st.steps);
  const parallelGroups = schedule.groups.filter((g) => g.parallel);
  if (parallelGroups.length > 0) {
    insights.push(`Parallel execution of independent steps saved ~${Math.min(50, parallelGroups.length * 10)}% total time`);
  }

  if (insights.length === 0) {
    lines.push(`No significant insights generated. The plan executed smoothly.`);
  } else {
    lines.push(`## Insights`);
    for (const insight of insights) {
      lines.push(`  - ${insight}`);
    }
  }

  lines.push(``);
  lines.push(`Total insights: ${insights.length}`);
  return lines.join("\n");
}

// PL-12: previous-plan insights are now read through ctx.storage via the
// setup-scoped getPreviousInsights() (see the insights-index maintained in
// save()), not a hardcoded filesystem path.

/* --------------------------------------------------------- documentation */

function generateDocs(st: PlanState, format: "markdown" | "html" | "json"): string {
  const now = Date.now();
  const durationMs = st.completedAt ? st.completedAt - st.createdAt : now - st.createdAt;
  const durationMin = Math.round((durationMs / 60000) * 10) / 10;
  const ce = st.costEstimate;
  const actualCost = ce?.actualCostUsd ?? 0;
  const estimatedCost = ce?.estimatedCostUsd ?? 0;

  // Gather linked items
  const linkedDecisions: string[] = [];
  const linkedErrors: string[] = [];
  const linkedSnippets: string[] = [];
  for (const step of st.steps) {
    if (step.linkedDecisions) linkedDecisions.push(...step.linkedDecisions.map((d) => String(d)));
    if (step.linkedErrors) linkedErrors.push(...step.linkedErrors.map((e) => String(e)));
    if (step.linkedSnippets) linkedSnippets.push(...step.linkedSnippets);
  }

  if (format === "json") {
    const doc = {
      overview: {
        task: st.task,
        status: STATUS_LABEL[st.status],
        duration: `${durationMin} min`,
        cost: {
          estimated: `$${estimatedCost.toFixed(4)}`,
          actual: `$${actualCost.toFixed(4)}`,
        },
      },
      steps: st.steps.map((s, i) => ({
        step: i + 1,
        description: s.description,
        status: s.status,
        duration: s.startedAt ? `${Math.max(0, Math.round(((s.completedAt ?? now) - s.startedAt) / 60000))} min` : undefined,
        result: s.result,
      })),
      risks: st.risks.map((r) => ({
        description: r.description,
        likelihood: r.likelihood,
        impact: r.impact,
        status: r.status,
        mitigation: r.mitigation,
        contingency: r.contingency,
      })),
      successCriteria: st.criteria.map((c) => ({
        description: c.description,
        metric: c.metric,
        status: c.status,
        result: c.result,
      })),
      insights: st.insights,
      linkedItems: {
        decisions: linkedDecisions,
        errors: linkedErrors,
        snippets: linkedSnippets,
      },
    };
    return JSON.stringify(doc, null, 2);
  }

  if (format === "html") {
    const lines: string[] = [];
    lines.push(`<!DOCTYPE html>`);
    lines.push(`<html lang="en">`);
    lines.push(`<head>`);
    lines.push(`  <meta charset="UTF-8">`);
    lines.push(`  <meta name="viewport" content="width=device-width, initial-scale=1.0">`);
    lines.push(`  <title>Plan Documentation — ${escapeHtml(st.task)}</title>`);
    lines.push(`  <style>`);
    lines.push(`    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #333; }`);
    lines.push(`    h1 { color: #1a1a1a; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }`);
    lines.push(`    h2 { color: #2c2c2c; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }`);
    lines.push(`    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }`);
    lines.push(`    th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; }`);
    lines.push(`    th { background: #f5f5f5; font-weight: 600; }`);
    lines.push(`    .status-complete { color: #2e7d32; }`);
    lines.push(`    .status-failed { color: #c62828; }`);
    lines.push(`    .status-pending { color: #757575; }`);
    lines.push(`    .status-in_progress { color: #1565c0; }`);
    lines.push(`    .status-skipped { color: #ef6c00; }`);
    lines.push(`    .meta { color: #666; font-size: 0.9rem; }`);
    lines.push(`    .insight { background: #f8f9fa; border-left: 3px solid #4a90d9; padding: 0.5rem 1rem; margin: 0.5rem 0; }`);
    lines.push(`  </style>`);
    lines.push(`</head>`);
    lines.push(`<body>`);
    lines.push(`  <h1>Plan Documentation</h1>`);
    lines.push(`  <p class="meta">Generated: ${new Date(now).toISOString()}</p>`);

    // Overview
    lines.push(`  <h2>Overview</h2>`);
    lines.push(`  <table>`);
    lines.push(`    <tr><th>Task</th><td>${escapeHtml(st.task)}</td></tr>`);
    lines.push(`    <tr><th>Status</th><td>${STATUS_LABEL[st.status]}</td></tr>`);
    lines.push(`    <tr><th>Duration</th><td>${durationMin} min</td></tr>`);
    lines.push(`    <tr><th>Estimated Cost</th><td>$${estimatedCost.toFixed(4)}</td></tr>`);
    lines.push(`    <tr><th>Actual Cost</th><td>$${actualCost.toFixed(4)}</td></tr>`);
    lines.push(`  </table>`);

    // Steps
    lines.push(`  <h2>Steps</h2>`);
    if (st.steps.length === 0) {
      lines.push(`  <p>No steps defined.</p>`);
    } else {
      lines.push(`  <table>`);
      lines.push(`    <tr><th>#</th><th>Description</th><th>Status</th><th>Duration</th><th>Result</th></tr>`);
      for (const [i, s] of st.steps.entries()) {
        const dur = s.startedAt ? `${Math.max(0, Math.round(((s.completedAt ?? now) - s.startedAt) / 60000))} min` : "—";
        lines.push(`    <tr><td>${i + 1}</td><td>${escapeHtml(s.description)}</td><td class="status-${s.status}">${s.status}</td><td>${dur}</td><td>${s.result ? escapeHtml(s.result) : "—"}</td></tr>`);
      }
      lines.push(`  </table>`);
    }

    // Risks
    lines.push(`  <h2>Risks</h2>`);
    if (st.risks.length === 0) {
      lines.push(`  <p>No risks identified.</p>`);
    } else {
      lines.push(`  <table>`);
      lines.push(`    <tr><th>Description</th><th>Likelihood</th><th>Impact</th><th>Status</th><th>Mitigation</th></tr>`);
      for (const r of st.risks) {
        lines.push(`    <tr><td>${escapeHtml(r.description)}</td><td>${r.likelihood}</td><td>${r.impact}</td><td>${r.status}</td><td>${r.mitigation ? escapeHtml(r.mitigation) : "—"}</td></tr>`);
      }
      lines.push(`  </table>`);
    }

    // Success Criteria
    lines.push(`  <h2>Success Criteria</h2>`);
    if (st.criteria.length === 0) {
      lines.push(`  <p>No success criteria defined.</p>`);
    } else {
      lines.push(`  <table>`);
      lines.push(`    <tr><th>Description</th><th>Metric</th><th>Status</th><th>Result</th></tr>`);
      for (const c of st.criteria) {
        lines.push(`    <tr><td>${escapeHtml(c.description)}</td><td>${escapeHtml(c.metric)}</td><td>${c.status}</td><td>${c.result ? escapeHtml(c.result) : "—"}</td></tr>`);
      }
      lines.push(`  </table>`);
    }

    // Insights
    lines.push(`  <h2>Insights</h2>`);
    if (st.insights.length === 0) {
      lines.push(`  <p>No insights recorded.</p>`);
    } else {
      for (const insight of st.insights) {
        lines.push(`  <div class="insight">${escapeHtml(insight)}</div>`);
      }
    }

    // Linked Items
    lines.push(`  <h2>Linked Items</h2>`);
    lines.push(`  <h3>Decisions</h3>`);
    if (linkedDecisions.length === 0) {
      lines.push(`  <p>No linked decisions.</p>`);
    } else {
      lines.push(`  <ul>`);
      for (const d of linkedDecisions) lines.push(`    <li>${escapeHtml(d)}</li>`);
      lines.push(`  </ul>`);
    }
    lines.push(`  <h3>Errors</h3>`);
    if (linkedErrors.length === 0) {
      lines.push(`  <p>No linked errors.</p>`);
    } else {
      lines.push(`  <ul>`);
      for (const e of linkedErrors) lines.push(`    <li>${escapeHtml(e)}</li>`);
      lines.push(`  </ul>`);
    }
    lines.push(`  <h3>Snippets</h3>`);
    if (linkedSnippets.length === 0) {
      lines.push(`  <p>No linked snippets.</p>`);
    } else {
      lines.push(`  <ul>`);
      for (const s of linkedSnippets) lines.push(`    <li>${escapeHtml(s)}</li>`);
      lines.push(`  </ul>`);
    }

    lines.push(`</body>`);
    lines.push(`</html>`);
    return lines.join("\n");
  }

  // Markdown (default)
  const lines: string[] = [];
  lines.push(`# Plan Documentation`);
  lines.push(``);
  lines.push(`> Generated: ${new Date(now).toISOString()}`);
  lines.push(``);

  // Overview
  lines.push(`## Overview`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Task | ${st.task} |`);
  lines.push(`| Status | ${STATUS_LABEL[st.status]} |`);
  lines.push(`| Duration | ${durationMin} min |`);
  lines.push(`| Estimated Cost | $${estimatedCost.toFixed(4)} |`);
  lines.push(`| Actual Cost | $${actualCost.toFixed(4)} |`);
  lines.push(``);

  // Steps
  lines.push(`## Steps`);
  lines.push(``);
  if (st.steps.length === 0) {
    lines.push(`No steps defined.`);
  } else {
    lines.push(`| # | Description | Status | Duration | Result |`);
    lines.push(`|---|-------------|--------|----------|--------|`);
    for (const [i, s] of st.steps.entries()) {
      const dur = s.startedAt ? `${Math.max(0, Math.round(((s.completedAt ?? now) - s.startedAt) / 60000))} min` : "—";
      const result = s.result ? s.result.replace(/\|/g, "\\|") : "—";
      lines.push(`| ${i + 1} | ${s.description.replace(/\|/g, "\\|")} | ${s.status} | ${dur} | ${result} |`);
    }
  }
  lines.push(``);

  // Risks
  lines.push(`## Risks`);
  lines.push(``);
  if (st.risks.length === 0) {
    lines.push(`No risks identified.`);
  } else {
    lines.push(`| Description | Likelihood | Impact | Status | Mitigation |`);
    lines.push(`|-------------|------------|--------|--------|------------|`);
    for (const r of st.risks) {
      const mit = r.mitigation ? r.mitigation.replace(/\|/g, "\\|") : "—";
      lines.push(`| ${r.description.replace(/\|/g, "\\|")} | ${r.likelihood} | ${r.impact} | ${r.status} | ${mit} |`);
    }
  }
  lines.push(``);

  // Success Criteria
  lines.push(`## Success Criteria`);
  lines.push(``);
  if (st.criteria.length === 0) {
    lines.push(`No success criteria defined.`);
  } else {
    lines.push(`| Description | Metric | Status | Result |`);
    lines.push(`|-------------|--------|--------|--------|`);
    for (const c of st.criteria) {
      const res = c.result ? c.result.replace(/\|/g, "\\|") : "—";
      lines.push(`| ${c.description.replace(/\|/g, "\\|")} | ${c.metric.replace(/\|/g, "\\|")} | ${c.status} | ${res} |`);
    }
  }
  lines.push(``);

  // Insights
  lines.push(`## Insights`);
  lines.push(``);
  if (st.insights.length === 0) {
    lines.push(`No insights recorded.`);
  } else {
    for (const insight of st.insights) {
      lines.push(`- ${insight}`);
    }
  }
  lines.push(``);

  // Linked Items
  lines.push(`## Linked Items`);
  lines.push(``);
  lines.push(`### Decisions`);
  if (linkedDecisions.length === 0) {
    lines.push(`No linked decisions.`);
  } else {
    for (const d of linkedDecisions) lines.push(`- ${d}`);
  }
  lines.push(``);
  lines.push(`### Errors`);
  if (linkedErrors.length === 0) {
    lines.push(`No linked errors.`);
  } else {
    for (const e of linkedErrors) lines.push(`- ${e}`);
  }
  lines.push(``);
  lines.push(`### Snippets`);
  if (linkedSnippets.length === 0) {
    lines.push(`No linked snippets.`);
  } else {
    for (const s of linkedSnippets) lines.push(`- ${s}`);
  }
  lines.push(``);

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ----------------------------------------------------- test strategy */

function determineTestType(description: string): { type: string; tests: string[] } {
  const lower = description.toLowerCase();
  if (lower.includes("api") || lower.includes("endpoint")) {
    return {
      type: "integration",
      tests: ["Integration tests for API contracts", "Endpoint response validation", "Request/response schema tests"],
    };
  }
  if (lower.includes("ui") || lower.includes("component")) {
    return {
      type: "component",
      tests: ["Component unit tests", "Visual regression tests", "Accessibility tests"],
    };
  }
  if (lower.includes("database") || lower.includes("schema")) {
    return {
      type: "database",
      tests: ["Migration tests", "Data integrity tests", "Schema validation tests"],
    };
  }
  if (lower.includes("auth") || lower.includes("security")) {
    return {
      type: "security",
      tests: ["Security unit tests", "Penetration testing", "Access control verification"],
    };
  }
  if (lower.includes("refactor")) {
    return {
      type: "regression",
      tests: ["Regression test suite", "Snapshot tests", "Behavioral diff tests"],
    };
  }
  if (lower.includes("fix") || lower.includes("bug")) {
    return {
      type: "unit",
      tests: ["Unit tests for the fixed behavior", "Edge case tests", "Boundary condition tests"],
    };
  }
  return {
    type: "unit",
    tests: ["Unit tests", "Edge case coverage"],
  };
}

function testStrategyText(st: PlanState): string {
  if (st.steps.length === 0) {
    return `${MARK} No steps in the plan yet.`;
  }
  const lines: string[] = [
    `${MARK} Testing Strategy`,
    ``,
  ];

  let totalCoverage = 0;
  const typeCounts: Record<string, number> = {};

  for (const [i, s] of st.steps.entries()) {
    const { type, tests } = determineTestType(s.description);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    const coverage = Math.min(95, 60 + tests.length * 10 + (s.confidence === "high" ? 5 : s.confidence === "low" ? -5 : 0));
    totalCoverage += coverage;

    lines.push(`## Step ${i + 1}: ${truncate(s.description, 60)}`);
    lines.push(`  Test type: ${type}`);
    lines.push(`  Estimated coverage: ${coverage}%`);
    lines.push(`  Recommendations:`);
    for (const t of tests) {
      lines.push(`    - ${t}`);
    }
    lines.push(``);
  }

  const avgCoverage = Math.round(totalCoverage / st.steps.length);
  lines.push(`## Summary`);
  lines.push(`  Steps analyzed: ${st.steps.length}`);
  lines.push(`  Average estimated coverage: ${avgCoverage}%`);
  lines.push(`  Test type breakdown:`);
  for (const [type, count] of Object.entries(typeCounts)) {
    lines.push(`    ${type}: ${count} step(s)`);
  }

  return lines.join("\n");
}

function shareText(st: PlanState, tool?: "jira" | "linear" | "github" | "slack"): string {
  const lines: string[] = [];
  const completed = st.steps.filter((s) => s.status === "complete").length;
  const total = st.steps.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  if (!tool) {
    // Generic shareable summary
    lines.push(`# Plan: ${st.task}`);
    lines.push(``);
    lines.push(`**Status:** ${STATUS_LABEL[st.status]}`);
    lines.push(`**Progress:** ${completed}/${total} steps complete (${pct}%)`);
    lines.push(`**Approval:** ${st.approvalStatus}`);
    lines.push(``);
    lines.push(`## Steps`);
    for (const [i, s] of st.steps.entries()) {
      const icon = s.status === "complete" ? "✓" : s.status === "in_progress" ? "→" : s.status === "failed" ? "✗" : s.status === "skipped" ? "○" : "·";
      lines.push(`${icon} ${i + 1}. ${s.description}`);
    }
    if (st.risks.length > 0) {
      lines.push(``);
      lines.push(`## Risks`);
      for (const r of st.risks) {
        lines.push(`- **${r.description}** (${riskLevel(riskScore(r))}) — ${r.mitigation}`);
      }
    }
    return lines.join("\n");
  }

  switch (tool) {
    case "jira": {
      lines.push(`## Summary`);
      lines.push(st.task);
      lines.push(``);
      lines.push(`## Description`);
      lines.push(`Plan status: ${STATUS_LABEL[st.status]}`);
      lines.push(`Progress: ${completed}/${total} steps complete (${pct}%)`);
      lines.push(`Approval: ${st.approvalStatus}`);
      lines.push(``);
      lines.push(`## Acceptance Criteria`);
      for (const [i, s] of st.steps.entries()) {
        lines.push(`- [ ] ${s.description}`);
      }
      if (st.criteria.length > 0) {
        lines.push(``);
        lines.push(`## Success Criteria`);
        for (const c of st.criteria) {
          // PL-13: c is a SuccessCriterion — render its description, not the
          // object interpolation ("[object Object]").
          lines.push(`- ${c.description} (${c.status})`);
        }
      }
      return lines.join("\n");
    }
    case "linear": {
      lines.push(`**Title:** ${st.task}`);
      lines.push(``);
      lines.push(`**Description:**`);
      lines.push(`Plan status: ${STATUS_LABEL[st.status]}`);
      lines.push(`Progress: ${completed}/${total} steps complete (${pct}%)`);
      lines.push(``);
      lines.push(`**Labels:** plan, ${st.status}`);
      lines.push(``);
      lines.push(`**Tasks:**`);
      for (const [i, s] of st.steps.entries()) {
        lines.push(`- [ ] ${s.description}`);
      }
      return lines.join("\n");
    }
    case "github": {
      lines.push(`## ${st.task}`);
      lines.push(``);
      lines.push(`**Status:** ${STATUS_LABEL[st.status]}`);
      lines.push(`**Progress:** ${completed}/${total} steps complete (${pct}%)`);
      lines.push(``);
      lines.push(`## Tasks`);
      for (const [i, s] of st.steps.entries()) {
        const icon = s.status === "complete" ? "x" : " ";
        lines.push(`- [${icon}] ${s.description}`);
      }
      if (st.risks.length > 0) {
        lines.push(``);
        lines.push(`## Risks`);
        for (const r of st.risks) {
          lines.push(`- **${r.description}** (${riskLevel(riskScore(r))})`);
        }
      }
      return lines.join("\n");
    }
    case "slack": {
      lines.push(`*Plan: ${st.task}*`);
      lines.push(`Status: ${STATUS_LABEL[st.status]} | Progress: ${completed}/${total} (${pct}%)`);
      lines.push(``);
      lines.push(`*Steps:*`);
      for (const [i, s] of st.steps.entries()) {
        const icon = s.status === "complete" ? "✅" : s.status === "in_progress" ? "🔄" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "⬜";
        lines.push(`${icon} ${i + 1}. ${s.description}`);
      }
      return lines.join("\n");
    }
    default:
      return shareText(st);
  }
}

function accessibilityText(st: PlanState, audience: "executive" | "technical" | "pm"): string {
  const now = Date.now();
  const lines: string[] = [
    `${MARK} Plan Accessibility Report (${audience})`,
    ``,
  ];

  if (audience === "executive") {
    // Executive summary: high-level, business impact, risks, ROI
    lines.push(`## Executive Summary`);
    lines.push(``);
    lines.push(`**Task:** ${st.task}`);
    lines.push(`**Status:** ${STATUS_LABEL[st.status]}`);
    lines.push(`**Approval:** ${st.approvalStatus}`);
    lines.push(``);

    const completed = st.steps.filter((s) => s.status === "complete").length;
    const total = st.steps.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    lines.push(`**Progress:** ${completed}/${total} steps complete (${pct}%)`);
    lines.push(``);

    // Business impact
    lines.push(`## Business Impact`);
    lines.push(``);
    if (st.costEstimate) {
      const ce = st.costEstimate;
      lines.push(`- **Estimated Cost:** $${ce.estimatedCostUsd.toFixed(4)}`);
      if (ce.actualCostUsd !== undefined) {
        lines.push(`- **Actual Cost:** $${ce.actualCostUsd.toFixed(4)}`);
        if (ce.estimatedCostUsd > 0) {
          const variance = ((ce.actualCostUsd - ce.estimatedCostUsd) / ce.estimatedCostUsd) * 100;
          lines.push(`- **Variance:** ${variance > 0 ? "+" : ""}${variance.toFixed(1)}%`);
        }
      }
    }
    lines.push(``);

    // ROI
    lines.push(`## ROI`);
    lines.push(``);
    if (st.insights.length > 0) {
      lines.push(`Key insights from execution:`);
      for (const insight of st.insights.slice(0, 5)) {
        lines.push(`  - ${insight}`);
      }
    } else {
      lines.push(`No insights recorded yet.`);
    }
    lines.push(``);

    // Risks
    lines.push(`## Risks`);
    lines.push(``);
    if (st.risks.length === 0) {
      lines.push(`No risks identified.`);
    } else {
      const open = st.risks.filter((r) => r.status === "open");
      const high = open.filter((r) => riskScore(r) >= 8);
      lines.push(`- **Open Risks:** ${open.length}`);
      lines.push(`- **High Risks:** ${high.length}`);
      if (high.length > 0) {
        lines.push(``);
        lines.push(`High-priority risks:`);
        for (const r of high) {
          lines.push(`  - ${r.description} (L${r.likelihood}×I${r.impact})`);
        }
      }
    }
    lines.push(``);

    // Success criteria
    lines.push(`## Success Criteria`);
    lines.push(``);
    if (st.criteria.length === 0) {
      lines.push(`No success criteria defined.`);
    } else {
      const passing = st.criteria.filter((c) => c.status === "passing").length;
      const failing = st.criteria.filter((c) => c.status === "failing").length;
      lines.push(`- **Passing:** ${passing}/${st.criteria.length}`);
      lines.push(`- **Failing:** ${failing}/${st.criteria.length}`);
    }
  } else if (audience === "technical") {
    // Technical appendix: detailed steps, architecture, dependencies, APIs
    lines.push(`## Technical Appendix`);
    lines.push(``);

    // Detailed steps
    lines.push(`## Detailed Steps`);
    lines.push(``);
    if (st.steps.length === 0) {
      lines.push(`No steps defined.`);
    } else {
      for (const [i, s] of st.steps.entries()) {
        lines.push(`### Step ${i + 1}: ${s.description}`);
        lines.push(`  Status: ${s.status}`);
        if (s.confidence) lines.push(`  Confidence: ${s.confidence}`);
        if (s.dependsOn && s.dependsOn.length > 0) {
          // PL-3: dependsOn holds step IDs; show current step numbers.
          const dn = s.dependsOn.map((d) => stepIndexOf(st.steps, d) + 1).filter((n) => n > 0);
          if (dn.length > 0) lines.push(`  Depends on: ${dn.map((n) => `Step ${n}`).join(", ")}`);
        }
        if (s.startedAt) {
          const end = s.completedAt ?? now;
          const dur = Math.max(0, Math.round((end - s.startedAt) / 60000));
          lines.push(`  Duration: ${dur} min`);
        }
        if (s.estimatedDurationMin) {
          lines.push(`  Estimated: ${s.estimatedDurationMin} min`);
        }
        if (s.result) lines.push(`  Result: ${s.result}`);
        if (s.error) lines.push(`  Error: ${s.error}`);
        if (s.linkedDecisions && s.linkedDecisions.length > 0) {
          lines.push(`  Linked Decisions: ${s.linkedDecisions.join(", ")}`);
        }
        if (s.linkedErrors && s.linkedErrors.length > 0) {
          lines.push(`  Linked Errors: ${s.linkedErrors.join(", ")}`);
        }
        if (s.linkedSnippets && s.linkedSnippets.length > 0) {
          lines.push(`  Linked Snippets: ${s.linkedSnippets.join(", ")}`);
        }
        if (s.comments && s.comments.length > 0) {
          lines.push(`  Comments: ${s.comments.length}`);
        }
        lines.push(``);
      }
    }

    // Architecture / Dependencies
    lines.push(`## Dependencies`);
    lines.push(``);
    const depCount = st.steps.reduce((sum, s) => sum + (s.dependsOn?.length ?? 0), 0);
    if (depCount === 0) {
      lines.push(`No dependencies between steps.`);
    } else {
      lines.push(`Total dependencies: ${depCount}`);
      lines.push(``);
      for (const [i, s] of st.steps.entries()) {
        if (s.dependsOn && s.dependsOn.length > 0) {
          // PL-3: dependsOn holds step IDs; show current step numbers.
          const dn = s.dependsOn.map((d) => stepIndexOf(st.steps, d) + 1).filter((n) => n > 0);
          if (dn.length > 0) lines.push(`  Step ${i + 1} depends on: ${dn.map((n) => `Step ${n}`).join(", ")}`);
        }
      }
    }
    lines.push(``);

    // APIs
    lines.push(`## APIs & Integrations`);
    lines.push(``);
    const apiSteps = st.steps.filter((s) =>
      s.description.toLowerCase().includes("api") ||
      s.description.toLowerCase().includes("endpoint") ||
      s.description.toLowerCase().includes("integration")
    );
    if (apiSteps.length === 0) {
      lines.push(`No API or integration steps found.`);
    } else {
      lines.push(`${apiSteps.length} step(s) involve APIs or integrations:`);
      for (const s of apiSteps) {
        const idx = st.steps.indexOf(s) + 1;
        lines.push(`  - Step ${idx}: ${s.description}`);
      }
    }
    lines.push(``);

    // Research
    if (st.research && st.research.length > 0) {
      lines.push(`## Research`);
      lines.push(``);
      for (const r of st.research) {
        lines.push(`Query: "${r.query}"`);
        lines.push(`Summary: ${r.summary}`);
        lines.push(``);
      }
    }
  } else {
    // PM view: timeline, milestones, resource allocation, status
    lines.push(`## PM View`);
    lines.push(``);

    // Timeline
    lines.push(`## Timeline`);
    lines.push(``);
    if (st.createdAt) {
      lines.push(`**Created:** ${new Date(st.createdAt).toISOString()}`);
    }
    if (st.approvedAt) {
      lines.push(`**Approved:** ${new Date(st.approvedAt).toISOString()}`);
    }
    if (st.startedAt) {
      lines.push(`**Started:** ${new Date(st.startedAt).toISOString()}`);
    }
    if (st.completedAt) {
      lines.push(`**Completed:** ${new Date(st.completedAt).toISOString()}`);
    }
    const durationMs = st.completedAt ? st.completedAt - st.createdAt : now - st.createdAt;
    const durationMin = Math.round((durationMs / 60000) * 10) / 10;
    lines.push(`**Duration:** ${durationMin} min`);
    lines.push(``);

    // Milestones
    lines.push(`## Milestones`);
    lines.push(``);
    if (st.steps.length === 0) {
      lines.push(`No milestones defined.`);
    } else {
      for (const [i, s] of st.steps.entries()) {
        const icon = s.status === "complete" ? "✓" : s.status === "in_progress" ? "→" : s.status === "failed" ? "✗" : s.status === "skipped" ? "○" : "·";
        lines.push(`${icon} Step ${i + 1}: ${s.description}`);
      }
    }
    lines.push(``);

    // Resource allocation
    lines.push(`## Resource Allocation`);
    lines.push(``);
    if (st.costEstimate) {
      const ce = st.costEstimate;
      lines.push(`- **Estimated Tokens:** ${ce.estimatedTokens?.toLocaleString() ?? "N/A"}`);
      if (ce.actualTokens !== undefined) {
        lines.push(`- **Actual Tokens:** ${ce.actualTokens.toLocaleString()}`);
      }
      lines.push(`- **Estimated Cost:** $${ce.estimatedCostUsd.toFixed(4)}`);
      if (ce.actualCostUsd !== undefined) {
        lines.push(`- **Actual Cost:** $${ce.actualCostUsd.toFixed(4)}`);
      }
    } else {
      lines.push(`No cost estimates available.`);
    }
    lines.push(``);

    // Status
    lines.push(`## Status`);
    lines.push(``);
    lines.push(`**Plan Status:** ${STATUS_LABEL[st.status]}`);
    lines.push(`**Approval Status:** ${st.approvalStatus}`);
    if (st.risks.length > 0) {
      const open = st.risks.filter((r) => r.status === "open").length;
      const mitigated = st.risks.filter((r) => r.status === "mitigated").length;
      lines.push(`**Risks:** ${open} open, ${mitigated} mitigated`);
    }
    if (st.criteria.length > 0) {
      const passing = st.criteria.filter((c) => c.status === "passing").length;
      const failing = st.criteria.filter((c) => c.status === "failing").length;
      lines.push(`**Success Criteria:** ${passing} passing, ${failing} failing`);
    }
  }

  return lines.join("\n");
}

function addComment(st: PlanState, stepNum: number, comment: string): string {
  if (stepNum < 1 || stepNum > st.steps.length) {
    return `${MARK} Invalid step number. Use \`/plan comment <n> <text>\` where n is 1-${st.steps.length}.`;
  }
  const step = st.steps[stepNum - 1];
  if (!step.comments) {
    step.comments = [];
  }
  step.comments.push({ text: comment, at: Date.now() });
  while (step.comments.length > MAX_COMMENTS_PER_STEP) step.comments.shift();
  st.updatedAt = Date.now();
  return `${MARK} Comment added to step ${stepNum}: ${step.description}`;
}

function riskScore(r: Risk): number {
  return r.likelihood * r.impact;
}

function riskLevel(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 15) return "critical";
  if (score >= 8) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/* ------------------------------------------------------------ confidence */

const CONFIDENCE_ICON: Record<Confidence, string> = {
  high: "✓", // green check
  medium: "–", // yellow dash
  low: "✗", // red X
};

function confidenceIcon(confidence: Confidence | undefined): string {
  return CONFIDENCE_ICON[confidence ?? "medium"];
}

function confidenceSummary(steps: PlanStep[]): string {
  if (steps.length === 0) return "no steps";
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const s of steps) counts[s.confidence ?? "medium"]++;
  const total = steps.length;
  const pct = (n: number) => Math.round((n / total) * 100);
  return `${pct(counts.high)}% high, ${pct(counts.medium)}% medium, ${pct(counts.low)}% low`;
}

function normalizeStep(step: PlanStep): PlanStep {
  if (!step.confidence) step.confidence = "medium";
  if (!Array.isArray(step.linkedDecisions)) step.linkedDecisions = [];
  if (!Array.isArray(step.linkedErrors)) step.linkedErrors = [];
  if (!Array.isArray(step.linkedSnippets)) step.linkedSnippets = [];
  return step;
}

function risksText(st: PlanState): string {
  if (st.risks.length === 0) {
    return `${MARK} No risks identified yet. Use plan_add_risk to add risks.`;
  }
  const sorted = [...st.risks].sort((a, b) => riskScore(b) - riskScore(a));
  const agg = aggregatesOf(st);
  const openCount = agg.risksOpen;
  const lines: string[] = [
    `${MARK} Risk Matrix`,
    ``,
    `            Impact →`,
    `         1      2      3      4      5`,
    `Likelihood`,
  ];
  for (let lik = 5; lik >= 1; lik--) {
    const cells: string[] = [];
    for (let imp = 1; imp <= 5; imp++) {
      const inCell = st.risks.filter((r) => r.likelihood === lik && r.impact === imp);
      if (inCell.length === 0) {
        cells.push("  ·   ");
      } else {
        const maxScore = Math.max(...inCell.map(riskScore));
        const level = riskLevel(maxScore);
        const marker = level === "critical" ? "C" : level === "high" ? "H" : level === "medium" ? "M" : "L";
        const count = inCell.length > 1 ? String(inCell.length) : " ";
        cells.push(` ${marker}${count}  `);
      }
    }
    lines.push(`  ${lik}    ${cells.join(" ")}`);
  }
  lines.push(``, `Legend: C=critical(15-25) H=high(8-14) M=medium(4-7) L=low(1-3) ·=empty`);
  if (agg.openHighRisks.length > 0) {
    lines.push(``, `HIGH-RISK ITEMS (score >= 8):`);
    for (const r of agg.openHighRisks) {
      lines.push(`  [${riskScore(r)}] ${r.description}`);
      if (r.mitigation) lines.push(`    Mitigation: ${r.mitigation}`);
      if (r.contingency) lines.push(`    Contingency: ${r.contingency}`);
    }
  }
  lines.push(``, `ALL RISKS (${st.risks.length} total, ${openCount} open):`);
  for (const r of sorted) {
    const score = riskScore(r);
    const statusMark = r.status === "mitigated" ? "✓" : r.status === "accepted" ? "○" : r.status === "realized" ? "✗" : "·";
    lines.push(`  ${statusMark} [${score}] L${r.likelihood}×I${r.impact} ${r.description} (${r.status})`);
  }
  return lines.join("\n");
}

function researchText(st: PlanState): string {
  if (!st.research || st.research.length === 0) {
    return `${MARK} No research recorded yet. Research is gathered during the planning phase.`;
  }
  const lines: string[] = [
    `${MARK} Research Findings`,
    ``,
  ];
  for (const r of st.research) {
    lines.push(`Query: "${r.query}"`);
    lines.push(`Domain: ${r.domain}`);
    lines.push(`Summary: ${r.summary}`);
    if (r.keyFindings.length > 0) {
      lines.push(`Key findings:`);
      for (const f of r.keyFindings) {
        lines.push(`  - ${f}`);
      }
    }
    if (r.sources.length > 0) {
      lines.push(`Sources:`);
      for (const s of r.sources) {
        lines.push(`  - ${s.title}: ${s.url}`);
      }
    }
    lines.push(`Cached: ${r.cached ? "yes" : "no"} · Searched: ${new Date(r.searchedAt).toISOString()}`);
    lines.push(``);
  }
  return lines.join("\n");
}

function diffText(st: PlanState, fromVersion?: number, toVersion?: number): string {
  if (st.history.length === 0 && st.version <= 1) {
    return `${MARK} No version history available.`;
  }
  const from = fromVersion !== undefined
    ? st.history.find((v) => v.version === fromVersion)
    : st.history[st.history.length - 2];
  const to = toVersion !== undefined
    ? st.history.find((v) => v.version === toVersion)
    : st.history[st.history.length - 1];
  if (!from || !to) {
    return `${MARK} Version not found in history.`;
  }
  const lines = [
    `${MARK} Diff: v${from.version} → v${to.version}`,
    `From: ${new Date(from.timestamp).toISOString()} — ${from.note}`,
    `To: ${new Date(to.timestamp).toISOString()} — ${to.note}`,
    ``,
  ];
  const fromDescs = from.steps.map((s) => s.description);
  const toDescs = to.steps.map((s) => s.description);
  const removed = fromDescs.filter((d) => !toDescs.includes(d));
  const added = toDescs.filter((d) => !fromDescs.includes(d));
  if (removed.length > 0) {
    lines.push(`Removed steps:`);
    removed.forEach((d) => lines.push(`  - ${d}`));
  }
  if (added.length > 0) {
    lines.push(`Added steps:`);
    added.forEach((d) => lines.push(`  + ${d}`));
  }
  const fromIds = from.steps.map((s) => s.id);
  const toIds = to.steps.map((s) => s.id);
  const reordered = fromIds.some((id, i) => id !== toIds[i]);
  if (reordered && removed.length === 0 && added.length === 0) {
    lines.push(`Steps reordered.`);
  }
  if (removed.length === 0 && added.length === 0 && !reordered) {
    lines.push(`No step changes detected.`);
  }
  if (from.planText !== to.planText) {
    lines.push(``, `Plan text modified.`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------ compare */

function parsePlanText(text: string): string[] {
  const lines = text.split("\n");
  const steps: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match numbered steps: "1. ..." or "1) ..." or "- ..." or "* ..."
    const match = /^(?:\d+[.)]\s+|[-*]\s+)(.+)$/.exec(trimmed);
    if (match) {
      steps.push(match[1].trim());
    } else if (steps.length > 0 && !trimmed.startsWith("#")) {
      // Continuation of previous step
      steps[steps.length - 1] += " " + trimmed;
    } else if (!trimmed.startsWith("#")) {
      steps.push(trimmed);
    }
  }
  return steps;
}

function compareText(st: PlanState, alternativePlan: string): string {
  const currentSteps = st.steps.map((s) => s.description);
  const altSteps = parsePlanText(alternativePlan);

  if (altSteps.length === 0) {
    return `${MARK} No steps found in the alternative plan. Provide a plan with numbered or bulleted steps.`;
  }

  // Step count
  const currentCount = currentSteps.length;
  const altCount = altSteps.length;
  const countDiff = altCount - currentCount;

  // Coverage: find common steps (by similarity)
  const commonSteps: Array<{ current: string; alternative: string }> = [];
  const uniqueCurrent: string[] = [];
  const uniqueAlt: string[] = [];

  const usedAlt = new Set<number>();
  for (const cs of currentSteps) {
    let bestMatch = -1;
    let bestScore = 0;
    for (let i = 0; i < altSteps.length; i++) {
      if (usedAlt.has(i)) continue;
      const similarity = stepSimilarity(cs, altSteps[i]);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = i;
      }
    }
    if (bestMatch >= 0 && bestScore > 0.3) {
      commonSteps.push({ current: cs, alternative: altSteps[bestMatch] });
      usedAlt.add(bestMatch);
    } else {
      uniqueCurrent.push(cs);
    }
  }
  for (let i = 0; i < altSteps.length; i++) {
    if (!usedAlt.has(i)) {
      uniqueAlt.push(altSteps[i]);
    }
  }

  // Complexity metrics
  const currentAvgLen = currentCount > 0 ? Math.round(currentSteps.reduce((sum, s) => sum + s.length, 0) / currentCount) : 0;
  const altAvgLen = altCount > 0 ? Math.round(altSteps.reduce((sum, s) => sum + s.length, 0) / altCount) : 0;
  const currentDeps = st.steps.reduce((sum, s) => sum + (s.dependsOn?.length ?? 0), 0);
  const altDeps = altSteps.filter((s) => s.toLowerCase().includes("after") || s.toLowerCase().includes("then") || s.toLowerCase().includes("depends")).length;

  // Duration estimates
  const currentTotalMin = st.steps.reduce((sum, s) => sum + (s.estimatedDurationMin ?? estimateDuration(s.description)), 0);
  const altTotalMin = altSteps.reduce((sum, s) => sum + estimateDuration(s), 0);

  // Cost estimates
  const currentCost = st.costEstimate?.estimatedCostUsd ?? 0;
  const altCost = currentCost > 0 ? currentCost * (altTotalMin / Math.max(1, currentTotalMin)) : 0;

  // Risk profile
  const currentRiskCount = st.risks.length;
  const currentHighRisk = st.risks.filter((r) => r.status === "open" && riskScore(r) >= 8).length;
  const altRiskKeywords = ["risk", "careful", "cautious", "edge case", "fallback", "rollback", "migration", "breaking"];
  const altRiskCount = altSteps.filter((s) => altRiskKeywords.some((kw) => s.toLowerCase().includes(kw))).length;

  // Build report
  const lines: string[] = [
    `${MARK} Plan Comparison Report`,
    ``,
    `## Step Count`,
    `  Current plan:  ${currentCount} step(s)`,
    `  Alternative:   ${altCount} step(s)`,
    `  Difference:    ${countDiff > 0 ? "+" : ""}${countDiff} step(s)`,
    ``,
    `## Coverage`,
    `  Common steps:  ${commonSteps.length}`,
    `  Unique to current: ${uniqueCurrent.length}`,
    `  Unique to alternative: ${uniqueAlt.length}`,
  ];

  if (commonSteps.length > 0) {
    lines.push(``, `  Side-by-side mapping:`);
    for (const [i, cs] of commonSteps.entries()) {
      lines.push(`    ${i + 1}. Current:  ${truncate(cs.current, 60)}`);
      lines.push(`       Alternative: ${truncate(cs.alternative, 60)}`);
    }
  }

  if (uniqueCurrent.length > 0) {
    lines.push(``, `  Steps only in current plan:`);
    for (const s of uniqueCurrent) {
      lines.push(`    - ${truncate(s, 80)}`);
    }
  }

  if (uniqueAlt.length > 0) {
    lines.push(``, `  Steps only in alternative plan:`);
    for (const s of uniqueAlt) {
      lines.push(`    - ${truncate(s, 80)}`);
    }
  }

  lines.push(
    ``,
    `## Complexity`,
    `  Current plan:`,
    `    Avg description length: ${currentAvgLen} chars`,
    `    Dependencies: ${currentDeps}`,
    `  Alternative plan:`,
    `    Avg description length: ${altAvgLen} chars`,
    `    Dependencies: ${altDeps}`,
  );

  lines.push(
    ``,
    `## Estimated Duration`,
    `  Current plan:  ${currentTotalMin} min`,
    `  Alternative:   ${altTotalMin} min`,
    `  Difference:    ${altTotalMin - currentTotalMin > 0 ? "+" : ""}${altTotalMin - currentTotalMin} min`,
  );

  lines.push(
    ``,
    `## Estimated Cost`,
    `  Current plan:  $${currentCost.toFixed(4)}`,
    `  Alternative:   $${altCost.toFixed(4)}`,
  );

  lines.push(
    ``,
    `## Risk Profile`,
    `  Current plan:  ${currentRiskCount} risk(s) identified (${currentHighRisk} high-risk open)`,
    `  Alternative:   ${altRiskCount} risk-related step(s) detected`,
  );

  // Recommendation
  lines.push(``, `## Recommendation`);

  const currentScore = scorePlan(currentCount, currentAvgLen, currentDeps, currentTotalMin, currentRiskCount, commonSteps.length);
  const altScore = scorePlan(altCount, altAvgLen, altDeps, altTotalMin, altRiskCount, commonSteps.length);

  if (altScore > currentScore * 1.1) {
    lines.push(`  The **alternative plan** is recommended.`);
    lines.push(`  Reason: ${getRecommendationReason(altCount, currentCount, altAvgLen, currentAvgLen, altTotalMin, currentTotalMin, altRiskCount, currentRiskCount)}`);
  } else if (currentScore > altScore * 1.1) {
    lines.push(`  The **current plan** is recommended.`);
    lines.push(`  Reason: ${getRecommendationReason(currentCount, altCount, currentAvgLen, altAvgLen, currentTotalMin, altTotalMin, currentRiskCount, altRiskCount)}`);
  } else {
    lines.push(`  Both plans are comparable. The current plan is slightly preferred due to existing context and progress tracking.`);
  }

  return lines.join("\n");
}

interface CodeReviewIssue {
  severity: "critical" | "warning" | "info";
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

function analyzeDiffForIssues(diff: string): CodeReviewIssue[] {
  const issues: CodeReviewIssue[] = [];
  const lines = diff.split("\n");
  let currentFile = "";
  let currentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current file
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[2];
      continue;
    }

    // Track line numbers
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine++;
      const content = line.slice(1);

      // Check for hardcoded credentials
      if (/password|secret|api[_-]?key|token|credential/i.test(content) && /=\s*["'][^"']+["']/.test(content)) {
        issues.push({
          severity: "critical",
          category: "security",
          file: currentFile,
          line: currentLine,
          message: "Possible hardcoded credential detected",
          suggestion: "Use environment variables or a secrets manager instead of hardcoding credentials",
        });
      }

      // Check for SQL injection risks
      if (/SELECT|INSERT|UPDATE|DELETE/i.test(content) && /["']\s*\+|\+\s*["']/.test(content)) {
        issues.push({
          severity: "critical",
          category: "security",
          file: currentFile,
          line: currentLine,
          message: "Possible SQL injection risk — string concatenation in SQL query",
          suggestion: "Use parameterized queries or prepared statements",
        });
      }

      // Check for XSS vulnerabilities
      if (/innerHTML|dangerouslySetInnerHTML|document\.write/.test(content)) {
        issues.push({
          severity: "critical",
          category: "security",
          file: currentFile,
          line: currentLine,
          message: "Potential XSS vulnerability — direct HTML injection",
          suggestion: "Sanitize user input or use safe rendering methods",
        });
      }

      // Check for long functions (heuristic: many consecutive lines in same function)
      if (content.includes("function") || content.includes("=>") || content.includes("def ")) {
        // Look ahead to estimate function length
        let funcLines = 0;
        for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
          if (lines[j].startsWith("+") && !lines[j].startsWith("+++")) {
            funcLines++;
          } else if (lines[j].startsWith("}") || lines[j].startsWith("}")) {
            break;
          }
        }
        if (funcLines > 30) {
          issues.push({
            severity: "warning",
            category: "quality",
            file: currentFile,
            line: currentLine,
            message: `Long function detected (~${funcLines}+ lines)`,
            suggestion: "Consider breaking this into smaller, more focused functions",
          });
        }
      }

      // Check for missing error handling
      if (/\.then\(|await |fetch\(|execSync|exec\(/.test(content) && !content.includes("catch") && !content.includes("try")) {
        // Check if there's a try/catch nearby
        let hasErrorHandler = false;
        for (let j = Math.max(0, i - 5); j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].includes("catch") || lines[j].includes("try")) {
            hasErrorHandler = true;
            break;
          }
        }
        if (!hasErrorHandler) {
          issues.push({
            severity: "warning",
            category: "quality",
            file: currentFile,
            line: currentLine,
            message: "Missing error handling for async operation",
            suggestion: "Wrap in try/catch or add .catch() handler",
          });
        }
      }

      // Check for console.log in production code
      if (/console\.log/.test(content) && !currentFile.includes("test") && !currentFile.includes("spec")) {
        issues.push({
          severity: "info",
          category: "quality",
          file: currentFile,
          line: currentLine,
          message: "console.log statement found",
          suggestion: "Consider using a proper logging library or removing debug statements",
        });
      }

      // Check for TODO/FIXME comments
      if (/TODO|FIXME|HACK|XXX/.test(content)) {
        issues.push({
          severity: "info",
          category: "documentation",
          file: currentFile,
          line: currentLine,
          message: "TODO/FIXME comment found",
          suggestion: "Address the TODO or create a tracking issue",
        });
      }

      // Check for N+1 query patterns
      if (/forEach.*await|for.*await.*query|map.*await/.test(content)) {
        issues.push({
          severity: "warning",
          category: "performance",
          file: currentFile,
          line: currentLine,
          message: "Possible N+1 query pattern — async operation in loop",
          suggestion: "Consider batching queries or using Promise.all for parallel execution",
        });
      }

      // Check for missing documentation
      if (/(export\s+)?(function|class|def|async\s+function)/.test(content)) {
        // Check if there's a JSDoc or docstring above
        let hasDoc = false;
        for (let j = Math.max(0, i - 5); j < i; j++) {
          if (lines[j].includes("/**") || lines[j].includes("///") || lines[j].includes('"""') || lines[j].includes("#")) {
            hasDoc = true;
            break;
          }
        }
        if (!hasDoc) {
          issues.push({
            severity: "info",
            category: "documentation",
            file: currentFile,
            line: currentLine,
            message: "New function/class without documentation",
            suggestion: "Add JSDoc, docstring, or inline comments explaining the purpose",
          });
        }
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed lines — don't increment line counter
    } else if (!line.startsWith("\\")) {
      // Context line
      currentLine++;
    }
  }

  return issues;
}

function codeReviewText(st: PlanState): string {
  const cwd = getCwd();
  if (!hasGitRepo(cwd)) {
    return `${MARK} Code review requires a git repository. No .git directory found in ${cwd || "the working directory"}.`;
  }

  if (st.status !== "complete") {
    return `${MARK} Code review requires a completed plan. The current plan status is: ${STATUS_LABEL[st.status]}. Complete the plan first, then run plan_code_review.`;
  }

  // Get the diff between the start and end of plan execution
  let diff: string;
  try {
    // Try to get diff from approvedAt to now, or from createdAt to now
    const startRef = st.approvedAt
      ? `git diff --stat HEAD 2>/dev/null || true`
      : "";
    // Get the full diff of uncommitted changes and recent commits
    diff = execSync(`git diff HEAD~5..HEAD -- . 2>/dev/null || git diff HEAD -- . 2>/dev/null || git diff --cached -- . 2>/dev/null`, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return `${MARK} Failed to get git diff. Ensure the repository has commits.`;
  }

  if (!diff || diff.trim().length === 0) {
    return `${MARK} No code changes found to review. The working directory appears to be clean.`;
  }

  // Parse diff statistics
  const filesChanged = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  const diffLines = diff.split("\n");

  for (const line of diffLines) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      filesChanged.add(fileMatch[2]);
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      linesAdded++;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      linesRemoved++;
    }
  }

  // Analyze the diff for issues
  const issues = analyzeDiffForIssues(diff);

  // Categorize issues by severity
  const critical = issues.filter((i) => i.severity === "critical");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  // Calculate quality score (0-100)
  const baseScore = 100;
  const criticalPenalty = critical.length * 15;
  const warningPenalty = warnings.length * 5;
  const infoPenalty = infos.length * 2;
  const score = Math.max(0, baseScore - criticalPenalty - warningPenalty - infoPenalty);

  // Build the report
  const lines: string[] = [
    `${MARK} Code Review Report`,
    ``,
    `Plan: ${st.task}`,
    `Status: ${STATUS_LABEL[st.status]}`,
    ``,
    `## Summary`,
    ``,
    `- Files changed: ${filesChanged.size}`,
    `- Lines added: ${linesAdded}`,
    `- Lines removed: ${linesRemoved}`,
    `- Issues found: ${issues.length} (${critical.length} critical, ${warnings.length} warnings, ${infos.length} info)`,
    `- Code quality score: ${score}/100`,
    ``,
  ];

  if (critical.length > 0) {
    lines.push(`## Critical Issues`, ``);
    for (const issue of critical) {
      lines.push(`- [${issue.category}] ${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`);
      if (issue.suggestion) lines.push(`  Suggestion: ${issue.suggestion}`);
    }
    lines.push(``);
  }

  if (warnings.length > 0) {
    lines.push(`## Warnings`, ``);
    for (const issue of warnings) {
      lines.push(`- [${issue.category}] ${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`);
      if (issue.suggestion) lines.push(`  Suggestion: ${issue.suggestion}`);
    }
    lines.push(``);
  }

  if (infos.length > 0) {
    lines.push(`## Info`, ``);
    for (const issue of infos) {
      lines.push(`- [${issue.category}] ${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`);
      if (issue.suggestion) lines.push(`  Suggestion: ${issue.suggestion}`);
    }
    lines.push(``);
  }

  if (issues.length === 0) {
    lines.push(`## Result`, ``);
    lines.push(`No issues found. The code changes look good!`, ``);
  }

  // Add recommendations
  lines.push(`## Recommendations`, ``);
  if (critical.length > 0) {
    lines.push(`- Address all critical issues before merging`);
  }
  if (warnings.length > 0) {
    lines.push(`- Review and address warnings to improve code quality`);
  }
  if (infos.length > 0) {
    lines.push(`- Consider addressing info-level issues for better maintainability`);
  }
  if (issues.length === 0) {
    lines.push(`- No immediate action required`);
    lines.push(`- Continue following the established patterns`);
  }
  lines.push(``);

  // Add test coverage note
  const testFiles = Array.from(filesChanged).filter((f) => f.includes("test") || f.includes("spec"));
  if (testFiles.length === 0 && filesChanged.size > 0) {
    lines.push(`## Test Coverage`, ``);
    lines.push(`No test files were changed. Consider adding tests for the modified code.`, ``);
  } else if (testFiles.length > 0) {
    lines.push(`## Test Coverage`, ``);
    lines.push(`Test files changed: ${testFiles.join(", ")}`, ``);
  }

  return lines.join("\n");
}

function stepSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection++;
  }
  return intersection / Math.max(aWords.size, bWords.size);
}

function scorePlan(steps: number, avgLen: number, deps: number, durationMin: number, risks: number, common: number): number {
  // Higher score is better
  let score = 0;
  score += steps * 10; // more steps = more thorough
  score += Math.min(avgLen, 100) * 0.5; // detailed descriptions
  score += deps * 5; // dependencies show planning
  score -= durationMin * 0.1; // shorter is better
  score -= risks * 3; // fewer risks is better
  score += common * 2; // common steps show alignment
  return score;
}

function getRecommendationReason(winnerSteps: number, loserSteps: number, winnerLen: number, loserLen: number, winnerDur: number, loserDur: number, winnerRisk: number, loserRisk: number): string {
  const reasons: string[] = [];
  if (winnerSteps > loserSteps) reasons.push(`more detailed (${winnerSteps} vs ${loserSteps} steps)`);
  if (winnerLen > loserLen * 1.2) reasons.push(`more detailed descriptions`);
  if (winnerDur < loserDur * 0.8) reasons.push(`shorter estimated duration`);
  if (winnerRisk < loserRisk) reasons.push(`lower risk profile`);
  if (reasons.length === 0) reasons.push(`better overall structure`);
  return reasons.join(", ");
}

function getCwd(): string {
  try {
    return resolve(process.cwd());
  } catch {
    return "";
  }
}

function hasGitRepo(cwd: string): boolean {
  if (!cwd) return false;
  return existsSync(join(cwd, ".git"));
}

function performRollback(st: PlanState, toStep?: number): string {
  // PL-8: validate the target before touching git at all.
  if (toStep !== undefined && (toStep < 1 || toStep > st.steps.length)) {
    return `${MARK} Invalid rollback target step ${toStep}: this plan has ${st.steps.length} step(s).`;
  }
  const cwd = getCwd();
  if (!hasGitRepo(cwd)) {
    return `${MARK} Rollback requires a git repository. No .git directory found in ${cwd || "the working directory"}.`;
  }

  const timestamp = Date.now();
  const backupBranch = `plan-rollback-${timestamp}`;

  // PL-8: record the current commit SHA first so the backup branch and the
  // reset target are the same deterministic point even if HEAD moves mid-op.
  let startSha = "";
  try {
    startSha = execSync("git rev-parse HEAD", { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return `${MARK} Rollback aborted: could not read the current commit (git rev-parse HEAD). Nothing was changed.`;
  }

  try {
    execSync(`git branch ${backupBranch} ${startSha}`, { cwd, stdio: "pipe" });
  } catch {
    return `${MARK} Failed to create backup branch ${backupBranch}.`;
  }

  // PL-8: previously any stash failure was swallowed and reset --hard ran
  // anyway, discarding uncommitted work. Now: only skip stashing when the
  // tree is genuinely clean; a real failure aborts BEFORE any reset.
  let stashed = false;
  try {
    const dirty = execSync("git status --porcelain", { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
    if (dirty.length > 0) {
      execSync(`git stash push -m "plan-rollback ${timestamp}"`, { cwd, stdio: "pipe" });
      stashed = true;
    }
  } catch {
    return `${MARK} Rollback aborted: git stash failed, so uncommitted changes could not be preserved. Nothing was reset — your working tree is untouched. Commit or stash manually, then retry.`;
  }

  let targetStep: number;
  if (toStep !== undefined) {
    targetStep = toStep;
  } else {
    const firstFailed = st.steps.findIndex((s) => s.status === "failed");
    targetStep = firstFailed > 0 ? firstFailed - 1 : 0;
  }

  try {
    execSync(`git reset --hard ${startSha}`, { cwd, stdio: "pipe" });
  } catch {
    return `${MARK} Failed to reset to ${startSha.slice(0, 10)}${stashed ? " — your changes remain stashed; run \`git stash pop\` to restore them" : ""}.`;
  }

  st.rollback = {
    rolledBackAt: timestamp,
    toStep: targetStep,
    backupBranch,
    gitAvailable: true,
    fromCommit: startSha,
    reason: toStep !== undefined ? `Rolled back to before step ${toStep}` : "Rolled back to before first failed step",
  };

  const lines = [
    `${MARK} Rollback complete`,
    `  Backup branch: ${backupBranch} (at ${startSha.slice(0, 10)})`,
    `  Reset commit: ${startSha.slice(0, 10)}`,
    `  Rollback recorded to step ${targetStep}`,
    stashed
      ? `  Uncommitted work: stashed — \`git stash pop\` to restore`
      : `  Uncommitted work: none (working tree was clean)`,
    `  Working directory: ${cwd}`,
    ``,
    `Use \`git checkout ${backupBranch}\` to restore the pre-rollback commits${stashed ? " and \`git stash pop\` for uncommitted work" : ""}.`,
  ];
  return lines.join("\n");
}

/* Rendered-view memo.
 *
 * buildReminder runs on every context event and buildPrompt on every kickoff /
 * resume, and each one re-serialised the whole plan (steps, risks, research,
 * approvals, checkpoints) into a fresh string — repeatedly, for a plan that had
 * not changed between two events. Both are pure functions of the plan state, so
 * the rendered text is cached against the same change token the aggregates use
 * and rebuilt only when the plan actually moves.
 *
 * buildPrompt additionally varies with its options, so those fold into the key.
 * Caching the finished string keeps this synchronous: nothing is deferred and
 * no timer is introduced, so a kick that renders once renders identically on a
 * retry. The WeakMap keys are live PlanState objects, so clearing a plan drops
 * its rendered text with it. */
const renderCache = new WeakMap<PlanState, { key: string; text: string }>();

function cachedRender(st: PlanState, key: string, render: () => string): string {
  const hit = renderCache.get(st);
  if (hit && hit.key === key) return hit.text;
  const text = render();
  renderCache.set(st, { key, text });
  return text;
}

/* Every mutation funnels through save(), so that is the one place a derived
 * view can be dropped. st.updatedAt alone is not a sufficient change token:
 * Date.now() only has millisecond resolution, so two mutations landing in the
 * same millisecond (a risk status flip plus a step edit, or two rapid tool
 * calls) leave updatedAt untouched while the underlying data moved. The view
 * keys above compare updatedAt *and* the array lengths, but a pure status
 * change alters no length, so the memo would serve a stale count. Bumping here
 * covers every mutating path and is conservative in the safe direction: a save
 * that changed nothing merely costs one recompute. WeakMap.delete keeps a
 * cleared plan's entries collectable and introduces no timer. */
function invalidateViews(st: PlanState): void {
  aggregatesCache.delete(st);
  renderCache.delete(st);
}

function renderKey(st: PlanState, suffix = ""): string {
  return `${st.updatedAt}|${st.steps.length}|${st.risks.length}|${st.criteria.length}|${st.childSessions.length}${suffix}`;
}

function buildReminder(st: PlanState): string {
  return cachedRender(st, renderKey(st), () => renderReminder(st));
}

function renderReminder(st: PlanState): string {
  const a = aggregatesOf(st);
  const { completed, total } = a;
  const lines = [
    "ACTIVE PLAN — keep working until it is complete.",
    `Task: ${st.task}`,
    `Status: ${STATUS_LABEL[st.status]}`,
  ];
  if (total > 0) lines.push(`Progress: ${completed}/${total} steps complete`);
  if (st.status === "executing" && a.nextPending) {
    lines.push(`Next: ${a.nextPending.description}`);
  }
  if (st.childSessions.length > 0) lines.push(`Child sessions: ${st.childSessions.map((cs) => `${cs.sessionID} (${cs.status})`).join(", ")}`);
  if (st.costEstimate) {
    const ce = st.costEstimate;
    if (ce.actualCostUsd !== undefined) {
      lines.push(`Cost: $${ce.actualCostUsd.toFixed(4)} actual / $${ce.estimatedCostUsd.toFixed(4)} est`);
    } else {
      lines.push(`Cost: ~$${ce.estimatedCostUsd.toFixed(4)} estimated`);
    }
  }
  if (st.approvalStatus === "approved") {
    lines.push("Approval: approved — awaiting execution confirmation");
  } else if (st.approvalStatus === "rejected") {
    lines.push("Approval: rejected — revise the plan");
  }
  if (a.riskTotal > 0) {
    const openHigh = a.openHighRisks;
    if (openHigh.length > 0) {
      lines.push(`Risks: ${openHigh.length} high-risk open — ${openHigh.map((r) => r.description).join("; ")}`);
    } else {
      lines.push(`Risks: ${a.risksOpen} open`);
    }
  }
  if (st.research && st.research.length > 0) {
    const totalSources = st.research.reduce((sum, r) => sum + r.sources.length, 0);
    lines.push(`Research: ${st.research.length} queries, ${totalSources} sources`);
  }
  // PL-7: the reminder is the only strategy guidance a mid-run model sees.
  lines.push(`Model strategy (${st.modelStrategy}): ${MODEL_STRATEGY_INSTRUCTIONS[st.modelStrategy]}`);
  if (st.phaseApprovals.length > 0) {
    const approved = st.phaseApprovals.filter((p) => p.status === "approved").length;
    const pending = st.phaseApprovals.filter((p) => p.status === "pending").length;
    lines.push(`Phase approvals: ${approved}/${st.phaseApprovals.length} approved, ${pending} pending`);
    if (st.executionMode === "incremental" && pending > 0) {
      const nextPending = st.phaseApprovals.find((p) => p.status === "pending");
      if (nextPending) {
        lines.push(`Next phase to approve: ${nextPending.stepDescription}`);
      }
    } else if (st.executionMode === "batch" && pending > 0) {
      // Batch mode never pauses for phase approval; say so, otherwise the
      // pending counter above reads like a blocker to a mid-run model.
      lines.push("Execution mode: batch — no per-phase approval required, keep going through all phases.");
    }
  }
  if (st.checkpoints.length > 0) {
    lines.push(`Checkpoints: ${st.checkpoints.length} recorded`);
  }
  lines.push(
    "Finish by calling `plan_complete` with a summary and evidence, or `plan_blocked` if stuck; use `plan_progress` for milestones.",
  );
  lines.push(
    "If you need user input or clarification, stop and ask — the plan will be resumed when the user responds.",
  );
  return lines.join("\n");
}

function buildPrompt(
  st: PlanState,
  opts: { kickoff?: boolean; note?: string; resume?: boolean } = {},
): string {
  // A one-off note is baked into the rendered text, so those calls skip the
  // cache entirely rather than growing the key with arbitrary caller text.
  const cacheable = !opts.note;
  const render = (): string => renderPrompt(st, opts);
  if (!cacheable) return render();
  const flags = `${opts.kickoff ? 1 : 0}${opts.resume ? 1 : 0}`;
  return cachedRender(st, renderKey(st, `|${flags}`), render);
}

function renderPrompt(
  st: PlanState,
  opts: { kickoff?: boolean; note?: string; resume?: boolean } = {},
): string {
  const lines: string[] = [];
  if (opts.resume) {
    lines.push(`${MARK} Resuming plan execution. Continue from where you left off.`);
  } else if (opts.kickoff) {
    lines.push(`${MARK} Plan approved. Begin execution now.`);
  } else {
    lines.push(`${MARK} Continue executing the plan.`);
  }
  if (opts.note) lines.push(opts.note);
  lines.push("", `TASK\n${st.task}`);
  if (st.planText) lines.push("", `PLAN\n${st.planText}`);
  if (st.steps.length > 0) {
    lines.push(
      "",
      `STEPS\n${st.steps
        .map((s, i) => `${i + 1}. [${s.status}] ${s.description}${s.error ? ` — ERROR: ${s.error}` : ""}`)
        .join("\n")}`,
    );
  }
  if (st.childSessions.length > 0) {
    lines.push("", `CHILD SESSIONS\n${st.childSessions.map((cs) => `- ${cs.sessionID} [${cs.status}] ${cs.task}`).join("\n")}`);
  }
  if (st.costEstimate) {
    const ce = st.costEstimate;
    lines.push(
      "",
      `COST ESTIMATE\nEstimated: $${ce.estimatedCostUsd.toFixed(4)} (${ce.inputTokens.toLocaleString()} in / ${ce.outputTokens.toLocaleString()} out)`,
    );
    if (ce.actualCostUsd !== undefined) {
      lines.push(`Actual: $${ce.actualCostUsd.toFixed(4)} (${(ce.actualInputTokens ?? 0).toLocaleString()} in / ${(ce.actualOutputTokens ?? 0).toLocaleString()} out)`);
    }
  }
  if (st.risks.length > 0) {
    const open = st.risks.filter((r) => r.status === "open");
    const high = open.filter((r) => riskScore(r) >= 8);
    lines.push(
      "",
      `RISKS\n${st.risks.map((r) => {
        const score = riskScore(r);
        const statusMark = r.status === "mitigated" ? "✓" : r.status === "accepted" ? "○" : r.status === "realized" ? "✗" : "·";
        return `${statusMark} [${score}] L${r.likelihood}×I${r.impact} ${r.description}${r.mitigation ? ` — Mitigation: ${r.mitigation}` : ""}${r.contingency ? ` — Contingency: ${r.contingency}` : ""}`;
      }).join("\n")}`,
    );
    if (high.length > 0) {
      lines.push(`\nHIGH-RISK: ${high.map((r) => r.description).join("; ")}`);
    }
  }
  if (st.research && st.research.length > 0) {
    lines.push(
      "",
      `RESEARCH\n${st.research.map((r) => {
        const sourceList = r.sources.length > 0 ? ` (${r.sources.length} sources)` : "";
        return `- [${r.domain}] "${r.query}"${sourceList}: ${r.summary}`;
      }).join("\n")}`,
    );
  }
  // PL-7: issue the strategy's instructions text with every kickoff/resume
  // prompt, so the executing model is told what free/paid/auto/fast means.
  if (opts.kickoff || opts.resume) {
    lines.push(
      "",
      `MODEL STRATEGY (${st.modelStrategy})\n${MODEL_STRATEGY_INSTRUCTIONS[st.modelStrategy]}\nUse the spawn_session tool with the appropriate model parameter.`,
    );
  }
  if (st.phaseApprovals.length > 0) {
    const approved = st.phaseApprovals.filter((p) => p.status === "approved").length;
    const pending = st.phaseApprovals.filter((p) => p.status === "pending").length;
    lines.push(
      "",
      `PHASE APPROVALS\n${approved}/${st.phaseApprovals.length} approved, ${pending} pending`,
    );
    if (st.executionMode === "incremental") {
      lines.push(`Execution mode: incremental (one phase at a time)`);
      const nextPending = st.phaseApprovals.find((p) => p.status === "pending");
      if (nextPending) {
        lines.push(`Next phase to approve: ${nextPending.stepDescription}`);
      }
    } else if (st.executionMode === "batch") {
      lines.push(`Execution mode: batch (all phases run without per-phase approval)`);
    }
  }
  if (st.checkpoints.length > 0) {
    lines.push(
      "",
      `CHECKPOINTS\n${st.checkpoints.length} recorded. Last: ${st.checkpoints[st.checkpoints.length - 1].summary}`,
    );
  }
  lines.push("", `VERSION\nCurrent version: ${st.version}`);
  lines.push(
    "",
    "Work autonomously through the remaining steps.",
    "Do not repeat work that is already done; take the single next concrete step.",
    "- When it is genuinely done, call `plan_complete` with a summary and concrete evidence.",
    "- If you cannot proceed, call `plan_blocked` with the reason and what you need from the user.",
    "- Otherwise call `plan_progress` to record each milestone, then keep going.",
    "- Call `plan_update_cost` periodically to track actual token usage and cost.",
    "A turn that ends without one of those calls will be resumed automatically, so never stop mid-task.",
  );
  return lines.join("\n");
}

/* --------------------------------------------------------------- parsing */

// PL-1: "accessibility" was missing, so `/plan accessibility pm` fell through
// to the default case and started a brand-new plan, wiping the old one.
const VERBS = new Set(["help", "status", "resume", "done", "complete", "clear", "stop", "cost", "risks", "research", "approve", "reject", "edit", "diff", "revert", "schedule", "pause", "approve-phase", "template", "export", "step", "criteria", "time", "estimate", "metrics", "model", "optimize", "dependencies", "decompose", "test-strategy", "rollback", "learn", "docs", "share", "comment", "compare", "review", "resources", "projects", "accessibility", "mode"]);

function parseCommand(raw: string): { verb: string; arg: string } {
  const text = raw.trim();
  if (!text) return { verb: "help", arg: "" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const head = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();
  if (VERBS.has(head)) return { verb: head, arg: rest };
  return { verb: "set", arg: text };
}

/* ---------------------------------------------------------------- plugin */

export default Plugin.define({
  id: "plan",
  async setup(ctx) {
    const c = ctx as unknown as PlanCtx;
    if (!c.command?.transform || !c.session) {
      console.error("[plan] command/session APIs are unavailable; the plugin is disabled.");
      return;
    }
    const hasStorage = !!(c.storage?.get && c.storage?.set && c.storage?.remove);
    const hasEvents = !!(c.event?.subscribe);
    if (!hasStorage || !hasEvents) {
      console.error("[plan] storage or event APIs unavailable; running without persistence or auto-continuation.");
    }

    const cfg = resolveConfig(c.options);
    const live = new Map<string, PlanState>();
    const loading = new Map<string, Promise<PlanState | undefined>>();
    const inFlight = new Set<string>();
    const evaluateIterations = new Map<string, number>();
    const consecutiveProgress = new Map<string, number>();
    const stuckIterations = new Map<string, number>();
    const contextReminderCount = new Map<string, number>();
    // PL-4: one-shot "verify criteria" nudge flag for the allDone gate.
    const criteriaNudgeSent = new Set<string>();
    // Per-session dedupe: skip evaluate when plan updatedAt is unchanged
    // since the last evaluation (no timer debounce — await-safe).
    const lastEvaluatedUpdatedAt = new Map<string, number>();
    // PL-9: per-session generation counters. clear()/replacement bump the
    // generation so in-flight handlers holding an older PlanState can't
    // resurrect the cleared plan through save()/live caching.
    const generations = new Map<string, number>();
    const stateGeneration = new WeakMap<PlanState, number>();
    // PL-2: drop every per-session counter for one session (resume, clear).
    const resetSessionCounters = (sessionID: string): void => {
      evaluateIterations.delete(sessionID);
      consecutiveProgress.delete(sessionID);
      stuckIterations.delete(sessionID);
      contextReminderCount.delete(sessionID);
      criteriaNudgeSent.delete(sessionID);
      lastEvaluatedUpdatedAt.delete(sessionID);
    };
    const MAX_SESSION_STATES = 500;
    const evictSessionStateIfFull = (): void => {
      while (live.size >= MAX_SESSION_STATES) {
        const oldest = live.keys().next();
        if (oldest.done) break;
        const sid = oldest.value as string;
        live.delete(sid);
        loading.delete(sid);
        inFlight.delete(sid);
        resetSessionCounters(sid);
        generations.delete(sid);
      }
      while (loading.size > MAX_SESSION_STATES) {
        const oldest = loading.keys().next();
        if (oldest.done) break;
        loading.delete(oldest.value as string);
      }
    };
    const disposers: Array<() => void | Promise<void>> = [];
    const track = (registration: Disposable | undefined): void => {
      if (registration && typeof registration.dispose === "function") {
        disposers.push(() => registration.dispose?.());
      }
    };

    const log = (message: string): void => {
      if (cfg.log) console.error(`[plan] ${message}`);
    };

    const note = async (sessionID: string, text: string): Promise<void> => {
      if (!cfg.notify) return;
      try {
        await c.session?.synthetic?.({ sessionID, text });
      } catch (err) {
        log(`failed to post note to ${sessionID}: ${describeError(err)}`);
      }
    };

    const INSIGHTS_INDEX_KEY = STORE_PREFIX + "insights-index";
    let insightsIndexChain: Promise<void> = Promise.resolve();
    type InsightsIndexEntry = { sessionID: string; updatedAt: number; insights: string[] };

    // PL-12: sibling insights are read through ctx.storage (a small index
    // key maintained on save), never a hardcoded filesystem layout.
    const readInsightsIndex = async (): Promise<InsightsIndexEntry[]> => {
      const raw = (await c.storage?.get?.(INSIGHTS_INDEX_KEY)) as { entries?: unknown } | undefined;
      const entries = Array.isArray(raw?.entries) ? (raw!.entries as unknown[]) : [];
      return entries.filter(
        (e): e is InsightsIndexEntry =>
          !!e && typeof e === "object" && typeof (e as InsightsIndexEntry).sessionID === "string" && Array.isArray((e as InsightsIndexEntry).insights),
      );
    };

    const lastSavedUpdatedAt = new Map<string, number>();
    const lastSavedInsights = new Map<string, string>();

    const updateInsightsIndex = (st: PlanState): void => {
      if (!st.insights || st.insights.length === 0) return;
      // Dirty-bit: only touch the index when insights actually changed.
      const key = st.insights.join("\n");
      if (lastSavedInsights.get(st.sessionID) === key) return;
      lastSavedInsights.set(st.sessionID, key);
      // Chained so concurrent saves read-modify-write the index serially.
      insightsIndexChain = insightsIndexChain.then(async () => {
        try {
          const others = (await readInsightsIndex()).filter((e) => e.sessionID !== st.sessionID);
          others.push({ sessionID: st.sessionID, updatedAt: st.updatedAt, insights: st.insights.slice(0, 10) });
          others.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          await c.storage?.set?.(INSIGHTS_INDEX_KEY, { entries: others.slice(0, 20) });
        } catch (err) {
          log(`failed to update insights index: ${describeError(err)}`);
        }
      });
    };

    const getPreviousInsights = async (sessionID: string): Promise<string[]> => {
      try {
        const entries = (await readInsightsIndex())
          .filter((e) => e.sessionID !== sessionID)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 20);
        const out: string[] = [];
        for (const e of entries) {
          for (const i of e.insights) {
            if (typeof i === "string" && !out.includes(i)) out.push(i);
          }
        }
        return out.slice(0, 20);
      } catch {
        return [];
      }
    };

    const save = async (st: PlanState): Promise<void> => {
      // PL-9: refuse to persist a plan whose generation is stale — the plan
      // was cleared or replaced while this caller held the old state.
      const current = generations.get(st.sessionID) ?? 0;
      const mine = stateGeneration.get(st);
      if (mine === undefined) stateGeneration.set(st, current);
      else if (mine !== current) {
        log(`skipped stale save for ${st.sessionID} (plan cleared or replaced mid-flight)`);
        return;
      }
      evictSessionStateIfFull();
      live.set(st.sessionID, st);
      // Every mutation reaches the derived views through save(), so drop their
      // memoised state here — before the redundant-rewrite guard below, which
      // would otherwise hide a same-millisecond mutation.
      invalidateViews(st);
      // Skip redundant rewrites when state hasn't changed since last save.
      const prevSaved = lastSavedUpdatedAt.get(st.sessionID);
      if (prevSaved !== undefined && prevSaved === st.updatedAt) {
        return;
      }
      try {
        await c.storage?.set?.(STORE_PREFIX + st.sessionID, st);
        lastSavedUpdatedAt.set(st.sessionID, st.updatedAt);
        updateInsightsIndex(st);
      } catch (err) {
        const message = `failed to persist plan for ${st.sessionID}: ${describeError(err)}`;
        console.error(`[plan] ${message}`);
        if (cfg.notify) {
          try {
            await c.session?.synthetic?.({ sessionID: st.sessionID, text: `[plan-plugin] Warning: ${message}` });
          } catch {
            /* note is best-effort */
          }
        }
      }
    };

    const load = async (sessionID: string): Promise<PlanState | undefined> => {
      const cached = live.get(sessionID);
      if (cached) return cached;
      const inflight = loading.get(sessionID);
      if (inflight) return inflight;
      const read = (async () => {
        // PL-9: remember the generation at read time; if clear()/replacement
        // bumps it while the storage read is in flight, discard the result
        // instead of re-caching the resurrected plan.
        const genAtRead = generations.get(sessionID) ?? 0;
        try {
          const raw = (await c.storage?.get?.(STORE_PREFIX + sessionID)) as PlanState | undefined;
          if (raw && typeof raw === "object" && typeof raw.task === "string" && raw.status) {
            if ((generations.get(sessionID) ?? 0) !== genAtRead) return undefined;
            // PL-3 + PL-11: default every array field/costEstimate and migrate
            // legacy index-based dependsOn/subSteps to step IDs.
            migratePlan(raw);
            evictSessionStateIfFull();
            stateGeneration.set(raw, genAtRead);
            live.set(sessionID, raw);
            return raw;
          }
          return undefined;
        } catch (err) {
          log(`failed to read plan for ${sessionID}: ${describeError(err)}`);
          return undefined;
        }
      })();
      loading.set(sessionID, read);
      try {
        return await read;
      } finally {
        loading.delete(sessionID);
      }
    };

    const clear = async (sessionID: string): Promise<void> => {
      // PL-9: bump the generation so in-flight saves from the old plan are
      // rejected; PL-2: drop every per-session counter with it.
      generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1);
      resetSessionCounters(sessionID);
      live.delete(sessionID);
      try {
        await c.storage?.remove?.(STORE_PREFIX + sessionID);
      } catch (err) {
        log(`failed to clear plan for ${sessionID}: ${describeError(err)}`);
      }
    };

    const newPlan = (sessionID: string, task: string): PlanState => {
      const now = Date.now();
      return {
        sessionID,
        task,
        planText: "",
        approvalStatus: "draft",
        status: "researching",
        steps: [],
        childSessions: [],
        partialResults: [],
        risks: [],
        criteria: [],
        insights: [],
        research: [],
        modelStrategy: "auto",
        executionMode: "incremental",
        createdAt: now,
        updatedAt: now,
        costEstimate: {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          estimatedAt: now,
        },
        version: 1,
        history: [],
        phaseApprovals: [],
        checkpoints: [],
        projects: [],
      };
    };
    const kick = async (st: PlanState, noteText: string, kickoff: boolean, delivery?: unknown, resume = false): Promise<void> => {
      const terminal = st.status === "complete" || st.status === "blocked" || st.status === "failed" || st.status === "paused" || st.status === "stopped";
      if (live.get(st.sessionID) !== st || terminal) return;
      try {
        await c.session?.prompt?.({
          sessionID: st.sessionID,
          text: buildPrompt(st, { kickoff, note: noteText, resume }),
          delivery,
        });
      } catch (err) {
        log(`failed to queue continuation for ${st.sessionID}: ${describeError(err)}`);
        st.status = "failed";
        st.stoppedReason = `continuation queue error: ${describeError(err)}`;
        st.updatedAt = Date.now();
        await save(st);
      }
    };

    const interrupt = async (sessionID: string, reason = ""): Promise<void> => {
      const st = await load(sessionID);
      if (!st || st.status !== "executing") return;
      st.status = "paused";
      st.pausedAt = Date.now();
      st.updatedAt = Date.now();
      await save(st);
      log(`plan paused for ${sessionID} (interrupt reason: ${reason || "unspecified"})`);
      await note(
        sessionID,
        `${MARK} Plan paused (the turn was interrupted${reason ? `: ${reason}` : ""}). Use \`/plan resume\` to keep going.`,
      );
    };

    const evaluate = async (sessionID: string, failed: boolean): Promise<void> => {
      if (!cfg.enabled || inFlight.has(sessionID)) return;
      inFlight.add(sessionID);
      try {
        const st = await load(sessionID);
        if (!st || st.status !== "executing") return;

        // Skip if the plan hasn't changed since the last evaluation.
        if (!failed && lastEvaluatedUpdatedAt.get(sessionID) === st.updatedAt) return;
        lastEvaluatedUpdatedAt.set(sessionID, st.updatedAt);

        if (failed) {
          st.status = "failed";
          st.stoppedReason = "execution error";
          st.updatedAt = Date.now();
          await save(st);
          const cwd = getCwd();
          if (hasGitRepo(cwd)) {
            await note(
              sessionID,
              `${MARK} Plan execution failed. Rollback available — use \`/plan rollback\` to revert to a previous state using git.`,
            );
          }
          return;
        }

        // --- Safety limit: max evaluate iterations ---
        const iterCount = (evaluateIterations.get(sessionID) ?? 0) + 1;
        evaluateIterations.set(sessionID, iterCount);
        if (iterCount > MAX_EVALUATE_ITERATIONS) {
          st.status = "paused";
          st.pausedAt = Date.now();
          st.stoppedReason = `exceeded maximum evaluate iterations (${MAX_EVALUATE_ITERATIONS})`;
          st.updatedAt = Date.now();
          await save(st);
          log(`plan paused for ${sessionID}: exceeded ${MAX_EVALUATE_ITERATIONS} evaluate iterations`);
          await note(
            sessionID,
            `${MARK} Plan paused: exceeded maximum evaluate iterations (${MAX_EVALUATE_ITERATIONS}). Use \`/plan resume\` to continue.`,
          );
          return;
        }

        // --- Safety limit: plan timeout (1 hour) ---
        // PL-2: per-run deadline — resume stamps resumedAt so a resumed run
        // gets a fresh window instead of inheriting elapsed time from before
        // the pause/stop.
        const executingSince = st.resumedAt ?? st.approvedAt ?? st.createdAt;
        if (Date.now() - executingSince > PLAN_TIMEOUT_MS) {
          st.status = "paused";
          st.pausedAt = Date.now();
          st.stoppedReason = "plan exceeded 1 hour execution timeout";
          st.updatedAt = Date.now();
          await save(st);
          log(`plan paused for ${sessionID}: exceeded 1 hour execution timeout`);
          await note(
            sessionID,
            `${MARK} Plan paused: exceeded 1 hour execution timeout. Use \`/plan resume\` to continue.`,
          );
          return;
        }

        // PL-5: fold sub-step progress into parent steps before deciding.
        if (syncParentSteps(st)) {
          st.updatedAt = Date.now();
          await save(st);
        }

        // Check if all steps are complete
        const allDone = st.steps.length > 0 && st.steps.every((s) => s.status === "complete" || s.status === "skipped");
        if (allDone) {
          // PL-4: the auto-complete path must honour the same criteria gate
          // plan_complete enforces — pending/failing criteria block it.
          const pendingCrit = st.criteria.filter((cr) => cr.status === "pending").length;
          const failingCrit = st.criteria.filter((cr) => cr.status === "failing").length;
          if (pendingCrit > 0 || failingCrit > 0) {
            if (!criteriaNudgeSent.has(sessionID)) {
              criteriaNudgeSent.add(sessionID);
              st.updatedAt = Date.now();
              await save(st);
              await kick(
                st,
                `All steps are done but the success criteria gate blocks completion: ${pendingCrit} pending, ${failingCrit} failing. Verify each criterion with plan_check_criteria (fixing any failures first), then call plan_complete.`,
                false,
              );
            }
            return;
          }
          st.status = "complete";
          st.completedAt = Date.now();
          st.updatedAt = Date.now();
          evaluateIterations.delete(sessionID);
          stuckIterations.delete(sessionID);
          criteriaNudgeSent.delete(sessionID);
          await save(st);
          await note(sessionID, `${MARK} All plan steps are complete.`);
          return;
        }

        // --- Safety limit: stuck detection (no step completed for N iterations) ---
        const lastCompletedStep = aggregatesOf(st).done;
        if (lastCompletedStep === 0 && st.steps.length > 0) {
          const stuckCount = (stuckIterations.get(sessionID) ?? 0) + 1;
          stuckIterations.set(sessionID, stuckCount);
          if (stuckCount >= MAX_STUCK_ITERATIONS) {
            st.status = "paused";
            st.pausedAt = Date.now();
            st.stoppedReason = `no step completed for ${MAX_STUCK_ITERATIONS} consecutive iterations`;
            st.updatedAt = Date.now();
            await save(st);
            log(`plan paused for ${sessionID}: no step completed for ${MAX_STUCK_ITERATIONS} iterations`);
            await note(
              sessionID,
              `${MARK} Plan paused: no step completed for ${MAX_STUCK_ITERATIONS} consecutive iterations. Use \`/plan resume\` to continue.`,
            );
            return;
          }
        } else {
          stuckIterations.delete(sessionID);
        }

        // In incremental mode, check if there are pending phase approvals
        if (st.executionMode === "incremental" && st.phaseApprovals.length > 0) {
          const hasPendingApprovals = st.phaseApprovals.some((p) => p.status === "pending");
          const hasApprovedPhases = st.phaseApprovals.some((p) => p.status === "approved");
          if (hasPendingApprovals && hasApprovedPhases) {
            // There are phases waiting for approval — pause and notify
            st.status = "paused";
            st.pausedAt = Date.now();
            st.updatedAt = Date.now();
            await save(st);
            const pendingCount = st.phaseApprovals.filter((p) => p.status === "pending").length;
            await note(
              sessionID,
              `${MARK} Waiting for phase approval. ${pendingCount} phase(s) pending. Use \`/plan approve-phase <n>\` to approve.`,
            );
            return;
          }
        }

        // Continue execution
        st.updatedAt = Date.now();
        await save(st);
        await kick(st, "", false);
      } catch (err) {
        log(`evaluate failed for ${sessionID}: ${describeError(err)}`);
      } finally {
        inFlight.delete(sessionID);
      }
    };

    const emergencyStop = async (sessionID: string): Promise<void> => {
      const st = await load(sessionID);
      if (!st) return;

      // PL-16: a completed plan has nothing to stop, and running the stop
      // would rewrite completed child sessions as cancelled and clear the
      // results. Refuse instead.
      if (st.status === "complete") {
        await note(
          sessionID,
          `${MARK} EMERGENCY STOP refused: the plan is already complete. Use \`/plan clear\` to forget it, or \`/plan <task>\` to start a new one.`,
        );
        return;
      }

      // Interrupt all active child sessions
      const activeChildren = st.childSessions.filter(
        (cs) => cs.status === "running" || cs.status === "pending",
      );
      for (const child of activeChildren) {
        try {
          await c.session?.interrupt?.({ sessionID: child.sessionID });
        } catch (err) {
          log(`failed to interrupt child ${child.sessionID}: ${describeError(err)}`);
        }
        child.status = "cancelled";
      }

      // Collect partial results from completed children
      const completedChildren = st.childSessions.filter((cs) => cs.status === "completed");
      for (const child of completedChildren) {
        if (child.result && !st.partialResults.includes(child.result)) {
          st.partialResults.push(child.result);
          while (st.partialResults.length > MAX_PARTIAL_RESULTS) st.partialResults.shift();
        }
      }

      st.status = "stopped";
      st.stoppedReason = "emergency stop";
      st.updatedAt = Date.now();
      await save(st);

      const completedCount = completedChildren.length;
      const cancelledCount = activeChildren.length;
      await note(
        sessionID,
        `${MARK} EMERGENCY STOP executed.\nStatus: stopped\nCompleted: ${completedCount}\nCancelled: ${cancelledCount}\nUse \`/plan resume\` to continue.`,
      );
      log(`emergency stop executed for ${sessionID}: ${completedCount} completed, ${cancelledCount} cancelled`);
    };

    const detectAndApplyDependencies = async (sessionID: string): Promise<string> => {
      const st = await load(sessionID);
      if (!st) return NO_PLAN;
      if (st.steps.length === 0) {
        return `${MARK} No steps in the plan yet.`;
      }
      const detected = detectDependencies(st.steps);
      // PL-3: merge detected dependencies in as step IDs (detectDependencies
      // reports 1-based step numbers).
      for (const d of detected) {
        const step = st.steps[d.step - 1];
        const depStep = st.steps[d.dependsOn - 1];
        if (!step || !depStep || step === depStep) continue;
        if (!Array.isArray(step.dependsOn)) step.dependsOn = [];
        if (!step.dependsOn.includes(depStep.id)) {
          step.dependsOn.push(depStep.id);
        }
      }
      st.updatedAt = Date.now();
      await save(st);
      return dependenciesText(st, detected);
    };

    /* --------------------------------------------------------- step decomposition */

    const COMPLEX_STEP_MIN_LENGTH = 100;

    const ACTION_VERBS = [
      "create", "implement", "build", "add", "design", "setup", "set up", "write",
      "define", "generate", "scaffold", "configure", "install", "migrate", "establish",
      "initialize", "research", "analyze", "plan", "identify", "reproduce",
      "test", "verify", "validate", "update", "extend", "refactor", "use", "run",
      "deploy", "document", "review", "optimize", "fix", "query", "integrate",
      "exercise", "check", "lint", "benchmark", "profile", "cover", "execute",
    ];

    function countActionVerbs(description: string): number {
      const lower = description.toLowerCase();
      let count = 0;
      for (const verb of ACTION_VERBS) {
        if (lower.includes(verb)) count++;
      }
      return count;
    }

    function isComplexStep(description: string): boolean {
      return description.length > COMPLEX_STEP_MIN_LENGTH || countActionVerbs(description) >= 2;
    }

    function generateSubSteps(description: string): string[] {
      // Split on common conjunctions and separators to find logical sub-tasks
      const parts = description
        .split(/(?:,\s*(?:and\s+)?|;\s*|\.\s+|\s+and then\s+|\s+then\s+|\s+and\s+)/i)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      if (parts.length <= 1) {
        // If no natural split points, try to break by action verbs
        const verbSplits: string[] = [];
        let remaining = description;
        for (const verb of ACTION_VERBS) {
          const regex = new RegExp(`\\b${verb}\\b`, "i");
          const match = regex.exec(remaining);
          if (match && match.index > 0) {
            const before = remaining.slice(0, match.index).trim();
            const after = remaining.slice(match.index).trim();
            if (before.length > 10) verbSplits.push(before);
            remaining = after;
          }
        }
        if (remaining.length > 10) verbSplits.push(remaining);
        if (verbSplits.length > 1) return verbSplits;
      }

      // If still only one part, create generic sub-steps
      if (parts.length <= 1) {
        return [
          `Research and plan: ${description}`,
          `Implement: ${description}`,
          `Verify: ${description}`,
        ];
      }

      return parts;
    }

    const decomposeStep = async (sessionID: string, stepNum: number): Promise<string> => {
      const st = await load(sessionID);
      if (!st) return NO_PLAN;
      if (st.status === "complete") {
        return `${MARK} Plan is already complete.`;
      }
      if (st.status === "executing") {
        return `${MARK} Plan is already executing and cannot be modified.`;
      }
      const idx = stepNum - 1;
      if (idx < 0 || idx >= st.steps.length) {
        return `${MARK} Step ${stepNum} does not exist. The plan has ${st.steps.length} step(s).`;
      }
      const step = st.steps[idx];

      // Check if already a parent
      if (step.isParent && step.subSteps && step.subSteps.length > 0) {
        return `${MARK} Step ${stepNum} is already decomposed into ${step.subSteps.length} sub-step(s).`;
      }

      // Check complexity
      if (!isComplexStep(step.description)) {
        return `${MARK} Step ${stepNum} is not complex enough to decompose (description: ${step.description.length} chars, ${countActionVerbs(step.description)} action verbs). Use the step as-is or make it more detailed.`;
      }

      // Generate sub-steps
      const subStepDescs = generateSubSteps(step.description);
      // PL-5: sub-steps count against the same MAX_STEPS ceiling.
      if (st.steps.length + subStepDescs.length > MAX_STEPS) {
        return `${MARK} Cannot decompose step ${stepNum}: the plan has ${st.steps.length} steps and this would add ${subStepDescs.length} more, exceeding the ${MAX_STEPS}-step limit.`;
      }
      const now = Date.now();
      const subStepIds: string[] = [];

      for (const desc of subStepDescs) {
        const subStep: PlanStep = {
          id: `step-${now}-${st.steps.length}`,
          description: desc,
          status: "pending",
          confidence: "medium",
          estimatedDurationMin: estimateDuration(desc),
          estimatedAt: now,
        };
        st.steps.push(subStep);
        subStepIds.push(subStep.id);
      }

      // PL-3: set up sequential dependencies between sub-steps using step IDs.
      for (let i = 1; i < subStepIds.length; i++) {
        const curr = st.steps.find((s) => s.id === subStepIds[i]);
        if (!curr) continue;
        if (!curr.dependsOn) curr.dependsOn = [];
        curr.dependsOn.push(subStepIds[i - 1]);
      }

      // Mark original step as parent (PL-3: subSteps hold step IDs)
      step.isParent = true;
      step.subSteps = subStepIds;

      st.updatedAt = now;
      await save(st);

      const lines = [
        `${MARK} Step ${stepNum} decomposed into ${subStepIds.length} sub-steps:`,
        ``,
        `Parent: ${step.description}`,
        ``,
      ];
      for (let i = 0; i < subStepIds.length; i++) {
        const subStep = st.steps.find((s) => s.id === subStepIds[i]);
        if (!subStep) continue;
        const subIdx = st.steps.indexOf(subStep);
        const deps = subStep.dependsOn ?? [];
        const depStr = deps.length > 0
          ? ` (after: ${deps.map((d) => `Step ${st.steps.findIndex((s) => s.id === d) + 1}`).join(", ")})`
          : "";
        lines.push(`  ${i + 1}. Step ${subIdx + 1}: ${subStep.description}${depStr}`);
      }
      lines.push(``, `The parent step will be marked complete when all sub-steps are done.`);
      return lines.join("\n");
    };

    /* --------------------------------------------------------- tool registration */

    if (c.tool?.transform) {
      try {
        track(
          await c.tool.transform((editor) => {
            editor.add({
              name: "plan_complete",
              description:
                "Session-scoped: no-ops without an active plan in this session. Declare the active plan complete. Only call this when every step is genuinely achieved and verified; include the checks you ran and their observed results as evidence.",
              input: z.object({
                summary: z.string().min(1).describe("One-line summary of what was accomplished."),
                evidence: z
                  .string()
                  .optional()
                  .describe("The exact commands/tests you ran and their results."),
              }),
              execute: (async (
                args: { summary: string; evidence?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is already complete." };
                }
                // Verify success criteria before completing
                if (st.criteria.length > 0) {
                  const unverified = st.criteria.filter((c) => c.status === "pending");
                  if (unverified.length > 0) {
                    return {
                      content: `Cannot complete: ${unverified.length} success criterion/criteria still unverified. Use plan_check_criteria to verify them first.`,
                    };
                  }
                  const failing = st.criteria.filter((c) => c.status === "failing");
                  if (failing.length > 0) {
                    return {
                      content: `Cannot complete: ${failing.length} success criterion/criteria failing: ${failing.map((c) => c.description).join("; ")}`,
                    };
                  }
                }
                st.status = "complete";
                // PL-10: stamp the completion time so metrics/learn duration
                // math works after tool-driven completion.
                st.completedAt = Date.now();
                st.lastSummary = args.summary.trim();
                if (args.evidence) st.evidence = args.evidence;
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content:
                    "Plan marked complete. Give the user a concise final summary now.",
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_blocked",
              description:
                "Session-scoped: no-ops without an active plan in this session. Declare that the active plan cannot be completed without the user. Explains why the loop should stop.",
              input: z.object({
                reason: z.string().min(1).describe("Why you cannot proceed."),
                needs: z.string().optional().describe("What you need from the user to continue."),
              }),
              execute: (async (
                args: { reason: string; needs?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is already complete; nothing to block." };
                }
                st.status = "blocked";
                st.blockedReason = [args.reason.trim(), args.needs ? `Needs: ${args.needs.trim()}` : ""]
                  .filter(Boolean)
                  .join(" — ");
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content:
                    "Plan marked blocked. Tell the user the reason and what you need from them.",
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_progress",
              description:
                "Session-scoped: no-ops without an active plan in this session. Record a milestone while working toward the active plan. Keeps the user informed and tells the plan loop that real progress is happening. Pass `step` (step number or ID) to mark that specific step complete; without it the current in-progress step is completed.",
              input: z.object({
                note: z.string().min(1).describe("What you just accomplished or learned."),
                step: z
                  .union([z.number().int().min(1), z.string().min(1)])
                  .optional()
                  .describe("Optional step number (1-based) or step ID to mark complete. Defaults to the in-progress step."),
              }),
              execute: (async (args: { note: string; step?: number | string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; progress was not recorded." };
                }
                // PL-6: address a specific step by number/ID; only fall back
                // to the in-progress step when no reference was given. A
                // reference that matches nothing must warn, not silently
                // no-op as success.
                const refd = args.step !== undefined ? resolveStepRef(st.steps, args.step) : undefined;
                let warning = "";
                if (refd && !refd.matched) {
                  warning = ` Warning: no step matches "${String(args.step)}" — pass a 1-based step number or step ID; no step was completed.`;
                } else if (refd?.step && refd.step.status !== "pending" && refd.step.status !== "in_progress") {
                  warning = ` Warning: step "${String(args.step)}" is already ${refd.step.status}; no step was completed.`;
                }
                // PL-6: an explicit-but-unmatched reference must NOT fall
                // back to completing some other (in-progress) step.
                const step = args.step !== undefined
                  ? refd?.step
                  : st.steps.find((s) => s.status === "in_progress");
                const stepDone = step && (step.status === "in_progress" || step.status === "pending");
                if (stepDone && step) {
                  step.status = "complete";
                  if (!step.startedAt) step.startedAt = Date.now();
                  step.completedAt = Date.now();
                  // Record checkpoint for completed phase
                  const checkpoint: Checkpoint = {
                    id: `checkpoint-${Date.now()}-${st.checkpoints.length}`,
                    stepId: step.id,
                    stepDescription: step.description,
                    timestamp: Date.now(),
                    summary: args.note.trim(),
                  };
                  st.checkpoints.push(checkpoint);
                  while (st.checkpoints.length > MAX_CHECKPOINTS) st.checkpoints.shift();
                  // PL-5: completing a sub-step can complete its parent.
                  syncParentSteps(st);
                  // Reset consecutive progress counter when a step is completed
                  consecutiveProgress.delete(sessionID);
                } else {
                  // No step was completed — increment counter. PL-6: the
                  // breaker only applies while the plan is actually executing.
                  const count = (consecutiveProgress.get(sessionID) ?? 0) + 1;
                  consecutiveProgress.set(sessionID, count);
                  if (st.status === "executing" && count >= MAX_CONSECUTIVE_PROGRESS_WITHOUT_STEP) {
                    st.status = "paused";
                    st.pausedAt = Date.now();
                    st.stoppedReason = `${count} consecutive plan_progress calls without completing a step`;
                    st.updatedAt = Date.now();
                    await save(st);
                    log(`plan paused for ${sessionID}: ${count} consecutive plan_progress without step completion`);
                    return {
                      content: `Plan paused: ${count} consecutive progress updates without completing a step. Tell the user what you need to proceed.`,
                    };
                  }
                }
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Progress recorded.${warning} Keep going.`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_add_step",
              description:
                "Session-scoped: no-ops without an active plan in this session. Add a new step to the active plan during execution when a subtask was not anticipated in the original plan.",
              input: z.object({
                description: z.string().min(1).describe("What this step accomplishes."),
                confidence: z.enum(["high", "medium", "low"]).optional().describe("Confidence level for this step (default: medium)."),
              }),
              execute: (async (args: { description: string; confidence?: "high" | "medium" | "low" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot add steps." };
                }
                if (st.steps.length >= MAX_STEPS) {
                  return {
                    content: `Cannot add step: plan already has ${MAX_STEPS} steps (maximum). Complete or remove existing steps first.`,
                  };
                }
                const now = Date.now();
                const confidence = args.confidence ?? "medium";
                st.steps.push({
                  id: `step-${Date.now()}-${st.steps.length}`,
                  description: args.description.trim(),
                  status: "pending",
                  confidence,
                  estimatedDurationMin: estimateDuration(args.description),
                  estimatedAt: now,
                });
                st.updatedAt = now;
                await save(st);
                return { content: `Step added: ${args.description.trim()} (estimated: ${estimateDuration(args.description)} min, confidence: ${confidence})` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_set_confidence",
              description:
                "Session-scoped: no-ops without an active plan in this session. Set the confidence level (high, medium, low) for a specific step in the active plan.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to update."),
                confidence: z.enum(["high", "medium", "low"]).describe("The confidence level for this step."),
              }),
              execute: (async (args: { step: number; confidence: "high" | "medium" | "low" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot update step confidence." };
                }
                const idx = args.step - 1;
                if (idx < 0 || idx >= st.steps.length) {
                  return { content: `Step ${args.step} does not exist. The plan has ${st.steps.length} step(s).` };
                }
                st.steps[idx].confidence = args.confidence;
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Step ${args.step} confidence set to ${args.confidence}: ${st.steps[idx].description}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_add_criterion",
              description:
                "Session-scoped: no-ops without an active plan in this session. Add a success criterion to the active plan. Criteria are verified before the plan can be marked complete.",
              input: z.object({
                description: z.string().min(1).describe("What the criterion checks."),
                metric: z.string().min(1).describe("How to measure success (e.g. 'all tests pass', 'latency < 200ms')."),
                maxAttempts: z.number().min(1).max(10).optional().describe("Maximum verification attempts (default 3)."),
              }),
              execute: (async (
                args: { description: string; metric: string; maxAttempts?: number },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot add criteria." };
                }
                const criterion: SuccessCriterion = {
                  id: `criterion-${Date.now()}-${st.criteria.length}`,
                  description: args.description.trim(),
                  metric: args.metric.trim(),
                  status: "pending",
                  attempts: 0,
                  maxAttempts: args.maxAttempts ?? 3,
                };
                st.criteria.push(criterion);
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Criterion added: ${criterion.description}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_check_criteria",
              description:
                "Session-scoped: no-ops without an active plan in this session. Verify success criteria for the active plan. All criteria must pass before the plan can be marked complete.",
              input: z.object({
                results: z
                  .array(
                    z.object({
                      criterionId: z.string().min(1).describe("The criterion ID to update."),
                      status: z.enum(["passing", "failing", "unverifiable"]).describe("Verification result."),
                      result: z.string().optional().describe("Observed result or measurement."),
                    }),
                  )
                  .min(1)
                  .describe("Verification results for each criterion."),
              }),
              execute: (async (
                args: {
                  results: Array<{ criterionId: string; status: "passing" | "failing" | "unverifiable"; result?: string }>;
                },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot check criteria." };
                }
                const lines: string[] = [];
                for (const r of args.results) {
                  const criterion = st.criteria.find((c) => c.id === r.criterionId);
                  if (!criterion) {
                    lines.push(`Unknown criterion: ${r.criterionId}`);
                    continue;
                  }
                  criterion.status = r.status;
                  criterion.attempts += 1;
                  if (r.result) criterion.result = r.result.trim();
                  criterion.checkedAt = Date.now();
                  lines.push(`${criterion.description}: ${r.status}${r.result ? ` — ${r.result}` : ""}`);
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: lines.join("\n") };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_time_estimate",
              description:
                "Session-scoped: no-ops without an active plan in this session. Estimate total plan duration based on step descriptions and compare with actual durations for completed steps.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.steps.length === 0) {
                  return { content: "No steps in the plan yet." };
                }
                const now = Date.now();
                const rows: Array<{
                  step: number;
                  description: string;
                  estimated: string;
                  actual: string;
                  variance: string;
                  status: string;
                }> = [];
                let totalEstimatedMin = 0;
                let totalActualMin = 0;
                let completedCount = 0;
                for (const [i, s] of st.steps.entries()) {
                  const estMin = s.estimatedDurationMin ?? estimateDuration(s.description);
                  totalEstimatedMin += estMin;
                  let actualMin = 0;
                  if (s.startedAt) {
                    const end = s.completedAt ?? now;
                    actualMin = Math.max(0, Math.round((end - s.startedAt) / 60000));
                    totalActualMin += actualMin;
                  }
                  if (s.status === "complete" || s.status === "failed") {
                    completedCount++;
                  }
                  const variance =
                    s.startedAt && s.status !== "pending"
                      ? actualMin > estMin
                        ? `+${actualMin - estMin} min over`
                        : actualMin < estMin
                          ? `${estMin - actualMin} min under`
                          : "on target"
                      : "—";
                  rows.push({
                    step: i + 1,
                    description: s.description,
                    estimated: `${estMin} min`,
                    actual: s.startedAt ? `${actualMin} min` : "—",
                    variance,
                    status: s.status,
                  });
                }
                const lines = [
                  `${MARK} Time Estimate vs Actual`,
                  "",
                  "| Step | Description | Estimated | Actual | Variance | Status |",
                  "|------|-------------|-----------|--------|----------|--------|",
                  ...rows.map(
                    (r) =>
                      `| ${r.step} | ${r.description} | ${r.estimated} | ${r.actual} | ${r.variance} | ${r.status} |`,
                  ),
                  "",
                  `Total estimated: ${totalEstimatedMin} min`,
                  `Total actual: ${totalActualMin} min (${completedCount} step(s) completed)`,
                ];
                if (completedCount === st.steps.length && st.steps.length > 0) {
                  const variancePct =
                    totalEstimatedMin > 0
                      ? Math.round(((totalActualMin - totalEstimatedMin) / totalEstimatedMin) * 100)
                      : 0;
                  const varianceStr =
                    variancePct > 0
                      ? `+${variancePct}% over estimate`
                      : variancePct < 0
                        ? `${variancePct}% under estimate`
                        : "on target";
                  lines.push(`Variance: ${varianceStr}`);
                }
                return { content: lines.join("\n") };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_time_report",
              description:
                "Session-scoped: no-ops without an active plan in this session. Compute and display the time spent on each step of the active plan.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.steps.length === 0) {
                  return { content: "No steps in the plan yet." };
                }
                const now = Date.now();
                const rows: Array<{ step: number; description: string; duration: string; status: string }> = [];
                let totalMs = 0;
                for (const [i, s] of st.steps.entries()) {
                  if (!s.startedAt) continue;
                  const end = s.completedAt ?? now;
                  const durMs = Math.max(0, end - s.startedAt);
                  totalMs += durMs;
                  const durMin = Math.round((durMs / 60000) * 10) / 10;
                  rows.push({
                    step: i + 1,
                    description: s.description,
                    duration: `${durMin} min`,
                    status: s.status,
                  });
                }
                if (rows.length === 0) {
                  return { content: "No steps have been started yet." };
                }
                const lines = [
                  `${MARK} Time Report`,
                  "",
                  "| Step | Description | Duration | Status |",
                  "|------|-------------|----------|--------|",
                  ...rows.map((r) => `| ${r.step} | ${r.description} | ${r.duration} | ${r.status} |`),
                  "",
                  `Total: ${Math.round((totalMs / 60000) * 10) / 10} min across ${rows.length} step(s)`,
                ];
                return { content: lines.join("\n") };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_spawn_child",
              description:
                "Session-scoped: records a child session spawned for plan execution. Call this after spawning a child session so /plan status can track it. Pass `step` (step number or ID) when the step's description is not byte-identical to stepDescription — otherwise the match is silently skipped.",
              input: z.object({
                childSessionID: z.string().min(1).describe("The session ID of the spawned child session."),
                stepDescription: z.string().optional().describe("Which plan step this child session is working on."),
                step: z
                  .union([z.number().int().min(1), z.string().min(1)])
                  .optional()
                  .describe("Optional step number (1-based) or step ID this child session works on. Preferred over stepDescription matching."),
              }),
              execute: (async (
                args: { childSessionID: string; stepDescription?: string; step?: number | string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (!st.childSessions.some((cs) => cs.sessionID === args.childSessionID)) {
                  st.childSessions.push({
                    sessionID: args.childSessionID,
                    task: args.stepDescription?.trim() || "child session",
                    status: "running",
                    spawnedAt: Date.now(),
                  });
                  while (st.childSessions.length > MAX_CHILD_SESSIONS) st.childSessions.shift();
                }
                // PL-6: explicit step reference wins; then exact description
                // match; then a UNIQUE case-insensitive substring match. If
                // nothing matches, say so loudly instead of no-opping.
                const stepDesc = args.stepDescription?.trim();
                let target: PlanStep | undefined;
                let warning = "";
                if (args.step !== undefined) {
                  const refd = resolveStepRef(st.steps, args.step);
                  if (refd.matched && refd.step && (refd.step.status === "pending" || refd.step.status === "in_progress")) {
                    target = refd.step;
                  } else if (!refd.matched) {
                    warning = ` Warning: no step matches "${String(args.step)}" — pass a 1-based step number or step ID; the step was NOT marked in progress.`;
                  }
                }
                if (!target && stepDesc) {
                  target = st.steps.find((s) => s.description === stepDesc && s.status === "pending");
                }
                if (!target && stepDesc) {
                  const lower = stepDesc.toLowerCase();
                  const fuzzy = st.steps.filter(
                    (s) => s.status === "pending" && (s.description.toLowerCase().includes(lower) || lower.includes(s.description.toLowerCase())),
                  );
                  if (fuzzy.length === 1) target = fuzzy[0];
                }
                if (!target && (stepDesc || args.step !== undefined)) {
                  warning = ` Warning: no pending step matches "${stepDesc ?? String(args.step)}" — the step was NOT marked in progress. Pass the step number or ID via the "step" parameter.`;
                }
                if (target) {
                  if (target.status === "pending") {
                    target.status = "in_progress";
                    target.startedAt = Date.now();
                  }
                  target.childSessionID = args.childSessionID;
                  // PL-5: starting a sub-step puts its parent in progress.
                  syncParentSteps(st);
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Child session ${args.childSessionID} recorded.${warning}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_update_cost",
              description:
                "Session-scoped: update the actual cost tracking for the active plan. Call this during execution to record real token usage and cost.",
              input: z.object({
                actualInputTokens: z.number().min(0).describe("Actual input tokens consumed so far."),
                actualOutputTokens: z.number().min(0).describe("Actual output tokens consumed so far."),
                actualCostUsd: z.number().min(0).describe("Actual cost in USD so far."),
              }),
              execute: (async (
                args: { actualInputTokens: number; actualOutputTokens: number; actualCostUsd: number },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (!st.costEstimate) {
                  st.costEstimate = {
                    inputTokens: 0,
                    outputTokens: 0,
                    estimatedCostUsd: 0,
                    estimatedAt: Date.now(),
                  };
                }
                st.costEstimate.actualInputTokens = args.actualInputTokens;
                st.costEstimate.actualOutputTokens = args.actualOutputTokens;
                st.costEstimate.actualCostUsd = args.actualCostUsd;
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Cost updated: $${args.actualCostUsd.toFixed(4)} (${args.actualInputTokens} in / ${args.actualOutputTokens} out)`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_add_risk",
              description:
                "Session-scoped: no-ops without an active plan in this session. Add a risk to the active plan's risk register with likelihood, impact, mitigation, and contingency.",
              input: z.object({
                description: z.string().min(1).describe("What the risk is."),
                likelihood: z.number().min(1).max(5).describe("Likelihood 1-5 (1=rare, 5=almost certain)."),
                impact: z.number().min(1).max(5).describe("Impact 1-5 (1=negligible, 5=severe)."),
                category: z.string().optional().describe("Risk category (e.g. technical, schedule, cost, external)."),
                mitigation: z.string().optional().describe("Strategy to reduce likelihood or impact."),
                contingency: z.string().optional().describe("Plan if the risk materializes."),
                stepId: z.string().optional().describe("Link to a specific plan step."),
              }),
              execute: (async (
                args: { description: string; likelihood: number; impact: number; category?: string; mitigation?: string; contingency?: string; stepId?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot add risks." };
                }
                const now = Date.now();
                const risk: Risk = {
                  id: `risk-${now}-${st.risks.length}`,
                  description: args.description.trim(),
                  likelihood: args.likelihood as RiskLikelihood,
                  impact: args.impact as RiskImpact,
                  category: args.category?.trim() || undefined,
                  mitigation: args.mitigation?.trim() || undefined,
                  contingency: args.contingency?.trim() || undefined,
                  status: "open",
                  identifiedAt: now,
                  updatedAt: now,
                  stepId: args.stepId?.trim() || undefined,
                };
                st.risks.push(risk);
                st.updatedAt = now;
                await save(st);
                const score = risk.likelihood * risk.impact;
                return {
                  content: `Risk added: ${risk.description} (L${risk.likelihood}×I${risk.impact} = ${score}, ${riskLevel(score)})`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_update_risk",
              description:
                "Session-scoped: no-ops without an active plan in this session. Update a risk's status, mitigation, or contingency. Use this to track mitigation progress.",
              input: z.object({
                riskId: z.string().min(1).describe("The risk ID to update."),
                status: z.enum(["open", "mitigated", "accepted", "realized"]).optional().describe("New status for the risk."),
                mitigation: z.string().optional().describe("Updated mitigation strategy."),
                contingency: z.string().optional().describe("Updated contingency plan."),
                notes: z.string().optional().describe("Additional notes."),
              }),
              execute: (async (
                args: { riskId: string; status?: RiskStatus; mitigation?: string; contingency?: string; notes?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                const risk = st.risks.find((r) => r.id === args.riskId);
                if (!risk) return { content: `Risk ${args.riskId} not found.` };
                if (args.status) risk.status = args.status;
                if (args.mitigation !== undefined) risk.mitigation = args.mitigation.trim() || undefined;
                if (args.contingency !== undefined) risk.contingency = args.contingency.trim() || undefined;
                if (args.notes !== undefined) risk.notes = args.notes.trim() || undefined;
                risk.updatedAt = Date.now();
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Risk ${risk.id} updated: status=${risk.status}`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_add_research",
              description:
                "Session-scoped: no-ops without an active plan in this session. Record research findings from web searches during the planning phase. Use this to track what was found, key insights, and sources.",
              input: z.object({
                query: z.string().min(1).describe("The search query that was executed."),
                domain: z.string().min(1).describe("The domain this research relates to (e.g., 'react', 'database')."),
                summary: z.string().min(1).describe("Summary of what was found."),
                keyFindings: z.array(z.string()).optional().describe("Key insights or takeaways from the research."),
                sources: z.array(z.object({
                  url: z.string().min(1),
                  title: z.string().min(1),
                  snippet: z.string().optional(),
                })).optional().describe("Sources/URLs found during research."),
                cached: z.boolean().optional().describe("Whether this result is cached for reuse."),
              }),
              execute: (async (
                args: {
                  query: string;
                  domain: string;
                  summary: string;
                  keyFindings?: string[];
                  sources?: Array<{ url: string; title: string; snippet?: string }>;
                  cached?: boolean;
                },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (!st.research) st.research = [];
                const now = Date.now();
                const result: ResearchResult = {
                  query: args.query.trim(),
                  domain: args.domain.trim(),
                  summary: args.summary.trim(),
                  keyFindings: args.keyFindings ?? [],
                  sources: (args.sources ?? []).map((s) => ({
                    url: s.url,
                    title: s.title,
                    snippet: s.snippet,
                    accessedAt: now,
                  })),
                  cached: args.cached ?? false,
                  searchedAt: now,
                };
                st.research.push(result);
                while (st.research.length > MAX_RESEARCH) st.research.shift();
                st.updatedAt = now;
                await save(st);
                return {
                  content: `Research recorded: "${result.query}" (${result.domain}) — ${result.sources.length} sources`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_update_research",
              description:
                "Session-scoped: no-ops without an active plan in this session. Update a research result's cached status or add additional findings/sources.",
              input: z.object({
                query: z.string().min(1).describe("The search query to update."),
                cached: z.boolean().optional().describe("Update cached status."),
                addFindings: z.array(z.string()).optional().describe("Additional key findings to append."),
                addSources: z.array(z.object({
                  url: z.string().min(1),
                  title: z.string().min(1),
                  snippet: z.string().optional(),
                })).optional().describe("Additional sources to append."),
              }),
              execute: (async (
                args: {
                  query: string;
                  cached?: boolean;
                  addFindings?: string[];
                  addSources?: Array<{ url: string; title: string; snippet?: string }>;
                },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (!st.research) return { content: "No research recorded yet." };
                const result = st.research.find((r) => r.query === args.query.trim());
                if (!result) return { content: `Research for "${args.query}" not found.` };
                if (args.cached !== undefined) result.cached = args.cached;
                if (args.addFindings) result.keyFindings.push(...args.addFindings);
                if (args.addSources) {
                  const now = Date.now();
                  result.sources.push(...args.addSources.map((s) => ({
                    url: s.url,
                    title: s.title,
                    snippet: s.snippet,
                    accessedAt: now,
                  })));
                }
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Research updated: "${result.query}" — ${result.sources.length} sources, ${result.keyFindings.length} findings`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_approve_phase",
              description:
                "Session-scoped: no-ops without an active plan in this session. Approve a specific phase for execution in incremental mode. Call this when the user has approved a phase.",
              input: z.object({
                stepId: z.string().min(1).describe("The step ID to approve."),
              }),
              execute: (async (args: { stepId: string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot approve phases." };
                }
                const phase = st.phaseApprovals.find((p) => p.stepId === args.stepId);
                if (!phase) return { content: `Phase ${args.stepId} not found.` };
                if (phase.status === "approved") {
                  return { content: `Phase ${args.stepId} is already approved.` };
                }
                phase.status = "approved";
                phase.approvedAt = Date.now();
                phase.approvedBy = "agent";
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Phase approved: ${phase.stepDescription}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_checkpoint",
              description:
                "Session-scoped: no-ops without an active plan in this session. Record a checkpoint after completing a phase. Call this to save progress between phases in incremental execution.",
              input: z.object({
                stepId: z.string().min(1).describe("The step ID that was completed."),
                summary: z.string().min(1).describe("What was accomplished in this phase."),
                result: z.string().optional().describe("The result or output of this phase."),
              }),
              execute: (async (
                args: { stepId: string; summary: string; result?: string },
                toolCtx: { sessionID?: string },
              ) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot record checkpoints." };
                }
                const step = st.steps.find((s) => s.id === args.stepId);
                if (!step) return { content: `Step ${args.stepId} not found.` };
                const checkpoint: Checkpoint = {
                  id: `checkpoint-${Date.now()}-${st.checkpoints.length}`,
                  stepId: args.stepId,
                  stepDescription: step.description,
                  timestamp: Date.now(),
                  summary: args.summary.trim(),
                  result: args.result?.trim() || undefined,
                };
                st.checkpoints.push(checkpoint);
                while (st.checkpoints.length > MAX_CHECKPOINTS) st.checkpoints.shift();
                st.updatedAt = Date.now();
                await save(st);
                return {
                  content: `Checkpoint recorded: ${checkpoint.summary}`,
                };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_accessibility",
              description:
                "Generate accessible versions of the plan for different audiences. Produces executive summaries, technical appendices, or PM-focused views depending on the audience parameter.",
              input: z.object({
                audience: z.enum(["executive", "technical", "pm"]).optional().describe("Target audience for the accessible version. Defaults to 'executive'."),
              }),
              execute: (async (args: { audience?: "executive" | "technical" | "pm" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                const audience = args.audience ?? "executive";
                return { content: accessibilityText(st, audience) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_link_decision",
              description:
                "Session-scoped: no-ops without an active plan in this session. Link a decision from the decision-log to a plan step. Use this to track which decisions are relevant to each step.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to link the decision to."),
                decisionId: z.number().min(1).describe("The decision ID from the decision-log to link."),
              }),
              execute: (async (args: { step: number; decisionId: number }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot link decisions." };
                }
                const idx = args.step - 1;
                if (idx < 0 || idx >= st.steps.length) {
                  return { content: `Step ${args.step} does not exist. The plan has ${st.steps.length} step(s).` };
                }
                if (!st.steps[idx].linkedDecisions) st.steps[idx].linkedDecisions = [];
                if (!st.steps[idx].linkedDecisions!.includes(args.decisionId)) {
                  st.steps[idx].linkedDecisions!.push(args.decisionId);
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Decision ${args.decisionId} linked to step ${args.step}: ${st.steps[idx].description}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_link_error",
              description:
                "Session-scoped: no-ops without an active plan in this session. Link an error from the error-journal to a plan step. Use this to track which errors are relevant to each step.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to link the error to."),
                errorId: z.number().min(1).describe("The error ID from the error-journal to link."),
              }),
              execute: (async (args: { step: number; errorId: number }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot link errors." };
                }
                const idx = args.step - 1;
                if (idx < 0 || idx >= st.steps.length) {
                  return { content: `Step ${args.step} does not exist. The plan has ${st.steps.length} step(s).` };
                }
                if (!st.steps[idx].linkedErrors) st.steps[idx].linkedErrors = [];
                if (!st.steps[idx].linkedErrors!.includes(args.errorId)) {
                  st.steps[idx].linkedErrors!.push(args.errorId);
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Error ${args.errorId} linked to step ${args.step}: ${st.steps[idx].description}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_link_snippet",
              description:
                "Session-scoped: no-ops without an active plan in this session. Link a snippet from the snippet-library to a plan step. Use this to track which snippets are relevant to each step.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to link the snippet to."),
                snippetId: z.string().min(1).describe("The snippet ID from the snippet-library to link."),
              }),
              execute: (async (args: { step: number; snippetId: string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status === "complete") {
                  return { content: "The plan is complete; cannot link snippets." };
                }
                const idx = args.step - 1;
                if (idx < 0 || idx >= st.steps.length) {
                  return { content: `Step ${args.step} does not exist. The plan has ${st.steps.length} step(s).` };
                }
                if (!st.steps[idx].linkedSnippets) st.steps[idx].linkedSnippets = [];
                if (!st.steps[idx].linkedSnippets!.includes(args.snippetId)) {
                  st.steps[idx].linkedSnippets!.push(args.snippetId);
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: `Snippet ${args.snippetId} linked to step ${args.step}: ${st.steps[idx].description}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_metrics",
              description:
                "Session-scoped: no-ops without an active plan in this session. Show plan execution metrics and analytics including step counts, completion percentage, duration, tokens, cost, child sessions, risks, and success criteria.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                return { content: metricsText(st) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_test_strategy",
              description:
                "Session-scoped: no-ops without an active plan in this session. Generate a testing strategy for plan steps, recommending test types and estimating coverage.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                return { content: testStrategyText(st) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_cost_optimize",
              description:
                "Session-scoped: no-ops without an active plan in this session. Analyze plan costs and suggest optimizations — identifies steps with high token usage, merge candidates, parallelizable steps, and low-confidence steps that might need re-planning.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                return { content: optimizeText(st) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_detect_dependencies",
              description:
                "Session-scoped: no-ops without an active plan in this session. Analyze step descriptions and detect dependencies between steps — explicit references (e.g. 'step N', 'the previous step'), producer/consumer concept matching (e.g. 'create schema' → 'write queries against the schema'), and test/implement pairing. Auto-populates dependsOn arrays with detected dependencies.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const result = await detectAndApplyDependencies(sessionID);
                return { content: result };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_decompose_step",
              description:
                "Session-scoped: no-ops without an active plan in this session. Decompose a complex step into smaller sub-steps. A step is considered complex if its description is longer than 100 characters or contains multiple action verbs. Sub-steps are created with sequential dependencies, and the original step is marked as a parent.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to decompose."),
              }),
              execute: (async (args: { step: number }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const result = await decomposeStep(sessionID, args.step);
                return { content: result };
              }) as AnyToolDef["execute"],
            });
            void editor.add({
              name: "plan_rollback",
              description: "Rollback plan execution to a previous state using git",
              input: z.object({
                toStep: z.number().min(1).optional().describe("Optional step number to rollback to (default: before the failed step)"),
              }),
              execute: (async (args: { toStep?: number }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: `${MARK} No plan exists for this session.` };
                const result = performRollback(st, args.toStep);
                await save(st);
                return { content: result };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_learn",
              description:
                "Session-scoped: no-ops without an active plan in this session. Analyze completed plan execution and generate insights for future planning — identifies steps that took longer than estimated, failed steps and why, problematic dependencies, materialized risks, and difficult success criteria.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status !== "complete") {
                  return { content: `${MARK} Learning requires a completed plan. The current plan status is: ${STATUS_LABEL[st.status]}. Complete the plan first, then run plan_learn.` };
                }
                const report = learnText(st);
                // Store insights in plan state
                const insights: string[] = [];
                for (const line of report.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith("- ") && !trimmed.startsWith("- Step") && !trimmed.startsWith("- Error") && !trimmed.startsWith("- Result")) {
                    insights.push(trimmed.slice(2));
                  }
                }
                st.insights = insights;
                st.updatedAt = Date.now();
                await save(st);
                return { content: report };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_generate_docs",
              description:
                "Session-scoped: no-ops without an active plan in this session. Generate documentation based on completed plan execution — includes overview, steps, risks, success criteria, insights, and linked items. Supports markdown, html, and json formats.",
              input: z.object({
                format: z.enum(["markdown", "html", "json"]).optional(),
              }),
              execute: (async (args: { format?: "markdown" | "html" | "json" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (st.status !== "complete") {
                  return { content: `${MARK} Documentation requires a completed plan. The current plan status is: ${STATUS_LABEL[st.status]}. Complete the plan first, then run plan_generate_docs.` };
                }
                const format = args.format ?? "markdown";
                const ext = format === "html" ? "html" : format === "json" ? "json" : "md";
                const content = generateDocs(st, format);
                const filename = `plan-docs-${sessionID}.${ext}`;
                const cwd = getCwd();
                const filepath = join(cwd, filename);
                try {
                  const { writeFileSync } = await import("node:fs");
                  writeFileSync(filepath, content, "utf-8");
                } catch (err) {
                  return { content: `${MARK} Failed to write documentation file: ${describeError(err)}` };
                }
                return { content: `${MARK} Documentation generated and saved to: ${filepath}\n\n${content}` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_share",
              description:
                "Session-scoped: no-ops without an active plan in this session. Share a plan via PM tool integration or generate a shareable summary.",
              input: z.object({
                tool: z.enum(["jira", "linear", "github", "slack"]).optional().describe("PM tool to format for"),
              }),
              execute: (async (args: { tool?: "jira" | "linear" | "github" | "slack" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                return { content: shareText(st, args.tool) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_compare",
              description:
                "Session-scoped: no-ops without an active plan in this session. Compare the current plan with an alternative plan.",
              input: z.object({
                alternativePlan: z.string().min(1).describe("The alternative plan text to compare against."),
              }),
              execute: (async (args: { alternativePlan: string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                return { content: compareText(st, args.alternativePlan) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_comment",
              description:
                "Session-scoped: no-ops without an active plan in this session. Add a comment to a plan step.",
              input: z.object({
                step: z.number().min(1).describe("The step number (1-based) to comment on."),
                comment: z.string().min(1).describe("The comment text."),
              }),
              execute: (async (args: { step: number; comment: string }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                const result = addComment(st, args.step, args.comment);
                await save(st);
                return { content: result };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_code_review",
              description:
                "Session-scoped: no-ops without an active plan in this session. Review code changes made during plan execution — analyzes git diff for code quality issues, security concerns, performance problems, test coverage, and documentation.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                const report = codeReviewText(st);
                return { content: report };
              }) as AnyToolDef["execute"],
            });
            editor.add({
              name: "plan_check_resources",
              description:
                "Check resource availability before plan execution — disk space, memory, CPU load, network connectivity, git status, and required dependencies.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, _toolCtx: { sessionID?: string }) => {
                const report = checkResources();
                return { content: formatResourceReport(report) };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_add_project",
              description:
                "Session-scoped: no-ops without an active plan in this session. Add an external project/dependency to the plan for cross-project planning.",
              input: z.object({
                name: z.string().min(1).describe("The project name."),
                path: z.string().min(1).describe("The absolute or relative path to the project."),
                relationship: z.enum(["dependency", "related", "blocks"]).describe("How this project relates to the plan."),
              }),
              execute: (async (args: { name: string; path: string; relationship: "dependency" | "related" | "blocks" }, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                const { existsSync } = await import("node:fs");
                const resolvedPath = resolve(getCwd(), args.path);
                if (!existsSync(resolvedPath)) {
                  return { content: `${MARK} Path does not exist: ${resolvedPath}` };
                }
                if (!st.projects) st.projects = [];
                const existing = st.projects.find((p) => p.name === args.name);
                if (existing) {
                  existing.path = args.path;
                  existing.relationship = args.relationship;
                } else {
                  st.projects.push({ name: args.name, path: args.path, relationship: args.relationship });
                }
                st.updatedAt = Date.now();
                await save(st);
                return { content: `${MARK} Project "${args.name}" added to plan (${args.relationship}).` };
              }) as AnyToolDef["execute"],
            });

            editor.add({
              name: "plan_cross_project_status",
              description:
                "Session-scoped: no-ops without an active plan in this session. Check status of all linked projects — path existence, git repo status, current branch, last commit date, and uncommitted changes.",
              input: z.object({}),
              execute: (async (_args: Record<string, never>, toolCtx: { sessionID?: string }) => {
                const sessionID = toolCtx?.sessionID ?? "";
                const st = await load(sessionID);
                if (!st) return { content: "No plan exists for this session." };
                if (!st.projects || st.projects.length === 0) {
                  return { content: `${MARK} No linked projects. Use plan_add_project to add them.` };
                }
                const { existsSync } = await import("node:fs");
                const { execSync } = await import("node:child_process");
                const lines: string[] = [`${MARK} Cross-Project Status`, ``];
                for (const proj of st.projects) {
                  const resolvedPath = resolve(getCwd(), proj.path);
                  lines.push(`📁 ${proj.name} (${proj.relationship})`);
                  lines.push(`  Path: ${resolvedPath}`);
                  if (!existsSync(resolvedPath)) {
                    lines.push(`  ⚠ Path does not exist`);
                    lines.push(``);
                    continue;
                  }
                  const gitDir = join(resolvedPath, ".git");
                  if (!existsSync(gitDir)) {
                    lines.push(`  Not a git repository`);
                    lines.push(``);
                    continue;
                  }
                  try {
                    const branch = execSync("git branch --show-current", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                    lines.push(`  Branch: ${branch || "(detached HEAD)"}`);
                    const lastCommit = execSync("git log -1 --format=%ci", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                    lines.push(`  Last commit: ${lastCommit || "unknown"}`);
                    const status = execSync("git status --porcelain", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                    if (status) {
                      const count = status.split("\n").length;
                      lines.push(`  Uncommitted changes: ${count} file(s)`);
                    } else {
                      lines.push(`  Working tree: clean`);
                    }
                  } catch {
                    lines.push(`  ⚠ Failed to read git status`);
                  }
                  lines.push(``);
                }
                return { content: lines.join("\n") };
              }) as AnyToolDef["execute"],
            });
          }),
        );
      } catch (err) {
        console.error(`[plan] tool.transform registration failed: ${describeError(err)}`);
      }
    }

    if (c.session.hook) {
      try {
        track(
          await c.session.hook("context", (event) => {
            if (!cfg.enabled) return;
            const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
            if (!sessionID) return;
            const messages = Array.isArray(event.messages) ? event.messages : [];
            for (let i = messages.length - 1; i >= 0; i--) {
              const text = messages[i]?.role === "system" ? textOf(messages[i]) : "";
              if (
                text.includes(REMINDER_SENTINEL) ||
                text === MARK ||
                text.startsWith(MARK + "\n")
              ) {
                messages.splice(i, 1);
              }
            }
            const st = live.get(sessionID);
            if (!st) {
              if (!live.has(sessionID)) {
                load(sessionID).catch((err) => log(`pre-warm load failed for ${sessionID}: ${describeError(err)}`));
              }
              return;
            }
            if (st.status !== "executing" && st.status !== "awaiting_approval") return;
            // Circuit breaker: stop injecting reminders after MAX_CONTEXT_REMINDERS
            const reminderCount = (contextReminderCount.get(sessionID) ?? 0) + 1;
            if (reminderCount > MAX_CONTEXT_REMINDERS) {
              return;
            }
            contextReminderCount.set(sessionID, reminderCount);
            messages.push({
              role: "system",
              content: [{ type: "text", text: `${REMINDER_SENTINEL}\n${MARK}\n${buildReminder(st)}` }],
            });
          }),
        );
      } catch (err) {
        console.error(`[plan] session.hook registration failed: ${describeError(err)}`);
      }
    }

    /* ----------------------------------------------------- command registration */

    if (c.command?.transform) {
      try {
        track(
          await c.command.transform((editor) => {
            editor.add({
              name: "plan",
              description:
                "Plan a task end-to-end: research, clarify with the user, present a plan, then execute it by spawning child sessions (free models first, paid as fallback).",
              execute: async ({ sessionID, prompt, delivery }) => {
                if (!cfg.enabled) {
                  await note(sessionID, `${MARK} The plan plugin is disabled (enabled=false).`);
                  return;
                }
                const { verb, arg } = parseCommand(prompt?.text ?? "");
                switch (verb) {
                  case "help":
                    await note(sessionID, HELP);
                    return;
                  case "status": {
                    const st = await load(sessionID);
                    await note(sessionID, st ? statusText(st) : NO_PLAN);
                    return;
                  }
                  case "stop": {
                    await emergencyStop(sessionID);
                    return;
                  }
                  case "resume": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    if (st.status === "executing") {
                      return void (await note(sessionID, `${MARK} Plan is already executing.`));
                    }
                    if (st.approvalStatus !== "approved") {
                      return void (await note(sessionID, `${MARK} Plan not yet approved. Approve the plan first.`));
                    }
                    st.status = "executing";
                    st.updatedAt = Date.now();
                    delete st.pausedAt;
                    delete st.stoppedReason;
                    // PL-10: a resumed run is not complete.
                    delete st.completedAt;
                    // PL-2: fresh per-run 1h window; reset the loop counters
                    // so a resumed plan doesn't inherit a dead run's counts.
                    st.resumedAt = Date.now();
                    resetSessionCounters(sessionID);
                    if (!st.startedAt) st.startedAt = Date.now();
                    await save(st);
                    const resumeNote = st.executionMode === "incremental" && st.phaseApprovals.length > 0
                      ? "The plan has been resumed by the user. Continue with the next approved phase."
                      : "The plan has been resumed by the user.";
                    await note(sessionID, `${MARK} Plan resumed.`);
                    // PL-7: resume kicks re-issue the model strategy text.
                    await kick(st, resumeNote, false, delivery, true);
                    return;
                  }
                  case "cost": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, costText(st));
                    return;
                  }
                  case "risks": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, risksText(st));
                    return;
                  }
                  case "research": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, researchText(st));
                    return;
                  }
                  case "schedule": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, scheduleText(st));
                    return;
                  }
                  case "model": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const strategy = arg.trim().toLowerCase();
                    if (!strategy) {
                      await note(
                        sessionID,
                        `${MARK} Model strategy: ${st.modelStrategy}\n${MODEL_STRATEGY_INSTRUCTIONS[st.modelStrategy]}\nChange with \`/plan model free|paid|auto|fast\`.`,
                      );
                      return;
                    }
                    if (strategy !== "free" && strategy !== "paid" && strategy !== "auto" && strategy !== "fast") {
                      await note(sessionID, `${MARK} Unknown strategy "${strategy}". Supported: free, paid, auto, fast.`);
                      return;
                    }
                    st.modelStrategy = strategy;
                    st.updatedAt = Date.now();
                    await save(st);
                    // PL-7: re-issue the new strategy's instructions so the
                    // executing model sees them immediately.
                    await note(
                      sessionID,
                      `${MARK} Model strategy set to "${strategy}": ${MODEL_STRATEGY_INSTRUCTIONS[strategy]}`,
                    );
                    return;
                  }
                  case "mode": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const mode = arg.trim().toLowerCase();
                    if (!mode) {
                      await note(
                        sessionID,
                        `${MARK} Execution mode: ${st.executionMode}\n${st.executionMode === "batch" ? "All phases run without per-phase approval." : "Execution pauses between phases for approval."}\nChange with \`/plan mode batch|incremental\`.`,
                      );
                      return;
                    }
                    if (mode !== "batch" && mode !== "incremental") {
                      await note(sessionID, `${MARK} Usage: /plan mode batch|incremental (got "${mode}")`);
                      return;
                    }
                    st.executionMode = mode;
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(
                      sessionID,
                      mode === "batch"
                        ? `${MARK} Execution mode set to "batch": all phases run without per-phase approval pauses.`
                        : `${MARK} Execution mode set to "incremental": execution pauses between phases for approval (\`/plan approve-phase <n>\`).`,
                    );
                    return;
                  }
                  case "template": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const templateName = arg.trim();
                    if (!templateName) {
                      const names = Object.keys(PLAN_TEMPLATES).join(", ");
                      await note(sessionID, `${MARK} Available templates: ${names}`);
                      return;
                    }
                    const template = PLAN_TEMPLATES[templateName];
                    if (!template) {
                      const names = Object.keys(PLAN_TEMPLATES).join(", ");
                      await note(sessionID, `${MARK} Unknown template "${templateName}". Available: ${names}`);
                      return;
                    }
                    st.steps = template.steps.map((desc, i) => ({
                      id: `step-${Date.now()}-${i}`,
                      description: desc,
                      status: "pending" as const,
                      confidence: "medium" as const,
                    }));
                    // PL-3: wholesale step replacement orphans every approval
                    // and sub-step reference to the old step IDs — drop them
                    // so evaluate's phase gate can't deadlock on ghosts.
                    reconcileStepRefs(st);
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Loaded template "${templateName}" (${template.steps.length} steps).`);
                    return;
                  }
                  case "export": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const fmt = arg.trim().toLowerCase();
                    if (fmt && !["markdown", "json", "mermaid", "github"].includes(fmt)) {
                      return void (await note(sessionID, `${MARK} Unknown format "${fmt}". Available formats: markdown, json, mermaid, github`));
                    }
                    await note(sessionID, planExport(st, fmt as "markdown" | "json" | "mermaid" | "github" | undefined));
                    return;
                  }
                  case "pause": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    if (st.status !== "executing") {
                      return void (await note(sessionID, `${MARK} Plan is not currently executing.`));
                    }
                    st.status = "paused";
                    st.pausedAt = Date.now();
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Plan paused between phases. Use \`/plan resume\` to continue.`);
                    return;
                  }
                  case "approve-phase": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    const phaseNum = parseInt(arg.trim(), 10);
                    if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > st.phaseApprovals.length) {
                      await note(sessionID, `${MARK} Invalid phase number. Use \`/plan approve-phase <n>\` where n is 1-${st.phaseApprovals.length}.`);
                      return;
                    }
                    const phase = st.phaseApprovals[phaseNum - 1];
                    if (phase.status === "approved") {
                      await note(sessionID, `${MARK} Phase ${phaseNum} is already approved.`);
                      return;
                    }
                    phase.status = "approved";
                    phase.approvedAt = Date.now();
                    phase.approvedBy = "user";
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Phase ${phaseNum} approved: ${phase.stepDescription}`);
                    return;
                  }
                  case "approve": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    if (st.status === "executing") {
                      return void (await note(sessionID, `${MARK} Plan is already executing.`));
                    }
                    if (st.approvalStatus === "approved") {
                      // PL-15: the review gate tells the user to respond with
                      // "approve" — that second approve (still awaiting
                      // approval) is what starts execution.
                      if (st.status === "awaiting_approval") {
                        st.status = "executing";
                        if (!st.startedAt) st.startedAt = Date.now();
                        // PL-2: fresh per-run window + clean counters.
                        st.resumedAt = Date.now();
                        resetSessionCounters(sessionID);
                        st.updatedAt = Date.now();
                        await save(st);
                        await note(sessionID, `${MARK} Execution confirmed — starting now.`);
                        await kick(st, "", true, delivery);
                        return;
                      }
                      return void (await note(sessionID, `${MARK} Plan is already approved. Use \`/plan resume\` to continue execution.`));
                    }
                    st.approvalStatus = "approved";
                    st.approvedAt = Date.now();
                    st.approvedBy = "user";
                    st.status = "awaiting_approval";
                    st.updatedAt = Date.now();
                    // Initialize phase approvals from steps
                    if (st.steps.length > 0 && st.phaseApprovals.length === 0) {
                      st.phaseApprovals = st.steps.map((s) => ({
                        stepId: s.id,
                        stepDescription: s.description,
                        status: "pending" as PhaseApprovalStatus,
                      }));
                    }
                    await save(st);

                    // Review gate: show execution summary
                    const ce = st.costEstimate;
                    const estTokens = ce ? ce.inputTokens + ce.outputTokens : 0;
                    const estCost = ce ? ce.estimatedCostUsd : 0;
                    const sessionCount = st.steps.length || 1;
                    const totalEstMin = st.steps.reduce(
                      (sum, s) => sum + (s.estimatedDurationMin ?? estimateDuration(s.description)),
                      0,
                    );
                    const reviewLines = [
                      `${MARK} Plan approved.`,
                      ``,
                      `This plan will use ~${estTokens.toLocaleString()} tokens across ${sessionCount} session${sessionCount !== 1 ? "s" : ""}.`,
                    ];
                    if (estCost > 0) {
                      reviewLines.push(`Estimated cost: $${estCost.toFixed(4)}`);
                    }
                    reviewLines.push(`Estimated duration: ~${totalEstMin} minutes`);
                    reviewLines.push(`Plan confidence: ${confidenceSummary(st.steps)}`);
                    const lowConfSteps = st.steps.filter((s) => s.confidence === "low");
                    if (lowConfSteps.length > 0) {
                      reviewLines.push(``, `⚠ Warning: ${lowConfSteps.length} step(s) have low confidence:`);
                      for (const s of lowConfSteps) {
                        reviewLines.push(`  - Step ${st.steps.indexOf(s) + 1}: ${s.description}`);
                      }
                    }
                    // Show insights from previous completed plans
                    const previousInsights = await getPreviousInsights(sessionID);
                    if (previousInsights.length > 0) {
                      reviewLines.push(``, `⚠ Insights from previous plans:`);
                      for (const insight of previousInsights) {
                        reviewLines.push(`  - ${insight}`);
                      }
                    }
                    // Show resource status
                    const resourceReport = checkResources();
                    reviewLines.push(``, `Resource Status:`);
                    for (const check of resourceReport.checks) {
                      const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗";
                      reviewLines.push(`  ${icon} ${check.name}: ${check.value}`);
                    }
                    if (resourceReport.recommendations.length > 0) {
                      reviewLines.push(``, `Recommendations:`);
                      for (const rec of resourceReport.recommendations) {
                        reviewLines.push(`  • ${rec}`);
                      }
                    }
                    if (resourceReport.hasCritical) {
                      reviewLines.push(``, `⚠ CRITICAL: Some resources are critically low or missing.`);
                      reviewLines.push(`  Execution may fail. Address critical issues before proceeding.`);
                      reviewLines.push(``, `Approve execution anyway? (respond with "approve" to begin, or "resources" to see full report)`);
                    } else {
                      reviewLines.push(``, `Approve execution? (respond with "approve" to begin)`);
                    }
                    // PL-7: the review gate must warn about paid models when
                    // the strategy is paid, even before a cost estimate exists.
                    if (st.modelStrategy === "paid" || (ce && ce.estimatedCostUsd > 0)) {
                      reviewLines.push(``, `This will use paid models${ce && ce.estimatedCostUsd > 0 ? ` (~$${estCost.toFixed(4)})` : ""}. Confirm?`);
                    }
                    await note(sessionID, reviewLines.join("\n"));
                    return;
                  }
                  case "reject": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    if (st.status === "executing") {
                      return void (await note(sessionID, `${MARK} Plan is already executing and cannot be rejected.`));
                    }
                    st.approvalStatus = "rejected";
                    st.status = "planning";
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Plan rejected. Return to planning and revise the plan.`);
                    return;
                  }
                  case "edit": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      return void (await note(sessionID, `${MARK} Plan is already complete.`));
                    }
                    if (st.status === "executing") {
                      return void (await note(sessionID, `${MARK} Plan is already executing and cannot be edited.`));
                    }
                    const cmd = parseEditCommand(arg) ?? parseNaturalEditCommand(arg);
                    if (!cmd) {
                      await note(sessionID, `${MARK} Could not parse edit command. Try: "remove step 3", "swap steps 4 and 5", "add error handling to step 2", "make authentication simpler", "use PostgreSQL instead of MySQL".`);
                      return;
                    }
                    let noteText = "";
                    if (cmd.action === "remove") {
                      const idx = cmd.params.index as number;
                      if (idx < 0 || idx >= st.steps.length) {
                        await note(sessionID, `${MARK} Step ${idx + 1} does not exist.`);
                        return;
                      }
                      const desc = st.steps[idx].description;
                      removeStep(st, idx);
                      noteText = `Removed step ${idx + 1}: ${desc}`;
                    } else if (cmd.action === "swap") {
                      const i = cmd.params.i as number;
                      const j = cmd.params.j as number;
                      if (i < 0 || i >= st.steps.length || j < 0 || j >= st.steps.length) {
                        await note(sessionID, `${MARK} Invalid step indices for swap.`);
                        return;
                      }
                      swapSteps(st, i, j);
                      noteText = `Swapped steps ${i + 1} and ${j + 1}`;
                    } else if (cmd.action === "skip") {
                      const idx = cmd.params.index as number | undefined;
                      const match = cmd.params.match as string | undefined;
                      let targetIdx: number;
                      if (idx !== undefined) {
                        targetIdx = idx;
                      } else if (match) {
                        targetIdx = st.steps.findIndex((s) => s.description.toLowerCase().includes(match));
                        if (targetIdx === -1) {
                          await note(sessionID, `${MARK} No step found matching "${match}".`);
                          return;
                        }
                      } else {
                        await note(sessionID, `${MARK} Invalid skip command.`);
                        return;
                      }
                      if (targetIdx < 0 || targetIdx >= st.steps.length) {
                        await note(sessionID, `${MARK} Step ${targetIdx + 1} does not exist.`);
                        return;
                      }
                      st.steps[targetIdx].status = "skipped";
                      // PL-5: skipping the last open sub-step completes its parent.
                      syncParentSteps(st);
                      noteText = `Skipped step ${targetIdx + 1}: ${st.steps[targetIdx].description}`;
                    } else if (cmd.action === "modify") {
                      const match = cmd.params.match as string | undefined;
                      const noteParam = cmd.params.note as string | undefined;
                      const add = cmd.params.add as string | undefined;
                      const remove = cmd.params.remove as string | undefined;
                      const replace = cmd.params.replace as string | undefined;
                      if (match || noteParam || add || remove || replace) {
                        const idx = cmd.params.index as number | undefined;
                        let targetIdx: number;
                        if (idx !== undefined) {
                          targetIdx = idx;
                        } else if (match) {
                          targetIdx = st.steps.findIndex((s) => s.description.toLowerCase().includes(match));
                          if (targetIdx === -1) {
                            await note(sessionID, `${MARK} No step found matching "${match}".`);
                            return;
                          }
                        } else {
                          await note(sessionID, `${MARK} Invalid modify command.`);
                          return;
                        }
                        if (targetIdx < 0 || targetIdx >= st.steps.length) {
                          await note(sessionID, `${MARK} Step ${targetIdx + 1} does not exist.`);
                          return;
                        }
                        let desc = st.steps[targetIdx].description;
                        if (remove) {
                          desc = desc.replace(new RegExp(remove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
                        }
                        if (replace && match) {
                          desc = desc.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replace).trim();
                        }
                        if (add) {
                          desc = `${desc} (add: ${add})`;
                        }
                        if (noteParam) {
                          desc = `${desc} [${noteParam}]`;
                        }
                        modifyStep(st, targetIdx, desc);
                        noteText = `Modified step ${targetIdx + 1}: ${st.steps[targetIdx].description}`;
                      } else {
                        const idx = cmd.params.index as number;
                        const desc = cmd.params.description as string;
                        if (idx < 0 || idx >= st.steps.length) {
                          await note(sessionID, `${MARK} Step ${idx + 1} does not exist.`);
                          return;
                        }
                        modifyStep(st, idx, desc);
                        noteText = `Modified step ${idx + 1}: ${st.steps[idx].description}`;
                      }
                    }
                    snapshotVersion(st, noteText);
                    st.updatedAt = Date.now();
                    await save(st);
                    const revisedLines = [
                      `${MARK} Plan updated (v${st.version}).`,
                      noteText,
                      ``,
                      `Revised steps:`,
                      ...st.steps.map((s, i) => `  ${i + 1}. [${s.status}] ${s.description}`),
                    ];
                    await note(sessionID, revisedLines.join("\n"));
                    return;
                  }
                  case "diff": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const parts = arg.trim().split(/\s+/);
                    const fromVer = parts[0] ? parseInt(parts[0], 10) : undefined;
                    const toVer = parts[1] ? parseInt(parts[1], 10) : undefined;
                    await note(sessionID, diffText(st, fromVer, toVer));
                    return;
                  }
                  case "revert": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status === "complete") {
                      await note(sessionID, `${MARK} Plan is already complete.`);
                      return;
                    }
                    const targetVersion = arg.trim() ? parseInt(arg.trim(), 10) : st.version - 1;
                    if (isNaN(targetVersion) || targetVersion < 1) {
                      await note(sessionID, `${MARK} Invalid version number. Use \`/plan revert <version>\`.`);
                      return;
                    }
                    const target = st.history.find((v) => v.version === targetVersion);
                    if (!target) {
                      await note(sessionID, `${MARK} Version ${targetVersion} not found in history.`);
                      return;
                    }
                    snapshotVersion(st, "Reverted to v" + targetVersion);
                    st.steps = structuredClone(target.steps).map((s: PlanStep) => normalizeStep(s));
                    // PL-3: the restored step set can orphan phase approvals
                    // and sub-step references left over from the newer version.
                    reconcileStepRefs(st);
                    st.planText = target.planText;
                    st.updatedAt = Date.now();
                    await save(st);
                    const lines = [
                      `${MARK} Reverted to v${targetVersion}.`,
                      ``,
                      `Restored steps:`,
                      ...st.steps.map((s, i) => `  ${i + 1}. [${s.status}] ${s.description}`),
                    ];
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "rollback": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const toStep = arg.trim() ? parseInt(arg.trim(), 10) : undefined;
                    if (arg.trim() && (isNaN(toStep as number) || (toStep as number) < 1)) {
                      await note(sessionID, `${MARK} Invalid step number. Use \`/plan rollback [step]\`.`);
                      return;
                    }
                    const result = performRollback(st, toStep);
                    await save(st);
                    await note(sessionID, result);
                    return;
                  }
                  case "learn": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status !== "complete") {
                      await note(sessionID, `${MARK} Learning requires a completed plan. The current plan status is: ${STATUS_LABEL[st.status]}. Complete the plan first, then run \`/plan learn\`.`);
                      return;
                    }
                    const report = learnText(st);
                    // Store insights in plan state
                    const insights: string[] = [];
                    for (const line of report.split("\n")) {
                      const trimmed = line.trim();
                      if (trimmed.startsWith("- ") && !trimmed.startsWith("- Step") && !trimmed.startsWith("- Error") && !trimmed.startsWith("- Result")) {
                        insights.push(trimmed.slice(2));
                      }
                    }
                    st.insights = insights;
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, report);
                    return;
                  }
                  case "docs": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.status !== "complete") {
                      await note(sessionID, `${MARK} Documentation requires a completed plan. The current plan status is: ${STATUS_LABEL[st.status]}. Complete the plan first, then run \`/plan docs\`.`);
                      return;
                    }
                    const format = (arg || "markdown") as "markdown" | "html" | "json";
                    const ext = format === "html" ? "html" : format === "json" ? "json" : "md";
                    const content = generateDocs(st, format);
                    const filename = `plan-docs-${sessionID}.${ext}`;
                    const cwd = getCwd();
                    const filepath = join(cwd, filename);
                    try {
                      const { writeFileSync } = await import("node:fs");
                      writeFileSync(filepath, content, "utf-8");
                    } catch (err) {
                      await note(sessionID, `${MARK} Failed to write documentation file: ${describeError(err)}`);
                      return;
                    }
                    await note(sessionID, `${MARK} Documentation generated and saved to: ${filepath}\n\n${content}`);
                    return;
                  }
                  case "done":
                  case "complete": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    st.status = "complete";
                    // PL-10: stamp completion time (metrics/learn rely on it).
                    st.completedAt = Date.now();
                    st.lastSummary = "Marked complete by the user.";
                    st.updatedAt = Date.now();
                    await save(st);
                    await note(sessionID, `${MARK} Plan marked complete.`);
                    return;
                  }
                  case "step": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const stepNum = parseInt(arg.trim(), 10);
                    if (isNaN(stepNum) || stepNum < 1 || stepNum > st.steps.length) {
                      await note(sessionID, `${MARK} Invalid step number. Use \`/plan step <n>\` where n is 1-${st.steps.length}.`);
                      return;
                    }
                    const step = st.steps[stepNum - 1];
                    const conf = step.confidence ?? "medium";
                    const lines = [
                      `${MARK} Step ${stepNum}`,
                      `Description: ${step.description}`,
                      `Status: ${step.status}`,
                      `Confidence: ${confidenceIcon(conf)} ${conf}`,
                    ];
                    if (step.startedAt) {
                      const end = step.completedAt ?? Date.now();
                      const durMin = Math.max(0, Math.round((end - step.startedAt) / 60000));
                      lines.push(`Duration: ${durMin} min`);
                    }
                    if (step.result) lines.push(`Result: ${step.result}`);
                    if (step.error) lines.push(`Error: ${step.error}`);
                    if (step.childSessionID) lines.push(`Child session: ${step.childSessionID}`);
                    if (step.linkedDecisions && step.linkedDecisions.length > 0) {
                      lines.push(`Linked decisions: ${step.linkedDecisions.join(", ")}`);
                    }
                    if (step.linkedErrors && step.linkedErrors.length > 0) {
                      lines.push(`Linked errors: ${step.linkedErrors.join(", ")}`);
                    }
                    if (step.linkedSnippets && step.linkedSnippets.length > 0) {
                      lines.push(`Linked snippets: ${step.linkedSnippets.join(", ")}`);
                    }
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "criteria": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.criteria.length === 0) {
                      await note(sessionID, `${MARK} No success criteria defined. Use plan_add_criterion to add them.`);
                      return;
                    }
                    const lines: string[] = [
                      `${MARK} Success Criteria`,
                      ``,
                    ];
                    for (const c of st.criteria) {
                      const icon = c.status === "passing" ? "✓" : c.status === "failing" ? "✗" : c.status === "unverifiable" ? "?" : "·";
                      lines.push(`${icon} ${c.description} (${c.metric}) — ${c.status}`);
                      if (c.result) lines.push(`  Result: ${c.result}`);
                      lines.push(`  Attempts: ${c.attempts}/${c.maxAttempts}`);
                    }
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "time": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.steps.length === 0) {
                      await note(sessionID, `${MARK} No steps in the plan yet.`);
                      return;
                    }
                    const now = Date.now();
                    const rows: Array<{ step: number; description: string; duration: string; status: string }> = [];
                    let totalMs = 0;
                    for (const [i, s] of st.steps.entries()) {
                      if (!s.startedAt) continue;
                      const end = s.completedAt ?? now;
                      const durMs = Math.max(0, end - s.startedAt);
                      totalMs += durMs;
                      const durMin = Math.round((durMs / 60000) * 10) / 10;
                      rows.push({
                        step: i + 1,
                        description: s.description,
                        duration: `${durMin} min`,
                        status: s.status,
                      });
                    }
                    if (rows.length === 0) {
                      await note(sessionID, `${MARK} No steps have been started yet.`);
                      return;
                    }
                    const lines = [
                      `${MARK} Time Report`,
                      "",
                      "| Step | Description | Duration | Status |",
                      "|------|-------------|----------|--------|",
                      ...rows.map((r) => `| ${r.step} | ${r.description} | ${r.duration} | ${r.status} |`),
                      "",
                      `Total: ${Math.round((totalMs / 60000) * 10) / 10} min across ${rows.length} step(s)`,
                    ];
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "estimate": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (st.steps.length === 0) {
                      await note(sessionID, `${MARK} No steps in the plan yet.`);
                      return;
                    }
                    const now = Date.now();
                    const rows: Array<{
                      step: number;
                      description: string;
                      estimated: string;
                      actual: string;
                      variance: string;
                      status: string;
                    }> = [];
                    let totalEstimatedMin = 0;
                    let totalActualMin = 0;
                    let completedCount = 0;
                    for (const [i, s] of st.steps.entries()) {
                      const estMin = s.estimatedDurationMin ?? estimateDuration(s.description);
                      totalEstimatedMin += estMin;
                      let actualMin = 0;
                      if (s.startedAt) {
                        const end = s.completedAt ?? now;
                        actualMin = Math.max(0, Math.round((end - s.startedAt) / 60000));
                        totalActualMin += actualMin;
                      }
                      if (s.status === "complete" || s.status === "failed") {
                        completedCount++;
                      }
                      const variance =
                        s.startedAt && s.status !== "pending"
                          ? actualMin > estMin
                            ? `+${actualMin - estMin} min over`
                            : actualMin < estMin
                              ? `${estMin - actualMin} min under`
                              : "on target"
                          : "—";
                      rows.push({
                        step: i + 1,
                        description: s.description,
                        estimated: `${estMin} min`,
                        actual: s.startedAt ? `${actualMin} min` : "—",
                        variance,
                        status: s.status,
                      });
                    }
                    const lines = [
                      `${MARK} Time Estimate vs Actual`,
                      "",
                      "| Step | Description | Estimated | Actual | Variance | Status |",
                      "|------|-------------|-----------|--------|----------|--------|",
                      ...rows.map(
                        (r) =>
                          `| ${r.step} | ${r.description} | ${r.estimated} | ${r.actual} | ${r.variance} | ${r.status} |`,
                      ),
                      "",
                      `Total estimated: ${totalEstimatedMin} min`,
                      `Total actual: ${totalActualMin} min (${completedCount} step(s) completed)`,
                    ];
                    if (completedCount === st.steps.length && st.steps.length > 0) {
                      const variancePct =
                        totalEstimatedMin > 0
                          ? Math.round(((totalActualMin - totalEstimatedMin) / totalEstimatedMin) * 100)
                          : 0;
                      const varianceStr =
                        variancePct > 0
                          ? `+${variancePct}% over estimate`
                          : variancePct < 0
                            ? `${variancePct}% under estimate`
                            : "on target";
                      lines.push(`Variance: ${varianceStr}`);
                    }
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "metrics": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, metricsText(st));
                    return;
                  }
                  case "optimize": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, optimizeText(st));
                    return;
                  }
                  case "dependencies": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const result = await detectAndApplyDependencies(sessionID);
                    await note(sessionID, result);
                    return;
                  }
                  case "decompose": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const stepNum = parseInt(arg.trim(), 10);
                    if (isNaN(stepNum) || stepNum < 1 || stepNum > st.steps.length) {
                      await note(sessionID, `${MARK} Invalid step number. Use \`/plan decompose <n>\` where n is 1-${st.steps.length}.`);
                      return;
                    }
                    const result = await decomposeStep(sessionID, stepNum);
                    await note(sessionID, result);
                    return;
                  }
                  case "test-strategy": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, testStrategyText(st));
                    return;
                  }
                  case "share": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const tool = arg.trim() as "jira" | "linear" | "github" | "slack" | undefined;
                    await note(sessionID, shareText(st, tool || undefined));
                    return;
                  }
                  case "comment": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const match = /^(\d+)\s+([\s\S]+)$/.exec(arg.trim());
                    if (!match) {
                      await note(sessionID, `${MARK} Usage: /plan comment <step> <text>`);
                      return;
                    }
                    const stepNum = parseInt(match[1], 10);
                    const commentText = match[2];
                    const result = addComment(st, stepNum, commentText);
                    await save(st);
                    await note(sessionID, result);
                    return;
                  }
                  case "compare": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const alternativePlan = arg.trim();
                    if (!alternativePlan) {
                      await note(sessionID, `${MARK} Usage: /plan compare <alternative plan text>`);
                      return;
                    }
                    await note(sessionID, compareText(st, alternativePlan));
                    return;
                  }
                  case "review": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    await note(sessionID, codeReviewText(st));
                    return;
                  }
                  case "clear": {
                    await clear(sessionID);
                    await note(sessionID, `${MARK} Plan cleared.`);
                    return;
                  }
                  case "resources": {
                    const report = checkResources();
                    await note(sessionID, formatResourceReport(report));
                    return;
                  }
                  case "projects": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    if (!st.projects || st.projects.length === 0) {
                      await note(sessionID, `${MARK} No linked projects. Use plan_add_project to add them.`);
                      return;
                    }
                    const { existsSync } = await import("node:fs");
                    const { execSync } = await import("node:child_process");
                    const lines: string[] = [`${MARK} Linked Projects`, ``];
                    for (const proj of st.projects) {
                      const resolvedPath = resolve(getCwd(), proj.path);
                      lines.push(`📁 ${proj.name} (${proj.relationship})`);
                      lines.push(`  Path: ${resolvedPath}`);
                      if (!existsSync(resolvedPath)) {
                        lines.push(`  ⚠ Path does not exist`);
                        lines.push(``);
                        continue;
                      }
                      const gitDir = join(resolvedPath, ".git");
                      if (!existsSync(gitDir)) {
                        lines.push(`  Not a git repository`);
                        lines.push(``);
                        continue;
                      }
                      try {
                        const branch = execSync("git branch --show-current", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                        lines.push(`  Branch: ${branch || "(detached HEAD)"}`);
                        const lastCommit = execSync("git log -1 --format=%ci", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                        lines.push(`  Last commit: ${lastCommit || "unknown"}`);
                        const status = execSync("git status --porcelain", { cwd: resolvedPath, encoding: "utf-8" }).trim();
                        if (status) {
                          const count = status.split("\n").length;
                          lines.push(`  Uncommitted changes: ${count} file(s)`);
                        } else {
                          lines.push(`  Working tree: clean`);
                        }
                      } catch {
                        lines.push(`  ⚠ Failed to read git status`);
                      }
                      lines.push(``);
                    }
                    await note(sessionID, lines.join("\n"));
                    return;
                  }
                  case "accessibility": {
                    const st = await load(sessionID);
                    if (!st) return void (await note(sessionID, NO_PLAN));
                    const audience = (arg.trim() || "executive") as "executive" | "technical" | "pm";
                    await note(sessionID, accessibilityText(st, audience));
                    return;
                  }
                  default: {
                    // PL-1: replacing a live plan (executing / awaiting
                    // approval) must be explicit — require "replace" as the
                    // first word, e.g. `/plan replace new task`.
                    let task = arg.trim();
                    const replaceFlag = /^replace\b\s*/i.exec(task);
                    const confirmedReplace = !!replaceFlag;
                    if (replaceFlag) task = task.slice(replaceFlag[0].length).trim();
                    if (!task) return void (await note(sessionID, HELP));
                    const existing = await load(sessionID);
                    if (
                      existing &&
                      (existing.status === "executing" || existing.status === "awaiting_approval") &&
                      !confirmedReplace
                    ) {
                      await note(
                        sessionID,
                        `${MARK} Refusing to replace the current plan ("${truncate(existing.task, 60)}", ${STATUS_LABEL[existing.status]}). Use \`/plan clear\` to drop it first, or re-run with the replace flag: \`/plan replace ${truncate(task, 60)}\`.`,
                      );
                      return;
                    }
                    if (existing) {
                      // Replace existing plan. PL-9: always clear() so the
                      // generation bumps even when replacing a complete plan,
                      // and PL-2: clear() drops all per-session counters for
                      // the old plan.
                      await clear(sessionID);
                    }
                    const st = newPlan(sessionID, task);
                    await save(st);
                    await note(
                      sessionID,
                      `${MARK} Plan created.\nTask: ${st.task}\nStatus: researching.`,
                    );
                    const researchPrompt = buildResearchPrompt(task);
                    const text = `${planPrompt(cfg.maxParallelChildren, st.modelStrategy)}\n\n---\n\nThe user wants to plan: ${task}${researchPrompt}`;
                    try {
                      await c.session?.prompt?.({
                        sessionID,
                        text,
                        delivery,
                      });
                    } catch (err) {
                      console.error(`[plan] /plan failed to inject: ${describeError(err)}`);
                      throw err;
                    }
                    return;
                  }
                }
              },
            });
          }),
        );
      } catch (err) {
        console.error(`[plan] command registration failed: ${describeError(err)}`);
      }
    }

    /* ------------------------------------------------------------ event loop */

    const abort = new AbortController();
    if (hasEvents) {
      void (async () => {
        try {
          for await (const event of c.event!.subscribe!({ signal: abort.signal })) {
            if (!cfg.enabled) continue;
            const type = String(event?.type ?? "");
            const data = (event?.data ?? {}) as Record<string, unknown>;
            const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
            if (!sessionID) continue;
            if (type === "session.execution.interrupted") {
              const reason = typeof data.reason === "string" ? data.reason : "";
              void interrupt(sessionID, reason).catch((err) => console.error(`[plan] interrupt failed for ${sessionID}: ${describeError(err)}`));
            } else if (type === "session.idle" || type === "session.execution.succeeded") {
              void evaluate(sessionID, false).catch((err) => console.error(`[plan] evaluate failed for ${sessionID}: ${describeError(err)}`));
            } else if (type === "session.execution.failed") {
              void evaluate(sessionID, true).catch((err) => console.error(`[plan] evaluate failed for ${sessionID}: ${describeError(err)}`));
            }
          }
        } catch (err) {
          if (!abort.signal.aborted) console.error(`[plan] event stream ended: ${describeError(err)}`);
        }
      })();
    }

    if (cfg.log) {
      console.error(`[plan] ready.`);
    }

    return async () => {
      abort.abort();
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          /* best effort */
        }
      }
      live.clear();
      loading.clear();
      inFlight.clear();
      evaluateIterations.clear();
      lastEvaluatedUpdatedAt.clear();
      lastSavedUpdatedAt.clear();
      lastSavedInsights.clear();
      consecutiveProgress.clear();
      stuckIterations.clear();
      contextReminderCount.clear();
      criteriaNudgeSent.clear();
      generations.clear();
    };
  },
});

/** Test seam (mirrors the `__test__` precedent in memory/code-review). */
export const __test__ = {
  migratePlan,
  removeStep,
  swapSteps,
  reconcileStepRefs,
  syncParentSteps,
  resolveStepRef,
  resolvedDeps,
  stepIndexOf,
  MODEL_STRATEGY_INSTRUCTIONS,
};

/* --------------------------------------------------------------- helpers */

function textOf(message: RawMessage | undefined): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .map((p) => {
      if (p?.type === "text" && typeof p.text === "string") return p.text;
      if (p && typeof p === "object") {
        try {
          return `[part type=${String(p.type ?? "unknown")}: ${truncate(JSON.stringify(p), 200)}]`;
        } catch {
          return `[part type=${String(p.type ?? "unknown")}: unstringifiable]`;
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
