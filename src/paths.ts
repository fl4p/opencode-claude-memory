// Claude Code compatible memory directory path resolution.
// Directory: ~/.claude/projects/<sanitizePath(canonicalGitRoot)>/memory/
// Ensures bidirectional memory sharing between Claude Code and OpenCode.

import { homedir } from "os"
import { join, dirname, resolve, sep } from "path"
import { mkdirSync, existsSync, readFileSync, statSync, realpathSync } from "fs"

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export const MAX_MEMORY_FILES = 200
export const MAX_MEMORY_FILE_BYTES = 40_000
export const FRONTMATTER_MAX_LINES = 30

export function validateMemoryFileName(fileName: string): string {
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName

  if (base.length === 0) {
    throw new Error("Memory file name cannot be empty")
  }
  if (base.includes("/") || base.includes("\\")) {
    throw new Error(`Memory file name must not contain path separators: ${fileName}`)
  }
  if (base.includes("..")) {
    throw new Error(`Memory file name must not contain path traversal: ${fileName}`)
  }
  if (base.includes("\0")) {
    throw new Error(`Memory file name must not contain null bytes: ${fileName}`)
  }
  if (base.startsWith(".")) {
    throw new Error(`Memory file name must not start with '.': ${fileName}`)
  }
  if (base.toUpperCase() === "MEMORY") {
    throw new Error(`'MEMORY' is a reserved name and cannot be used as a memory file name`)
  }

  return `${base}.md`
}

const MAX_SANITIZED_LENGTH = 200

// Exact copy of Claude Code's djb2Hash() from utils/hash.ts
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

// Exact copy of Claude Code's sanitizePath() from utils/sessionStoragePortable.ts
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash = simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// Matches Claude Code's findGitRoot() from utils/git.ts
function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath)
  const root = current.substring(0, current.indexOf(sep) + 1) || sep

  while (current !== root) {
    try {
      const gitPath = join(current, ".git")
      const s = statSync(gitPath)
      if (s.isDirectory() || s.isFile()) {
        return current.normalize("NFC")
      }
    } catch {}
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  try {
    const gitPath = join(root, ".git")
    const s = statSync(gitPath)
    if (s.isDirectory() || s.isFile()) {
      return root.normalize("NFC")
    }
  } catch {}

  return null
}

// Matches Claude Code's resolveCanonicalRoot() from utils/git.ts
// Resolves worktrees to the main repo root via .git -> gitdir -> commondir chain
function resolveCanonicalRoot(gitRoot: string): string {
  try {
    const gitContent = readFileSync(join(gitRoot, ".git"), "utf-8").trim()
    if (!gitContent.startsWith("gitdir:")) {
      return gitRoot
    }
    const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim())

    const commonDir = resolve(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim(),
    )

    // SECURITY: validate worktreeGitDir is a direct child of <commonDir>/worktrees/
    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot
    }

    // SECURITY: validate gitdir back-link points to our .git
    const backlink = realpathSync(
      readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim(),
    )
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot
    }

    if (commonDir.endsWith(`${sep}.git`) || commonDir.endsWith("/.git")) {
      return dirname(commonDir).normalize("NFC")
    }

    return commonDir.normalize("NFC")
  } catch {
    return gitRoot
  }
}

export function findCanonicalGitRoot(startPath: string): string | null {
  const root = findGitRoot(startPath)
  if (!root) return null
  return resolveCanonicalRoot(root)
}

function getClaudeConfigHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")
}

export function getProjectDir(worktree: string): string {
  const canonicalRoot = findCanonicalGitRoot(worktree) ?? worktree
  return join(getClaudeConfigHomeDir(), "projects", sanitizePath(canonicalRoot))
}

// ---------------------------------------------------------------------------
// Local (in-repo) memory mode
//
// By default memory lives in the global Claude store
// (~/.claude/projects/<root>/memory/). Set OPENCODE_MEMORY_LOCAL (or the
// opencode.json plugin option `localMemory`) to keep memory INSIDE the repo at
// <gitRoot>/.claude/memory/ so it can be committed, diffed, and reviewed
// alongside the code.
//
//   off / 0 / false / global — always the global store (never local)
//   on  / 1 / true  / local  — always the in-repo folder (created if absent)
//   auto (default)           — the in-repo folder ONLY if it already exists,
//                              otherwise the global store
//
// Precedence: env var > plugin option > "auto". The env var ALWAYS wins so a
// single shell can override per invocation (matching getRecallModel).
export type LocalMemoryMode = "auto" | "on" | "off"

