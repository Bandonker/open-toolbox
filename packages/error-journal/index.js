import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { openDatabase, applyPragmas, maybeBackupDb, latestValidBackup, checkOpenDb, isCorruption, parseStringArray, quoteFtsQuery, dbUnavailable, clampLimit, copyBackupIntoPlace, hasTriggers, truncateStored, vacuum, rebuildFts, buildTagFilter, STORE_CAPS, } from "./lib/sqlite.js";
import { redactSecrets } from "./lib/redact.js";
import { formatAge, projectHash } from "./lib/format.js";
import { asBool } from "./lib/config.js";
import { createHash } from "node:crypto";
const DB_DIR = join(homedir(), ".opencode-plugins", "error-journal");
const DB_PATH = join(DB_DIR, "error-journal.db");
const BACKUP_DIR = join(DB_DIR, "backups");
const MAX_BACKUPS = 5;
// E167/EJ-2: autoProject is resolved per setup() from ctx.options (env
// fallback) and the project tag is the session's location directory hashed like
// memory.ts does — see setup(). The old module-level `let autoProject = true`
// plus process.cwd() labelled every row with the server's cwd and could never
// be changed, so error_config reported a fiction.
/** P5: redact obvious secrets before they hit the pack's own store (opt-out via env). */
function storeRedactOn() {
    return process.env.OPENCODE_PLUGINS_STORE_REDACT !== "false";
}
function scrubStore(text) {
    return storeRedactOn() ? redactSecrets(text) : text;
}
/** EJ-3: dedupe fingerprint inputs must be normalized the same way on the
 * write path and on the migration backfill, so both agree. */
function normalizeErrorText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}
/** EJ-3: SHA-1, matching memory.ts. The old 32-bit djb2 folded distinct texts
 * into one bucket (and collided *silently*), bumping `count` on an unrelated
 * error while a duplicate of the real one was inserted next to it. */
