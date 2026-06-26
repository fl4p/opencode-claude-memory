# Secrets & Redaction

> Mined 2026-06-26 from the project's own past Claude Code sessions.
> Theme: keeping secret VALUES out of saved memories in the auto-memory / opencode-claude-memory project.

## TL;DR — what actually protects what

- **The prompt is the first line of defense everywhere.** A natural-language REDACTION RULE
  in the extract prompt (`src/prompt.ts`) applies to every save and is the only thing that
  catches keyword-less leaks. Historically it was the *only* defense — the deterministic
  scrub lived solely in the Python eval/replay harness.
- **A programmatic scrub now ships in the plugin.** `src/redact.ts` ports `redactSecrets`/
  `scrubMemoryFields` 1:1 (incl. the WiFi/PSK hardening + the 16-case regression suite), and
  `saveMemory` runs it on `name`/`description`/`content`. The decision (`shouldRedactMemory`):
  - **IN-REPO writes: scrubbed by default** (the `.claude/memory` store can be committed/pushed),
    opt-out via `localMemorySecrets`.
  - **GLOBAL `~/.claude` writes: kept by default** (the store is private to the user), with an
    **opt-in** scrub via `OPENCODE_MEMORY_REDACT_GLOBAL` / `redactGlobalSecrets` for
    belt-and-suspenders.
  So the prompt-only gap is closed exactly where it matters most — the pushable store — while
  the default global policy ("secrets OK in `~/.claude`") is preserved. The scrub is
  keyword-anchored and best-effort, not a guarantee; the prompt rule still backs it.

## Redaction architecture (the layered design)

The validated recipe for secret safety is **two complementary layers**, fail-safe-composable
(both only ever replace a value with `«REDACTED»`, so over-redaction is never data loss):

1. **Deterministic regex floor** — `local_extract.redact_secrets`. Zero-cost, certain on
   *known* keyword+value forms (`api_key`, `psk`, `token=`, `password '…'`). Scrubs credential
   VALUES anchored on strong keywords, leaving location pointers, paths, usernames, prose intact.
2. **Concentrated LLM secret-strip pass** — a *separate* LLM call whose only job is "redact
   VALUES only, change nothing else." Reaches novel / contextual / keyword-less forms the regex
   structurally cannot.

Best deployed at **save-time to PREVENT the write**, with the periodic dream as a whole-store
backstop sweep. Neither layer alone suffices; their **union** maximizes recall.

## The 2-pass concentration result

The 2-pass secret eval — synthetic 8-memory store, 7 planted secret VALUES
(regex-catchable + regex-evading forms) + 5 decoy look-alikes. Conditions: `regex`, `1pass`
(consolidate+strip together), `2pass` (concentrated strip), `2pass+rx`.

