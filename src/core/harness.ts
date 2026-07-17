import { appendFileSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { getProjectDir, ensureDir } from "./paths.js"

// Obj1 sidecar — see auto-memory/agent-memory-gotchas-1.md.
//
// Memory (the memory_* tools) captures Obj2: durable facts the AGENT should
// recall next session. This captures Obj1: observations about how the agent /
// its skills / the harness BEHAVED, whose fix is a diff to the system prompt,
// agent config, or a skill — read by the HARNESS DEVELOPER, never injected into
// agent context. It deliberately lives OUTSIDE the memory dir so it is never
// scanned, indexed in MEMORY.md, or surfaced by recall.

export const HARNESS_FEEDBACK_CATEGORIES = [
  "tool-efficiency", // redundant reads, retry loops, errors not surfacing, thrash
  "agent-behavior", // the agent did something inefficient/wrong a prompt fix would prevent
  "skill-design", // a skill described instead of acted, missing loop, too-slow polling, unclear tool
  "harness-config", // something to change in the harness/agent config, not remember per-session
  "other",
] as const
export type HarnessFeedbackCategory = (typeof HARNESS_FEEDBACK_CATEGORIES)[number]

export const HARNESS_FEEDBACK_FILE = "harness-feedback.md"

const HEADER = [
  "# Harness feedback (NOT agent memory)",
  "",
  "Obj1 — tool-use efficiency and agent/skill behavior calibration. Each entry is",
  "feedback for the *harness developer* to act on (a system-prompt, agent-config, or",
  "skill diff). These are never recalled into agent context. See",
  "auto-memory/agent-memory-gotchas-1.md for the Obj1/Obj2 split.",
  "",
  "---",
  "",
  "",
].join("\n")

export function getHarnessFeedbackPath(worktree: string): string {
  const dir = getProjectDir(worktree)
  ensureDir(dir)
  return join(dir, HARNESS_FEEDBACK_FILE)
}

export function saveHarnessFeedback(
  worktree: string,
  title: string,
  category: HarnessFeedbackCategory,
  body: string,
  originSessionId?: string,
): string {
  const path = getHarnessFeedbackPath(worktree)
  if (!existsSync(path)) writeFileSync(path, HEADER, "utf-8")

  const meta = [`category: ${category}`, `logged: ${new Date().toISOString()}`]
  if (originSessionId) meta.push(`session: ${originSessionId}`)

  const entry =
    `## ${title}\n` +
    meta.map((m) => `- ${m}`).join("\n") +
    "\n\n" +
    body.trim() +
    "\n\n---\n\n"
  appendFileSync(path, entry, "utf-8")
  return path
}
