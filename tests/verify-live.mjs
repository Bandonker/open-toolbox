#!/usr/bin/env node
/**
 * Live end-to-end checks for the context-pruner plugin.
 *
 * Deliberately NOT part of `npm test`: it needs the running opencode server and
 * a live provider (LM Studio). Run it by hand:
 *
 *   node tests/verify-live.mjs all
 *   node tests/verify-live.mjs compaction title soak concurrency recall failopen prose
 *   node tests/verify-live.mjs overflow        # opt-in, reloads the LM Studio model
 *
 * Env:
 *   OPENCODE_LIVE_URL       default http://127.0.0.1:49374
 *   OPENCODE_LIVE_PASSWORD  else read from ~/.config/opencode/service.json
 *   LIVE_PROVIDER           default lmstudio
 *   LIVE_MODEL              default qwen/qwen3.5-9b
 *   LIVE_DIRECTORY          default the repo root
 *   LMS                     path to the lms CLI (overflow scenario)
 *
 * Exits 0 with SKIP when the server is unreachable. Never prints the password.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const base = (process.env.OPENCODE_LIVE_URL ?? "http://127.0.0.1:49374").replace(/\/$/, "");
const providerID = process.env.LIVE_PROVIDER ?? "lmstudio";
const modelID = process.env.LIVE_MODEL ?? "qwen/qwen3.5-9b";
const directory = process.env.LIVE_DIRECTORY ?? repo;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  live/${name}${detail ? `  - ${detail}` : ""}`);
}
function note(text) {
  console.log(`NOTE  ${text}`);
}

function password() {
  if (process.env.OPENCODE_LIVE_PASSWORD) return process.env.OPENCODE_LIVE_PASSWORD;
  const file = join(homedir(), ".config", "opencode", "service.json");
  return JSON.parse(readFileSync(file, "utf8")).password;
}

const auth = "Basic " + Buffer.from(`opencode:${password()}`).toString("base64");

async function api(method, path, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function reachable() {
  try {
    const res = await api("GET", "/api/session", undefined, 5000);
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function newSession() {
  const res = await api("POST", "/api/session", {
    model: { providerID, id: modelID },
    location: { directory },
  });
  const sid = res.json?.data?.id;
  if (!sid) throw new Error(`session create failed: ${res.status}`);
  return sid;
}

/** Providers briefly drop the connection while LM Studio reloads a model. */
async function newSessionRetry(attempts = 8) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await newSession();
    } catch (err) {
      last = err;
      note(`session create retry ${i + 1}: ${String(err).slice(0, 80)}`);
      await sleep(3000);
    }
  }
  throw last;
}

async function send(sid, text) {
  return api("POST", `/api/session/${sid}/prompt`, { text });
}

function contextOf(json) {
  return Array.isArray(json?.data) ? json.data : [];
}

function parts(ctx) {
  const out = [];
  for (const message of ctx) {
    for (const part of message.content ?? []) out.push({ message, part });
  }
  return out;
}

function resultText(part) {
  const result = part.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (typeof result.value === "string") return result.value;
    return JSON.stringify(result.value ?? result);
  }
  if (typeof part.text === "string") return part.text;
  return "";
}

function toolOutput(part) {
  const blocks = part.state?.content;
  if (Array.isArray(blocks)) return blocks.map((b) => b?.text ?? "").join("\n");
  return resultText(part);
}

function stubs(ctx) {
  return parts(ctx)
    .filter(({ part }) => part.type === "tool" || part.result != null)
    .map(({ part, message }) => ({
      id: part.id ?? part.toolCallId ?? message.id,
      name: part.name ?? part.tool ?? "",
      resultType: part.state?.status ?? (part.result && typeof part.result === "object" ? part.result.type : typeof part.result),
      text: toolOutput(part),
    }));
}

async function context(sid) {
  const res = await api("GET", `/api/session/${sid}/context`);
  return contextOf(res.json);
}

/** Wait until the transcript stops growing and at least one assistant turn finished. */
async function waitIdle(sid, timeoutMs = 150000) {
  const end = Date.now() + timeoutMs;
  let lastSig = "";
  let stable = 0;
  let ctx = [];
  while (Date.now() < end) {
    await sleep(1500);
    ctx = await context(sid);
    const last = ctx[ctx.length - 1];
    const sig = `${ctx.length}:${last?.time?.completed ?? 0}:${last?.time?.updated ?? 0}`;
    const hasAssistant = ctx.some((m) => m.type === "assistant" && m.time?.completed);
    if (sig === lastSig && hasAssistant) {
      stable += 1;
      if (stable >= 2) return ctx;
    } else {
      stable = 0;
      lastSig = sig;
    }
  }
  return ctx;
}

function assistantText(ctx) {
  return ctx
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? ""))
    .join("\n")
    .trim();
}

async function sessionsList() {
  const res = await api("GET", "/api/session");
  return Array.isArray(res.json?.data) ? res.json.data : [];
}

// ---------------------------------------------------------------------------
// scenarios

