import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// The post-session EXTRACT_PROMPT (and its runtime capture directives) is what
// decides whether a fact gets memorialized and as which type. The "btw self-test"
// showed an incidental aside ("btw: Big_PICKLE is GLM-4.6") captured as a
// `reference` memory and NOT suppressed. That outcome is non-deterministic at the
// model layer, so we cannot assert the capture itself in CI. Instead we guard the
// deterministic CAUSAL CONDITIONS in the prompt — if an edit flips any of them,
// the observed behavior would regress, and this test fails. No model, no keys.
const HOOK = readFileSync(join(import.meta.dir, "../bin/opencode-memory"), "utf-8")

describe("EXTRACT_PROMPT — btw-capture invariants (deterministic, no keys)", () => {
  test("`reference` type covers config-locations / where-to-find-things", () => {
    // A model-alias / config pointer like big-pickle=GLM-4.6 is a reference fact.
    expect(HOOK).toContain("**reference**")
    expect(HOOK).toMatch(/reference.*config locations.*where to find things/)
  })

  test("a non-obvious durable fact must NOT be skipped as too trivial", () => {
    // The criterion that let an incidental aside still qualify.
    expect(HOOK).toContain("Hard-to-rederive beats strictly-absent")
    expect(HOOK).toContain("skipping junk and redundancy, not skipping a clean non-obvious fact")
  })

  test("EVIDENCE RULE is scoped to user/feedback — reference needs no quote", () => {
    // Why an incidental `reference` aside is capturable: the grounded-quote
    // requirement gates user/feedback, not reference/project.
    expect(HOOK).toContain("EVIDENCE RULE (user and feedback types)")
  })

  describe("user-capture is opt-in, OFF by default (must not silently flip on)", () => {
    test("env default is 0", () => {
      expect(HOOK).toContain('CAPTURE_USER="${OPENCODE_MEMORY_CAPTURE_USER:-0}"')
    })
    test("prompt body disables type=user absent an explicit enable line", () => {
      expect(HOOK).toContain("DISABLED BY DEFAULT: do NOT save `user` memories")
      expect(HOOK).toMatch(/Absent that line, skip type=user entirely/)
    })
    test("default branch appends USER-CAPTURE: DISABLED", () => {
      expect(HOOK).toContain("USER-CAPTURE: DISABLED")
      expect(HOOK).toContain("USER-CAPTURE: ENABLED") // the opt-in branch still exists
    })
    test("an explicit 'remember/always/never' directive pierces the opt-in (but never redaction)", () => {
      // The opt-in suppresses GUESSING a profile, not honoring an explicit
      // "remember I'm a Go dev". Without this carve-out the backstop would
      // silently drop a deliberate user request. Counterpart: an incidental
      // aside is still suppressed (the user-suppression eval fixture).
      expect(HOOK).toContain("EXPLICIT-DIRECTIVE RULE")
      expect(HOOK).toMatch(/PIERCES the USER-CAPTURE default-off/)
      expect(HOOK).toMatch(/does NOT pierce the REDACTION RULE/)
    })
  })

  describe("credential redaction: pointers opt-out (on), secret VALUES never", () => {
    test("secret values are absolutely never written", () => {
      expect(HOOK).toContain("never write secret VALUES")
    })
    test("env default leaves cred-location pointers ENABLED", () => {
      expect(HOOK).toContain('REDACT_CRED_POINTERS="${OPENCODE_MEMORY_REDACT_CRED_POINTERS:-0}"')
      expect(HOOK).toContain("CRED-POINTER: ENABLED")
    })
  })

  test("memory-about-memory carve-out present (no recursion capture)", () => {
    // Guards the sibling invariant validated in the same work: the extractor must
    // not memorialize the memory system itself, even mid-design-session.
    expect(HOOK).toMatch(/memory.*notes.*knowledge system.*INCLUDING.*this very session/s)
  })
})

