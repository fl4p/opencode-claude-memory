# opencode-claude-memory

Claude Code-compatible persistent memory for OpenCode. Both agents read and write the same
Markdown memory files, so they share one project context.

A fork of [kuitos/opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory),
keeping the upstream store and format and adding the items below. Design notes are in
[`docs/`](docs/).

## What this fork adds

- **Post-session memory extraction** — after a session it mines the transcript for durable
  memories. Extraction/dream/recall models are configurable; left unset, extraction reuses
  the session's own model so the fork hits a warm prompt cache (set `extractModel` to pin a
  dedicated extractor like GLM-4.6 / `opencode/big-pickle`).
- **Dream consolidation** — a periodic pass collapses duplicate memories and prunes stale or
  invalidated ones, keeping the store small and current.
- **In-repo memory** — store memory at `<repo>/.claude/memory/` instead of the global
  `~/.claude` store, so it can be committed. Same path Claude Code uses, so they still share.
- **Secret scrubbing for in-repo memory** — in-repo writes have credential values scrubbed
  by default (the global store is left alone). Opt out with `localMemorySecrets`.
- **Harness-feedback sidecar** — observations about how the agent and tools behaved are
  captured to a separate global sidecar and kept out of recall (and out of any committable
  in-repo store).
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

### During a session

The plugin injects the memory prompt (the `memory_*` tool instructions plus the `MEMORY.md`
index) and, on each user turn, surfaces the memories relevant to that message via **LLM
recall**: a small, fast model (the configurable `recallModel`) reads your message and each
memory's one-line description and picks which to inject (up to 5). It's an LLM relevance
judgment rather than keyword or embedding search, and it runs as a non-blocking prefetch so
it doesn't add turn latency.

### After a session

The shell hook wraps `opencode`. After each session it forks the session to extract memory
(if none was written). Forking replays the session's own conversation context to the
extractor rather than serializing a transcript, and **by default extraction runs on the
session's own model** — so the fork lands on a warm prompt cache and the pass is cheap
(it only pays for the new extraction turn, not a re-read of the whole conversation). Pin a
*different* `extractModel` (e.g. a dedicated cheaper or stronger extractor like GLM-4.6) and
that model has no shared cache, so it must prefill the entire conversation as fresh input —
better extraction, higher token cost. Disable the session-model matching with
`OPENCODE_MEMORY_MATCH_SESSION_MODEL=0`. It then runs a consolidation pass if the auto-dream
gate passes (by default 24h since the last run and 5 touched sessions). Maintenance runs in
the background unless `OPENCODE_MEMORY_FOREGROUND=1`.

### When opencode isn't wrapped

When opencode is launched directly (not through the hook) — e.g. an editor integration — the
post-session step never runs. For those cases, `opencode-memory maintain [--dir DIR]` runs
extraction + the auto-dream gate on the latest session for `DIR` without starting an
interactive opencode, so you can wire it to a cron job or an on-close hook. It honours the
same `OPENCODE_MEMORY_*` model/bin settings. `opencode-memory dream [--dir DIR]` runs a
single consolidation pass (collapse duplicates, prune stale/invalidated) over `DIR`'s live
memory store, bypassing the auto-dream gate.

### Fork cleanup

Extraction and dream both work by forking the session (`opencode run --fork`), which creates a
throwaway `<title> (fork #N)` session. Each run deletes its own fork afterward, identified by
snapshotting session ids immediately before the fork and deleting the new one that appears —
this is exact even when several of your sessions share a title (a title-plus-time-window match
is not, and older versions leaked forks into `opencode session list` whenever titles collided).
If leftover forks accumulated under an older version, `opencode-memory purge-forks [--dir DIR]`
lists them (dry run); add `--yes` to delete, `--all` to sweep every directory instead of just
the current repo. It removes **turn-less** `(fork #N)` sessions — forks with no message of their
own after the fork point (abandoned copies and leaked extraction/dream forks). A fork you
actually continued always has later messages, so real work is never touched.

Every consolidation pass (auto or forced) appends one audit line to a persistent **dream
journal** at `$STATE_DIR/dream-journal.log` — timestamp, mode, ok/fail, delete/save counts,
model, host session, and dir — so `tail` answers "did a dream already run on this store, and
what did it change?" without digging through the ephemeral per-run logs in `$TMPDIR`.

