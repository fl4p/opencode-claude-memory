import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  getMemoryDir,
  getMemoryEntrypoint,
  getLocalMemoryDir,
  getLocalMemoryMode,
  getProjectDir,
  setLocalMemoryMode,
  setIndexMaxLines,
  getIndexMaxLines,
  DEFAULT_INDEX_MAX_LINES,
  ENTRYPOINT_NAME,
  LOCAL_MEMORY_DIRNAME,
} from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "paths-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

// getProjectDir keys off CLAUDE_CONFIG_DIR; isolate it so the suite never reads
// or writes the developer's real ~/.claude store.
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedLocalEnv = process.env.OPENCODE_MEMORY_LOCAL
const savedIndexEnv = process.env.OPENCODE_MEMORY_INDEX_MAX_LINES

beforeEach(() => {
  const cfg = mkdtempSync(join(tmpdir(), "paths-cfg-"))
  tempDirs.push(cfg)
  process.env.CLAUDE_CONFIG_DIR = cfg
  delete process.env.OPENCODE_MEMORY_LOCAL
  delete process.env.OPENCODE_MEMORY_INDEX_MAX_LINES
  setLocalMemoryMode(undefined)
  setIndexMaxLines(undefined)
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedLocalEnv === undefined) delete process.env.OPENCODE_MEMORY_LOCAL
  else process.env.OPENCODE_MEMORY_LOCAL = savedLocalEnv
  if (savedIndexEnv === undefined) delete process.env.OPENCODE_MEMORY_INDEX_MAX_LINES
  else process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = savedIndexEnv
  setLocalMemoryMode(undefined)
  setIndexMaxLines(undefined)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("index size limit resolution", () => {
  test("defaults below the hard cap (lead time before truncation)", () => {
    expect(getIndexMaxLines()).toBe(DEFAULT_INDEX_MAX_LINES)
    expect(DEFAULT_INDEX_MAX_LINES).toBeLessThan(200) // MAX_ENTRYPOINT_LINES
  })

  test("env var overrides the plugin option", () => {
    setIndexMaxLines(120)
    process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = "50"
    expect(getIndexMaxLines()).toBe(50)
  })

  test("plugin option is used when env is unset (number or numeric string)", () => {
    setIndexMaxLines(80)
    expect(getIndexMaxLines()).toBe(80)
    setIndexMaxLines("90")
    expect(getIndexMaxLines()).toBe(90)
  })

  test("0 / off disables the warning via env and is not overridden by the default", () => {
    process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = "0"
    expect(getIndexMaxLines()).toBe(0)
    process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = "off"
    expect(getIndexMaxLines()).toBe(0)
  })

  test("0 / off disables via the plugin option too (0 must not fall through)", () => {
    setIndexMaxLines(0)
    expect(getIndexMaxLines()).toBe(0)
    setIndexMaxLines("off")
    expect(getIndexMaxLines()).toBe(0)
  })

  test("garbage value falls back to the next layer", () => {
    setIndexMaxLines(75)
    process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = "banana"
    expect(getIndexMaxLines()).toBe(75)
  })

  test("negative value is treated as unset (falls back), NOT as disable", () => {
    setIndexMaxLines(75)
    process.env.OPENCODE_MEMORY_INDEX_MAX_LINES = "-1"
    expect(getIndexMaxLines()).toBe(75) // negative env ignored → plugin option used
    delete process.env.OPENCODE_MEMORY_INDEX_MAX_LINES
    setIndexMaxLines(-5)
    expect(getIndexMaxLines()).toBe(DEFAULT_INDEX_MAX_LINES) // negative option → default
  })

  test("floors fractional values", () => {
    setIndexMaxLines(90.7)
    expect(getIndexMaxLines()).toBe(90)
  })
})

describe("local memory mode resolution", () => {
  test("defaults to auto", () => {
    expect(getLocalMemoryMode()).toBe("auto")
  })

  test("env var overrides the plugin option (env wins)", () => {
    setLocalMemoryMode("off")
    process.env.OPENCODE_MEMORY_LOCAL = "on"
    expect(getLocalMemoryMode()).toBe("on")
  })

  test("plugin option is used when env is unset", () => {
    setLocalMemoryMode("on")
    expect(getLocalMemoryMode()).toBe("on")
  })

  test("recognises aliases for on/off/auto", () => {
    for (const v of ["1", "true", "yes", "local", "ON"]) {
      process.env.OPENCODE_MEMORY_LOCAL = v
      expect(getLocalMemoryMode()).toBe("on")
    }
    for (const v of ["0", "false", "no", "global", "OFF"]) {
      process.env.OPENCODE_MEMORY_LOCAL = v
      expect(getLocalMemoryMode()).toBe("off")
    }
    process.env.OPENCODE_MEMORY_LOCAL = "auto"
    expect(getLocalMemoryMode()).toBe("auto")
  })

  test("unrecognised value falls back to the next layer", () => {
    setLocalMemoryMode("on")
    process.env.OPENCODE_MEMORY_LOCAL = "banana"
    expect(getLocalMemoryMode()).toBe("on") // garbage env ignored, option used
  })
})

describe("getLocalMemoryDir", () => {
  test("is <gitRoot>/.claude/memory", () => {
    const repo = makeTempGitRepo()
    expect(getLocalMemoryDir(repo)).toBe(join(repo, LOCAL_MEMORY_DIRNAME))
  })
})

describe("getMemoryDir — auto mode", () => {
  test("uses the global store when no in-repo folder exists", () => {
    const repo = makeTempGitRepo()
    const dir = getMemoryDir(repo)
    expect(dir).toBe(join(getProjectDir(repo), "memory"))
    // auto mode must NOT create the local folder
    expect(existsSync(getLocalMemoryDir(repo))).toBe(false)
  })

  test("adopts the in-repo folder once it already exists", () => {
    const repo = makeTempGitRepo()
    const localDir = getLocalMemoryDir(repo)
    mkdirSync(localDir, { recursive: true })
    expect(getMemoryDir(repo)).toBe(localDir)
  })

  test("a stray FILE at the local path is not adopted (falls back to global, no crash)", () => {
    const repo = makeTempGitRepo()
    const localDir = getLocalMemoryDir(repo)
    mkdirSync(join(repo, ".claude"), { recursive: true })
    writeFileSync(localDir, "not a directory", "utf-8") // file named "memory"
    expect(getMemoryDir(repo)).toBe(join(getProjectDir(repo), "memory"))
  })
})

describe("getMemoryDir — env precedence (reverse direction)", () => {
  test("env off overrides plugin option on", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    process.env.OPENCODE_MEMORY_LOCAL = "off"
    expect(getMemoryDir(repo)).toBe(join(getProjectDir(repo), "memory"))
  })
})

