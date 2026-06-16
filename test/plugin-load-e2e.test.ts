import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * True end-to-end: the REAL `opencode` binary discovers, loads, and invokes this
 * plugin. Every other test exercises the plugin's logic in-process (importing
 * MemoryPlugin and calling its hooks with a hand-built `as never` context) or
 * runs the shell hook against a *fake* opencode stub — none proves opencode
 * actually loads the plugin and fires a hook with the real context shape.
 *
 * Signal (model-free, no auth): the plugin's `config` hook injects a hidden
 * recall agent (`opencode-memory-recall`) into the resolved config. We install
 * the bundled plugin into an isolated XDG_CONFIG_HOME (opencode auto-discovers
 * `$XDG_CONFIG_HOME/opencode/plugin/*.js`, the same path the replay harness
 * uses) and read it back via `opencode debug config`:
 *   - WITH the plugin  -> the injected agent appears  (factory ran, hook fired)
 *   - WITH `--pure`    -> it does NOT                  (negative control)
 * The `--pure` arm is what makes this a real assertion rather than a coincidence:
 * it proves the agent is there *because opencode loaded our plugin*, not because
 * something else conjured the name.
 *
 * Gated: skips cleanly when the opencode binary is absent (set OPENCODE_BIN to
 * override), so CI without opencode installed stays green. `debug config` needs
 * no model and no credentials.
 */

const RECALL_AGENT = "opencode-memory-recall"
const PINNED = "/opt/homebrew/Cellar/opencode/1.17.7/bin/opencode"

function findOpencode(): string | null {
  const fromEnv = process.env.OPENCODE_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (existsSync(PINNED)) return PINNED
  const which = spawnSync("bash", ["-lc", "command -v opencode"], { encoding: "utf-8" })
  const p = which.stdout?.trim()
  return p && existsSync(p) ? p : null
}

const OPENCODE = findOpencode()
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

/** Bundle src/index.ts into one ESM file under an isolated XDG_CONFIG_HOME and
 *  return { configHome, projectDir }. Mirrors replay_memories.bundle_plugin /
 *  make_config_home: SDK left external (opencode injects @opencode-ai/plugin). */
function installPlugin(): { configHome: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "oc-plugin-load-"))
  tempRoots.push(root)
  const configHome = join(root, "cfg")
  const pluginDir = join(configHome, "opencode", "plugin")
  const projectDir = join(root, "proj")
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  const entry = join(process.cwd(), "src", "index.ts")
  const bundle = join(pluginDir, "memory.js")
  // `process.execPath` is the bun running this test -> `bun build ...`.
  const build = spawnSync(
    process.execPath,
    ["build", entry, "--format", "esm", "--target", "node",
      "--external", "@opencode-ai/plugin", "--outfile", bundle],
    { cwd: process.cwd(), encoding: "utf-8" },
  )
  if (build.status !== 0 || !existsSync(bundle)) {
    throw new Error(`plugin bundle failed: ${build.stderr || build.stdout}`)
  }
  writeFileSync(
    join(configHome, "opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }) + "\n",
  )
  return { configHome, projectDir }
}

function resolvedConfig(opencode: string, configHome: string, projectDir: string, pure: boolean): string {
  const args = ["debug", "config"]
  if (pure) args.push("--pure")
  const root = join(configHome, "..")
  const res = spawnSync(opencode, args, {
    cwd: projectDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Isolate config (plugin discovery) + the rest of XDG so the probe never
      // touches the developer's real opencode data/cache/state.
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
    },
  })
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`
}

describe("opencode loads the plugin (real binary)", () => {
  test.skipIf(!OPENCODE)(
    "config hook injects the recall agent; --pure proves it's our plugin",
    () => {
      const { configHome, projectDir } = installPlugin()

      const withPlugin = resolvedConfig(OPENCODE!, configHome, projectDir, false)
      expect(withPlugin).toContain(RECALL_AGENT)

      const pure = resolvedConfig(OPENCODE!, configHome, projectDir, true)
      expect(pure).not.toContain(RECALL_AGENT)
    },
    60_000,
  )
})
