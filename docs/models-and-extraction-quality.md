# Memory Extraction — Models & Quality

> Mined from Claude Code session transcripts on **2026-06-26** for the auto-memory /
> `opencode-claude-memory` plugin. Reference doc — verdicts on which LLMs were tried for
> memory **extraction**, **recall**, and **dreaming** (consolidation), and how their quality
> was measured. Cross-references the design doc
> `auto-memory/replay-and-extraction-design.md` (§-numbered) throughout; this doc captures the
> decision rationale and dead-ends, not a re-derivation.

Source sessions cited inline as ``:

---

## 1. Model comparison — every model tried

| Model / alias | Role | Where it runs | Verdict | Key numbers |
|---|---|---|---|---|
| **GLM-4.6** = `opencode/big-pickle` | extraction · recall-judge · dream | opencode gateway (cloud, $0 free/preview tier) | **DEFAULT.** Cleanest distiller; respects all conservative gates | Fixtures **7/7**; real-session over-capture **0.12/sess**; dream **9→6 lossless**; never leaks; ~7 s/call (variance ~3.3–18 s, one 120 s timeout) |
| **kimi-k2p7-code-fast** (`fireworks/routers/...`) | extraction (speed pick) | Fireworks cloud | Viable #2; clears the gates but noisier | Fixtures **7/7**, 100% recall, **~4 s**; real-session over-capture **0.56/sess** (~4.7× GLM); 0 leaks |
| kimi-k2p7-code | extraction | Fireworks cloud | Good, one harness-feedback slip | 6/7, 100% recall, ~6 s, 80% precision |
| kimi-k2p6-turbo | extraction | Fireworks cloud | Fine, older weights; superseded by k2p7-fast | 6/7, 92% recall |
| **Qwen3-30B-A3B-Instruct-2507** (and Coder-30B-A3B) | extraction · dream (both rejected) | local MLX (in-process) AND Novita cloud (fp8) | **REJECTED.** Leaks secrets, floods, ignores suppression/abstain/redaction rules, unstable | Fixtures **1/7** (local 4-bit), **2/7** (Novita coder); real-session over-capture **2.92/sess** (~24× GLM); dream destructively unstable |
| **Gemma-4-12B-Coder** (`gemma-4-12B-coder-fable5-...-4bit-msq`, gemma4_unified VLM via mlx-vlm) | extraction · dream | local mlx-vlm | **BEST local tried, but NOT shippable.** Fail-safe dream, but over-captures and leaks a real secret | Fixtures **5/7**, 0 fixture leaks; real-session over-capture **1.25/sess** (~10× GLM), **0/22 save-worthy**, **1 real PSK leak**; peak ~9.5 GB |
| GLM-4-32B-0414 | extraction | local MLX (4-bit DWQ) | Dead end: slow + under-extracts | 3/7, ~100 s/fixture; wrong tool-format lesson |
| Qwen3-Coder-30B-A3B (Novita fp8) | extraction | Novita cloud | Confirms Qwen failure is the MODEL, not quant/host | 2/7, 37% precision, 30 hard-fails, leaks `hunter2pickle` |
| openai/gpt-5.5 | extraction (attempted) | — | Not evaluated (`ProviderModelNotFoundError`, no auth in eval config) | — |
| Claude Opus 4.8 | (strong-caller control for coding bake-off) | cline gateway only | **Deferred** in the coding bake-off; not used for memory extraction | see §6 contradiction note |

