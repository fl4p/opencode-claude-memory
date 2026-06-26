import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs"
import { join, basename } from "path"
import {
  getMemoryDir,
  getMemoryEntrypoint,
  ENTRYPOINT_NAME,
  validateMemoryFileName,
  shouldRedactInRepoMemory,
  MAX_MEMORY_FILES,
  MAX_MEMORY_FILE_BYTES,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  FRONTMATTER_MAX_LINES,
} from "./paths.js"
import { scrubMemoryFields } from "./redact.js"

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

// Provenance stamp written into every memory this plugin saves, so plugin-authored
// memories are distinguishable from ones Claude Code's own memory subsystem wrote
// in the shared store. Claude Code (and our parser) ignore unknown metadata fields,
// so this stays byte-compatible.
export const MEMORY_GENERATOR = "opencode-claude-memory"

export type MemoryEntry = {
  filePath: string
  fileName: string
  name: string
  description: string
  type: MemoryType
  created: string
  content: string
  rawContent: string
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, content: trimmed }
  }

  const lines = trimmed.split("\n")
  let closingLineIdx = -1
  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    if (lines[i].trimEnd() === "---") {
      closingLineIdx = i
      break
    }
  }
  if (closingLineIdx === -1) {
    return { frontmatter: {}, content: trimmed }
  }

  const endIndex = lines.slice(0, closingLineIdx).join("\n").length + 1

  const frontmatterBlock = trimmed.slice(3, endIndex).trim()
  const content = trimmed.slice(endIndex + 3).trim()

  const frontmatter: Record<string, string> = {}
  for (const line of frontmatterBlock.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      frontmatter[key] = value
    }
  }

  return { frontmatter, content }
}

// Emit the nested `metadata` block that Claude Code's memory subsystem writes
// on disk (a memory is a node in its memory graph). The flat top-level `type:`
// of older Claude Code releases is gone; aligning here keeps files written by
// this plugin byte-compatible with Claude Code's store. `parseFrontmatter`
// reads both the nested and the legacy flat form, so reads stay compatible.
function buildFrontmatter(
  name: string,
  description: string,
  type: MemoryType,
  originSessionId?: string,
  created?: string,
): string {
  // `created` is a top-level sort key (Claude Code's auto-dream copies it from
  // the oldest source memory when collapsing a duplicate cluster, so manifest
  // order survives consolidation). Auto-stamp to now unless a caller passes one
  // through — the only caller that does is a consolidation pass preserving the
  // oldest source's date.
  const createdAt = created?.trim() || new Date().toISOString()
  const metadata = ["  node_type: memory", `  generator: ${MEMORY_GENERATOR}`, `  type: ${type}`]
  if (originSessionId) metadata.push(`  originSessionId: ${originSessionId}`)
  return `---\nname: ${name}\ndescription: ${description}\ncreated: ${createdAt}\nmetadata:\n${metadata.join("\n")}\n---`
}

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}

export function listMemories(worktree: string): MemoryEntry[] {
  const memDir = getMemoryDir(worktree)
  const entries: MemoryEntry[] = []

  let files: string[]
  try {
    files = readdirSync(memDir, { encoding: "utf-8" })
      .filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME)
      .sort()
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return entries
  }

  for (const fileName of files) {
    const filePath = join(memDir, fileName)
    try {
      const rawContent = readFileSync(filePath, "utf-8")
      const { frontmatter, content } = parseFrontmatter(rawContent)
      entries.push({
        filePath,
        fileName,
        name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
        description: frontmatter.description ?? "",
        type: parseMemoryType(frontmatter.type) ?? "user",
        created: frontmatter.created ?? "",
        content,
        rawContent,
      })
    } catch {
      
    }
  }

  return entries
}