export const LOCAL_MEMORY_DIRNAME = join(".claude", "memory")

let pluginLocalMemoryMode: LocalMemoryMode | undefined

function parseLocalMemoryMode(raw: unknown): LocalMemoryMode | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  if (!v) return undefined
  if (v === "auto") return "auto"
  if (v === "on" || v === "1" || v === "true" || v === "yes" || v === "local") return "on"
  if (v === "off" || v === "0" || v === "false" || v === "no" || v === "global") return "off"
  return undefined
}

// Captured from the opencode.json plugin `options` block on construction (see
// index.ts). Always (re)set — never early-return on undefined — or a stale mode
// from a prior construction would leak in via module state.
export function setLocalMemoryMode(raw: unknown): void {
  pluginLocalMemoryMode = parseLocalMemoryMode(raw)
}

export function getLocalMemoryMode(): LocalMemoryMode {
  return parseLocalMemoryMode(process.env.OPENCODE_MEMORY_LOCAL) ?? pluginLocalMemoryMode ?? "auto"
}

// In-repo memory directory: <canonical git root>/.claude/memory. Keyed by the
// SAME canonical root as the global store, so worktrees of one repo share it.
export function getLocalMemoryDir(worktree: string): string {
  const root = findCanonicalGitRoot(worktree) ?? worktree
  return join(root, LOCAL_MEMORY_DIRNAME)
}

// The session's own repo, captured by MemoryPlugin. The local on/off mode is a
// statement about where THIS session stores memory — it must NOT force the
// in-repo store onto OTHER repos surfaced via extraMemoryRoots. So extra roots
// are resolved as if mode were "auto" (adopt in-repo only if it already exists),
// which stops `localMemory:on` from littering a foreign repo with .claude/memory
// just because we read its index. Cleared (undefined) outside a plugin session,
// where every call is implicitly about the one worktree in hand.
let sessionMemoryRoot: string | undefined
export function setSessionMemoryRoot(worktree: string | undefined): void {
  sessionMemoryRoot = worktree ? (findCanonicalGitRoot(worktree) ?? worktree) : undefined
}

function isSessionRoot(worktree: string): boolean {
  if (!sessionMemoryRoot) return true
  return (findCanonicalGitRoot(worktree) ?? worktree) === sessionMemoryRoot
}

// The on/off/auto mode that actually applies to a given worktree: the configured
// mode for the session's own repo, "auto" for any other (extra) root.
function effectiveLocalMode(worktree: string): LocalMemoryMode {
  return isSessionRoot(worktree) ? getLocalMemoryMode() : "auto"
}

// ---------------------------------------------------------------------------
// In-repo secret policy
//
// Secret VALUES are acceptable in the GLOBAL ~/.claude store (private to the
// user) but NOT in an in-repo .claude/memory store, which may be committed and
// pushed (even a private repo can later go public). So writes to in-repo memory
// are run through a deterministic credential scrub UNLESS the user explicitly
// opts in via OPENCODE_MEMORY_LOCAL_SECRETS / opencode.json `localMemorySecrets`.
let pluginLocalMemorySecrets: boolean | undefined

function parseBoolish(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  if (!v) return undefined
  if (v === "on" || v === "1" || v === "true" || v === "yes" || v === "allow") return true
  if (v === "off" || v === "0" || v === "false" || v === "no" || v === "deny") return false
  return undefined
}

export function setLocalMemorySecretsAllowed(raw: unknown): void {
  pluginLocalMemorySecrets = parseBoolish(raw)
}

// Default false: scrub by default. env > plugin option > false.
export function localMemorySecretsAllowed(): boolean {
  return parseBoolish(process.env.OPENCODE_MEMORY_LOCAL_SECRETS) ?? pluginLocalMemorySecrets ?? false
}

// True when the active store for this worktree is the in-repo folder (NOT the
// global ~/.claude store). Compared without mutating state — it does not create
// directories, unlike getMemoryDir.
export function isInRepoMemory(worktree: string): boolean {
  const mode = effectiveLocalMode(worktree)
  if (mode === "off") return false
  if (mode === "on") return true
  return isExistingDir(getLocalMemoryDir(worktree)) // auto: only if already adopted
}

