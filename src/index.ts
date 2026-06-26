import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { parse, resolve } from "path"
import { buildMemorySystemPrompt, buildIndexLimitWarning } from "./prompt.js"
import { formatRecalledMemories, recallSelectedMemories, type RecalledMemory } from "./recall.js"
import { isSupportedRecallSelectorClient, selectRelevantMemoryFilenames, type SessionClient } from "./recallSelector.js"
import { scanMemoryFiles, getMemoryManifest, type MemoryHeader } from "./memoryScan.js"
import {
  saveMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  readMemory,
  readIndex,
  MEMORY_TYPES,
} from "./memory.js"
import { getMemoryDir, findCanonicalGitRoot, setLocalMemoryMode, setIndexMaxLines } from "./paths.js"
import { saveHarnessFeedback, HARNESS_FEEDBACK_CATEGORIES } from "./harness.js"

// Per-turn derived state — overwritten each time messages.transform fires.
// This replaces the old process-global session Maps so that compact naturally
// resets both alreadySurfaced and recentTools (the messages shrink after compact,
// so the derived state shrinks with them).
type TurnContext = {
  turnID: string
  query?: string
  alreadySurfaced: Set<string>
  recentTools: string[]
  recallPrefetch?: RecallPrefetch
}

type RecallPrefetch = {
  turnID: string
  settled: boolean
  consumed: boolean
  result: RecalledMemory[]
}

const turnContextBySession = new Map<string, TurnContext>()
const selectorSessionIDs = new Set<string>()
// Sessions that have already been shown the index-size-limit warning, so the
// agent is asked to warn the user at most once per session (see prompt.ts).
const indexLimitWarnedSessions = new Set<string>()

function shouldIgnoreMemoryContext(query: string | undefined): boolean {
  if (process.env.OPENCODE_MEMORY_IGNORE === "1") return true
  if (!query) return false

  const normalized = query.toLowerCase()
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  )
}

function extractUserQuery(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined

  if ("content" in message) {
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") return content
    if (content !== undefined) return JSON.stringify(content)
  }

  if ("parts" in message) {
    const parts = (message as { parts?: unknown }).parts
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          return typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
      if (text) return text
    }
  }

  return undefined
}

function getLastUserQuery(messages: Array<{ info?: { id?: unknown; role?: unknown; sessionID?: unknown }; parts?: unknown }>): {
  query?: string
  sessionID?: string
  messageID?: string
  messageIndex?: number
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "user") continue

    const query = extractUserQuery(message)
    const sessionID = typeof message.info?.sessionID === "string" ? message.info.sessionID : undefined
    const messageID = typeof message.info?.id === "string" ? message.info.id : undefined
    return { query, sessionID, messageID, messageIndex: i }
  }

  return {}
}

function isAutoMemoryPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  return typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.includes("# Auto Memory")
}

// Parses "### <name> (<type>)" headers from the ## Recalled Memories section
// of system prompts. After compaction old system messages disappear, so
// the returned set naturally shrinks — no manual reset needed.
function extractSurfacedMemoryKeys(systemText: string): Set<string> {
  const keys = new Set<string>()
  const recalledSection = systemText.indexOf("## Recalled Memories")
  if (recalledSection === -1) return keys

  const headerPattern = /^### (.+?) \((\w+)\)/gm
  const section = systemText.slice(recalledSection)
  for (let match = headerPattern.exec(section); match !== null; match = headerPattern.exec(section)) {
    keys.add(`${match[1]}|${match[2]}`)
  }
  return keys
}

// Only completed tools — matches Claude Code's collectRecentSuccessfulTools().
function extractRecentTools(
  messages: Array<{ info?: { role?: unknown }; parts?: unknown[] }>,
): string[] {
  const tools: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (!message.parts || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue
      const p = part as { type?: string; tool?: string; state?: { status?: string } }
      if (p.type !== "tool" || !p.tool) continue
      if (p.state?.status !== "completed") continue
      if (seen.has(p.tool)) continue
      seen.add(p.tool)
      tools.push(p.tool)
    }
  }
  return tools
}

// Settings passed via the plugin's `options` bag in opencode.json (the native
// per-plugin config surface). Captured once when the plugin loads. Environment
// variables still take precedence over these. Only recall* is consumed here —
// extract*/dream* run in the wrapper (bin/opencode-memory), which reads the same
// options block from opencode.json itself.
let pluginRecallModel: string | undefined
let pluginRecallAgent: string | undefined
let pluginExtraRoots: string[] = []

