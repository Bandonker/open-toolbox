/**
 * Regression test: the peer-awareness injection must not re-arm every turn.
 *
 * Each peer row ends in a relative age ("47s ago") that ticks every second, so a
 * raw `text === wanted` comparison never matched. Every turn therefore stripped
 * and re-pushed the system message; the model read that as news and replied
 * "acknowledged"; that reply was itself a turn, which re-triggered the same
 * check in every other session. Two sessions could keep each other awake
 * indefinitely without either one doing any work.
 *
 * This drives the real plugin's context hook with two sessions and asserts the
 * injection settles instead of oscillating.
 *
 * Note the 5s waits: the plugin caches the rendered notice for
 * PEER_NOTICE_TTL_MS. Inside that window the text is byte-identical and the
 * defect is invisible. The roster only stops matching once the cache expires and
 * the notice is rebuilt around a newer "Ns ago" — so every turn here deliberately
 * crosses that boundary.
 */
const mod = await import(new URL("../opencode-sessions/opencode-sessions.ts", import.meta.url));

const TTL_MS = 5_300; // just past PEER_NOTICE_TTL_MS
const crossCache = () => new Promise((r) => setTimeout(r, TTL_MS));

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const directory = process.cwd();
const tools = {};
const hooks = {};

const ctx = {
  options: { peerAwareness: true },
  location: { directory },
  // Peers live in-process; an empty scan keeps the test hermetic and stops a
  // second opencode process leaking presence into it.
  storage: {
    get: async () => undefined,
    set: async () => undefined,
    remove: async () => undefined,
    scan: async () => ({ entries: [] }),
  },
  event: { subscribe: () => (async function* () {})() },
  tool: {
    hook: async () => ({ dispose: async () => {} }),
    transform: async (cb) => {
      cb({ add: (t) => void (tools[t.name] = t) });
      return { dispose: async () => {} };
    },
  },
  session: {
    hook: async (name, cb) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
    get: async ({ sessionID }) => ({ id: sessionID, title: "t", parentID: "p" }),
    context: async () => [],
    interrupt: async () => {},
  },
};

await mod.default.setup(ctx);

const onContext = hooks.context;
check("peer-awareness context hook registered", typeof onContext === "function");
if (typeof onContext !== "function") {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

const sysText = (m) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("")
      : "";
const notices = (messages) =>
  messages.filter((m) => sysText(m).includes("[opencode-sessions:peers]"));
const turn = (sessionID, messages) => onContext({ sessionID, messages });

// A live peer in the same project. Without someone to be briefed about the
// notice is undefined and there is nothing to test — the loop needs a roster.
await turn("ses_peer_bbbbbbbbbbbbbb", [{ role: "system", content: [{ type: "text", text: "b" }] }]);

// --- turn 1: the roster is new, so a notice must be injected
const msgs = [{ role: "user", content: [{ type: "text", text: "work" }] }];
await turn("ses_self_aaaaaaaaaaaaaaa", msgs);
const first = notices(msgs);
check("a peer-bearing session gets a notice injected", first.length === 1, first[0] ? sysText(first[0]).split("\n")[1] : "none");
const firstText = first[0] ? sysText(first[0]) : "";
check("the notice names the peer", /ses_peer/.test(firstText), firstText.split("\n")[2] ?? "");

// --- turn 2, past the cache: same roster, so the notice must survive untouched.
// This is the assertion that matters. A re-injection produces a *new* message
// object carrying a newer "Ns ago"; leaving it alone is what stops the loop.
await crossCache();
await turn("ses_self_aaaaaaaaaaaaaaa", msgs);
const second = notices(msgs);
check("an unchanged roster does not double the notice", second.length === 1, `count=${second.length}`);
check(
  "an unchanged roster is left in place, not re-injected",
  second[0] === first[0] && sysText(second[0]) === firstText,
  second[0] === first[0] ? "retained" : "REPLACED",
);

// --- and it must stay quiet indefinitely, which is what actually breaks the loop
let reInjected = 0;
for (let i = 0; i < 3; i++) {
  await crossCache();
  await turn("ses_self_aaaaaaaaaaaaaaa", msgs);
  if (notices(msgs).length !== 1 || notices(msgs)[0] !== first[0]) reInjected++;
}
check(
  "the injection stays at exactly one, unchanged message over many turns",
  reInjected === 0 && notices(msgs).length === 1,
  `reInjected=${reInjected} count=${notices(msgs).length}`,
);

// --- a genuine change must still reach the model: the fix must not mute the brief
const other = [{ role: "user", content: [{ type: "text", text: "work" }] }];
await turn("ses_peer_ccccccc", other);
await turn("ses_self_dddddddddddddd", other);
const cText = sysText(notices(other)[0] ?? {});
check("a new peer does produce a notice", /ses_peer_/.test(cText), cText.split("\n")[2] ?? "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
