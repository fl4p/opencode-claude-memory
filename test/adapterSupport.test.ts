import { describe, expect, test } from "bun:test"
import {
  decideMemoryGateway,
  formatMemoryGatewayBrief,
  stripSessionOwnedToolFields,
} from "../src/core/adapterSupport.js"
import type { RecalledMemory } from "../src/core/recall.js"

function memory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    fileName: "project.md",
    filePath: "/tmp/memory/project.md",
    name: "Project",
    type: "project",
    description: "Project memory",
    content: "Use Bun for tests.",
    ageInDays: 0,
    ...overrides,
  }
}

describe("decideMemoryGateway", () => {
  test("marks empty recall as insufficient with bounded fallback work", () => {
    const decision = decideMemoryGateway({ recalled: [] })

    expect(decision.status).toBe("insufficient")
    expect(decision.recalledCount).toBe(0)
    expect(decision.reasons).toEqual(["No relevant memories were recalled."])
    expect(decision.fallback).toEqual({
      memorySearches: 1,
      sourceChecks: 1,
      stopPolicy: "answer_with_gaps",
    })
  })

  test("marks recalled context with missing facts as partial", () => {
    const decision = decideMemoryGateway({
      recalled: [memory()],
      missingItems: ["No release memory found."],
    })

    expect(decision.status).toBe("partial")
    expect(decision.recalledCount).toBe(1)
    expect(decision.reasons).toEqual(["No release memory found."])
    expect(decision.fallback.stopPolicy).toBe("verify_source")
    expect(decision.fallback.memorySearches).toBe(1)
  })

  test("prioritizes conflicts over missing items", () => {
    const decision = decideMemoryGateway({
      recalled: [memory()],
      missingItems: ["No latest command memory found."],
      conflictReasons: ["Memory and current package scripts disagree."],
    })

    expect(decision.status).toBe("conflicting")
    expect(decision.reasons).toEqual(["Memory and current package scripts disagree."])
    expect(decision.fallback).toEqual({
      memorySearches: 0,
      sourceChecks: 2,
      stopPolicy: "verify_source",
    })
  })

  test("marks directly relevant recalled memory as sufficient", () => {
    const decision = decideMemoryGateway({ recalled: [memory()] })

    expect(decision.status).toBe("sufficient")
    expect(decision.recalledCount).toBe(1)
    expect(decision.fallback.stopPolicy).toBe("answer_from_memory")
  })
})

describe("formatMemoryGatewayBrief", () => {
  test("formats status, fallback, and reasons for adapter prompts", () => {
    const brief = formatMemoryGatewayBrief(
      decideMemoryGateway({
        recalled: [memory()],
        sourceFreshnessReasons: ["Memory is older than the changed file."],
      }),
    )

    expect(brief).toContain("## Memory Gateway")
    expect(brief).toContain("Status: partial")
    expect(brief).toContain("Fallback: verify_source; memory searches 0; source checks 1")
    expect(brief).toContain("- Memory is older than the changed file.")
  })
})

describe("stripSessionOwnedToolFields", () => {
  test("removes session-owned fields from tool params", () => {
    const params = {
      sessionKey: "session",
      namespace: "project",
      cwd: "/repo",
      query: "build command",
      limit: 3,
    }

    expect(stripSessionOwnedToolFields(params)).toEqual({
      query: "build command",
      limit: 3,
    })
  })
})