async function scenarioCompaction() {
  const sid = await newSession();
  await send(sid, "Use the read tool to read the file README.md, then reply with one short line.");
  const before = await waitIdle(sid);
  const reads = stubs(before).filter((s) => s.name === "read").length;
  const started = await api("POST", `/api/session/${sid}/compact`, {});
  const mid = started.json?.data?.id;
  check("compaction request is accepted", started.status === 200 && Boolean(mid), `status=${started.status} mid=${mid ?? "n/a"}`);

  let msg;
  const end = Date.now() + 90000;
  while (mid && Date.now() < end) {
    await sleep(2000);
    const res = await api("GET", `/api/session/${sid}/message/${mid}`);
    msg = res.json?.data;
    if (msg?.status === "completed" || msg?.status === "error") break;
  }
  const blob = JSON.stringify(msg ?? {});
  check("compaction message completes", msg?.status === "completed", `status=${msg?.status ?? "timeout"} reads=${reads}`);
  check(
    "compaction checkpoint summary is written",
    blob.includes("# Context checkpoint") && blob.includes("## Goal") && blob.includes("## Files touched"),
    blob.slice(0, 90).replace(/\s+/g, " "),
  );
}

async function scenarioTitle() {
  const probe = "TITLESHORTCIRCUIT-PROBE-AlphaBravoCharlieDeltaEchoFoxtrotGolfHotelIndiaJuliet";
  const sid = await newSession();
  await send(sid, `${probe} reply with the single word ACK.`);
  await waitIdle(sid);
  const list = await sessionsList();
  const title = list.find((s) => s.id === sid)?.title ?? "";
  const short = title.startsWith("TITLESHORTCIRCUIT-PROBE") && title.length <= 60;
  check("title short-circuit derives the title locally", short, `title="${title}" (len ${title.length})`);
}

async function scenarioSoak() {
  const sid = await newSession();
  const seen = new Map();
  let stable = true;
  let turnsDone = 0;
  for (let turn = 0; turn < 3; turn++) {
    await send(sid, "Read the file docs/CONTEXT-COMPILER-PLAN.md and reply with the single word DONE.");
    const ctx = await waitIdle(sid);
    if (ctx.some((m) => m.type === "assistant" && m.time?.completed)) turnsDone += 1;
    for (const s of stubs(ctx)) {
      if (!s.text) continue;
      const prior = seen.get(s.id);
      if (prior !== undefined && prior !== s.text) stable = false;
      seen.set(s.id, s.text);
    }
  }
  const list = await sessionsList();
  const tokens = list.find((s) => s.id === sid)?.tokens ?? {};
  const cacheRead = tokens.cache?.read ?? 0;
  check("soak run completes three turns", turnsDone === 3, `turns=${turnsDone} toolOutputs=${seen.size}`);
  // The plugin edits only the outgoing request (invariant #1), so the stored
  // transcript must be byte-identical for the same tool output across turns.
  check("the stored transcript is never mutated", stable, `distinct=${seen.size}`);
  note(`soak session ${sid}: cache.read=${cacheRead} (provider cache accounting; LM Studio may report 0)`);
}

async function scenarioConcurrency() {
  const sids = await Promise.all([newSession(), newSession(), newSession()]);
  await Promise.all(sids.map((sid, i) => send(sid, `Reply with the single word ACK${i}.`)));
  const ctxs = await Promise.all(sids.map((sid) => waitIdle(sid, 180000)));
  const ok = ctxs.every((ctx) => assistantText(ctx).length > 0);
  check("three concurrent sessions all complete", ok, ctxs.map((ctx) => assistantText(ctx).slice(0, 12)).join(" | "));
  const alive = await reachable();
  check("server survives concurrent sessions", alive);
}

async function scenarioRecall() {
  const sid = await newSession();
  await send(sid, "Read the file README.md and reply with the single word DONE.");
  const ctx = await waitIdle(sid);
  const read = stubs(ctx).find((s) => s.name === "read" && s.text);
  check("a live read tool result is present to prune", Boolean(read), read ? `chars=${read.text.length}` : "no tool output captured");
  note("the recall cache lives in memory/the outgoing request only; exercise it with tests/verify-plugins.mjs — the stored transcript is never mutated by design");
}

async function scenarioFailOpen() {
  const sid = await newSession();
  const huge = "x".repeat(60000);
  const res = await send(sid, huge);
  check("oversized prompt is accepted", res.status >= 200 && res.status < 300, `status=${res.status}`);
  const alive = await reachable();
  check("server stays up after an oversized prompt", alive);
}

