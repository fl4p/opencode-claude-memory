# Dreaming & Memory Consolidation

*Reference doc, mined from the project's own past Claude Code sessions. It summarizes the dream and the over-merge finding.*

The "dream" is the auto-memory project's periodic **consolidation pass**: a separate
operation from per-session extraction that clusters, merges, and prunes the accumulated
memory store. It exists to fix the **dedup gap** that per-session isolation creates —
e.g. duplicate `user`/firmware profiles that no single extraction run can merge because
each session only sees its own conversation.

---

## 1. What consolidation does (the algorithm)

A dream is a **small, conservative pruning pass** over one project's memory files. Its
job is deliberately narrow (from the shipping `AUTODREAM_PROMPT`,
`opencode-claude-memory/bin/opencode-memory:522`):

- **Delete stale / invalidated** memories — a fact that no longer holds (contradicted by
  a newer memory, project moved on, a preference changed).
- **Collapse duplicates / near-duplicates** — when another memory already covers the same
  fact; if one richer single-fact memory would genuinely replace a cluster, delete the
  whole cluster and save ONE fresh replacement.
- **Leave good memories untouched** — "a clean memory set is a valid outcome"; do NOT
  mass-rewrite, re-summarise, or "improve" memories that are fine.

Disciplines carried over from extraction (verbatim in the prompt):
- **Immutability** — never edit a memory in place; to combine, DELETE the old files and
  `memory_save` ONE fresh file. One fact per file; never fold unrelated facts together.
- **Preserve `created`** — a replacement takes the OLDEST source memory's `created`
  value so the `MEMORY.md` manifest sort order stays accurate.
- **Type discipline** — only collapse memories of the SAME type (`user` / `feedback` /
  `project` / `reference`); never fold one kind into another.
- **No escalation / no invention** — a merged memory may state only what its sources
  established.
- **Credential guard** — never introduce a credential value/file/path/username pointer
  the sources lacked; "if a source leaks one, drop that detail rather than copying it
  forward."
- **Guardrails** — when confidence is low, KEEP; never delete the last copy of a fact not
  recorded elsewhere; if the set is already clean, change nothing and say so.

The prompt design is `orient → consolidate → prune`: (1) `memory_list` the whole
inventory; for any overlapping cluster `memory_read` each member before merging
("descriptions alone are not enough to merge on"); (2) classify each memory
stale/duplicate/good and apply. This was aligned to Claude Code's pruning-prompt
design during the 2026-06-16 dev session.

---

## 2. The live-tool-loop vs plan-prompt distinction

The shipping `AUTODREAM_PROMPT` is written for a **LIVE TOOL LOOP**. The model operates
through `memory_*` tools (`memory_list`, `memory_search`, `memory_read`, `memory_save`,
`memory_delete`) and applies its deletes/saves directly:

> "use ONLY these tools" … "the builtin file tools … CANNOT reach it and will error" …
> "Work the whole inventory to completion in this one pass … apply your deletes/saves
> directly. Do not stop after planning" … closes with "Return a brief summary…".

The "use ONLY these tools / builtin file tools will error" preamble and the action-forcing
"do not stop after planning" line were **added to fix a real failure**: the first GLM dream
run did nothing (the model reached for the builtin `read`, errored, and gave up); with the
preamble it succeeded 41→34.

For **local single-shot models** that won't drive a multi-round tool loop, the eval harness
uses a **plan prompt** instead. `gemma_dream.py` shows the model the FULL inventory inline
and asks for ONE JSON plan (`merge` / `delete` / `keep`), then applies it deterministically
(`apply_plan` → `MemoryStore.save/delete`). Rationale (from `gemma_dream.py` docstring):
Gemma emits ONE `memory_list` call then switches out of native tool-call format into JSON
and the live loop stalls (9→9, no consolidation) — so the loop is the wrong mechanism for
that model.

