# Benchmarks & Evals

> Reference doc mined 2026-06-26 from past Claude Code session transcripts.
> Covers the "little benchmark": the Kimi tool-use prompt A/B, the public
> `kimi-tools` SWE-bench bake-off, the SWE-bench Verified K2.6/K2.7 runs, the
> contamination-free `agent-benchmark` (fugu) pipeline, and the memory-extraction
> eval harness.


| file | content |
|---|---|

Cross-references: `agent-benchmark/RESULTS.md`,
`auto-memory/replay-and-extraction-design.md`.

---

## 1. Kimi tool-use prompt A/B (hygiene benchmarks)

Purpose: measure whether a custom system prompt improves **tool-selection hygiene**
(fewer "discouraged"/duplicate tool calls, no empty-args `run_commands` loops) for
Kimi K2.6/K2.7 — *not* coding accuracy. Two harnesses, self-contained stdlib scenarios.

**Study 1 — cline harness** (Fireworks Kimi K2.7; later K2.6). Arms = system-prompt
variants (control, v00, current, plus a ported `oc-port`). Metric = tool-selection
hygiene. Key gotcha: an isolated `--data-dir` breaks cline auth (all arms fail, tools=0),
so the two models must **share the default data-dir and run sequentially**.

oc-port merged table (4 scenarios × 3 trials = 12/arm):

```
model/arm      n  pass%  pass^k  tools tc/tr disc dup  bad%   avg_s    tot_s
K2.7/control  12   100    100     40   3.3   21    6  15%   17.0s   203.6s
K2.7/current  12   100    100     57   4.8    0    5   9%   47.5s   570.6s
K2.7/oc-port  12    92     75     53   4.4    0    1   2%   96.3s  1155.5s
K2.6/control  12   100    100     34   2.8   21    6  18%    7.2s    86.2s
K2.6/current  12   100    100     57   4.8    6    1   2%    9.4s   113.2s
K2.6/oc-port  12   100    100     48   4.0    2    2   4%   10.9s   131.4s
```

Finding: the ported opencode prompt eliminates discouraged tools as well as the bespoke
`current` (K2.7 21→0; K2.6 21→2, actually beating `current`'s 6). Caveat: `oc-port`
blows up K2.7 latency to ~96s/trial.

**Study 2 — opencode harness, 2×2** (4 arms × 4 scenarios × 3 trials = **48 runs**;
whole sweep cost **$0.49**). Arms: `{k2.6,k2.7} × {default, custom override}`.

```
arm           pass% pass^k tools tc/tr tokens   cost$    lat
k2.6-default  100   100     32   2.7   253750  0.1398   6.5s
k2.6-custom    92    75     27   2.2   208481  0.1011   6.5s
k2.7-default  100   100     29   2.4   235760  0.1297  10.6s
k2.7-custom   100   100     38   3.2   299127  0.1188  13.4s
```

Headline: the *same* custom prompt **compresses K2.6** (−18% tokens, cheaper) but
**expands K2.7** (+27% tokens, more thorough, slower). On deeper "verify-the-code"
scenarios the prompt instead trimmed both (K2.6 −18% tokens; K2.7 −18% tokens and ~3×
faster). K2.7 is ~2× slower per call than K2.6 regardless of prompt.

Honest caveats logged: `empty_args = 0` on **every** arm including control → the original
empty-args `run_commands` loop (the whole motivation for v00) **never fired** on
K2.7/Fireworks, so the prompt's stated purpose is unmeasured, not proven. Task success
saturated (100%) — these toy scenarios top out below the difficulty where models diverge.

Reasoning-parity note: every harness run is reasoning-OFF for parity. At the raw Fireworks
API **both** Kimis reason by default (K2.6 ~370–700 chars `reasoning_content`, K2.7-code
~130); `reasoning_effort` has negligible effect on K2.6. The `reasoning_tokens=0` seen in
the harness is the provider config suppressing it (`fireworks.reasoning.enabled=false`),
not the model declining to reason. Together serves the same K2.6 (`391` answer) but ~17s
vs Fireworks ~2s. Captured in `bench_endpoints.py` / `bench_endpoints_results.json`;
`benchmark_kimi.py` is a separate (broken — missing `openai`) throughput probe.

---

## 2. Public `kimi-tools` SWE-bench bake-off (the /48 ↔ /43 story)

Repo: `github.com/fl4p/kimi-tools` (public). Purpose: compare 6 system-prompt arms across
K2.6/K2.7 (later GLM-5.2 and Opus 4.8) on a harder SWE-bench band.

- **6 prompt arms:** `default` (no prompt), `claude` (claude-code 2.1.178 interactive-cli,
  oc-adapted), `cursor`, `sharp`, `kcbal` (kimi-cline balanced), `kcauto` (kimi-cline
  autonomous). Prompt files under `/tmp/kimi-tools-staging/system-prompts/`.
- **Set:** 48 instances across 8 repos → **43 "evaluable"** after excluding **5 matplotlib
  images** that the *rootless* server couldn't grade (a **subuid overflow**, the source of
  the `/43` tally). On a **root-Docker** host (`<build-host>`) the matplotlib images grade,
  letting the headline be reported `/48`.