**Idle-triggered maintain (no wrapper, no hook).** Instead of wiring `maintain` externally,
the plugin itself can fire it: set `OPENCODE_MEMORY_MAINTAIN_ON_IDLE=1` (or `maintainOnIdle:
true`) and it subscribes to opencode's `session.idle` event and spawns `opencode-memory
maintain --dir <cwd>` once the session goes quiet. This works for **any** launch — dashboard
tile, bare CLI, editor — with no shell hook and no per-launcher config. It is **off by
default** so that running opencode *through* the wrapper doesn't extract twice. A new turn
cancels the pending run, so maintain fires once per quiet period rather than every turn (the
incremental high-water mark makes any overlap a cheap near-noop); tune the debounce with
`OPENCODE_MEMORY_MAINTAIN_IDLE_SECONDS` (default 30). It spawns the wrapper detached, so it
never adds turn latency.

### Incremental extraction

Extraction is incremental: it records how many user turns a session had when it was last
extracted, so resuming a session re-mines only the new turns (and skips entirely when
nothing new was said) rather than re-processing the whole conversation. Set
`OPENCODE_MEMORY_INCREMENTAL=0` to always re-mine the full session.

The high-water mark is a count of user turns, so it assumes the transcript only grows. If a
session is edited in place (same turn count, changed content) the unchanged count means that
edit is skipped; if a transcript is compacted/shrinks, the stale mark is discarded and a
full re-mine runs. The "turns 1..N already done" boundary the extractor is given is phrased
in OpenCode user-turn terms; against a different transcript shape the index could drift,
though the gate itself only needs the count to be monotonic.

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
`localMemorySecrets`. The global store keeps secrets by default; for belt-and-suspenders you
can opt the same scrub onto global writes with `OPENCODE_MEMORY_REDACT_GLOBAL` /
`redactGlobalSecrets`. The scrub is keyword-anchored and best-effort, not a guarantee.

**Harness feedback stays global.** The harness-feedback sidecar (observations about how the
agent and tools behaved) is always written to the global `~/.claude/.../harness-feedback.md`
sidecar, even in in-repo mode. It is developer feedback, not curated project memory, so it is
deliberately kept out of a committable `.claude/memory`. Only the durable memories follow the
in-repo switch.

In-repo mode and `extraMemoryRoots` are independent: the `on`/`off`/`auto` switch governs
only the session's own repo. Repos surfaced via `extraMemoryRoots` are always read with
`auto` semantics, so `localMemory: on` never creates a `.claude/memory` inside another repo
just because its index was surfaced.

## Configuration

Each setting is an env var or an `opencode.json` option. Precedence: env var, then
`opencode.json`, then default.

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_MEMORY_OPENCODE_BIN` | PATH lookup | Path to the `opencode` binary to wrap (e.g. a local dev build) |
| `OPENCODE_MEMORY_EXTRACT` | `1` | `0` disables post-session extraction |
| `OPENCODE_MEMORY_INCREMENTAL` | `1` | `0` re-mines the whole session on each resume instead of only new turns |
| `OPENCODE_MEMORY_FOREGROUND` | `0` | `1` runs maintenance in foreground |
| `OPENCODE_MEMORY_TERMINAL_LOG` | foreground-only | `1`/`0` forces terminal logs on/off |
| `OPENCODE_MEMORY_MODEL` / `OPENCODE_MEMORY_AGENT` | session's own model / opencode default | Extraction model / agent. Unset, extraction reuses the session's model (warm cache, cheap) |
| `OPENCODE_MEMORY_MATCH_SESSION_MODEL` | `1` | `0` stops matching the session's model when no extraction model is set (falls back to opencode's default model) |
| `OPENCODE_MEMORY_RECALL_MODEL` / `OPENCODE_MEMORY_RECALL_AGENT` | default / `opencode-memory-recall` | Recall model / agent |
| `OPENCODE_MEMORY_AUTODREAM` | `1` | `0` disables consolidation |
| `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS` / `_MIN_SESSIONS` | `24` / `5` | Consolidation gate |
| `OPENCODE_MEMORY_AUTODREAM_MODEL` / `_AGENT` | extraction model / agent | Consolidation model / agent |
| `OPENCODE_MEMORY_MAINTAIN_ON_IDLE` | `0` | `1` makes the plugin spawn `maintain` on `session.idle` (extraction without the wrapper or a hook) |
| `OPENCODE_MEMORY_MAINTAIN_IDLE_SECONDS` | `30` | Debounce: quiet seconds after idle before idle-maintain fires |
| `OPENCODE_MEMORY_LOCAL` | `auto` | In-repo memory: `on` / `off` / `auto` |
| `OPENCODE_MEMORY_LOCAL_SECRETS` | `off` | `on` allows secrets in in-repo memory |
| `OPENCODE_MEMORY_REDACT_GLOBAL` | `off` | `on` also scrubs credential values from global writes (opt-in defense-in-depth) |
| `OPENCODE_MEMORY_INDEX_MAX_LINES` | `160` | `MEMORY.md` soft limit; `0`/`off` disables |
| `OPENCODE_MEMORY_EXTRA_ROOTS` | — | Extra memory roots (split on `, ; :` or newline) |

The model/local/index settings can also go in `opencode.json`, as a `["package", {options}]`
tuple entry:

```jsonc
{
  "plugin": [
    ["opencode-claude-memory", {
      "extractModel": "opencode/big-pickle",   // dreamModel defaults to this
      "recallModel":  "openai/gpt-4o-mini",
      "localMemory":  "auto",                   // on | off | auto
      "localMemorySecrets": false,
      "redactGlobalSecrets": false,             // opt-in: scrub global writes too
      "maintainOnIdle": false,                  // opt-in: run maintain on session.idle
      "indexMaxLines": 160,
      "extraMemoryRoots": ["/abs/path/to/other-repo"]
    }]
  ]
}
```

Use the tuple form — current opencode validates the plugin schema as `string | array` and
**rejects** the `{ "package": ..., "options": ... }` object form ("Expected string | array").
The wrapper reads options from either shape, but opencode itself must accept the entry first.

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
