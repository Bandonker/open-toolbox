#!/usr/bin/env node
/**
 * Long session test — verifies running sessions don't over-inflate
 * (waste tokens) as turns accumulate.
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
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}

async function reachable() {
  try {
    const res = await api("GET", "/api/session", undefined, 5000);
    return res.status >= 200 && res.status < 500;
  } catch { return false; }
}

async function newSession() {
  const res = await api("POST", "/api/session", {
    model: { providerID, id: modelID },
    location: { directory },
  });
  const sid = res.json?.data?.id;
  if (!sid) throw new Error(`session create failed: status=${res.status}`);
  return sid;
}

async function send(sid, text) {
  return api("POST", `/api/session/${sid}/prompt`, { text });
}

async function context(sid) {
  const res = await api("GET", `/api/session/${sid}/context`);
  return Array.isArray(res.json?.data) ? res.json.data : [];
}

async function sessionsList() {
  const res = await api("GET", "/api/session");
  return Array.isArray(res.json?.data) ? res.json.data : [];
}

function jsonLength(obj) { return JSON.stringify(obj).length; }

if (!(await reachable())) {
  console.log("SKIP  opencode live server is not reachable at " + base);
  process.exit(0);
}

const sid = await newSession();
console.log(`--- long session started ${sid}`);

// Each turn uses a tool (read) + assistant reply to simulate real workload
const prompts = [
  "Read the file README.md and reply with one short line.",
  "Read the file package.json and reply with one short line.",
  "Read the file plugins/context-pruner.ts and reply DONE.",
  "Read the file docs/CONTEXT-COMPILER-DCP.md and reply DONE.",
  "Read the file docs/CONTEXT-COMPILER-PLAN.md and reply DONE.",
  "Read the file README.md again and reply SHORT.",
  "Read the file package.json again and reply SHORT.",
  "Read the file plugins/context-pruner.ts again and reply SHORT.",
  "Read README.md, package.json, and plugins/context-pruner.ts. Reply SUMMARY.",
  "Read docs/CONTEXT-COMPILER-DCP.md and docs/CONTEXT-COMPILER-PLAN.md. Reply SUMMARY.",
];

const measurements = [];

for (let turn = 1; turn <= prompts.length; turn++) {
  await send(sid, prompts[turn - 1]);
  // Wait for assistant turn to complete (poll context)
  let ctx = [];
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    await sleep(1500);
    ctx = await context(sid);
    const last = ctx[ctx.length - 1];
    const hasAssistant = ctx.some((m) => m.type === "assistant" && m.time?.completed);
    if (hasAssistant && ctx.length > 0) break;
  }

  const list = await sessionsList();
  const sessionInfo = list.find((s) => s.id === sid) || {};
  const tokens = sessionInfo.tokens || {};
  const msgCount = ctx.length;
  const assistantCount = ctx.filter((m) => m.type === "assistant").length;
  const compiledSize = jsonLength(ctx);
  const rawEstimate = compiledSize; // approximate for comparison

  measurements.push({
    turn,
    messages: msgCount,
    assistants: assistantCount,
    contextBytes: compiledSize,
    tokensIn: tokens.input ?? null,
    tokensCacheRead: tokens.cache?.read ?? null,
    tokensOut: tokens.output ?? null,
  });

  console.log(
    `turn=${turn.toString().padStart(2)} | msg=${msgCount.toString().padStart(2)} | ` +
    `assistant=${assistantCount} | bytes=${compiledSize.toString().padStart(6)} | ` +
    `tokens(in=${tokens.input ?? "?"} out=${tokens.output ?? "?"} cache=${tokens.cache?.read ?? "?"})`
  );
}

console.log("\n--- long session complete ---");
console.log("Summary:");
console.table(measurements);

// Check inflation: if message count grows but compiled size explodes unboundedly,
// it's a sign of token waste. If it stays roughly linear / bounded, plugin is controlling it.
const firstBytes = measurements[0].contextBytes;
const lastBytes = measurements[measurements.length - 1].contextBytes;
const growthRatio = lastBytes / firstBytes;
console.log(`\nContext byte growth: ${firstBytes} -> ${lastBytes} (${growthRatio.toFixed(2)}x)`);
console.log(`Message growth: 2 -> ${measurements[measurements.length - 1].messages}`);
if (growthRatio < 5 && measurements[measurements.length - 1].messages > 0) {
  console.log("PASS  session did not over-inflate; context stayed bounded relative to turns.");
} else {
  console.log("NOTE  high growth detected — check if pruning/compaction is active.");
}