// Regression: replaying the "Non-focused tile fade" session (ses_12e18f166…)
// through the production --fork path produced a FABRICATED feedback memory. The
// session was entirely about UI tiles, but the model read the agent's own
// `reasoning` blocks ("I need to create an anchored summary…") and invented a
// verbatim USER quote ("the summaries are helpful but you don't need to maintain
// the entire session history…") that appears nowhere in any user turn. Root
// cause: the --fork transcript includes the agent's reasoning, undelimited, and
// the prompt did not forbid attributing reasoning/assistant text to the user.
// The ATTRIBUTION RULE closes this WITHOUT stripping reasoning — reasoning stays
// visible because it is the core signal for Phase 1 (harness feedback about agent
// behavior); it just can no longer be misquoted as the user in Phase 2.
describe("EXTRACT_PROMPT — ATTRIBUTION RULE (anti-confabulation, deterministic, no keys)", () => {
  test("the rule exists", () => {
    expect(HOOK).toContain("ATTRIBUTION RULE (whose words are these)")
  })

  test("reasoning is KEPT for Phase 1, not stripped (sink-aware: Obj1 needs it)", () => {
    // The fix must not blind harness-feedback to the agent's own reasoning —
    // that is exactly where "the agent went wrong" lives.
    expect(HOOK).toMatch(/legitimate input for Phase 1 when judging how the agent behaved/)
  })

  test("reasoning / assistant / tool / summary text is NEVER a user statement", () => {
    expect(HOOK).toMatch(/Treat reasoning and assistant text as output FROM the agent[^]*NEVER a user statement/)
    expect(HOOK).toContain(
      "attribute reasoning, an assistant message, a tool result, or a summary the agent itself wrote as if the user said it",
    )
  })

  test("user/feedback evidence must come from a real, verbatim user turn", () => {
    expect(HOOK).toContain("must come from a real USER turn that appears verbatim above")
    // ties back to the pre-existing EVIDENCE RULE rather than introducing a rival gate
    expect(HOOK).toMatch(/the EVIDENCE RULE is not met — do not save/)
  })

  test("a gist-quote that is not verbatim is explicitly a fabrication", () => {
    expect(HOOK).toContain("Never manufacture a quote")
    expect(HOOK).toMatch(/does not appear verbatim in a user turn is a fabrication, even if it captures the gist/)
  })
})

describe("EXTRACT_PROMPT — PROVENANCE RULE (no-COMMITS-block hash confabulation)", () => {
  // Regression: a local/direct extraction with NO COMMITS block injected echoed
  // the rule's own example hash ("a1b2c3d") as if it were a real commit. The
  // example must not be a copyable real-looking hash, and the rule must tell the
  // model to cite NO hash when no COMMITS block is present.
  test("example hash is a non-copyable placeholder, not a real-looking sha", () => {
    expect(HOOK).not.toContain("fixed in a1b2c3d")
    expect(HOOK).toContain("fixed in <commit>")
  })

  test("no COMMITS block => cite no hash, do not reuse the placeholder or a stale hash", () => {
    expect(HOOK).toContain("If NO COMMITS block appears in this message")
    expect(HOOK).toMatch(/do NOT write any commit hash/)
    expect(HOOK).toMatch(/never reuse a hash from this prompt or from another session/)
  })
})

describe("EXTRACT_PROMPT — PHASE-1 OBSERVATION RULE (abstain delta, no spurious harness_feedback)", () => {
  // Local Qwen-30B fired a fabricated harness_feedback on review/design sessions:
  // it promoted a code-review opinion about the code UNDER DISCUSSION into harness
  // feedback, and invented would-be-better fixes for problems that never occurred.
  // The eval measured this on the harness-feedback / btw-model-alias fixtures.
  // These guards lock the three deltas that gate it (no model, no keys).
  test("Phase 1 requires the feedback to describe behavior that ACTUALLY OCCURRED", () => {
    expect(HOOK).toContain("PHASE-1 OBSERVATION RULE")
    expect(HOOK).toMatch(/ACTUALLY OCCURRED in THIS conversation/)
    expect(HOOK).toMatch(/if you cannot point to the turn or tool call where the problem actually happened, record nothing/)
  })

  test("the session SUBJECT (reviewing agent/skill/tool code) is not itself harness_feedback", () => {
    expect(HOOK).toMatch(/the conversation SUBJECT is agent, harness, skill, or tooling code/)
    expect(HOOK).toMatch(/review opinions about the code under discussion are the session deliverable/)
  })

  test("the catch-all bullet is gated on an OBSERVED misbehavior, not a code-review opinion", () => {
    expect(HOOK).toMatch(/ONLY when triggered by an inefficiency or misbehavior you OBSERVED the agent exhibit this session/)
    expect(HOOK).toMatch(/never as a code-review opinion about code the session was discussing/)
  })

  test("a few-shot DO-NOT-record example inoculates the observed fabrication", () => {
    expect(HOOK).toContain("fabricated harness feedback")
    expect(HOOK).toMatch(/no observed agent misbehavior/)
  })
})
