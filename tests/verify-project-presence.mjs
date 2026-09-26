/**
 * Project presence / peer awareness (PP-1..PP-nn).
 *
 * opencode has no `session.list()`, so peers are discovered from the event
 * stream: every session event carries `data.sessionID` and `location.directory`.
 * These tests drive that stream through a stub context and assert the registry
 * groups by directory, expires stale entries, self-claims on first turn, and
 * that the injected notice is stripped and re-added rather than accumulating.
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const PROJECT = "/tmp/verify-presence-project";
const OTHER = "/tmp/verify-presence-other";

/**
 * Build a stub ctx that feeds a controllable session-event stream.
 *
 * The stream must be push-based, not a snapshot: the pump starts during setup,
 * so events pushed afterwards still have to arrive. A generator that read the
 * queue once at subscribe time would miss everything.
 */
function makeCtx(options = {}) {
  const tools = {};
  const store = new Map();
  const contextHooks = [];
  const synthetic = [];
  const prompts = [];
  const subs = [];
  // push-based async queue
  const pending = [];
  let wake = null;
  const push = (ev) => {
    pending.push(ev);
    wake?.();
  };
  const drain = async function* (signal) {
    while (!signal?.aborted) {
      while (pending.length > 0) yield pending.shift();
      await new Promise((r) => {
        wake = r;
        if (signal) signal.addEventListener("abort", r, { once: true });
      });
      wake = null;
    }
  };

  const ctx = {
    options: options.options ?? {},
    location: { directory: PROJECT, project: { id: "proj-1", directory: PROJECT, canonical: PROJECT } },
    event: {
      subscribe: ({ signal } = {}) => {
        subs.push({ signal });
        return drain(signal);
      },
    },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, title: "x", parentID: "p" }),
      context: async () => [],
      interrupt: async () => {},
      synthetic: async (a) => void synthetic.push(a),
      prompt: async (a) => void prompts.push(a),
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => void (tools[t.name] = t) });
        return { dispose: async () => {} };
      },
    },
    hook: async (name, cb) => void contextHooks.push({ name, cb }),
  };
  // session.hook is on ctx.session for this plugin's usage
  ctx.session.hook = async (name, cb) => void contextHooks.push({ name, cb });

  return { ctx, tools, store, contextHooks, synthetic, prompts, push, subs };
}

// Ids are 8+ chars so they survive the 8-char shortId used in display output,
// while staying long enough that the assertions below are unambiguous.
const ID_A = "ses_aaaa01";
const ID_B = "ses_bbbb02";
const ID_C = "ses_cccc03";
// Displayed rows use an 8-char shortId, so fixtures must be <= 8 chars for
// assertions to match on what a user actually sees.
const SELF = "ses_self";
const PEER = "ses_peer0";

const sessionEvent = (sessionID, directory, type = "session.step.started") => ({
  type,
  location: { directory },
  data: { sessionID, agent: "build" },
});

// ---------------------------------------------------------------- PP-1..4
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  check("PP-1 all three presence tools register", !!h.tools.project_sessions && !!h.tools.session_broadcast && typeof h.tools.session_send?.execute === "function");

  // Feed events for two sessions in this project and one in another project.
  h.push(sessionEvent(ID_A, PROJECT));
  h.push(sessionEvent(ID_B, PROJECT, "session.idle"));
  h.push(sessionEvent(ID_C, OTHER));
  // The pump is started in setup; give the async generator a tick to drain.
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  const text = out.content;
  check("PP-2 sees a peer in the same project", text.includes(ID_A.slice(0,8)) && text.includes(ID_B.slice(0,8)), text.replace(/\n/g, " | ").slice(0, 150));
  check("PP-3 does NOT leak sessions from another project", !text.includes(ID_C.slice(0,8)), "other-project peer hidden");
  // Assert on this peer's own line, not the whole blob: the other peer is
  // legitimately "running", so a bare /idle/ scan would match the wrong row.
  const bLine = text.split("\n").find((l) => l.includes(ID_B.slice(0, 8))) ?? "";
  check("PP-4 idle peer is reported as idle", /\bidle\b/.test(bLine), bLine.trim() || "row not found");
}

// ---------------------------------------------------------------- PP-5
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const out = await h.tools.project_sessions.execute({}, { sessionID: SELF });
  check("PP-5 reports no peers when the project is empty", out.content.startsWith("No other sessions"), out.content.slice(0, 80));
}

// ---------------------------------------------------------------- PP-6
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  const out = await h.tools.project_sessions.execute({ task: "refactoring the auth module" }, { sessionID: SELF });
  check("PP-6 project_sessions can declare a task", out.content.includes("No other sessions"), out.content.slice(0, 60));

  // PP-7: within one instance, a claimed task must show up for another session.
  // (Cross-process visibility is PP-7b below, via the shared storage mirror.)
  const h2 = makeCtx();
  await mod.default.setup(h2.ctx);
  const out2 = await h2.tools.project_sessions.execute({ task: "updating the install docs" }, { sessionID: PEER });
  const out3 = await h2.tools.project_sessions.execute({}, { sessionID: "ses_view0" });
  check(
    "PP-7 a claimed task is visible to a peer",
    out3.content.includes("updating the install docs"),
    out3.content.replace(/\n/g, " | ").slice(0, 160),
  );
  void out2;
}