// True when the in-repo store is active AND not opted into secrets — i.e. an
// in-repo write must be scrubbed. (Kept as a named predicate for the in-repo case.)
export function shouldRedactInRepoMemory(worktree: string): boolean {
  return isInRepoMemory(worktree) && !localMemorySecretsAllowed()
}

// Defense-in-depth for the GLOBAL store. Secret VALUES are allowed there by
// default (it is the user's private ~/.claude), so a programmatic scrub of the
// global path is OPT-IN: enable it to run the same deterministic credential
// scrub on global writes too, for users who want belt-and-suspenders over the
// prompt-only guard. env OPENCODE_MEMORY_REDACT_GLOBAL > plugin option > false.
let pluginRedactGlobalSecrets: boolean | undefined
export function setRedactGlobalSecrets(raw: unknown): void {
  pluginRedactGlobalSecrets = parseBoolish(raw)
}
export function redactGlobalSecrets(): boolean {
  return parseBoolish(process.env.OPENCODE_MEMORY_REDACT_GLOBAL) ?? pluginRedactGlobalSecrets ?? false
}

// The actual decision for ANY memory write: in-repo writes scrub by default
// (opt-out via localMemorySecrets); global writes scrub only when opted in.
export function shouldRedactMemory(worktree: string): boolean {
  if (isInRepoMemory(worktree)) return !localMemorySecretsAllowed()
  return redactGlobalSecrets()
}

// ---------------------------------------------------------------------------
// Index size limit (soft, advisory)
//
// A configurable line budget for the MEMORY.md index. When the index reaches it,
// the plugin asks the agent to warn the user ONCE and offer compaction (cluster
// duplicates, drop stale, shorten entries). This is SEPARATE from the hard
// MAX_ENTRYPOINT_LINES cap that truncates what gets loaded into context.
//
//   <unset>  — default to MAX_ENTRYPOINT_LINES
//   0 / off  — disable the warning entirely
//   N        — warn once the index has N or more lines
//
// Precedence: env OPENCODE_MEMORY_INDEX_MAX_LINES > plugin option > default.
// Default sits at 80% of the hard cap so the warning lands before truncation.
export const DEFAULT_INDEX_MAX_LINES = Math.floor(MAX_ENTRYPOINT_LINES * 0.8)
let pluginIndexMaxLines: number | undefined

function parseIndexMaxLines(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase()
    if (!v) return undefined
    if (v === "off" || v === "none" || v === "false") return 0
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN
  // Negative / non-finite values are treated as UNSET (fall back to the next
  // layer), not as 0 — so a fat-fingered "-1" can't silently disable the warning
  // the way an explicit "0"/"off" intentionally does.
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

export function setIndexMaxLines(raw: unknown): void {
  pluginIndexMaxLines = parseIndexMaxLines(raw)
}

// Returns 0 when the warning is disabled. Defaults below the hard
// MAX_ENTRYPOINT_LINES cap so the user is warned with some lead time BEFORE the
// index starts getting truncated, not at the exact moment truncation begins.
export function getIndexMaxLines(): number {
  const env = parseIndexMaxLines(process.env.OPENCODE_MEMORY_INDEX_MAX_LINES)
  return env ?? pluginIndexMaxLines ?? DEFAULT_INDEX_MAX_LINES
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function getMemoryDir(worktree: string): string {
  // Mode applies to the session's own repo; extra roots resolve as "auto" so we
  // never force-create an in-repo store inside a foreign repo (see effectiveLocalMode).
  const mode = effectiveLocalMode(worktree)
  if (mode !== "off") {
    const localDir = getLocalMemoryDir(worktree)
    // "on" forces the in-repo folder (creating it). "auto" adopts it only when
    // the user has already opted in by creating it AS A DIRECTORY — a stray file
    // or symlink at that path must not hijack the store or crash the first write.
    if (mode === "on" || isExistingDir(localDir)) {
      ensureDir(localDir)
      return localDir
    }
  }
  const memoryDir = join(getProjectDir(worktree), "memory")
  ensureDir(memoryDir)
  return memoryDir
}

export function getMemoryEntrypoint(worktree: string): string {
  return join(getMemoryDir(worktree), ENTRYPOINT_NAME)
}

export function isMemoryPath(absolutePath: string, worktree: string): boolean {
  const memDir = getMemoryDir(worktree)
  return absolutePath.startsWith(memDir)
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}