describe("getMemoryEntrypoint follows the active mode", () => {
  test("resolves MEMORY.md inside the local dir under on mode", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    expect(getMemoryEntrypoint(repo)).toBe(join(getLocalMemoryDir(repo), ENTRYPOINT_NAME))
  })
})

describe("getMemoryDir — on mode", () => {
  test("forces and creates the in-repo folder", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    const dir = getMemoryDir(repo)
    expect(dir).toBe(getLocalMemoryDir(repo))
    expect(existsSync(dir)).toBe(true)
  })
})

describe("getMemoryDir — off mode", () => {
  test("stays global even when an in-repo folder exists", () => {
    const repo = makeTempGitRepo()
    mkdirSync(getLocalMemoryDir(repo), { recursive: true })
    process.env.OPENCODE_MEMORY_LOCAL = "off"
    expect(getMemoryDir(repo)).toBe(join(getProjectDir(repo), "memory"))
  })
})

describe("getMemoryDir — worktrees share one repo's local store", () => {
  test("a subdirectory resolves to the same in-repo folder", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    const sub = join(repo, "packages", "app")
    mkdirSync(sub, { recursive: true })
    // both resolve via the canonical git root → same local memory dir
    expect(getMemoryDir(sub)).toBe(getMemoryDir(repo))
  })
})

describe("getMemoryDir — entrypoint and writes follow the active dir", () => {
  test("a saved file lands in the local dir under on mode", () => {
    const repo = makeTempGitRepo()
    setLocalMemoryMode("on")
    const dir = getMemoryDir(repo)
    writeFileSync(join(dir, "MEMORY.md"), "# Memory Index\n", "utf-8")
    expect(existsSync(join(getLocalMemoryDir(repo), "MEMORY.md"))).toBe(true)
  })
})
