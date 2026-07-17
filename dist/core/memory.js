import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { getMemoryDir, getMemoryEntrypoint, ENTRYPOINT_NAME, validateMemoryFileName, shouldRedactMemory, MAX_MEMORY_FILES, MAX_MEMORY_FILE_BYTES, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, FRONTMATTER_MAX_LINES, } from "./paths.js";
import { scrubMemoryFields } from "./redact.js";
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
// Provenance stamp written into every memory this plugin saves, so plugin-authored
// memories are distinguishable from ones Claude Code's own memory subsystem wrote
// in the shared store. Claude Code (and our parser) ignore unknown metadata fields,
// so this stays byte-compatible.
export const MEMORY_GENERATOR = "opencode-claude-memory";
function parseFrontmatter(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("---")) {
        return { frontmatter: {}, content: trimmed };
    }
    const lines = trimmed.split("\n");
    let closingLineIdx = -1;
    for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
        if (lines[i].trimEnd() === "---") {
            closingLineIdx = i;
            break;
        }
    }
    if (closingLineIdx === -1) {
        return { frontmatter: {}, content: trimmed };
    }
    const endIndex = lines.slice(0, closingLineIdx).join("\n").length + 1;
    const frontmatterBlock = trimmed.slice(3, endIndex).trim();
    const content = trimmed.slice(endIndex + 3).trim();
    const frontmatter = {};
    for (const line of frontmatterBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
            frontmatter[key] = value;
        }
    }
    return { frontmatter, content };
}
// Emit the nested `metadata` block that Claude Code's memory subsystem writes
// on disk (a memory is a node in its memory graph). The flat top-level `type:`
// of older Claude Code releases is gone; aligning here keeps files written by
// this plugin byte-compatible with Claude Code's store. `parseFrontmatter`
// reads both the nested and the legacy flat form, so reads stay compatible.
function buildFrontmatter(name, description, type, originSessionId, created) {
    // `created` is a top-level sort key (Claude Code's auto-dream copies it from
    // the oldest source memory when collapsing a duplicate cluster, so manifest
    // order survives consolidation). Auto-stamp to now unless a caller passes one
    // through — the only caller that does is a consolidation pass preserving the
    // oldest source's date.
    const createdAt = created?.trim() || new Date().toISOString();
    const metadata = ["  node_type: memory", `  generator: ${MEMORY_GENERATOR}`, `  type: ${type}`];
    if (originSessionId)
        metadata.push(`  originSessionId: ${originSessionId}`);
    return `---\nname: ${name}\ndescription: ${description}\ncreated: ${createdAt}\nmetadata:\n${metadata.join("\n")}\n---`;
}
function parseMemoryType(raw) {
    if (!raw)
        return undefined;
    return MEMORY_TYPES.find((t) => t === raw);
}
export function listMemories(worktree) {
    const memDir = getMemoryDir(worktree);
    const entries = [];
    let files;
    try {
        files = readdirSync(memDir, { encoding: "utf-8" })
            .filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME)
            .sort()
            .slice(0, MAX_MEMORY_FILES);
    }
    catch {
        return entries;
    }
    for (const fileName of files) {
        const filePath = join(memDir, fileName);
        try {
            const rawContent = readFileSync(filePath, "utf-8");
            const { frontmatter, content } = parseFrontmatter(rawContent);
            entries.push({
                filePath,
                fileName,
                name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
                description: frontmatter.description ?? "",
                type: parseMemoryType(frontmatter.type) ?? "user",
                created: frontmatter.created ?? "",
                content,
                rawContent,
            });
        }
        catch {
        }
    }
    return entries;
}
export function readMemory(worktree, fileName) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    try {
        const rawContent = readFileSync(filePath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        return {
            filePath,
            fileName: basename(filePath),
            name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
            description: frontmatter.description ?? "",
            type: parseMemoryType(frontmatter.type) ?? "user",
            created: frontmatter.created ?? "",
            content,
            rawContent,
        };
    }
    catch {
        return null;
    }
}
export function saveMemory(worktree, fileName, name, description, type, content, originSessionId, created) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    // In-repo memory may be committed/pushed — scrub credential VALUES before
    // writing. Covers every write path including post-session extraction. By
    // default the global ~/.claude store is left as-is (secrets allowed there);
    // shouldRedactMemory also returns true for global writes when the user opts in
    // via OPENCODE_MEMORY_REDACT_GLOBAL. The scrub flows into the MEMORY.md index
    // pointer below, since it runs on name/description too.
    if (shouldRedactMemory(worktree)) {
        const scrubbed = scrubMemoryFields({ name, description, content });
        name = scrubbed.name;
        description = scrubbed.description;
        content = scrubbed.content;
    }
    const fileContent = `${buildFrontmatter(name, description, type, originSessionId, created)}\n\n${content.trim()}\n`;
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
        throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    writeFileSync(filePath, fileContent, "utf-8");
    updateIndex(worktree, safeName, name, description);
    return filePath;
}
export function deleteMemory(worktree, fileName) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    try {
        unlinkSync(filePath);
        removeFromIndex(worktree, safeName);
        return true;
    }
    catch {
        return false;
    }
}
export function searchMemories(worktree, query) {
    const all = listMemories(worktree);
    const lowerQuery = query.toLowerCase();
    return all.filter((entry) => entry.name.toLowerCase().includes(lowerQuery) ||
        entry.description.toLowerCase().includes(lowerQuery) ||
        entry.content.toLowerCase().includes(lowerQuery));
}
export function readIndex(worktree) {
    const entrypoint = getMemoryEntrypoint(worktree);
    try {
        return readFileSync(entrypoint, "utf-8");
    }
    catch {
        return "";
    }
}
function updateIndex(worktree, fileName, name, description) {
    const entrypoint = getMemoryEntrypoint(worktree);
    const existing = readIndex(worktree);
    const lines = existing.split("\n").filter((l) => l.trim());
    const pointer = `- [${name}](${fileName}) — ${description}`;
    const existingIdx = lines.findIndex((l) => l.includes(`(${fileName})`));
    if (existingIdx >= 0) {
        lines[existingIdx] = pointer;
    }
    else {
        lines.push(pointer);
    }
    writeFileSync(entrypoint, lines.join("\n") + "\n", "utf-8");
}
function removeFromIndex(worktree, fileName) {
    const entrypoint = getMemoryEntrypoint(worktree);
    const existing = readIndex(worktree);
    const lines = existing
        .split("\n")
        .filter((l) => l.trim() && !l.includes(`(${fileName})`));
    writeFileSync(entrypoint, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}
// Port of Claude Code's truncateEntrypointContent() from memdir.ts.
// Uses .length (char count, same as Claude Code) for byte measurement.
export function truncateEntrypoint(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false };
    const contentLines = trimmed.split("\n");
    const lineCount = contentLines.length;
    const byteCount = trimmed.length;
    const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
    const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;
    if (!wasLineTruncated && !wasByteTruncated) {
        return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
    }
    let truncated = wasLineTruncated
        ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
        : trimmed;
    if (truncated.length > MAX_ENTRYPOINT_BYTES) {
        const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
        truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
    }
    const reason = wasByteTruncated && !wasLineTruncated
        ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
        : wasLineTruncated && !wasByteTruncated
            ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
            : `${lineCount} lines and ${formatFileSize(byteCount)}`;
    return {
        content: truncated + `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
        lineCount,
        byteCount,
        wasLineTruncated,
        wasByteTruncated,
    };
}