Roles legend: **extraction** = read a finished session transcript → emit memories; **recall**
= select/inject stored memories into a new session (the plugin's recall sub-agent); **dream** =
periodic consolidation that may *delete/merge* memories (irreversible — the riskiest op).

---

## 2. `big-pickle` = GLM-4.6 (confirmed)

The user stated it verbatim mid-session: *"btw: Big_PICKLE is GLM-4.6"* on a free/preview tier (every run cost `$0`):

1. **Synthetic fixtures (`score_heuristic`).** 7 hand-built adversarial fixtures (~1.5 KB each),
   keyword/groundedness scored, identical across all models so numbers compare directly (design
   doc §14b/§15). They pin specific *gates* (redaction, user-suppression, recursion-carveout,
   abstain) but **cannot see SELECTIVITY** — a capture can be true yet not worth saving (design
   doc §15d/§16).
2. **LLM-judge on fixtures (groundedness).** Re-scored finalists with GLM-4.6 as judge. **Did
   NOT rescue kimi's low precision** — groundedness asks "is the capture *true*?", the wrong axis
   for a selective distiller; a grounded capture can still be a should-not-have-saved capture
   (design doc §15f, explicitly self-corrected).
3. **Real-session save-worthiness consensus (the eval worth trusting).** Run extractor over real
   transcripts (`replay-out-fugu-claude/` + `replay-out-vibe/`), and ask judges *per memory*:
   grounded? save-worthy (or derivable-from-code / ephemeral / memory-system junk)? secret leak?
   - §16: single cross-assigned judge, 10 sessions.
   - **§16b: 2-judge consensus** — every capture judged by *both* GLM-4.6 and kimi-k2p7-code-fast;
     counted `over_capture` **only when BOTH agree** `save_worthy=False` (disagreement → `split`,
     excluded from the tally), so no single judge decides. 16 varied sessions, per-session timeout
     tolerance. This is the gold standard the doc trusts; the robust metric is **over-capture
     volume per session**, not the noisy save-worthy %.

**Vote instability is a measured dead-end:** `temp=0.6`, 5 samples/fixture → Qwen is unstable on
6/7 fixtures yet majority-vote pass stays **1/7, identical to greedy**. Voting filters random
noise, not a *systematic* wrong output that recurs in the majority. Temperature+voting is
**rejected** as a stability mechanism (design doc §14d). The same instability sinks Qwen dreaming
(below).

---

## 4. Per-model failure modes (with citations)

### GLM-4.6 / big-pickle — the bar everything else is measured against
- 7/7 fixtures; 100% recall; **never emits a secret value**; respects user-suppression and the
  recursion carve-out; **abstains** on harness feedback (design doc §14b/§15).
- Real-session: **0.12 over-captures/session**, the selectivity king; its single slip class is the
  memory-system-location carve-out (design doc §16b/§11a).
- Dream: **9→6 lossless** — deletes only true duplicates + the memory-system-design entry, invents
  nothing (design doc §10c/§17).
- The one operational wart: **latency variance** (gateway-bound, not prompt-bound) — swung ~5.9 s
  to ~18 s mean across runs in a day, one standalone call timed out at 120 s; a big firmware-log
  step hit ~172 s.

### Qwen3-30B-A3B — rejected at every host/quant
- First quantified live on the cross-agent channel: on the *same* fixture session GLM-4.6 emitted
  **0 memories** (correct abstain) while Qwen invented **1 fabricated `harness_feedback`** →
  **"GLM abstains, Qwen invents"**.
- Fixtures 1/7. The one it passes is `explicit-remember-directive`. Failures are
  **instruction-following-fidelity**, not capability (design doc §14b):
  - **cred-pointer:** writes the password VALUE inline (`the password is 'hunter2pickle'`).
  - **user-suppression:** saves a `type=user` memory despite user-capture being OFF; invents
    guidance.
  - **recursion-carveout:** saves 3 memories *about the memory system itself*, including a
    self-referential wikilink.
  - **feedback-preference:** misroutes a standing preference into `harness_feedback`, misses the
    real `feedback`.
- Prompt hardening (the abstain delta) is **ineffective** — still fires `harness_feedback` 7/7;
  Qwen ignores the new rule as it ignores REDACTION (design doc §14c). Vote doesn't help (§14d).
- **Host/quant ruled out:** Novita's *hosted fp8* coder scores 2/7 and leaks the same
  `hunter2pickle` — identical signature to local 4-bit. So 1/7 is **not** a quant artifact, not an
  in-process-harness artifact, not a tool-format issue, not coder-vs-instruct. The MoE's ~3B active
  params are simply too loose for the conservative gates (design doc §15a).
- Real-session consensus: **2.92 over-captures/session (~24× GLM)**, 0 save-worthy of 44 (design
  doc §16b).
- **Dreaming is UNSAFE (irreversibly):** temp=0.6×3 gives 3 distinct destructive delete-sets
  (after-counts `[3,7,8]`); sample 1 **saved a merged file then deleted the file it just wrote**
  and nuked 6/9 distinct facts. Verdict: do NOT dream on local Qwen (design doc §17).
- OOM was *solved* (in-process agentic loop, ~18.5 GB peak, whole distribution fits single-shot;
  the ~30k "ceiling" was the HTTP server, never the model) — but content quality is the real
  blocker, not infra (design doc §13).

### Gemma-4-12B-Coder — best local, still not shippable
- Runtime is a "read-the-docs" trap: it's a `gemma4_unified` multimodal VLM → needs **mlx-vlm
  0.6.3** (separate `~/.venvs/mlx-vlm`), driven TEXT-only, prompted-JSON (it ignores its own native
  `<|tool_call>` format and volunteers a clean JSON block); peak ~9.5 GB (design doc §18).
- Fixtures looked good: **5/7, 0 leaks** across all 7 runs — lands near kimi, far above Qwen.
- **§16b consensus overturns the fixture optimism** (design doc §18a):
  - over-capture **1.25/session (~10× GLM, ~2.2× kimi)**.
  - **0 of 22 captures consensus save-worthy** — it documents the repo ("Project Overview", "Tech
    Stack", "DB schema", per-commit summaries, ephemeral benchmark numbers) instead of distilling.
  - **1 real secret-VALUE leak:** it saved the **Lab WiFi PSK value** into a memory (both judges
    flagged it); `scrub_memory`'s keyword-anchored redaction missed the WiFi-PSK form. Same failure
    class as Qwen, milder only in volume.
- Dream is **fail-safe but NOT lossless** — corrected in §18b: the original "lossless" read used a
  self-contradictory prompt; with the conflict fixed the over-merge **loses the `bat_c` detail**.
  GLM keeps `bat_c` separate; the over-merge is **Gemma-specific** (GLM re-check confirms) (design
  doc §18b).
- The security review of the integration code found **no vulnerabilities** — the LLM-output→FS path
  is confined by `MemoryStore._safe` (basename + `.md`, throwaway pooled corpus)** vs Qwen3-30B-A3B's MoE (~3.3B active);
  restraint/suppression/consistency are **active-param-bound**, and ~4× active params is decisive.
  Total params are a red herring (design doc §18). Even so, ~12B active is below the GLM/kimi bar.

### kimi (k2p7-code / -fast / k2p6-turbo) — the viable cloud #2
- k2p7-code-fast is **7/7, 100% recall, ~4 s** — quality holds at higher throughput, so it's the
  **speed** pick. But it's **noisier (~63% fixture precision vs GLM's 92%)**: it saves a few
  derivable-from-config/code extras GLM correctly omits (design doc §15b/§15f).
- Real-session over-capture 0.56/session (~4.7× GLM); both its over-captures were CLAUDE.md-derivable
  — a mild ding, far from Qwen (design doc §16b).

### GLM-4-32B-0414 (local) — dead end
- Dense 32B ⇒ ~100 s/fixture and **under**-extracts (3/7), narrating "I will not record…" instead of
  emitting calls. Cost a methodology lesson: first eval drove it with **Qwen's Hermes `<tool_call>`
  format**; GLM-4-0414's documented format is `function_name\n{json}` with **`observation`**-role
  results. *Lesson: read the API docs for the exact version/variant; don't infer the format from a
  generic wrapper's defaults* (design doc §15c).

---

## 5. The deterministic redaction guard (model-independent safety)

`redact_secrets` / `scrub_memory` in `local_extract.py` scrub credential VALUES anchored on
strong keywords, leaving location pointers/paths/usernames/prose intact. It is **best-effort, NOT a
guarantee** — "patch-an-evasion is itself the finding": a value phrased with no keyword cue slips
through (design doc §14e). Two real misses drove hardening:
- Qwen's description-form leak (`password 'hunter2pickle'`, keyword-then-quoted-value, no copula) →
  copula made optional, a quoted value is itself a strong signal (design doc §14e).
- Gemma's **WiFi-PSK** leak (no `password`/`token` keyword anchor) → added the wireless family
  (`psk`, `pre-shared key`, `wpa[2]-psk`, `wifi password/key`, `network key`, `passcode`), pinned by
  `test_redact_secrets.py` (design doc §18a/§18b redaction-hardening note).
- **Production gap (important):** this guard lives only in the Python eval/replay harness. The
  shipping plugin's secret safety is **prompt-only** (`prompt.ts`); porting `redact_secrets` into the
  plugin's `memory_save` is an open follow-up (memory `project_plugin_no_programmatic_secret_gate`).

---

## 6. Defaults and WHY

- **Extraction default: GLM-4.6 (`opencode/big-pickle`), cloud.** Tightest selectivity (0.12
  over-capture/session), 7/7 gates, never leaks (design doc §14f/§15e/§16b).
- **Speed alternative: `kimi-k2p7-code-fast`** (7/7, ~4 s) when latency matters; accept ~4.7× more
  over-capture (design doc §15b/§15e).
- **Dream default: GLM-4.6** (9→6 lossless; both local models fail the dream — Qwen destructively,
  Gemma by losing detail) (design doc §17/§18b).
- **Local is effectively "lower quality" today.** Every Qwen3-30B-A3B variant leaks + floods at any
  host/quant; Gemma-4-12B is the best local but still over-captures ~10× and leaked a real PSK. A
  competent-enough local model (70B+) won't fit the 36 GB budget at the quality bar (design doc
  §14f/§18a). The OOM/infra side is fully solved — the blocker is **model judgment**, not the harness.