| condition | GLM-4.6 | Gemma-4-12B |
|---|---|---|
| regex floor | 43% (3/7) | 43% (3/7) |
| 1pass (both at once) | **100%** | **43%**, n_out=8 (didn't consolidate either) |
| 2pass (concentrated) | 100% | **100%** (n_out=6) |
| 2pass+rx | 100%, 0 decoys lost | 100%, **1 decoy lost** |

- **Regex floor alone is insufficient (43% both models)** — it catches keyword+value forms and
  misses every keyword-less form (password inside a connection string, value-only "Recovery code:",
  bare `Bearer <tok>`).
- **GLM-4.6 doesn't need concentration** — strips all 7 forms *while* consolidating (1pass=100%);
  the 2nd pass is free insurance for it.
- **Concentration is decisive for the weak/local model.** Gemma asked to do both at once failed
  BOTH (43% strip + no consolidation); given one narrow job it jumps to 100%. This is what makes a
  local secret-strip pipeline viable at all.
- The 2nd pass fixes secrets, **not over-merge** (orthogonal to the dream-merge problem).
- Conclusion: layered floor + concentrated LLM strip. **Does NOT change the default** (extraction +
  dream stay on GLM-4.6); it's the recipe IF a local pipeline is ever built.

## Cross-validation on REAL stores — 8 projects / 155 memories

The real-store secret scan measures PREVALENCE + the regex-vs-LLM GAP on real Claude
stores (LLM arm is **local Gemma only** — never send real, possibly-secret memory to a cloud model;
masked `/tmp` output only, exact leak locations kept OUT of any doc).

- **Regex floor: 0 real leaks caught, 2 false positives** over 155 memories. It is STRUCTURALLY
  BLIND to the real leaks (creds inside a URL, bare ``pass `x` ``) and MISFIRES on prose
  ("passwords are *not* migratable"). Confirms the floor cannot stand alone.
- **Local Gemma critic: 14 flags, ZERO overlap with regex.** Adjudicated: **~3 are REAL
  keyword-less leaks** the regex could never catch (literal creds in a git URL `user:pass@host`;
  a literal DB password ``pass `x` `` — "pass" is not a regex keyword; a 6-digit device passkey).
  The other ~11 are **false positives** (hostnames, serial ports `ESPPORT=`/`-p`, an OTA URL,
  SSID/PSK that are actually `$VAR` refs). **Precision ≈ 3 real : 11 FP (~21%).**
- **The two layers are COMPLEMENTARY (zero overlap):** regex catches keyword forms but FPs on
  prose; the LLM catches keyword-less forms but FPs on infra strings. Union = max recall.
- Gemma's low precision is tolerable **only** under the fail-safe `«REDACTED»`-only design
  (over-redaction ≠ loss). A human-facing "you have leaks" alert on raw Gemma output would be ~80%
  noise → needs a higher-precision critic (GLM, or a confirm pass) before alerting.
- Best hygiene observed: most secrets in real stores are already `$VAR` refs (the user's
  secrets→`.env` rule); the literal leaks are exceptions, flagged for scrubbing.

## The real PSK/WiFi leak and hardening

- **A real secret VALUE leaked.** A Gemma extraction run on a **real session** saved the **Lab WiFi
  PSK value** into a memory (both consensus judges flagged it). `scrub_memory`'s keyword-anchored
  redaction did **not** catch the WiFi-PSK form. On a single controlled fixture Gemma leaked 0; on
  real sessions it leaked a real credential — same failure class as Qwen, milder only in volume.
  This is why Gemma is judged NOT shippable.
- **WiFi/wireless hardening.** `redact_secrets` gained the WiFi credential
  family: `psk`, `pre-shared key`, `wpa[2]-psk`, `wifi password/key`, `network key`, `passcode`.
  The leak slipped through because the old keyword set had **no** such term, so the
  already-present quoted-value gate never fired on ``PSK `<value>` ``. Pinned by
  the redaction regression suite (16 checks, synthetic values only; includes FP guards
  for SSID names, location pointers, "password-protected", "wifi is down").

## Known false-positive fixes

- **WPA handshake false match:** the `wpa` keyword collateral-matched "**WPA 4-way handshake**". Regex narrowed
  `wpa\d?(?:[\s_-]?psks?)?` → `wpa\d?[\s_-]?psks?`, making `psk`/`key` **required** after `wpa`.
  Documented as a deliberate FP fix; **regression still 16/16** — the leak case and all other
  cases still pass. The security review of that diff found **no findings** (eval-only safety net,
  intentional tightening, not a control regression).
- **Description-form value:** `redact_secrets` first MISSED ``password '<planted-pw>'``
  (keyword-then-quoted-value, no copula). Hardened: copula now optional, a quoted value is itself a
  strong signal, and the length-only heuristic (which flagged ordinary long words like
  "requirements") was dropped. After: scrubbed from both fields, **0 false positives** across
  `password-protected` / `password requirements` / cred-location pointers / key paths / usernames.

## The fundamental limit

> The patch-an-evasion cycle is itself the finding: regex post-redaction of an **uncooperative
> model** is best-effort — a value phrased with no keyword cue still slips through. The guard
> *reduces* leak risk; it does not eliminate it.

Therefore the design conclusion is **model-first**: the right extractor is the *stronger* model.
GLM-4.6 (`opencode/big-pickle`) is 7/7 clean and never emits a secret value while consolidating;
Qwen-30B-A3B-4bit is 1/7 and leaks in forms a guard cannot fully contain. Default extraction +
dream stay on **GLM-4.6**. The two model-independent deliverables (both in `local_extract.py`) are
the agentic-loop correctness fix and the redaction guard.

## Origin of the redaction rule

The whole rule set was derived empirically by triaging replay output:
- First triage found ~1 of 7 raw memories worth keeping, and **the single most important finding was
  a credential leak** (`user_llm_api_workflow.md` quoting key prefixes `tgp_v1_…`/`sk_-_…` and
  pointing at the key file). → "Never write credentials, key prefixes, or credential-file locations."
- A **fresh session with a different secret shape** then surfaced a leak the first rule was too
  narrow for: `~/.cron-dash-creds (user <user>, password is there)`. → rule strengthened to forbid
  credential **file/path/username pointers**, not just values (re-validated: leak gone, good ESM
  reference retained). The lesson: don't tune on the same 4 sessions.
- Later the rule was **split** after observing the user's real store deliberately keeps cred
  pointers (`reference_creds_env_files.md`, an actual gitignored `secrets.env`): secret **VALUES**
  are absolutely never written; a credential **location reference** is allowed by default, and
  `OPENCODE_MEMORY_REDACT_CRED_POINTERS=1` strips locations too. The analyzer's cred flags across
  the 27-session and fugu/scale runs were **all** verified as location-pointers, **zero secret
  values** — the redaction + pointer split working as designed.

## Design decision now in play: GLOBAL store vs IN-REPO store

A secret VALUE in the **global** `~/.claude/.../memory` store is acceptable (private to the
machine). A secret value in an **in-repo** `.claude/memory` store is **not** — the repo may be
private but pushed/shared, so a leaked value escapes the machine. Therefore:

- Secrets (values) must NOT land in an in-repo / local-mode memory store unless the user
  **explicitly opts in**.
- **DONE (2026-06-26):** this is now implemented. `saveMemory` scrubs in-repo writes via the
  ported `src/redact.ts`; opt-in to keep secrets in-repo is `OPENCODE_MEMORY_LOCAL_SECRETS` /
  `opencode.json` `localMemorySecrets` (default off). The `memory_save` tool reports
  `🔒 Redacted N credential value` when it catches one.

## Key files

- The Python eval harness — `redact_secrets` / `scrub_memory` (original)
- `opencode-claude-memory/src/redact.ts` — TS port now running in production for in-repo writes
- `opencode-claude-memory/test/redact.test.ts` — the 16-case suite, ported
- The redaction regression suite — 16 checks, synthetic values + FP guards
- The 2-pass concentration eval (synthetic, both backends)
- The real-store cross-validation eval (regex + local Gemma, masked /tmp)
- `opencode-claude-memory/src/prompt.ts:122` — the prompt-level REDACTION RULE (applies everywhere)

## Open questions

- **Global store still relies on the prompt only.** In-repo writes are now scrubbed; the global
  `~/.claude` store is intentionally not. Is that the right call long-term, or should the dream
  sweep also run the scrub as a backstop?
- **Local-pipeline higher-precision critic.** The local Gemma critic is ~21% precision; a
  human-facing "you have leaks" alert needs GLM (or a confirm pass) before it's not ~80% noise. Which?
- **Residual keyword-less leaks.** The guard is best-effort by construction. What rate of
  no-keyword-cue values still slips through on real corpora, and is the concentrated LLM strip pass
  worth wiring into production for those, or only the dream sweep?
- **Cred-pointer opt-out default.** Pointers are allowed by default with an opt-out env var; should
  an in-repo store flip that default to opt-IN (stricter) given the push risk?
- **Explicit opt-in UX** for allowing secret values into a chosen store — does this exist yet, or is
  it still only a design intent?
