/**
 * Unit tests for the pure helpers in helpers.ts.
 *
 * These do not need a server: Node 24 strips the TS types on import, and
 * helpers.ts only defines functions at load time.
 *
 *   node --test unit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  asBool,
  clampInt,
  deriveTitle,
  formatUnsupported,
  parseJsonFromText,
  parseModelString,
  schemaInstruction,
  truncate,
} from "./helpers.ts";

test("clampInt clamps and coerces", () => {
  assert.equal(clampInt(5, 3, 1, 10), 5);
  assert.equal(clampInt(0, 3, 1, 10), 1);
  assert.equal(clampInt(99, 3, 1, 10), 10);
  assert.equal(clampInt("7", 3, 1, 10), 7);
  assert.equal(clampInt("abc", 3, 1, 10), 3);
  assert.equal(clampInt(undefined, 3, 1, 10), 3);
  assert.equal(clampInt(3.9, 3, 1, 10), 3);
});

test("asBool parses booleans and common strings", () => {
  assert.equal(asBool(true, false), true);
  assert.equal(asBool("yes", false), true);
  assert.equal(asBool("ON", false), true);
  assert.equal(asBool("1", false), true);
  assert.equal(asBool("off", true), false);
  assert.equal(asBool("nope", false), false);
  assert.equal(asBool(undefined, true), true);
});

test("deriveTitle takes the first line and caps length", () => {
  assert.equal(deriveTitle("hello world"), "hello world");
  assert.equal(deriveTitle("line one\nline two"), "line one");
  assert.equal(deriveTitle("   "), "untitled task");
  assert.equal(deriveTitle("a".repeat(80)).endsWith("..."), true);
  assert.equal(deriveTitle("a".repeat(80)).length, 60);
});

test("truncate leaves short text and marks long text", () => {
  assert.equal(truncate("short", 10), "short");
  const out = truncate("x".repeat(20), 10);
  assert.equal(out.startsWith("x".repeat(10)), true);
  assert.match(out, /truncated 10 chars/);
});

test("schemaInstruction embeds the schema and JSON wording", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } } };
  const text = schemaInstruction(schema);
  assert.match(text, /JSON Schema/);
  assert.match(text, /no markdown code fences/);
  assert.equal(text.includes(JSON.stringify(schema)), true);
});

test("parseJsonFromText extracts plain, fenced, and embedded JSON", () => {
  assert.deepEqual(parseJsonFromText('{"answer":"PONG"}'), { answer: "PONG" });
  assert.deepEqual(parseJsonFromText("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseJsonFromText("Sure! {\"a\":1} done"), { a: 1 });
  assert.deepEqual(parseJsonFromText("[1,2]"), [1, 2]);
  assert.equal(parseJsonFromText("no json here"), undefined);
});

test("formatUnsupported matches structured-output failures only", () => {
  assert.equal(
    formatUnsupported("Error from provider: Thinking mode does not support this tool_choice"),
    true,
  );
  assert.equal(formatUnsupported("StructuredOutputError: no structured_output present"), true);
  assert.equal(formatUnsupported("json_schema not allowed"), true);
  assert.equal(formatUnsupported("some unrelated network error"), false);
  assert.equal(formatUnsupported(undefined), false);
});

test("parseModelString splits provider/model and rejects malformed input", () => {
  assert.deepEqual(parseModelString("opencode-go/deepseek-v4.1-flash"), {
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
  });
  assert.deepEqual(parseModelString("a/b/c"), { providerID: "a", modelID: "b/c" });
  assert.ok("error" in parseModelString("noslash"));
  assert.ok("error" in parseModelString("/x"));
  assert.ok("error" in parseModelString("x/"));
});
