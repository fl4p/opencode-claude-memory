# Pi Memory Ecosystem Comparison

Date: 2026-06-28

This note compares `opencode-claude-memory` with seven existing Pi memory
packages:

- [`jayzeng/pi-memory`](https://github.com/jayzeng/pi-memory)
- [`jo-inc/pi-mem`](https://github.com/jo-inc/pi-mem)
- [`chandra447/pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory)
- [`VandeeFeng/pi-memory-md`](https://github.com/VandeeFeng/pi-memory-md)
- [`weauratech/pi-memctx`](https://github.com/weauratech/pi-memctx)
- [`walodayeet/pi-hindsight`](https://github.com/walodayeet/pi-hindsight)
- [`@remnic/plugin-pi`](https://github.com/joshuaswarren/remnic/tree/main/packages/plugin-pi)

The goal is to decide whether an `opencode-claude-memory` port to the Pi coding
agent is still worth doing, and what features should be borrowed from existing
Pi packages.

## Conclusion

None of the existing Pi packages makes this port redundant.

The existing packages are useful Pi-native memory systems, but they do not
preserve the core contract of this plugin: Claude-compatible, per-project,
typed Markdown memories with active LLM-selected recall and post-session
extraction/consolidation.

The pragmatic path is to port this plugin's storage, recall, extraction,
redaction, and harness-feedback model into a Pi extension, then selectively
borrow Pi-native UX from the other packages.

The closest additional candidates split into two groups:

- `pi-memory-md` and `pi-memctx` are closest to the local Markdown-file approach,
  but use their own memory repository or pack schema.
- `pi-hindsight` and `@remnic/plugin-pi` are closest at the Pi adapter layer,
  with strong recall, observation, compaction, and command patterns, but rely on
  external memory substrates instead of Claude-compatible files.

## What This Plugin Does Differently

`opencode-claude-memory` is centered on a curated memory engine:

- Claude-compatible storage under `~/.claude/projects/<sanitized-root>/memory/`
  and optional in-repo `<repo>/.claude/memory/`.
- One Markdown file per memory, with frontmatter, plus a `MEMORY.md` index.
- Typed memories: `user`, `feedback`, `project`, and `reference`.
- LLM-selected recall of up to five relevant memories per user turn.
- Recall injection guard and staleness warnings.
- Post-session extraction via `opencode-memory maintain`.
- Periodic dream consolidation to merge, prune, and update memories.
- In-repo secret scrubbing by default, plus optional global redaction.
- Cross-repo memory root allowlisting.
- `harness_feedback` sidecar for agent/tool behavior feedback that should not
  be recalled into future sessions.

Key local references:

- `src/paths.ts` - Claude-compatible root resolution and in-repo memory mode.
- `src/memory.ts` - memory file format, CRUD, index updates, redaction call.
- `src/recallSelector.ts` - hidden LLM selector for relevant memory files.
- `src/recall.ts` - recalled memory formatting and safety guard.
- `src/index.ts` - OpenCode hook wiring and memory tools.
- `bin/opencode-memory` - post-session extraction and dream consolidation.

## Package Comparison

| Package | What it does well | Gap vs this plugin | What to borrow |
|---|---|---|---|
| [`jayzeng/pi-memory`](https://github.com/jayzeng/pi-memory) | Lightweight Pi extension with Markdown storage, scratchpad, daily logs, qmd search, cache-stable snapshots, compaction handoff, and `memory_status`. | Uses a flat `~/.pi/agent/memory/MEMORY.md` store rather than Claude-compatible per-memory files. It has no typed memory file graph, no post-session extraction/dream, no root allowlist, no harness-feedback split, and qmd is the search substrate. | Cache-stable snapshot mode, `memory_status`, qmd health/status UX, scratchpad, daily log handoff, size-capped previews. |
| [`jo-inc/pi-mem`](https://github.com/jo-inc/pi-mem) | Simple Pi UX: Markdown memory, scratchpad checklist, daily logs, configurable context files, dashboard widget, and lightweight keyword search. | No semantic or LLM-selected recall, no structured per-memory metadata, no post-session extraction/consolidation, no secret scrub, no repo-scoped Claude layout. | Dashboard widget, scratchpad checklist, simple `PI_*` and `.pi-mem.json` config, session-start/session-switch UI patterns. |
| [`chandra447/pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory) | Most mature Pi-native system: SQLite FTS session search, memory search, background review, correction detection, failure memory, commands, skills, project skill discovery, and content scanning. | Different storage model: `MEMORY.md`, `USER.md`, `failures.md`, project buckets, and SQLite. Defaults to policy-only recall, has basename-based project scoping, and is not Claude-compatible. | Pi command surface, `/memory-preview-context`, session indexing/backfill, optional SQLite FTS mirror, `skill_manage`, project skill discovery, DB self-healing patterns, Pi child-process patterns. |
| [`VandeeFeng/pi-memory-md`](https://github.com/VandeeFeng/pi-memory-md) | Closest Pi-native Markdown analogue: git-backed memory repo, project/global scopes, frontmatter-based generated index, one-shot session delivery, sync hooks, packaged skills, BM25/rg search, and experimental tape anchors/threads/review UI. | Stores under `~/.pi/memory-md/<project-basename>/core/...`, not Claude-compatible `.claude/memory`. It lacks the canonical `MEMORY.md` pointer index, the `user/feedback/project/reference` API, post-session extraction/dream, `harness_feedback`, deterministic save-time redaction, and collision-safe project identity. | Git sync hooks as optional transport, hidden `message-append` delivery, `/memory-check`, `/memory-refresh`, BM25/rg search, memory init/import/digest skills, and tape/session-bridge ideas after the core port is stable. |
| [`weauratech/pi-memctx`](https://github.com/weauratech/pi-memctx) | Closest lifecycle/retrieval analogue: Markdown memory packs, automatic pre-turn Memory Gateway, qmd-or-grep retrieval, `agent_end` learning, review queue, workspace init/refresh, Pi commands, status overlay, and secret scanning/redaction. | Uses Obsidian-style packs under `.pi/memory-vault/packs` or `~/.pi/agent/memory-vault/packs`, with context/action/decision/observation/runbook/session notes. It is not Claude-compatible, has no post-session fork extraction or high-water marks, no dream consolidation, no `harness_feedback`, and no `extraMemoryRoots` model. | Memory Gateway UX, sufficiency/fallback briefs, qmd collection-scoped search with grep fallback, `/memctx-*` commands, review queue, debug snapshots, workspace bootstrap, doctor/status output, and scanners. |
| [`walodayeet/pi-hindsight`](https://github.com/walodayeet/pi-hindsight) | Strong Pi-native recall/retention adapter: fresh per-turn recall, hidden `hindsight-recall` filtering, durable `message_end` retention queue, stable session documents, tags/scopes, setup/status/doctor/profile/flush/popup commands, and explicit Hindsight tools. | Canonical store is an external Hindsight bank/server, not local Claude-compatible Markdown. Retention is session/message append, not curated single-fact extraction plus dream. It has no `MEMORY.md` index, no per-memory frontmatter graph, no local root allowlist, and no harness-feedback sidecar. | Hook wiring for recall and flush, queue/flush UX, session import/backfill, tags/scopes profiles, raw-input recall query derivation, last-recall popup, UI-only indicators, provider-message pruning, and `#nomem` / `#skip`. |
| [`@remnic/plugin-pi`](https://github.com/joshuaswarren/remnic/tree/main/packages/plugin-pi) | Closest Pi adapter peer: native `context` recall before model calls, `message_end`/`turn_end`/`session_shutdown` observation, `session_before_compact` long-context flush/checkpoint/token recording, MCP tools as Pi tools, slash commands, and hardened installer/config. | Delegates memory semantics to the Remnic daemon/core, not a Claude-compatible store. It has no local typed Claude files, no filename selector, no OpenCode-style fork extractor/dream, no `harness_feedback`, and no in-repo `.claude/memory` redaction contract. Requires Remnic daemon and auth token. | Pi lifecycle integration, compaction handoff, MCP proxy field-stripping, recall explanation/debug commands, persistent dedupe via Pi custom entries, namespace/session routing, and installer hardening. |

## Feature Gap Matrix

These are features present in one or more Pi memory packages that this plugin
does not currently have, or does not have in Pi-native form.

| Feature | Found in | Why it matters | Recommendation |
|---|---|---|---|
| Scratchpad/checklist memory | `jayzeng/pi-memory`, `jo-inc/pi-mem` | Gives the agent a place for transient follow-ups without polluting durable memory. | Borrow. Keep separate from curated memories and never include in `MEMORY.md`. |
| Daily append-only logs | `jayzeng/pi-memory`, `jo-inc/pi-mem` | Useful for lightweight session continuity and compaction handoff. | Consider as a Pi-only auxiliary log, not a replacement for extraction. |
| Compaction handoff | `jayzeng/pi-memory`, `jo-inc/pi-mem` | Captures open scratchpad items and recent context before Pi compacts the session. | Borrow for Pi lifecycle integration. |
| Cache-stable memory snapshot | `jayzeng/pi-memory` | Preserves KV/prefix cache stability by avoiding prompt changes every turn. | Borrow selectively. Balance this against active LLM recall. |
| `memory_status` doctor tool | `jayzeng/pi-memory` | Makes path, qmd, snapshot, and search state inspectable. | Borrow. Add status for Claude path, local/global mode, redaction, index size, and recall selector. |
| qmd-backed semantic/hybrid search | `jayzeng/pi-memory` | Gives fast lexical plus optional semantic search over Markdown. | Optional only. Do not make qmd a hard dependency or canonical store. |
| Dashboard widget | `jo-inc/pi-mem` | Good Pi-native visibility for recent sessions and open scratchpad items. | Borrow later if Pi UI hooks are stable. |
| Last-24h summary | `jo-inc/pi-mem` | Helps users re-enter work after many sessions. | Optional. Keep separate from memory extraction to avoid saving activity logs as durable facts. |
| SQLite FTS memory search | `pi-hermes-memory` | Fast search and filtering, independent of qmd. | Consider as an optional mirror, not source of truth. |
| SQLite session search | `pi-hermes-memory` | Lets the agent search past Pi conversations directly. | Valuable Pi-native addition, but separate from curated memory. |
| Session indexing/backfill | `pi-hermes-memory` | Enables search over historical Pi sessions. | Borrow if implementing session search. |
| `/memory-preview-context` | `pi-hermes-memory` | Lets users inspect what memory context would be injected. | Borrow. Very useful for debugging recall and prompt bloat. |
| Pi command surface | `pi-hermes-memory` | Makes memory maintenance discoverable from chat. | Borrow commands for status, preview, maintain, dream, and sync. |
| Skill management | `pi-hermes-memory` | Stores reusable procedures as Pi-native skills. | Consider as a separate feature. Do not mix skills with memories. |
| Project skill discovery | `pi-hermes-memory` | Lets project-specific skills follow the project. | Consider later; not part of the first memory port. |
| Background review every N turns/tools | `pi-hermes-memory` | Saves notable facts without waiting for shutdown. | Be cautious. This can over-capture transient state. Prefer the existing extraction pipeline first. |
| Correction detection | `pi-hermes-memory` | Saves user corrections quickly. | Borrow only with strict durable-memory criteria and duplicate checks. |
| Failure/correction/insight categories | `pi-hermes-memory` | Useful for debugging memory and repeated mistakes. | Map carefully. Some belong in `feedback`, some in `project`, and some in `harness_feedback`. |
| Content scanner | `pi-hermes-memory` | Blocks prompt injection and obvious secrets before persistence. | Borrow concepts, but tune to avoid blocking safe credential-location references. |
| Git-backed memory sync | `pi-memory-md` | Pull/push hooks, fetch TTL, rebase/autostash, and auto-commit make file memory portable across machines. | Consider optional transport for `.claude/memory`; do not replace the canonical store. |
| Hidden one-shot context delivery | `pi-memory-md` | Delivers memory as an invisible custom message once per session, reducing repeated prompt cost. | Borrow as an optional delivery mode, while preserving recall guard language. |
| Shared global memory scope | `pi-memory-md` | Provides cross-project global notes alongside project memory. | Consider mapping to explicit extra roots or a global allowed root. |
| BM25 and bounded rg search | `pi-memory-md` | Gives fast local lexical search without qmd or SQLite. | Borrow as a fallback or diagnostic path. |
| Tape anchors and task threads | `pi-memory-md` | Stores resumable long-running task anchors, decisions, next steps, files, and memory links. | Consider later for Pi goal continuity; keep separate from durable memory. |
| Session bridge | `pi-memory-md` | Bridges relevant context from recent `new`, `resume`, or `fork` sessions. | Borrow carefully for Pi session transitions; avoid turning it into curated memory. |
| Import/digest skills | `pi-memory-md` | Provides guided import from URLs/files/folders and tape-to-memory digest workflows. | Borrow skill UX for optional import; typed tools remain authoritative for writes. |
| Memory Gateway sufficiency states | `pi-memctx` | Classifies retrieved memory as sufficient, partial, insufficient, or conflicting, then injects fallback guidance. | Borrow for recall debugging and bounded tool-use control. |
| Workspace bootstrap and refresh | `pi-memctx` | Scans repos, docs, manifests, workflows, git, and safe commands to generate starter memory. | Add as optional import/bootstrap, never as automatic replacement for curated memory. |
| Review queue for learned memories | `pi-memctx` | Low-confidence auto-learn candidates wait for approve/reject instead of writing immediately. | Borrow before enabling high-volume auto-learning. |
| Gateway debug snapshots | `pi-memctx` | Writes sanitized/truncated retrieval diagnostics for recall-quality debugging. | Borrow for evals and support. |
| Tool-failure memory hints | `pi-memctx` | Searches memory after failed tools to surface relevant troubleshooting notes. | Consider as a later Pi UX feature. |
| Offline retention queue | `pi-hindsight` | Queues memory retention records when writes cannot flush immediately. | Borrow for robust post-session extraction/observation pipelines. |
| Session document import/backfill | `pi-hindsight` | Parses and upserts current or historical Pi sessions as stable documents. | Borrow for session search, not curated memory. |
| Tags and observation scopes | `pi-hindsight` | Routes memory by session, parent, cwd, project, and store method. | Consider metadata mapping; do not treat tags as hard security boundaries. |
| Raw-input recall query derivation | `pi-hindsight` | Uses the user's raw input rather than expanded skill/slash-command bodies for recall. | Borrow to avoid noisy recall queries in Pi. |
| Provider-context filtering | `pi-hindsight` | Filters stale hidden recall messages before provider serialization. | Borrow if using hidden/custom recall messages. |
| Native Pi observation stream | `@remnic/plugin-pi` | Observes user, assistant, and tool-result messages as Pi-native structured parts with dedupe. | Borrow as passive archive/extraction input; do not equate observation with curated memory. |
| Long-context compaction checkpointing | `@remnic/plugin-pi` | Flushes archive before compaction and records token deltas/checkpoint summaries. | Borrow for Pi lifecycle integration; keep separate from dream consolidation. |
| MCP tool bridge hardening | `@remnic/plugin-pi` | Exposes daemon MCP tools as Pi tools while stripping runtime-owned `sessionKey`, `namespace`, and `cwd`. | Borrow trust-boundary pattern if adding MCP or daemon-backed tools. |
| Recall explanation/debug UX | `@remnic/plugin-pi`, `pi-hindsight` | Commands like `/remnic-why` and `/hindsight:popup` make injected context auditable. | Borrow as `/memory-why`, preview, and status UX for our selector. |
| Installer/config hardening | `@remnic/plugin-pi` | CLI writes auto-discovery wrapper/config/README, uses private token config, rejects unsafe path layouts, and shortens startup probes. | Borrow for a Pi installer or package setup flow. |

## Features This Plugin Has That They Generally Do Not

These are the features that justify a first-party port rather than adopting an
existing Pi package as-is.

| Feature | Why it matters |
|---|---|
| Claude-compatible `.claude` memory layout | Allows memory sharing with Claude Code and keeps compatibility with the existing OpenCode plugin behavior. |
| Per-memory Markdown files with frontmatter | Enables topic-level recall, descriptions, types, timestamps, provenance, and safe updates. |
| `MEMORY.md` as index only | Keeps always-loaded context concise while preserving discoverability. |
| LLM-selected recall | Selects relevant memories based on name/description rather than dumping all memory or relying only on keyword search. |
| Recalled memory injection guard | Prevents memory content from acting like fresh user instructions. |
| Staleness warnings | Reminds the agent that memory can be outdated and must be verified against current repo state. |
| Post-session extraction | Mines durable facts after the full session, instead of relying only on in-session tool calls or background nudges. |
| Dream consolidation | Keeps the memory store small, deduped, and current. |
| In-repo memory mode | Allows project memory to be committed and reviewed when the user opts in. |
| Save-time secret scrubbing | Redacts credential values from in-repo memory by default. |
| Cross-repo memory roots | Lets declared repos expose read-only memory without arbitrary writes. |
| Root allowlisting | Prevents the model from writing memory to undeclared filesystem locations. |
| `harness_feedback` sidecar | Captures agent/tool behavior feedback for the harness developer without polluting recalled memory. |
| Provenance-aware extraction | Anchors extracted code-change memories to commits and file references where possible. |

## Borrow And Avoid

Borrow:

- Pi lifecycle hooks for session start, before-agent-start, before-compact, and
  shutdown.
- Pi-native commands for status, preview, maintain, dream, and session indexing.
- A scratchpad/checklist, kept separate from durable memory.
- Cache-stable snapshot mechanics where they do not undermine active recall.
- Optional qmd or SQLite search mirrors.
- Session search as a separate capability from curated memory.
- Content-scanner ideas for prompt-injection and secret safety.
- Pi UI widgets after the core port is stable.
- Optional git sync for memory transport, without changing the `.claude` store.
- Hidden/custom-message delivery where it improves token cost and can be safely
  filtered before provider calls.
- Review queues for any high-volume auto-learning mode.
- Recall sufficiency/fallback diagnostics, including a `/memory-why` or
  `/memory-preview-context` command.
- Session import/backfill and passive observation as inputs to extraction and
  search, not as direct curated memory.
- MCP/daemon trust-boundary patterns if exposing external memory tooling.
- Installer hardening: private config permissions, symlink/path containment, and
  short startup probes.

Avoid:

- Replacing the per-memory file store with a flat append-only `MEMORY.md`.
- Making qmd or SQLite the canonical source of truth.
- Basename-only project identity.
- Policy-only recall as the only default.
- Broad substring mutation for curated memories.
- Delimiter-based durable storage such as section-sign-delimited entries.
- Treating daily logs, session summaries, or Last-24h dashboards as curated
  memory.
- Background review that saves without the existing extraction discipline.
- Overbroad scanners that reject useful reference memories, such as "credentials
  live in ~/.service-creds" without secret values.
- Replacing the Claude-compatible store with memory packs, Hindsight banks,
  Remnic daemon memory, or basename-scoped project folders.
- Relying on prompt/skill-only writes for security-critical persistence.
- Treating tags/scopes as hard security boundaries.
- Persisting hidden recall messages without provider-context filtering and a
  pruning path.
- Turning every observed event or session stream into curated memory without the
  extraction and dream discipline.
- Direct retain/store writes without deterministic redaction and injection-guard
  framing.

## Recommended Port Direction

Build the Pi port around this plugin's existing memory model:

1. Preserve Claude-compatible paths, per-memory Markdown files, and the
   `MEMORY.md` index.
2. Port the structured tools: `memory_save`, `memory_delete`, `memory_list`,
   `memory_search`, `memory_read`, and `harness_feedback`.
3. Implement Pi-native recall injection with the same guard and staleness
   language.
4. Port post-session extraction and dream consolidation using Pi lifecycle hooks
   and, where needed, a Pi child process.
5. Add Pi-native diagnostics and preview commands.
6. Add optional scratchpad, qmd/SQLite/BM25 search mirrors, git sync, session
   search, and passive observation only after the core compatibility port is
   stable.
7. Treat richer systems such as tape threads, memory gateway sufficiency, review
   queues, MCP bridges, and long-context checkpointing as follow-on Pi UX
   features rather than requirements for the initial compatibility port.
