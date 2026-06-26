# Memory Recall — Models & Quality

Recall is the plugin's per-turn selection step (`src/recallSelector.ts`): given the user's
query, a manifest of stored memories (filename, type, description), and the recently used
tools, return up to 5 memories that are *clearly* useful. It is **read-only selection, not
memory writing** — so the extraction failure modes (over-capture, secret leaks) do not apply
here. What matters for recall is selection precision/recall and latency on the interactive
hot path. This is a different task from extraction, and the model ranking is different too.

(Extraction/dreaming model quality is covered separately in
[models-and-extraction-quality.md](models-and-extraction-quality.md). The best extractor is
not the best selector — see the findings below.)

## Methodology

- **12 labeled fixtures** — each a query + a memory manifest + the gold set of filenames
  that should be selected. Coverage: single hit among distractors, multi-hit, empty-list
  restraint (nothing relevant -> `[]`), the **tool carve-out rule** (suppress a usage/API
  reference for a recently-used tool, but keep a gotcha/warning about it), lexical-overlap
  distractors (semantic discernment over keyword match), and selectivity (one precise answer
  among several related memories).
- The plugin's **real** `SELECT_MEMORIES_SYSTEM_PROMPT` (parsed from source so it cannot
  drift), prompted-JSON output, and one scorer for every model so numbers compare directly.
- Cloud models run via `opencode run`; local Gemma runs in-process via mlx-vlm.
- Metrics: macro precision / recall / F1, exact-match, empty-list handling, carve-out
  compliance, and median latency.

## Results

| Model | F1 | Precision | Recall | Exact | Median latency |
|---|---|---|---|---|---|
| Kimi k2p7-code-fast | 1.000 | 1.000 | 1.000 | 12/12 | 7.6 s |
| gpt-oss-20b (Fireworks) | 1.000 | 1.000 | 1.000 | 12/12 | 13.5 s |
| qwen3.7-plus | 1.000 | 1.000 | 1.000 | 12/12 | 8.1 s |
| deepseek-v4-flash | 0.972 | 0.958 | 1.000 | 11/12 | 17.6 s |
| **Gemma-4-12B (local, mlx-vlm)** | 0.972 | 0.958 | 1.000 | 11/12 | **3.9 s** |
| GLM-4.6 (`opencode/big-pickle`) | 0.956 | 0.958 | 0.972 | 10/12 | 9.2 s |
| GLM-5.2 (`fireworks .../glm-5p2`) | 0.931 | 0.903 | 1.000 | 10/12 | 8.2 s |

Every model passed **empty-list restraint 2/2 and the tool carve-out 2/2** — the
rule-following part of recall is easy for all of them. All separation is at the selectivity
margin (one or two fixtures).

## Findings

- **Local Gemma is a strong recall model — and the fastest.** F1 0.972, on par with the
  cloud field, at 3.9 s/call (pure on-device; no network, no process cold-start). This
  *inverts* its extraction verdict: Gemma was rejected for *writing* memories (over-capture
  plus a real secret leak), but recall is read-only *selection*, so that failure mode cannot
  occur. For a recall model that keeps a secret-bearing global store on-device, Gemma-12B is
  a defensible pick.
- **The extraction champion is the recall laggard.** Both GLMs land at the bottom here, and
  GLM-5.2 actually *over-selects* (precision 0.903, the most aggressive includer). Concrete
  evidence that recall and extraction reward different behavior — which is the reason the
  plugin exposes a *separate* recall model rather than reusing the extractor.
- **Kimi is the standout cloud pick** — a perfect score and the fastest cloud model. Since
  Kimi is also the extraction runner-up, it is the strongest single dual-use choice.

## Caveats

- **Easy task, small set (12).** Most models cluster near-perfect; F1 0.97 vs 1.00 is a
  single fixture. The empty-list and carve-out results (everyone 2/2) are the more robust
  signal than the F1 ordering.
- **`gpt-4o-mini` was not measured** — it is OpenAI-proprietary and was not reachable through
  the providers configured for this eval (Fireworks/Novita/HF). `gpt-oss-20b`, OpenAI's open
  sibling, stood in and scored a perfect 1.000.
- **Cloud latency includes the `opencode run` process cold-start** (a few seconds/call) that
  the in-process plugin recall would not pay; read cloud latency *relatively*. Local Gemma's
  3.9 s is real on-device compute and still the lowest.
- **Local Gemma ran in-process via mlx-vlm.** Wiring it into the plugin's `recallModel`
  requires exposing it as an OpenAI-compatible / ollama provider that opencode can reach;
  `recallModel` is dispatched through opencode's provider system, not a raw local call.
- A parser bug was found and fixed mid-run: GLM-4.6 emits backslash-escaped JSON (`\"`),
  which the first parser scored as empty (F1 0.789); after normalizing, GLM-4.6 re-scored to
  0.956. The table reflects the corrected run.
