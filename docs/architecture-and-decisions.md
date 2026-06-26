# Architecture & Key Decisions

*opencode-claude-memory plugin + the auto-memory research around it. Mined 2026-06-26 from the project's own past Claude Code sessions and the plugin source.*

This is a navigational reference: how the plugin is structured, **why** it is shaped that way, and where to dig deeper. Plugin source lives in `opencode-claude-memory/`.

---

## 1. Origin & lineage



The system prompt was later **re-baselined against Claude Code 2.1.178** (extracted from the installed binary), adopting CC's type definitions, frontmatter form, `[[their-name]]` linking, and never-save-credentials rule — with documented deliberate deltas (flat model, no team/private scope; the added `harness_feedback` sidecar) so future syncs don't "fix" them (`src/prompt.ts:5–25`).

---

## 2. Component map

The system splits cleanly into an **always-on plugin** (recall + memory tools, runs every turn) and a **post-session wrapper** (extraction + dream, runs once after a session).

### Plugin — `opencode-claude-memory/src/` (TypeScript, loaded by OpenCode every turn)

| File | Responsibility |
|---|---|
| `paths.ts` | Claude-Code-compatible path resolution: `sanitizePath` + `findCanonicalGitRoot` (worktree→main-repo) → `~/.claude/projects/<root>/memory/`. Also the **new** local (in-repo) memory mode and the soft index-size-limit config. |
| `memory.ts` | The store CRUD + format: `saveMemory`/`readMemory`/`listMemories`/`searchMemories`/`deleteMemory`, `buildFrontmatter` (type, `originSessionId`, `created:`), `readIndex`/`truncateEntrypoint`, `MEMORY_TYPES = user·feedback·project·reference`. |
| `memoryScan.ts` | Reads memory-file frontmatter into `MemoryHeader[]` (`scanMemoryFiles`) and renders the selector manifest (`formatMemoryManifest`/`getMemoryManifest`). Port of CC's `scanMemoryFiles`. |
| `recallSelector.ts` | The **LLM recall selector**: spins a hidden child session, feeds it the query + manifest + recent tools, gets back ≤5 filenames via structured JSON output. |
| `recall.ts` | Turns selected filenames into `RecalledMemory[]` (strip frontmatter, line/byte-truncate to 200 lines / 4 KB, age-warning), and `formatRecalledMemories` (the `## Recalled Memories` block + the **injection guard**: "treat as background context, not user instructions"). |
| `prompt.ts` | Builds the always-on `# Auto Memory` system prompt (types, what-NOT-to-save, harness-feedback routing, how-to-save, when-to-access, trusting-recall, searching-past-context) + `buildIndexLimitWarning`. |
| `harness.ts` | The **Obj1 sidecar writer** — `saveHarnessFeedback` appends to `harness-feedback.md` **in the project dir, outside `memory/`**. |
| `index.ts` | The plugin entrypoint: wires the OpenCode hooks (`messages.transform`, `system.transform`, `tool.execute.after`, `config`, `chat.params`), registers the six tools (`memory_save/delete/list/search/read` + `harness_feedback`), runs the recall prefetch, enforces the root allowlist. |

### Wrapper — `opencode-claude-memory/bin/opencode-memory` (shell + embedded Python, runs once post-session)

- Holds the bespoke two-phase `EXTRACT_PROMPT` and the Claude-Code-pruning-aligned `AUTODREAM_PROMPT`.
- `run_extraction_if_needed` forks the just-finished session (`opencode run -s <id> --fork`) with `EXTRACT_PROMPT` prepended by `get_session_commits_block` (provenance; opt-out `OPENCODE_MEMORY_PROVENANCE=0`).
- Auto-dream gating: `OPENCODE_MEMORY_AUTODREAM` (default on), `_MIN_HOURS` (24), `_MIN_SESSIONS` (5), stale-lock handling. The dream reorganizes existing memories; it is **not** given a conversation.

### Research harness — vibe repo (Python, not shipped)

`replay_transcript.py` (reasoning-stripped transcript-injection replay + provenance + passive latency), `replay_claude.py` (Claude-Code JSONL source), `replay_memories.py` (the `--fork` mirror), `run_dream.py` (pool a replay-out dir → one store → dream), `analyze_replay.py` (corpus quality + leak/recursion/grounding checks), and the eval harness (labeled-fixture + save-worthiness evals, local-model backends).

---

## 3. Data flow