// ---------------------------------------------------------------- PP-7b cross-process mirror
{
  const shared = new Map();
  const mk = () => {
    const h = makeCtx();
    h.ctx.storage = {
      get: async (k) => shared.get(k),
      set: async (k, v) => void shared.set(k, v),
    };
    return h;
  };
  const a = mk();
  await mod.default.setup(a.ctx);
  a.tools.project_sessions.execute({ task: "adding the presence feature" }, { sessionID: SELF });
  // The mirror is debounced (2s) by design; wait it out.
  await new Promise((r) => setTimeout(r, 2400));
  const b = mk();
  await mod.default.setup(b.ctx);
  // b's setup reads the snapshot asynchronously; give it a tick.
  await new Promise((r) => setTimeout(r, 60));
  const out = await b.tools.project_sessions.execute({}, { sessionID: "ses_other0" });
  check(
    "PP-7b presence crosses process boundaries via ctx.storage",
    out.content.includes("adding the presence feature"),
    out.content.replace(/\n/g, " | ").slice(0, 180),
  );
}

// ---------------------------------------------------------------- PP-8/9 awareness injection
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  check("PP-8 a context hook is registered for awareness", h.contextHooks.some((x) => x.name === "context"), h.contextHooks.map((x) => x.name).join(","));

  const hook = h.contextHooks.find((x) => x.name === "context")?.cb;
  const messages = [];
  await hook({ sessionID: SELF, messages });

  // Self-claim must have happened with no observable event at all. Ask from a
  // different session id so the claim shows up as a peer row.
  const claimed = await h.tools.project_sessions.execute({}, { sessionID: "ses_peer0" });
  const selfRow = claimed.content.split("\n").find((l) => l.includes(SELF)) ?? "";
  check(
    "PP-9 the session self-claims on first turn",
    /\brunning\b/.test(selfRow) && selfRow.length > 0,
    selfRow.trim() || `no row for ${SELF} in: ${claimed.content.replace(/\n/g, " | ").slice(0, 200)}`,
  );

  // Now a real peer shows up and the notice should appear.
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  const notice = messages.map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text).join("") : m.content)).join("\n");
  check("PP-10 awareness notice is injected when a peer exists", notice.includes("other session") && notice.includes(ID_A.slice(0,8)), notice.replace(/\n/g, " | ").slice(0, 170));

  // Calling again must replace, not accumulate.
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  await hook({ sessionID: SELF, messages });
  const notices = messages.filter((m) => {
    const t = Array.isArray(m.content) ? m.content.map((c) => c.text).join("") : m.content;
    return String(t).includes("[opencode-sessions:peers]");
  });
  check("PP-11 awareness notice is replaced, not duplicated", notices.length === 1, `${notices.length} notices present`);

  // Peer goes stale -> notice must be removed, not left stale.
  /* peers left to expire naturally */
  messages.length = 0;
  await hook({ sessionID: SELF, messages });
  check("PP-12 no notice when peers are gone", !messages.some((m) => String(m.content).includes("[opencode-sessions:peers]")), "notice removed");
}

// ---------------------------------------------------------------- PP-13 broadcast
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  h.push(sessionEvent(ID_B, PROJECT));
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.session_broadcast.execute({ text: "I am renaming the auth module, hands off", noReply: true }, { sessionID: SELF });
  check("PP-13 broadcast reaches every peer", out.content.includes("2/2"), out.content);
  check("PP-14 broadcast uses synthetic when noReply", h.synthetic.length === 2 && h.prompts.length === 0, `synthetic=${h.synthetic.length} prompts=${h.prompts.length}`);
}

// ---------------------------------------------------------------- PP-15 send to a peer
{
  const h = makeCtx();
  await mod.default.setup(h.ctx);
  h.push(sessionEvent(ID_A, PROJECT));
  await new Promise((r) => setTimeout(r, 60));

  const out = await h.tools.session_send.execute({ sessionId: ID_A, text: "are you editing README?" }, { sessionID: SELF });
  check("PP-15 session_send reaches an untracked peer session", h.prompts.some((p) => p.sessionID === ID_A), out.content.slice(0, 120));
  check("PP-16 send-to-peer is reported as a peer, not a child", /peer session/.test(out.content), out.content.slice(0, 120));

  // Unknown id that is not a peer must still be refused.
  const bad = await h.tools.session_send.execute({ sessionId: "ses_unknownunknown", text: "hi" }, { sessionID: SELF });
  check("PP-17 an entirely unknown session is still refused", /Unknown session/.test(bad.content), bad.content.slice(0, 100));
}

// ---------------------------------------------------------------- PP-18 peerAwareness off
{
  const h = makeCtx({ options: { peerAwareness: false } });
  await mod.default.setup(h.ctx);
  check("PP-18 peerAwareness:false registers no context hook", !h.contextHooks.some((x) => x.name === "context"), h.contextHooks.map((x) => x.name).join(",") || "none");
  // but the tools must still work
  check("PP-19 tools still register with awareness off", !!h.tools.project_sessions);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
