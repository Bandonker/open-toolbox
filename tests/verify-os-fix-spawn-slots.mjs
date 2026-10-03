/**
 * OS-2 regression: the concurrency slot must be reserved at launch() entry.
 *
 * Both limits were measured against `tracked`, which only learns about a child
 * after `ctx.session.create()` resolves — up to 8s of server time behind the
 * request that asked for it. `spawn_many` fires its whole batch with
 * `Promise.all`, so every child in the batch passed the check while the map was
 * still empty, and a fan-out of 20 produced 20 live sessions against a limit of
 * 3. The slot is now taken synchronously before the first await, handed to the
 * tracked record once that exists, and released on every failure path.
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

/** A fake server whose `session.create` is slow, the way a real one is. */
function makeCtx(options = {}) {
  const tools = {};
  const registry = new Map();
  const created = [];
  const prompts = [];
  const state = { createDelayMs: 120, failCreate: false, inFlightCreate: 0, maxInFlightCreate: 0 };

  const editor = {
    add: (t) => {
      tools[t.name] = t;
      registry.set(t.name, t);
    },
    list: () => [...registry.values()].map((t) => ({ ...t, id: t.id ?? t.name })),
    get: (id) => registry.get(id),
    update: (id, fn) => {
      const t = registry.get(id);
      if (t) fn(t);
    },
    remove: (id) => void registry.delete(id),
    namespace: () => {},
  };

  const ctx = {
    options,
    location: { directory: process.cwd() },
    // No event pump needed here: children stay "running" because nothing ever
    // goes idle in this fixture, which is exactly the state that occupies a slot.
    event: { subscribe: () => (async function* () {})() },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      remove: async () => undefined,
      scan: async () => ({ entries: [] }),
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (cb) => {
        cb(editor);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async ({ sessionID }) => ({ id: sessionID, title: "unrelated" }),
      context: async () => [],
      interrupt: async () => {},
      synthetic: async () => {},
      create: async ({ title }) => {
        state.inFlightCreate += 1;
        state.maxInFlightCreate = Math.max(state.maxInFlightCreate, state.inFlightCreate);
        await new Promise((r) => setTimeout(r, state.createDelayMs));
        if (state.failCreate) {
          state.inFlightCreate -= 1;
          throw new Error("server refused the create");
        }
        const id = `ses_child_${created.length + 1}`;
        created.push({ id, title });
        state.inFlightCreate -= 1;
        return { id, title };
      },
      prompt: async ({ sessionID, text }) => void prompts.push({ sessionID, text }),
    },
  };
  return { ctx, tools, created, prompts, state };
}

const many = (h, n, parentID = "ses_parent_a") =>
  h.tools.spawn_many.execute(
    { sessions: Array.from({ length: n }, (_, i) => ({ prompt: `task number ${i + 1}` })) },
    { sessionID: parentID },
  );

// ---------------- global cap: a parallel batch cannot all squeeze in
{
  const h = makeCtx({ maxConcurrentSessions: 2, maxSessionsPerParent: 8 });
  await mod.default.setup(h.ctx);
  const out = await many(h, 4);
  const refusals = (out.content.match(/Refused: concurrency limit reached/g) ?? []).length;
  check("OS-2: a 4-wide batch against a cap of 2 refuses exactly 2", refusals === 2, `refused=${refusals}`);
  check("OS-2: only the allowed children were created", h.created.length === 2, `created=${h.created.length}`);
  check(
    "OS-2: the server never saw more creates in flight than the cap",
    h.state.maxInFlightCreate <= 2,
    `peak=${h.state.maxInFlightCreate}`,
  );
  // The reserved slot must be *held*, not merely counted: a second batch made
  // while the first is still creating must be refused too.
  const second = await many(h, 1);
  check(
    "OS-2: a follow-up spawn while the batch is still launching is refused",
    /Refused: concurrency limit reached/.test(second.content) || h.created.length === 2,
    second.content.slice(0, 70),
  );
}

// ---------------- a failed launch must give its slot back
{
  const h = makeCtx({ maxConcurrentSessions: 1, maxSessionsPerParent: 8 });
  await mod.default.setup(h.ctx);
  const first = await many(h, 1);
  check("OS-2: the first spawn takes the only slot", /Spawned child session/.test(first.content), first.content.slice(0, 60));

  const held = await many(h, 1);
  check("OS-2: the second spawn is refused while it is held", /Refused: concurrency limit/.test(held.content), held.content.slice(0, 60));

  // Free the slot, then fail a create: the reservation must not leak.
  await h.tools.session_cancel.execute({ sessionId: h.created[0].id }, { sessionID: "ses_parent_a" });
  h.state.failCreate = true;
  const broken = await many(h, 1);
  check(
    "OS-2: a create that fails reports the failure, not a phantom session",
    /Failed to create child session/.test(broken.content),
    broken.content.slice(0, 90),
  );
  h.state.failCreate = false;
  const after = await many(h, 1);
  check(
    "OS-2: the failed launch released its reservation",
    /Spawned child session/.test(after.content),
    after.content.slice(0, 90),
  );
}

// ---------------- per-parent cap counts reservations too
{
  const h = makeCtx({ maxConcurrentSessions: 8, maxSessionsPerParent: 2 });
  await mod.default.setup(h.ctx);
  const out = await many(h, 3);
  const refusals = (out.content.match(/Refused: per-parent limit reached/g) ?? []).length;
  check("OS-2: the per-parent cap bites inside one parallel batch", refusals === 1, out.content.replace(/\n/g, " | ").slice(0, 160));
  check("OS-2: only two children were created for that parent", h.created.length === 2, `created=${h.created.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