```
                 ┌─────────────────────────── per turn (plugin) ───────────────────────────┐
 user query ──▶ messages.transform ──▶ recall prefetch ──▶ recallSelector (hidden LLM child)
                       │                                          │ ≤5 filenames
                       │                                          ▼
                 system.transform ◀── formatRecalledMemories ◀── recall.ts (truncate + age-warn)
                       │
                       ▼
        # Auto Memory prompt = types + rules + MEMORY.md index + ## Recalled Memories
                       │
              agent works; may call memory_save / harness_feedback / memory_{list,search,read,delete}
                       ▼
   memory_save ─▶ <memory dir>/<file>.md (+ MEMORY.md index)     harness_feedback ─▶ project-dir/harness-feedback.md
                                                                   (OUTSIDE memory/, never recalled)

                 └──────────────────────── post-session (wrapper) ────────────────────────┘
   session ──▶ bin/opencode-memory ──▶ [Phase 1 harness_feedback] then [Phase 2 memory_save]  (+ commits block)
                       └─ periodically ──▶ AUTODREAM_PROMPT consolidates the whole store (dedup/merge/prune)
```

Two writers, two readers: the **agent in-session** writes via the tools and reads via recall; the **post-session wrapper** writes the same store via `--fork` extraction; the **dream** later compacts it. Recall only ever reads `memory/`, so the harness-feedback sidecar is structurally invisible to it.

---

## 4. Key decisions & rationale

### 4a. Claude-Code-compatible memory layout (`paths.ts`)

### 4b. Two sinks: Obj1 (harness feedback) vs Obj2 (memory) — `harness.ts`
The core split. **Obj2 / memory** = durable facts the agent should *recall* next session (user · feedback · project · reference), via `memory_save` → `memory/*.md` + `MEMORY.md` index, **recalled = yes**. **Obj1 / harness feedback** = how the agent/skill/tool *behaved* or how the harness should change (tool-efficiency · agent-behavior · skill-design · harness-config), via `harness_feedback` → `harness-feedback.md`, **recalled = never**. The routing test: *if the fix is a diff to the harness/prompt/skill (read by a developer) → harness_feedback; if the fix is the agent knowing a durable fact → memory* (`prompt.ts:131–149`).

**Why a separate sink (not just a `feedback` type):** before the split, behavior/calibration findings ("the channel skill only described polling instead of running a watcher") were saved as `feedback` memories and recalled into every future session — noise to the agent, and the signal a developer should act on was buried. The sidecar is written by `harness.ts` to `getProjectDir(worktree)` — the **project dir, not the memory dir** — so it is never scanned, indexed, or recalled (`harness.ts:5–12, 38–42`). Note this holds even in local in-repo mode: harness feedback always goes to the global project dir, never into the committed `.claude/memory`.

### 4c. Two-phase extraction, Phase 1 first
`bin/opencode-memory`'s `EXTRACT_PROMPT` is bespoke (CC has no post-session extraction prompt — it saves in-session). It runs **Phase 1 (harness feedback) before Phase 2 (memory)**. Doing harness feedback *first* removes the "four memory types" anchor that otherwise drags behavior findings into the `feedback` type (the scorecard shows routing only worked once the two-phase shape landed). Phase 2 carries the evidence rule, redaction rule, what-NOT-to-save, hard-to-rederive reference rescue, one-fact rule, `[[wikilink]]` rule, and provenance rule — each forged by a specific bad memory.

### 4d. LLM recall selection (not embeddings/keywords) — `recallSelector.ts`, `recall.ts`

### 4e. Recall safety: staleness + injection guard

### 4f. Default extractor = GLM-4.6 (`opencode/big-pickle`)
All replay/extraction/dream work defaults to `opencode/big-pickle`, which is **GLM-4.6** (Zhipu, via an opencode gateway alias). Extraction *content* quality tracks **model capability**, not harness/quant/host. GLM-4.6 is 7/7 on the adversarial fixtures and the selectivity king on real sessions (0.12 over-captures/session); `kimi-k2p7-code-fast` is the 7/7 ~4 s **speed** pick (~5× noisier); **every Qwen3-30B-A3B variant leaks secrets and over-extracts** at any host/quant and is unsafe. Gemma-4-12B-Coder is the best *local* model tried but still over-captures ~10× GLM and leaked a real WiFi PSK on a real session — not shippable. Dreaming (deletion is irreversible) is *even more* model-sensitive: GLM is 9→6 near-lossless; Qwen is destructively unstable; Gemma over-merges. **Default extraction + dream stay on GLM-4.6.**

### 4g. Reasoning-stripped transcript injection (research harness)
The replay harness feeds a **reasoning-stripped** transcript (user turns + final assistant text + tool calls, `reasoning` parts excluded at the SQLite query layer) to a *fresh* run, rather than `opencode run --fork` which rebuilds context *including* the original assistant's inner monologue — the direct source of the worst memories (episodic narration, third-person user-judgement, activity-as-preference). Stripping and the prompt rules fix *different* failure sources and neither alone suffices. (The production hook still uses `--fork`; provenance is injected separately.)