**Model-independent keepers** (ship regardless of model): the agentic-loop correctness fix and the
redaction guard in `local_extract.py`; the provider-free local dream harness `run_dream_local.py`
(measures the next local model in one command); the eval harnesses `gemma_*.py` /
`saveworthiness_eval.py` (design doc §14f/§17/§18a).

### ⚠ Contradiction / clarification vs the supplied ground truth
The ground truth's *"kimi-tools bake-off: Opus 4.8 xhigh×claude = 40/48 (ties GLM-5.2's best)"* is
different thing: a **SWE-bench coding system-prompt bake-off** on 8 `psf/requests` instances
(scored **resolved/8**, not /48), where **Opus 4.8 was added as a strong-caller control and then
explicitly DEFERRED** ("we will defer this"); Opus is reachable only via cline's gateway (opencode
has no Anthropic). The 40/48 number belongs to a separate `kimi-tools` public bake-off (see memory
`project_kimi_tools_opus_arm` / `project_kimi_tools_repo_moved`), which is about **coding** tool-use,
**not memory extraction**. Flagging so the two bake-offs aren't conflated: no model-for-extraction
verdict in this doc rests on the 40/48 figure.

---

## 7. Decision rationale & dead-ends the design doc under-states

- **The free, opaque, gateway tier is load-bearing.** GLM-4.6 via big-pickle costs `$0` but is a
  preview/free tier with volatile latency and no cost reporting (zen gateway omits cost in
  `step-finish`). The honest production trade is "free-but-opaque-preview vs paid-but-controlled"
  — a swap to a paid Anthropic/Kimi endpoint is a *model* change,
  not just a host change.
