<div align="center">

# 🧠 Claude Code-compatible memory for OpenCode

**Persistent, local-first shared memory for OpenCode and Claude Code — zero config and no migration required.**

This OpenCode memory plugin lets OpenCode read and write Claude Code-compatible Markdown memory files, so both CLIs share the same project context.

Claude Code writes memory → OpenCode reads it. OpenCode writes memory → Claude Code reads it.

**A fork of [kuitos/opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory).** It keeps the upstream Claude-Code-compatible store and format, and adds a tuned extraction pipeline, optional in-repo memory, an index size-limit warning, and in-repo secret scrubbing — see [What this fork adds](#-what-this-fork-adds) and the [`docs/`](docs/) knowledge base.

[Quick Start](#-quick-start) • [What this fork adds](#-what-this-fork-adds) • [How it works](#-how-it-works) • [Configuration](#-configuration) • [FAQ](#-faq)

</div>

---

## ✨ At a glance

- **OpenCode plugin for Claude Code memory**
  Adds persistent memory tools, system prompt injection, and post-session extraction to OpenCode.
- **Claude Code-compatible memory**
  Uses Claude Code’s existing memory paths, file format, and taxonomy.
- **Zero config**
  Install + enable plugin, then keep using `opencode` as usual.
- **Local-first, no migration**
  Memory stays as local Markdown files in the same directory Claude Code already uses.
- **Auto-dream consolidation**
  Periodically runs a background memory consolidation pass (Claude-style auto-dream gating).

## 🚀 Quick Start

### Prerequisites

- `opencode`
- `python3` available in `PATH`

`python3` is a runtime dependency for the wrapper's scoped session detection and fork cleanup logic.
If it is missing or not executable, post-session maintenance becomes less reliable: session targeting can fall back to less precise heuristics, and fork cleanup is skipped for safety.

Common install commands:

```bash
# macOS (Homebrew)
brew install python

# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y python3

# Fedora
sudo dnf install -y python3

# Arch Linux
sudo pacman -S python
```

### 1. Install

```bash
npm install -g opencode-claude-memory
opencode-memory install   # one-time: installs shell hook
```

This installs:
- The **plugin** — memory tools + system prompt injection
- The `opencode-memory` **CLI** — wraps opencode with automatic memory extraction + auto-dream consolidation
- A **shell hook** — defines an `opencode()` function in your `.zshrc`/`.bashrc` that delegates to `opencode-memory`

If `python3` is not installed yet, install it first using the commands above before enabling the shell hook.

### 2. Configure

```jsonc
// opencode.json
{
  "plugin": ["opencode-claude-memory"]
}
```

### 3. Use

```bash
opencode
```

That’s it. Memory extraction runs in the background after each session, and auto-dream consolidation is checked with time/session gates.

To uninstall:

```bash
opencode-memory uninstall   # removes shell hook from .zshrc/.bashrc
npm uninstall -g opencode-claude-memory
```

To print the wrapper package version:

```bash
opencode-memory self -v
```

This removes the shell hook, the CLI, and the plugin. Your saved memories in `~/.claude/projects/` are **not** deleted.

## 💡 Why this exists

If you use both Claude Code and OpenCode on the same repository, memory often ends up in separate silos.

This project solves that by making OpenCode read and write memory in Claude Code’s existing structure, so your context carries over naturally between both tools.

## 🧩 What makes this different

Most memory plugins introduce a new storage model or migration step.

This one is a **compatibility layer**, not a new memory system:

- same memory directory conventions as Claude Code
- same Markdown + frontmatter format
- same memory taxonomy (`user`, `feedback`, `project`, `reference`)
- same project/worktree resolution behavior

The outcome: **shared context across Claude Code and OpenCode without maintaining two memory systems.**

## 🍴 What this fork adds

On top of upstream's compatibility layer, this fork adds:

- **Tuned two-phase extraction** — post-session extraction runs Phase 1 (harness feedback) then Phase 2 (durable memory). Harness feedback (the `Obj1` sidecar: observations about how the agent/skills/tools behaved) is written *outside* the memory dir so it is never recalled into context. Default extraction model is GLM-4.6 (`opencode/big-pickle`); extraction/dream/recall models are all configurable (see [Configuration](#-configuration)).
- **In-repo memory mode** — `OPENCODE_MEMORY_LOCAL` / `localMemory` (`auto`/`on`/`off`). Stores memory at `<repo>/.claude/memory/` instead of the global `~/.claude/...`, so it can be committed and shared with Claude Code (which writes the same path when asked). `auto` adopts the in-repo folder iff it already exists.
- **In-repo secret scrubbing** — writes to in-repo `.claude/memory` are run through a deterministic credential scrub by default (the private global store is left as-is), since an in-repo store may be committed/pushed. Opt out with `OPENCODE_MEMORY_LOCAL_SECRETS` / `localMemorySecrets`.
- **Index size-limit warning** — `OPENCODE_MEMORY_INDEX_MAX_LINES` / `indexMaxLines` (default 160). Once `MEMORY.md` reaches the limit the agent warns you once and offers to compact (cluster duplicates / drop stale / shorten entries).
- **Cross-repo memory** — declare other repos via `extraMemoryRoots` to surface their memory read-only in a session.

Background and rationale for all of the above (model bake-offs, local-inference experiments, the dream/consolidation design, secret-redaction evals) live in [`docs/`](docs/).

## ⚙️ How it works

```mermaid
graph LR
    A[You run opencode] --> B[Shell hook calls opencode-memory]
    B --> C[opencode-memory finds real binary]
    C --> D[Runs opencode normally]
    D --> E[You exit]
    E --> F[Extract memories if needed]
    F --> G[Evaluate auto-dream gate]
    G --> H[Consolidate memories if gate passes]
    H --> I[Memories saved to ~/.claude/projects/]
```

The shell hook defines an `opencode()` function that delegates to `opencode-memory`:

1. Shell function intercepts `opencode` command (higher priority than PATH)
2. `opencode-memory` finds the real `opencode` binary in PATH
3. Runs it with all your arguments
4. After you exit, it checks whether the session already wrote memory files
5. If needed, it forks the session with a memory extraction prompt
6. It evaluates the auto-dream gate (default: at least 24h since last consolidation and 5 touched sessions)
7. If the gate passes, it runs a background consolidation pass to merge/prune memories
8. Maintenance runs **in the background** unless `OPENCODE_MEMORY_FOREGROUND=1`
9. Terminal maintenance logs are shown in foreground mode by default, or can be forced on/off with `OPENCODE_MEMORY_TERMINAL_LOG=1|0`

### Runtime dependencies

The wrapper expects `python3` to be available at runtime.

It is used for:

- scoped session selection from `opencode session list`
- parsing `opencode export` output to resolve session directories
- safely identifying and cleaning up forked extraction / auto-dream sessions

Without `python3`, the plugin tools still load, but wrapper maintenance is degraded and fork cleanup is intentionally skipped to avoid deleting the wrong session.

### Compatibility details

The implementation ports core logic from Claude Code for path hashing, git-root/worktree handling, memory format, and memory prompting behavior, so both tools can operate on the same files safely.

Key modules ported from Claude Code's `src/memdir/`:

| Module | Source | Purpose |
|---|---|---|
| `memoryScan.ts` | `memoryScan.ts` | Recursive directory scan + frontmatter header parsing |
| `recall.ts` + `recallSelector.ts` | `findRelevantMemories.ts` | LLM-selected memory recall + selected memory formatting |
| `prompt.ts` | `memoryTypes.ts` + `memdir.ts` | System prompt sections, type taxonomy, truncation |
| `memory.ts` | `memdir.ts` | `truncateEntrypoint()` aligned with `truncateEntrypointContent()` |

## 👥 Who this is for

- You use **both Claude Code and OpenCode**.
- You want **one shared memory context** across both tools.
- You prefer **file-based, local-first memory** you can inspect in Git/worktrees.
- You don’t want migration overhead or lock-in.

## ❓ FAQ

### Is this a new memory system?

No. It is a compatibility layer that lets OpenCode use Claude Code-compatible memory layout and conventions.

### Do I need to migrate existing memory?

No migration required. If you already have Claude Code memory files, OpenCode can work with them directly.

### Where is data stored?

By default, in local files under Claude-style project memory directories (for example, under `~/.claude/projects/<project>/memory/`) — shared with Claude Code.

You can instead keep memory **inside the repo**, at `<repo>/.claude/memory/`, so it can be committed, diffed, and reviewed alongside the code. Set the in-repo switch `OPENCODE_MEMORY_LOCAL` (or the `localMemory` option in `opencode.json`):

- `off` / `0` — always use the global `~/.claude` store (never local)
- `on` / `1` — always use the in-repo `<repo>/.claude/memory/` folder (created if absent)
- `auto` (**default**) — use the in-repo folder **only if it already exists**, otherwise the global store

So the zero-config way to opt a repo into local memory is simply `mkdir -p .claude/memory` — `auto` mode then writes there. Extraction, dreaming, recall, and the `MEMORY.md` index all follow the active directory. The switch keys off the canonical git root, so subdirectories and **linked worktrees** of one repo share the canonical (main) checkout's store — a worktree session writes into the main checkout's `.claude/memory`, not the worktree's own tree.

> 🔒 **Secrets in in-repo memory are scrubbed by default.** The global `~/.claude` store is private to you, so secret values are kept as-is there. But an in-repo `.claude/memory/` can be committed and pushed, so writes to it run through a deterministic credential scrub (`«REDACTED»`) that catches the common `<keyword> is/= <value>` and `<keyword> \`<value>\`` forms (passwords, API keys, tokens, WiFi/PSK, …). This is belt-and-suspenders, not a guarantee — a value phrased with no keyword cue can still slip through, so still review `.claude/memory/` before pushing. If you intentionally want secrets stored in-repo, set `OPENCODE_MEMORY_LOCAL_SECRETS` (or `localMemorySecrets` in `opencode.json`) to disable the scrub.

### Why file-based memory?

File-based memory is transparent, local-first, easy to inspect/diff/back up, and works naturally with existing developer workflows.

### Can I disable auto extraction?

Yes. Set `OPENCODE_MEMORY_EXTRACT=0`.

### Can I disable auto-dream?

Yes. Set `OPENCODE_MEMORY_AUTODREAM=0`. You can also tune gates with:
- `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS`
- `OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS`

### Can I cap how large the memory index gets?

Yes. Set a soft line limit for the `MEMORY.md` index via `OPENCODE_MEMORY_INDEX_MAX_LINES` (or the `indexMaxLines` option in `opencode.json`); the default is `160` (below the hard 200-line cap, so you get lead time before the index is truncated). Once the index reaches the limit, the agent warns you **once** that session and offers to compact memory by:

- **clustering** near-duplicate or related memories into a single merged file,
- **removing stale** memories that are outdated or superseded, and
- **shortening** verbose entries so each index line is a one-line hook.

It only offers — nothing is deleted without your confirmation. Set the limit to `0` (or `off`) to disable the warning. This is independent of the hard cap that truncates what actually gets loaded into context.

## 🔧 Configuration

### Environment variables

- `OPENCODE_MEMORY_EXTRACT` (default `1`): set `0` to disable automatic memory extraction
- `OPENCODE_MEMORY_FOREGROUND` (default `0`): set `1` to run maintenance in foreground
- `OPENCODE_MEMORY_TERMINAL_LOG` (default `foreground-only`): set `1` to force terminal logs on, `0` to force them off
- `OPENCODE_MEMORY_MODEL`: override model used for extraction
- `OPENCODE_MEMORY_AGENT`: override agent used for extraction
- `OPENCODE_MEMORY_RECALL_MODEL`: override model used for LLM memory recall selection
- `OPENCODE_MEMORY_RECALL_AGENT` (default `opencode-memory-recall`): override agent used for LLM memory recall selection
- `OPENCODE_MEMORY_AUTODREAM` (default `1`): set `0` to disable auto-dream consolidation
- `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS` (default `24`): min hours between consolidation runs
- `OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS` (default `5`): min touched sessions since last consolidation
- `OPENCODE_MEMORY_AUTODREAM_MODEL`: override model used for auto-dream
- `OPENCODE_MEMORY_AUTODREAM_AGENT`: override agent used for auto-dream
- `OPENCODE_MEMORY_LOCAL` (default `auto`): in-repo memory switch — `on` stores memory at `<repo>/.claude/memory/`, `off` forces the global `~/.claude` store, `auto` uses the in-repo folder if it already exists
- `OPENCODE_MEMORY_INDEX_MAX_LINES` (default `160`): soft size limit for the `MEMORY.md` index — once reached, the agent warns you once and offers to compact memory; set `0` or `off` to disable the warning. (Sits below the hard 200-line cap so you get lead time before the index is truncated.)
- `OPENCODE_MEMORY_LOCAL_SECRETS` (default `off`): when `on`, allow secret values to be written to **in-repo** `.claude/memory` (disables the deterministic credential scrub). The global `~/.claude` store is never scrubbed regardless.

### Model settings via `opencode.json` (recommended)

Rather than exporting env vars, you can declare the extraction, dream, and recall
models persistently in the plugin's `options` block in `opencode.json` — the native
per-plugin settings surface. opencode merges global (`~/.config/opencode`) and
project config; project wins, and **environment variables still override everything**.

```jsonc
{
  "plugin": [
    {
      "package": "opencode-claude-memory",
      "options": {
        "extractModel": "opencode/big-pickle",       // post-session extraction
        "dreamModel":   "opencode/big-pickle",        // auto-dream consolidation (defaults to extractModel)
        "recallModel":  "openai/gpt-4o-mini",         // LLM recall selection
        "extractAgent": "...",                         // optional agent overrides
        "dreamAgent":   "...",
        "recallAgent":  "...",
        "localMemory":  "auto",                         // in-repo memory: on | off | auto (default)
        "localMemorySecrets": false,                    // allow secret values in in-repo .claude/memory (default false → scrubbed)
        "indexMaxLines": 160,                           // warn + offer compaction once MEMORY.md hits this many lines (default 160, 0 = off)
        "extraMemoryRoots": ["/abs/path/to/other-repo"] // see "Cross-repo memory" below
      }
    }
  ]
}
```

Precedence per setting: **env var → `opencode.json` options → built-in default**
(and `dreamModel` falls back to `extractModel` when neither is set).

> **opencode version note.** Recent opencode uses the object entry shape shown above
> (`{ "package": ..., "options": {...} }`). On opencode `1.17.x` stable the entry is a
> **tuple**: `"plugin": [["opencode-claude-memory", { "extractModel": "..." }]]`. The
> wrapper accepts both (plus the `"plugins"` plural key); write whichever your opencode
> version's config schema expects.

Verify what actually resolved (no session launched):

```sh
OPENCODE_MEMORY_PRINT_SETTINGS=1 opencode run
# extract.model=opencode/big-pickle
# dream.model=opencode/big-pickle
# recall.model=<opencode.json options.recallModel, else default>
# local.mode=<opencode.json options.localMemory, else auto>
# local.secrets=<opencode.json options.localMemorySecrets, else off>
# index.max_lines=<opencode.json options.indexMaxLines, else 160>
```

> Note: `extractModel`/`dreamModel` are resolved by the post-session wrapper directly
> from `opencode.json`, so those lines show the concrete value. `recallModel`,
> `localMemory`, `localMemorySecrets`, and `indexMaxLines` are consumed **in-process by the plugin** — the
> wrapper only echoes their env var, otherwise printing the `<opencode.json options.…>`
> placeholder shown above. They still take effect; they just aren't resolved by this
> command unless set via the matching env var. All share the one `options` block.

### Cross-repo memory (`extraMemoryRoots`)

By default a session's memory is pinned to the repo it launched in — reading files
from another repo does **not** load that repo's memory. To additionally surface one
or more *other* repos' memory in a session, declare them:

```jsonc
"options": { "extraMemoryRoots": ["/Users/me/dev/other-repo"] }
```

or via env (replaces the option when set; entries split on `, ; :` or newline):

```sh
OPENCODE_MEMORY_EXTRA_ROOTS="/Users/me/dev/other-repo" opencode
```

What this does:
- **Read-only index injection** — each declared repo's memory index is appended to the
  Auto Memory system block under an `## Additional memory index — <path>` heading. (Index
  only; the LLM recall selector still runs against the session repo.)
- **Targeted tool access** — every `memory_*` tool takes an optional `root` argument. Pass
  a declared repo's path to read/search/list, or to **save/delete** in that repo. Omitting
  `root` always means the session's own repo.

Safety: a `root` that is **not** the session repo or a declared `extraMemoryRoots` entry is
**rejected** — the model cannot write memory to an arbitrary path. Paths are matched by
canonical git root, so a subdir or worktree of an allowed repo resolves correctly.

Scope: this affects **in-session** recall and tools only. Post-session extraction and
auto-dream still operate on the session's own repo.

### Logs

Logs are written to `$TMPDIR/opencode-memory-logs/`:
- `extract-*.log`: automatic memory extraction
- `dream-*.log`: auto-dream consolidation

By default, terminal log lines are only printed when maintenance runs in foreground (`OPENCODE_MEMORY_FOREGROUND=1`). Background runs stay quiet unless you explicitly set `OPENCODE_MEMORY_TERMINAL_LOG=1`.

### Concurrency safety

Lock files prevent concurrent extraction/consolidation runs per project root. Stale locks are cleaned up automatically.

## 📝 Memory format

Each memory is a Markdown file with YAML frontmatter:

```markdown
---
name: User prefers terse responses
description: User wants concise answers without trailing summaries
type: feedback
---

Skip post-action summaries. User reads diffs directly.

**Why:** User explicitly requested terse output style.
**How to apply:** Don't summarize changes at the end of responses.
```

Supported memory types:
- `user`
- `feedback`
- `project`
- `reference`

## 🔧 Tools reference

- `memory_save`: save/update a memory
- `memory_delete`: delete a memory by filename
- `memory_list`: list memory metadata
- `memory_search`: search by keyword
- `memory_read`: read full memory content

## 🧪 Development

```bash
# Run tests
bun test

# Build artifacts
bun run build
```

See [`docs/`](docs/) for the design notes and experiment write-ups behind this fork.

## 📄 License

[MIT](LICENSE). Original work © [kuitos](https://github.com/kuitos) (upstream
[opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory)); fork
modifications © their respective authors.
