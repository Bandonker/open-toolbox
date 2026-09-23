import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const db = new DatabaseSync(join(homedir(), ".local/share/opencode/opencode.db"), { readOnly: true });

const sid = process.argv[2] || "ses_f380f0816ffeSGjtynvynLXnnw";
const rows = db.prepare(`select id, seq, type, data from session_message where session_id = ? order by seq`).all(sid);
console.log("session:", sid, "messages:", rows.length);
console.log("message types:", JSON.stringify(rows.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {})));

// Recursively hunt for the shape that kills SessionModelRequest.prepare:
// any object with result.type === "content" whose value is not an array,
// and any completed tool item whose state.content is not an array.
const findings = [];
function walk(node, path) {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
  if (!node || typeof node !== "object") return;
  if (node.type === "tool-result" && node.result?.type === "content" && !Array.isArray(node.result.value))
    findings.push(["BAD-TOOL-RESULT", path, JSON.stringify(node.result).slice(0, 200)]);
  if (node.type === "tool" && node.state?.status === "completed" && !Array.isArray(node.state.content))
    findings.push(["BAD-TOOL-STATE", path, JSON.stringify(node.state).slice(0, 200)]);
  if (node.result && typeof node.result === "object" && node.result.type === "content" && !Array.isArray(node.result.value))
    findings.push(["BAD-RESULT", path, JSON.stringify(node.result).slice(0, 200)]);
  for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
}
for (const r of rows) {
  let d;
  try { d = JSON.parse(r.data); } catch { findings.push(["UNPARSEABLE", `seq=${r.seq}`, ""]); continue; }
  walk(d, `seq=${r.seq}(${r.type})`);
}
console.log("findings:", findings.length);
for (const f of findings.slice(0, 20)) console.log(...f);

// Also dump one tool item verbatim to confirm the normal shape.
for (const r of rows) {
  const d = JSON.parse(r.data);
  const t = (d.content || []).find?.((c) => c.type === "tool");
  if (t) { console.log("sample tool item keys:", Object.keys(t).join(","), "| state keys:", Object.keys(t.state || {}).join(",")); break; }
}
