export const SESSION_OWNED_TOOL_FIELDS = ["sessionKey", "namespace", "cwd"];
// Adapter-neutral version of the useful "Memory Gateway" idea: the adapter can
// decide whether recalled memory is enough, partial, absent, or conflicting
// before the provider call. This only formats guidance; repo/source evidence
// remains authoritative.
export function decideMemoryGateway(input) {
    const recalledCount = input.recalled.length;
    const missingItems = [...(input.missingItems ?? [])].filter(Boolean);
    const conflictReasons = [...(input.conflictReasons ?? [])].filter(Boolean);
    const sourceFreshnessReasons = [...(input.sourceFreshnessReasons ?? [])].filter(Boolean);
    if (conflictReasons.length > 0) {
        return {
            status: "conflicting",
            recalledCount,
            reasons: conflictReasons,
            fallback: { memorySearches: 0, sourceChecks: 2, stopPolicy: "verify_source" },
        };
    }
    if (recalledCount === 0) {
        return {
            status: "insufficient",
            recalledCount,
            reasons: ["No relevant memories were recalled."],
            fallback: { memorySearches: 1, sourceChecks: 1, stopPolicy: "answer_with_gaps" },
        };
    }
    if (missingItems.length > 0 || sourceFreshnessReasons.length > 0) {
        return {
            status: "partial",
            recalledCount,
            reasons: [...missingItems, ...sourceFreshnessReasons],
            fallback: { memorySearches: missingItems.length > 0 ? 1 : 0, sourceChecks: 1, stopPolicy: "verify_source" },
        };
    }
    return {
        status: "sufficient",
        recalledCount,
        reasons: ["Recalled memory appears directly relevant."],
        fallback: { memorySearches: 0, sourceChecks: 0, stopPolicy: "answer_from_memory" },
    };
}
export function formatMemoryGatewayBrief(decision) {
    const lines = [
        "## Memory Gateway",
        "",
        `Status: ${decision.status}`,
        `Recalled memories: ${decision.recalledCount}`,
        `Fallback: ${decision.fallback.stopPolicy}; memory searches ${decision.fallback.memorySearches}; source checks ${decision.fallback.sourceChecks}`,
    ];
    if (decision.reasons.length > 0) {
        lines.push("", "Reasons:");
        for (const reason of decision.reasons)
            lines.push(`- ${reason}`);
    }
    return lines.join("\n");
}
export function stripSessionOwnedToolFields(params, fields = SESSION_OWNED_TOOL_FIELDS) {
    const owned = new Set(fields);
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        if (!owned.has(key))
            out[key] = value;
    }
    return out;
}