function asOptionString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function asOptionStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
}

// Always (re)set on construction — never early-return on missing options, or
// stale recall settings from a prior construction would leak in (module state).
function recordPluginOptions(options: Record<string, unknown> | undefined): void {
  pluginRecallModel = asOptionString(options?.recallModel)
  pluginRecallAgent = asOptionString(options?.recallAgent)
  pluginExtraRoots = asOptionStringArray(options?.extraMemoryRoots)
  // Local (in-repo) memory mode. env OPENCODE_MEMORY_LOCAL still takes
  // precedence (resolved in paths.ts); always set so a stale mode can't leak in.
  setLocalMemoryMode(options?.localMemory)
  // Soft index-size limit. env OPENCODE_MEMORY_INDEX_MAX_LINES takes precedence.
  setIndexMaxLines(options?.indexMaxLines)
}

// Additional memory roots whose index is surfaced read-only this session and
// which the memory_* tools may target via their `root` arg. The env var REPLACES
// the option when set (scalar precedence, matching getRecallModel). Each entry is
// a repo path (a git root or any directory); env entries split on , ; : newline.
function getExtraRoots(): string[] {
  const env = process.env.OPENCODE_MEMORY_EXTRA_ROOTS
  if (env && env.trim()) {
    return env
      .split(/[,;:\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return pluginExtraRoots
}

function getRecallAgent(): string {
  return process.env.OPENCODE_MEMORY_RECALL_AGENT || pluginRecallAgent || "opencode-memory-recall"
}

function getRecallModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.OPENCODE_MEMORY_RECALL_MODEL || pluginRecallModel
  if (!raw) return undefined

  const slashIdx = raw.indexOf("/")
  if (slashIdx <= 0 || slashIdx === raw.length - 1) return undefined
  return {
    providerID: raw.slice(0, slashIdx),
    modelID: raw.slice(slashIdx + 1),
  }
}

function isRootPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === parse(resolved).root
}

function resolveMemoryRoot(worktree: string, directory: string): string {
  if (isRootPath(worktree) && !isRootPath(directory)) return directory
  return worktree
}

function isUsefulRecallQuery(query: string | undefined): query is string {
  const trimmed = query?.trim()
  if (!trimmed) return false
  if (/\s/.test(trimmed)) return true
  return /[\u3400-\u9fff]/.test(trimmed) && trimmed.length >= 4
}

function buildTurnID(
  sessionID: string,
  messageID: string | undefined,
  messageIndex: number | undefined,
  query: string | undefined,
): string {
  return `${sessionID}:${messageID ?? `${messageIndex ?? -1}:${query ?? ""}`}`
}

function alreadySurfacedKey(header: MemoryHeader): string {
  return `${header.name ?? header.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${header.type ?? "user"}`
}

function startRecallPrefetch(input: {
  client: SessionClient | undefined
  directory: string
  worktree: string
  parentSessionID: string
  turnID: string
  query: string | undefined
  alreadySurfaced: ReadonlySet<string>
  recentTools: readonly string[]
}): RecallPrefetch | undefined {
  if (!input.client || !isUsefulRecallQuery(input.query)) return undefined

  if (!isSupportedRecallSelectorClient(input.client)) return undefined

  const memoryDir = getMemoryDir(input.worktree)
  const headers = scanMemoryFiles(memoryDir).filter((header) => !input.alreadySurfaced.has(alreadySurfacedKey(header)))
  if (headers.length === 0) return undefined

  const handle: RecallPrefetch = {
    turnID: input.turnID,
    settled: false,
    consumed: false,
    result: [],
  }

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
    .catch(() => [])

  void promise.then((result) => {
    handle.result = result
  }).finally(() => {
    handle.settled = true
  })

  return handle
}

function consumeRecallPrefetch(ctx: TurnContext | undefined): RecalledMemory[] {
  const prefetch = ctx?.recallPrefetch
  if (!prefetch || !prefetch.settled || prefetch.consumed) return []

  prefetch.consumed = true
  return prefetch.result
}

// Tracks how many memory entries a memory_list call saw so tool.execute.after
// can render a meaningful title without re-reading the filesystem. Keyed by
// callID, which uniquely identifies a single tool invocation.
const memoryListCountByCallID = new Map<string, number>()
const memorySearchCountByCallID = new Map<string, number>()

function buildMemoryToolTitle(
  toolID: string,
  args: Record<string, unknown> | undefined,
  callID: string | undefined,
): string | undefined {
  switch (toolID) {
    case "memory_save": {
      const type = typeof args?.type === "string" ? args.type : ""
      const name = typeof args?.name === "string" ? args.name : ""
      if (type && name) return `${type}: ${name}`
      if (name) return name
      return undefined
    }
    case "memory_delete":
    case "memory_read": {
      const fileName = typeof args?.file_name === "string" ? args.file_name : ""
      return fileName || undefined
    }
    case "memory_list": {
      const count = callID ? memoryListCountByCallID.get(callID) : undefined
      if (callID) memoryListCountByCallID.delete(callID)
      if (count === undefined) return "list memories"
      return `${count} ${count === 1 ? "memory" : "memories"}`
    }
    case "memory_search": {
      const query = typeof args?.query === "string" ? args.query : ""
      const count = callID ? memorySearchCountByCallID.get(callID) : undefined
      if (callID) memorySearchCountByCallID.delete(callID)
      if (query && count !== undefined) {
        return `"${query}" · ${count} ${count === 1 ? "match" : "matches"}`
      }
      if (query) return `"${query}"`
      return undefined
    }
    default:
      return undefined
  }
}

function getCallID(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined
  const v = (ctx as { callID?: unknown }).callID
  return typeof v === "string" ? v : undefined
}

export const MemoryPlugin: Plugin = async ({ worktree, directory, client }, options) => {
  directory ??= worktree
  recordPluginOptions(options)
  const memoryRoot = resolveMemoryRoot(worktree, directory)
  getMemoryDir(memoryRoot)

  // Resolve a tool's optional `root` arg against the allowlist (this session's
  // repo + declared extraMemoryRoots). An omitted root means "this session's
  // repo"; an undeclared root is REJECTED — this is what stops the model from
  // writing memory to an arbitrary path. Compared by canonical git root so a
  // subdir/worktree of an allowed repo still resolves.
  const canonicalRoot = (p: string): string => findCanonicalGitRoot(p) ?? resolve(p)
  const allowedRoots = (): string[] => [memoryRoot, ...getExtraRoots()]
  const resolveToolRoot = (rootArg: unknown): { root: string } | { error: string } => {
    if (typeof rootArg !== "string" || !rootArg.trim()) return { root: memoryRoot }
    const want = canonicalRoot(rootArg.trim())
    for (const r of allowedRoots()) {
      if (canonicalRoot(r) === want) return { root: r }
    }
    return {
      error:
        `Memory root "${rootArg}" is not allowed. Declare it in opencode.json plugin ` +
        `options.extraMemoryRoots (or the OPENCODE_MEMORY_EXTRA_ROOTS env var) first. ` +
        `Allowed roots: ${allowedRoots().join(", ")}`,
    }
  }

  return {
    config: async (config) => {
      const agentName = getRecallAgent()
      const mutable = config as {
        agent?: Record<string, Record<string, unknown>>
      }
      mutable.agent ??= {}
      mutable.agent[agentName] ??= {
        mode: "all",
        hidden: true,
        prompt: "Select up to 5 relevant memory filenames for the current user query. Return only the requested structured output.",
      }
    },

    "chat.params": async (input, output) => {
      if (input.agent !== getRecallAgent()) return
      output.temperature = 0
      output.options = {
        ...output.options,
        maxOutputTokens: 256,
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "harness_feedback") {
        const title = typeof input.args?.title === "string" ? input.args.title : undefined
        if (title) output.title = `harness: ${title}`
        return
      }
      if (!input.tool.startsWith("memory_")) return
      const title = buildMemoryToolTitle(input.tool, input.args, input.callID)
      if (title) output.title = title
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const { query, sessionID, messageID, messageIndex } = getLastUserQuery(output.messages)
      if (sessionID && selectorSessionIDs.has(sessionID)) return

      if (sessionID) {
        const alreadySurfaced = new Set<string>()
        for (const message of output.messages) {
          const role = String(message.info.role)
          if (role !== "system") continue
          for (const part of message.parts) {
            if (!part || typeof part !== "object") continue
            const text = (part as { text?: string }).text
            if (typeof text === "string") {
              for (const key of extractSurfacedMemoryKeys(text)) {
                alreadySurfaced.add(key)
              }
            }
          }
        }

        const recentTools = extractRecentTools(
          output.messages as Array<{ info?: { role?: unknown }; parts?: unknown[] }>,
        )

        const turnID = buildTurnID(sessionID, messageID, messageIndex, query)
        const existing = turnContextBySession.get(sessionID)
        const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query)
        let recallPrefetch: RecallPrefetch | undefined
        if (!ignoreMemoryContext) {
          recallPrefetch = existing?.turnID === turnID
            ? existing.recallPrefetch
            : startRecallPrefetch({
              client: client as unknown as SessionClient,
              directory,
              worktree: memoryRoot,
              parentSessionID: sessionID,
              turnID,
              query,
              alreadySurfaced,
              recentTools,
            })
        }

        turnContextBySession.set(sessionID, { turnID, query, alreadySurfaced, recentTools, recallPrefetch })
      }

      if (shouldIgnoreMemoryContext(query)) {
        output.messages = output.messages
          .map((message) => {
            const role = String(message.info.role)
            if (role !== "system") return message

            const parts = message.parts.filter((part) => !isAutoMemoryPart(part))
            return { ...message, parts }
          })
          .filter((message) => message.parts.length > 0)
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      let sessionID: string | undefined
      if (_input && typeof _input === "object") {
        sessionID = typeof (_input as { sessionID?: unknown }).sessionID === "string"
          ? (_input as { sessionID?: string }).sessionID
          : undefined
      }
      if (sessionID && selectorSessionIDs.has(sessionID)) return

      const ctx = sessionID ? turnContextBySession.get(sessionID) : undefined
      const query = ctx?.query

      const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query)
      const recalled = ignoreMemoryContext ? [] : consumeRecallPrefetch(ctx)

      const recalledSection = formatRecalledMemories(recalled)
      let memoryPrompt = buildMemorySystemPrompt(memoryRoot, recalledSection, {
        includeIndex: !ignoreMemoryContext,
      })
      // Surface declared extra roots read-only (index only — no per-root recall).
      // Appended to the SAME system string so consumers still see one Auto Memory
      // block. Suppressed under the ignore-memory gate like the primary index.
      if (!ignoreMemoryContext) {
        for (const root of getExtraRoots()) {
          if (canonicalRoot(root) === canonicalRoot(memoryRoot)) continue
          let manifest = ""
          let count = 0
          try {
            const m = getMemoryManifest(root)
            manifest = m.manifest
            count = m.headers.length
          } catch {
            continue
          }
          if (count === 0) continue
          memoryPrompt +=
            `\n\n## Additional memory index — ${root}\n\n` +
            `Read-only index of another repo's curated memory. To read an entry, call ` +
            `memory_read with root:"${root}". Note: memory_save and memory_delete still ` +
            `target THIS session's repo unless you pass the same root.\n\n${manifest}`
        }
      }
      // Once per session, if the index has hit the configured soft limit, ask the
      // agent to warn the user and offer compaction. Latched so it isn't repeated
      // every turn; only when the index is actually loaded (not under ignore).
      if (!ignoreMemoryContext && sessionID && !indexLimitWarnedSessions.has(sessionID)) {
        const warning = buildIndexLimitWarning(readIndex(memoryRoot))
        if (warning) {
          memoryPrompt += `\n\n${warning}`
          indexLimitWarnedSessions.add(sessionID)
        }
      }
      output.system.push(memoryPrompt)
    },

    tool: {
      memory_save: tool({
        description:
          "Save or update a memory for future conversations. " +
          "Each memory is stored as a markdown file with frontmatter. " +
          "Use this when the user explicitly asks you to remember something, " +
          "or when you observe important information worth preserving across sessions " +
          "(user preferences, feedback, project context, external references). " +
          "Check existing memories first with memory_list or memory_search to avoid duplicates.",
        args: {
          file_name: tool.schema
            .string()
            .describe(
              'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"',
            ),
          name: tool.schema.string().describe("Human-readable name for this memory"),
          description: tool.schema
            .string()
            .describe("One-line description — used to decide relevance in future conversations, so be specific"),
          type: tool.schema
            .enum(MEMORY_TYPES)
            .describe(
              "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
            ),
          content: tool.schema
            .string()
            .describe(
              "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines",
            ),
          created: tool.schema
            .string()
            .optional()
            .describe(
              "OMIT this normally — `created` is auto-stamped to now. Set it ONLY when consolidating duplicate " +
                "memories: pass the oldest source memory's `created` value (an ISO-8601 timestamp) so the manifest " +
                "sort order stays accurate after the merge.",
            ),
          root: tool.schema
            .string()
            .optional()
            .describe(
              "OMIT normally — defaults to THIS session's repo. Set ONLY to write to another repo whose path is " +
                "declared in the plugin's extraMemoryRoots; pass that repo's absolute path. Any other path is rejected.",
            ),
        },
        async execute(args, ctx) {
          const r = resolveToolRoot(args.root)
          if ("error" in r) return r.error
          // ToolContext carries the originating sessionID; record it as
          // memory provenance, matching Claude Code's on-disk metadata. The
          // guard keeps the unit-test mock (which passes only { callID }) working.
          const originSessionId =
            typeof (ctx as { sessionID?: unknown })?.sessionID === "string"
              ? (ctx as { sessionID?: string }).sessionID
              : undefined
          const filePath = saveMemory(
            r.root,
            args.file_name,
            args.name,
            args.description,
            args.type,
            args.content,
            originSessionId,
            args.created,
          )
          return `Memory saved to ${filePath}`
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
          const r = resolveToolRoot(args.root)
          if ("error" in r) return r.error
          const deleted = deleteMemory(r.root, args.file_name)
          return deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`
        },
      }),

      memory_list: tool({
        description:
          "List all saved memories with their names, types, and descriptions. " +
          "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
          "or when you need to recall what's been stored.",
        args: {
          root: tool.schema
            .string()
            .optional()
            .describe("OMIT normally (this session's repo). Set to a declared extraMemoryRoots path to list there."),
        },
        async execute(args, ctx) {
          const r = resolveToolRoot(args.root)
          if ("error" in r) return r.error
          const entries = listMemories(r.root)
          const callID = getCallID(ctx)
          if (callID) memoryListCountByCallID.set(callID, entries.length)
          if (entries.length === 0) {
            return "No memories saved yet."
          }
          const lines = entries.map(
            (e) =>
              `- **${e.name}** (${e.type}) [${e.fileName}]${e.created ? ` · created ${e.created.slice(0, 10)}` : ""}: ${e.description}`,
          )
          return `${entries.length} memories found:\n${lines.join("\n")}`
        },
      }),

      memory_search: tool({
        description:
          "Search memories by keyword. Searches across names, descriptions, and content. " +
          "Use this to find relevant memories before answering questions or when the user references past conversations.",
        args: {
          query: tool.schema.string().describe("Search query — searches across name, description, and content"),
          root: tool.schema
            .string()
            .optional()
            .describe("OMIT normally (this session's repo). Set to a declared extraMemoryRoots path to search there."),
        },
        async execute(args, ctx) {
          const r = resolveToolRoot(args.root)
          if ("error" in r) return r.error
          const results = searchMemories(r.root, args.query)
          const callID = getCallID(ctx)
          if (callID) memorySearchCountByCallID.set(callID, results.length)
          if (results.length === 0) {
            return `No memories matching "${args.query}".`
          }
          const lines = results.map(
            (e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}\n  Content: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`,
          )
          return `${results.length} matches for "${args.query}":\n${lines.join("\n")}`
        },
      }),

      memory_read: tool({
        description: "Read the full content of a specific memory file.",
        args: {
          file_name: tool.schema.string().describe("File name of the memory to read (with or without .md extension)"),
          root: tool.schema
            .string()
            .optional()
            .describe(
              "OMIT for this session's repo. Set to a declared extraMemoryRoots path (e.g. one shown in an " +
                "'Additional memory index' block) to read that repo's memory.",
            ),
        },
        async execute(args, _ctx) {
          const r = resolveToolRoot(args.root)
          if ("error" in r) return r.error
          const entry = readMemory(r.root, args.file_name)
          if (!entry) {
            return `Memory "${args.file_name}" not found.`
          }
          const createdLine = entry.created ? `\n**Created:** ${entry.created}` : ""
          return `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}${createdLine}\n\n${entry.content}`
        },
      }),

      harness_feedback: tool({
        description:
          "Record feedback for the HARNESS DEVELOPER (not agent memory). Use this — " +
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
            .describe(
              "tool-efficiency | agent-behavior | skill-design | harness-config | other",
            ),
          body: tool.schema
            .string()
            .describe(
              "What was observed and the suggested harness/prompt/skill change. Be concrete.",
            ),
        },
        async execute(args, ctx) {
          const originSessionId =
            typeof (ctx as { sessionID?: unknown })?.sessionID === "string"
              ? (ctx as { sessionID?: string }).sessionID
              : undefined
          const path = saveHarnessFeedback(
            memoryRoot,
            args.title,
            args.category,
            args.body,
            originSessionId,
          )
          return `Harness feedback recorded in ${path} (not saved as memory).`
        },
      }),
    },
  }
}