export function readMemory(worktree: string, fileName: string): MemoryEntry | null {
  const safeName = validateMemoryFileName(fileName)
  const memDir = getMemoryDir(worktree)
  const filePath = join(memDir, safeName)

  try {
    const rawContent = readFileSync(filePath, "utf-8")
    const { frontmatter, content } = parseFrontmatter(rawContent)
    return {
      filePath,
      fileName: basename(filePath),
      name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
      description: frontmatter.description ?? "",
      type: parseMemoryType(frontmatter.type) ?? "user",
      created: frontmatter.created ?? "",
      content,
      rawContent,
    }
  } catch {
    return null
  }
}

export function saveMemory(
  worktree: string,
  fileName: string,
  name: string,
  description: string,
  type: MemoryType,
  content: string,
  originSessionId?: string,
  created?: string,
): string {
  const safeName = validateMemoryFileName(fileName)
  const memDir = getMemoryDir(worktree)
  const filePath = join(memDir, safeName)

  // In-repo memory may be committed/pushed — scrub credential VALUES before
  // writing (the global ~/.claude store is left as-is). Covers every write path
  // including post-session extraction. No-op for global mode or when the user
  // opted into in-repo secrets. The scrub also flows into the MEMORY.md index
  // pointer below, since it runs on name/description too.
  if (shouldRedactInRepoMemory(worktree)) {
    const scrubbed = scrubMemoryFields({ name, description, content })
    name = scrubbed.name
    description = scrubbed.description
    content = scrubbed.content
  }

  const fileContent = `${buildFrontmatter(name, description, type, originSessionId, created)}\n\n${content.trim()}\n`
  if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
    throw new Error(
      `Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`,
    )
  }
  writeFileSync(filePath, fileContent, "utf-8")

  updateIndex(worktree, safeName, name, description)

  return filePath
}

export function deleteMemory(worktree: string, fileName: string): boolean {
  const safeName = validateMemoryFileName(fileName)
  const memDir = getMemoryDir(worktree)
  const filePath = join(memDir, safeName)

  try {
    unlinkSync(filePath)
    removeFromIndex(worktree, safeName)
    return true
  } catch {
    return false
  }
}

export function searchMemories(worktree: string, query: string): MemoryEntry[] {
  const all = listMemories(worktree)
  const lowerQuery = query.toLowerCase()

  return all.filter(
    (entry) =>
      entry.name.toLowerCase().includes(lowerQuery) ||
      entry.description.toLowerCase().includes(lowerQuery) ||
      entry.content.toLowerCase().includes(lowerQuery),
  )
}

export function readIndex(worktree: string): string {
  const entrypoint = getMemoryEntrypoint(worktree)
  try {
    return readFileSync(entrypoint, "utf-8")
  } catch {
    return ""
  }
}

function updateIndex(worktree: string, fileName: string, name: string, description: string): void {
  const entrypoint = getMemoryEntrypoint(worktree)
  const existing = readIndex(worktree)
  const lines = existing.split("\n").filter((l) => l.trim())

  const pointer = `- [${name}](${fileName}) — ${description}`
  const existingIdx = lines.findIndex((l) => l.includes(`(${fileName})`))

  if (existingIdx >= 0) {
    lines[existingIdx] = pointer
  } else {
    lines.push(pointer)
  }

  writeFileSync(entrypoint, lines.join("\n") + "\n", "utf-8")
}

function removeFromIndex(worktree: string, fileName: string): void {
  const entrypoint = getMemoryEntrypoint(worktree)
  const existing = readIndex(worktree)
  const lines = existing
    .split("\n")
    .filter((l) => l.trim() && !l.includes(`(${fileName})`))

  writeFileSync(entrypoint, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8")
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return `${(bytes / 1024).toFixed(1)}KB`
}

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

// Port of Claude Code's truncateEntrypointContent() from memdir.ts.
// Uses .length (char count, same as Claude Code) for byte measurement.
export function truncateEntrypoint(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  if (!trimmed) return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false }

  const contentLines = trimmed.split("\n")
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content: truncated + `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}
