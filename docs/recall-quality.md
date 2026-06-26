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

Two sets are used. A **hand-authored set** (12 fixtures, 3–5 memories each) pins specific
rules but saturates. A larger **real-store set** (50 fixtures generated from real project
memory stores, ~13 real memories per manifest) is the discriminating test — it is the
production condition, where selection happens among many real distractors. For the real-store
set, gold labels come from a **2-judge consensus** (GLM-4.6 ∩ Kimi): one model writes a
situation-style query for a target memory, both independently label which memories answer it,
and gold is their intersection (ambiguous/empty/over-broad cases dropped). GLM-4.6 and Kimi
therefore have a mild **judge advantage** on the real-store numbers; the hand set is the
bias-free anchor, and the best *non-judge* model is the cleaner signal.

## Results — hand-authored set (12 fixtures)

| Model | F1 | Precision | Recall | Exact | Median latency |
|---|---|---|---|---|---|
| Kimi k2p7-code-fast | 1.000 | 1.000 | 1.000 | 12/12 | 7.6 s |
| gpt-oss-20b (Fireworks) | 1.000 | 1.000 | 1.000 | 12/12 | 13.5 s |
| qwen3.7-plus | 1.000 | 1.000 | 1.000 | 12/12 | 8.1 s |
| deepseek-v4-flash | 0.972 | 0.958 | 1.000 | 11/12 | 17.6 s |
| **Gemma-4-12B (local, mlx-vlm)** | 0.972 | 0.958 | 1.000 | 11/12 | **3.9 s** |
| GLM-4.6 (`opencode/big-pickle`) | 0.956 | 0.958 | 0.972 | 10/12 | 9.2 s |
| GLM-5.2 (`fireworks .../glm-5p2`) | 0.931 | 0.903 | 1.000 | 10/12 | 8.2 s |

Everyone passes empty-list restraint 2/2 and the tool carve-out 2/2 — the rule-following part
of recall is easy. The set saturates (most models near-perfect), so it does not separate the
field; treat it as a floor check, not a ranking.

## Results — real-store set (50 fixtures, ~13 distractors each)

| Model | F1 | Precision | Recall | Exact | Empty | Median latency |
|---|---|---|---|---|---|---|
| GLM-4.6 (`opencode/big-pickle`) † | 0.897 | 0.871 | 0.970 | 38/50 | 8/8 | 13.7 s |
| deepseek-v4-flash | 0.876 | 0.834 | 0.980 | 36/50 | 8/8 | 19.0 s |
| Kimi k2p7-code-fast † | 0.863 | 0.818 | 0.960 | 34/50 | 8/8 | 16.0 s |
| qwen3.7-plus | 0.850 | 0.796 | 0.980 | 32/50 | 8/8 | 13.1 s |
| gpt-oss-20b (Fireworks) | 0.847 | 0.789 | 1.000 | 32/50 | 8/8 | 21.1 s |
| **Gemma-4-12B (local, mlx-vlm)** | 0.777 | 0.725 | 0.900 | 29/50 | 8/8 | **10.8 s** |
| GLM-5.2 (`fireworks .../glm-5p2`) | 0.759 | 0.666 | 1.000 | 21/50 | 8/8 | 14.5 s |

† judge model (defined gold) — read with the home-field caveat above. Every model still
handled empty-list restraint 8/8.

## Findings

- **The real-store set is what matters; the hand set saturates.** With realistic manifests
  (~13 candidates) the field spreads out and the easy-set ranking inverts. Read the 50-set.
- **Recall ≠ extraction — opposite ranking.** On the real-store set the *extractor* (GLM-4.6)
  tops recall too, but GLM-**5.2** is the *worst* (precision 0.666, exact 21/50): it includes
  almost everything. "GLM" is not one behavior. This is the concrete reason the plugin exposes
  a separate recall model instead of reusing the extractor — and a reason not to assume a
  newer model is a better selector.
- **Local Gemma is usable but second-tier at scale.** It looked top-class on the easy set
  (0.972) but drops to **0.777** on realistic manifests — precision 0.725: it over-selects
  when there are many candidates (recall stays high at 0.900). It is still the **fastest**
  (10.8 s, on-device) and the only fully-local option, so for a privacy-driven local recall
  model it is a reasonable trade; for best selection quality the cloud field is ~0.10 F1
  ahead. Note this *recall* result is unrelated to its rejected *extraction* verdict (recall
  is read-only, so the secret-leak failure mode cannot occur).
- **Best non-judge cloud pick: deepseek-v4-flash** (0.876), just behind judge-advantaged
  GLM-4.6. Kimi (a judge) sits mid-pack, which suggests the consensus gold genuinely
  constrains the task rather than simply rewarding the judges. gpt-oss-20b and GLM-5.2 both
  hit recall 1.000 but pay heavily in precision (over-inclusion).

## Caveats

- **Judge advantage on the real-store set.** Gold there is GLM-4.6 ∩ Kimi consensus, so those
  two are graded partly against their own labels. Their absolute numbers are optimistic;
  rankings *among the other five* (deepseek, qwen, gpt-oss, Gemma, GLM-5.2) are unbiased, and
  local Gemma — the model of interest — is not a judge.
- **The hand set (12) saturates.** Most models near-perfect; it is a floor check, not a
  ranking. The 50-fixture real-store set is the discriminating result.
- **Generated queries, not human-written.** Real-store queries were authored by a model
  (situation-style, no description echo) and consensus-labeled; this is a step below
  hand-labeled ground truth. The hand set remains the human-authored anchor.
- **`gpt-4o-mini` was not measured** — it is OpenAI-proprietary and was not reachable through
  the providers configured for this eval (Fireworks/Novita/HF). `gpt-oss-20b`, OpenAI's open
  sibling, stood in (perfect on the hand set; 0.847 at scale).
- **Cloud latency includes the `opencode run` process cold-start** (a few seconds/call) that
  the in-process plugin recall would not pay; read cloud latency *relatively*. Local Gemma's
  3.9 s is real on-device compute and still the lowest.
- **Local Gemma ran in-process via mlx-vlm.** Wiring it into the plugin's `recallModel`
  requires exposing it as an OpenAI-compatible / ollama provider that opencode can reach;
  `recallModel` is dispatched through opencode's provider system, not a raw local call.
- A parser bug was found and fixed mid-run: GLM-4.6 emits backslash-escaped JSON (`\"`),
  which the first parser scored as empty (F1 0.789); after normalizing, GLM-4.6 re-scored to
  0.956. The table reflects the corrected run.