- **Grading:** `eval_runner.py` (hardened) drives `swebench.harness.run_evaluation` with
  `--cache_level instance` (8 images pull once, reuse), arms run **sequentially** (httpbin
  contention), one network-flake re-eval. Tally helpers: `tally_arms5.py`, `cost_glm.py`,
  `grade_tag.sh` / `gold_val.sh` (made orphan-safe with `setsid` + run_id-scoped `pkill`).

**Harder-band 6-prompt × 2-model result (/43, from `ab/FINDINGS-swe.md:51`):**

| prompt | K2.6 | K2.7 |
|---|---|---|
| default | 16/43 | **25/43** |
| sharp | **21/43** | 18/43 |
| cursor | 20/43 | 17/43 |
| kimi-cline autonomous | 19/43 | 20/43 |
| kimi-cline balanced | 18/43 | 13/43 |

**Headline finding: the prompt effect flips sign with model strength.** On weaker **K2.6**
every scaffold beats bare `default`; on stronger **K2.7** the bare `default` wins (25/43)
and every scaffold *hurts* it. The earlier 16-instance "claude-code is the consistent
winner" did **not** hold at 48 (small-N noise). This mirrors the fugu finding: scaffolding
help is conditional and the strongest model needs the least.

**GLM-5.2 added** (`fireworks-ai/accounts/fireworks/models/glm-5p2`, run on `<build-host>`).
Default-prompt three-model comparison: K2.6 16/43 · K2.7 25/43 · **GLM-5.2 26/43 (60%)** —
narrowly the best default arm, high-precision/low-recall (12/48 empty patches, but 81% of
non-empty patches resolve), and remarkably terse (~11.7M tokens vs Kimi's 35–41M).
Full GLM-5.2 6-prompt sweep (/48): claude 39, cursor 40, sharp 32, kcbal 30, kcauto 38,
default 29 (committed `8f56e96`).

**Opus 4.8 arm** (`opus4.8-xhigh`, effort=`xhigh`, `claude` prompt):
- **Result: 40/48 resolved** (47 graded, 1 empty `sphinx-9229`, 7 unresolved, 0 errors).
- **Cost: $52.46** — far below the $150–400 estimate because **prompt caching** turns the
  ~48.6M tokens mostly into cache-reads ($0.5/M); opencode reports cache-aware per-step
  cost. 1.01M tok/inst, 243s/inst avg, 22.1 tools/inst.
- **Where it lands:** 40/48 **ties GLM-5.2's best arm** (cursor, 40/48) and edges GLM-5.2's
  own claude arm (39/48) — but a different model family at ~$52/arm vs GLM's Fireworks
  pennies. Opus-xhigh ≈ best-case GLM-5.2, not a leap above it.

**Gotchas surfaced (contamination bugs in the harness, not the models):**
- **`.pyuserbase` / `.pipcache` leak:** the harness sets `PYTHONUSERBASE`/`PIP_CACHE_DIR`
  *inside* the workdir; `extract_patch`'s `git add -A` swept 254MB of installed
  site-packages + pip cache into the diff → "patches" up to 25MB. Bites models that
  pip-install heavily (GLM) but **not** Kimi (read+edit), so Kimi's numbers are unaffected.
  Fixed by excluding both dirs (`:(exclude).pyuserbase` / `.pipcache`); stripping existing
  preds needed no re-run (real edits intact underneath).
- **httpbin flake:** the 8-instance `psf/requests` band's strict resolved rate (1–2/8) is
  dominated by ~5–6 uniform HTTPS/timeout PASS_TO_PASS tests no env without a local HTTPS
  httpbin can pass — environmental, not skill. The meaningful signal is FAIL_TO_PASS-only
  fix-correctness (default 6/8, scaffolds 7/8). The easy band adds a near-constant +7
  offset and no discriminative signal; the 48-instance band drives the whole result.
- Docker Hub 429 rate-limit on the re-run was bypassed via a SOCKS tunnel (mem→mrt).
- predict is pure Fireworks API + git (**no Docker**); only grading needs Docker.
  `<build-host>` had its original benchmark setup gone (NO_VENV/NO_OC) and a too-old system
  Python 3.8 → bootstrapped Python 3.12.13 + swebench 4.1.0 + opencode via `uv`.

---

## 3. SWE-bench Verified — K2.6 vs K2.7 (8 `psf/requests`, the original run)

Purpose: a real capability benchmark (vs the saturated toy scenarios) to test "is K2.7 the
better coder?".

**Setup / infra path (the hard-won recipe):**
- arm64 Mac, no Docker. **podman was a dead end:** runs containers natively fine, but the
  **docker-compat API socket** the swebench SDK needs throws a storage-driver error
  (`readlink .../storage/overlay: invalid argument` via the rootful `additionalImageStores`).
- Switched to **colima** (Homebrew) started with **`--vm-type vz --vz-rosetta`** so the
  arm64 Mac runs SWE-bench's x86 images fast via Rosetta. Also had to **drop the
  `osxkeychain` credsStore**. Gold-patch eval validated the pipeline (resolved 1/1 in 138s).
- swebench 4.1.0 in a venv; predict harness `swe_bench.py` clones repo at base_commit →
  runs Kimi via opencode → extracts `git diff`. Two predict bugs fixed: must run opencode
  with **`cwd=workdir`** (else it inherits vibe's `.opencode` config and never converges →
  empty-patch timeouts) + an **action-forcing prompt line** (else the model rabbit-holes
  into reproduction and never writes the fix).

**Result: K2.6 and K2.7 tie at 6/8 (75%) resolved** (1 attempt each). 4 solved by both,
each uniquely solves 2 the other misses — noise at n=8. Tokens/tool-calls essentially
identical (~5.8M total, ~25 calls each). Latency: K2.7 72s vs K2.6 95s avg, but huge
per-instance variance (e.g. 5414: K2.6 218s/1.5M tok vs K2.7 48s/346k) and K2.6's early
instances were confounded by colima VM contention from the concurrent gold eval. The
toy-scenario "K2.7 is slower" pattern did **not** replicate on real repo work.
**No axis (accuracy, tokens, latency) cleanly separates the two models at this difficulty.**
(Committed `79860bb`, `28d5561`, `bc8cabc`.)

**Sharp prompt on the same 8:** `default` 6/8 both models; **`sharp` regressed both**
(K2.6 2/8, K2.7 4/8) and newly solved nothing. Sharp used fewer tokens — it compressed the
model into doing less work, producing terser, wrong patches. Punchline: `sharp.md` was
tuned to win tool-hygiene on toy scenarios but trades correctness for concision on real
tasks with hidden tests. Cleaner tool use ≠ better outcomes. (Committed `03f21dd`; raw
artifacts in `~/.cache/swebench-kimi/results/`.)

---

## 4. `agent-benchmark` — contamination-free fugu track + history-mining pipeline

Purpose: real bugs lifted verbatim from post-cutoff commits in a (claimed) private repo →
no gold patch on the public internet to memorize. opencode + Kimi on Fireworks; 6 prompt
arms × {K2.6, K2.7}; **binary grading by exit code, no judge.**
(See `agent-benchmark/RESULTS.md`.)

| case | grading | mode | resolved | discriminates? |
|---|---|---|---|---|
| `fugu-late-start-problem` | clock-wrap flip-test | extract | **6/12** | **yes — strongly** |
| `fugu-strntof-oob` | ASan + NaN contract | handed file | 12/12 | no (floor) |
| `fugu-strntof-oob` | ASan + NaN contract | full source (106 files) | 12/12 | no (floor) |
| `fugu-scope-bufsel-underflow` | contract + ASan | handed file | 12/12 | no (floor) |

`late-start` per-arm: K2.7 5/6 vs K2.6 1/6 (only `kcbal` cracked K2.6; `cursor` failed
both). **Key finding: discrimination = diagnosis difficulty, not localization.** `strntof`
stays 12/12 whether the buggy file is handed over or buried in the 106-file tree (symptom
points straight at the parser). `late-start` separates arms because its root cause (a
32-bit `micros` clock wrap) sits far from its symptom ("backoff stuck"), demanding real
diagnosis. Harvest diagnosis-heavy bugs for discrimination; localized bugs are a
contamination-free floor.

**Contamination-claim contradiction (flagged in the session review):** the README
claims fugu is private with no public gold patch, but `fl4p/fugu-mppt-firmware` is **public
(48★)** — the three fugu problems all have public gold patches. The benchmark's core
anti-contamination claim was false; the proposed fix is mining the user's own
conversation + git history for genuinely-private bugs.

**History-mining pipeline (Stage 1/2) — security-reviewed in the session:**
- `mine_candidates.py` (Stage 1) — proposes only, writes nothing into `problems/`; scores
  diagnosis difficulty + a contamination tier (origin host + commit date vs model cutoff).
- `scaffold_problem.py` (Stage 2) — turns one candidate into a `problems/<name>/fix-task/`
  skeleton matching the fugu layout.
- `templates/run_eval.{cpp,cs,py,ts}.sh` — per-language auto-graders, same exit-code
  contract as fugu (gold=RESOLVED, src=FAIL).
- `verify_grader.sh` — the **"trust anchor"**: runs a task's own grader against gold (must
  RESOLVE) and src (must FAIL) before the hidden test is trusted.
