# Local Inference (36GB Mac)

Reference for running the auto-memory **extraction** and **dream/consolidation** models
*locally* on the M3 Pro / 36 GB Mac. How OOM was actually solved, the memory-footprint
numbers, in-process vs HTTP server, MoE vs dense, mlx-lm vs mlx-vlm, and the techniques
that did **not** help.

*Mined 2026-06-26 from the project's own past Claude Code sessions.*

**Important framing:** the four transcripts capture the *earlier* conclusion (a
~30k-token ceiling, measured through the HTTP server, with a wrong "MoE-prefill
accumulation" theory). The discovery that **the ceiling was the HTTP server, not the
model** — and that in-process covers the whole corpus — came *later*. This doc reconciles
both, and flags where the transcripts' conclusions were later overturned. See
"Contradictions" at the end.

---

## TL;DR recipe (the shipping path)

Run extraction/dream **in-process, single sequential call, no HTTP server, no
concurrency**. That is what dissolves the OOM. (`local_extract.py --backend inproc`.)

- Load the model once, call `mlx_lm.generate_step` directly, read `mx.get_peak_memory`.
- One OS subprocess per session only for crash isolation — *not* a long-lived server.
- Leave the Metal **wired limit unset** (in-process default = 0). Do **not** raise it.
- Qwen3-30B-A3B-4bit peak is **~0.094 GB / 1k tokens, dead-linear**; the 54k-token
  corpus-max session peaks **~23.5 GB**, ~4 GB under the ~27 GB Metal wired ceiling.
  The whole transcript distribution fits single-shot.

---

## 1. The model & why MoE

- Hardware: **M3 Pro, 36 GB unified, 11 cores**, ~150 GB/s bandwidth. Default usable
  Metal ≈ **27 GB (~75% of 36 GB, not the full 36)** — this 27 GB *wired* ceiling, not
  total RAM, is the real wall throughout.
- Pick: **`mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit`** — MoE 30B total / **3B
  active** per token. The MoE shape is the whole point on this box: 36 GB holds the full
  weights, but each token reads ~3B, so it *runs like a 3B for speed (~40–70 tok/s) while
  answering like a 30B*. ~17 GB on disk at 4-bit.
- Rejected alternatives, with reasons recorded: **GLM-4.5-Air** (MoE 106B/12B, ~60 GB+ —
  won't fit 36 GB); **gpt-oss-20b** (fits, faster, but not Chinese); dense Qwen3-8B/14B
  (slower per-token than the 30B-A3B MoE); **Gemini Nano** (phone-tier 2B, not a loadable
  checkpoint, no OpenAI-compat server — dead end for a batch harness); **Gemma-3 12B/27B**
  (dense, viable-but-weaker alt).
- Install gotchas worth keeping: Homebrew python3 was 3.14 (too new for MLX wheels) → used
  **python3.13 in a dedicated venv**. Anonymous HuggingFace pulls are throttled hard and
  repeated kill/relaunch **fragments `.incomplete` shards** (each restart spawns fresh
  random-suffix partials instead of resuming) — use an HF token / don't thrash the
  download.

## 2. Tooling / venvs — mlx-lm vs mlx-vlm

Two **separate** venvs; do not mix them.

| venv | package | drives | used for |
|---|---|---|---|
| `~/.venvs/mlx-lm` | `mlx-lm 0.31.3 / mlx 0.31.2` (py3.13) | Qwen3-30B-A3B | extraction + dream (`InprocBackend`) |
| `~/.venvs/mlx-vlm` | `mlx-vlm` (separate) | Gemma-4 `gemma4_unified` VLM | Gemma eval/dream backend |

- On Apple Silicon **MLX beats llama.cpp/Ollama by ~20–30%**. `mlx-lm` (`pip install
  mlx-lm`) is the scriptable path; LM Studio's MLX backend was the GUI alternative.
- Gemma-4 is **`gemma4_unified`, a VLM** loaded via **`mlx_vlm.load` / `stream_generate`
  — NOT `mlx-lm`**. Model id:
  `mlx-community/gemma-4-12B-coder-fable5-composer2.5-v1-4bit-msq`. Driver:
  `PY=~/.venvs/mlx-vlm/bin/python`.

## 3. In-process vs HTTP server — why in-process wins

The single most load-bearing finding (foreshadowed in the earlier "keep extraction off
opencode / it's the concurrency" thread):

- **The HTTP server is the OOM, not the model.** Measuring through a cold `mlx_lm.server`
  per rung showed ~30k tokens → OOM mid-prefill, and the thread blamed "MoE-prefill /
  allocator-cache accumulation." Re-measuring **in-process** (model loaded once,
  `generate_step` called directly) **refutes both the theory and the ceiling**: peak is
  linear/shallow and the 54k-max session sails through at 23.5 GB.
- **Why the server crashed at ~30k but in-process reaches 54k:**
  - `mlx_lm.server` **sets the Metal wired limit to 29 GB at startup** (`server.py:1889`),
    which makes it *retain* allocator buffers instead of releasing them → peak inflates.
    In-process leaves wired **unset (0)** → buffers released freely.
  - opencode fires **concurrent** calls down the server path (recall-prefetch + title/
    summary gen alongside extraction), and per-request detokenizer / HTTP / asyncio state
    stacks → roughly *doubles* peak.
  - Fix: delete the server from the extraction path entirely. Extract in-process, one
    sequential call, no HTTP, no concurrency.
- In the transcript thread this was first understood as "**run extraction direct,
  concurrency=1, off opencode**" — `replay_transcript.py` was found to drive `opencode run`
  (the concurrent OOM path), so "off opencode" meant **building a new direct harness**
  (`direct_extract_probe.py`), not reusing the replay script. The full in-process
  refutation came later.

## 4. Memory-footprint numbers

| what | number | source |
|---|---|---|
| Qwen 4-bit weights on disk | ~17 GB | — |
| Metal **wired** ceiling (the wall) | ~27 GB (≈75% of 36) | project notes |
| Qwen in-process prefill peak | **~0.094 GB / 1k tok, linear** | project notes |
| Qwen single-shot **54,376-tok** session (corpus max) | **peak 23.46 GB, survives** | project notes |
| Qwen KV at 30k tok | only ~3 GB (GQA: 48L × 4 KV-heads × 128 dim ≈ 96 KB/tok) — *not* the binding term | project notes |
| Gemma-4-12B `gemma4_unified` (mlx-vlm) peak | **~9.5 GB** (read via `mx.get_peak_memory`) | project ground-truth notes; transcript shows the measurement code, not the prose number |
| (superseded) server-measured single-req ceiling | ~18k survives / ~33k OOM → "≈30k" | project notes |

Coverage: at the **mistaken** 30k server ceiling, ~76% of sessions fit single-shot and
~24% looked like they needed map-reduce (median session 8.7k tok, p75 24k, max 54k —
computed with the **real Qwen3 tokenizer**, after fixing a char-vs-token unit bug; see
section 5). In-process retires that framing: the whole distribution (max 54k) fits single-shot
with margin, so **0% need chunking** today.

## 5. Bugs found & fixed along the way

- **Char-cap vs token-ceiling unit bug.** The pipeline capped on *chars*
  (`REPLAY_MAX_TRANSCRIPT_CHARS`, sliced at `replay_transcript.py:145`) but the OOM
  ceiling is in *tokens*, and the char→token ratio swings ~2.4× (dense code/JSON ≈1.4 vs
  prose ≈3.3 chars/tok) — exactly the dangerous end for code-dense agentic transcripts.
  Fixed by installing the lightweight `tokenizers` wheel and re-deriving the true
  distribution (median dropped 19k→8.7k tok).
- **Single-shot Phase-2 truncation → 0 memories.** A single-shot call could emit a Phase-1
  `harness_feedback` and stop *before* Phase-2 `memory_save`, depending on whether the
  model batched both into turn 1 — starving memory extraction to **0 entries**. Root cause
  is a **`local_extract.py` correctness bug, not a model trait**; a one-line prompt edit
  flips it, and the **agentic tool-loop** fix makes Phase-2 reliable. NB this is a
  *content/correctness* fix, distinct from the *OOM* fix in section 3 — see Contradictions.
- **Memory tail-truncation recall loss.** The 32k cap kept the transcript *tail*
  (`body[-MAX_TRANSCRIPT_CHARS:]`), silently dropping early memory-worthy facts — a recall
  problem, not a memory-budget one.
- **Fabricated commit hash.** A single-shot 54k extraction cited commit `a1b2c3d`
  (0 occurrences in repo); a prompt edit removed it without changing peak (23.44 vs 23.46
  GB).

## 6. Techniques that did NOT help (and why)

- **KV quantization (KIVI / VeloxQuant 2-bit, Q8).** Irrelevant here: KV is only ~3 GB at
  30k and the OOM is *not* KV-bound. You can't quant your way out of a non-KV OOM. (And
  once in-process is used, there is no ceiling to raise in range anyway.) The whole
  KIVI/KV-quant detour was retired *by data*.
- **Raising `iogpu.wired_limit_mb`.** The intuitive lever is the **opposite** of what
  helps. The server crashes *because* it pins wired to 29 GB and retains buffers;
  in-process leaves wired unset (0) and releases freely. Leave it unset.
- **"SoloHeaven" (`joongom/mlx-soloheaven`).** Its marquee prefix-cache/250× feature is
  **useless for extraction** — every transcript is a distinct single-shot prompt with no
  shared prefix to reuse (same reason ordinary prefix caching doesn't help extraction).
  Its graceful-OOM/disk-spillover is real but **can't spill a live activation buffer
  mid-matmul**, and in-process measured **~600 s RPC-timeout slow** with no OOM benefit
  over the in-process default. Rejected for extraction (potentially useful for the
  *interactive coding* loop, which *is* a shared-growing-prefix workload).
- **`prefill_step_size` tuning.** A near no-op for the ceiling (step 8192 vs 2048 ≈
  263 s vs 292 s, ~10% faster, +0.7 GB peak).
- **Prefix / prompt caching for extraction.** No shared prefix across single-shot
  transcripts → nothing to cache. (It *is* the real win for interactive agentic coding.)
- **Aggressive KV quant for extraction quality.** Cautioned against on recall grounds
  (extraction needs faithful recall of scattered details); moot once KV proved
  non-binding.

## 7. Gemma-4 specifics

- Loaded via **mlx-vlm** (`gemma4_unified` VLM), separate `~/.venvs/mlx-vlm`. Peak ~9.5 GB.
- **PROMPTED-JSON, single-shot** protocol (not native tool-calls): Gemma-4's native
  tool-call format wraps string values in a special `<|"|>` token that **mlx-lm/mlx-vlm
  do not parse yet** (mlx-lm issue #1096 — OpenAI `tool_calls` stays empty). To avoid the
  "drive-the-model-with-the-wrong-format" trap, the harness asks for a plain JSON array.
- `GemmaBackend` is **interface-compatible with `local_extract.InprocBackend`** (the Qwen
  path), but the Gemma *dream* uses a **single-shot JSON consolidation plan**, not the
  agentic tool loop, because Gemma emits one big batch rather than iterating tool calls.
  (`gemma_dream.py` / `gemma_eval.py`; `--backend inproc|gemma` in the runner.)

---

## Contradictions / refinements vs the briefed ground truth

1. **"OOM solved by in-process *agentic tool loop* (NOT single-shot)" conflates two fixes.**
   **In-process** (deleting the HTTP server) is what solves **OOM** — and
   in-process **single-shot** itself is fine memory-wise (peak 23.5 GB at the 54k max). The
   **agentic tool loop** fixes a *separate* problem: the single-shot **Phase-2 truncation**
   (a `local_extract.py` correctness bug → 0 memories), i.e. *content/reliability*, not
   memory. So: in-process ⇒ no OOM; tool-loop ⇒ Phase-2 actually populated. The Gemma path
   even ships single-shot deliberately.
2. **The four source transcripts do NOT contain the in-process refutation.** They stop at
   the **server-measured ~30k ceiling** and the (later-disproven) "MoE-prefill /
   allocator-cache accumulation" theory, plus the KIVI/SoloHeaven/wired-limit debate. The
   `0.094 GB/1k`, `23.5 GB @ 54k`, and "ceiling was the HTTP server" facts were established
   *later*, post-dating these sessions — the transcripts are the dead-end-laden journey to
   that conclusion, not the conclusion itself.
3. **Ground-truth "~30k ceiling was the HTTP server" — confirmed**, with the precise
   mechanism the brief omits: the server pins `wired_limit=29 GB` at startup and **retains**
   buffers, and opencode concurrency + per-request HTTP/detokenizer state roughly doubles
   peak.
4. **Gemma peak ~9.5 GB** is asserted in the project's ground-truth notes; the 06-19
   transcript only shows the *measurement code* (`mx.get_peak_memory`), not the prose figure
   — treat 9.5 GB as notes-sourced, not transcript-quoted.
5. **"Whole distribution fits at ~23.5 GB" — confirmed**, but note 23.5 GB is the *single
   54k-max session*; smaller sessions are far lower (linear at 0.094 GB/1k). The corpus
   *max* is what fits at 23.5 GB.

## Open questions

- **Qwen Phase-2 stability under greedy decoding** is still brittle:
  few-shot / the Phase-1 abstain delta were proposed but not confirmed landed. Has the
  agentic-tool-loop fix fully stabilised Phase-2 across the corpus, or is it still
  session-dependent?
- **Wired-limit-raised + SoloHeaven re-run on the server path** were left as `claude-vibe`
  TODOs; in-process made them moot for extraction — were they ever run,
  and is there any residual case (e.g. >54k synthetic sessions) where the server path or a
  2-way split is still needed?
- **Gemma-4 as a *shippable* local extractor**: the project notes record it as "best local
  extractor tried but NOT shippable" (over-capture, a real secret-VALUE leak). Is mlx-lm #1096 (the
  unparsed `<|"|>` tool-call token) fixed upstream yet, and would native tool-calls change
  the verdict?
- **Map-reduce harness** for hypothetical >ceiling sessions: none exist in the true corpus
  (max 54k) — is the token-aware 2-way split still maintained as dormant insurance, or
  removed?
