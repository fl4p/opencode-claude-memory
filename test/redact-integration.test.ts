import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { saveMemory, readMemory } from "../src/memory.js"
import {
  setLocalMemoryMode,
  setLocalMemorySecretsAllowed,
  shouldRedactInRepoMemory,
} from "../src/paths.js"

// A SYNTHETIC secret — never put a real credential in a repo file.
const SECRET = "hunter2pickle"
const CONTENT = `the password is ${SECRET}`

const tempDirs: string[] = []
function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "redact-int-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

const savedCfg = process.env.CLAUDE_CONFIG_DIR
const savedLocal = process.env.OPENCODE_MEMORY_LOCAL
const savedSecrets = process.env.OPENCODE_MEMORY_LOCAL_SECRETS

beforeEach(() => {
  const cfg = mkdtempSync(join(tmpdir(), "redact-cfg-"))
  tempDirs.push(cfg)
  process.env.CLAUDE_CONFIG_DIR = cfg // isolate the global store from the dev's ~/.claude
  delete process.env.OPENCODE_MEMORY_LOCAL
  delete process.env.OPENCODE_MEMORY_LOCAL_SECRETS
  setLocalMemoryMode(undefined)
  setLocalMemorySecretsAllowed(undefined)
})

afterEach(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v))
  restore("CLAUDE_CONFIG_DIR", savedCfg)
  restore("OPENCODE_MEMORY_LOCAL", savedLocal)
  restore("OPENCODE_MEMORY_LOCAL_SECRETS", savedSecrets)
  setLocalMemoryMode(undefined)
  setLocalMemorySecretsAllowed(undefined)
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe("in-repo secret scrubbing", () => {
  test("in-repo save (local on) scrubs the credential value", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    saveMemory(repo, "creds", "Creds", "the password is " + SECRET, "reference", CONTENT)
    const got = readMemory(repo, "creds")
    expect(got).not.toBeNull()
    expect(got!.content).toContain("«REDACTED»")
    expect(got!.content).not.toContain(SECRET)
    expect(got!.description).not.toContain(SECRET) // index pointer is scrubbed too
  })

  test("global save (local off) KEEPS the secret — ~/.claude is private", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("off")
    saveMemory(repo, "creds", "Creds", "desc", "reference", CONTENT)
    const got = readMemory(repo, "creds")
    expect(got!.content).toContain(SECRET)
    expect(got!.content).not.toContain("«REDACTED»")
  })

  test("opt-in (localMemorySecrets) keeps secrets even in-repo", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    setLocalMemorySecretsAllowed("on")
    saveMemory(repo, "creds", "Creds", "desc", "reference", CONTENT)
    const got = readMemory(repo, "creds")
    expect(got!.content).toContain(SECRET)
  })
})

describe("shouldRedactInRepoMemory predicate", () => {
  test("true for in-repo default, false when opted in, false for global", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    expect(shouldRedactInRepoMemory(repo)).toBe(true)
    setLocalMemorySecretsAllowed("on")
    expect(shouldRedactInRepoMemory(repo)).toBe(false)
    setLocalMemorySecretsAllowed(undefined)
    setLocalMemoryMode("off")
    expect(shouldRedactInRepoMemory(repo)).toBe(false)
  })

  test("env OPENCODE_MEMORY_LOCAL_SECRETS overrides the plugin option", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    setLocalMemorySecretsAllowed("off")
    process.env.OPENCODE_MEMORY_LOCAL_SECRETS = "1"
    expect(shouldRedactInRepoMemory(repo)).toBe(false) // env allows secrets → no scrub
  })
})
