# Auto-Memory / opencode-claude-memory — Knowledge Base

Reference docs for the memory plugin and the research behind it, mined on
transcripts) and cross-referenced with `auto-memory/replay-and-extraction-design.md`
(the §-numbered design doc, the authoritative source).

## Documents

| Doc | Covers |
|-----|--------|
| [architecture-and-decisions.md](architecture-and-decisions.md) | Plugin structure (paths/memory/recall/prompt/harness + the `bin/` wrapper), the Obj1/Obj2 split, two-phase extraction, why GLM is the default, design-doc §-map |
| [models-and-extraction-quality.md](models-and-extraction-quality.md) | Every model tried for extraction/recall (GLM-4.6/big-pickle, Qwen, Gemma, kimi, Opus), the fixtures→groundedness→2-judge methodology, per-model failure modes |
| [local-inference.md](local-inference.md) | Running models locally on a 36GB Mac — OOM solving, in-process vs HTTP server, MoE vs dense, mlx-lm vs mlx-vlm, footprint numbers, the dead-ends |
| [dreaming-and-consolidation.md](dreaming-and-consolidation.md) | Auto-dream (cluster/merge/prune stale), gating thresholds, live-tool-loop vs plan prompt, fail-safe-but-not-lossless + the over-merge bug |
| [benchmarks-and-evals.md](benchmarks-and-evals.md) | The kimi-tools tool-use bake-off, SWE-bench runs, the memory-eval harness, the agent-benchmark fugu pipeline |
| [secrets-and-redaction.md](secrets-and-redaction.md) | The deterministic credential scrub, the 2-pass concentration eval, the global-vs-in-repo policy, what protects production |

## Current shipped state (2026-06-26)

Three features landed in `opencode-claude-memory` this day (branch
`align-claude-memory-spec`):

1. **In-repo memory mode** — `OPENCODE_MEMORY_LOCAL` / `localMemory` (`auto`/`on`/`off`).
   Stores memory at `<repo>/.claude/memory/` instead of the global
   `~/.claude/projects/.../memory/`. `auto` adopts the in-repo folder iff it exists.
   This matches where Claude Code itself writes in-repo memory when asked, so the two
   share files. Keyed by canonical git root.
2. **Configurable index size limit** — `OPENCODE_MEMORY_INDEX_MAX_LINES` /
   `indexMaxLines` (default 160 = 80% of the 200-line hard cap). The agent warns once
   per session and offers compaction (cluster / drop stale / shorten).
3. **In-repo secret scrub** — writes to in-repo `.claude/memory` are run through the
   ported deterministic credential scrub (`src/redact.ts`); the global `~/.claude`
   store is left as-is. Opt-out: `OPENCODE_MEMORY_LOCAL_SECRETS` / `localMemorySecrets`.

## Cross-cutting corrections (flagged while mining — read these)

The mining agents caught several places where loose summaries had conflated things:

- **The kimi `40/48` figure is a *coding* (SWE-bench system-prompt) bake-off, NOT memory
  extraction.** Opus 4.8 `xhigh×claude` = 40/48 resolved (~$52, caching) ties GLM-5.2's
  best. Don't cite it as a memory-extraction result. (see benchmarks-and-evals.md)
- **"OOM solved (in-process)" and "agentic tool loop" are two *separate* fixes.**
  In-process / no-HTTP-server solves the **OOM** (memory); the agentic tool loop fixes a
  **separate content bug** (single-shot Phase-2 truncation → 0 memories). Gemma even ships
  single-shot. (see local-inference.md)
- **`/43→/48` was a subuid overflow on the rootless server** blocking 5 matplotlib images,
  not a "colima artifact." colima `--vm-type vz --vz-rosetta` was the *separate* K2.6/K2.7
  8-instance Mac path. (see benchmarks-and-evals.md)
- **Harness feedback (Obj1) always writes to the GLOBAL project dir, even in local mode**
  (`harness.ts` uses `getProjectDir`, not `getMemoryDir`), so a committed `.claude/memory`
  will not carry the `harness-feedback.md` sidecar. (see architecture-and-decisions.md)
- **The plugin is a fork of kuitos's `opencode-claude-memory`** — it keeps the
  Claude-Code-compatible store/format and adds the Obj1/Obj2 split + the tuned two-phase
  extraction prompt. (see architecture-and-decisions.md)

## Provenance

Mined from the project's own past Claude Code sessions and reconciled against the
`auto-memory/replay-and-extraction-design.md` design doc (the authoritative source).
Specific session transcripts are intentionally not cited here.