function hashText(text) {
    return createHash("sha1").update(text).digest("hex");
}
let db = null;
let lastBackupTime = 0;
function getDb() {
    if (!db) {
        // DL-2: mkdir inside try so a creation failure routes to backup-restore
        // instead of escaping as an unhandled throw.
        try {
            if (!existsSync(DB_DIR)) {
                mkdirSync(DB_DIR, { recursive: true });
            }
            db = openDatabase(DB_PATH);
            applyPragmas(db);
            initSchema(db);
        }
        catch (e) {
            try {
                db = tryRestore();
            }
            catch {
                db = null;
            }
            if (!db)
                throw e;
        }
    }
    return db;
}
function initSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_text TEXT NOT NULL,
      context TEXT,
      resolution TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      assignee TEXT,
      related INTEGER,
      stack_trace TEXT,
      code TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      hash TEXT NOT NULL DEFAULT ''
    )
  `);
    // Migration: add hash column to existing databases created before E168.
    const columns = database.query("PRAGMA table_info(errors)").all();
    if (!columns.some((c) => c.name === "hash")) {
        database.exec("ALTER TABLE errors ADD COLUMN hash TEXT NOT NULL DEFAULT ''");
    }
    // EJ-3: backfill the fingerprint for rows written before the switch to SHA-1
    // (empty defaults from the column migration, and legacy 32-bit djb2 values
    // that are not 40 hex chars). Without this every pre-existing row keeps a
    // hash the write path can never produce, so re-logging a known error inserted
    // a second row instead of bumping `count`. One stray duplicate per error may
    // survive — the fingerprint itself is now correct for all rows.
    const staleHashes = database
        .query("SELECT id, error_text FROM errors WHERE hash IS NULL OR hash = '' OR length(hash) <> 40")
        .all();
    if (staleHashes.length > 0) {
        const setHash = database.prepare("UPDATE errors SET hash = ? WHERE id = ?");
        for (const row of staleHashes) {
            setHash.run(hashText(normalizeErrorText(row.error_text ?? "")), row.id);
        }
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_errors_hash ON errors(hash, project)");
    const row = database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='errors_fts'")
        .get();
    const createdFts = !row;
    if (createdFts) {
        database.exec(`
      CREATE VIRTUAL TABLE errors_fts USING fts5(
        error_text,
        context,
        resolution,
        tags,
        content=errors,
        content_rowid=id,
        tokenize='porter'
      )
    `);
    }
    // E1: triggers are ensured on every open, not only when the FTS table was
    // just created — a dropped/desynced trigger must not silently stop making
    // new errors searchable.
    // CR-9: verify all three triggers (ai/ad/au), not just the insert one.
    const hadTriggers = hasTriggers(database, ["errors_ai", "errors_ad", "errors_au"]);
    database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      VALUES (new.id, new.error_text, COALESCE(new.context, ''), COALESCE(new.resolution, ''), new.tags);
    END
  `);
    database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_ad AFTER DELETE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, error_text, context, resolution, tags)
      VALUES ('delete', old.id, old.error_text, COALESCE(old.context, ''), COALESCE(old.resolution, ''), old.tags);
    END
  `);
    database.exec(`
    CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, error_text, context, resolution, tags)
      VALUES ('delete', old.id, old.error_text, COALESCE(old.context, ''), COALESCE(old.resolution, ''), old.tags);
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      VALUES (new.id, new.error_text, COALESCE(new.context, ''), COALESCE(new.resolution, ''), new.tags);
    END
  `);
    if (createdFts) {
        // Backfill any existing rows into the freshly created (empty) index.
        database.exec(`
      INSERT INTO errors_fts(rowid, error_text, context, resolution, tags)
      SELECT id, error_text, COALESCE(context, ''), COALESCE(resolution, ''), tags FROM errors
    `);
    }
    else if (!hadTriggers) {
        // The index existed but the sync triggers were missing: rebuild it so
        // past and future rows are consistent again.
        database.exec(`INSERT INTO errors_fts(errors_fts) VALUES('rebuild')`);
    }
}
function backup() {
    maybeBackupDb({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        maxBackups: MAX_BACKUPS,
        lastBackupTime: () => lastBackupTime,
        setLastBackupTime: (t) => { lastBackupTime = t; },
    });
}
function tryRestore() {
    const latest = latestValidBackup(BACKUP_DIR);
    if (!latest)
        return null;
    // E2: close the failing handle first (an open handle blocks the copy on
    // Windows) and drop stale -wal/-shm so they cannot be replayed on top of
    // the restored snapshot.
    if (db) {
        try {
            db.close();
        }
        catch { /* ignore */ }
        db = null;
    }
    // CR-8: I/O wrapped with context (copyBackupIntoPlace); it also drops
    // -wal/-shm/-journal so they cannot be replayed on the restored snapshot.
    try {
        copyBackupIntoPlace(DB_PATH, latest);
    }
    catch {
        return null;
    }
    let restored;
    try {
        restored = openDatabase(DB_PATH);
        applyPragmas(restored);
        initSchema(restored);
    }
    catch {
        return null;
    }
    // J1: verify the restored copy on its own handle — the pre-copy backup
    // check cannot catch a copy that lands corrupt. Never serve it silently.
    try {
        if (!checkOpenDb(restored)) {
            try {
                restored.close();
            }
            catch { /* ignore */ }
            return null;
        }
    }
    catch {
        try {
            restored.close();
        }
        catch { /* ignore */ }
        return null;
    }
    return restored;
}
function withRetry(fn, isWrite = false) {
    try {
        const result = fn();
        if (isWrite) {
            try {
                backup();
            }
            catch { }
        }
        return result;
    }
    catch (err) {
        if (isCorruption(err)) {
            try {
                db?.close();
            }
            catch { /* ignore */ }
            db = null;
            try {
                db = tryRestore();
            }
            catch {
                db = null;
            }
            if (db) {
                // CR-3: the retried call can fail too — route it to dbUnavailable
                // instead of throwing out of the tool.
                try {
                    const result = fn();
                    if (isWrite) {
                        try {
                            backup();
                        }
                        catch { }
                    }
                    return result;
                }
                catch (retryErr) {
                    return dbUnavailable(retryErr);
                }
            }
            // CR-3/J1: the store is corrupt and no valid backup could be restored.
            // Surface the underlying failure through the canonical dbUnavailable
            // message ("Storage unavailable: …") instead of a bare string, so the
            // cause reaches the caller and the restore path stays consistent.
            return dbUnavailable(err);
        }
        // CR-3: never throw storage failures out of tools — every caller uses
        // the result as tool `content`, so surface a readable message instead.
        return dbUnavailable(err);
    }
}
function formatError(row) {
    const tags = parseStringArray(row.tags);
    let out = `**#${row.id}** — ${row.created_at} (${formatAge(row.created_at)})`;
    if (row.resolved_at)
        out += ` (resolved ${row.resolved_at})`;
    out += "\n";
    if (row.project)
        out += `Project: ${row.project}\n`;
    if (tags.length > 0)
        out += `Tags: ${tags.join(", ")}\n`;
    // E171: show count when > 1.
    if (row.count > 1)
        out += `Occurrences: ${row.count}\n`;
    out += `\n\`\`\`\n${row.error_text}\n\`\`\`\n`;
    if (row.context)
        out += `\nContext: ${row.context}\n`;
    if (row.resolution)
        out += `\nResolution: ${row.resolution}\n`;
    return out;
}
export default Plugin.define({
    id: "error-journal",
    async setup(ctx) {
        // E167/EJ-2: real configuration for the project tag. Options win, then the
        // environment, then the default; the tag is the *session's* location
        // directory hashed exactly like memory.ts tags rows, so a server serving
        // several projects no longer labels every row with the same process cwd.
        const autoProject = asBool(ctx.options?.autoProject ?? process.env.OPENCODE_ERROR_JOURNAL_AUTO_PROJECT, true);
        const autoScope = autoProject
            ? projectHash(ctx.location?.directory ?? process.cwd())
            : null;
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "error_log",
                // EJ-5: document that the journal is manual-only (opt-in logging).
                description: "Log a new error to the journal. Record the error message/stack, what was happening, and optional tags/project for categorization. Manual-only: errors are recorded only when this tool is called explicitly; nothing is captured automatically.",
                input: z.object({
                    error_text: z.string().min(1).describe("The error message or stack trace"),
                    context: z.string().optional().describe("What was happening when the error occurred (file, command, action)"),
                    tags: z.array(z.string()).optional().describe("Tags for categorization (e.g. ['typescript', 'build'])"),
                    project: z.string().optional().describe("Project path or name"),
                    // E180: severity field.
                    severity: z.string().optional().describe("Severity/priority (default: medium)"),
                    // E181: assignee field.
                    assignee: z.string().optional().describe("Person or component assigned to this error"),
                    // E182: related field.
                    related: z.number().optional().describe("ID of a related error"),
                    // E183: stack trace.
                    stackTrace: z.string().optional().describe("Stack trace (stored separately from error_text)"),
                    // E184: code field.
                    code: z.string().optional().describe("Structured error code"),
                }),
                execute: async (input) => {
                    try {
                        const out = withRetry(() => {
                            const database = getDb();
                            const tagsJson = JSON.stringify(input.tags ?? []);
                            // E167/EJ-2: caller-provided project wins; otherwise tag with the
                            // hashed session location directory (autoScope), never the cwd.
                            const project = input.project || autoScope;
                            // E168/E169/EJ-3: deduplicate similar errors — fingerprint the
                            // *stored* form (scrubbed + capped) with SHA-1 so the write path
                            // and the migration backfill hash the same bytes.
                            const storedText = truncateStored(scrubStore(input.error_text), STORE_CAPS.errorField);
                            const hash = hashText(normalizeErrorText(storedText));
                            const existing = database
                                .prepare("SELECT id, count FROM errors WHERE hash = ? AND project IS ? LIMIT 1")
                                .get(hash, project);
                            if (existing) {
                                database
                                    .prepare("UPDATE errors SET count = count + 1, last_seen_at = datetime('now') WHERE id = ?")
                                    .run(existing.id);
                                return `Error #${existing.id} already logged (occurrence ${existing.count + 1})`;
                            }
                            const stmt = database.prepare("INSERT INTO errors (error_text, context, tags, project, severity, assignee, related, stack_trace, code, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                            const result = stmt.run(
                            // CR-4: cap unbounded inputs into DB/FTS (20k each).
                            storedText, input.context ? truncateStored(scrubStore(input.context), STORE_CAPS.errorField) : null, tagsJson, project, input.severity || "medium", input.assignee || null, input.related || null, input.stackTrace ? truncateStored(scrubStore(input.stackTrace), STORE_CAPS.errorField) : null, input.code || null, hash);
                            return `Logged error #${result.lastInsertRowid}`;
                        }, true);
                        return { content: out };
                    }
                    catch (err) {
                        return { content: dbUnavailable(err) };
                    }
                },
            });
            editor.add({
                name: "error_resolve",
                description: "Add a resolution to a logged error. Records how the error was fixed for future reference.",
                input: z.object({
                    id: z.number().describe("Error ID to resolve"),
                    resolution: z.string().min(1).describe("How the error was fixed"),
                    append: z.boolean().optional().describe("Append to existing resolution instead of replacing"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = withRetry(() => {
                        const database = getDb();
                        const row = database
                            .query("SELECT id, resolution FROM errors WHERE id = ?")
                            .get(args.id);
                        if (!row)
                            return `Error #${args.id} not found`;
                        // EJ-6: surface a prior resolution instead of silently overwriting.
                        // Cap the echo at 500 chars so a huge stored resolution cannot
                        // blow up tool output.
                        const prior = row.resolution ? ` (prior resolution: "${truncateStored(row.resolution, 500)}")` : "";
                        // E166: append mode concatenates with existing resolution.
                        const newResolution = args.append && row.resolution
                            ? row.resolution + "\n" + args.resolution
                            : args.resolution;
                        database
                            .prepare("UPDATE errors SET resolution = ?, resolved_at = datetime('now') WHERE id = ?")
                            // CR-4: cap unbounded inputs into DB/FTS (20k).
                            .run(truncateStored(scrubStore(newResolution), STORE_CAPS.errorField), args.id);
                        return `Resolved error #${args.id}${prior}`;
                    }, true);
                    return { content: out };
                },
            });
            editor.add({
                name: "error_search",
                description: "Search the error journal using full-text search. Matches against error text, context, resolution, and tags. Use this when a similar error appears to find past resolutions.",
                input: z.object({
                    query: z.string().describe("Search query"),
                    tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
                    limit: z.number().optional().describe("Max results (default: 10)"),
                    // E161: project filter.
                    project: z.string().optional().describe("Filter by project"),
                    // E162: resolved filter.
                    resolved: z.boolean().optional().describe("Filter: true = resolved only, false = unresolved only"),
                    // E163: date range filter.
                    createdAfter: z.string().optional().describe("Only errors created on/after this ISO date."),
                    createdBefore: z.string().optional().describe("Only errors created on/before this ISO date."),
                    // E173: sort option.
                    sort: z.enum(["relevance", "created"]).optional().describe("Sort order (default: relevance)"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = withRetry(() => {
                        const database = getDb();
                        const q = quoteFtsQuery(args.query);
                        if (!q)
                            return "No errors found. (empty query)";
                        // Shared clampLimit: trunc + finite guard.
                        const limit = clampLimit(args.limit ?? 10, 10, 50);
                        let sql = `SELECT e.* FROM errors e
                 JOIN errors_fts f ON f.rowid = e.id
                 WHERE errors_fts MATCH ?`;
                        const params = [q];
                        // E160: tag filter parity with error_list.
                        const tagFilter = buildTagFilter(args.tags ?? [], "e.tags");
                        if (tagFilter.clause) {
                            sql += tagFilter.clause;
                            params.push(...tagFilter.params);
                        }
                        // E161: project filter.
                        if (args.project) {
                            sql += " AND e.project = ?";
                            params.push(args.project);
                        }
                        // E162: resolved filter.
                        if (args.resolved === true) {
                            sql += " AND e.resolved_at IS NOT NULL";
                        }
                        else if (args.resolved === false) {
                            sql += " AND e.resolved_at IS NULL";
                        }
                        // E163: date range filter.
                        if (args.createdAfter) {
                            sql += " AND e.created_at >= ?";
                            params.push(args.createdAfter);
                        }
                        if (args.createdBefore) {
                            sql += " AND e.created_at <= ?";
                            params.push(args.createdBefore);
                        }
                        // E173: sort option.
                        if (args.sort === "created") {
                            sql += " ORDER BY e.created_at DESC, e.id DESC";
                        }
                        else {
                            // E174: weighted bm25 — error_text 2x, tags 0.5x.
                            sql += " ORDER BY bm25(errors_fts, 2.0, 1.0, 1.0, 0.5)";
                        }
                        sql += " LIMIT ?";
                        params.push(limit);
                        const rows = database.prepare(sql).all(...params);
                        if (rows.length === 0)
                            return "No matching errors found.";
                        return rows.map(formatError).join("\n---\n\n");
                    });
                    return { content: out };
                },
            });
            editor.add({
                name: "error_list",
                description: "List recent errors, optionally filtered by project, tags, or resolved status.",
                input: z.object({
                    project: z.string().optional().describe("Filter by project path/name"),
                    tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
                    resolved: z.boolean().optional().describe("Filter: true = resolved only, false = unresolved only, omit = all"),
                    sort: z.enum(["created", "resolved", "project"]).optional().describe("Sort order (default: created)"),
                    limit: z.number().optional().describe("Max results (default: 20)"),
                    // E165: FTS query filter.
                    query: z.string().optional().describe("Full-text search query"),
                    // E172: unresolved shorthand.
                    unresolved: z.boolean().optional().describe("Shorthand for resolved: false"),
                }),
                execute: async (input) => {
                    const out = withRetry(() => {
                        const database = getDb();
                        const conditions = [];
                        const params = [];
                        if (input.project) {
                            conditions.push("project = ?");
                            params.push(input.project);
                        }
                        // E172: unresolved shorthand.
                        const resolvedFilter = input.unresolved === true ? false : input.resolved;
                        if (resolvedFilter === true) {
                            conditions.push("resolution IS NOT NULL");
                        }
                        else if (resolvedFilter === false) {
                            conditions.push("resolution IS NULL");
                        }
                        // E3: exact tag match against the JSON array — substring LIKE
                        // produced false positives (e.g. "api" matching "api-v2").
                        const tagFilter = buildTagFilter(input.tags ?? [], "errors.tags");
                        if (tagFilter.clause) {
                            conditions.push(tagFilter.clause.replace(/^ AND /, ""));
                            params.push(...tagFilter.params);
                        }
                        // E165: FTS query filter.
                        if (input.query) {
                            const q = quoteFtsQuery(input.query);
                            if (q) {
                                conditions.push("id IN (SELECT rowid FROM errors_fts WHERE errors_fts MATCH ?)");
                                params.push(q);
                            }
                        }
                        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
                        // Shared clampLimit: trunc + finite guard.
                        const limit = clampLimit(input.limit ?? 20, 20, 100);
                        // E164: sort option.
                        const orderBy = input.sort === "resolved"
                            ? "resolved_at DESC"
                            : input.sort === "project"
                                ? "project ASC, created_at DESC"
                                : "created_at DESC";
                        const rows = database
                            .query(`SELECT * FROM errors ${where} ORDER BY ${orderBy} LIMIT ?`)
                            .all(...params, limit);
                        if (rows.length === 0)
                            return "No errors found.";
                        return rows.map(formatError).join("\n---\n\n");
                    });
                    return { content: out };
                },
            });
            editor.add({
                name: "error_delete",
                description: "Delete error entries by ID, or bulk delete by query, tag, or project. Only rows of this project can be deleted; pass all: true to widen past that scope.",
                input: z.object({
                    id: z.number().optional().describe("Error ID to delete (exact)"),
                    query: z.string().optional().describe("Delete errors matching this search query"),
                    tag: z.string().optional().describe("Delete errors with this tag"),
                    project: z.string().optional().describe("Delete errors from this project"),
                    confirm: z.boolean().optional().describe("Confirm deletion (required for non-id deletes)"),
                    // E178: dryRun flag.
                    dryRun: z.boolean().optional().describe("If true, only show what would be deleted"),
                    // EJ-1: explicit widening flag, mirroring memory_forget's `all`.
                    all: z.boolean().optional().describe("Widen the delete to rows outside this project (default: false)"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = withRetry(() => {
                        const database = getDb();
                        if (args.id !== undefined) {
                            // EJ-1: load the row and gate it like the reads do. The errors
                            // table has no session column, so the narrowest available scope
                            // is the project tag; previously any session that guessed an id
                            // deleted any other project's row.
                            const row = database
                                .query("SELECT id, project FROM errors WHERE id = ?")
                                .get(args.id);
                            if (!row)
                                return `Error #${args.id} not found`;
                            if (args.all !== true && autoScope !== null && row.project !== autoScope) {
                                return `Refused: error #${args.id} belongs to another project (${row.project ?? "unscoped"}). Pass all: true to delete it anyway.`;
                            }
                            // E178: dryRun for id-based delete.
                            if (args.dryRun === true) {
                                return `Dry run — would delete error #${args.id}`;
                            }
                            database.prepare("DELETE FROM errors WHERE id = ?").run(args.id);
                            return `Deleted error #${args.id}`;
                        }
                        // E156: bulk delete
                        if (!args.confirm)
                            return "Bulk deletion requires confirm: true";
                        const conditions = [];
                        const params = [];
                        // EJ-1: bulk deletes used to honor no scope at all — a `tag` filter
                        // wiped that tag's rows in *every* project sharing the journal.
                        let scopeNote = "";
                        if (args.all !== true && autoScope !== null) {
                            conditions.push("project = ?");
                            params.push(autoScope);
                            scopeNote = " (this project only; pass all: true to widen)";
                        }
                        if (args.query) {
                            const q = quoteFtsQuery(args.query);
                            if (!q)
                                return "No errors found. (empty query)";
                            conditions.push("id IN (SELECT rowid FROM errors_fts WHERE errors_fts MATCH ?)");
                            params.push(q);
                        }
                        if (args.tag) {
                            const tagFilter = buildTagFilter([args.tag], "errors.tags");
                            if (tagFilter.clause) {
                                conditions.push(tagFilter.clause.replace(/^ AND /, ""));
                                params.push(...tagFilter.params);
                            }
                        }
                        if (args.project) {
                            // EJ-1: an explicit project filter names the caller's own scope;
                            // asking for someone else's project still needs the flag rather
                            // than silently ANDing two project predicates to nothing.
                            if (args.all !== true && autoScope !== null && args.project !== autoScope) {
                                return `Refused: project "${args.project}" is not this project (${autoScope ?? "unscoped"}). Pass all: true to delete across projects.`;
                            }
                            conditions.push("project = ?");
                            params.push(args.project);
                            scopeNote = "";
                        }
                        if (conditions.length === 0)
                            return "No deletion criteria provided";
                        const where = `WHERE ${conditions.join(" AND ")}`;
                        const count = database.prepare(`SELECT COUNT(*) as count FROM errors ${where}`).get(...params).count;
                        // E178: dryRun for bulk delete.
                        if (args.dryRun === true) {
                            return `Dry run — would delete ${count} error(s)${scopeNote}`;
                        }
                        database.prepare(`DELETE FROM errors ${where}`).run(...params);
                        return `Deleted ${count} error(s)${scopeNote}`;
                    }, true);
                    return { content: out };
                },
            });
            editor.add({
                name: "error_export",
                description: "Export errors to JSON or Markdown format.",
                input: z.object({
                    format: z.enum(["json", "markdown"]).optional().describe("Export format (default: json)"),
                    resolved: z.boolean().optional().describe("Filter by resolution status"),
                    project: z.string().optional().describe("Filter by project"),
                    tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
                }),
                execute: async (input) => {
                    const args = input;
                    const out = withRetry(() => {
                        const database = getDb();
                        const conditions = [];
                        const params = [];
                        if (args.resolved === true) {
                            conditions.push("resolution IS NOT NULL");
                        }
                        else if (args.resolved === false) {
                            conditions.push("resolution IS NULL");
                        }
                        if (args.project) {
                            conditions.push("project = ?");
                            params.push(args.project);
                        }
                        const tagFilter = buildTagFilter(args.tags ?? [], "errors.tags");
                        if (tagFilter.clause) {
                            conditions.push(tagFilter.clause.replace(/^ AND /, ""));
                            params.push(...tagFilter.params);
                        }
                        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
                        const rows = database.prepare(`SELECT * FROM errors ${where} ORDER BY created_at DESC`).all(...params);
                        if (rows.length === 0)
                            return "No errors found.";
                        const format = args.format || "json";
                        if (format === "json") {
                            return JSON.stringify(rows, null, 2);
                        }
                        else {
                            const md = rows.map(row => {
                                const tags = parseStringArray(row.tags);
                                const lines = [];
                                lines.push(`## Error #${row.id}`);
                                lines.push(`- **Created:** ${row.created_at}`);
                                if (row.resolved_at)
                                    lines.push(`- **Resolved:** ${row.resolved_at}`);
                                if (row.project)
                                    lines.push(`- **Project:** ${row.project}`);
                                if (tags.length > 0)
                                    lines.push(`- **Tags:** ${tags.join(", ")}`);
                                lines.push(`\n\`\`\`\n${row.error_text}\n\`\`\``);
                                if (row.context)
                                    lines.push(`\n**Context:** ${row.context}`);
                                if (row.resolution)
                                    lines.push(`\n**Resolution:** ${row.resolution}`);
                                return lines.join("\n");
                            });
                            return md.join("\n\n---\n\n");
                        }
                    });
                    return { content: out };
                },
            });
            editor.add({
                name: "error_stats",
                description: "Get aggregate statistics about logged errors.",
                input: z.object({}),
                execute: async () => {
                    const out = withRetry(() => {
                        const database = getDb();
                        // Counts by resolution status
                        const resolvedRow = database.prepare("SELECT COUNT(*) as count FROM errors WHERE resolution IS NOT NULL").get();
                        const unresolvedRow = database.prepare("SELECT COUNT(*) as count FROM errors WHERE resolution IS NULL").get();
                        const totalRow = database.prepare("SELECT COUNT(*) as count FROM errors").get();
                        // Top tags
                        const tagRows = database.prepare(`
              SELECT value as tag, COUNT(*) as count
              FROM errors, json_each(errors.tags)
              GROUP BY value
              ORDER BY count DESC
              LIMIT 10
            `).all();
                        // Top projects
                        const projectRows = database.prepare(`
              SELECT project, COUNT(*) as count
              FROM errors
              WHERE project IS NOT NULL
              GROUP BY project
              ORDER BY count DESC
              LIMIT 10
            `).all();
                        // Errors per month
                        const monthRows = database.prepare(`
              SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
              FROM errors
              GROUP BY month
              ORDER BY month DESC
              LIMIT 12
            `).all();
                        const resolutionRate = totalRow.count > 0 ? ((resolvedRow.count / totalRow.count) * 100).toFixed(1) : "0.0";
                        const lines = [];
                        lines.push(`**Error Statistics**`);
                        lines.push(`Total errors: ${totalRow.count}`);
                        lines.push(`Resolved: ${resolvedRow.count} (${resolutionRate}%)`);
                        lines.push(`Unresolved: ${unresolvedRow.count}`);
                        lines.push("");
                        lines.push(`**Top Tags:**`);
                        for (const r of tagRows)
                            lines.push(`  ${r.tag}: ${r.count}`);
                        lines.push("");
                        lines.push(`**Top Projects:**`);
                        for (const r of projectRows)
                            lines.push(`  ${r.project}: ${r.count}`);
                        lines.push("");
                        lines.push(`**Errors per Month:**`);
                        for (const r of monthRows)
                            lines.push(`  ${r.month}: ${r.count}`);
                        return lines.join("\n");
                    });
                    return { content: out };
                },
            });
            // E175: vacuum tool.
            editor.add({
                name: "error_vacuum",
                description: "Reclaim disk space by running VACUUM.",
                input: z.object({}),
                execute: async () => {
                    const out = withRetry(() => {
                        const database = getDb();
                        vacuum(database);
                        return "Vacuumed.";
                    });
                    return { content: out };
                },
            });
            // E176: rebuild FTS tool.
            editor.add({
                name: "error_rebuild_fts",
                description: "Rebuild the FTS index.",
                input: z.object({}),
                execute: async () => {
                    const out = withRetry(() => {
                        const database = getDb();
                        rebuildFts(database, "errors_fts");
                        return "FTS index rebuilt.";
                    });
                    return { content: out };
                },
            });
            // E177: config tool.
            editor.add({
                name: "error_config",
                description: "Show the current error-journal configuration.",
                input: z.object({}),
                execute: async () => {
                    return {
                        content: [
                            `db: ${DB_PATH}`,
                            `backupDir: ${BACKUP_DIR}`,
                            `maxBackups: ${MAX_BACKUPS}`,
                            // EJ-2: report the value actually in force for this session
                            // (options/env), and the project tag rows get stamped with.
                            `autoProject: ${autoProject}`,
                            `project: ${autoScope ?? "(none — rows are unscoped)"}`,
                        ].join("\n"),
                    };
                },
            });
        });
        return () => {
            try {
                db?.close();
            }
            catch {
                /* ignore */
            }
            db = null;
        };
    },
});
