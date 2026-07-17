import { tool } from "@opencode-ai/plugin";
import { parse, resolve } from "path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMemorySystemPrompt, buildIndexLimitWarning } from "./core/prompt.js";
import { formatRecalledMemories, recallSelectedMemories } from "./core/recall.js";
import { isSupportedRecallSelectorClient, selectRelevantMemoryFilenames } from "./core/recallSelector.js";
import { scanMemoryFiles, getMemoryManifest } from "./core/memoryScan.js";
import { saveMemory, deleteMemory, listMemories, searchMemories, readMemory, readIndex, MEMORY_TYPES, } from "./core/memory.js";
import { getMemoryDir, findCanonicalGitRoot, setLocalMemoryMode, setSessionMemoryRoot, setIndexMaxLines, setLocalMemorySecretsAllowed, setRedactGlobalSecrets, shouldRedactMemory, isInRepoMemory, } from "./core/paths.js";
import { scrubMemoryFields } from "./core/redact.js";
import { saveHarnessFeedback, HARNESS_FEEDBACK_CATEGORIES } from "./core/harness.js";
const turnContextBySession = new Map();
const selectorSessionIDs = new Set();
// Sessions that have already been shown the index-size-limit warning, so the
// agent is asked to warn the user at most once per session (see prompt.ts).
const indexLimitWarnedSessions = new Set();
// Pending idle-triggered `opencode-memory maintain` runs, keyed by sessionID.
// A session.idle event arms a debounce timer; a new chat.message clears it, so
// maintenance fires once the conversation actually goes quiet — not every turn.
const idleMaintainTimers = new Map();
function shouldIgnoreMemoryContext(query) {
    if (process.env.OPENCODE_MEMORY_IGNORE === "1")
        return true;
    if (!query)
        return false;
    const normalized = query.toLowerCase();
    return (/(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
        /memory\s+(should be|must be)?\s*ignored/.test(normalized));
}
function extractUserQuery(message) {
    if (!message || typeof message !== "object")
        return undefined;
    if ("content" in message) {
        const content = message.content;
        if (typeof content === "string")
            return content;
        if (content !== undefined)
            return JSON.stringify(content);
    }
    if ("parts" in message) {
        const parts = message.parts;
        if (Array.isArray(parts)) {
            const text = parts
                .map((part) => {
                if (!part || typeof part !== "object")
                    return "";
                return typeof part.text === "string"
                    ? part.text
                    : "";
            })
                .filter(Boolean)
                .join("\n")
                .trim();
            if (text)
                return text;
        }
    }
    return undefined;
}
function getLastUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.info?.role !== "user")
            continue;
        const query = extractUserQuery(message);
        const sessionID = typeof message.info?.sessionID === "string" ? message.info.sessionID : undefined;
        const messageID = typeof message.info?.id === "string" ? message.info.id : undefined;
        return { query, sessionID, messageID, messageIndex: i };
    }
    return {};
}
function isAutoMemoryPart(part) {
    if (!part || typeof part !== "object")
        return false;
    return typeof part.text === "string" &&
        part.text.includes("# Auto Memory");
}
// Parses "### <name> (<type>)" headers from the ## Recalled Memories section
// of system prompts. After compaction old system messages disappear, so
// the returned set naturally shrinks — no manual reset needed.
function extractSurfacedMemoryKeys(systemText) {
    const keys = new Set();
    const recalledSection = systemText.indexOf("## Recalled Memories");
    if (recalledSection === -1)
        return keys;
    const headerPattern = /^### (.+?) \((\w+)\)/gm;
    const section = systemText.slice(recalledSection);
    for (let match = headerPattern.exec(section); match !== null; match = headerPattern.exec(section)) {
        keys.add(`${match[1]}|${match[2]}`);
    }
    return keys;
}
// Only completed tools — matches Claude Code's collectRecentSuccessfulTools().
function extractRecentTools(messages) {
    const tools = [];
    const seen = new Set();
    for (const message of messages) {
        if (!message.parts || !Array.isArray(message.parts))
            continue;
        for (const part of message.parts) {
            if (!part || typeof part !== "object")
                continue;
            const p = part;
            if (p.type !== "tool" || !p.tool)
                continue;
            if (p.state?.status !== "completed")
                continue;
            if (seen.has(p.tool))
                continue;
            seen.add(p.tool);
            tools.push(p.tool);
        }
    }
    return tools;
}
// Settings passed via the plugin's `options` bag in opencode.json (the native
// per-plugin config surface). Captured once when the plugin loads. Environment
// variables still take precedence over these. Only recall* is consumed here —
// extract*/dream* run in the wrapper (bin/opencode-memory), which reads the same
// options block from opencode.json itself.
let pluginRecallModel;
let pluginRecallAgent;
let pluginExtraRoots = [];
let pluginMaintainOnIdle;
function asOptionString(v) {
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asOptionBool(v) {
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(s))
            return true;
        if (["0", "false", "no", "off"].includes(s))
            return false;
    }
    return undefined;
}
function asOptionStringArray(v) {
    if (!Array.isArray(v))
        return [];
    return v
        .filter((x) => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim());
}
// Always (re)set on construction — never early-return on missing options, or
// stale recall settings from a prior construction would leak in (module state).
function recordPluginOptions(options) {
    pluginRecallModel = asOptionString(options?.recallModel);
    pluginRecallAgent = asOptionString(options?.recallAgent);
    pluginExtraRoots = asOptionStringArray(options?.extraMemoryRoots);
    // Local (in-repo) memory mode. env OPENCODE_MEMORY_LOCAL still takes
    // precedence (resolved in paths.ts); always set so a stale mode can't leak in.
    setLocalMemoryMode(options?.localMemory);
    // Soft index-size limit. env OPENCODE_MEMORY_INDEX_MAX_LINES takes precedence.
    setIndexMaxLines(options?.indexMaxLines);
    // Allow secret values in IN-REPO memory (off by default). env
    // OPENCODE_MEMORY_LOCAL_SECRETS takes precedence.
    setLocalMemorySecretsAllowed(options?.localMemorySecrets);
    // Opt-in defense-in-depth: also scrub credential values from GLOBAL writes
    // (off by default; secrets are allowed in ~/.claude). env
    // OPENCODE_MEMORY_REDACT_GLOBAL takes precedence.
    setRedactGlobalSecrets(options?.redactGlobalSecrets);
    // Run `opencode-memory maintain` automatically when the session goes idle, so
    // post-session extraction works for ANY launch (dashboard tile, bare CLI,
    // editor) without the wrapper or a dashboard on_close hook. Off by default to
    // avoid double-extraction when opencode IS run through the wrapper. env
    // OPENCODE_MEMORY_MAINTAIN_ON_IDLE takes precedence.
    pluginMaintainOnIdle = asOptionBool(options?.maintainOnIdle);
}
// Additional memory roots whose index is surfaced read-only this session and
// which the memory_* tools may target via their `root` arg. The env var REPLACES
// the option when set (scalar precedence, matching getRecallModel). Each entry is
// a repo path (a git root or any directory); env entries split on , ; : newline.
function getExtraRoots() {
    const env = process.env.OPENCODE_MEMORY_EXTRA_ROOTS;
    if (env && env.trim()) {
        return env
            .split(/[,;:\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return pluginExtraRoots;
}
function getRecallAgent() {
    return process.env.OPENCODE_MEMORY_RECALL_AGENT || pluginRecallAgent || "opencode-memory-recall";
}
function getRecallModel() {
    const raw = process.env.OPENCODE_MEMORY_RECALL_MODEL || pluginRecallModel;
    if (!raw)
        return undefined;
    const slashIdx = raw.indexOf("/");
    if (slashIdx <= 0 || slashIdx === raw.length - 1)
        return undefined;
    return {
        providerID: raw.slice(0, slashIdx),
        modelID: raw.slice(slashIdx + 1),
    };
}
function isRootPath(path) {
    const resolved = resolve(path);
    return resolved === parse(resolved).root;
}
function resolveMemoryRoot(worktree, directory) {
    if (isRootPath(worktree) && !isRootPath(directory))
        return directory;
    return worktree;
}
function isUsefulRecallQuery(query) {
    const trimmed = query?.trim();
    if (!trimmed)
        return false;
    if (/\s/.test(trimmed))
        return true;
    return /[\u3400-\u9fff]/.test(trimmed) && trimmed.length >= 4;
}
function buildTurnID(sessionID, messageID, messageIndex, query) {
    return `${sessionID}:${messageID ?? `${messageIndex ?? -1}:${query ?? ""}`}`;
}
function alreadySurfacedKey(header) {
    return `${header.name ?? header.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${header.type ?? "user"}`;
}
function startRecallPrefetch(input) {
    if (!input.client || !isUsefulRecallQuery(input.query))
        return undefined;
    if (!isSupportedRecallSelectorClient(input.client))
        return undefined;
    const memoryDir = getMemoryDir(input.worktree);
    const headers = scanMemoryFiles(memoryDir).filter((header) => !input.alreadySurfaced.has(alreadySurfacedKey(header)));
    if (headers.length === 0)
        return undefined;
    const handle = {
        turnID: input.turnID,
        settled: false,
        consumed: false,
        result: [],
    };
    const promise = selectRelevantMemoryFilenames({
        client: input.client,
        directory: input.directory,
        parentSessionID: input.parentSessionID,
        query: input.query,
        memories: headers,
        recentTools: input.recentTools,
        selectorSessionIDs,
        agent: getRecallAgent(),
        model: getRecallModel(),
    })
        .then((selectedFilenames) => recallSelectedMemories(headers, selectedFilenames, input.alreadySurfaced))
        .catch(() => []);
    void promise.then((result) => {
        handle.result = result;
    }).finally(() => {
        handle.settled = true;
    });
    return handle;
}
function consumeRecallPrefetch(ctx) {
    const prefetch = ctx?.recallPrefetch;
    if (!prefetch || !prefetch.settled || prefetch.consumed)
        return [];
    prefetch.consumed = true;
    return prefetch.result;
}
// Tracks how many memory entries a memory_list call saw so tool.execute.after
// can render a meaningful title without re-reading the filesystem. Keyed by
// callID, which uniquely identifies a single tool invocation.
const memoryListCountByCallID = new Map();
const memorySearchCountByCallID = new Map();
function buildMemoryToolTitle(toolID, args, callID) {
    switch (toolID) {
        case "memory_save": {
            const type = typeof args?.type === "string" ? args.type : "";
            const name = typeof args?.name === "string" ? args.name : "";
            if (type && name)
                return `${type}: ${name}`;
            if (name)
                return name;
            return undefined;
        }
        case "memory_delete":
        case "memory_read": {
            const fileName = typeof args?.file_name === "string" ? args.file_name : "";
            return fileName || undefined;
        }
        case "memory_list": {
            const count = callID ? memoryListCountByCallID.get(callID) : undefined;
            if (callID)
                memoryListCountByCallID.delete(callID);
            if (count === undefined)
                return "list memories";
            return `${count} ${count === 1 ? "memory" : "memories"}`;
        }
        case "memory_search": {
            const query = typeof args?.query === "string" ? args.query : "";
            const count = callID ? memorySearchCountByCallID.get(callID) : undefined;
            if (callID)
                memorySearchCountByCallID.delete(callID);
            if (query && count !== undefined) {
                return `"${query}" · ${count} ${count === 1 ? "match" : "matches"}`;
            }
            if (query)
                return `"${query}"`;
            return undefined;
        }
        default:
            return undefined;
    }
}
function getCallID(ctx) {
    if (!ctx || typeof ctx !== "object")
        return undefined;
    const v = ctx.callID;
    return typeof v === "string" ? v : undefined;
}
// Idle-maintain: env OPENCODE_MEMORY_MAINTAIN_ON_IDLE > plugin option > false.
function isMaintainOnIdleEnabled() {
    const env = asOptionBool(process.env.OPENCODE_MEMORY_MAINTAIN_ON_IDLE);
    return env ?? pluginMaintainOnIdle ?? false;
}
// Debounce window: wait this long after the last idle before spawning maintain,
// so a quick follow-up turn cancels it. env OPENCODE_MEMORY_MAINTAIN_IDLE_SECONDS,
// default 30s.
function getMaintainIdleDelayMs() {
    const raw = process.env.OPENCODE_MEMORY_MAINTAIN_IDLE_SECONDS;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return (Number.isFinite(n) && n > 0 ? n : 30) * 1000;
}
// The wrapper lives next to the compiled plugin (../bin/opencode-memory). Fall
// back to a PATH lookup if that resolution fails (e.g. an unusual install).
function resolveMaintainBin() {
    try {
        const p = fileURLToPath(new URL("../bin/opencode-memory", import.meta.url));
        if (existsSync(p))
            return p;
    }
    catch {
        /* fall through to PATH */
    }
    return "opencode-memory";
}
function spawnMaintain(dir) {
    if (!dir)
        return;
    try {
        // Detached + unref'd so it outlives this turn and never blocks the session.
        // The wrapper's own per-repo lock serialises overlapping maintain runs.
        const child = spawn(resolveMaintainBin(), ["maintain", "--dir", dir], {
            detached: true,
            stdio: "ignore",
            env: process.env,
        });
        child.unref();
    }
    catch {
        /* best-effort; never disrupt the session */
    }
}
function clearMaintainTimer(sessionID) {
    const t = idleMaintainTimers.get(sessionID);
    if (t) {
        clearTimeout(t);
        idleMaintainTimers.delete(sessionID);
    }
}
function armMaintainTimer(sessionID, dir) {
    clearMaintainTimer(sessionID);
    const t = setTimeout(() => {
        idleMaintainTimers.delete(sessionID);
        spawnMaintain(dir);
    }, getMaintainIdleDelayMs());
    t.unref?.();
    idleMaintainTimers.set(sessionID, t);
}
export const MemoryPlugin = async ({ worktree, directory, client }, options) => {
    directory ??= worktree;
    recordPluginOptions(options);
    const memoryRoot = resolveMemoryRoot(worktree, directory);
    // Pin the session's own repo so the local on/off mode applies only here, not to
    // declared extraMemoryRoots (which stay "auto" — never force-created in-repo).
    setSessionMemoryRoot(memoryRoot);
    getMemoryDir(memoryRoot);
    // Resolve a tool's optional `root` arg against the allowlist (this session's
    // repo + declared extraMemoryRoots). An omitted root means "this session's
    // repo"; an undeclared root is REJECTED — this is what stops the model from
    // writing memory to an arbitrary path. Compared by canonical git root so a
    // subdir/worktree of an allowed repo still resolves.
    const canonicalRoot = (p) => findCanonicalGitRoot(p) ?? resolve(p);
    const allowedRoots = () => [memoryRoot, ...getExtraRoots()];
    const resolveToolRoot = (rootArg) => {
        if (typeof rootArg !== "string" || !rootArg.trim())
            return { root: memoryRoot };
        const want = canonicalRoot(rootArg.trim());
        for (const r of allowedRoots()) {
            if (canonicalRoot(r) === want)
                return { root: r };
        }
        return {
            error: `Memory root "${rootArg}" is not allowed. Declare it in opencode.json plugin ` +
                `options.extraMemoryRoots (or the OPENCODE_MEMORY_EXTRA_ROOTS env var) first. ` +
                `Allowed roots: ${allowedRoots().join(", ")}`,
        };
    };
    return {
        config: async (config) => {
            const agentName = getRecallAgent();
            const mutable = config;
            mutable.agent ??= {};
            mutable.agent[agentName] ??= {
                mode: "all",
                hidden: true,
                prompt: "Select up to 5 relevant memory filenames for the current user query. Return only the requested structured output.",
            };
        },
        "chat.params": async (input, output) => {
            if (input.agent !== getRecallAgent())
                return;
            output.temperature = 0;
            output.options = {
                ...output.options,
                maxOutputTokens: 256,
            };
        },
        // Idle-triggered post-session extraction (opt-in). When the session goes
        // quiet, debounce-spawn `opencode-memory maintain` so extraction works for
        // any launch without the wrapper or a dashboard on_close hook. A new turn
        // (chat.message) cancels the pending run so it fires only once per quiet
        // period; the wrapper's incremental high-water mark makes repeats cheap.
        event: async ({ event }) => {
            if (!isMaintainOnIdleEnabled())
                return;
            const ev = event;
            const sid = typeof ev?.properties?.sessionID === "string" ? ev.properties.sessionID : undefined;
            // Only sessions this plugin instance actually served (same project), and
            // never the recall selector's own hidden child sessions.
            if (!sid || !turnContextBySession.has(sid) || selectorSessionIDs.has(sid))
                return;
            if (ev.type === "session.idle")
                armMaintainTimer(sid, directory ?? memoryRoot);
        },
        "chat.message": async (input) => {
            // The conversation resumed — cancel any pending idle-maintain.
            if (isMaintainOnIdleEnabled())
                clearMaintainTimer(input.sessionID);
        },
        "tool.execute.after": async (input, output) => {
            if (input.tool === "harness_feedback") {
                const title = typeof input.args?.title === "string" ? input.args.title : undefined;
                if (title)
                    output.title = `harness: ${title}`;
                return;
            }
            if (!input.tool.startsWith("memory_"))
                return;
            const title = buildMemoryToolTitle(input.tool, input.args, input.callID);
            if (title)
                output.title = title;
        },
        "experimental.chat.messages.transform": async (_input, output) => {
            const { query, sessionID, messageID, messageIndex } = getLastUserQuery(output.messages);
            if (sessionID && selectorSessionIDs.has(sessionID))
                return;
            if (sessionID) {
                const alreadySurfaced = new Set();
                for (const message of output.messages) {
                    const role = String(message.info.role);
                    if (role !== "system")
                        continue;
                    for (const part of message.parts) {
                        if (!part || typeof part !== "object")
                            continue;
                        const text = part.text;
                        if (typeof text === "string") {
                            for (const key of extractSurfacedMemoryKeys(text)) {
                                alreadySurfaced.add(key);
                            }
                        }
                    }
                }
                const recentTools = extractRecentTools(output.messages);
                const turnID = buildTurnID(sessionID, messageID, messageIndex, query);
                const existing = turnContextBySession.get(sessionID);
                const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query);
                let recallPrefetch;
                if (!ignoreMemoryContext) {
                    recallPrefetch = existing?.turnID === turnID
                        ? existing.recallPrefetch
                        : startRecallPrefetch({
                            client: client,
                            directory,
                            worktree: memoryRoot,
                            parentSessionID: sessionID,
                            turnID,
                            query,
                            alreadySurfaced,
                            recentTools,
                        });
                }
                turnContextBySession.set(sessionID, { turnID, query, alreadySurfaced, recentTools, recallPrefetch });
            }
            if (shouldIgnoreMemoryContext(query)) {
                output.messages = output.messages
                    .map((message) => {
                    const role = String(message.info.role);
                    if (role !== "system")
                        return message;
                    const parts = message.parts.filter((part) => !isAutoMemoryPart(part));
                    return { ...message, parts };
                })
                    .filter((message) => message.parts.length > 0);
            }
        },
        "experimental.chat.system.transform": async (_input, output) => {
            let sessionID;
            if (_input && typeof _input === "object") {
                sessionID = typeof _input.sessionID === "string"
                    ? _input.sessionID
                    : undefined;
            }
            if (sessionID && selectorSessionIDs.has(sessionID))
                return;
            const ctx = sessionID ? turnContextBySession.get(sessionID) : undefined;
            const query = ctx?.query;
            const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query);
            const recalled = ignoreMemoryContext ? [] : consumeRecallPrefetch(ctx);
            const recalledSection = formatRecalledMemories(recalled);
            let memoryPrompt = buildMemorySystemPrompt(memoryRoot, recalledSection, {
                includeIndex: !ignoreMemoryContext,
            });
            // Surface declared extra roots read-only (index only — no per-root recall).
            // Appended to the SAME system string so consumers still see one Auto Memory
            // block. Suppressed under the ignore-memory gate like the primary index.
            if (!ignoreMemoryContext) {
                for (const root of getExtraRoots()) {
                    if (canonicalRoot(root) === canonicalRoot(memoryRoot))
                        continue;
                    let manifest = "";
                    let count = 0;
                    try {
                        const m = getMemoryManifest(root);
                        manifest = m.manifest;
                        count = m.headers.length;
                    }
                    catch {
                        continue;
                    }
                    if (count === 0)
                        continue;
                    memoryPrompt +=
                        `\n\n## Additional memory index — ${root}\n\n` +
                            `Read-only index of another repo's curated memory. To read an entry, call ` +
                            `memory_read with root:"${root}". Note: memory_save and memory_delete still ` +
                            `target THIS session's repo unless you pass the same root.\n\n${manifest}`;
                }
            }
            // Once per session, if the index has hit the configured soft limit, ask the
            // agent to warn the user and offer compaction. Latched so it isn't repeated
            // every turn; only when the index is actually loaded (not under ignore).
            if (!ignoreMemoryContext && sessionID && !indexLimitWarnedSessions.has(sessionID)) {
                const warning = buildIndexLimitWarning(readIndex(memoryRoot));
                if (warning) {
                    memoryPrompt += `\n\n${warning}`;
                    indexLimitWarnedSessions.add(sessionID);
                }
            }
            output.system.push(memoryPrompt);
        },
        tool: {
            memory_save: tool({
                description: "Save or update a memory for future conversations. " +
                    "Each memory is stored as a markdown file with frontmatter. " +
                    "Use this when the user explicitly asks you to remember something, " +
                    "or when you observe important information worth preserving across sessions " +
                    "(user preferences, feedback, project context, external references). " +
                    "Check existing memories first with memory_list or memory_search to avoid duplicates.",
                args: {
                    file_name: tool.schema
                        .string()
                        .describe('File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"'),
                    name: tool.schema.string().describe("Human-readable name for this memory"),
                    description: tool.schema
                        .string()
                        .describe("One-line description — used to decide relevance in future conversations, so be specific"),
                    type: tool.schema
                        .enum(MEMORY_TYPES)
                        .describe("Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)"),
                    content: tool.schema
                        .string()
                        .describe("Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines"),
                    created: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT this normally — `created` is auto-stamped to now. Set it ONLY when consolidating duplicate " +
                        "memories: pass the oldest source memory's `created` value (an ISO-8601 timestamp) so the manifest " +
                        "sort order stays accurate after the merge."),
                    root: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT normally — defaults to THIS session's repo. Set ONLY to write to another repo whose path is " +
                        "declared in the plugin's extraMemoryRoots; pass that repo's absolute path. Any other path is rejected."),
                },
                async execute(args, ctx) {
                    const r = resolveToolRoot(args.root);
                    if ("error" in r)
                        return r.error;
                    // ToolContext carries the originating sessionID; record it as
                    // memory provenance, matching Claude Code's on-disk metadata. The
                    // guard keeps the unit-test mock (which passes only { callID }) working.
                    const originSessionId = typeof ctx?.sessionID === "string"
                        ? ctx.sessionID
                        : undefined;
                    // For in-repo memory, scrub credential values first and tell the user
                    // when something was caught (the scrub also runs inside saveMemory as
                    // the safety net for non-tool callers; here it surfaces the count).
                    let saveName = args.name;
                    let saveDescription = args.description;
                    let saveContent = args.content;
                    let redactionNote = "";
                    if (shouldRedactMemory(r.root)) {
                        const s = scrubMemoryFields({ name: saveName, description: saveDescription, content: saveContent });
                        saveName = s.name;
                        saveDescription = s.description;
                        saveContent = s.content;
                        if (s.count > 0) {
                            redactionNote = isInRepoMemory(r.root)
                                ? ` 🔒 Redacted ${s.count} credential value(s) before writing to in-repo memory ` +
                                    `(secrets are kept out of committable .claude/memory; set localMemorySecrets to allow them).`
                                : ` 🔒 Redacted ${s.count} credential value(s) before writing ` +
                                    `(OPENCODE_MEMORY_REDACT_GLOBAL is enabled).`;
                        }
                    }
                    const filePath = saveMemory(r.root, args.file_name, saveName, saveDescription, args.type, saveContent, originSessionId, args.created);
                    return `Memory saved to ${filePath}.${redactionNote}`;
                },
            }),
            memory_delete: tool({
                description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
                args: {
                    file_name: tool.schema.string().describe("File name of the memory to delete (with or without .md extension)"),
                    root: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT normally (this session's repo). Set to a declared extraMemoryRoots path to delete there."),
                },
                async execute(args, _ctx) {
                    const r = resolveToolRoot(args.root);
                    if ("error" in r)
                        return r.error;
                    const deleted = deleteMemory(r.root, args.file_name);
                    return deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`;
                },
            }),
            memory_list: tool({
                description: "List all saved memories with their names, types, and descriptions. " +
                    "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
                    "or when you need to recall what's been stored.",
                args: {
                    root: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT normally (this session's repo). Set to a declared extraMemoryRoots path to list there."),
                },
                async execute(args, ctx) {
                    const r = resolveToolRoot(args.root);
                    if ("error" in r)
                        return r.error;
                    const entries = listMemories(r.root);
                    const callID = getCallID(ctx);
                    if (callID)
                        memoryListCountByCallID.set(callID, entries.length);
                    if (entries.length === 0) {
                        return "No memories saved yet.";
                    }
                    const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.fileName}]${e.created ? ` · created ${e.created.slice(0, 10)}` : ""}: ${e.description}`);
                    return `${entries.length} memories found:\n${lines.join("\n")}`;
                },
            }),
            memory_search: tool({
                description: "Search memories by keyword. Searches across names, descriptions, and content. " +
                    "Use this to find relevant memories before answering questions or when the user references past conversations.",
                args: {
                    query: tool.schema.string().describe("Search query — searches across name, description, and content"),
                    root: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT normally (this session's repo). Set to a declared extraMemoryRoots path to search there."),
                },
                async execute(args, ctx) {
                    const r = resolveToolRoot(args.root);
                    if ("error" in r)
                        return r.error;
                    const results = searchMemories(r.root, args.query);
                    const callID = getCallID(ctx);
                    if (callID)
                        memorySearchCountByCallID.set(callID, results.length);
                    if (results.length === 0) {
                        return `No memories matching "${args.query}".`;
                    }
                    const lines = results.map((e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}\n  Content: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`);
                    return `${results.length} matches for "${args.query}":\n${lines.join("\n")}`;
                },
            }),
            memory_read: tool({
                description: "Read the full content of a specific memory file.",
                args: {
                    file_name: tool.schema.string().describe("File name of the memory to read (with or without .md extension)"),
                    root: tool.schema
                        .string()
                        .optional()
                        .describe("OMIT for this session's repo. Set to a declared extraMemoryRoots path (e.g. one shown in an " +
                        "'Additional memory index' block) to read that repo's memory."),
                },
                async execute(args, _ctx) {
                    const r = resolveToolRoot(args.root);
                    if ("error" in r)
                        return r.error;
                    const entry = readMemory(r.root, args.file_name);
                    if (!entry) {
                        return `Memory "${args.file_name}" not found.`;
                    }
                    const createdLine = entry.created ? `\n**Created:** ${entry.created}` : "";
                    return `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}${createdLine}\n\n${entry.content}`;
                },
            }),
            harness_feedback: tool({
                description: "Record feedback for the HARNESS DEVELOPER (not agent memory). Use this — " +
                    "instead of memory_save — when a finding is about how YOU or your skills/tools " +
                    "BEHAVED, or how the harness should change: tool-use inefficiency (redundant " +
                    "reads, retry loops, errors not surfacing), a skill that described instead of " +
                    "acted, a missing background loop, an unclear tool description, or anything whose " +
                    "fix is a diff to the system prompt / agent config / a skill rather than a fact " +
                    "to recall next session. These entries are never recalled into agent context.",
                args: {
                    title: tool.schema.string().describe("Short headline for the observation"),
                    category: tool.schema
                        .enum(HARNESS_FEEDBACK_CATEGORIES)
                        .describe("tool-efficiency | agent-behavior | skill-design | harness-config | other"),
                    body: tool.schema
                        .string()
                        .describe("What was observed and the suggested harness/prompt/skill change. Be concrete."),
                },
                async execute(args, ctx) {
                    const originSessionId = typeof ctx?.sessionID === "string"
                        ? ctx.sessionID
                        : undefined;
                    const path = saveHarnessFeedback(memoryRoot, args.title, args.category, args.body, originSessionId);
                    return `Harness feedback recorded in ${path} (not saved as memory).`;
                },
            }),
        },
    };
};
