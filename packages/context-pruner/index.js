import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const VERSION = 1;
const STUB_MARK = "[context-pruner] output of ";
const SUMMARY_MARK = "[context summary]";
const PROSE_SUMMARY_MARK = "[context prose summary]";
const POINTER_MARK = "[context-pruner] folded into summary";
// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
// E39: message catalog for multi-language support
const MESSAGES = {
    en: {
        summaryApplied: "Summary applied",
        compressionQualityLow: "Compression quality low",
        sessionStateExported: "Session state exported",
        sessionStateImported: "Session state imported",
        sessionStateImportFailed: "Failed to import session state",
        compressionStats: "Compression stats",
        recallStats: "Recall stats",
        budgetStats: "Budget stats",
        turn: "Turn",
        budgetRatio: "Budget ratio",
        tokens: "Tokens",
        saved: "Saved",
        total: "Total",
        session: "Session",
        epoch: "Epoch",
        decisions: "Decisions",
        summaries: "Summaries",
        savedTokens: "Saved tokens",
        inputTokens: "Input tokens",
        ratio: "Ratio",
        activePruneDecisions: "Active prune decisions",
        activeSummaries: "active summaries",
        cacheEconomics: "Cache economics",
        cacheSavings: "cache savings",
        calibrationRatio: "Calibration ratio",
        charactersSaved: "Characters saved",
        checkpoints: "Checkpoints",
        collapsed: "collapsed",
        comparisonTitle: "Context pruner comparison",
        compressedFiles: "Compressed files",
        compressDisabled: "Compression is disabled",
        compressEmpty: "Nothing compressible in this context",
        compressFocus: "Focus",
        compressModelUnavailable: "Compression model unavailable",
        compressNoContext: "No context to compress",
        compressRequiresSession: "compress needs a sessionID: it can only compress the session that called it.",
        compressLiveTurnIncluded: "Includes output from the turn in progress (you asked for this range by name)",
        compressKeptNewest: "Range truncated to the newest 40 targets",
        compressNoTargets: "No compressible targets in range",
        compressProtected: "Protected",
        compressResult: "Compressed",
        compressSaved: "saved",
        compressionCost: "Compression cost",
        configFile: "Config file",
        contextMapCallCompress: "Call compress to fold these into a summary.",
        contextMapMore: "…and",
        contextMapTitle: "Context map",
        estimatedCostSaved: "estimated cost saved",
        estimatedTokensSaved: "Estimated tokens saved",
        hooks: "Hooks",
        lowQualityCompressions: "Low quality compressions",
        mode: "Mode",
        modelRef: "Model",
        netSavings: "Net savings",
        noCompressibleContext: "No compressible context",
        noRequestCompiled: "No request compiled yet",
        noSessionsSpecified: "No sessions specified",
        nudgeConsider: "Consider compressing soon.",
        nudgeContextAt: "Context at",
        nudgeCritical: "Context is critical — compress now.",
        nudgeUseCompress: "Use the compress tool to free context.",
        nudgesSent: "Nudges sent",
        of: "of",
        ofPruningTotal: "Stubbed (of pruning total)",
        pruning: "Pruning",
        promptTokens: "Prompt tokens",
        protectedMarker: "protected",
        pruned: "pruned",
        reportTitle: "Context pruner report",
        requestsCompiled: "Requests compiled",
        retryState: "Retry state",
        rerunTool: "Rerun the tool to see full output",
        savingsByTopic: "savings by topic",
        sessionNotFound: "session not found",
        sessionTotal: "session total",
        spanCollapse: "Span collapse",
        statsTitle: "Context pruner stats",
        stubbed: "stubbed",
        stubbedBelowFloor: "Stubbed below floor",
        summarised: "summarised",
        summariesGenerated: "Summaries generated",
        summaryUnavailable: "Summary unavailable",
        toolResultsPruned: "Tool results pruned",
        topic: "topic",
        trackedSessions: "Tracked sessions",
        undoEmpty: "Nothing to undo",
        undoRequiresSession: "undo requires a sessionID",
        undoSuccess: "Compression undone",
        window: "window",
    },
    zh: {
        summaryApplied: "摘要已应用",
        compressionQualityLow: "压缩质量低",
        sessionStateExported: "会话状态已导出",
        sessionStateImported: "会话状态已导入",
        sessionStateImportFailed: "导入会话状态失败",
        compressionStats: "压缩统计",
        recallStats: "召回统计",
        budgetStats: "预算统计",
        turn: "轮次",
        budgetRatio: "预算比率",
        tokens: "令牌",
        saved: "已保存",
        total: "总计",
        session: "会话",
        epoch: "纪元",
        decisions: "决策",
        summaries: "摘要",
        savedTokens: "已保存令牌",
        inputTokens: "输入令牌",
        ratio: "比率",
    },
    ja: {
        summaryApplied: "要約が適用されました",
        compressionQualityLow: "圧縮品質が低い",
        sessionStateExported: "セッション状態がエクスポートされました",
        sessionStateImported: "セッション状態がインポートされました",
        sessionStateImportFailed: "セッション状態のインポートに失敗しました",
        compressionStats: "圧縮統計",
        recallStats: "リコール統計",
        budgetStats: "予算統計",
        turn: "ターン",
        budgetRatio: "予算比率",
        tokens: "トークン",
        saved: "保存済み",
        total: "合計",
        session: "セッション",
        epoch: "エポック",
        decisions: "決定",
        summaries: "要約",
        savedTokens: "保存済みトークン",
        inputTokens: "入力トークン",
        ratio: "比率",
    },
};
function t(key, locale) {
    const catalog = MESSAGES[locale] ?? MESSAGES.en;
    return catalog[key] ?? MESSAGES.en[key] ?? key;
}
function num(value, fallback = 0) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function asBool(value, fallback) {
    if (value === undefined || value === null || value === "")
        return fallback;
    if (typeof value === "boolean")
        return value;
    const text = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text))
        return true;
    if (["0", "false", "no", "off"].includes(text))
        return false;
    return fallback;
}
function asInt(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(Math.max(Math.floor(n), min), max);
}
function asList(value) {
    if (Array.isArray(value))
        return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value === "string") {
        return value
            .split(/[,\n]/)
            .map((v) => v.trim())
            .filter(Boolean);
    }
    return [];
}
function getPath(obj, path) {
    let cur = obj;
    for (const key of path.split(".")) {
        if (!cur || typeof cur !== "object")
            return undefined;
        cur = cur[key];
    }
    return cur;
}
function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== "")
            return value;
    }
    return undefined;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
    }
    return out;
}
/** Parse JSONC (comments + trailing commas) without pulling a dependency. */
function parseJsonc(text) {
    if (text.charCodeAt(0) === 0xfeff)
        text = text.slice(1);
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    out = out.replace(/,(\s*[}\]])/g, "$1");
    try {
        const parsed = JSON.parse(out);
        return isPlainObject(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function readConfigFile(path) {
    try {
        if (!existsSync(path))
            return undefined;
        return parseJsonc(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
/**
 * Global opencode config directories, most-specific first.
 *
 * opencode honors XDG_CONFIG_HOME on Linux/BSD (default ~/.config) and uses
 * ~/Library/Application Support on macOS. Windows has no XDG equivalent, so it
 * stays on ~/.config. We previously hardcoded ~/.config/opencode, which
 * silently missed the config for anyone who relocated XDG_CONFIG_HOME.
 *
 * The legacy ~/.config path is kept as a fallback rather than replaced, so an
 * existing install never loses its settings. Paths are de-duplicated because on
 * a default Linux box the XDG entry resolves back to the same directory.
 */
function globalConfigDirs() {
    const home = homedir();
    const dirs = [];
    if (process.platform === "darwin") {
        dirs.push(join(home, "Library", "Application Support", "opencode"));
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.trim())
        dirs.push(join(xdg, "opencode"));
    dirs.push(join(home, ".config", "opencode"));
    return [...new Set(dirs)];
}
/**
 * CP-16: the debug logger used to write under a hardcoded `~/.config` path and
 * never cleaned anything, so a machine with `debug: true` once accumulated one
 * dated file per day forever. Pruning runs once per directory per process (the
 * logger calls it after every append) and removes dated log files the
 * filesystem says are older than a week.
 */
const DEBUG_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const prunedDebugDirs = new Set();
function pruneDebugLogs(dir) {
    if (prunedDebugDirs.has(dir))
        return;
    prunedDebugDirs.add(dir);
    try {
        const now = Date.now();
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".log"))
                continue;
            const full = join(dir, name);
            try {
                if (now - statSync(full).mtimeMs > DEBUG_LOG_MAX_AGE_MS)
                    unlinkSync(full);
            }
            catch {
                /* a file we cannot stat or unlink is not worth an exception */
            }
        }
    }
    catch {
        /* ignore */
    }
}
/** Collect config from (in order): global file, project file, legacy dcp file. */
function configCandidatePaths(directory) {
    const candidates = [];
    const explicit = process.env.OPENCODE_CONTEXT_PRUNER_CONFIG;
    if (explicit)
        candidates.push(explicit);
    const globalDirs = globalConfigDirs();
    for (const dir of globalDirs) {
        candidates.push(join(dir, "context-pruner.jsonc"));
    }
    if (directory) {
        candidates.push(join(directory, ".opencode", "context-pruner.jsonc"));
    }
    for (const dir of globalDirs) {
        candidates.push(join(dir, "dcp.jsonc"));
    }
    if (directory) {
        candidates.push(join(directory, ".opencode", "dcp.jsonc"));
    }
    return candidates;
}
function loadConfigFiles(directory) {
    let config = {};
    let path;
    for (const candidate of configCandidatePaths(directory)) {
        const loaded = readConfigFile(candidate);
        if (!loaded)
            continue;
        config = deepMerge(config, loaded);
        path = candidate;
    }
    return { config, path };
}
function parseLimit(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value === "number")
        return Number.isFinite(value) && value > 0 ? { abs: value } : undefined;
    const text = String(value).trim();
    const pct = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pct) {
        const n = Number(pct[1]);
        return n > 0 ? { pct: Math.min(n, 100) } : undefined;
    }
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? { abs: n } : undefined;
}
function limitTokens(limit, window) {
    if (!limit)
        return undefined;
    if (limit.abs !== undefined)
        return limit.abs;
    if (limit.pct !== undefined) {
        // C13: callers pass a possibly-unknown window — 0/NaN would turn a
        // percentage limit into 0 tokens (or NaN).
        if (!Number.isFinite(window) || window <= 0)
            return undefined;
        return Math.floor(window * (limit.pct / 100));
    }
    return undefined;
}
function globToRegExp(glob) {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`);
}
function compilePatterns(list) {
    const out = [];
    for (const pattern of list) {
        try {
            const re = new RegExp(pattern);
            const flags = re.flags.replace(/[gy]/g, "");
            out.push(flags !== re.flags ? new RegExp(re.source, flags) : re);
        }
        catch {
            /* ignore malformed patterns */
        }
    }
    return out;
}
function compileGlobs(list) {
    return list.map((glob) => globToRegExp(glob));
}
const DEFAULT_PROTECTED = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
    "context_report",
    "context_map",
    "context_pruner_recall",
];
function resolveConfig(directory, options) {
    const o = options ?? {};
    const { config: file, path } = loadConfigFiles(directory);
    const pick = (key, envKey, dcpPath) => {
        const fromOption = o[key];
        if (fromOption !== undefined && fromOption !== null && fromOption !== "")
            return fromOption;
        const fromEnv = process.env[envKey];
        if (fromEnv !== undefined && fromEnv !== "")
            return fromEnv;
        const fromDcp = dcpPath ? getPath(file, dcpPath) : undefined;
        const fromFlat = file[key];
        return firstDefined(fromDcp, fromFlat);
    };
    const protectedTools = new Set([
        ...DEFAULT_PROTECTED,
        ...asList(getPath(file, "protectedTools")),
        ...asList(pick("protectedTools", "OPENCODE_CONTEXT_PRUNER_PROTECTED_TOOLS")),
    ]);
    const protectedPatterns = compilePatterns(asList(pick("protectedPatterns", "OPENCODE_CONTEXT_PRUNER_PROTECTED_PATTERNS")));
    const protectedInputPatterns = compilePatterns(asList(pick("protectedInputPatterns", "OPENCODE_CONTEXT_PRUNER_PROTECTED_INPUT_PATTERNS")));
    const protectedFilePatterns = compileGlobs(asList(firstDefined(getPath(file, "protectedFilePatterns"), pick("protectedFilePatterns", "OPENCODE_CONTEXT_PRUNER_PROTECTED_FILES"))));
    const charsPerToken = num(pick("charsPerToken", "OPENCODE_CONTEXT_PRUNER_CHARS_PER_TOKEN"), 3.6);
    const keepHeadChars = asInt(pick("keepHeadChars", "OPENCODE_CONTEXT_PRUNER_KEEP_HEAD"), 200, 0, 100000);
    const keepRecent = asInt(pick("keepRecent", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT"), 6, 0, 10000);
    // Prose (assistant/user text) is only eligible when compressText is on; the
    // most recent N prose parts stay untouched so the live reasoning is kept.
    const keepRecentText = asInt(pick("keepRecentText", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TEXT"), 2, 0, 10000);
    const minChars = asInt(pick("minChars", "OPENCODE_CONTEXT_PRUNER_MIN_CHARS"), 2000, 0, 10_000_000);
    // Over-budget pruning is allowed below the voluntary floor so small stale
    // outputs still shed when the window is tight (DCP prunes at any size).
    const budgetMinChars = asInt(pick("budgetMinChars", "OPENCODE_CONTEXT_PRUNER_BUDGET_MIN_CHARS"), Math.min(minChars, 200), 0, 10_000_000);
    const notifyRaw = firstDefined(pick("notify", "OPENCODE_CONTEXT_PRUNER_NOTIFY"), "detailed");
    let notify;
    if (typeof notifyRaw === "boolean")
        notify = notifyRaw ? "detailed" : "off";
    else if (["off", "minimal", "detailed"].includes(String(notifyRaw)))
        notify = String(notifyRaw);
    else
        notify = asBool(notifyRaw, true) ? "detailed" : "off";
    const notifyTypeRaw = String(firstDefined(pick("notifyType", "OPENCODE_CONTEXT_PRUNER_NOTIFY_TYPE"), "toast")).toLowerCase();
    const notifyType = notifyTypeRaw === "chat" ? "chat" : "toast";
    const notifyMinTokens = asInt(pick("notifyMinTokens", "OPENCODE_CONTEXT_PRUNER_NOTIFY_MIN_TOKENS"), 500, 0, 10_000_000);
    const notifyOnTopic = asBool(pick("notifyOnTopic", "OPENCODE_CONTEXT_PRUNER_NOTIFY_ON_TOPIC"), true);
    /**
     * CP-21: nested option values. `pick()` resolves options → env → file for
     * SCALARS, but the nested groups (`manualMode`, `turnProtection`, `strategies`)
     * were only ever read out of the config FILE, so the documented plugin options
     * set through `ctx.options` — the normal way a plugin is configured in
     * opencode.json — silently did nothing, and a JSON string (all an env var can
     * ever be) was dropped as well. Accept an object, a legacy boolean, or a JSON
     * string from any source.
     */
    const asObj = (value) => {
        if (isPlainObject(value))
            return value;
        if (typeof value === "string" && value.trim().startsWith("{")) {
            try {
                const parsed = JSON.parse(value);
                return isPlainObject(parsed) ? parsed : undefined;
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    };
    const manualValue = pick("manualMode", "OPENCODE_CONTEXT_PRUNER_MANUAL_MODE");
    const manualRaw = asObj(manualValue);
    // `manualMode.automaticStrategies` may also be given flat (it started life as
    // its own option in the E29 docs).
    const automaticRaw = firstDefined(manualRaw?.automaticStrategies, pick("automaticStrategies", "OPENCODE_CONTEXT_PRUNER_AUTOMATIC_STRATEGIES"));
    const manualMode = {
        enabled: manualRaw ? asBool(manualRaw.enabled, false) : asBool(manualValue, false),
        automaticStrategies: asBool(automaticRaw, true),
    };
    const turnValue = pick("turnProtection", "OPENCODE_CONTEXT_PRUNER_TURN_PROTECTION");
    const turnRaw = asObj(turnValue);
    const turnProtection = {
        enabled: asBool(turnRaw ? turnRaw.enabled : turnValue, false),
        turns: asInt(turnRaw ? turnRaw.turns : undefined, 4, 0, 1000),
    };
    const compressRaw = getPath(file, "compress");
    const compress = isPlainObject(compressRaw) ? compressRaw : {};
    const compressValue = (dcpKey, envKey, flatKey) => firstDefined(getPath(compress, dcpKey), pick(flatKey, envKey));
    const strategiesRaw = asObj(pick("strategies", "OPENCODE_CONTEXT_PRUNER_STRATEGIES")) ?? {};
    const dedupeFile = firstDefined(getPath(strategiesRaw, "deduplication"), getPath(file, "deduplication"));
    const purgeFile = firstDefined(getPath(strategiesRaw, "purgeErrors"), getPath(file, "purgeErrors"));
    const nudgeForceRaw = String(firstDefined(compressValue("nudgeForce", "", "nudgeForce"), "soft")).toLowerCase();
    return {
        enabled: asBool(pick("enabled", "OPENCODE_CONTEXT_PRUNER_ENABLED"), true),
        keepRecent,
        keepRecentText,
        relaxRecentFloor: asInt(pick("relaxRecentFloor", "OPENCODE_CONTEXT_PRUNER_RELAX_FLOOR"), 2, 0, 1000),
        minChars,
        budgetMinChars,
        keepHeadChars,
        keepErrors: asBool(pick("keepErrors", "OPENCODE_CONTEXT_PRUNER_KEEP_ERRORS"), true),
        ignoreTools: new Set(asList(pick("ignoreTools", "OPENCODE_CONTEXT_PRUNER_IGNORE"))),
        charsPerToken: charsPerToken > 0 ? charsPerToken : 3.6,
        budgetRatio: Math.min(Math.max(num(pick("budgetRatio", "OPENCODE_CONTEXT_PRUNER_BUDGET_RATIO"), 0.9), 0.1), 1),
        targetRatio: Math.min(Math.max(num(pick("targetRatio", "OPENCODE_CONTEXT_PRUNER_TARGET_RATIO"), 0.85), 0.1), 1),
        maxOutputReserve: asInt(pick("maxOutputReserve", "OPENCODE_CONTEXT_PRUNER_MAX_OUTPUT_RESERVE"), 8192, 0, 1_000_000),
        keepRecentTurns: asInt(pick("keepRecentTurns", "OPENCODE_CONTEXT_PRUNER_KEEP_RECENT_TURNS"), 2, 0, 1000),
        minReplanTokens: asInt(pick("minReplanTokens", "OPENCODE_CONTEXT_PRUNER_MIN_REPLAN_TOKENS"), 2000, 0, 10_000_000),
        dedupe: asBool(firstDefined(isPlainObject(dedupeFile) ? dedupeFile.enabled : dedupeFile, pick("dedupe", "OPENCODE_CONTEXT_PRUNER_DEDUPE")), true),
        purgeErrors: asBool(firstDefined(isPlainObject(purgeFile) ? purgeFile.enabled : purgeFile, pick("purgeErrors", "OPENCODE_CONTEXT_PRUNER_PURGE_ERRORS")), true),
        purgeErrorTurns: asInt(isPlainObject(purgeFile) ? purgeFile.turns : undefined, 4, 0, 1000),
        protectedTools,
        protectedPatterns,
        protectedInputPatterns,
        protectedFilePatterns,
        superseded: asBool(pick("superseded", "OPENCODE_CONTEXT_PRUNER_SUPERSEDED"), true),
        compressEnabled: asBool(compressValue("enabled", "OPENCODE_CONTEXT_PRUNER_COMPRESS", "compressEnabled"), true),
        compressText: asBool(compressValue("text", "OPENCODE_CONTEXT_PRUNER_COMPRESS_TEXT", "compressText"), true),
        // CP-6: the `compress.mode` option was dead config (every accepted value
        // mapped to "range"); it is no longer read — range behavior always applies,
        // and legacy configs that still set "mode" keep parsing without error.
        compressMaxSourceChars: asInt(compressValue("maxSourceChars", "OPENCODE_CONTEXT_PRUNER_COMPRESS_MAX_CHARS", "compressMaxSourceChars"), 24000, 500, 10_000_000),
        protectTags: asBool(compressValue("protectTags", "OPENCODE_CONTEXT_PRUNER_PROTECT_TAGS", "protectTags"), true),
        protectUserMessages: asBool(compressValue("protectUserMessages", "OPENCODE_CONTEXT_PRUNER_PROTECT_USER", "protectUserMessages"), false),
        summaryBuffer: asBool(compressValue("summaryBuffer", "OPENCODE_CONTEXT_PRUNER_SUMMARY_BUFFER", "summaryBuffer"), true),
        autoSummarize: asBool(compressValue("autoSummarize", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS", "autoSummarize"), true),
        autoSummarizeMaxCalls: asInt(compressValue("autoSummarizeMaxCalls", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MAX", "autoSummarizeMaxCalls"), 5, 0, 1000),
        autoSummarizeMinTokens: asInt(compressValue("autoSummarizeMinTokens", "OPENCODE_CONTEXT_PRUNER_AUTO_COMPRESS_MIN", "autoSummarizeMinTokens"), 4000, 0, 10_000_000),
        maxAutoSummaries: asInt(compressValue("maxAutoSummaries", "OPENCODE_CONTEXT_PRUNER_MAX_AUTO_SUMMARIES", "maxAutoSummaries"), 12, 0, 1000),
        // DCP has no cap on compression. The cap stays for the conservative
        // profile, but any profile can set it to 0 (unlimited); the model-call
        // budget is what actually gates the decision, and past
        // `autoSummarizeRatio` of the window a model call is worth it.
        autoSummarizeStub: asBool(compressValue("stubFallback", "OPENCODE_CONTEXT_PRUNER_AUTO_STUB", "autoSummarizeStub"), true),
        autoSummarizeRatio: Math.min(Math.max(num(compressValue("autoSummarizeRatio", "OPENCODE_CONTEXT_PRUNER_AUTO_RATIO", "autoSummarizeRatio"), 0.7), 0.1), 1),
        proactiveSummarize: asBool(pick("proactiveSummarize", "OPENCODE_CONTEXT_PRUNER_PROACTIVE"), true),
        steadyTargetRatio: Math.min(Math.max(num(pick("steadyTargetRatio", "OPENCODE_CONTEXT_PRUNER_STEADY_RATIO"), 0.06), 0), 1),
        steadyTargetMinTokens: asInt(pick("steadyTargetMinTokens", "OPENCODE_CONTEXT_PRUNER_STEADY_MIN"), 1500, 0, 10_000_000),
        collapseRanges: asBool(pick("collapseRanges", "OPENCODE_CONTEXT_PRUNER_COLLAPSE"), true),
        collapseStubs: asBool(pick("collapseStubs", "OPENCODE_CONTEXT_PRUNER_COLLAPSE_STUBS"), true),
        cacheAware: asBool(pick("cacheAware", "OPENCODE_CONTEXT_PRUNER_CACHE_AWARE"), true),
        cacheAmortize: asInt(pick("cacheAmortize", "OPENCODE_CONTEXT_PRUNER_CACHE_AMORTIZE"), 4, 1, 100),
        compactionCheckpoint: asBool(pick("compactionCheckpoint", "OPENCODE_CONTEXT_PRUNER_COMPACTION"), true),
        retryOnOverflow: asBool(pick("retryOnOverflow", "OPENCODE_CONTEXT_PRUNER_RETRY"), true),
        retryMaxAttempts: asInt(pick("retryMaxAttempts", "OPENCODE_CONTEXT_PRUNER_RETRY_MAX"), 3, 1, 100),
        recoveryRatio: Math.min(Math.max(num(pick("recoveryRatio", "OPENCODE_CONTEXT_PRUNER_RECOVERY_RATIO"), 0.5), 0.1), 0.9),
        titleShortCircuit: asBool(pick("titleShortCircuit", "OPENCODE_CONTEXT_PRUNER_TITLE"), false),
        summaryKeep: asInt(pick("summaryKeep", "OPENCODE_CONTEXT_PRUNER_SUMMARY_KEEP"), 100, 0, 100000),
        recall: asBool(pick("recall", "OPENCODE_CONTEXT_PRUNER_RECALL"), true),
        recallKeep: asInt(pick("recallKeep", "OPENCODE_CONTEXT_PRUNER_RECALL_KEEP"), 50, 0, 10000),
        recallMaxChars: asInt(pick("recallMaxChars", "OPENCODE_CONTEXT_PRUNER_RECALL_MAX_CHARS"), 200000, 1000, 10_000_000),
        storageGc: asBool(pick("storageGc", "OPENCODE_CONTEXT_PRUNER_STORAGE_GC"), true),
        summaryCacheMax: asInt(pick("summaryCacheMax", "OPENCODE_CONTEXT_PRUNER_SUMMARY_CACHE_MAX"), 500, 0, 1_000_000),
        calibrationMax: asInt(pick("calibrationMax", "OPENCODE_CONTEXT_PRUNER_CALIBRATION_MAX"), 256, 0, 1_000_000),
        minContextLimit: parseLimit(compressValue("minContextLimit", "OPENCODE_CONTEXT_PRUNER_MIN_CONTEXT_LIMIT", "minContextLimit")),
        maxContextLimit: parseLimit(compressValue("maxContextLimit", "OPENCODE_CONTEXT_PRUNER_MAX_CONTEXT_LIMIT", "maxContextLimit")),
        modelMinLimits: getPath(compress, "modelMinLimits") ?? {},
        modelMaxLimits: getPath(compress, "modelMaxLimits") ?? {},
        nudgeEnabled: asBool(compressValue("nudgeEnabled", "OPENCODE_CONTEXT_PRUNER_NUDGE", "nudgeEnabled"), true),
        nudgeFrequency: asInt(compressValue("nudgeFrequency", "OPENCODE_CONTEXT_PRUNER_NUDGE_FREQUENCY", "nudgeFrequency"), 5, 1, 1000),
        nudgeCallFrequency: asInt(compressValue("nudgeCallFrequency", "OPENCODE_CONTEXT_PRUNER_NUDGE_CALLS", "nudgeCallFrequency"), 8, 1, 10000),
        nudgeCriticalRatio: Math.min(Math.max(num(compressValue("nudgeCriticalRatio", "OPENCODE_CONTEXT_PRUNER_NUDGE_CRITICAL", "nudgeCriticalRatio"), 0.8), 0.1), 1),
        iterationNudgeThreshold: asInt(compressValue("iterationNudgeThreshold", "OPENCODE_CONTEXT_PRUNER_ITERATION_NUDGE", "iterationNudgeThreshold"), 15, 1, 10000),
        nudgeForce: nudgeForceRaw === "strong" ? "strong" : "soft",
        manualMode,
        turnProtection,
        notify,
        notifyType,
        notifyMinTokens,
        notifyOnTopic,
        log: asBool(pick("log", "OPENCODE_CONTEXT_PRUNER_LOG"), false),
        debug: asBool(pick("debug", "OPENCODE_CONTEXT_PRUNER_DEBUG"), false),
        configPath: path,
        // E25: custom summarization prompt template
        summaryPromptTemplate: typeof pick("summaryPromptTemplate", "OPENCODE_CONTEXT_PRUNER_SUMMARY_PROMPT_TEMPLATE") === "string" ? String(pick("summaryPromptTemplate", "OPENCODE_CONTEXT_PRUNER_SUMMARY_PROMPT_TEMPLATE")) : undefined,
        // E26: per-tool compression strategies
        toolStrategies: getPath(file, "toolStrategies") ?? undefined,
        // E29: custom notification hook (only from options, not env/file)
        notifyHook: typeof o.notifyHook === "function" ? o.notifyHook : undefined,
        // E32: custom eviction policy
        evictionPolicy: (() => {
            const raw = String(firstDefined(pick("evictionPolicy", "OPENCODE_CONTEXT_PRUNER_EVICTION_POLICY"), "lru")).toLowerCase();
            return raw === "lfu" || raw === "priority" ? raw : "lru";
        })(),
        // E33: fallback model for summarization
        fallbackModelId: typeof pick("fallbackModelId", "OPENCODE_CONTEXT_PRUNER_FALLBACK_MODEL") === "string" ? String(pick("fallbackModelId", "OPENCODE_CONTEXT_PRUNER_FALLBACK_MODEL")) : undefined,
        // E35: custom token counter (only from options)
        tokenCounter: typeof o.tokenCounter === "function" ? o.tokenCounter : undefined,
        // E38: token budget scheduling
        budgetSchedule: Array.isArray(getPath(file, "budgetSchedule")) ? getPath(file, "budgetSchedule") : undefined,
        // E39: locale
        locale: typeof pick("locale", "OPENCODE_CONTEXT_PRUNER_LOCALE") === "string" ? String(pick("locale", "OPENCODE_CONTEXT_PRUNER_LOCALE")) : "en",
        // E40: custom compression strategies (only from options)
        customStrategies: Array.isArray(o.customStrategies) ? o.customStrategies : undefined,
    };
}
function valueToText(value) {
    if (typeof value === "string") {
        if (value.length > 2000 && value.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 2000)) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value))
            return `${value.slice(0, 2000)}\n[truncated]`;
        return value.length > 50000 ? `${value.slice(0, 50000)}\n[truncated]` : value;
    }
    if (value === undefined || value === null)
        return "";
    if (Array.isArray(value)) {
        // Live tool-result values are arrays of content parts
        // (`[{type:"text",text}, {type:"file",...}]`). Extract the readable text
        // so pruning measures — and stubs — the same text the model would see.
        const texts = [];
        for (const item of value) {
            if (typeof item === "string") {
                texts.push(item);
            }
            else if (isPlainObject(item) && typeof item.text === "string") {
                texts.push(item.text);
            }
        }
        if (texts.length > 0)
            return texts.join("\n");
        // No text parts (e.g. file-only output): fall through to JSON so the
        // size estimate still reflects the payload instead of reading empty.
    }
    try {
        // CP-9: file-only payloads can be huge — cap the serialized form.
        const json = JSON.stringify(value) ?? "";
        return json.length > 2000 ? `${json.slice(0, 2000)}\n[truncated]` : json;
    }
    catch {
        return String(value);
    }
}
function resultText(result) {
    if (!result)
        return "";
    return valueToText(result.value);
}
function isToolResult(part) {
    return part.type === "tool-result" || (part.result !== undefined && part.type === undefined);
}
function toolNameOf(part) {
    return String(part.name ?? part.toolName ?? part.tool ?? "tool");
}
function isErrorResult(result) {
    return result?.type === "error";
}
/** `session.generate` may return `{ text }` or a wrapped `{ data: { text } }`. */
function generatedText(response) {
    if (typeof response === "string")
        return response;
    if (isPlainObject(response)) {
        if (typeof response.text === "string")
            return response.text;
        const data = response.data;
        if (isPlainObject(data) && typeof data.text === "string")
            return data.text;
    }
    return "";
}
/** FNV-1a, stable within a process and cheap over large strings. */
function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}
function estimateTokens(text, cfg, ratio) {
    // E35: use custom token counter if provided
    if (cfg.tokenCounter) {
        const n = cfg.tokenCounter(text);
        if (Number.isFinite(n) && n > 0)
            return Math.ceil(n * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1));
    }
    return estimateCharsTokens(text.length, cfg, ratio);
}
/** The same conversion for a size that is already known in characters. */
function estimateCharsTokens(chars, cfg, ratio) {
    if (chars <= 0)
        return 0;
    const base = chars / cfg.charsPerToken;
    return Math.max(1, Math.ceil(base * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1)));
}
function partKey(mi, pi, part, message) {
    const id = part.id ?? part.toolCallId;
    if (id)
        return `t:${id}`;
    return `m:${message.id ?? mi}:${pi}`;
}
/**
 * Tool arguments live on the sibling `tool-call` part, not on `tool-result`
 * (`ToolResultPart` has no `input`). Correlate them by id so signature dedupe,
 * superseded reads and protected paths also work on the real hook payload.
 */
function toolCallInputs(messages) {
    const out = new Map();
    for (const message of messages) {
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const part of content) {
            if (part?.type !== "tool-call")
                continue;
            const id = part.id ?? part.toolCallId;
            if (id)
                out.set(id, part.input);
        }
    }
    return out;
}
function collectResults(messages, cfg, ratio) {
    const out = [];
    let totalTokens = 0;
    const callInputs = toolCallInputs(messages);
    for (let mi = 0; mi < messages.length; mi++) {
        const message = messages[mi] ?? {};
        const content = Array.isArray(message.content) ? message.content : [];
        for (let pi = 0; pi < content.length; pi++) {
            const part = content[pi] ?? {};
            if (isToolResult(part)) {
                const text = resultText(part.result);
                const callId = part.id ?? part.toolCallId;
                const tokens = estimateTokens(text, cfg, ratio);
                out.push({
                    mi,
                    pi,
                    key: partKey(mi, pi, part, message),
                    name: toolNameOf(part),
                    text,
                    error: isErrorResult(part.result),
                    tokens,
                    part,
                    input: part.input !== undefined ? part.input : callId ? callInputs.get(callId) : undefined,
                    kind: "tool",
                });
                totalTokens += tokens;
                continue;
            }
            // Prose is opt-in (compressText). We replace the text part in place; the
            // message and any tool-call parts stay exactly where they were, so a
            // tool call is never decoupled from its result.
            if (!cfg.compressText || part.type !== "text" || typeof part.text !== "string")
                continue;
            const role = String(message.role ?? "");
            if (role !== "assistant" && role !== "user")
                continue;
            if (role === "user" && cfg.protectUserMessages)
                continue;
            const text = part.text;
            if (!text.trim())
                continue;
            const tokens = estimateTokens(text, cfg, ratio);
            out.push({
                mi,
                pi,
                key: partKey(mi, pi, part, message),
                name: role === "user" ? "user-message" : "assistant-message",
                text,
                error: false,
                tokens,
                part,
                input: undefined,
                kind: "text",
            });
            totalTokens += tokens;
        }
    }
    return Object.assign(out, { totalTokens });
}
/**
 * CP-19: release the message-graph references a compiled request collected.
 * `st.compressible` survives until the NEXT request replaces it, and every unit
 * held its part (a clone of the whole message, content arrays included, with
 * `result.value` holding a second copy of the very text the unit already
 * carries) plus the tool input. Small scalars the later tools still need — file
 * path, part id, text size — are snapshotted first. Everything the compile
 * itself needs (planning, summaries, stubs, span collapse) runs BEFORE this.
 */
function releaseCompiledUnits(results) {
    for (const r of results) {
        if (r.part === undefined)
            continue;
        if (!r.file)
            r.file = filePathOf(r);
        const id = r.part.id ?? r.part.toolCallId;
        if (typeof id === "string" && !r.ref)
            r.ref = id;
        if (r.size === undefined)
            r.size = r.text.length;
        r.part = undefined;
        r.input = undefined;
    }
}
function userMessageIndexes(messages) {
    const userIdxs = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.role === "user")
            userIdxs.push(i);
    }
    return userIdxs;
}
/**
 * Index of the oldest message inside the window covered by the last `turns`
 * user messages, or -1 when the session is not even `turns` turns long yet.
 *
 * This is the VOLUNTARY recency ring (`keepRecentTurns` / `turnProtection` /
 * `purgeErrorTurns`): "keep the last N turns untouched". A window wider than the
 * transcript is not a protection, it is the whole transcript — returning the
 * first user message here made `candidateResults` drop every single unit in a
 * short session, so a fresh/subagent/fork transcript could never be pruned,
 * summarised or repurged at all.
 *
 * The mandatory live-turn guard (invariant C2) does NOT come from here: it is
 * `liveTurnIndex`, computed independently of any window, so the tool output the
 * model has just received is protected no matter how the rings are configured.
 */
function protectedFromIndex(messages, turns) {
    if (turns <= 0)
        return -1;
    const userIdxs = userMessageIndexes(messages);
    if (userIdxs.length <= turns)
        return -1;
    return userIdxs[userIdxs.length - turns];
}
/**
 * CP-1: message index of the NEWEST user message (-1 = none) — the start of the
 * live turn. Computed independently of the turn-protection window so the live
 * turn stays protected even in a session with a single user message.
 *
 * A message whose content is nothing but tool results is NOT a user turn — it is
 * the tool channel carried on a user message, and counting it as the start of a
 * new turn made the guard swallow every unit of such a request (invariant C2
 * became "never prune", which is no protection at all). A genuine turn always
 * carries user-authored text/file parts, so the newest message with one of those
 * is where the live turn starts.
 */
function liveTurnIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== "user")
            continue;
        const content = Array.isArray(messages[i]?.content) ? messages[i].content : [];
        if (content.length === 0)
            return i;
        if (content.some((part) => !isToolResult(part)))
            return i;
    }
    return -1;
}
/** C3: count of tool-call parts in the outgoing request. */
function countToolCalls(messages) {
    let n = 0;
    for (const message of messages) {
        for (const part of message.content ?? [])
            if (part.type === "tool-call")
                n++;
    }
    return n;
}
function partHasReasoning(part) {
    if (!isPlainObject(part))
        return false;
    const p = part;
    const type = String(p.type ?? "").toLowerCase();
    if (type === "reasoning" || type === "thinking")
        return true;
    if (typeof p.reasoning === "string" && p.reasoning.length > 0)
        return true;
    if (typeof p.thinking === "string" && p.thinking.length > 0)
        return true;
    return false;
}
function messageHasReasoning(message) {
    if (!isPlainObject(message))
        return false;
    const m = message;
    if (typeof m.reasoning === "string" && m.reasoning.length > 0)
        return true;
    if (typeof m.thinking === "string" && m.thinking.length > 0)
        return true;
    const content = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
    for (const part of content)
        if (partHasReasoning(part))
            return true;
    return false;
}
/**
 * Reasoning turns are provider-sensitive. Injecting a synthetic turn into a
 * session whose transcript already carries assistant reasoning makes strict
 * providers (reasoning_content round-trip / "thinking is enabled but
 * reasoning_content is missing") reject the next request and kills the
 * session. Detect the real part shape (`type: "reasoning"`) as well as the
 * legacy top-level `reasoning`/`thinking` fields and `parts` arrays.
 */
function hasReasoningContent(messages) {
    for (const message of messages)
        if (messageHasReasoning(message))
            return true;
    return false;
}
/** C16: prose compresses far better than tool output — lower floor for it. */
function minCharsFor(r, cfg) {
    // E26: per-tool compression strategies
    const strategy = cfg.toolStrategies?.[r.name];
    if (strategy?.minChars !== undefined)
        return strategy.minChars;
    return r.kind === "text" ? Math.max(200, Math.floor(cfg.minChars / 4)) : cfg.minChars;
}
/** E26: effective max source chars for a tool, falling back to the global cap. */
function maxSourceCharsFor(toolName, cfg) {
    const strategy = toolName ? cfg.toolStrategies?.[toolName] : undefined;
    if (strategy?.maxSourceChars !== undefined && strategy.maxSourceChars > 0)
        return strategy.maxSourceChars;
    return cfg.compressMaxSourceChars;
}
function filePathOf(result) {
    // CP-19: `input` is released with the message part; the snapshot taken at
    // release time keeps file notes working for a compiled-but-idle session.
    if (typeof result.file === "string" && result.file)
        return result.file;
    if (!isPlainObject(result.input))
        return undefined;
    const value = firstDefined(result.input.filePath, result.input.path, result.input.file);
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
}
/** Canonical key for comparing file paths across case-insensitive filesystems. */
function pathKey(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}
function pathOfPart(part) {
    if (!isPlainObject(part.input))
        return undefined;
    const value = firstDefined(part.input.filePath, part.input.path, part.input.file);
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
}
function errorText(error) {
    if (typeof error === "string")
        return error;
    if (isPlainObject(error)) {
        const direct = firstDefined(error.message, error.name, error.type, error.reason, error.detail);
        if (typeof direct === "string")
            return direct;
        try {
            return JSON.stringify(error);
        }
        catch {
            return "";
        }
    }
    return error ? String(error) : "";
}
/** Provider phrasing for "the prompt is larger than the window". */
function isOverflowError(text) {
    return /context[_ ]?(length|window|limit|size)|maximum context|too many tokens|token limit|prompt is too long|reduce the length|exceeds? the (maximum |available )?context|exceed_?context/i.test(text);
}
/** Deterministic compaction checkpoint: goals, progress, files, recent errors. */
function buildCheckpoint(messages) {
    const goals = [];
    const progress = [];
    const files = new Map();
    const errors = [];
    for (const message of messages) {
        const role = String(message.role ?? "");
        for (const part of message.content ?? []) {
            const type = String(part.type ?? "");
            if (type === "text" && typeof part.text === "string" && part.text.trim()) {
                if (role === "user")
                    goals.push(part.text.trim());
                else if (role === "assistant")
                    progress.push(part.text.trim());
                continue;
            }
            if (type === "tool-call" || type === "tool-result") {
                const path = pathOfPart(part);
                if (path)
                    files.set(path, (files.get(path) ?? 0) + 1);
                if (type === "tool-result" && isErrorResult(part.result)) {
                    const text = resultText(part.result).replace(/\s+/g, " ").trim();
                    if (text)
                        errors.push(`- ${String(part.name ?? "tool")}: ${text.slice(0, 200)}`);
                }
            }
        }
    }
    const squash = (text, limit) => text.replace(/\s+/g, " ").trim().slice(0, limit);
    const lines = ["# Context checkpoint", ""];
    if (goals.length) {
        lines.push("## Goal");
        for (const goal of goals.slice(-3))
            lines.push(`- ${squash(goal, 400)}`);
        lines.push("");
    }
    if (progress.length) {
        lines.push("## Progress");
        for (const item of progress.slice(-3))
            lines.push(`- ${squash(item, 400)}`);
        lines.push("");
    }
    if (files.size) {
        lines.push("## Files touched");
        for (const [path, count] of [...files.entries()].slice(-40))
            lines.push(`- ${path}${count > 1 ? ` (${count}x)` : ""}`);
        lines.push("");
    }
    if (errors.length) {
        lines.push("## Recent tool errors");
        lines.push(...errors.slice(-5));
        lines.push("");
    }
    lines.push("_Written automatically by context-pruner; the full transcript stays on disk._");
    return lines.join("\n");
}
function deriveTitle(messages) {
    for (const message of messages) {
        if (String(message.role ?? "") !== "user")
            continue;
        for (const part of message.content ?? []) {
            if (String(part.type ?? "") !== "text" || typeof part.text !== "string")
                continue;
            const text = part.text
                .replace(/```[\s\S]*?```/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            if (!text)
                continue;
            const sentence = text.split(/[.!?\n]/)[0]?.trim() ?? text;
            const title = sentence.slice(0, 60).trim();
            if (title.length >= 3)
                return title;
        }
    }
    return undefined;
}
// CP-11: shared RegExp instances are stateful when global/sticky — a `g`/`y`
// flag left over from a future caller or hand-built config would make
// `test()` alternate true/false via `lastIndex`. Reset around every test.
function statelessTest(re, text) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
}
function blockedByFilePattern(result, cfg) {
    if (cfg.protectedFilePatterns.length === 0)
        return false;
    const path = filePathOf(result);
    if (!path)
        return false;
    return cfg.protectedFilePatterns.some((re) => statelessTest(re, path));
}
function isProtected(result, cfg) {
    if (cfg.ignoreTools.has(result.name) ||
        cfg.protectedTools.has(result.name) ||
        cfg.protectedPatterns.some((re) => statelessTest(re, result.name)) ||
        blockedByFilePattern(result, cfg)) {
        return true;
    }
    if (cfg.protectedInputPatterns.length > 0 && result.input !== undefined) {
        try {
            const serialized = JSON.stringify(result.input);
            if (serialized && cfg.protectedInputPatterns.some((re) => statelessTest(re, serialized))) {
                return true;
            }
        }
        catch {
            // Non-serializable input — skip pattern matching.
        }
    }
    return false;
}
/** Shared empty set for the relaxed recency ring — never mutated. */
const EMPTY_KEYSET = new Set();
/**
 * Shared scan for the candidate filter: the recency ring keys, the turn
 * protection index, and the error-purge index. Computed once per request and
 * reused by every candidateResults call — they only differ in minLength and
 * the relax flags, never in this scan.
 */
function candidateScan(results, messages, cfg) {
    const toolResults = results.filter((r) => r.kind === "tool");
    const recentKeys = new Set(toolResults.slice(Math.max(0, toolResults.length - cfg.keepRecent)).map((r) => r.key));
    const turns = Math.max(cfg.keepRecentTurns, cfg.turnProtection.enabled ? cfg.turnProtection.turns : 0);
    const from = turns <= 0 ? -1 : protectedFromIndex(messages, turns);
    const errorFrom = cfg.purgeErrors && !cfg.keepErrors ? protectedFromIndex(messages, cfg.purgeErrorTurns) : -1;
    return { recentKeys, from, errorFrom };
}
function candidateResults(results, messages, cfg, covered, minLength = cfg.minChars, relax = {
    recent: false,
    turns: false,
}, liveFrom = -1, scan) {
    // CP-2: the recency ring is a ring of TOOL outputs. Slicing the mixed
    // tool+prose list let prose eat the ring (with compressText on by default
    // that ring-fenced only half the intended tool outputs). The slice index has
    // to come from the FILTERED list too — measured against the mixed length, a
    // single prose part silently shrank the ring below `keepRecent`.
    const shared = scan ?? candidateScan(results, messages, cfg);
    const recent = relax.recent ? EMPTY_KEYSET : shared.recentKeys;
    const from = relax.turns ? -1 : shared.from;
    const errorFrom = shared.errorFrom;
    return results.filter((r) => r.kind === "tool" &&
        // C2: the live turn is NEVER eligible — deep relaxation used to allow
        // stubbing the very tool result this request just received.
        !(liveFrom >= 0 && r.mi >= liveFrom) &&
        !recent.has(r.key) &&
        !covered.has(r.key) &&
        !(from >= 0 && r.mi >= from) &&
        !(errorFrom >= 0 && r.error && r.mi >= errorFrom) &&
        !isProtected(r, cfg) &&
        r.text.length >= minLength);
}
/**
 * Prose units that must not be summarised: the most recent `keepRecentText`
 * and anything inside the protected turns. Tool results are handled separately
 * by `candidateResults`.
 */
function protectedTextKeys(units, st, cfg) {
    const keys = new Set();
    const texts = units.filter((u) => u.kind === "text");
    const recent = texts.slice(Math.max(0, texts.length - cfg.keepRecentText));
    for (const u of recent)
        keys.add(u.key);
    if (st.textProtectedFrom >= 0) {
        for (const u of texts)
            if (u.mi >= st.textProtectedFrom)
                keys.add(u.key);
    }
    return keys;
}
/** Stable identity of a tool call: tool name plus sorted, normalised arguments. */
function toolSignature(r) {
    if (r.kind !== "tool" || !isPlainObject(r.input))
        return "";
    const keys = Object.keys(r.input).sort();
    const json = JSON.stringify(r.input, keys, 0) ?? "";
    if (json.length > 4096)
        return "";
    return hash32(`${r.name}\u0000${json}`).toString(16);
}
function recallId(key, text) {
    return hash32(`${key}\u0000${text}`).toString(16).padStart(8, "0");
}
/**
 * Drop entries until the cache is within `keep`.
 *
 * CP-12: every policy picks its victim on an (score, at) TUPLE. The old code
 * overwrote `score` with a timestamp in the tie-break branch and then compared
 * that against the running best score, so lfupriority victims were chosen
 * essentially at random once more than one entry shared a score.
 */
function evictRecall(st, keep, policy) {
    while (st.recall.size > keep) {
        let evictKey;
        let evictScore = Infinity;
        let evictAt = Infinity;
        for (const [key, entry] of st.recall) {
            // LFU: lowest access count; priority: lowest priority (imported state
            // only); LRU (default): oldest access. All tie-break on the oldest `at`.
            const score = policy === "lfu" ? (entry.hits ?? 0) : policy === "priority" ? (entry.priority ?? 0) : entry.at;
            if (score < evictScore || (score === evictScore && entry.at < evictAt)) {
                evictScore = score;
                evictAt = entry.at;
                evictKey = key;
            }
        }
        if (evictKey === undefined)
            break;
        st.recall.delete(evictKey);
    }
}
/**
 * CP-7: factor applied to `recallMaxChars` (the READ cap) to derive the WRITE
 * cap. `valueToText`'s array branch joins content parts with no cap at all, so
 * an uncapped store turned a few large reads into hundreds of MB persisted
 * through `recall:<sid>` on every pruning request. Storage holds a generous
 * multiple of what a single read can ever return.
 */
const RECALL_STORE_FACTOR = 2;
/**
 * Keep the full text of a pruned result so the model can recall it instead of
 * paying to re-run the tool. Bounded by count; oldest entries fall away first.
 * The entry is written through to `ctx.storage` so a restart keeps recall alive.
 */
function rememberOutput(st, r, cfg) {
    if (!cfg.recall || cfg.recallKeep <= 0)
        return undefined;
    const id = recallId(r.key, r.text);
    if (!st.recall.has(id)) {
        // CP-7: cap what is stored; `chars` keeps the ORIGINAL size so the read
        // path can still tell the model how much was given up.
        const storeCap = Math.max(cfg.recallMaxChars, 1000) * RECALL_STORE_FACTOR;
        const text = r.text.length > storeCap ? `${r.text.slice(0, storeCap)}\n[context-pruner] stored output truncated at ${storeCap} chars` : r.text;
        st.recall.set(id, { tool: r.name, text, chars: r.text.length, at: Date.now(), hits: 0 });
        evictRecall(st, cfg.recallKeep, cfg.evictionPolicy);
        st.recallDirty = true;
    }
    return id;
}
/** C8: per-request memo — planDecisions runs up to 4x per request and each
 * run rebuilt identical stub strings with repeated slicing. Pure function of
 * the key parts, so entries stay valid across requests; bounded by cap. */
const stubMemo = new Map();
const STUB_MEMO_MAX = 4096;
function makeStub(r, reason, cfg, ratio, id) {
    const memoKey = `${r.key}|${reason}|${r.text.length}|${hash32(r.text.slice(0, 512))}|${cfg.keepHeadChars}|${ratio}|${id ?? ""}`;
    const memoHit = stubMemo.get(memoKey);
    if (memoHit)
        return memoHit;
    const resultType = isPlainObject(r.part?.result) ? r.part.result.type : undefined;
    const isText = resultType === undefined || resultType === "text";
    const head = isText ? r.text.slice(0, cfg.keepHeadChars).trimEnd() : "";
    const path = filePathOf(r);
    const fileNote = path ? ` (file: ${path})` : "";
    const hint = id ? ` Full output kept locally: call context_pruner_recall with id "${id}".` : "";
    const marker = `[context-pruner] output of "${r.name}"${fileNote} pruned (${r.text.length} chars, ~${r.tokens} tokens). ${reason}. Re-run the tool if you need it again.${hint}`;
    const stub = head ? `${head}\n\n${marker}` : marker;
    const out = {
        stub,
        savedChars: Math.max(0, r.text.length - stub.length),
        savedTokens: Math.max(0, r.tokens - estimateTokens(stub, cfg, ratio)),
    };
    // CP-10: FIFO-evict the oldest entries instead of dropping the whole
    // cache — a full clear throws away hot stubs next to cold ones.
    if (stubMemo.size >= STUB_MEMO_MAX) {
        let evicted = 0;
        for (const oldest of stubMemo.keys()) {
            stubMemo.delete(oldest);
            if (++evicted >= 512)
                break;
        }
    }
    stubMemo.set(memoKey, out);
    return out;
}
/** Hash each covered result's text so a summary can detect changed sources. */
function coverHashes(results) {
    return results.map((r) => hash32(r.text));
}
function isPrunedStub(text) {
    return (text.startsWith(STUB_MARK) ||
        text.includes(`\n\n${STUB_MARK}`) ||
        text.startsWith(POINTER_MARK) ||
        text.startsWith(SUMMARY_MARK) ||
        text.startsWith(PROSE_SUMMARY_MARK));
}
/**
 * Build a replacement result that the model request can actually send.
 * OpenCode core iterates `result.value` as an array
 * (`value.map((a) => a.type !== "file" ? a : ...)`, SessionModelRequest.prepare),
 * so a plain string here crashes every subsequent request with
 * `s.result.value.map is not a function`. Pruned output is text, so the
 * replacement is always `{type:"text", value:[{type:"text",text}]}`.
 */
function typedResult(_r, value) {
    return { type: "text", value: [{ type: "text", text: value }] };
}
/** Write the compiled value back into the part for this request only. */
function writeUnit(r, value) {
    // CP-19: a released unit (its request is long gone) has no part to rewrite.
    const part = r.part;
    if (!part)
        return;
    if (r.kind === "text") {
        // Prose keeps `type: "text"` and every sibling part stays in place.
        part.text = value;
        return;
    }
    // CP-7: preserve extra host fields — replacing the whole object drops
    // metadata the host attached to `result`.
    const prev = isPlainObject(part.result) ? part.result : {};
    part.result = { ...prev, ...typedResult(r, value) };
}
/**
 * Structural copy of a value for the *request only*. The context hook rewrites
 * messages in place, and the host re-serialises `event.messages` afterwards, so
 * a mutation that reaches a stored message object also reaches the transcript
 * on disk (a folded assistant reply persisted as a bare
 * `[context-pruner] folded into summary` pointer). Cloning each message slot
 * before rewriting keeps the on-disk record pristine. Plain objects and arrays
 * are copied recursively; anything else (class instances, typed arrays) is kept
 * by reference so host-owned payloads are not rebuilt.
 *
 * CP-24: this cost is measured, not assumed — 0.081 ms for a 150-message /
 * 0.34 MB session, 0.853 ms for 1500 messages / 3.41 MB, i.e. ~0.25 ms/MB.
 * The context hook itself costs 14-95 ms on those same sessions, so the copy is
 * <=1% of a request. A targeted copy-on-write (shallow message, deep only the
 * tool-result `result`/`value` the hook actually rewrites) measures 5.8-8.6x
 * cheaper, which is ~0.7 ms on a ~90 ms hook: not worth trading a structurally
 * obvious copy for one that has to enumerate every mutation site to stay
 * transcript-safe. `tests/verify-pruner-transcript.mjs` holds the budget so a
 * future change cannot quietly make this super-linear.
 */
function cloneForRequest(value) {
    if (Array.isArray(value))
        return value.map((v) => cloneForRequest(v));
    if (value && typeof value === "object") {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) {
            const out = {};
            for (const key of Object.keys(value))
                out[key] = cloneForRequest(value[key]);
            return out;
        }
    }
    return value;
}
function sumSaved(decisions) {
    let total = 0;
    for (const d of decisions.values())
        total += d.savedTokens;
    return total;
}
function systemTextOf(event) {
    const system = event.system;
    if (!Array.isArray(system))
        return "";
    return system
        .map((p) => (p && typeof p.text === "string" ? String(p.text) : ""))
        .join("\n");
}
const modelCaches = new WeakMap();
let modelCacheSize = 0;
/** Model lists come back as `{ data: [...] }` (async) or a bare array (tests). */
function normalizeModels(value) {
    if (Array.isArray(value))
        return value;
    if (isPlainObject(value) && Array.isArray(value.data))
        return value.data;
    if (isPlainObject(value) && Array.isArray(value.models))
        return value.models;
    return [];
}
function setModelCache(ctx, models) {
    modelCaches.set(ctx, models);
    modelCacheSize = Math.max(modelCacheSize, models.length);
}
/**
 * CP: model id → input price, memoised on the cached model list so `compress`
 * does not await/parse `ctx.model.list()` on every summarised request. Rebuilt
 * whenever the cached list reference changes.
 */
const modelPricingCaches = new WeakMap();
function modelInputPrices(ctx) {
    const source = modelCaches.get(ctx) ?? [];
    const cached = modelPricingCaches.get(ctx);
    if (cached && cached.source === source)
        return cached.prices;
    const prices = new Map();
    for (const m of source) {
        if (typeof m?.id === "string")
            prices.set(m.id, num(m?.cost?.[0]?.input));
    }
    modelPricingCaches.set(ctx, { source, prices });
    return prices;
}
/**
 * `ctx.model.list()` is async in the live runtime, but the context hook is
 * synchronous. Resolve it once per context object and read the cached result.
 */
function refreshModels(ctx) {
    try {
        if (typeof ctx.model?.list !== "function")
            return;
        const value = ctx.model.list();
        if (Array.isArray(value)) {
            setModelCache(ctx, normalizeModels(value));
            return;
        }
        if (value && typeof value.then === "function") {
            void value
                .then((output) => setModelCache(ctx, normalizeModels(output)))
                .catch(() => { });
        }
    }
    catch {
        /* ignore */
    }
}
function resolveModel(ctx, ref) {
    const list = modelCaches.get(ctx) ?? [];
    if (list.length === 0)
        return undefined;
    const id = ref?.id ?? ref?.modelID ?? ref?.model ?? ref?.name;
    const pid = ref?.providerID ?? ref?.provider;
    const matches = (m) => m?.id === id ||
        m?.modelID === id ||
        (typeof m?.id === "string" && typeof id === "string" && (m.id === `${pid}/${id}` || m.id.endsWith(`/${id}`)));
    const wrongProvider = (m) => typeof pid === "string" && typeof m?.providerID === "string" && m.providerID !== pid;
    if (typeof id === "string") {
        const exact = list.find((m) => matches(m) && !wrongProvider(m));
        if (exact)
            return exact;
        const loose = list.find(matches);
        if (loose)
            return loose;
    }
    if (typeof pid === "string")
        return list.find((m) => m?.providerID === pid);
    return undefined;
}
function budgetFor(model, cfg, turn) {
    const window = num(model?.limit?.context);
    if (!window || window <= 0)
        return null;
    // E38: token budget scheduling — look up budget ratio by turn
    let budgetRatio = cfg.budgetRatio;
    if (cfg.budgetSchedule && cfg.budgetSchedule.length > 0 && turn !== undefined) {
        // Find the most recent schedule entry for this turn
        let best;
        for (const entry of cfg.budgetSchedule) {
            if (entry.turn <= turn && (!best || entry.turn >= best.turn)) {
                best = entry;
            }
        }
        if (best)
            budgetRatio = best.budgetRatio;
    }
    // CP-5: real hard cap — reserve is the model's output limit clamped to
    // maxOutputReserve, falling back to maxOutputReserve when unknown.
    const outputLimit = num(model?.limit?.output);
    const reserve = outputLimit > 0 ? Math.min(outputLimit, cfg.maxOutputReserve) : cfg.maxOutputReserve;
    const budget = Math.max(0, Math.floor(window * budgetRatio) - reserve);
    const target = Math.max(0, Math.floor(budget * cfg.targetRatio));
    return { window, budget, target };
}
/** Resolve a per-model override map entry (exact provider/id, id, then substring). */
function overrideLimit(map, model, ref) {
    const keys = Object.keys(map);
    if (keys.length === 0)
        return undefined;
    const pid = model?.providerID ?? (typeof ref?.providerID === "string" ? ref.providerID : undefined);
    const id = model?.id ?? (typeof ref?.modelID === "string" ? ref.modelID : typeof ref?.id === "string" ? ref.id : undefined);
    const candidates = [pid && id ? `${pid}/${id}` : "", id ?? "", pid ?? ""].filter(Boolean);
    for (const candidate of candidates) {
        if (map[candidate] !== undefined)
            return parseLimit(map[candidate]);
    }
    for (const key of keys) {
        if (id && id.includes(key))
            return parseLimit(map[key]);
    }
    return undefined;
}
// ----------------------------------------------------------------------------
// module state
const sessions = new Map();
const calibration = new Map();
// CP-4: model-key hint per session — must be evicted with its session (see stateFor).
const sessionModelKey = new Map();
/**
 * CP-1: best-effort storage write — a throwing or rejecting store must never
 * surface (sync throw is swallowed, async rejection gets a no-op catch so
 * Node never reports an unhandled rejection).
 *
 * CP-15: `onFail` lets the caller REPORT the failure (the plugin's own state is
 * being lost); the swallow/no-throw contract is unchanged.
 */
function guardedSet(store, key, value, onFail) {
    const fail = (err) => {
        if (!onFail)
            return;
        try {
            onFail(err);
        }
        catch {
            /* a failing reporter must not break the write path either */
        }
    };
    try {
        Promise.resolve(store?.set?.(key, value)).catch((err) => {
            fail(err);
        });
    }
    catch (err) {
        fail(err);
    }
}
/**
 * CP-16: best-effort storage delete. Session deletion is a host event; a failing
 * store must not turn cleanup into a crash, and must not leave an unhandled
 * rejection behind. Mirrors guardedSet (including CP-15's reporter).
 */
function guardedRemove(store, key, onFail) {
    const fail = (err) => {
        if (!onFail)
            return;
        try {
            onFail(err);
        }
        catch {
            /* ignore */
        }
    };
    try {
        Promise.resolve(store?.remove?.(key)).catch((err) => {
            fail(err);
        });
    }
    catch (err) {
        fail(err);
    }
}
/**
 * Adaptive cache economics. Rewriting a cached prefix pays the provider's
 * cache-write premium once; pruning saves cache-read tokens on every later
 * request. Return the token savings needed to amortise that rewrite within
 * `cacheAmortize` future requests, capped at half the target so a warm cache
 * can defer churn but never starve the budget.
 */
function cacheReplanGate(st, cfg) {
    if (!cfg.cacheAware)
        return 0;
    if (st.cacheRead === 0 && st.cacheWrite === 0)
        return 0;
    const read = st.cacheReadPrice > 0 ? st.cacheReadPrice : st.inputCost * 0.1;
    const write = st.cacheWritePrice > 0 ? st.cacheWritePrice : st.inputCost * 1.25;
    const premium = write - read;
    if (read <= 0 || premium <= 0)
        return 0;
    const suffix = st.pendingEstimate > 0 ? st.pendingEstimate : st.budget ?? 0;
    return Math.max(0, (suffix * premium) / (read * Math.max(1, cfg.cacheAmortize)));
}
const totals = {
    requests: 0,
    pruned: 0,
    stubbed: 0,
    stubSavedTokens: 0,
    savedChars: 0,
    savedTokens: 0,
    summaries: 0,
    summarySavedTokens: 0,
    generations: 0,
    nudgeCount: 0,
    checkpoints: 0,
    overflowRecoveries: 0,
    recalls: 0,
    collapsedSpans: 0,
    collapsedMessages: 0,
    collapsedTokens: 0,
    compressionCallTokens: 0,
    compressionCallCost: 0,
    // E27: compression quality metrics
    lowQualityCompressions: 0,
};
function stateFor(sessionID) {
    // C18: monotonic recency tick (not wall clock) — every access strictly
    // increases, so ties are impossible and tests are deterministic.
    const now = ++seenClock;
    let st = sessions.get(sessionID);
    if (st) {
        st.lastSeen = now;
        return st;
    }
    // C18 (was C7): evict the least-recently-used session, not the
    // first-inserted one, so active sessions survive eviction pressure.
    // The victim's epoch/decisions are flushed first, making eviction lossless.
    if (sessions.size >= 512) {
        let stalestKey;
        let stalestAt = Infinity;
        for (const [key, entry] of sessions) {
            if (entry.lastSeen < stalestAt) {
                stalestAt = entry.lastSeen;
                stalestKey = key;
            }
        }
        if (stalestKey !== undefined) {
            const evicted = sessions.get(stalestKey);
            if (evicted)
                flushEpoch(stalestKey, evicted);
            sessions.delete(stalestKey);
            // CP-4: the model-key hint must die with its session or the map
            // grows without bound across sessions.
            sessionModelKey.delete(stalestKey);
        }
    }
    st = {
        epoch: 0,
        lastSeen: now,
        loadedEpoch: false,
        decisions: new Map(),
        summaries: new Map(),
        loadedSummaries: false,
        pendingEstimate: 0,
        lastUsageTotal: null,
        ratio: calibration.get(modelKeyHint(sessionID)) ?? 1,
        requestCount: 0,
        replanCount: 0,
        window: null,
        budget: null,
        target: null,
        inputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        compressible: [],
        summariesCount: 0,
        summarySavedTokens: 0,
        savedTokensTotal: 0,
        inputCost: 0,
        cacheReadPrice: 0,
        cacheWritePrice: 0,
        lastGate: 0,
        lastReplan: null,
        lastReplanShort: 0,
        autoSummarizeCalls: 0,
        autoSummarizing: false,
        recoveryTarget: null,
        overflowRetries: 0,
        modelRef: "",
        recall: new Map(),
        loadedRecall: false,
        recallDirty: false,
        lastNudgeRequest: -1000,
        iterationsSinceCompress: 0,
        lastToolCallTotal: 0,
        lastInputTotal: null,
        lastCacheReadTotal: null,
        lastCacheWriteTotal: null,
        nudges: 0,
        textProtectedFrom: -1,
        turnProtectedFrom: -1,
        collapseSpans: 0,
        collapseMessages: 0,
        collapseSavedTokens: 0,
        compressionStack: [],
        compressionCallTokens: 0,
        compressionCallCost: 0,
        lowQualityCompressions: 0,
        pendingNotes: [],
    };
    sessions.set(sessionID, st);
    // C18: epoch/decisions reload lazily (fire-and-forget, like summaries) —
    // a restarted or evicted session resumes its epoch instead of repruning.
    loadEpochInto(sessionID, st);
    return st;
}
const MAX_EPOCH_DECISIONS = 200;
let seenClock = 0;
let epochStore = null;
function sanitizeDecision(raw) {
    if (!isPlainObject(raw) || typeof raw.key !== "string")
        return null;
    return {
        key: raw.key,
        reason: typeof raw.reason === "string" ? raw.reason : "",
        origChars: num(raw.origChars),
        savedChars: num(raw.savedChars),
        savedTokens: num(raw.savedTokens),
    };
}
function sanitizeEpochSnapshot(raw) {
    if (!isPlainObject(raw))
        return undefined;
    const epoch = num(raw.epoch);
    const decisions = Array.isArray(raw.decisions)
        ? raw.decisions.map(sanitizeDecision).filter((d) => d !== null).slice(-MAX_EPOCH_DECISIONS)
        : [];
    return { epoch: Number.isFinite(epoch) ? Math.max(0, Math.floor(epoch)) : 0, decisions };
}
function flushEpoch(sessionID, st) {
    if (!epochStore)
        return;
    try {
        epochStore.save(sessionID, {
            epoch: st.epoch,
            decisions: [...st.decisions.values()].slice(-MAX_EPOCH_DECISIONS),
        });
    }
    catch {
        /* ignore — epoch persistence is best-effort */
    }
}
function loadEpochInto(sessionID, st) {
    if (!epochStore || st.loadedEpoch)
        return;
    st.loadedEpoch = true;
    void epochStore
        .load(sessionID)
        .then((snap) => {
        try {
            if (!snap || sessions.get(sessionID) !== st)
                return;
            const clean = sanitizeEpochSnapshot(snap);
            if (!clean)
                return;
            // CP-14: MONOTONIC. A load can land after this session already advanced
            // (or re-created) its epoch — an evicted-and-recreated session writes 0
            // to the store, an in-memory session has moved to N. Taking the max
            // means a late or stale snapshot can never rewind the epoch, which is
            // what keeps the cache-stability contract (a lower epoch re-prunes a
            // prefix that was already rewritten).
            st.epoch = Math.max(st.epoch, clean.epoch);
            // CP-14: union, never replace — decisions learned since the snapshot
            // stay in force.
            for (const d of clean.decisions)
                if (!st.decisions.has(d.key))
                    st.decisions.set(d.key, d);
        }
        catch {
            /* ignore */
        }
    })
        .catch(() => { });
}
/** Test seam for C18 (session-state bounds + epoch persistence). */
export const __test__ = {
    stateFor,
    sessionCount: () => sessions.size,
    hasSession: (sessionID) => sessions.has(sessionID),
    resetSessions: () => {
        sessions.clear();
        sessionModelKey.clear();
    },
    setEpochStore: (store) => {
        epochStore = store;
    },
    sanitizeLabel,
    summaryCacheKey,
    digestOwners,
    // CP-1..CP-11 verification seams.
    resolveConfig,
    globalConfigDirs,
    configCandidatePaths,
    guardedSet,
    guardedRemove,
    valueToText,
    statelessTest,
    compilePatterns,
    isProtected,
    writeUnit,
    cloneForRequest,
    budgetFor,
    makeStub,
    stubMemoSize: () => stubMemo.size,
    clearStubMemo: () => {
        stubMemo.clear();
    },
    setModelKey: (sid, key) => {
        sessionModelKey.set(sid, key);
    },
    hasModelKey: (sid) => sessionModelKey.has(sid),
    latestTopic,
    topicLedger,
    // CP-1 verification seams: the voluntary turn ring vs. the mandatory live
    // turn guard.
    protectedFromIndex,
    liveTurnIndex,
    // E30/E37: export/import/comparison seams for tests and tooling.
    exportSessionState,
    importSessionState,
    renderComparison,
    // E25/E26/E35/E38/E39/E40: new config-driven seams.
    summaryPrompt,
    estimateTokens,
    minCharsFor,
    evictRecall,
    renderStats,
};
/**
 * CP-8: how far the undo stack reaches back, and how much of each folded unit it
 * keeps. Six compressions is well more than a turn issues, and 4 KB per unit is
 * enough for undo to restore something useful while bounding the stack at a few
 * hundred KB instead of a full second copy of the session's output.
 */
const COMPRESSION_STACK_MAX = 6;
const COMPRESSION_PREVIEW_CHARS = 4000;
/** Push one applied compression onto the session's bounded undo stack. */
function pushCompressionEntry(st, covers, originalTexts) {
    let truncated = false;
    const previews = new Map();
    for (const [key, text] of originalTexts) {
        if (text.length > COMPRESSION_PREVIEW_CHARS) {
            truncated = true;
            previews.set(key, `${text.slice(0, COMPRESSION_PREVIEW_CHARS)}\n\n[context-pruner] undo preview truncated at ${COMPRESSION_PREVIEW_CHARS} of ${text.length} chars`);
        }
        else {
            previews.set(key, text);
        }
    }
    st.compressionStack.push({ covers, originalTexts: previews, truncated });
    // Oldest entry goes first: undo only ever pops the newest, so dropping the
    // deepest history is the least useful thing to lose.
    while (st.compressionStack.length > COMPRESSION_STACK_MAX)
        st.compressionStack.shift();
}
/**
 * E34: Undo the last compression applied to a session.
 * Pops the compression stack and restores original texts.
 * @returns true if a compression was undone, false if the stack was empty.
 */
function undoLastCompression(sessionID) {
    const st = sessions.get(sessionID);
    if (!st)
        return { undone: false, truncated: false };
    const entry = st.compressionStack.pop();
    if (!entry)
        return { undone: false, truncated: false };
    // Restore original texts (CP-8: previews, capped at write time).
    for (const [key, text] of entry.originalTexts) {
        const unit = st.compressible.find((r) => r.key === key);
        if (unit) {
            unit.text = text;
        }
    }
    // Remove the summary record
    const record = st.summaries.get(entry.covers[0]);
    if (record) {
        st.summaries.delete(entry.covers[0]);
    }
    // Restore decisions
    for (const key of entry.covers) {
        // Decisions are not restored — they were deleted during compression
        // and would need to be re-derived from the original text
    }
    return { undone: true, truncated: entry.truncated === true };
}
/** Calibration is keyed per model string when the context hook has seen one. */
function modelKeyHint(sessionID) {
    return sessionModelKey.get(sessionID) ?? "";
}
function modelKey(model, ref) {
    if (model?.providerID && model?.id)
        return `${model.providerID}/${model.id}`;
    const pid = ref?.providerID ?? ref?.provider;
    const id = ref?.modelID ?? ref?.id ?? ref?.model;
    if (typeof pid === "string" && typeof id === "string")
        return `${pid}/${id}`;
    return "";
}
function coveredKeys(st) {
    const set = new Set();
    for (const record of st.summaries.values())
        for (const key of record.covers)
            set.add(key);
    return set;
}
function summarySavings(results, st, cfg, ratio, sharedByKey) {
    let saved = 0;
    let applied = 0;
    let tokens = 0;
    const byKey = sharedByKey ?? new Map(results.map((r) => [r.key, r]));
    for (const record of st.summaries.values()) {
        const present = record.covers.filter((key) => byKey.has(key));
        if (present.length === 0)
            continue;
        const orig = present.reduce((sum, key) => sum + (byKey.get(key)?.tokens ?? 0), 0);
        const sumTokens = estimateTokens(record.text, cfg, ratio);
        saved += Math.max(0, orig - sumTokens);
        applied += present.length;
        tokens += sumTokens;
    }
    return { saved, applied, tokens };
}
// ----------------------------------------------------------------------------
// planner
function planDecisions(results, candidates, cfg, ratio, budget, debug) {
    const decisions = new Map();
    const add = (r, reason) => {
        const existing = decisions.get(r.key);
        if (existing)
            return existing;
        const { savedChars, savedTokens } = makeStub(r, reason, cfg, ratio);
        const d = { key: r.key, reason, origChars: r.text.length, savedChars, savedTokens };
        decisions.set(r.key, d);
        return d;
    };
    const autoPrune = !cfg.manualMode.enabled || cfg.manualMode.automaticStrategies;
    // E40 / CP-5: custom compression strategies. The strategy result used to be
    // captured in a local named `decisions`, shadowing the outer map, and the
    // merge guard tested the map it was iterating — always false — so custom
    // strategies ran and their output was discarded. Merge into the OUTER map.
    if (cfg.customStrategies && cfg.customStrategies.length > 0) {
        for (const strategy of cfg.customStrategies) {
            try {
                const provided = strategy.apply(results, candidates, cfg);
                for (const [key, d] of provided) {
                    if (decisions.has(key) || !d || typeof d.key !== "string")
                        continue;
                    decisions.set(key, { ...d, key });
                }
            }
            catch (err) {
                // Custom strategy failures must not break the built-in strategies.
                debug?.(`custom strategy ${strategy.id} failed: ${String(err)}`);
            }
        }
    }
    if (autoPrune && cfg.superseded) {
        const candidateKeys = new Set(candidates.map((c) => c.key));
        const newestByPath = new Map();
        for (let i = results.length - 1; i >= 0; i--) {
            const r = results[i];
            // C4: an errored read is not an authority — never let it supersede a
            // good earlier read of the same path.
            if (r.error)
                continue;
            const path = filePathOf(r);
            const key = path ? pathKey(path) : "";
            if (key && !newestByPath.has(key))
                newestByPath.set(key, i);
        }
        for (let i = 0; i < results.length; i++) {
            const path = filePathOf(results[i]);
            if (!path || !candidateKeys.has(results[i].key))
                continue;
            const newest = newestByPath.get(pathKey(path));
            if (newest !== undefined && newest > i)
                add(results[i], `superseded by a newer read/write of ${path}`);
        }
    }
    if (autoPrune && cfg.dedupe) {
        const candidateKeys = new Set(candidates.map((c) => c.key));
        // Two outputs are duplicates when the same tool returned the same text.
        const newestByHash = new Map();
        for (let i = results.length - 1; i >= 0; i--) {
            const r = results[i];
            if (r.kind !== "tool")
                continue;
            const h = hash32(`${r.name}\u0000${r.text}`);
            if (!newestByHash.has(h)) {
                newestByHash.set(h, r.key);
                continue;
            }
            if (candidateKeys.has(r.key))
                add(r, "duplicate of newer output");
        }
    }
    if (autoPrune && cfg.dedupe) {
        const candidateKeys = new Set(candidates.map((c) => c.key));
        // Same tool + same normalised arguments, newest call wins (DCP's
        // `deduplication` strategy). Unlike exact-text dedupe this also drops a
        // re-read whose output changed.
        const newestBySignature = new Map();
        for (let i = results.length - 1; i >= 0; i--) {
            const r = results[i];
            // C4: an errored call is not an authority over an earlier good read.
            if (r.error)
                continue;
            const signature = toolSignature(r);
            if (!signature || newestBySignature.has(signature))
                continue;
            newestBySignature.set(signature, i);
        }
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.kind !== "tool" || !candidateKeys.has(r.key))
                continue;
            const signature = toolSignature(r);
            const newest = signature ? newestBySignature.get(signature) : undefined;
            if (newest !== undefined && newest > i)
                add(r, `superseded by a newer ${r.name} call with the same arguments`);
        }
    }
    if (autoPrune && cfg.purgeErrors && !cfg.keepErrors) {
        for (const r of candidates)
            if (r.error)
                add(r, "stale error output");
    }
    const remaining = candidates.filter((r) => !decisions.has(r.key)).sort((a, b) => b.tokens - a.tokens);
    if (!autoPrune)
        return decisions;
    if (budget) {
        // Over budget, the pool may reach below the voluntary floor: small stale
        // outputs are still worth dropping when the window is tight.
        const pool = (budget.pool ?? candidates)
            .filter((r) => !decisions.has(r.key))
            .sort((a, b) => b.tokens - a.tokens);
        let projected = budget.overhead;
        for (const r of results)
            projected += r.tokens;
        for (const d of decisions.values())
            projected -= d.savedTokens;
        // CP-17: an applied summary already shed tokens the raw `results[].tokens`
        // sum still counts. Ignoring them inflated the projection, so the loop kept
        // stubbing units it did not need to (over-prune) against a steady target.
        projected -= Math.max(0, budget.summarySaved ?? 0);
        for (const r of pool) {
            if (projected <= budget.target)
                break;
            const d = add(r, "over budget");
            projected -= d.savedTokens;
        }
    }
    else {
        for (const r of remaining)
            add(r, "stale tool output");
    }
    return decisions;
}
function applyDecisions(results, decisions, cfg, ratio, covered, st) {
    let count = 0;
    let savedChars = 0;
    let savedTokens = 0;
    for (const r of results) {
        const d = decisions.get(r.key);
        if (!d)
            continue;
        // CP-10: `stubbed` marks a unit THIS request already stubbed; `r.text` is
        // still the original output, so only a stub that arrived in the transcript
        // itself (`isPrunedStub`) disqualifies a unit from being stubbed again.
        if (covered.has(r.key) || r.stubbed === true || isPrunedStub(r.text))
            continue;
        const recall = rememberOutput(st, r, cfg);
        const { stub, savedChars: sc, savedTokens: stk } = makeStub(r, d.reason, cfg, ratio, recall);
        // A pruned result is always rewritten as text-with-array-value so the
        // model request can send it (core maps over result.value as an array).
        writeUnit(r, stub);
        // CP-10: the same unit must not be stubbed twice within ONE request — the
        // auto-stub path (`maybeAutoSummarize`) and the hook's own plan both call
        // this, and a second pass rewrote the part with a different reason, so
        // totals.pruned / savedTokens / the receipt counted the saving twice.
        //
        // That is tracked with a per-unit flag rather than by rewriting `r.text`:
        // `st.compressible` (the very array iterated here) survives until the next
        // request, and the manual `compress` tool reads the units' text afterwards
        // to build the digest source. Mutating the shared text made a unit stubbed
        // by an earlier pass look already-pruned, so it silently dropped out of the
        // compress range (and `coverHashes`/`pruneStaleSummaries` hashed stub text
        // instead of the source it summarises, which made the fresh record look
        // stale on the very next request). The units are rebuilt by
        // `collectResults` on every request, so the flag is exactly per-request.
        r.stubbed = true;
        d.savedChars = sc;
        d.savedTokens = stk;
        count++;
        savedChars += sc;
        savedTokens += stk;
    }
    return { count, savedChars, savedTokens };
}
/**
 * Whole-span collapse — the outgoing-request equivalent of a model-driven range
 * compression, derived locally and for free.
 *
 * Stubbing rewrites a value but leaves every part on the wire: the message
 * shell, the per-unit JSON scaffolding, the sibling `tool-call` with its
 * arguments, and a pointer for each folded unit. Once a closed run of messages
 * is *fully represented* in an applied summary (a digest or one of its
 * pointers), the run can be reduced to the digest parts it already carries and
 * the rest of the run dropped — including the tool-call parts. That structural
 * residual is exactly the "on-disk ceiling" measured in
 * `docs/CONTEXT-COMPILER-ONDISK.md`, recovered here with no disk write at all.
 *
 * Safety rules, all conservative:
 *  - the live turn (`turnProtectedFrom`) is never touched;
 *  - every part of a run must be represented by a summary (or, with
 *    `collapseStubs`, by a stub); an uncovered error, a small stale output,
 *    unsummarised prose or an unknown part type blocks the whole run;
 *  - a tool-call and its result are dropped together or kept together, so
 *    invariant #2 holds and no request loses a result it still references;
 *  - protected tools, ignored tools and protected file patterns are never
 *    dropped, and every failure path leaves the array exactly as it was.
 */
function collapseSpans(messages, results, st, cfg, ratio) {
    const none = { spans: 0, messages: 0, parts: 0, savedChars: 0, savedTokens: 0 };
    if (!cfg.collapseRanges || messages.length === 0)
        return none;
    const live = st.turnProtectedFrom;
    const unitAt = new Map();
    for (const r of results)
        unitAt.set(`${r.mi}:${r.pi}`, r);
    const callOwner = new Map();
    const resultOwner = new Map();
    for (let mi = 0; mi < messages.length; mi++) {
        const content = messages[mi]?.content;
        if (!Array.isArray(content))
            continue;
        for (const part of content) {
            const id = part?.id ?? part?.toolCallId;
            if (!id)
                continue;
            if (part.type === "tool-call")
                callOwner.set(String(id), mi);
            else if (isToolResult(part))
                resultOwner.set(String(id), mi);
        }
    }
    /**
     * How a part stands on the wire right now: `digest` (a summary body, which
     * must survive), `pointer` (a unit folded into a digest), `stub` (retained
     * head plus recall hint), or `raw` (untouched — nothing stands in for it, so
     * it blocks its run).
     */
    const statusOf = (mi, pi, part) => {
        const unit = unitAt.get(`${mi}:${pi}`);
        if (!unit)
            return "raw";
        if (unit.kind === "tool" && isProtected(unit, cfg))
            return "raw";
        const text = unit.kind === "text" ? String(part.text ?? "") : resultText(part.result);
        if (text.startsWith(SUMMARY_MARK) || text.startsWith(PROSE_SUMMARY_MARK))
            return "digest";
        if (text.startsWith(POINTER_MARK))
            return "pointer";
        if (isPrunedStub(text))
            return "stub";
        return "raw";
    };
    const represented = (status) => status === "digest" || status === "pointer" || (cfg.collapseStubs && status === "stub");
    /** The single part a tool message carries, when it carries exactly one. */
    const answerAt = (index) => {
        const content = messages[index]?.content;
        if (!Array.isArray(content) || content.length !== 1)
            return undefined;
        return content[0] ?? undefined;
    };
    // A message is reducible when every part in it is represented. A tool-call
    // counts only when the result answering it is represented too, so the pair is
    // always removed as a unit.
    const reducible = new Array(messages.length).fill(false);
    for (let mi = 0; mi < messages.length; mi++) {
        if (live >= 0 && mi >= live)
            continue;
        const content = messages[mi]?.content;
        if (!Array.isArray(content) || content.length === 0)
            continue;
        let ok = true;
        for (let pi = 0; pi < content.length && ok; pi++) {
            const part = content[pi] ?? {};
            if (part.type === "tool-call") {
                const id = part.id ?? part.toolCallId;
                const answerMi = id ? resultOwner.get(String(id)) : undefined;
                const answer = answerMi === undefined ? undefined : answerAt(answerMi);
                if (answerMi === undefined || !answer || !represented(statusOf(answerMi, 0, answer)))
                    ok = false;
                continue;
            }
            if (isToolResult(part)) {
                if (!represented(statusOf(mi, pi, part)))
                    ok = false;
                continue;
            }
            if (part.type === "text") {
                if (!represented(statusOf(mi, pi, part)))
                    ok = false;
                continue;
            }
            ok = false; // unknown part type: never dropped blind
        }
        if (ok)
            reducible[mi] = true;
    }
    // Maximal consecutive runs, pairing-checked before anything is removed.
    const planned = new Map();
    let spans = 0;
    let droppedMessages = 0;
    let droppedParts = 0;
    let index = 0;
    while (index < messages.length) {
        if (!reducible[index]) {
            index++;
            continue;
        }
        let end = index;
        while (end + 1 < messages.length && reducible[end + 1])
            end++;
        const inRun = (at) => at >= index && at <= end;
        let safe = true;
        let anchors = 0;
        const keep = new Map();
        for (let at = index; at <= end && safe; at++) {
            const content = messages[at]?.content ?? [];
            for (let pi = 0; pi < content.length; pi++) {
                const part = content[pi] ?? {};
                const id = part.id ?? part.toolCallId;
                if (part.type === "tool-call") {
                    const answerMi = id ? resultOwner.get(String(id)) : undefined;
                    // A call whose result stays outside the run cannot leave alone.
                    if (answerMi === undefined || !inRun(answerMi)) {
                        safe = false;
                        break;
                    }
                    // Keep the call only when it anchors a digest that survives.
                    const answer = answerAt(answerMi);
                    if (answer && statusOf(answerMi, 0, answer) === "digest") {
                        anchors++;
                        keep.set(at, (keep.get(at) ?? new Set()).add(pi));
                    }
                    continue;
                }
                // A result whose call stays outside the run cannot be removed alone.
                if (isToolResult(part)) {
                    const callMi = id ? callOwner.get(String(id)) : undefined;
                    if (callMi !== undefined && !inRun(callMi)) {
                        safe = false;
                        break;
                    }
                }
                if (statusOf(at, pi, part) === "digest") {
                    anchors++;
                    keep.set(at, (keep.get(at) ?? new Set()).add(pi));
                }
            }
        }
        // Skip runs that fail the pairing check, or that carry no digest at all:
        // something the model can read must survive from the span. A run that would
        // keep every part is skipped too, so the counters only report real removals.
        let partsInRun = 0;
        let partsKept = 0;
        for (let at = index; at <= end; at++) {
            partsInRun += (messages[at]?.content ?? []).length;
            partsKept += keep.get(at)?.size ?? 0;
        }
        if (!safe || anchors === 0 || partsKept >= partsInRun) {
            index = end + 1;
            continue;
        }
        spans++;
        for (let at = index; at <= end; at++) {
            const size = (messages[at]?.content ?? []).length;
            const kept = keep.get(at)?.size ?? 0;
            if (kept === 0)
                droppedMessages++;
            else
                droppedParts += Math.max(0, size - kept);
            planned.set(at, keep.get(at) ?? new Set());
        }
        index = end + 1;
    }
    if (spans === 0)
        return none;
    // Measure the request as it stands, then rewrite it in place.
    let before = 0;
    try {
        before = JSON.stringify(messages).length;
    }
    catch {
        return none; // unserialisable payload: leave the request exactly as it is
    }
    for (const [at, keep] of planned) {
        const content = messages[at]?.content;
        if (!Array.isArray(content) || keep.size === 0)
            continue;
        const kept = [];
        for (let pi = 0; pi < content.length; pi++)
            if (keep.has(pi))
                kept.push(content[pi]);
        content.length = 0;
        content.push(...kept);
    }
    // The context hook is in-place, so truncate and refill — the same pattern the
    // host and every mutating plugin use — and every holder sees the compiled
    // request. The transcript on disk is never involved.
    const survivors = [];
    for (let at = 0; at < messages.length; at++) {
        const keep = planned.get(at);
        if (keep === undefined || keep.size > 0)
            survivors.push(messages[at]);
    }
    messages.length = 0;
    messages.push(...survivors);
    let after = before;
    try {
        after = JSON.stringify(messages).length;
    }
    catch {
        after = before;
    }
    const savedChars = Math.max(0, before - after);
    return {
        spans,
        messages: droppedMessages,
        parts: droppedParts,
        savedChars,
        savedTokens: estimateCharsTokens(savedChars, cfg, ratio),
    };
}
function pointerFor(r, cfg) {
    const locale = cfg.locale ?? "en";
    if (r.kind === "text")
        return `${POINTER_MARK} (was ${r.name}, ${r.text.length} chars).`;
    return `${POINTER_MARK} (was "${r.name}", ${r.text.length} chars). ${t("rerunTool", locale)}`;
}
/**
 * Drop summaries whose covered results were edited since the summary was
 * written: the model must not read a stale digest of changed output.
 */
function pruneStaleSummaries(st, byKey) {
    let dropped = 0;
    for (const [key, record] of [...st.summaries]) {
        if (!Array.isArray(record.hashes) || record.hashes.length !== record.covers.length)
            continue;
        for (let i = 0; i < record.covers.length; i++) {
            const r = byKey.get(record.covers[i]);
            if (!r)
                continue;
            const h = record.hashes[i];
            if (Number.isFinite(h) && h !== hash32(r.text)) {
                st.summaries.delete(key);
                dropped++;
                break;
            }
        }
    }
    return dropped;
}
function applySummaries(results, st, cfg, sharedByKey) {
    const byKey = sharedByKey ?? new Map(results.map((r) => [r.key, r]));
    let applied = 0;
    for (const record of st.summaries.values()) {
        const present = record.covers.map((key) => byKey.get(key)).filter((r) => Boolean(r));
        if (present.length === 0)
            continue;
        writeUnit(present[0], record.text);
        for (let i = 1; i < present.length; i++) {
            writeUnit(present[i], pointerFor(present[i], cfg));
        }
        applied += present.length;
    }
    return applied;
}
/**
 * One pass over the results applying summary records first and stubs second.
 * Semantically identical to applySummaries + applyDecisions run in that order:
 * a key in a summary record is covered, so applyDecisions would skip it anyway;
 * a stub only touches keys that no record claims.
 */
function applySummariesAndDecisions(results, st, decisions, cfg, ratio, covered, sharedByKey) {
    const byKey = sharedByKey;
    const summaryWrites = new Map();
    let summaryApplied = 0;
    for (const record of st.summaries.values()) {
        const present = record.covers.map((key) => byKey.get(key)).filter((r) => Boolean(r));
        if (present.length === 0)
            continue;
        summaryApplied += present.length;
        summaryWrites.set(present[0].key, record.text);
        for (let i = 1; i < present.length; i++) {
            summaryWrites.set(present[i].key, pointerFor(present[i], cfg));
        }
    }
    let count = 0;
    let savedChars = 0;
    let savedTokens = 0;
    for (const r of results) {
        const summaryText = summaryWrites.get(r.key);
        if (summaryText !== undefined) {
            writeUnit(r, summaryText);
            continue;
        }
        const d = decisions.get(r.key);
        if (!d)
            continue;
        if (covered.has(r.key) || r.stubbed === true || isPrunedStub(r.text))
            continue;
        const recall = rememberOutput(st, r, cfg);
        const stub = makeStub(r, d.reason, cfg, ratio, recall);
        writeUnit(r, stub.stub);
        r.stubbed = true;
        d.savedChars = stub.savedChars;
        d.savedTokens = stub.savedTokens;
        count++;
        savedChars += stub.savedChars;
        savedTokens += stub.savedTokens;
    }
    return { summaryApplied, applied: { count, savedChars, savedTokens } };
}
function sentTokens(byKey, rawTotal, overhead, decisions, summarySaved) {
    // Same arithmetic as scanning every result, but O(decisions): each decision
    // shaves its unit's tokens (floored at zero) off the cached raw total.
    let total = overhead + rawTotal - summarySaved;
    for (const d of decisions.values()) {
        const r = byKey.get(d.key);
        if (!r)
            continue;
        total += Math.max(0, r.tokens - d.savedTokens) - r.tokens;
    }
    return Math.max(0, total);
}
// ----------------------------------------------------------------------------
// summarisation
function extractProtected(text) {
    const blocks = [];
    const stripped = text.replace(/<protect>([\s\S]*?)<\/protect>/g, (_match, inner) => {
        blocks.push(inner);
        // C10: a fixed NUL sentinel could collide with real content — a stable,
        // distinctive marker also keeps the summary cache key deterministic.
        return `[context-pruner protected #${blocks.length}]`;
    });
    return { stripped, blocks };
}
/**
 * C19: topic/reason are caller-controlled free text that used to flow raw
 * into the summarizer prompt (prompt injection: "ignore previous
 * instructions", fake <material>/<protect> blocks, role prefixes) and into
 * the summary cache key (cache fragmentation from whitespace/case/junk
 * variants). Sanitize once; use the clean value for both prompt and key.
 */