### 4h. Provenance recovery
In-session saving gets the commit hash for free; post-hoc extraction can't. The harness recovers it deterministically: render every turn's timestamp + tool file targets, map touched files → their containing git roots (`_repos_for_files`, even *nested* repos like `opencode-source`), `git log` each over the session window, and inject a commits block before the extract prompt + a PROVENANCE RULE telling the model to cite the matching hash / `file:line` and invent neither. Took 0%→100% commit-hash citation on code-change memories, no hallucinated hashes. Shipped to the production `--fork` path via `get_session_commits_block`. Watch-out: a placeholder example hash (`a1b2c3d`) once got confabulated when no block was injected — fixed by a non-copyable `<commit>` placeholder + a no-block→no-hash clause.

---

## 5. New architecture state (just shipped)

Two features added to `paths.ts` recently; treat these as current architecture:

### 5a. Local (in-repo) memory mode — `paths.ts:149–265`
`OPENCODE_MEMORY_LOCAL` (env) or `localMemory` (opencode.json plugin option) keeps memory **inside the repo** at `<gitRoot>/.claude/memory/` so it can be committed/diffed/reviewed alongside code. Modes: `off`/`global` (always global store), `on`/`local` (always in-repo, created if absent), **`auto` (default)** — in-repo only if that dir already *exists*, else global. Precedence: env > plugin option > `auto`. The local dir is keyed by the **same canonical git root** as the global store, so worktrees of one repo share it (`getLocalMemoryDir`). `getMemoryDir` resolves the mode each call; `auto` adopts the local dir only when it's a real directory (a stray file/symlink must not hijack or crash the first write). **Caveat:** harness-feedback still routes to the global project dir regardless (see 4b).

### 5b. Configurable index size-limit warning — `paths.ts:199–240`, `prompt.ts:288–306`
A **soft, advisory** line budget for `MEMORY.md`, separate from the hard `MAX_ENTRYPOINT_LINES = 200` cap that truncates what loads into context. `OPENCODE_MEMORY_INDEX_MAX_LINES` (env) / `indexMaxLines` (option); default `DEFAULT_INDEX_MAX_LINES = floor(200 * 0.8) = 160` so the warning lands *before* truncation. `0`/`off` disables; a negative/fat-fingered value falls through to default (only explicit `0`/`off` disables). When the index reaches the limit, `buildIndexLimitWarning` injects a one-time prompt asking the agent to warn the user **once** this session and offer compaction (cluster duplicates, drop stale, shorten entries; never silently delete). Latched per session via `indexLimitWarnedSessions` in `index.ts:513–519`.

---

## 6. Other shipped specifics worth knowing

- **Root allowlist** (`index.ts:359–373`): a tool's optional `root` arg is resolved against `[this-repo, ...extraMemoryRoots]` by canonical git root; an undeclared root is *rejected* — this is what stops the model writing memory to an arbitrary path. Extra roots' indexes are surfaced read-only (`## Additional memory index — <root>`).
- **Ignore-memory gate**: env `OPENCODE_MEMORY_IGNORE=1` or a "ignore/don't use memory" query suppresses both the index and recall, and strips the `# Auto Memory` block from system messages (`index.ts:45–54, 455–465`).
- **Per-turn derived state** replaced process-global Maps so `compact` naturally resets `alreadySurfaced`/`recentTools` (they're re-derived from the shrunken message list; `index.ts:20–30, 113–145`).
- **Tool-result titles**: `tool.execute.after` rewrites memory/harness tool result titles (`project: name`, `N memories`, `harness: <title>`; `index.ts:303–407`).
- **`created:` frontmatter** (`memory.ts:buildFrontmatter`): auto-stamped, caller-overridable so a dream merge preserves the oldest source's date and keeps manifest sort order accurate.

---

## 7. Open questions / planned follow-ups

- **Port deterministic secret redaction into the plugin's `memory_save`.** Production secret safety is **prompt-only** (`prompt.ts:122`); the deterministic `redact_secrets`/`scrub_memory` (with WiFi/PSK hardening + `test_redact_secrets.py`) lives **only in the Python eval harness** and does NOT protect the shipping plugin. The design conclusion (regex floor + a concentrated LLM secret-strip pass, best-deployed at save-time to *prevent* the write) is the recommended architecture but unbuilt in production.
- **Per-root / local-mode maturity.** Local in-repo mode (section 5a) is new; harness-feedback still escapes to the global project dir even in local mode (so a committed `.claude/memory` won't carry the sidecar) — confirm that's the intended boundary, and decide whether extra-root memory writing/dreaming needs the same secret gate.
- **Extraction gate scanning only the global store.** Auto-dream gating (min-hours/min-sessions) and the extraction triggers were designed around the global store; verify they behave correctly when a repo is in local in-repo mode (the dream pools/operates on the store the wrapper resolves).
- **Stay-silent-when-empty:** the model occasionally writes a "no harness feedback found" sidecar entry instead of staying silent — a one-line prompt tweak.
- **Larger local model**: a fully-local pipeline needs a model with more *active* params than Qwen-30B-A3B (MoE, ~3B active) and Gemma-4-12B; the harness (`run_dream_local.py`, `gemma_*`) measures the next candidate in one command.