async function scenarioProse() {
  const consumer = "PROSE-COMPRESSION-PROBE: the cache layer owns the region map; a stale region is dropped when its source output changes, and the ledger keeps the calibration ratio.";
  const sid = await newSession();
  // Varied turns so the model writes several distinct prose blocks that are
  // worth summarising later.
  const prompts = [
    "Explain in three sentences how a prompt-cache invalidation works and why a plugin should avoid rewriting the prefix. Keep it prose, no bullets.",
    "Explain in three sentences what a token ledger calibration ratio is and how it is derived from provider usage. Keep it prose, no bullets.",
    "Explain in three sentences why a summary of tool output must keep file paths, symbols and error text. Keep it prose, no bullets.",
  ];
  for (const text of prompts) {
    await send(sid, text);
    await waitIdle(sid);
  }

  const before = await context(sid);
  const beforeText = assistantText(before).length;
  const beforeJson = JSON.stringify(before).length;
  check("live session has assistant prose worth compressing", beforeText > 500, `prose chars=${beforeText}`);

  await send(sid, `Remember this verbatim for the rest of our conversation, then reply with the single word ACK: ${consumer}`);
  await waitIdle(sid);

  // Ask the model to try the whole-message compression path. Whether it chooses
  // to call compress depends on the model, so the outcome is reported, not
  // asserted as a pass/fail of the plugin.
  const mapRes = await api("POST", `/api/session/${sid}/prompt`, {
    text: "Call the context_map tool and reply with the single word DONE. Do not use any other tool.",
  });
  check("context_map prompt is accepted", mapRes.status >= 200 && mapRes.status < 300, `status=${mapRes.status}`);

  const after = await context(sid);
  const proseParts = parts(after).filter(({ part }) => part.type === "text" && typeof part.text === "string");
  const summarized = proseParts.filter(({ part }) => part.text.startsWith("[context prose summary]"));
  const stored = JSON.stringify(after);
  const markers = [
    "[context-pruner] output of",
    "[context-pruner] folded into summary",
    "[context prose summary]",
    "[context summary]",
  ];
  note(
    `prose scenario ${sid}: proseChars=${beforeText} beforeJson=${beforeJson} afterJson=${stored.length} proseParts=${proseParts.length} summarized=${summarized.length}` +
      ` markersSeen=${markers.filter((m) => stored.includes(m)).length}`,
  );
  note(
    summarized.length > 0
      ? "the live model compressed prose through the plugin's compress tool"
      : "the live model did not call compress this run; the mechanism is covered by tests/verify-plugins.mjs",
  );
  check("the prose scenario runs without breaking the session", awaited(sid, after), `messages=${after.length}`);
}

function awaited(sid, ctx) {
  return ctx.length > 0 && ctx.some((m) => m.type === "assistant");
}

async function scenarioOverflow() {
  const lms = process.env.LMS;
  if (!lms || process.env.LIVE_OVERFLOW !== "1") {
    note("overflow scenario skipped: set LMS and LIVE_OVERFLOW=1 (it reloads the LM Studio model)");
    return;
  }
  const { execFileSync } = await import("node:child_process");
  const run = (args) => {
    try {
      const out = execFileSync(lms, args, { encoding: "utf8", timeout: 120000 });
      return out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    } catch (err) {
      return `error: ${String(err).replace(/\s+/g, " ").slice(0, 160)}`;
    }
  };
  note(`lms unload --all -> ${run(["unload", "--all"])}`);
  note(`lms load ${modelID} -c 2048 -y -> ${run(["load", modelID, "-c", "2048", "-y"])}`);
  try {
    const sid = await newSessionRetry();
    await send(sid, "Use the read tool to read the file plugins/context-pruner.ts, then reply DONE.");
    const ctx = await waitIdle(sid, 240000);
    const blob = JSON.stringify(ctx);
    const overflowSeen = /exceeds the available context|context size|context[_ ](length|window|limit)|maximum context|prompt is too long|too many tokens/i.test(blob);
    const completed = ctx.some((m) => m.type === "assistant" && m.time?.completed && assistantText([m]).length > 0);
    const detail = blob.match(/exceeds the available context size[^"\\]{0,40}/)?.[0] ?? `overflowSeen=${overflowSeen}`;
    check("a real provider context-limit error is observed", overflowSeen, detail.slice(0, 120));
    check("the session reaches a terminal state after the overflow", overflowSeen || completed, `completed=${completed}`);
    note(`overflow session ${sid}: overflowSeen=${overflowSeen} completed=${completed}`);
  } finally {
    note(`lms unload --all -> ${run(["unload", "--all"])}`);
    note(`lms load ${modelID} -y -> ${run(["load", modelID, "-y"])}`);
  }
}

// ---------------------------------------------------------------------------

const all = ["compaction", "title", "soak", "concurrency", "recall", "failopen", "prose"];
const requested = process.argv.slice(2);
const names = requested.length === 0 || requested.includes("all") ? all.slice() : requested;

if (!(await reachable())) {
  console.log("SKIP  opencode live server is not reachable at " + base);
  process.exit(0);
}

const runners = {
  compaction: scenarioCompaction,
  title: scenarioTitle,
  soak: scenarioSoak,
  concurrency: scenarioConcurrency,
  recall: scenarioRecall,
  failopen: scenarioFailOpen,
  prose: scenarioProse,
  overflow: scenarioOverflow,
};

for (const name of names) {
  const runner = runners[name];
  if (!runner) {
    console.log(`SKIP  unknown scenario "${name}"`);
    continue;
  }
  console.log(`--- ${name}`);
  try {
    await runner();
  } catch (err) {
    check(`${name} scenario ran without throwing`, false, String(err).slice(0, 160));
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(failed === 0 ? 0 : 1);
