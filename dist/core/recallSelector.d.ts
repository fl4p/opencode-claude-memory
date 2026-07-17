import { type MemoryHeader } from "./memoryScan.js";
export declare const SELECT_MEMORIES_SYSTEM_PROMPT = "You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.\n\nReturn a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.\n- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.\n- If there are no memories in the list that would clearly be useful, feel free to return an empty list.\n- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools \u2014 active use is exactly when those matter.\n";
export declare const UNSUPPORTED_RECALL_SELECTOR_CLIENT_MESSAGE = "opencode-claude-memory LLM recall requires an OpenCode SDK session client with create/prompt/delete support.";
export type SessionClient = {
    session?: {
        create?: (...args: unknown[]) => Promise<unknown>;
        prompt?: (...args: unknown[]) => Promise<unknown>;
        delete?: (...args: unknown[]) => Promise<unknown>;
    };
};
export type SelectRelevantMemoryFilenamesInput = {
    client: SessionClient | undefined;
    directory: string;
    parentSessionID: string;
    query: string;
    memories: MemoryHeader[];
    recentTools: readonly string[];
    selectorSessionIDs: Set<string>;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
};
export declare function isSupportedRecallSelectorClient(client: SessionClient | undefined): boolean;
export declare function assertSupportedRecallSelectorClient(client: SessionClient | undefined): asserts client is SessionClient;
export declare function selectRelevantMemoryFilenames(input: SelectRelevantMemoryFilenamesInput): Promise<string[]>;