const MAX_LABEL_CHARS = 200;
function sanitizeLabel(raw) {
    let s = typeof raw === "string" ? raw : "";
    s = s.replace(/[\0-\b\f-\x1f\x7f]+/g, " "); // control chars (keep \t\n for now)
    s = s.replace(/<[^>\n]{0,64}>/g, " "); // tag-like framing: <material>, <protect>, <system>, ...
    s = s.replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|directives?|rules?)\b/gi, " ");
    s = s.replace(/\byou\s+are\s+now\b/gi, " ");
    s = s.replace(/^\s*(system|assistant|user)\s*:\s*/gim, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > MAX_LABEL_CHARS)
        s = s.slice(0, MAX_LABEL_CHARS).trimEnd();
    return s;
}
/** Cap for banked receipt fragments (each is one short clause). */
const MAX_PENDING_NOTES = 4;
/**
 * Bank a receipt fragment for the next turn's single digest. Out-of-turn
 * completions (async auto-summarise, compress tool, checkpoint) report here
 * so they never emit a second receipt line for a request.
 */
function bankNote(st, note) {
    const text = note.replace(/\s+/g, " ").trim();
    if (!text)
        return;
    st.pendingNotes.push(text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text);
    while (st.pendingNotes.length > MAX_PENDING_NOTES)
        st.pendingNotes.shift();
}
/** Most recently created summary topic ("": none). Receipts reuse it. */
function latestTopic(st) {
    let topic = "";
    let at = -Infinity;
    for (const rec of st.summaries.values()) {
        if (rec.topic && rec.at >= at) {
            at = rec.at;
            topic = rec.topic;
        }
    }
    return topic;
}
function summaryCacheKey(topic, source) {
    return `summary:${hash32(`${VERSION}\0${sanitizeLabel(topic)}\0${source}`)}`;
}
/**
 * CP-18: sessions a digest cache entry belongs to. Entries written since this
 * field existed carry `sessions`; older entries do not and are reclaimed by the
 * count cap instead (never by session deletion). Only real session ids count, so
 * the `"unknown"` fallback can never make an entry look attributable.
 */
