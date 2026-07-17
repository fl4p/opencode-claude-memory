import type { RecalledMemory } from "./recall.js";
export type MemoryContextDeliveryMode = "system-prompt" | "hidden-message";
export type MemoryGatewayStatus = "sufficient" | "partial" | "insufficient" | "conflicting";
export type MemoryGatewayFallback = {
    memorySearches: number;
    sourceChecks: number;
    stopPolicy: "answer_from_memory" | "answer_with_gaps" | "verify_source";
};
export type MemoryGatewayDecision = {
    status: MemoryGatewayStatus;
    recalledCount: number;
    reasons: string[];
    fallback: MemoryGatewayFallback;
};
export type MemoryGatewayInput = {
    recalled: readonly RecalledMemory[];
    missingItems?: readonly string[];
    conflictReasons?: readonly string[];
    sourceFreshnessReasons?: readonly string[];
};
export declare const SESSION_OWNED_TOOL_FIELDS: readonly ["sessionKey", "namespace", "cwd"];
export type SessionOwnedToolField = (typeof SESSION_OWNED_TOOL_FIELDS)[number];
export declare function decideMemoryGateway(input: MemoryGatewayInput): MemoryGatewayDecision;
export declare function formatMemoryGatewayBrief(decision: MemoryGatewayDecision): string;
export declare function stripSessionOwnedToolFields<T extends Record<string, unknown>>(params: T, fields?: readonly string[]): Omit<T, SessionOwnedToolField>;
