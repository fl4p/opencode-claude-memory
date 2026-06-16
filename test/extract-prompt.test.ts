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
