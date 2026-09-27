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
import path from "node:path";
import {
  asBool,
  clampInt,
  deriveTitle,
  extractEditPaths,
  formatUnsupported,
  isFileMutatingTool,
  normalizeClaimPath,
  parseJsonFromText,
  parseModelString,
  schemaInstruction,
  taskTokens,
  tasksOverlap,
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

// --- concurrent-edit helpers -------------------------------------------

test("isFileMutatingTool recognises write tools and ignores read-only ones", () => {
  for (const t of ["edit", "write", "patch", "multiedit", "apply_patch"]) {
    assert.ok(isFileMutatingTool(t), `${t} should write`);
  }
  // Namespaced and MCP spellings must be caught too.
  for (const t of ["fs.write_file", "mcp__fs__edit_file", "str_replace_editor"]) {
    assert.ok(isFileMutatingTool(t), `${t} should write`);
  }
  for (const t of ["read", "grep", "glob", "list", "webfetch", "session_send", "bash"]) {
    assert.ok(!isFileMutatingTool(t), `${t} should not write`);
  }
  // "rewrite" ends in "write" but is not a file tool: the verb must be
  // segment-delimited, not a bare substring.
  assert.ok(!isFileMutatingTool("some_rewrite_tool"));
});

test("extractEditPaths finds plain path fields and diff headers", () => {
  assert.deepEqual(extractEditPaths({ filePath: "/p/src/a.ts" }), ["/p/src/a.ts"]);
  assert.deepEqual(extractEditPaths({ file: "a.ts", content: "x" }), ["a.ts"]);
  // Nested, as a multi-edit tool would send it.
  assert.deepEqual(extractEditPaths({ edits: [{ path: "a.ts" }, { path: "b.ts" }] }), [
    "a.ts",
    "b.ts",
  ]);
  // A unified diff names its file in a header, not in a field.
  const diff = "--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-x\n+y\n";
  assert.ok(extractEditPaths({ patch: diff }).includes("src/c.ts"));
  const apply = "*** Begin Patch\n*** Update File: src/d.ts\n@@\n-a\n+b\n";
  assert.ok(extractEditPaths({ patch: apply }).includes("src/d.ts"));
  // Nothing to find, and nothing to choke on.
  assert.deepEqual(extractEditPaths({ oldString: "a", newString: "b" }), []);
  assert.deepEqual(extractEditPaths(null), []);
  assert.deepEqual(extractEditPaths("a string"), []);
  // Deduplicated, and a long junk payload cannot blow up the walk.
  assert.deepEqual(extractEditPaths({ path: "a", filePath: "a" }), ["a"]);
  const deep = { a: { b: { c: { d: { e: { f: { path: "deep.ts" } } } } } } };
  assert.deepEqual(extractEditPaths(deep), [], "must not scan past the depth limit");
});

test("normalizeClaimPath makes relative and absolute paths collide", () => {
  const dir = path.resolve("/proj");
  const abs = normalizeClaimPath(path.join(dir, "src/a.ts"), dir);
  assert.equal(abs, "src/a.ts");
  // The same file named three ways must produce one key, or the collision is
  // missed on the common case.
  assert.equal(normalizeClaimPath("./src/a.ts", dir), abs);
  assert.equal(normalizeClaimPath("src/./a.ts", dir), abs);
  assert.equal(normalizeClaimPath("src/a.ts", dir), abs);
  // Quoting survives, as a shell-ish tool may send it.
  assert.equal(normalizeClaimPath('"src/a.ts"', dir), abs);
  // Rejects nothing useful, ignores junk.
  assert.equal(normalizeClaimPath("   ", dir), undefined);
  assert.equal(normalizeClaimPath("x".repeat(5000), dir), undefined);
  // A file outside the project still gets a stable key rather than being
  // dropped, so two agents writing the same shared file still collide.
  const outside = normalizeClaimPath("/etc/hosts", dir);
  assert.ok(outside && outside.length > 0, "outside path still keyed");
});

test("taskTokens drops generic verbs so a shared verb is not shared work", () => {
  const t = taskTokens("updating the auth module");
  assert.ok(t.has("auth") && t.has("module"));
  assert.ok(!t.has("updating"), "'updating' is generic and must be dropped");
  assert.ok(!t.has("the"));
  // Two-character noise is not a content word.
  assert.ok(!taskTokens("do a js fix").has("js"));
  assert.deepEqual([...taskTokens(undefined)], []);
});

test("tasksOverlap only fires on a genuine content-word overlap", () => {
  const mine = taskTokens("refactoring the auth module");
  assert.ok(tasksOverlap("auth module cleanup", mine), "shares 'auth'");
  // Same verbs, different subject: must not count as related.
  assert.ok(!tasksOverlap("updating the install docs", taskTokens("refactoring the auth module")));
  assert.ok(!tasksOverlap(undefined, mine));
});
