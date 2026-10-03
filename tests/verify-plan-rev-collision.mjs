/**
 * Millisecond-collision regression test for the plan plugin's change guards.
 *
 *   node tests/verify-plan-rev-collision.mjs
 *
 * Date.now() is frozen so every mutation lands in the same millisecond. Before
 * the revision counter, `updatedAt` could not distinguish them, so the second
 * save() was skipped as "unchanged" and its write was lost — and evaluate()
 * skipped a genuinely changed plan.
 */
const mod = await import(new URL("../plugins/plan.ts", import.meta.url));
const plugin = mod.default;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

/* Freeze the clock: updatedAt can no longer move. */
const realNow = Date.now;
const FROZEN = 1_700_000_000_000;
Date.now = () => FROZEN;

try {
  const store = new Map();
  const tools = [];
  const hooks = {};

  const ctx = {
    options: {},
    app: { name: "opencode", version: "2.0.0", channel: "desktop" },
    config: async () => ({ enabled: true, notify: false }),
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) });
        return { dispose: async () => {} };
      },
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    command: { transform: async (cb) => { cb({ add: () => {} }); return { dispose: async () => {} }; } },
    session: {
      prompt: async () => {},
      synthetic: async () => {},
      get: async () => undefined,
      context: async () => [],
    },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v);
      },
    },
    directory: { path: process.cwd() },
    model: { list: async () => ({ location: {}, data: [] }) },
  };

  await plugin.setup(ctx);

  const byName = new Map(tools.map((t) => [t.name, t]));
  check("plan tools registered", byName.has("plan_add_step") && byName.has("plan_add_criterion"));

  const sid = "ses_rev_collision";

  // Start a plan through the plugin's own path.
  const started = await hooks["tool.execute.before"]?.({
    sessionID: sid,
    tool: "plan_complete",
    args: {},
  });
  void started;

  // Seed a plan directly through storage so the test does not depend on the
  // command surface, then let the plugin load it.
  const seedKey = `plan.v1.${sid}`;
  store.set(seedKey, {
    sessionID: sid,
    task: "collision test plan",
    status: "executing",
    steps: [{ id: "s1", description: "first step", status: "pending", deps: [], confidence: "medium" }],
    criteria: [],
    risks: [],
    research: [],
    insights: [],
    checkpoints: [],
    comments: [],
    childSessions: [],
    partialResults: [],
    history: [],
    phaseApprovals: [],
    dependencies: [],
    projects: [],
    modelStrategy: "auto",
    executionMode: "incremental",
    createdAt: FROZEN,
    updatedAt: FROZEN,
    rev: 0,
  });

  const toolCtx = { sessionID: sid };

  // Two mutations back to back, same frozen millisecond.
  await byName.get("plan_add_criterion").execute(
    { description: "latency under 200ms", metric: "p95 < 200ms" },
    toolCtx,
  );
  const afterFirst = store.get(seedKey);
  const revAfterFirst = afterFirst?.rev;
  const criteriaAfterFirst = afterFirst?.criteria?.length ?? 0;

  await byName.get("plan_add_step").execute({ description: "second step" }, toolCtx);
  const afterSecond = store.get(seedKey);

  check("first mutation persisted a criterion", criteriaAfterFirst === 1, `criteria=${criteriaAfterFirst}`);
  check("revision counter advanced past the seed", typeof revAfterFirst === "number" && revAfterFirst > 0, `rev=${revAfterFirst}`);

  // This is the regression: with the clock frozen, updatedAt is unchanged
  // across both saves, so the old guard treated the second save as a no-op.
  check(
    "updatedAt could not distinguish the two mutations (precondition)",
    afterSecond?.updatedAt === FROZEN,
    `updatedAt=${afterSecond?.updatedAt}`,
  );
  check(
    "second mutation was NOT skipped as redundant",
    (afterSecond?.steps?.length ?? 0) === 2,
    `steps=${afterSecond?.steps?.length}`,
  );
  check(
    "revision advanced again for the second mutation",
    (afterSecond?.rev ?? 0) > (revAfterFirst ?? 0),
    `${revAfterFirst} -> ${afterSecond?.rev}`,
  );

  // A genuinely redundant save (no mutation) should still be skipped.
  const before = store.get(seedKey);
  const savesBefore = store.get(seedKey);
  void savesBefore;
  // plan_add_criterion with an empty description is rejected by the schema, so
  // instead re-save via a no-op tool that loads and saves without mutating.
  const statusTool = byName.get("plan_metrics");
  if (statusTool) await statusTool.execute({}, toolCtx);
  const after = store.get(seedKey);
  check(
    "read-only tool did not bump the revision",
    after?.rev === before?.rev,
    `rev ${before?.rev} -> ${after?.rev}`,
  );
} finally {
  Date.now = realNow;
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);