function digestOwners(value) {
    if (!isPlainObject(value))
        return [];
    const raw = value.sessions;
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        const sid = typeof item === "string" ? item : "";
        if (/^ses/.test(sid) && !out.includes(sid))
            out.push(sid);
    }
    return out;
}
function summaryPrompt(source, topic, reason, protectedBlocks, cfg, toolName) {
    const focus = topic || "the conversation so far";
    // E25: use custom template if provided
    if (cfg?.summaryPromptTemplate) {
        return cfg.summaryPromptTemplate
            .replace(/\{source\}/g, source)
            .replace(/\{topic\}/g, focus)
            .replace(/\{reason\}/g, reason || "context limit")
            .replace(/\{protectedBlocks\}/g, protectedBlocks.map((b) => `<protect>${b}</protect>`).join("\n"));
    }
    // E26: per-tool prompt hint
    const hint = toolName && cfg?.toolStrategies?.[toolName]?.promptHint
        ? `\n\nAdditional guidance for ${toolName}: ${cfg.toolStrategies[toolName].promptHint}`
        : "";
    return [
        "You compress part of a coding-agent conversation so it fits in a smaller context window.",
        "Rewrite the material as a dense, factual summary another coding agent can act on.",
        "Keep: file paths, symbol names, commands run, exact values, error messages, and decisions.",
        "Drop: boilerplate, repeated output, and prose that adds no facts.",
        "Do not invent details and do not add commentary. Output only the summary.",
        "",
        `Focus: ${focus}`,
        `Reason: ${reason || "context limit"}`,
        "",
        "<material>",
        source,
        "</material>",
        protectedBlocks.length > 0 ? "\n\nPreserve these protected excerpts verbatim at the end:" : "",
        ...protectedBlocks.map((b) => `<protect>${b}</protect>`),
    ]
        .filter(Boolean)
        .join("\n") + hint;
}
/**
 * Deterministic digest used when the summariser model cannot be reached: the
 * head of every covered unit plus a pointer, so nothing is lost silently.
 */
