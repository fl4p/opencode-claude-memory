# opencode-claude-memory

Claude Code-compatible persistent memory for OpenCode. Both tools read and write the same
Markdown memory files, so they share one project context.

A fork of [kuitos/opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory),
keeping the upstream store and format and adding the items below. Design notes are in
[`docs/`](docs/).

## What this fork adds

- **Two-phase extraction** — Phase 1 captures harness feedback (kept out of recall),
  Phase 2 captures durable memory. Extraction/dream/recall models are configurable;
  default is GLM-4.6 (`opencode/big-pickle`).
- **In-repo memory** — store memory at `<repo>/.claude/memory/` instead of the global
  `~/.claude` store, so it can be committed. Same path Claude Code uses, so they still share.
- **Secret scrubbing for in-repo memory** — in-repo writes have credential values scrubbed
  by default (the global store is left alone). Opt out with `localMemorySecrets`.
- **Index size-limit warning** — when `MEMORY.md` gets large, the agent offers to compact it.
- **Cross-repo memory** — surface other repos' memory read-only via `extraMemoryRoots`.

## Install

Requires `opencode` and `python3` on `PATH`.

```bash
npm install -g opencode-claude-memory
opencode-memory install        # installs the shell hook
```

Enable it in `opencode.json`, then use opencode normally:

```jsonc
{ "plugin": ["opencode-claude-memory"] }
```

Uninstall with `opencode-memory uninstall` then `npm uninstall -g opencode-claude-memory`
(saved memories are kept).

## How it works

The shell hook wraps `opencode`. After each session it forks the session to extract memory
(if none was written), then runs a consolidation pass if the auto-dream gate passes (by
default 24h since the last run and 5 touched sessions). Maintenance runs in the background
unless `OPENCODE_MEMORY_FOREGROUND=1`. During a session the plugin injects the memory
prompt and surfaces relevant memories via LLM recall.

## Where memory is stored

Default (global, shared with Claude Code):

```
~/.claude/projects/<sanitized-canonical-git-root>/memory/
```

Or in-repo at `<repo>/.claude/memory/`, set via `OPENCODE_MEMORY_LOCAL` / `localMemory`:

- `off` — always global
- `on` — always in-repo (created if absent)
- `auto` (default) — in-repo only if `.claude/memory/` already exists, else global

So `mkdir -p .claude/memory` opts a repo in. Memory keys off the canonical git root, so
subdirectories and worktrees share one store.

**Secrets:** in-repo writes scrub credential values (`«REDACTED»`) by default, since that
store can be pushed; the private global store is untouched. It is a safety net, not a
guarantee — review before pushing. Disable with `OPENCODE_MEMORY_LOCAL_SECRETS` /
`localMemorySecrets`.

## Configuration

Each setting is an env var or an `opencode.json` option. Precedence: env var, then
`opencode.json`, then default.

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_MEMORY_EXTRACT` | `1` | `0` disables post-session extraction |
| `OPENCODE_MEMORY_FOREGROUND` | `0` | `1` runs maintenance in foreground |
| `OPENCODE_MEMORY_TERMINAL_LOG` | foreground-only | `1`/`0` forces terminal logs on/off |
| `OPENCODE_MEMORY_MODEL` / `OPENCODE_MEMORY_AGENT` | opencode default | Extraction model / agent |
| `OPENCODE_MEMORY_RECALL_MODEL` / `OPENCODE_MEMORY_RECALL_AGENT` | default / `opencode-memory-recall` | Recall model / agent |
| `OPENCODE_MEMORY_AUTODREAM` | `1` | `0` disables consolidation |
| `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS` / `_MIN_SESSIONS` | `24` / `5` | Consolidation gate |
| `OPENCODE_MEMORY_AUTODREAM_MODEL` / `_AGENT` | extraction model / agent | Consolidation model / agent |
| `OPENCODE_MEMORY_LOCAL` | `auto` | In-repo memory: `on` / `off` / `auto` |
| `OPENCODE_MEMORY_LOCAL_SECRETS` | `off` | `on` allows secrets in in-repo memory |
| `OPENCODE_MEMORY_INDEX_MAX_LINES` | `160` | `MEMORY.md` soft limit; `0`/`off` disables |
| `OPENCODE_MEMORY_EXTRA_ROOTS` | — | Extra memory roots (split on `, ; :` or newline) |

The model/local/index settings can also go in `opencode.json`:

```jsonc
{
  "plugin": [
    {
      "package": "opencode-claude-memory",
      "options": {
        "extractModel": "opencode/big-pickle",   // dreamModel defaults to this
        "recallModel":  "openai/gpt-4o-mini",
        "localMemory":  "auto",                   // on | off | auto
        "localMemorySecrets": false,
        "indexMaxLines": 160,
        "extraMemoryRoots": ["/abs/path/to/other-repo"]
      }
    }
  ]
}
```

Note: on opencode `1.17.x` the entry is a tuple instead:
`"plugin": [["opencode-claude-memory", { ... }]]`. The wrapper accepts both.

Check resolved settings without launching a session:
`OPENCODE_MEMORY_PRINT_SETTINGS=1 opencode run`.

Logs go to `$TMPDIR/opencode-memory-logs/`. Lock files prevent concurrent runs per repo.

## Cross-repo memory

Declare other repos to surface their memory read-only:

```jsonc
"options": { "extraMemoryRoots": ["/abs/path/to/other-repo"] }
```

Each declared repo's index is injected read-only, and `memory_*` tools accept an optional
`root` argument pointing at a declared repo (omitting it means the session's repo). Any
other `root` is rejected. Recall, extraction, and consolidation still run on the session's
own repo.

## Memory format

A Markdown file with YAML frontmatter; types are `user`, `feedback`, `project`, `reference`.
A `MEMORY.md` index holds one-line pointers and is loaded each session.

```markdown
---
name: User prefers terse responses
description: User wants concise answers without trailing summaries
type: feedback
---

Skip post-action summaries. User reads diffs directly.
```

## Tools

`memory_save`, `memory_delete`, `memory_list`, `memory_search`, `memory_read`.

## Development

```bash
bun test        # run tests
bun run build   # build
```

## License

[MIT](LICENSE). Original work © [kuitos](https://github.com/kuitos); fork modifications ©
their respective authors.