- The review transcript **truncates** ("Now I have enough to
  assess…") — the written security verdict is not in the captured transcript.

---

## 5. Memory-extraction eval harness (fixtures + judges + redaction)

Purpose: validate the auto-memory extraction prompt — does it save the right durable facts,
suppress noise, and never leak secrets? (design doc
`auto-memory/replay-and-extraction-design.md`.)

- **Replay/extraction model:** the `opencode/big-pickle` alias used across the harness is
  **GLM-4.6** (Zhipu); it re-judges past sessions fresh regardless of who originally ran
  them.
- **Methodology:** a small fixture set plus **at-scale replay** over stratified real
  sessions, scored by automated checks (`analyze_replay.py`: leak/recursion/grounding) plus
  manual judgement calls. Validated at scale on **32 fresh sessions** (59% zero-memory
  restraint, 0/32 recursion, redaction holds, 10 real harness findings) and a **27-session
  vibe batch** (0 user memories with opt-in off, commit-hash provenance on project
  memories, cred-pointer references allowed but 0 secret values). The design doc's §16b
  "real-session 2-judge consensus" (and the later Gemma/Qwen verdicts) extends this.
- **Prompt rework:** a two-phase, evidence-grounded `EXTRACT_PROMPT` — Phase 1 (harness
  feedback, removes the "four-types" anchor) then Phase 2 (durable memory, behavior-analysis
  forbidden, must quote the user turn — *"a benchmark of three providers is not a provider
  preference"*), a redaction rule, a recursion carve-out, and a hard-to-rederive reference
  rescue.
- **Redaction gotchas (the load-bearing findings):**
  - A fresh session with a *different secret shape* (a `~/.cron-dash-creds` file pointer +
    username, vs the inline Fireworks keys the rule was tuned on) leaked past the rule —
    the value of not tuning on the same 4 fixtures. Rule strengthened to forbid credential
    file/path/username *pointers*, not just values; re-validated (leak gone, ESM reference
    retained).
  - Later **relaxed** (split): secret **values** never; a location **reference** ("creds in
    `~/.cron-dash-creds`") allowed by default (matches how the user actually tracks
    secrets), with `OPENCODE_MEMORY_REDACT_CRED_POINTERS=1` to strip locations too.
    User-data capture is opt-in (`OPENCODE_MEMORY_CAPTURE_USER`).
  - A flagged real leak in `user_llm_api_workflow.md`: it quoted credential prefixes
    (`tgp_v1_…`, `sk_-_…`) *and* misread a benchmark of three providers as a standing
    "prefers Fireworks" preference — wrong on top of being a security problem.

---

## Open questions

- **`/48` ambiguity:** in these transcripts `/48` means three different things — the
  opencode hygiene sweep was literally **48 runs** ($0.49); the public bake-off scores
  **/48 instances** (43 evaluable on a rootless box). Worth keeping the distinction explicit
  in any writeup.
- **`/43` cause — refinement vs ground truth:** the `/43` tally came from a **subuid
  overflow on the rootless server** that couldn't grade the 5 matplotlib images; on the
  root-Docker `<build-host>` host they grade, giving `/48`. The "ground-truth" phrasing
  "`/43` was a *colima* artifact" is imprecise — colima (vz-rosetta) was the **K2.6/K2.7
  8-instance Mac eval** path; the 48-instance bake-off `/43`↔`/48` is specifically the
  matplotlib subuid/root-Docker issue on the server.
- **`~/.venvs/swebench` + `grade_tag.sh`:** `grade_tag.sh`/`gold_val.sh` appear in the
  bake-off session (orphan-safe grading), but the specific `~/.venvs/swebench` path and
  `~/grade_tag.sh` cited in memory are **not** in these transcripts — likely from the later
  kimi-tools-repo-moved session. Confirm against that session if exact paths matter.
- **Larger/harder SWE-bench sample** (~30–50 instances across django/sympy/sklearn) was
  repeatedly offered but never run — the band where a real K2.6↔K2.7 generational gap could
  open is still unmeasured.
- **Codex / gpt-5.x arm** ("what Kimi Desktop actually resolves" via gpt-5.2-codex) was
  scoped but deferred; `swe_bench.py` only drives opencode.
- **agent-benchmark security verdict** is missing — the review transcript truncates before
  the written assessment of `mine_candidates.py` / `scaffold_problem.py` / the shell graders.