function fallbackSummary(units, cfg) {
    const locale = cfg.locale ?? "en";
    const parts = units.map((r) => `- ${r.name} (~${r.tokens} tokens): ${r.text.slice(0, 200).replace(/\s+/g, " ").trim()}`);
    return [t("summaryUnavailable", locale) + ":", ...parts].join("\n");
}
function buildSummaryText(summaryBody, protectedBlocks, prose = false, filePaths, cfg) {
    const mark = prose ? PROSE_SUMMARY_MARK : SUMMARY_MARK;
    const locale = cfg?.locale ?? "en";
    const fileLine = filePaths && filePaths.length ? `${t("compressedFiles", locale)}: ${filePaths.join(", ")}. ` : "";
    const blocks = protectedBlocks.map((b) => `<protect>${b}</protect>`).join("\n");
    return `${mark} ${fileLine}${summaryBody.trim()}${blocks ? `\n\n${blocks}` : ""}`;
}
// ----------------------------------------------------------------------------
// reporting
function renderStats(cfg) {
    const grossSavings = totals.savedTokens + totals.summarySavedTokens;
    const netSavings = grossSavings - totals.compressionCallTokens;
    const locale = cfg.locale ?? "en";
    return [
        t("statsTitle", locale),
        "",
        `${t("requestsCompiled", locale)}: ${totals.requests}`,
        `${t("toolResultsPruned", locale)}: ${totals.pruned}`,
        `${t("stubbedBelowFloor", locale)}: ${totals.stubbed} (~${totals.stubSavedTokens} tokens)`,
        `${t("summariesGenerated", locale)}: ${totals.summaries} (model calls: ${totals.generations})`,
        `${t("charactersSaved", locale)}: ${totals.savedChars}`,
        `${t("estimatedTokensSaved", locale)}: ${grossSavings}`,
        `  · ${t("pruning", locale)}: ${totals.savedTokens}`,
        `  · ${t("summaries", locale)}: ${totals.summarySavedTokens}`,
        `  · ${t("ofPruningTotal", locale)}: ${totals.stubSavedTokens}`,
        `${t("compressionCost", locale)}: ${totals.compressionCallTokens} tokens ($${totals.compressionCallCost.toFixed(4)})`,
        `${t("netSavings", locale)}: ${netSavings} tokens`,
        `${t("lowQualityCompressions", locale)}: ${totals.lowQualityCompressions}`,
        `${t("nudgesSent", locale)}: ${totals.nudgeCount}`,
        `${t("trackedSessions", locale)}: ${sessions.size}`,
    ].join("\n");
}
/** Per-token value of a pruned token: fresh input, or the premium over a cache read. */
function effectiveInputPrice(st) {
    if (st.cacheRead > 0 && st.cacheReadPrice > 0)
        return Math.max(0, st.inputCost - st.cacheReadPrice);
    return st.inputCost;
}
/** Per-topic savings ledger: display-only rollup of the tracked summary records. */
function topicLedger(st, cfg) {
    if (st.summaries.size === 0)
        return [];
    const byKey = new Map(st.compressible.map((r) => [r.key, r]));
    const groups = new Map();
    for (const record of st.summaries.values()) {
        const topic = record.topic || "(general)";
        let group = groups.get(topic);
        if (!group) {
            group = { topic, summaries: 0, units: 0, saved: 0 };
            groups.set(topic, group);
        }
        group.summaries++;
        group.units += record.covers.length;
        const present = record.covers.map((key) => byKey.get(key)).filter((r) => r !== undefined);
        const original = present.reduce((sum, r) => sum + r.tokens, 0);
        group.saved += Math.max(0, original - estimateTokens(record.text, cfg, st.ratio));
    }
    return [...groups.values()].sort((a, b) => b.saved - a.saved);
}
function renderReport(sessionID, cfg) {
    const st = sessionID ? sessions.get(sessionID) : undefined;
    const locale = cfg.locale ?? "en";
    const lines = [t("reportTitle", locale), ""];
    if (!st) {
        lines.push(t("noRequestCompiled", locale));
        lines.push(`${t("trackedSessions", locale)}: ${sessions.size}`);
        return lines.join("\n");
    }
    const hitRatio = st.inputTokens + st.cacheRead > 0 ? st.cacheRead / (st.inputTokens + st.cacheRead) : 0;
    const window = st.window ?? limitTokens(cfg.maxContextLimit, 0) ?? "unknown";
    lines.push(`${t("requestsCompiled", locale)}: ${st.requestCount}`);
    lines.push(`${t("epoch", locale)}: ${st.epoch} (replans: ${st.replanCount})`);
    lines.push(`${t("window", locale)}: ${window}  budget: ${st.budget ?? "n/a"}  target: ${st.target ?? "n/a"}`);
    lines.push(`${t("modelRef", locale)}: ${st.modelRef || "(none)"}  models cached: ${modelCacheSize}`);
    lines.push(`${t("checkpoints", locale)}: ${totals.checkpoints}  overflow recoveries: ${totals.overflowRecoveries}  recalls: ${totals.recalls}`);
    lines.push(`${t("retryState", locale)}: recover target ${st.recoveryTarget ?? "n/a"}  attempts ${st.overflowRetries}`);
    lines.push(`${t("calibrationRatio", locale)}: ${st.ratio.toFixed(3)}  cache hit: ${(hitRatio * 100).toFixed(1)}%`);
    if (st.inputCost > 0) {
        const effective = effectiveInputPrice(st);
        const basis = st.cacheRead > 0 && st.cacheReadPrice > 0 ? "input − cache read" : "input tokens";
        lines.push(`${t("estimatedCostSaved", locale)}: $${(st.savedTokensTotal * effective).toFixed(4)} (at $${(effective * 1_000_000).toFixed(2)}/M ${basis})`);
        if (st.cacheRead > 0 && st.cacheReadPrice > 0 && st.inputCost > st.cacheReadPrice) {
            lines.push(`${t("cacheSavings", locale)}: $${(st.cacheRead * (st.inputCost - st.cacheReadPrice)).toFixed(4)} (${st.cacheRead} cached tokens vs input price)`);
        }
    }
    if (st.compressionCallTokens > 0 || st.compressionCallCost > 0) {
        lines.push(`${t("compressionCost", locale)}: ${st.compressionCallTokens} tokens ($${st.compressionCallCost.toFixed(4)})`);
        const netTokens = st.savedTokensTotal - st.compressionCallTokens;
        lines.push(`${t("netSavings", locale)}: ${netTokens} tokens`);
    }
    lines.push(`${t("promptTokens", locale)}: ${st.inputTokens}  cache read: ${st.cacheRead}  cache write: ${st.cacheWrite}`);
    if (st.cacheRead > 0 || st.cacheWrite > 0) {
        const short = st.lastReplan === "deferred" && st.lastReplanShort > 0 ? ` (short ${Math.ceil(st.lastReplanShort)})` : "";
        lines.push(`${t("cacheEconomics", locale)}: ${cfg.cacheAware ? "on" : "off"}  replan gate: ${st.lastGate} tok  last replan: ${st.lastReplan ?? "n/a"}${short}`);
    }
    lines.push(`${t("activePruneDecisions", locale)}: ${st.decisions.size}`);
    const proseSummaries = [...st.summaries.values()].filter((r) => r.prose).length;
    lines.push(`${t("activeSummaries", locale)}: ${st.summaries.size} (covering ${coveredKeys(st).size} units, ~${st.summarySavedTokens} tokens saved${proseSummaries ? `, ${proseSummaries} prose` : ""})`);
    const ledger = topicLedger(st, cfg);
    if (ledger.length > 0) {
        lines.push(t("savingsByTopic", locale) + ":");
        for (const row of ledger) {
            lines.push(`  · ${row.topic} — ${row.summaries} summaries, ${row.units} units, ~${row.saved} tokens saved`);
        }
    }
    lines.push(`${t("nudgesSent", locale)}: ${st.nudges}  tool calls since last summary: ${st.iterationsSinceCompress}`);
    lines.push(`${t("spanCollapse", locale)}: ${cfg.collapseRanges ? "on" : "off"}${cfg.collapseStubs ? "+stubs" : ""}  last request: ${st.collapseSpans} span(s), ${st.collapseMessages} message(s), ~${st.collapseSavedTokens} tokens`);
    lines.push(`${t("mode", locale)}: ${cfg.manualMode.enabled ? "manual" : "automatic"}  turnProtection: ${cfg.turnProtection.enabled ? `${cfg.turnProtection.turns} turns` : "off"}`);
    lines.push(`${t("hooks", locale)}: compaction=${cfg.compactionCheckpoint ? "on" : "off"} retry=${cfg.retryOnOverflow ? "on" : "off"} title=${cfg.titleShortCircuit ? "on" : "off"} recall=${cfg.recall ? "on" : "off"}`);
    if (cfg.configPath)
        lines.push(`${t("configFile", locale)}: ${cfg.configPath}`);
    if (st.decisions.size > 0) {
        for (const d of st.decisions.values()) {
            lines.push(`  · ${d.key} — ${d.reason} (~${d.savedTokens} tokens)`);
        }
    }
    lines.push("");
    lines.push(renderStats(cfg));
    return lines.join("\n");
}
function renderContextMap(st, cfg, limit = 50) {
    const list = st.compressible;
    const locale = cfg.locale ?? "en";
    if (list.length === 0)
        return t("noCompressibleContext", locale);
    const textProtected = protectedTextKeys(list, st, cfg);
    const lines = [t("contextMapTitle", locale) + ":"];
    // C11: the map is embedded in nudges — an unbounded listing would eat the
    // very context it is trying to save.
    const shown = list.slice(0, Math.max(1, limit));
    shown.forEach((r, index) => {
        const protectedFlag = isProtected(r, cfg) || textProtected.has(r.key) ? ` [${t("protectedMarker", locale)}]` : "";
        const preview = r.text.slice(0, 80).replace(/\s+/g, " ");
        lines.push(`#${index + 1} ${r.name} ~${r.tokens} tokens${protectedFlag} — ${preview}`);
    });
    if (list.length > shown.length) {
        lines.push(`${t("contextMapMore", locale)} ${list.length - shown.length} more (call context_map for the full list).`);
    }
    lines.push("");
    lines.push(t("contextMapCallCompress", locale));
    return lines.join("\n");
}
// ----------------------------------------------------------------------------
// E30: session state export/import
function exportSessionState(sessionID) {
    const st = sessions.get(sessionID);
    if (!st)
        return JSON.stringify({ error: "session not found" });
    const decisions = Array.from(st.decisions.values());
    const summaries = Array.from(st.summaries.values());
    const recall = Array.from(st.recall.entries()).map(([id, entry]) => ({ id, ...entry }));
    return JSON.stringify({
        version: 1,
        sessionID,
        epoch: st.epoch,
        decisions,
        summaries,
        recall,
        inputTokens: st.inputTokens,
        cacheRead: st.cacheRead,
        cacheWrite: st.cacheWrite,
        savedTokensTotal: st.savedTokensTotal,
        summarySavedTokens: st.summarySavedTokens,
        compressionCallTokens: st.compressionCallTokens,
        compressionCallCost: st.compressionCallCost,
        lowQualityCompressions: st.lowQualityCompressions,
        nudges: st.nudges,
        requestCount: st.requestCount,
        replanCount: st.replanCount,
        iterationsSinceCompress: st.iterationsSinceCompress,
        lastToolCallTotal: st.lastToolCallTotal,
        textProtectedFrom: st.textProtectedFrom,
        turnProtectedFrom: st.turnProtectedFrom,
        collapseSpans: st.collapseSpans,
        collapseMessages: st.collapseMessages,
        collapseSavedTokens: st.collapseSavedTokens,
    });
}
function importSessionState(sessionID, json) {
    try {
        const data = JSON.parse(json);
        if (!isPlainObject(data))
            return false;
        let st = sessions.get(sessionID);
        if (!st) {
            st = stateFor(sessionID);
        }
        if (typeof data.epoch === "number")
            st.epoch = data.epoch;
        if (Array.isArray(data.decisions)) {
            for (const d of data.decisions) {
                if (isPlainObject(d) && typeof d.key === "string") {
                    st.decisions.set(d.key, d);
                }
            }
        }
        if (Array.isArray(data.summaries)) {
            for (const s of data.summaries) {
                if (isPlainObject(s) && typeof s.first === "string") {
                    st.summaries.set(s.first, s);
                }
            }
        }
        if (Array.isArray(data.recall)) {
            for (const r of data.recall) {
                if (isPlainObject(r) && typeof r.id === "string") {
                    st.recall.set(r.id, r);
                }
            }
        }
        if (typeof data.inputTokens === "number")
            st.inputTokens = data.inputTokens;
        if (typeof data.cacheRead === "number")
            st.cacheRead = data.cacheRead;
        if (typeof data.cacheWrite === "number")
            st.cacheWrite = data.cacheWrite;
        if (typeof data.savedTokensTotal === "number")
            st.savedTokensTotal = data.savedTokensTotal;
        if (typeof data.summarySavedTokens === "number")
            st.summarySavedTokens = data.summarySavedTokens;
        if (typeof data.compressionCallTokens === "number")
            st.compressionCallTokens = data.compressionCallTokens;
        if (typeof data.compressionCallCost === "number")
            st.compressionCallCost = data.compressionCallCost;
        if (typeof data.lowQualityCompressions === "number")
            st.lowQualityCompressions = data.lowQualityCompressions;
        if (typeof data.nudges === "number")
            st.nudges = data.nudges;
        if (typeof data.requestCount === "number")
            st.requestCount = data.requestCount;
        if (typeof data.replanCount === "number")
            st.replanCount = data.replanCount;
        if (typeof data.iterationsSinceCompress === "number")
            st.iterationsSinceCompress = data.iterationsSinceCompress;
        if (typeof data.lastToolCallTotal === "number")
            st.lastToolCallTotal = data.lastToolCallTotal;
        if (typeof data.textProtectedFrom === "number")
            st.textProtectedFrom = data.textProtectedFrom;
        if (typeof data.turnProtectedFrom === "number")
            st.turnProtectedFrom = data.turnProtectedFrom;
        if (typeof data.collapseSpans === "number")
            st.collapseSpans = data.collapseSpans;
        if (typeof data.collapseMessages === "number")
            st.collapseMessages = data.collapseMessages;
        if (typeof data.collapseSavedTokens === "number")
            st.collapseSavedTokens = data.collapseSavedTokens;
        return true;
    }
    catch {
        return false;
    }
}
// ----------------------------------------------------------------------------
// E37: session comparison
function renderComparison(sessionIDs, cfg) {
    const locale = cfg.locale ?? "en";
    const lines = [t("comparisonTitle", locale), ""];
    if (sessionIDs.length === 0) {
        lines.push(t("noSessionsSpecified", locale));
        return lines.join("\n");
    }
    const rows = [];
    for (const sid of sessionIDs) {
        const st = sessions.get(sid);
        if (!st) {
            rows.push({ sessionID: sid, exists: false, epoch: 0, decisions: 0, summaries: 0, savedTokens: 0, inputTokens: 0, compressionCallTokens: 0, lowQualityCompressions: 0, nudges: 0, requestCount: 0 });
        }
        else {
            rows.push({
                sessionID: sid,
                exists: true,
                epoch: st.epoch,
                decisions: st.decisions.size,
                summaries: st.summaries.size,
                savedTokens: st.savedTokensTotal,
                inputTokens: st.inputTokens,
                compressionCallTokens: st.compressionCallTokens,
                lowQualityCompressions: st.lowQualityCompressions,
                nudges: st.nudges,
                requestCount: st.requestCount,
            });
        }
    }
    // Header
    lines.push(`${"session".padEnd(24)} ${"epoch".padStart(6)} ${"decisions".padStart(10)} ${"summaries".padStart(10)} ${"savedTokens".padStart(12)} ${"inputTokens".padStart(12)} ${"compTokens".padStart(12)} ${"lowQual".padStart(8)} ${"nudges".padStart(7)} ${"requests".padStart(9)}`);
    lines.push("-".repeat(120));
    for (const r of rows) {
        if (!r.exists) {
            lines.push(`${r.sessionID.slice(0, 24).padEnd(24)} (${t("sessionNotFound", locale)})`);
        }
        else {
            lines.push(`${r.sessionID.slice(0, 24).padEnd(24)} ${String(r.epoch).padStart(6)} ${String(r.decisions).padStart(10)} ${String(r.summaries).padStart(10)} ${String(r.savedTokens).padStart(12)} ${String(r.inputTokens).padStart(12)} ${String(r.compressionCallTokens).padStart(12)} ${String(r.lowQualityCompressions).padStart(8)} ${String(r.nudges).padStart(7)} ${String(r.requestCount).padStart(9)}`);
        }
    }
    return lines.join("\n");
}
// ----------------------------------------------------------------------------
// plugin
export default Plugin.define({
    id: "context-pruner",
    async setup(ctx) {
        const c = ctx;
        let cfg = resolveConfig(c.location?.directory, c.options);
        if (!cfg.enabled) {
            // Keep the plugin file loadable for easy re-enabling, but do not register
            // any hooks, tools, or background work while explicitly disabled.
            return async () => { };
        }
        refreshModels(c);
        const disposers = [];
        const track = (registration) => {
            if (registration && typeof registration.dispose === "function") {
                disposers.push(() => registration.dispose());
            }
            else if (typeof registration === "function") {
                disposers.push(registration);
            }
        };
        const log = (message) => {
            if (!cfg.log && !cfg.debug)
                return;
            try {
                console.error(`[context-pruner] ${message}`);
            }
            catch {
                /* ignore */
            }
        };
        const debug = (message) => {
            if (!cfg.debug)
                return;
            try {
                // CP-16: same directory the config is read from. `homedir()` missed the
                // XDG config root and every portable/XDG install, and a `logs/` path
                // that was never cleaned grew without bound.
                const root = globalConfigDirs()[0];
                if (!root)
                    return;
                const dir = join(root, "logs", "context-pruner");
                mkdirSync(dir, { recursive: true });
                appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${message}\n`);
                pruneDebugLogs(dir);
            }
            catch {
                /* ignore */
            }
        };
        /**
         * CP-15: a pruning failure used to go only to `debug()`, which is off by
         * default — a session could lose every byte of its epoch, recall and summary
         * state and the user would never see why. The hook still never throws (that
         * would break the session), but the failure is now reported through `log()`
         * — i.e. printed even when `log` is off, since this is exactly the case the
         * user needs it for — at most once per category per session so a broken
         * store cannot spam stderr on every request. The count is kept so a later
         * report can say how many were suppressed.
         */
        const failureCounts = new Map();
        const reportFailure = (category, err, sessionID) => {
            const key = `${category}|${sessionID ?? ""}`;
            const seen = (failureCounts.get(key) ?? 0) + 1;
            failureCounts.set(key, seen);
            // Every failure also lands in the debug log, whatever the reporting says.
            debug(`[${category}] ${String(err)}`);
            if (failureCounts.size > 256) {
                const oldest = failureCounts.keys().next();
                if (!oldest.done)
                    failureCounts.delete(oldest.value);
            }
            const scope = sessionID ? `${category} (${sessionID})` : category;
            if (seen === 1) {
                try {
                    console.error(`[context-pruner] ${scope} failed: ${String(err)}`);
                }
                catch {
                    /* ignore */
                }
                return;
            }
            // Report again on a widening powers-of-two cadence (2, 4, 8, …).
            if ((seen & (seen - 1)) === 0) {
                try {
                    console.error(`[context-pruner] ${scope} failed ${seen}x, last: ${String(err)}`);
                }
                catch {
                    /* ignore */
                }
            }
        };
        /**
         * CP-20: claim a digest cache entry for one session as an OWNER, keeping
         * every owner already recorded. The same content hashes to the same key in
         * two sessions (a fork, two agents reading the same file), and the old
         * blind `sessions: [sessionID]` write REPLACED the list: when the session
         * written first was deleted, `purgeOrphanDigests` saw a single dead owner and
         * reclaimed a digest a live session was still using.
         *
         * The claim is also skipped when this session is already an owner, which
         * keeps a cache-hit path free of writes (write volume drives `gcStorage`).
         */
        const claimDigest = async (key, text, topic, owner) => {
            const existing = await readStore(key, "digest");
            const owners = digestOwners(existing);
            if (isPlainObject(existing) && typeof existing.text === "string" && existing.text && owners.includes(owner))
                return;
            const previous = isPlainObject(existing) ? existing : undefined;
            const merged = [...owners, ...(owner ? [owner] : [])].filter((sid, i, all) => sid && all.indexOf(sid) === i);
            writeStore(key, {
                text: previous && typeof previous.text === "string" && previous.text ? previous.text : text,
                topic: topic || (previous && typeof previous.topic === "string" ? previous.topic : ""),
                version: VERSION,
                at: Date.now(),
                sessions: merged,
            });
        };
        // Config hot reload: opencode only re-reads a plugin when its file changes,
        // so watch the config files and re-resolve in place when one is edited.
        let reloadTimer;
        const reloadConfig = () => {
            reloadTimer = undefined;
            try {
                cfg = resolveConfig(c.location?.directory, c.options);
                log("config reloaded");
                debug(`config reloaded from ${cfg.configPath ?? "(defaults)"}`);
            }
            catch (err) {
                debug(`config reload failed: ${String(err)}`);
            }
        };
        const scheduleReload = () => {
            if (reloadTimer)
                clearTimeout(reloadTimer);
            reloadTimer = setTimeout(reloadConfig, 250);
        };
        const watchedConfigs = [];
        for (const configPath of configCandidatePaths(c.location?.directory)) {
            if (!existsSync(configPath))
                continue;
            try {
                watchFile(configPath, { interval: 1000 }, scheduleReload);
                watchedConfigs.push({ path: configPath, listener: scheduleReload });
            }
            catch {
                /* ignore */
            }
        }
        const readStore = async (key, context, sessionID) => {
            try {
                const value = c.storage?.get ? await c.storage.get(key) : undefined;
                return value;
            }
            catch (err) {
                // CP-15: a failed read means the plugin silently forgets state it
                // should have restored (epoch, recall, summaries, digests). Report.
                const split = key.indexOf(":");
                reportFailure(`store read ${context ?? (split > 0 ? key.slice(0, split) : "store")}`, err, sessionID);
                return undefined;
            }
        };
        /**
         * CP-14: read-modify-write helper. `set` is a blind overwrite, and one key
         * genuinely has more than one writer (an evicted-then-recreated session
         * state, a fork, a second opencode process on the same store), so every
         * durable write re-reads first and merges into whatever the store holds.
         */
        const mergeStore = (key, merge, context, sessionID) => {
            void Promise.resolve(readStore(key, context, sessionID))
                .then((existing) => writeStore(key, merge(existing)))
                .catch((err) => reportFailure(`store merge ${context ?? "state"}`, err, sessionID));
        };
        /** CP-16/17: page through every entry under a prefix (bounded, best-effort). */
        const scanStore = async (prefix) => {
            const scan = c.storage?.scan;
            if (typeof scan !== "function")
                return [];
            const out = [];
            let after;
            // Bounded so a looping scan can never spin forever at startup.
            for (let page = 0; page < 1000; page++) {
                const res = await scan({ prefix, after });
                const entries = Array.isArray(res?.entries) ? res.entries : [];
                for (const entry of entries) {
                    const key = String(entry?.key ?? "");
                    if (key)
                        out.push({ key, value: entry?.value });
                }
                if (!res?.next)
                    break;
                after = res.next;
            }
            return out;
        };
        let writesSinceGc = 0;
        /**
         * CP-17: bound the non-session caches. `summary:<hash>` digests and
         * `calibration:<model>` ratios have no delete event, so they are capped by
         * count. Best-effort: never throws into its caller.
         *
         * CP-26: eviction is ownership-aware. Sorting purely oldest-first meant a
         * live session's digests -- which are by definition among the *oldest*
         * entries, having been written earlier in the session -- were the first to
         * go once the cap was reached, so the cache lost exactly the entries still
         * in use and the next compress re-spent a `session.generate` call to rebuild
         * them. Unreferenced entries are now evicted first (oldest first); live
         * ones are only touched if the cap cannot be met any other way.
         *
         * "In use" means "CP-18 already found a live owner for it", which needs no
         * extra probing: `sweepOrphanedState` runs `purgeOrphanDigests` immediately
         * before this at startup, so an entry that still lists an owner has already
         * survived the liveness check. Only untagged/legacy entries -- the ones no
         * session can ever claim -- are evictable ahead of the live ones. Testing
         * the in-memory `sessions` map instead would be useless here: it is empty
         * in a fresh process, which is exactly when the sweep runs.
         *
         * The cap is deliberately a SOFT bound. It is driven by a write counter, not
         * by the size of the namespace (which would mean a full scan per write), so
         * the real guarantee is "cap, plus at most one batch of writes before the
         * next sweep" -- measured at 332 against a cap of 256 while driving 376
         * models. A hard bound would need a scan per write. `verify-pruner-gc.mjs`
         * pins the soft bound rather than the nominal one.
         */
        const gcStorage = async () => {
            if (!cfg.storageGc)
                return;
            const cap = async (prefix, max, at, isOurs, inUse) => {
                if (max <= 0)
                    return;
                // Shape guard: even if the host ever returned keys outside our
                // namespace, GC must only ever remove entries this plugin wrote.
                const entries = (await scanStore(prefix)).filter((e) => isOurs(e.value));
                if (entries.length <= max)
                    return;
                // 0 = evictable, 1 = still in use: unreferenced entries sort ahead, and
                // within each band the oldest goes first.
                entries.sort((a, b) => (inUse(a.key, a.value) ? 1 : 0) - (inUse(b.key, b.value) ? 1 : 0) ||
                    at(a.value) - at(b.value) ||
                    a.key.localeCompare(b.key));
                for (const entry of entries.slice(0, entries.length - max))
                    guardedRemove(c.storage, entry.key);
            };
            await cap("summary:", cfg.summaryCacheMax, (v) => num(v?.at), (v) => isPlainObject(v) && typeof v.text === "string", 
            // Reached only after CP-18 has already reclaimed dead-owned digests, so
            // "has an owner" means "has a live owner".
            (_key, v) => digestOwners(v).length > 0);
            // A ratio is in use while any session this process still tracks runs that
            // model. `sessionModelKey` is keyed by session id with the model key as
            // the value, so test the values, not the keys.
            const liveModelKeys = new Set(sessionModelKey.values());
            await cap("calibration:", cfg.calibrationMax, (v) => num(v?.updatedAt), (v) => isPlainObject(v) && typeof v.r === "number", (key) => liveModelKeys.has(key.slice("calibration:".length)));
        };
        // CP-1: storage writes are best-effort — a rejecting store must never
        // surface as an unhandled rejection.
        const writeStore = (key, value) => {
            // CP-15: a failed write loses the plugin's own durable state (epoch,
            // recall, summaries, digest cache, calibration) — report it, do not
            // swallow it whole. The key's namespace scopes the suppression counter.
            const split = key.indexOf(":");
            const namespace = split > 0 ? key.slice(0, split) : "store";
            const owner = split > 0 && (namespace === "epoch" || namespace === "recall" || namespace === "summaries") ? key.slice(split + 1) : undefined;
            guardedSet(c.storage, key, value, (err) => reportFailure(`store write ${namespace}`, err, owner));
            // CP-17: keep the bounded caches bounded during a long-lived process, not
            // just at startup. Reclaim at most once per batch of writes.
            if (cfg.storageGc && (key.startsWith("summary:") || key.startsWith("calibration:"))) {
                if (++writesSinceGc >= 100) {
                    writesSinceGc = 0;
                    void gcStorage().catch(() => {
                        /* ignore */
                    });
                }
            }
        };
        // CP-2: per-session persist chain — serializes recall read-modify-write
        // so overlapping flushes cannot clobber each other.
        const persistChains = new Map();
        // CP-16: every key context-pruner keeps for one session. Deleting a session
        // must drop all of them, or they linger for the life of the profile.
        const SESSION_KEYS = (sid) => [`epoch:${sid}`, `recall:${sid}`, `summaries:${sid}`];
        /**
         * CP-16: forget everything about one session. Called when the host reports
         * `session.deleted` and by the startup sweep; best-effort so a bad store
         * cannot break the caller.
         */
        const forgetSession = (sessionID) => {
            if (!sessionID)
                return;
            sessions.delete(sessionID);
            sessionModelKey.delete(sessionID);
            persistChains.delete(sessionID);
            for (const key of SESSION_KEYS(sessionID))
                guardedRemove(c.storage, key);
        };
        /**
         * CP-18/CP-13: cached liveness probe. Session deletion can happen while
         * opencode is closed (no event), so both passes probe `session.get`.
         *
         * CP-13: a probe FAILURE is not a NOT-FOUND. `session.get` throws for plenty
         * of transient reasons (server still starting, a network blip, a rate
         * limit), and counting that as "gone" deleted the epoch/recall/summaries
         * keys — and every digest they owned — of a perfectly live session, which
         * is far more destructive than holding a cache entry. The probe is therefore
         * tri-state: `true` alive, `false` definitively not found, `null` unknown
         * (never cached, so the next sweep re-probes). Only `false` reclaims.
         */
        const sessionDomain = c.session;
        // CP-19: a long-lived server probes thousands of sessions; this map is a
        // cache, so it is bounded (FIFO) instead of growing for the process's life.
        const ALIVE_CACHE_MAX = 512;
        const aliveCache = new Map();
        /**
         * CP-13: classify a failed `session.get`. opencode reports a missing session
         * by THROWING (NotFoundError / a 404), so "it threw" cannot simply mean
         * "transient" — the sweep would never reclaim anything. But the same call
         * also throws while the server is still starting or when a request fails.
         * Only an error that positively says not-found is definitive.
         */
        const isNotFoundFailure = (err) => {
            const rec = (err ?? {});
            const status = num(rec.status ?? rec.statusCode, 0);
            if (status === 404 || status === 410)
                return true;
            const text = `${String(rec.name ?? "")} ${String(rec.message ?? "")} ${String(err?.message ?? "")} ${String(err ?? "")}`.toLowerCase();
            return /(not\s*found|no such|does not exist|unknown session|invalid session)/.test(text);
        };
        const isAlive = async (sid) => {
            const cached = aliveCache.get(sid);
            if (cached !== undefined)
                return cached;
            if (typeof sessionDomain?.get !== "function")
                return null;
            let alive;
            try {
                const info = await sessionDomain.get({ sessionID: sid });
                // A missing session object (or one without an id) is the host's
                // definitive "not found"; a throw is only definitive when it says so.
                alive = Boolean(info && info.id) ? true : false;
            }
            catch (err) {
                alive = isNotFoundFailure(err) ? false : null;
            }
            if (alive === null)
                return null;
            if (aliveCache.size >= ALIVE_CACHE_MAX) {
                const oldest = aliveCache.keys().next();
                if (!oldest.done)
                    aliveCache.delete(oldest.value);
            }
            aliveCache.set(sid, alive);
            return alive;
        };
        /**
         * CP-18: reclaim digest-cache entries whose owning sessions are all gone.
         * Entries shared by a live session survive; untagged legacy entries are
         * left to the count-based GC (CP-17). CP-13: an owner whose probe failed is
         * unknown, not gone, and keeps the digest.
         */
        const purgeOrphanDigests = async () => {
            if (typeof sessionDomain?.get !== "function")
                return;
            for (const entry of await scanStore("summary:")) {
                const owners = digestOwners(entry.value);
                if (owners.length === 0)
                    continue;
                let anyAlive = false;
                let anyUnknown = false;
                for (const sid of owners) {
                    const alive = await isAlive(sid);
                    if (alive === true) {
                        anyAlive = true;
                        break;
                    }
                    if (alive === null)
                        anyUnknown = true;
                }
                if (anyAlive || anyUnknown)
                    continue;
                debug(`reclaimed digest ${entry.key} (sessions: ${owners.join(", ")})`);
                guardedRemove(c.storage, entry.key);
            }
        };
        /**
         * CP-16/18: drop session keys whose session no longer exists, then any
         * digests left with no live owner. Runs once at setup so deletions that
         * happened while opencode was closed are reclaimed too (the
         * `session.deleted` event has no replay).
         */
        const sweepOrphanedState = async () => {
            if (typeof sessionDomain?.get !== "function")
                return;
            const seen = new Set();
            for (const prefix of ["epoch:", "recall:", "summaries:"]) {
                for (const entry of await scanStore(prefix)) {
                    const sid = entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : "";
                    if (sid)
                        seen.add(sid);
                }
            }
            for (const sid of seen) {
                // CP-13: only a definitive not-found reclaims; an unknown probe is
                // retried on the next sweep rather than deleting a live session's state.
                if ((await isAlive(sid)) === false) {
                    debug(`reclaimed orphaned state for deleted session ${sid}`);
                    forgetSession(sid);
                }
            }
            await purgeOrphanDigests();
        };
        // CP-8: memoize the per-request JSON.stringify(event.tools).
        let lastToolsRef;
        let lastToolsJson = "{}";
        const notify = (sessionID, summaryLine, detail) => {
            if (cfg.notify === "off")
                return;
            // E29: custom notification hook
            if (cfg.notifyHook) {
                try {
                    cfg.notifyHook(sessionID, summaryLine, detail);
                }
                catch {
                    /* ignore */
                }
                return;
            }
            // E39: localize the notification prefix
            const locale = cfg.locale ?? "en";
            // Minimal stays a single line; detailed is that line plus the detail.
            const text = cfg.notify === "minimal" ? summaryLine : `${summaryLine}\n${detail}`;
            if (cfg.notifyType === "chat") {
                try {
                    // CP-1: guarded so a rejecting session sink cannot escape.
                    Promise.resolve(c.session?.synthetic?.({ sessionID, text: `[context-pruner] ${text}`, description: "context-pruner", delivery: "queue" })).catch(() => {
                        /* ignore */
                    });
                }
                catch {
                    /* ignore */
                }
            }
            else {
                try {
                    console.error(`[context-pruner] ${text}`);
                }
                catch {
                    /* ignore */
                }
            }
        };
        /** Parse a stored `summaries:<sid>` array into records (CP-14: shared by
         * the loader and the merge-on-write path). */
        const parseSummaryEntries = (raw) => {
            const out = [];
            if (!Array.isArray(raw))
                return out;
            for (const entry of raw) {
                if (!isPlainObject(entry))
                    continue;
                const covers = asList(entry.covers);
                const text = typeof entry.text === "string" ? entry.text : "";
                if (covers.length === 0 || !text)
                    continue;
                out.push({
                    first: covers[0],
                    covers,
                    hashes: Array.isArray(entry.hashes) ? entry.hashes.map((h) => num(h)) : [],
                    text,
                    tokens: num(entry.tokens),
                    topic: typeof entry.topic === "string" ? entry.topic : "",
                    at: num(entry.at),
                    // CP-6 classification must survive the round trip: the merge-on-write
                    // path below rebuilds every record through this parser, so dropping it
                    // here silently turned every reloaded prose summary into a tool
                    // summary (`context_report` stopped counting prose, and the flag the
                    // apply path branches on was gone).
                    prose: entry.prose === true,
                });
            }
            return out;
        };
        const loadSummaries = async (sessionID, st) => {
            if (st.loadedSummaries)
                return;
            st.loadedSummaries = true;
            for (const rec of parseSummaryEntries(await readStore(`summaries:${sessionID}`, "summaries", sessionID))) {
                // CP-14: union by key, newest `at` wins.
                if (!st.summaries.has(rec.first) || (st.summaries.get(rec.first)?.at ?? 0) <= rec.at)
                    st.summaries.set(rec.first, rec);
            }
        };
        // C18: epoch/decisions survive eviction and restarts through ctx.storage
        // (same best-effort pattern as summaries/recall). stateFor() flushes on
        // eviction and reloads lazily on creation via this registration.
        epochStore = {
            // CP-14: the epoch is monotonic. An evicted-then-recreated session state
            // flushes epoch 0 into a key that already holds N; a plain overwrite sent
            // the session backwards and the next request re-pruned a prefix the
            // provider had cached under the newer layout. Decisions are written as
            // this state's authoritative snapshot (compress DELETES entries on
            // purpose, so a union would resurrect stubs for units a summary already
            // replaced) — only the epoch is merged forward.
            save: (sid, snap) => mergeStore(`epoch:${sid}`, (existing) => {
                const prev = sanitizeEpochSnapshot(existing);
                return { epoch: Math.max(prev?.epoch ?? 0, snap.epoch), decisions: snap.decisions, at: Date.now() };
            }, "epoch", sid),
            load: async (sid) => sanitizeEpochSnapshot(await readStore(`epoch:${sid}`, "epoch", sid)),
        };
        /** Drop the oldest records until the session is within `summaryKeep`. */
        const trimSummaries = (st) => {
            if (cfg.summaryKeep <= 0)
                return;
            while (st.summaries.size > cfg.summaryKeep) {
                let oldestKey;
                let oldestAt = Infinity;
                for (const [key, rec] of st.summaries) {
                    if (rec.at < oldestAt) {
                        oldestAt = rec.at;
                        oldestKey = key;
                    }
                }
                if (oldestKey === undefined)
                    break;
                st.summaries.delete(oldestKey);
            }
        };
        /**
         * CP-14: merge-on-write. The old code wrote `[...st.summaries.values()]`
         * blind, so a second writer on the same key (evict-and-recreate, fork,
         * another process) had its summaries deleted by the next flush — deleting a
         * summary record loses the digest the transcript pointers refer to and the
         * next request re-spends a `session.generate` call to rebuild it. Re-read
         * inside the session's persist chain and union by key, newest `at` wins.
         *
         * The returned promise is the write itself, so an `await`ing caller (the
         * compress tool) observes the flush it just asked for. Fire-and-forget
         * callers still serialise behind the same per-session chain, so ordering —
         * which is what makes the merge correct — is unchanged.
         */
        const summaryChains = new Map();
        const persistSummaries = (sessionID, st) => {
            trimSummaries(st);
            const tail = summaryChains.get(sessionID) ?? Promise.resolve();
            const head = tail
                .then(async () => {
                const merged = new Map();
                for (const rec of parseSummaryEntries(await readStore(`summaries:${sessionID}`, "summaries", sessionID)))
                    merged.set(rec.first, rec);
                for (const rec of st.summaries.values()) {
                    const held = merged.get(rec.first);
                    if (!held || held.at <= rec.at)
                        merged.set(rec.first, rec);
                }
                let list = [...merged.values()];
                // Newest records win the cap: a reloaded record's own `at` decides its
                // rank, so a fork's older summaries are the ones evicted.
                if (cfg.summaryKeep > 0 && list.length > cfg.summaryKeep) {
                    list = list.sort((a, b) => a.at - b.at).slice(-cfg.summaryKeep);
                }
                writeStore(`summaries:${sessionID}`, list);
            })
                .catch((err) => {
                reportFailure("persist summaries", err, sessionID);
            });
            summaryChains.set(sessionID, head);
            if (summaryChains.size > 20) {
                const first = summaryChains.keys().next().value;
                if (first !== undefined && first !== sessionID)
                    summaryChains.delete(first);
            }
            void head.then(() => {
                if (summaryChains.get(sessionID) === head)
                    summaryChains.delete(sessionID);
            }).catch(() => { });
            return head;
        };
        /** Parse a stored `recall:<sid>` array into entries (CP-14: shared by the
         * loader and the merge-on-write path). */
        const parseRecallEntries = (raw) => {
            const out = [];
            if (!Array.isArray(raw))
                return out;
            for (const entry of raw) {
                if (!isPlainObject(entry))
                    continue;
                const id = typeof entry.id === "string" ? entry.id : "";
                const text = typeof entry.text === "string" ? entry.text : "";
                if (!id || !text)
                    continue;
                out.push({
                    id,
                    entry: {
                        tool: typeof entry.tool === "string" ? entry.tool : "",
                        text,
                        chars: num(entry.chars, text.length),
                        at: num(entry.at),
                        hits: num(entry.hits),
                        ...(typeof entry.priority === "number" ? { priority: num(entry.priority) } : {}),
                    },
                });
            }
            return out;
        };
        /** CP-14: union parsed entries into the session map, newest `at` wins. */
        const mergeRecallEntries = (st, parsed) => {
            for (const { id, entry } of parsed) {
                const held = st.recall.get(id);
                if (!held || held.at <= entry.at)
                    st.recall.set(id, entry);
            }
        };
        const loadRecall = async (sessionID, st) => {
            if (st.loadedRecall)
                return;
            st.loadedRecall = true;
            mergeRecallEntries(st, parseRecallEntries(await readStore(`recall:${sessionID}`, "recall", sessionID)));
            evictRecall(st, cfg.recallKeep, cfg.evictionPolicy);
        };
        /**
         * Flush newly pruned outputs. CP-14: this is a genuine read-modify-write —
         * `st.recall` only holds what this process remembered, so writing it blind
         * deleted entries another writer (or this session before an eviction) had
         * stored, and a lost entry is output the model can no longer recall without
         * re-running the tool. The chain already serialized this session's own
         * flushes (CP-2); it now re-reads the stored array inside the chain and
         * unions by `at` instead of relying on the load-once `loadRecall` guard —
         * which never re-read, so the "merging anything already persisted" the
         * comment promised never happened after the first load.
         */
        const persistRecall = (sessionID, st) => {
            if (!st.recallDirty)
                return;
            // CP-2: chain onto the session's pending persist so an in-flight
            // read-modify-write finishes before the next one starts.
            const tail = persistChains.get(sessionID) ?? Promise.resolve();
            const head = tail
                .then(async () => {
                mergeRecallEntries(st, parseRecallEntries(await readStore(`recall:${sessionID}`, "recall", sessionID)));
                evictRecall(st, cfg.recallKeep, cfg.evictionPolicy);
                writeStore(`recall:${sessionID}`, [...st.recall.entries()].map(([id, entry]) => ({ id, ...entry })));
                st.recallDirty = false;
            })
                .catch((err) => {
                // CP-15: report — the recall entries this flush would have stored are gone.
                reportFailure("persist recall", err, sessionID);
            });
            persistChains.set(sessionID, head);
            if (persistChains.size > 20) {
                const first = persistChains.keys().next().value;
                if (first !== undefined && first !== sessionID)
                    persistChains.delete(first);
            }
            void head.then(() => {
                if (persistChains.get(sessionID) === head)
                    persistChains.delete(sessionID);
            }).catch(() => { });
        };
        /**
         * Guaranteed token relief: when the projected request exceeds the target,
         * summarise the largest compressible results immediately instead of waiting
         * for the model to act on a nudge. Runs at most `autoSummarizeMaxCalls`
         * model calls per session (cache hits are free), covers at most
         * `maxAutoSummaries` units per request (largest first; 0 = unlimited),
         * and the summary is applied on the next request.
         * Default budget is 5 calls; 0 opts out into unlimited.
         */
        async function maybeAutoSummarize(sessionID, st, estimate, turn) {
            if (!cfg.autoSummarize || !cfg.compressEnabled || st.autoSummarizing)
                return;
            // 0 = opt-out unlimited; default 5 bounds `session.generate` spend on stuck sessions.
            if (cfg.autoSummarizeMaxCalls > 0 && st.autoSummarizeCalls >= cfg.autoSummarizeMaxCalls)
                return;
            if (st.target === null || estimate <= st.target)
                return;
            const session = c.session;
            const covered = coveredKeys(st);
            const textProtected = protectedTextKeys(st.compressible, st, cfg);
            const pool = st.compressible
                .filter((r) => !covered.has(r.key) &&
                !isProtected(r, cfg) &&
                !textProtected.has(r.key) &&
                !(st.turnProtectedFrom >= 0 && r.mi >= st.turnProtectedFrom) &&
                !isPrunedStub(r.text) &&
                // C16: prose gets a lower floor than tool output.
                r.text.length >= minCharsFor(r, cfg))
                .sort((a, b) => b.tokens - a.tokens);
            if (pool.length === 0)
                return;
            const shortfall = estimate - st.target;
            const chosen = [];
            let sum = 0;
            // Per-request cap: the pool is sorted by tokens desc, so this keeps the
            // top-N biggest wins. 0 = unlimited (no count cap).
            const cap = cfg.maxAutoSummaries > 0 ? cfg.maxAutoSummaries : pool.length;
            for (const r of pool) {
                if (chosen.length > 0 && sum >= shortfall)
                    break;
                chosen.push(r);
                sum += r.tokens;
                if (chosen.length >= cap)
                    break;
            }
            // Present the summary at the earliest covered unit so the model reads it
            // before the pointers that fold into it.
            chosen.sort((a, b) => a.mi - b.mi || a.pi - b.pi);
            // Model calls are finite; below the floor a stub is still worth more than
            // a nudge the model may ignore. Only the window passing
            // `autoSummarizeRatio` of the limit justifies the call.
            const window = st.window ?? 0;
            const critical = cfg.proactiveSummarize ||
                cfg.autoSummarizeRatio <= 0.1 ||
                (window > 0 && estimate >= Math.floor(window * cfg.autoSummarizeRatio));
            if (sum < cfg.autoSummarizeMinTokens) {
                if (cfg.autoSummarizeStub && st.pendingEstimate > st.target) {
                    const autoPlan = planDecisions(st.compressible, chosen, cfg, st.ratio, null, debug);
                    // C6: persist the ad-hoc stub decisions into the current epoch —
                    // recomputing them every request let them flip-flop and broke the
                    // byte-identical prompt prefix the provider cache relies on.
                    for (const [k, v] of autoPlan)
                        st.decisions.set(k, v);
                    flushEpoch(sessionID, st);
                    const appliedStubs = applyDecisions(st.compressible, autoPlan, cfg, st.ratio, covered, st);
                    if (appliedStubs.count > 0) {
                        const savedStubs = appliedStubs.savedTokens;
                        totals.savedTokens += savedStubs;
                        totals.stubbed += appliedStubs.count;
                        totals.stubSavedTokens += savedStubs;
                        st.savedTokensTotal += savedStubs;
                        st.iterationsSinceCompress = 0;
                        // Folded into the turn's single digest (or banked when there is
                        // no turn to attach to) — never a receipt of its own.
                        if (turn) {
                            turn.stubbed += appliedStubs.count;
                            turn.stubSaved += savedStubs;
                        }
                        else {
                            bankNote(st, `stubbed ${appliedStubs.count} result(s), ~${savedStubs} tokens saved`);
                        }
                        debug(`auto-stub applied for ${sessionID}: ${appliedStubs.count} results, ~${savedStubs} tokens`);
                    }
                }
                return;
            }
            if (!critical)
                return;
            if (typeof session?.generate !== "function")
                return;
            st.autoSummarizing = true;
            try {
                const raw = chosen.map((r) => `### ${r.name}\n${r.text}`).join("\n\n");
                // CP-10: `chosen` aliases the live `st.compressible` units, and the
                // hook's own applyDecisions runs (synchronously, after this function
                // yields at its first await) and now rewrites `r.text` to the stub it
                // sent. Snapshot the identity data the record needs while the units
                // still hold their original text — hashing stub text instead would make
                // the record look stale on the very next request, dropping the summary
                // and re-spending the model call.
                const chosenHashes = coverHashes(chosen);
                const chosenPaths = chosen.map((r) => filePathOf(r)).filter(Boolean);
                const chosenProse = chosen.every((r) => r.kind === "text");
                let blocks = [];
                let source = raw;
                if (cfg.protectTags) {
                    const extracted = extractProtected(raw);
                    source = extracted.stripped;
                    blocks = extracted.blocks;
                }
                const maxSrc = maxSourceCharsFor(chosen[0]?.name, cfg);
                if (source.length > maxSrc)
                    source = `${source.slice(0, maxSrc)}\n\n[truncated]`;
                const cacheKey = `summary:${hash32(`${VERSION}\u0000auto\u0000${source}`)}`;
                let body;
                const cached = await readStore(cacheKey, "digest");
                if (isPlainObject(cached) && typeof cached.text === "string" && cached.text)
                    body = cached.text;
                if (body) {
                    // CP-20: a hit still has to record this session as a co-owner.
                    await claimDigest(cacheKey, body, "auto", sessionID);
                }
                if (!body) {
                    // Cache misses spend the session model-call budget; cache hits are
                    // free so repeat requests covering the same units don't re-spend.
                    st.autoSummarizeCalls++;
                    if (cfg.autoSummarizeMaxCalls > 0 && st.autoSummarizeCalls > cfg.autoSummarizeMaxCalls)
                        return;
                    const prompt = summaryPrompt(source, "what future work needs", "context budget", blocks, cfg, chosen[0]?.name);
                    try {
                        // E33: try fallback model if configured and session model fails
                        if (cfg.fallbackModelId) {
                            try {
                                const response = await session.generate({ sessionID, prompt, model: cfg.fallbackModelId });
                                body = generatedText(response);
                            }
                            catch {
                                body = "";
                            }
                        }
                        if (!body) {
                            const response = await session.generate({ sessionID, prompt });
                            body = generatedText(response);
                        }
                    }
                    catch {
                        body = "";
                    }
                    // The model call may fail or return nothing (local models are flaky);
                    // fall back to a deterministic digest so the relief is still real.
                    if (!body && cfg.autoSummarizeStub)
                        body = fallbackSummary(chosen, cfg);
                    if (!body)
                        return;
                    totals.generations++;
                    // CP-20: union the owner list instead of replacing it.
                    await claimDigest(cacheKey, body, "auto", sessionID);
                }
                const text = buildSummaryText(body, blocks, chosenProse, chosenPaths, cfg);
                const tokens = estimateTokens(text, cfg, st.ratio);
                const covers = chosen.map((r) => r.key);
                for (const [key, existing] of [...st.summaries]) {
                    if (existing.covers.every((cover) => covers.includes(cover)))
                        st.summaries.delete(key);
                }
                st.summaries.set(covers[0], { first: covers[0], covers, hashes: chosenHashes, text, tokens, topic: "auto", at: Date.now(), prose: chosenProse });
                for (const key of covers)
                    st.decisions.delete(key);
                await persistSummaries(sessionID, st);
                const saved = Math.max(0, chosen.reduce((acc, r) => acc + r.tokens, 0) - tokens);
                totals.summaries++;
                totals.summarySavedTokens += saved;
                st.iterationsSinceCompress = 0;
                // Banked for the next turn's single digest: this completion lands
                // after the triggering turn already flushed its receipt.
                bankNote(st, `auto-summarised ${chosen.length} result(s), ~${saved} tokens saved`);
                debug(`auto-summarise applied for ${sessionID}: ${chosen.length} results, ~${saved} tokens`);
            }
            catch (err) {
                debug(`auto-summarise failed: ${String(err)}`);
            }
            finally {
                st.autoSummarizing = false;
            }
        }
        // ---------------------------------------------------------------- context
        if (typeof c.session?.hook === "function") {
            try {
                track(await c.session.hook("context", (event) => {
                    try {
                        if (!cfg.enabled)
                            return;
                        const sessionID = String(event.sessionID ?? "unknown");
                        const st = stateFor(sessionID);
                        const ref = event.model;
                        // C14: a cold model cache made budget resolution fail for every
                        // request until the async model list landed — refresh on first use.
                        if ((modelCaches.get(c) ?? []).length === 0)
                            refreshModels(c);
                        const model = resolveModel(c, ref);
                        st.modelRef = `${String(ref?.providerID ?? ref?.provider ?? "?")}/${String(ref?.id ?? ref?.modelID ?? "?")}`;
                        const mKey = modelKey(model, ref);
                        if (mKey && !calibration.has(mKey)) {
                            calibration.set(mKey, st.ratio);
                            try {
                                void readStore(`calibration:${mKey}`).then((value) => {
                                    const r = num(value?.r, 0);
                                    if (r > 0 && Number.isFinite(r)) {
                                        calibration.set(mKey, r);
                                        st.ratio = r;
                                    }
                                }).catch(() => {
                                    /* CP-1: ignore */
                                });
                            }
                            catch {
                                /* ignore */
                            }
                        }
                        if (mKey)
                            sessionModelKey.set(sessionID, mKey);
                        if (!st.loadedSummaries)
                            void loadSummaries(sessionID, st).catch(() => { });
                        const ratio = st.ratio;
                        const rawMessages = event.messages;
                        const messages = (Array.isArray(rawMessages) ? rawMessages : []);
                        // Detach the request from the stored transcript before any rewrite:
                        // the hook mutates in place by contract, and the host re-serialises
                        // `event.messages` after it returns. Replacing each slot with a
                        // structural clone leaves the stored messages untouched, so pruning
                        // stays request-only as promised. Array identity is preserved, which
                        // span collapse relies on when it truncates and refills `messages`.
                        for (let i = 0; i < messages.length; i++)
                            messages[i] = cloneForRequest(messages[i]);
                        const results = collectResults(messages, cfg, ratio);
                        st.compressible = results;
                        const protectTurns = Math.max(cfg.keepRecentTurns, cfg.turnProtection.enabled ? cfg.turnProtection.turns : 0);
                        st.textProtectedFrom = protectedFromIndex(messages, protectTurns);
                        // The live turn (everything at or after the NEWEST user message) is
                        // never summarised: the model needs the tool output it just
                        // received. CP-1: computed independently of the turn-protection
                        // window, so a session with a single user message still protects it.
                        st.turnProtectedFrom = liveTurnIndex(messages);
                        // Integrity: a summary whose source output changed is dropped, so its
                        // results can be summarised again (or pruned by another strategy).
                        const byKey = new Map(results.map((r) => [r.key, r]));
                        const droppedSummaries = pruneStaleSummaries(st, byKey);
                        if (droppedSummaries > 0) {
                            // The context hook is synchronous by contract: chain, do not await.
                            void persistSummaries(sessionID, st);
                            debug(`dropped ${droppedSummaries} stale summary record(s) for ${sessionID}`);
                        }
                        const covered = coveredKeys(st);
                        // CP-17: standing summary savings are computed once, before planning.
                        // Nothing between here and the reporting below changes a summary
                        // record or the raw tokens of a covered unit (applyDecisions skips
                        // covered keys), so this value also serves the receipts later.
                        const stats = summarySavings(results, st, cfg, ratio, byKey);
                        const rawTotal = results.totalTokens;
                        const scan = candidateScan(results, messages, cfg);
                        // CP-6: the E38 budget schedule is indexed by turn, so the hook has
                        // to say which turn it is — the count of user messages so far.
                        const budget = budgetFor(model, cfg, userMessageIndexes(messages).length);
                        if (budget) {
                            st.window = budget.window;
                            st.budget = budget.budget;
                            st.target = budget.target;
                        }
                        const inputPrice = num(model?.cost?.[0]?.input);
                        if (inputPrice > 0)
                            st.inputCost = inputPrice / 1_000_000;
                        const cacheReadPrice = num(model?.cost?.[0]?.cache?.read);
                        if (cacheReadPrice > 0)
                            st.cacheReadPrice = cacheReadPrice / 1_000_000;
                        const cacheWritePrice = num(model?.cost?.[0]?.cache?.write);
                        if (cacheWritePrice > 0)
                            st.cacheWritePrice = cacheWritePrice / 1_000_000;
                        // Overflow recovery: after a context-limit retry, aim well under the
                        // normal budget. The halved target persists across turns until the
                        // compiled request actually fits, then it is cleared.
                        const recovering = st.recoveryTarget !== null && st.budget !== null;
                        let effectiveTarget = recovering ? st.recoveryTarget : budget?.target ?? null;
                        // Proactive steady state: aim well under the window so closed topics
                        // are summarised before the request ever approaches the limit.
                        const steady = cfg.proactiveSummarize && cfg.steadyTargetRatio > 0 && st.window
                            ? Math.max(cfg.steadyTargetMinTokens, Math.floor(st.window * cfg.steadyTargetRatio))
                            : null;
                        if (steady !== null)
                            effectiveTarget = effectiveTarget === null ? steady : Math.min(effectiveTarget, steady);
                        if (effectiveTarget !== null)
                            st.target = effectiveTarget;
                        // CP-8: `event.tools` rarely changes between requests — reuse the
                        // last serialization when the reference is identical.
                        const eventTools = event.tools;
                        if (eventTools !== lastToolsRef) {
                            try {
                                const raw = JSON.stringify(eventTools ?? {});
                                lastToolsJson = raw.length > 50000 ? raw.slice(0, 50000) : raw;
                            }
                            catch {
                                lastToolsJson = "{}";
                            }
                            lastToolsRef = eventTools;
                        }
                        const overhead = estimateTokens(systemTextOf(event), cfg, ratio) +
                            estimateTokens(lastToolsJson, cfg, ratio) +
                            messages.length * 4;
                        const candidates = candidateResults(results, messages, cfg, covered, cfg.minChars, undefined, st.turnProtectedFrom, scan);
                        const budgetPool = budget && cfg.budgetMinChars < cfg.minChars
                            ? candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, undefined, st.turnProtectedFrom, scan)
                            : candidates;
                        const target = effectiveTarget ?? budget?.target ?? null;
                        // Over target, the recency ring-fence is the first thing to give:
                        // small stale results below the floor come next. Recent outputs are
                        // touched only when the voluntary pool cannot reach the target, and
                        // a small set of hottest outputs is always kept so the live turn
                        // never loses its most recent context entirely.
                        let desired = planDecisions(results, candidates, cfg, ratio, budget && target !== null ? { target, overhead, pool: budgetPool, summarySaved: stats.saved } : null, debug);
                        const planWith = (pool) => planDecisions(results, candidates, cfg, ratio, budget && target !== null ? { target, overhead, pool, summarySaved: stats.saved } : null, debug);
                        const projectedNow = (pool) => sentTokens(byKey, rawTotal, overhead, planWith(pool), 0);
                        if (budget && target !== null && projectedNow(budgetPool) > target) {
                            // The hottest outputs survive every relaxation stage: even when the
                            // recency ring-fence gives way, the live turn never loses its most
                            // recent context entirely. With relaxRecentFloor 0 this is a no-op.
                            const hottest = cfg.relaxRecentFloor > 0
                                ? new Set(results
                                    .filter((r) => r.kind === "tool")
                                    .slice(Math.max(0, results.length - cfg.relaxRecentFloor))
                                    .map((r) => r.key))
                                : new Set();
                            const keepHottest = (pool) => pool.filter((r) => !hottest.has(r.key));
                            const relaxed = keepHottest(candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, {
                                recent: true,
                                turns: cfg.turnProtection.enabled,
                            }, st.turnProtectedFrom, scan));
                            const relaxedPlan = planWith(relaxed);
                            if (sumSaved(relaxedPlan) > sumSaved(desired))
                                desired = relaxedPlan;
                            const deep = keepHottest(candidateResults(results, messages, cfg, covered, cfg.budgetMinChars, { recent: true, turns: true }, st.turnProtectedFrom, scan));
                            const deepPlan = planWith(deep);
                            if (sumSaved(deepPlan) > sumSaved(desired))
                                desired = deepPlan;
                        }
                        let decisions = desired;
                        const desiredSavings = sumSaved(desired);
                        const currentSavings = sumSaved(st.decisions);
                        // CP-9: the replan gate is a cache-churn question, so it is computed
                        // against the model's real `budget.target`. The proactive steady
                        // ceiling (`steadyTargetRatio`, often 6% of the window) sits far
                        // below it and used to count as "over target": the gate collapsed to
                        // zero and every request replanned the whole prefix, defeating the
                        // provider cache the gate exists to protect. The steady ceiling
                        // still drives the work itself (planDecisions/maybeAutoSummarize run
                        // against `effectiveTarget`); only the deferral decision changes.
                        const gateTarget = budget?.target ?? null;
                        const overTarget = gateTarget !== null && sentTokens(byKey, rawTotal, overhead, st.decisions, stats.saved) > gateTarget;
                        const gate = overTarget || recovering ? 0 : cacheReplanGate(st, cfg);
                        // Over budget or recovering, don't let the voluntary replan floor
                        // defer savings we need right now.
                        const threshold = overTarget || recovering ? 0 : Math.max(cfg.minReplanTokens, gate);
                        st.lastGate = Math.ceil(threshold);
                        if (st.decisions.size > 0 && !recovering && desiredSavings - currentSavings < threshold) {
                            decisions = st.decisions;
                            st.lastReplan = "deferred";
                            st.lastReplanShort = Math.max(0, threshold - (desiredSavings - currentSavings));
                            debug(`replan deferred for ${sessionID}: gate ${Math.ceil(threshold)}, short ${Math.ceil(st.lastReplanShort)}`);
                        }
                        else {
                            st.decisions = desired;
                            st.epoch++;
                            st.replanCount++;
                            flushEpoch(sessionID, st);
                            st.lastReplan = "allowed";
                            st.lastReplanShort = 0;
                        }
                        // Summarise from the raw (pre-stub) size: stubbing alone can meet a
                        // low steady target, but a digest of the stubbed units is smaller
                        // still. The record is stored now and applied on the next request.
                        const rawEstimate = Math.max(0, overhead + rawTotal);
                        // Single-digest receipts: auto-stub counts accumulate into this
                        // turn's receipt instead of notifying separately; async
                        // completions bank a note for the next turn's digest.
                        const turnAuto = { stubbed: 0, stubSaved: 0 };
                        if (!cfg.manualMode.enabled)
                            void maybeAutoSummarize(sessionID, st, rawEstimate, turnAuto).catch(() => { });
                        const { summaryApplied, applied } = applySummariesAndDecisions(results, st, decisions, cfg, ratio, covered, byKey);
                        // Whole-span collapse runs last: the digests and stubs it reads are
                        // already written, so a closed run that is fully represented loses
                        // its message shells, per-unit scaffolding and tool-call arguments.
                        const collapsed = collapseSpans(messages, results, st, cfg, ratio);
                        st.collapseSpans = collapsed.spans;
                        st.collapseMessages = collapsed.messages;
                        st.collapseSavedTokens = collapsed.savedTokens;
                        if (collapsed.spans > 0) {
                            totals.collapsedSpans += collapsed.spans;
                            totals.collapsedMessages += collapsed.messages;
                            totals.collapsedTokens += collapsed.savedTokens;
                            debug(`span collapse for ${sessionID}: ${collapsed.spans} span(s), ${collapsed.messages} message(s), ${collapsed.parts} part(s), ~${collapsed.savedTokens} tokens`);
                        }
                        persistRecall(sessionID, st);
                        st.summariesCount = st.summaries.size;
                        st.summarySavedTokens = stats.saved;
                        st.requestCount++;
                        // C3: cadence counts ACTUAL tool calls seen this request — it used
                        // to count pruned results, so nudges never fired in low-prune
                        // sessions and fired constantly in heavy ones.
                        const toolCallsNow = countToolCalls(messages);
                        st.iterationsSinceCompress += Math.max(0, toolCallsNow - st.lastToolCallTotal);
                        st.lastToolCallTotal = toolCallsNow;
                        st.pendingEstimate = Math.max(0, sentTokens(byKey, rawTotal, overhead, decisions, stats.saved) - collapsed.savedTokens);
                        if (st.recoveryTarget !== null && st.pendingEstimate <= st.recoveryTarget) {
                            st.recoveryTarget = null;
                            st.overflowRetries = 0;
                            debug(`overflow recovery complete for ${sessionID}`);
                        }
                        totals.requests++;
                        totals.pruned += applied.count;
                        totals.savedChars += applied.savedChars;
                        totals.savedTokens += applied.savedTokens;
                        // C5: standing summary savings live in summarySavedTokens (set
                        // above) — adding them here again double-counted them on every
                        // subsequent request.
                        st.savedTokensTotal += applied.savedTokens + collapsed.savedTokens;
                        // One receipt per turn: prune, stub, summary, collapse and any
                        // banked notes share a single digest through notify().
                        const banked = st.pendingNotes.length > 0 ? [...st.pendingNotes] : [];
                        if ((applied.count > 0 || summaryApplied > 0 || collapsed.spans > 0 || turnAuto.stubbed > 0 || banked.length > 0) && cfg.notify !== "off") {
                            const saved = applied.savedTokens + stats.saved + collapsed.savedTokens + turnAuto.stubSaved;
                            const sessionTotal = st.savedTokensTotal + st.summarySavedTokens;
                            const topic = latestTopic(st);
                            // Throttled receipt: meaningful saves always report; a freshly
                            // applied summary — or a banked note from an async/manual
                            // summarise or checkpoint — reports too so nothing is lost.
                            if (saved >= cfg.notifyMinTokens || (summaryApplied > 0 && cfg.notifyOnTopic) || (banked.length > 0 && cfg.notifyOnTopic)) {
                                st.pendingNotes.length = 0;
                                const locale = cfg.locale ?? "en";
                                const receipt = `${t("savedTokens", locale)} ~${saved} ${t("tokens", locale)} · ~${sessionTotal} ${t("sessionTotal", locale)}${topic ? ` · ${t("topic", locale)}: ${topic}` : ""}${banked.length > 0 ? ` · ${banked.join(" · ")}` : ""}`;
                                notify(sessionID, `${t("pruned", locale)} ${applied.count} result(s)${summaryApplied ? `, ${summaryApplied} ${t("summarised", locale)}` : ""}${turnAuto.stubbed > 0 ? `, ${turnAuto.stubbed} ${t("stubbed", locale)}` : ""}${collapsed.spans > 0 ? `, ${collapsed.messages} ${t("collapsed", locale)}` : ""} — ${receipt} (${t("epoch", locale)} ${st.epoch})`, `${t("epoch", locale)} ${st.epoch}: ${t("pruned", locale)} ${applied.count}/${results.length}, ${t("summaries", locale)} ${st.summaries.size}, ${receipt}` +
                                    (collapsed.spans > 0
                                        ? `\n  ${t("spanCollapse", locale)}: ${collapsed.spans} span(s), ${collapsed.messages} message(s), ~${collapsed.savedTokens} tokens`
                                        : "") +
                                    (applied.count > 0
                                        ? `\n  reasons: ${[...new Set([...decisions.values()].map((d) => d.reason))].join(", ")}`
                                        : ""));
                            }
                        }
                        // nudges -------------------------------------------------------
                        if (cfg.nudgeEnabled && !cfg.manualMode.enabled && cfg.compressEnabled) {
                            const window = st.window ?? limitTokens(cfg.maxContextLimit, 0) ?? 0;
                            if (window > 0) {
                                const minLimit = limitTokens(cfg.minContextLimit, window) ?? Math.floor(window * 0.5);
                                const overLimit = st.pendingEstimate >= minLimit;
                                const dueByFrequency = st.requestCount - st.lastNudgeRequest >= cfg.nudgeFrequency;
                                const dueByCalls = st.iterationsSinceCompress >= cfg.nudgeCallFrequency;
                                const dueByIterations = st.iterationsSinceCompress >= cfg.iterationNudgeThreshold;
                                // Nearly full: ask even if the cadence has not come around.
                                const critical = st.pendingEstimate >= Math.floor(window * cfg.nudgeCriticalRatio);
                                if (overLimit && (dueByFrequency || dueByCalls || dueByIterations || critical)) {
                                    st.lastNudgeRequest = st.requestCount;
                                    st.nudges++;
                                    totals.nudgeCount++;
                                    // C11: a critical nudge carries only the top entries — the
                                    // full map would itself eat the context it is trying to save.
                                    const map = renderContextMap(st, cfg, critical ? 10 : 25);
                                    const nudgeLocale = cfg.locale ?? "en";
                                    const force = cfg.nudgeForce === "strong" ? t("nudgeCritical", nudgeLocale) : t("nudgeConsider", nudgeLocale);
                                    const nudge = [
                                        `[context-pruner] ${t("nudgeContextAt", nudgeLocale)} ~${st.pendingEstimate} ${t("of", nudgeLocale)} ~${window} tokens.`,
                                        `${force} ${t("nudgeUseCompress", nudgeLocale)}`,
                                        "",
                                        map,
                                    ].join("\n");
                                    // Never inject into a reasoning turn: bank the nudge and
                                    // surface it on the next receipt instead of voice-ing it as
                                    // a synthetic turn (which strict providers reject).
                                    if (hasReasoningContent(messages)) {
                                        st.pendingNotes.push(nudge.length > 200 ? `${nudge.slice(0, 200).trimEnd()}.` : nudge);
                                        while (st.pendingNotes.length > 20)
                                            st.pendingNotes.shift();
                                    }
                                    else {
                                        try {
                                            // CP-1: guarded so a rejecting session sink cannot escape.
                                            Promise.resolve(c.session?.synthetic?.({ sessionID, text: nudge, description: "context-pruner nudge", delivery: "queue" })).catch(() => {
                                                /* ignore */
                                            });
                                        }
                                        catch {
                                            /* ignore */
                                        }
                                    }
                                    st.iterationsSinceCompress = 0;
                                }
                            }
                        }
                        if (cfg.log) {
                            log(`epoch ${st.epoch}: pruned ${applied.count}/${results.length}, summaries ${st.summaries.size}, ~${applied.savedTokens + stats.saved} tokens (sent ~${st.pendingEstimate}, target ${st.target ?? "n/a"})`);
                        }
                        // CP-19: the request is fully compiled and reported. Release the
                        // message-part references so the cloned transcript this request
                        // built can be collected; `st.compressible` keeps the scalars
                        // (name, text, tokens, file, part id) that `context_map`, `compress`
                        // and the stats tools read between requests. An auto-summarise still
                        // in flight writes nothing into these parts any more — which is the
                        // correct outcome, since the request those clones belong to has
                        // already been sent; its decisions live in `st.decisions` /
                        // `st.summaries` and are applied by the NEXT request's compile.
                        releaseCompiledUnits(results);
                    }
                    catch (err) {
                        // The hook must never throw into the host session — but CP-15: a
                        // failure here means THIS REQUEST WENT OUT UNPRUNED, which is the
                        // one failure the user has to see. reportFailure() prints through
                        // the log sink once per session and then suppresses.
                        debug(`context hook failed: ${String(err)}`);
                        const sid = String(event?.sessionID ?? "unknown");
                        reportFailure("context hook", err, sid);
                    }
                }));
            }
            catch (err) {
                // A failed registration must not take down the host session. Leave
                // context untouched and expose a safe diagnostic for debugging.
                log(`context hook registration failed; continuing without pruning: ${String(err)}`);
                debug(`context hook registration failed: ${String(err)}`);
            }
        }
        // ----------------------------------------------------------------- usage
        if (typeof c.event?.subscribe === "function") {
            const onEvent = (event) => {
                try {
                    const type = event?.type;
                    // CP-16: the host announces deletion; drop our per-session keys so
                    // nothing is left behind in the profile store.
                    if (type === "session.deleted") {
                        const deleted = String((event.data ?? {}).sessionID ?? "");
                        if (deleted) {
                            // CP-18: pin the id dead so the digest purge below cannot re-probe
                            // it as live, then forget its keys and any digest it alone owned.
                            aliveCache.set(deleted, false);
                            forgetSession(deleted);
                            void purgeOrphanDigests().catch(() => {
                                /* ignore */
                            });
                        }
                        return;
                    }
                    if (type !== "session.usage.updated")
                        return;
                    const data = (event.data ?? {});
                    const sessionID = String(data.sessionID ?? "unknown");
                    const st = stateFor(sessionID);
                    const tokens = (data.tokens ?? {});
                    const input = num(tokens.input);
                    const cache = (tokens.cache ?? {});
                    const cacheRead = num(cache.read);
                    const cacheWrite = num(cache.write);
                    const total = input + cacheRead + cacheWrite;
                    if (st.pendingEstimate > 0 && st.lastUsageTotal !== null) {
                        const delta = total - st.lastUsageTotal;
                        if (delta > 0) {
                            const observed = delta / st.pendingEstimate;
                            if (observed > 0.05 && observed < 20) {
                                st.ratio = st.ratio === 1 ? observed : st.ratio * 0.7 + observed * 0.3;
                                const mKey = sessionModelKey.get(sessionID);
                                if (mKey) {
                                    // C7: cap the calibration map (FIFO eviction of old models).
                                    if (calibration.size >= 256 && !calibration.has(mKey)) {
                                        const oldestKey = calibration.keys().next();
                                        if (!oldestKey.done)
                                            calibration.delete(oldestKey.value);
                                    }
                                    calibration.set(mKey, st.ratio);
                                    writeStore(`calibration:${mKey}`, { r: st.ratio, updatedAt: Date.now() });
                                }
                            }
                        }
                    }
                    st.lastUsageTotal = total;
                    // C1: these totals are CUMULATIVE per session — accumulate only the
                    // per-field deltas. Treating them as per-event increments corrupted
                    // the cache-hit ratio, the cost-saved estimate and the cache-replan
                    // gate (every event re-added the session's whole lifetime input).
                    // A null baseline means "first sighting": the whole total is new.
                    st.inputTokens += Math.max(0, input - (st.lastInputTotal ?? 0));
                    st.cacheRead += Math.max(0, cacheRead - (st.lastCacheReadTotal ?? 0));
                    st.cacheWrite += Math.max(0, cacheWrite - (st.lastCacheWriteTotal ?? 0));
                    st.lastInputTotal = input;
                    st.lastCacheReadTotal = cacheRead;
                    st.lastCacheWriteTotal = cacheWrite;
                    st.pendingEstimate = 0;
                    // A request that reached usage accounting succeeded: clear overflow state.
                    st.overflowRetries = 0;
                    st.recoveryTarget = null;
                }
                catch (err) {
                    // CP-15: a usage event that throws loses token calibration and
                    // overflow recovery for the session — report it, suppressed per session.
                    debug(`usage event failed: ${String(err)}`);
                    reportFailure("usage event", err, typeof event?.sessionID === "string" ? String(event.sessionID) : undefined);
                }
            };
            // The promise API's `event.subscribe` returns an async iterable (the
            // callback form is effect-domain only), so drive every shape. Note the
            // test double calls subscribe WITHOUT the callback — pass it only when
            // the function declares a parameter.
            try {
                const subscribe = c.event.subscribe;
                const stream = subscribe.length > 0 ? subscribe(onEvent) : subscribe();
                if (stream && typeof stream[Symbol.asyncIterator] === "function") {
                    void (async () => {
                        try {
                            for await (const event of stream)
                                onEvent(event);
                        }
                        catch {
                            /* stream closed */
                        }
                    })().catch(() => { });
                }
                else if (typeof stream === "function") {
                    track(stream);
                }
                else if (stream && typeof stream.then === "function") {
                    void Promise.resolve(stream)
                        .then((registration) => {
                        const dispose = registration?.dispose;
                        if (typeof dispose === "function")
                            track(() => dispose());
                    })
                        .catch(() => { });
                }
                else if (stream && typeof stream.dispose === "function") {
                    const dispose = stream.dispose;
                    track(() => dispose());
                }
            }
            catch {
                /* ignore */
            }
        }
        // ------------------------------------------------------------------ tools
        if (typeof c.tool?.transform === "function") {
            try {
                track(await c.tool.transform((editor) => {
                    editor.add({
                        name: "context_pruner_stats",
                        description: "Show what context-pruner trimmed and the active configuration.",
                        input: z.object({}),
                        execute: async () => {
                            try {
                                return { content: renderStats(cfg) };
                            }
                            catch (err) {
                                return { content: `context_pruner_stats failed: ${String(err)}` };
                            }
                        },
                    });
                    editor.add({
                        name: "context_report",
                        description: "Detailed context-compiler report: token budget, epoch, cache hit ratio, active prune decisions and summaries.",
                        input: z.object({
                            sessionID: z.string().optional().describe("Session to report on (defaults to the caller's session)"),
                        }),
                        execute: async (input, toolCtx) => {
                            try {
                                const args = (input ?? {});
                                // C12: default to the CALLING session, not "whichever
                                // session happened to compile last".
                                const callerSid = String(toolCtx?.sessionID ?? "");
                                const sessionID = args.sessionID ?? (callerSid || undefined);
                                return { content: renderReport(sessionID, cfg) };
                            }
                            catch (err) {
                                return { content: `context_report failed: ${String(err)}` };
                            }
                        },
                    });
                    editor.add({
                        name: "context_map",
                        description: "List the compressible tool output in this session (oldest first, with stable #N references) before calling `compress`.",
                        input: z.object({
                            sessionID: z.string().optional().describe("Session to map (defaults to the caller's session)"),
                        }),
                        execute: async (input, toolCtx) => {
                            try {
                                const args = (input ?? {});
                                // C12: default to the CALLING session — the old
                                // "[...sessions.keys()].pop()" guess picked whichever session
                                // happened to compile last.
                                const callerSid = String(toolCtx?.sessionID ?? "");
                                const sessionID = args.sessionID ?? callerSid;
                                const st = sessions.get(sessionID);
                                if (!st)
                                    return { content: "No request has been compiled for this session yet." };
                                return { content: renderContextMap(st, cfg, st.compressible.length) };
                            }
                            catch (err) {
                                return { content: `context_map failed: ${String(err)}` };
                            }
                        },
                    });
                    editor.add({
                        name: "context_pruner_recall",
                        description: "Return the full output of a tool result that context-pruner replaced with a stub, instead of re-running the tool.",
                        input: z.object({
                            id: z.string().describe("The id shown in the pruned-output stub"),
                        }),
                        execute: async (input, toolCtx) => {
                            try {
                                const args = (input ?? {});
                                const id = String(args.id ?? "").trim();
                                if (!id)
                                    return { content: "context_pruner_recall requires an id." };
                                // C17: recall is scoped to the calling session — ids are 32-bit
                                // hashes, and scanning every session leaked other sessions'
                                // tool output. Without a caller id (very old runtimes) fall
                                // back to the previous scan.
                                const callerSid = String(toolCtx?.sessionID ?? "");
                                const order = callerSid ? [callerSid] : [...sessions.keys()];
                                for (const sid of order) {
                                    const st = sessions.get(sid) ?? (callerSid && sid === callerSid ? stateFor(sid) : undefined);
                                    if (!st)
                                        continue;
                                    if (!st.loadedRecall)
                                        await loadRecall(sid, st);
                                    const hit = st.recall.get(id);
                                    if (!hit)
                                        continue;
                                    totals.recalls++;
                                    // CP-12: record the access. Without a hit counter the `lfu`
                                    // eviction policy compared entries that were all zero and
                                    // evicted by insertion order, i.e. it was not LFU at all.
                                    hit.hits = (hit.hits ?? 0) + 1;
                                    st.recallDirty = true;
                                    const text = hit.text.length > cfg.recallMaxChars
                                        ? `${hit.text.slice(0, cfg.recallMaxChars)}\n\n[context-pruner] recall truncated at ${cfg.recallMaxChars} of ${hit.chars} chars.`
                                        : hit.text;
                                    return { content: text };
                                }
                                return { content: `No stored output for id "${id}". It may have been evicted or produced in another process.` };
                            }
                            catch (err) {
                                return { content: `context_pruner_recall failed: ${String(err)}` };
                            }
                        },
                    });
                    editor.add({
                        name: "compress",
                        description: "Replace a chosen range of older tool output with a real summary produced by the session model. " +
                            "Ranges: `last` (the N most recent tool outputs), `from`/`to` (inclusive, using #N from context_map or a message id), " +
                            "`before`/`after`. Always give a `topic` describing what future work must retain. " +
                            "Run context_map first to see what is available. Protected tools, `<protect>` blocks and protected user text are never summarised; " +
                            "a range you name explicitly may include the turn in progress, and the reply says how many of the folded units came from it.",
                        input: z.object({
                            topic: z.string().optional().describe("What the summary must preserve (files, symbols, decisions)"),
                            reason: z.string().optional().describe("Why you are compressing now"),
                            from: z.union([z.string(), z.number()]).optional().describe("#N or message id — start of the range"),
                            to: z.union([z.string(), z.number()]).optional().describe("#N or message id — end of the range (inclusive)"),
                            before: z.union([z.string(), z.number()]).optional().describe("Compress everything before this #N or message id"),
                            after: z.union([z.string(), z.number()]).optional().describe("Compress everything after this #N or message id"),
                            last: z.number().int().optional().describe("Compress the N most recent tool outputs"),
                            dryRun: z.boolean().optional().describe("Preview the compression prompt without applying it"),
                        }),
                        execute: async (input, context) => {
                            try {
                                return await runCompress(input, context);
                            }
                            catch (err) {
                                return { content: `compress failed: ${String(err)}` };
                            }
                        },
                    });
                    editor.add({
                        name: "context_pruner_undo",
                        description: "Undo the last compression applied to this session, restoring the original tool outputs.",
                        input: z.object({
                            sessionID: z.string().optional().describe("Session to undo compression for (defaults to the caller's session)"),
                        }),
                        execute: async (input, toolCtx) => {
                            try {
                                const args = (input ?? {});
                                const callerSid = String(toolCtx?.sessionID ?? "");
                                const sessionID = args.sessionID ?? callerSid;
                                if (!sessionID)
                                    return { content: t("undoRequiresSession", cfg.locale ?? "en") };
                                const ok = undoLastCompression(sessionID);
                                if (ok.undone) {
                                    // CP-8: the stack keeps capped previews, so say when a
                                    // restored output came back shortened.
                                    return { content: ok.truncated ? `${t("undoSuccess", cfg.locale ?? "en")} (some outputs were restored from a truncated preview)` : t("undoSuccess", cfg.locale ?? "en") };
                                }
                                return { content: t("undoEmpty", cfg.locale ?? "en") };
                            }
                            catch (err) {
                                return { content: `context_pruner_undo failed: ${String(err)}` };
                            }
                        },
                    });
                }));
            }
            catch (err) {
                log(`tool registration failed; continuing with the remaining plugins: ${String(err)}`);
                debug(`tool registration failed: ${String(err)}`);
            }
        }
        // --------------------------------------------------------------- commands
        if (typeof c.command?.transform === "function") {
            try {
                track(await c.command.transform((editor) => {
                    editor.add({
                        name: "context",
                        description: "Report the current context-compiler budget, epoch, summaries and prune decisions.",
                        execute: async (input) => {
                            const text = renderReport(input?.sessionID, cfg);
                            try {
                                await c.session?.synthetic?.({ sessionID: input?.sessionID, text, description: "context report" });
                            }
                            catch {
                                log(text);
                            }
                        },
                    });
                    editor.add({
                        name: "compress",
                        description: "Ask the model to compress older context with the current focus.",
                        execute: async (input) => {
                            const focus = typeof input?.prompt === "string" ? input.prompt : "";
                            const text = [
                                "[context-pruner] The user requested a context compression pass.",
                                focus ? `Focus: ${focus}` : "",
                                "Call `context_map` if needed, then call `compress` with a topic and a range (last/from/to/before/after).",
                            ]
                                .filter(Boolean)
                                .join("\n");
                            try {
                                await c.session?.synthetic?.({ sessionID: input?.sessionID, text, description: "compress request", delivery: "queue" });
                            }
                            catch {
                                log(text);
                            }
                        },
                    });
                }));
            }
            catch (err) {
                log(`command registration failed; continuing with the remaining plugins: ${String(err)}`);
                debug(`command registration failed: ${String(err)}`);
            }
        }
        // --- compress tool implementation (closure over ctx/st) ------------------
        async function findTargets(args, list) {
            const resolveIndex = (ref) => {
                if (typeof ref === "number" && Number.isFinite(ref))
                    return Math.floor(ref) - 1;
                if (typeof ref === "string") {
                    const text = ref.trim();
                    const numbered = text.match(/^#?(\d+)$/);
                    if (numbered)
                        return Number(numbered[1]) - 1;
                    // CP-19: `ref` is the part-id snapshot kept when the part was released.
                    const idx = list.findIndex((r) => r.key === text || r.ref === text || r.part?.id === text || r.part?.toolCallId === text);
                    if (idx >= 0)
                        return idx;
                }
                return -1;
            };
            if (typeof args.last === "number" && Number.isFinite(args.last)) {
                return list.slice(Math.max(0, list.length - Math.floor(args.last)));
            }
            if (args.before !== undefined) {
                const i = resolveIndex(args.before);
                // C9: `list.slice(0, 0)` is the same `[]` as the `i === -1` arm —
                // the third ternary branch was dead.
                return i >= 0 ? list.slice(0, i) : [];
            }
            if (args.after !== undefined) {
                const i = resolveIndex(args.after);
                return i >= 0 ? list.slice(i + 1) : [];
            }
            if (args.from !== undefined) {
                const a = resolveIndex(args.from);
                const b = args.to !== undefined ? resolveIndex(args.to) : a;
                if (a >= 0 && b >= a)
                    return list.slice(a, b + 1);
                return [];
            }
            if (args.to !== undefined) {
                const b = resolveIndex(args.to);
                return b >= 0 ? list.slice(0, b + 1) : [];
            }
            return [];
        }
        async function runCompress(input, callContext) {
            const locale = cfg.locale ?? "en";
            if (!cfg.compressEnabled)
                return { content: t("compressDisabled", locale) };
            const args = (input ?? {});
            const caller = (callContext ?? {});
            // CP-3: compress rewrites the transcript of the session it summarises, so
            // it runs on the CALLER's session only. The old
            // `[...sessions.keys()].pop()` fallback silently compressed whichever
            // session had compiled last — the failure mode CP-12 already fixed for
            // context_report and context_map, and exactly what happens when a subagent
            // calls compress while the parent compiled most recently.
            const callerSid = String(caller.sessionID ?? "");
            if (!callerSid)
                return { content: t("compressRequiresSession", locale) };
            const sessionID = callerSid;
            const st = sessions.get(sessionID);
            if (!st)
                return { content: t("compressNoContext", locale) };
            const list = st.compressible;
            if (list.length === 0)
                return { content: t("compressEmpty", locale) };
            const textProtected = protectedTextKeys(list, st, cfg);
            let targets = await findTargets(args, list);
            targets = targets.filter((r) => !isProtected(r, cfg) &&
                !textProtected.has(r.key) &&
                r.text.length >= Math.min(cfg.minChars, 200) &&
                !isPrunedStub(r.text));
            // CP-18 (restored): the manual tool does NOT filter the live turn. It is
            // the model naming a specific range on purpose — filtering here made
            // `from`/`to`/`last` unusable in exactly the shape where it matters (a
            // short or single-turn session, where the live turn IS the whole
            // transcript, so every unit was dropped and compress reported "no
            // targets"). Invariant C2 is an invariant about the AUTOMATIC passes,
            // which run without being asked and honour `turnProtectedFrom` at the C2
            // guards (candidateResults / maybeAutoSummarize / collapseSpans).
            // The count is reported as a note so the model can see it folded live
            // output on purpose rather than by accident.
            let liveIncluded = 0;
            if (st.turnProtectedFrom >= 0)
                liveIncluded = targets.filter((r) => r.mi >= st.turnProtectedFrom).length;
            if (targets.length === 0) {
                return { content: t("compressNoTargets", locale) };
            }
            // CP-18: the old `slice(0, 40)` kept the OLDEST targets and dropped the
            // near-term ones without a word, which is backwards — the recent range is
            // what the model still works in. Keep the newest and say what happened.
            let keptNewest = false;
            if (targets.length > 40) {
                targets = targets.slice(-40);
                keptNewest = true;
            }
            const topic = sanitizeLabel(args.topic);
            const reason = sanitizeLabel(args.reason) || "context limit";
            const rawSource = targets.map((r) => `### ${r.name}\n${r.text}`).join("\n\n");
            let protectedBlocks = [];
            let source = rawSource;
            if (cfg.protectTags) {
                const extracted = extractProtected(rawSource);
                source = extracted.stripped;
                protectedBlocks = extracted.blocks;
            }
            const maxSrc = maxSourceCharsFor(targets[0]?.name, cfg);
            if (source.length > maxSrc) {
                source = `${source.slice(0, maxSrc)}\n\n[truncated]`;
            }
            // E28: dry-run mode — build the prompt and return it without calling the model.
            const dryRun = asBool(args.dryRun, false);
            if (dryRun) {
                // CP-4: the per-tool template and the target's tool name were dropped on
                // this path, so a dry run previewed a different prompt than the one the
                // real call sends.
                const prompt = summaryPrompt(source, topic, reason, protectedBlocks, cfg, targets[0]?.name);
                const estimatedTokens = targets.reduce((sum, r) => sum + r.tokens, 0);
                const estimatedSavings = Math.max(0, estimatedTokens - estimateTokens(prompt, cfg, st.ratio));
                return {
                    content: [
                        "[dry-run] Compression preview — no changes applied.",
                        "",
                        liveIncluded > 0 ? `${t("compressLiveTurnIncluded", locale)} (${liveIncluded} unit(s)).` : "",
                        keptNewest ? `${t("compressKeptNewest", locale)}.` : "",
                        `Targets (${targets.length}):`,
                        ...targets.map((r) => `  · #${r.key} ${r.name} (${r.tokens} tokens)`),
                        "",
                        `Estimated savings: ~${estimatedSavings} tokens`,
                        "",
                        "Prompt that would be sent to the model:",
                        "---",
                        prompt,
                        "---",
                    ].join("\n"),
                };
            }
            const cacheKey = summaryCacheKey(topic, source);
            let body;
            const cached = await readStore(cacheKey, "digest");
            if (isPlainObject(cached) && typeof cached.text === "string" && cached.text) {
                body = cached.text;
                debug(`summary cache hit for ${targets.length} result(s)`);
                // CP-20: a cache hit still has to record this session as a co-owner, or
                // the digest is owned by whoever wrote it first and dies with them.
                await claimDigest(cacheKey, body, topic, sessionID);
            }
            const session = c.session;
            if (!body) {
                if (typeof session?.generate !== "function") {
                    return { content: "The session model is unavailable, so compress cannot generate a summary right now." };
                }
                const prompt = summaryPrompt(source, topic, reason, protectedBlocks, cfg, targets[0]?.name);
                try {
                    const response = await session.generate({ sessionID, prompt });
                    body = generatedText(response);
                    // E31: track compression cost
                    const inputTokens = num(response?.inputTokens ?? response?.usage?.input_tokens, 0);
                    if (inputTokens > 0) {
                        st.compressionCallTokens += inputTokens;
                        totals.compressionCallTokens += inputTokens;
                        // Estimate cost: use model pricing if available, otherwise rough estimate
                        if ((modelCaches.get(c) ?? []).length === 0)
                            refreshModels(c);
                        const pricing = modelInputPrices(c).get(st.modelRef) ?? 0;
                        const cost = pricing > 0 ? (inputTokens / 1_000_000) * pricing : 0;
                        st.compressionCallCost += cost;
                        totals.compressionCallCost += cost;
                    }
                }
                catch {
                    body = "";
                }
                if (!body && cfg.autoSummarizeStub)
                    body = fallbackSummary(targets, cfg);
                if (!body) {
                    debug(`compress generate returned empty`);
                    return { content: t("compressModelUnavailable", locale) };
                }
                totals.generations++;
                // CP-20: union the owner list instead of replacing it.
                await claimDigest(cacheKey, body, topic, sessionID);
            }
            const prose = targets.every((r) => r.kind === "text");
            const compressedPaths = targets.map((r) => filePathOf(r)).filter(Boolean);
            const text = buildSummaryText(body, protectedBlocks, prose, compressedPaths, cfg);
            const covers = targets.map((r) => r.key);
            const record = {
                first: covers[0],
                covers,
                hashes: coverHashes(targets),
                text,
                tokens: estimateTokens(text, cfg, st.ratio),
                topic,
                at: Date.now(),
                prose,
            };
            // E34: push to compression stack before applying (CP-8: bounded, previews capped).
            const originalTexts = new Map();
            for (const r of targets) {
                originalTexts.set(r.key, r.text);
            }
            pushCompressionEntry(st, covers, originalTexts);
            // Nested compression: drop any previous record fully contained here.
            for (const [key, existing] of [...st.summaries]) {
                if (existing.covers.every((cover) => covers.includes(cover)))
                    st.summaries.delete(key);
            }
            st.summaries.set(covers[0], record);
            for (const key of covers)
                st.decisions.delete(key);
            // Awaited: the record has to be readable the moment `compress` returns,
            // both for a caller that immediately inspects storage and for the next
            // request, which loads summaries from there.
            await persistSummaries(sessionID, st);
            const savedTokens = Math.max(0, targets.reduce((sum, r) => sum + r.tokens, 0) - record.tokens);
            totals.summaries++;
            totals.summarySavedTokens += savedTokens;
            // E27: compression quality metrics — track low-quality compressions
            const originalTokens = targets.reduce((sum, r) => sum + r.tokens, 0);
            if (originalTokens > 0) {
                const qualityRatio = record.tokens / originalTokens;
                if (qualityRatio > 0.8) {
                    totals.lowQualityCompressions++;
                    st.lowQualityCompressions++;
                }
            }
            st.iterationsSinceCompress = 0;
            // Banked for the next turn's single digest: the digest names the
            // summary and its topic when it applies the record.
            bankNote(st, `compress: ${targets.length} result(s) → ${record.tokens} tokens (saved ~${savedTokens})`);
            return {
                content: [
                    `${t("compressResult", locale)} ${targets.length} tool result(s) (~${savedTokens} tokens saved).`,
                    t("compressSaved", locale),
                    topic ? `${t("compressFocus", locale)}: ${topic}` : "",
                    protectedBlocks.length > 0 ? `${t("compressProtected", locale)} ${protectedBlocks.length} protected block(s) verbatim.` : "",
                    // CP-18: say when the range reached into the turn in progress.
                    liveIncluded > 0 ? `${t("compressLiveTurnIncluded", locale)} (${liveIncluded} unit(s)).` : "",
                    keptNewest ? `${t("compressKeptNewest", locale)} (${targets.length} kept of a longer range).` : "",
                ]
                    .filter(Boolean)
                    .join("\n"),
            };
        }
        // ------------------------------------------------------------- tier 4
        // Native wins DCP cannot do: fill the compaction checkpoint ourselves,
        // recover from context-limit retries, and short-circuit title generation.
        if (typeof c.session?.hook === "function") {
            // CP-23: guarded like the context hook above. A tier-4 registration that
            // rejects must not reject `setup` itself: that would either fail the
            // plugin load outright or, if the host does not await setup, leak an
            // unhandled rejection during startup and take down a turn.
            try {
                track(await c.session.hook("compaction", (event) => {
                    try {
                        if (!cfg.enabled || !cfg.compactionCheckpoint)
                            return;
                        const record = event;
                        const sessionID = String(record.sessionID ?? "unknown");
                        const summary = buildCheckpoint((record.messages ?? []));
                        // No model request runs for a checkpoint, but opencode still reads
                        // result.tokens as a full TokenUsage.Info (input/output/reasoning and
                        // cache.read/write). A bare number crashes compaction on `cache.read`.
                        record.result = { summary, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
                        totals.checkpoints++;
                        // Banked for the next turn's single digest, not a receipt of its own.
                        bankNote(stateFor(sessionID), `checkpoint written (${summary.length} chars)`);
                        debug(`checkpoint for ${sessionID}: ${summary.length} chars`);
                    }
                    catch (err) {
                        debug(`compaction hook failed: ${String(err)}`);
                    }
                }));
                track(await c.session.hook("retry", (event) => {
                    try {
                        if (!cfg.enabled || !cfg.retryOnOverflow)
                            return;
                        const record = event;
                        if (!isOverflowError(errorText(record.error)))
                            return;
                        const attempt = num(record.attempt, 0);
                        const sessionID = String(record.sessionID ?? "unknown");
                        if (attempt >= cfg.retryMaxAttempts) {
                            record.decision = { retry: false };
                            debug(`overflow retry exhausted for ${sessionID}`);
                            return;
                        }
                        const st = stateFor(sessionID);
                        if (st.budget !== null) {
                            const reduced = Math.max(1, Math.floor(st.budget * cfg.recoveryRatio));
                            st.recoveryTarget = st.recoveryTarget === null ? reduced : Math.min(st.recoveryTarget, reduced);
                        }
                        st.overflowRetries++;
                        totals.overflowRecoveries++;
                        const delay = Math.min(2000, 250 * Math.max(1, attempt));
                        record.decision = { retry: true, delay };
                        notify(sessionID, "context overflow - trimming harder and retrying", `overflow: retry ${attempt + 1} in ${delay}ms`);
                        debug(`overflow retry for ${sessionID} attempt ${attempt + 1} (delay ${delay}ms, target ${st.recoveryTarget ?? "n/a"})`);
                    }
                    catch (err) {
                        debug(`retry hook failed: ${String(err)}`);
                    }
                }));
                track(await c.session.hook("title", (event) => {
                    try {
                        if (!cfg.enabled || !cfg.titleShortCircuit)
                            return;
                        const record = event;
                        const title = deriveTitle((record.messages ?? []));
                        if (title)
                            record.result = title;
                    }
                    catch (err) {
                        debug(`title hook failed: ${String(err)}`);
                    }
                }));
            }
            catch (err) {
                // Losing compaction/retry/title costs relief, not the session: the
                // pruner simply runs without them and the host carries on.
                log(`tier-4 hook registration failed; continuing without it: ${String(err)}`);
                debug(`tier-4 hook registration failed: ${String(err)}`);
            }
        }
        // CP-16/17: reclaim keys for sessions deleted while this plugin was not
        // running (no event replay), then bound the non-session caches. Best-effort
        // and off the critical path so setup never blocks.
        void sweepOrphanedState()
            .then(() => gcStorage())
            .catch(() => {
            /* ignore */
        });
        log(`ready (budgetRatio=${cfg.budgetRatio}, targetRatio=${cfg.targetRatio}, keepRecent=${cfg.keepRecent}, relaxRecentFloor=${cfg.relaxRecentFloor}, minReplanTokens=${cfg.minReplanTokens}, compress=${cfg.compressEnabled ? "range" : "off"}${cfg.compressEnabled && cfg.compressText ? "+text" : ""}, collapse=${cfg.collapseRanges ? (cfg.collapseStubs ? "stubs" : "on") : "off"}${cfg.configPath ? `, config=${cfg.configPath}` : ""})`);
        debug("context-pruner initialised");
        return async () => {
            for (const watched of watchedConfigs) {
                try {
                    unwatchFile(watched.path, watched.listener);
                }
                catch {
                    /* ignore */
                }
            }
            if (reloadTimer)
                clearTimeout(reloadTimer);
            for (const dispose of disposers) {
                try {
                    await dispose();
                }
                catch {
                    /* ignore */
                }
            }
        };
    },
});
