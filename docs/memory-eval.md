# Memory-Extraction Evaluation

How the auto-memory extraction prompt is validated: does it save the right durable facts,
suppress noise, and never leak secrets? Reconciled with the design doc
`auto-memory/replay-and-extraction-design.md`.

(Tool-use / SWE-bench coding benchmarks for the underlying models are out of scope here —
those belong to the `kimi-tools` and `agent-benchmark` repos. This doc only covers the
evaluation of *memory extraction*.)

## Replay model

The `opencode/big-pickle` alias used across the eval harness is **GLM-4.6** (Zhipu). It
re-judges past sessions fresh, regardless of which model originally ran them. Model-by-model
extraction-quality verdicts (GLM vs Qwen vs Gemma vs kimi) are in
[models-and-extraction-quality.md](models-and-extraction-quality.md).

## Methodology

- A small **fixture set** plus **at-scale replay** over stratified real sessions, scored by
  automated checks (`analyze_replay.py`: leak / recursion / grounding) plus manual judgement.
- Validated at scale on:
  - **32 fresh sessions** — 59% zero-memory restraint, 0/32 recursion, redaction held, 10
    real harness-feedback findings.
  - a **27-session batch** — 0 user memories with opt-in off, commit-hash provenance on
    project memories, credential-pointer references allowed but 0 secret values.
- The design doc's §16b "real-session 2-judge consensus" (and the later Gemma/Qwen
  verdicts) extends this.

## Prompt design

A two-phase, evidence-grounded `EXTRACT_PROMPT`:

- **Phase 1 — harness feedback** (drops the "four-types" anchor).
- **Phase 2 — durable memory**: behavior-analysis forbidden, must quote the user turn
  (*"a benchmark of three providers is not a provider preference"*), with a redaction rule,
  a recursion carve-out, and a hard-to-rederive reference rescue.

## Redaction findings

The load-bearing results that shaped the credential scrub (see
[secrets-and-redaction.md](secrets-and-redaction.md) for the full story):

- A session with a *different secret shape* (a `~/.cron-dash-creds` file pointer + username,
  vs the inline keys the rule was first tuned on) leaked past the rule — the value of not
  tuning on the same handful of fixtures. The rule was strengthened to forbid credential
  file/path/username *pointers*, not just values, then re-validated.
- Later **split**: secret **values** are never kept; a location **reference** ("creds in
  `~/.cron-dash-creds`") is allowed by default (matching how secrets are actually tracked),
  with `OPENCODE_MEMORY_REDACT_CRED_POINTERS=1` to strip locations too. User-data capture is
  opt-in (`OPENCODE_MEMORY_CAPTURE_USER`).
- One real leak combined two failures: a memory quoted credential prefixes *and* misread a
  benchmark of three providers as a standing "prefers X" preference — wrong on top of being
  a security problem.

## Open questions

- The deterministic scrub is keyword-anchored and best-effort; what rate of keyword-less
  credential values still slips through on real corpora, and is a concentrated LLM strip
  pass worth wiring into the production save path (or only the consolidation sweep)?
- The at-scale validation used GLM-4.6 as judge; a periodic re-run as models change would
  keep the restraint/leak numbers honest.