**`build_plan_prompt(dream_prompt)`** (added 2026-06-20)
adapts the shipping tool-loop prompt for plan mode **without touching the shipping prompt**
(GLM's live path keeps using `AUTODREAM_PROMPT` verbatim):
- Keep the **JUDGMENT** sections — `Discipline` (incl. the credential guard) and
  `Guardrails` — **verbatim**, so consolidation criteria stay identical to the GLM baseline.
- Keep the paradigm-neutral intro paragraph as-is.
- Replace ONLY the tool-loop **mechanism** framing (Tools / "The pass" / immutability /
  trailing "Return a brief summary" prose) with coherent plan-mode framing ("You are NOT
  calling tools … return ONE consolidation plan in the JSON format specified at the end").
- The trailing "Return a brief summary…" prose (which has no `## ` header and rides along in
  the Guardrails body) is stripped via regex, because `PLAN_INSTRUCTION` defines the
  JSON-only output.

This fix resolved a **self-contradiction confound**: before it, `gemma_dream.py` fed the
tool-loop body AND a `PLAN_INSTRUCTION` appendix ("Do NOT call any tools. Output ONLY a
single JSON object") that argued with each other.

---

## 3. Gating (production, `bin/opencode-memory`)

Auto-dream runs as a post-session task (`run_autodream_if_needed`,
`opencode-claude-memory/bin/opencode-memory:1632`), gated by two thresholds before it fires:

- **`OPENCODE_MEMORY_AUTODREAM_MIN_HOURS`** (default **24**) — minimum hours between
  auto-dream runs. `hours_since < MIN_HOURS` → return (no-op).
- **`OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS`** (default **5**) — minimum sessions touched
  since the last consolidation (`count_sessions_touched_since_ms`). Below it → no-op.

Additional gates: `jq` must be present (needed for JSON session parsing, else skip); a
**consolidation lock** (`try_acquire_consolidation_lock`, stale after 1h) prevents
concurrent dreams on the same project. On fire, it runs
`opencode run -s <session> --fork --dir <wd> [-m AUTODREAM_MODEL] [--agent ...]
"$AUTODREAM_PROMPT"`. **On failure the gate timestamp is rolled back**
(`rollback_consolidation_lock`) so the next session retries; on success the lock mtime is
kept at "now" as the last-consolidated timestamp. Forked sessions are cleaned up afterward.
The dream model falls back to the extract model when neither env nor `opencode.json`
specifies one (`AUTODREAM_MODEL` precedence: env > opencode.json options > extract model).

Note: `opencode-memory.test.ts` exercises the wrapper's dream **gating/targeting** (env
gates, lock, session selection) but does NOT assert on the `AUTODREAM_PROMPT` text — the
prompt is only covered behaviorally by the `run_dream.py` validation run.

---

## 4. Fail-safe but NOT lossless — the over-merge bug (the key finding)

**Confirms ground truth.** The honest standing: the dream is **fail-safe but NOT lossless**
Tracking how this was established:

- **GLM-4.6 baseline (production model, `opencode/big-pickle`):** the reference quality
  bar. On the pooled fugu corpus: **9 → 6, near-lossless**, conservative, type-respecting,
  invents nothing. On a 41-memory pool: **41 → 34, lossless** (every deleted fact verified
  still present in a surviving memory — e.g. the havan log path survives in
  `pv_solar_mppt_setup`). GLM **keeps `bat_c` fully intact** (`project_bat_c_optional_for_psu_topology`).

- **Gemma, original measurement:** looked like a clean win — 9→6, full coverage,
  "preserves the bat_c detail / lossless." **SUPERSEDED.** That run used the
  self-contradictory prompt (tool-loop body + JSON-plan appendix), a confound.

- **Prompt conflict fixed (via `build_plan_prompt`):** with a coherent,
  discipline-faithful plan prompt, Gemma's 9→6 is **mechanically clean (full coverage,
  no phantom deletes) but NOT lossless.** Both parsing runs fold the **distinct**
  `bat_c_optional_for_psu_topology` fact INTO `shared_bus_termination_fix`, compressing its
  three paragraphs (Cbat=NAN disables termination + EOC; PSU/non-battery topology
  rationale; the `isfinite(Cbat)` / `_updateTermination` / `shouldRelease` guards; "don't
  re-add a hard assertion on Cbat") down to a **single commit bullet**
  (`keep bat_c optional`). The two memories merely share a commit; they
  are separate durable facts. This violates the "NEVER fold two distinct facts" /
  "preserve every distinct technical detail" discipline → **real retrieval loss.**
  "Fixing the conflict didn't rescue the dream — it removed the confound and exposed that
  the consolidation judgment over-merges."

- **GLM re-check — the over-merge is GEMMA-SPECIFIC, not a prompt gap.** On the *identical*
  prompt discipline / same 9-memory fugu corpus, GLM deleted
  `[feedback_secrets_env_memory_repo, project_shared_bus_termination_architecture,
  project_shared_bus_termination_fix]`, created nothing, and **kept `bat_c` fully intact.**
  So GLM preserves the distinct fact where Gemma folds it → **the over-merge is a Gemma
  judgment flaw, NOT prompt under-specification.** (The prompt fix was still correct —
  it removed a genuine self-contradiction — but was never going to fix the over-merge.)

- **Fail-safe is the saving grace.** temp=0.6×3 → `after_count = [6, 9, 9]`: the two 9→9
  are JSON **parse failures → safe no-op** (deleted nothing), never a *different*
  destructive set. Categorically unlike Qwen3-30B-A3B, which produced 3 genuinely
  different destructive delete-sets, once self-deleted a merge it had just written, and
  wiped distinct non-duplicate facts with no replacement — irreversible damage. Parse
  robustness is weak at temp>0 (only 1/3 produced a usable plan; the long inline inventory
  + 2200-tok cap truncates the JSON), so **greedy/temp-0 is the only reliable mode** for the
  plan harness.

- **GLM's own milder failure.** GLM's 9→6 is near-lossless, NOT perfectly lossless: its
  third deletion drops the unique, non-stale `feedback_secrets_env_memory_repo` rule
  ("secrets → gitignored `.env`; never write secret values into notes") with no surviving
  copy — defensible only as an about-the-notes-system carveout, and re-derivable from global
  config / `prompt.ts`. Both models fail differently — Gemma over-merges a technical fact,
  GLM prunes a borderline-meta preference — but GLM's is milder and recoverable.

**Production decision: dreaming stays on GLM-4.6.** Qwen3-30B-A3B is UNSAFE for
consolidation (irreversibly destructive). Gemma is fail-safe but below the GLM bar and
NOT shippable as the local default. Consolidation, even more than extraction,
requires conservative, stable judgment because deletion is irreversible.

---

## 5. Security review of `gemma_dream.py`

Reviewed the `build_plan_prompt` addition + the apply path. **No findings / no exploitable
vulnerability.**

- **Credential guard preserved.** `build_plan_prompt` keeps the `Discipline` body (which
  holds the credential-leak guard) and the `Guardrails` block verbatim from the current
  shipping prompt; the rewritten mechanism sections (Tools / "The pass" / immutability)
  carry no safety content, so nothing safety-relevant is lost.
- **Sink hardening.** The LLM's plan output is consumed through `MemoryStore._safe`, which
  `os.path.basename`s every `file_name` (and appends `.md`) before any write/delete — so
  a plan-supplied `file_name`/`subsumes` cannot path-traverse out of the per-sample memory
  dir (`../../etc/passwd` collapses to `passwd.md`). No `subprocess`/`eval`/`exec`/`pickle`/
  `yaml.load`, no network sinks, no new entry points; `json.loads(..., strict=False)`
  tolerates control chars but reaches no injection sink. The store is a throwaway pooled
  corpus (`shutil.rmtree` before each sample), not user data.
- **One noted future-fragility (not a current bug):** `secs.get("Guardrails", "")` and the
  discipline-key `next(..., "")` both default to empty string if the upstream shipping
  prompt is renamed — a silent-drop / fail-open-state-drift pattern that would drop the
  credential guard. Harmless against the *current* shipping prompt (the guard IS emitted
  verbatim), but worth a pin/assertion if the section headers ever change.

---

## 6. Production vs eval split

- **Production** (`opencode-claude-memory/bin/opencode-memory`): the live-tool-loop
  `AUTODREAM_PROMPT`, run by the real opencode binary via `opencode run --fork`, gated by
  MIN_HOURS / MIN_SESSIONS + lock, on **GLM-4.6** (`opencode/big-pickle`). This is the only
  shipped path.
- **Eval / research harnesses** (vibe-side, outside the plugin repo):
  - `run_dream.py` — pools a `replay-out/*` dir's memories into one isolated store
    (collision-rename, backfill `created` from mtime), git-inits a throwaway repo, runs the
    REAL `AUTODREAM_PROMPT` through opencode (pinned Cellar 1.17.7), diffs before/after,
    writes `dream-report.json`. The GLM baseline.
  - `run_dream_local.py` — in-process local-model dream via the `agentic_call` tool loop
    against a real `MemoryStore` (the OOM-free, provider-free path; `--backend inproc|gemma`).
  - `gemma_dream.py` — single-shot JSON plan harness with `build_plan_prompt` (the plan-mode
    eval, NOT a tool loop). Greedy/temp-0 only for reliable parsing.
  - These harnesses are how a future local model is measured "in one command"; until one
    clears the GLM bar, the production dream stays GLM-only.

---

## Open questions

1. **No prompt-text regression guard.** `AUTODREAM_PROMPT`'s invariants (mandate `memory_*`,
   forbid builtin file tools, preserve `created`, the credential guard) are covered only
   behaviorally by `run_dream.py`, not by a unit/source-grep test — a future prompt edit
   could silently regress them. (A cheap source-grep pin was proposed but not confirmed
   shipped.)
2. **`build_plan_prompt` fail-open if section headers are renamed** — the empty-string
   defaults would silently drop the credential guard / Guardrails. Should this assert that
   the `Discipline`/`Guardrails` sections were actually found?
3. **Will the over-merge appear on production GLM at larger scale?** The GLM re-check used
   only the 9-memory fugu corpus. Does GLM's conservative behavior hold as the store grows
   toward the index cap (the design notes ~115-fact truncation risk where pruning becomes
   load-bearing)?
4. **No formal lossless metric.** "Lossless" is currently asserted by manual fact-survival
   inspection per run; there is no automated check that every deleted fact still lives in a
   surviving memory.
5. **Is the production GLM dream itself ever audited for the milder failure** (dropping the
   `feedback_secrets_env` meta-rule)? That deletion was found by manual re-read, not by any
   guard.