- **The recall sub-session deadlocks headless extraction.** The plugin's recall-prefetch spawns a
  child agent that hangs inside a headless `opencode run`; `--no-recall`
  (`OPENCODE_MEMORY_IGNORE=1`) skips it while keeping memory tools + save instructions — the
  recommended extraction mode.
- **"Looser" was made concrete, not hand-waved.** The Qwen-vs-GLM gap moved from a vibe ("Qwen is
  looser") to a number via a same-fixture diff (GLM 0 memories vs Qwen 1 fabricated), with the
  honest caveat that the two runs used different harnesses (opencode-fork vs a direct probe). Worth remembering as a methodology trap.

---

## 8. Open questions / unresolved

- **Production secret gate.** The deterministic `redact_secrets` is harness-only; the shipping
  plugin remains prompt-only. Porting it into `memory_save` is planned but open
  (`project_plugin_no_programmatic_secret_gate`). Even ported, it's best-effort — a keyword-less
  value still slips (design doc §14e).
- **A clean local-vs-cloud A/B.** "Keep extraction off opencode" means building a *new direct
  harness*; the surviving non-OOM path is a separate ~50-line `direct_extract_probe.py`, so a true
  apples-to-apples GLM-vs-Qwen A/B (same direct probe, same prompt) was never run.
- **Save-worthy % is noisy.** Real-session corpora warrant so few memories that the save-worthy
  *percentage* is unstable (n=2–3); only **over-capture volume** is robust. Gold labels on real
  sessions, and larger/more varied corpora, would firm it up (design doc §16/§16b).
- **gpt-5.5 never evaluated** (`ProviderModelNotFoundError`) — an obvious gap in the cloud sweep
  (design doc §15d).
- **Prompt-cache reuse for long transcripts.** GLM-4.6's latency variance is gateway-bound; a
  `prompt_cache` reuse on the 54k-tail re-prefill is the noted-but-unimplemented follow-up (design
  doc §14a).
- **Gemma caveats unresolved:** prompted-JSON ≠ the tool-loop baselines (may itself nudge toward
  over-listing → an upper-bound-ish over-capture read), n=16, and it's a community coder fine-tune,
  not base Gemma 4 (design doc §18a).
