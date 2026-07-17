export type BuildMemorySystemPromptOptions = {
    includeIndex?: boolean;
};
export declare function buildMemorySystemPrompt(worktree: string, recalledMemoriesSection?: string, options?: BuildMemorySystemPromptOptions): string;
export declare function countIndexLines(indexContent: string): number;
export declare function buildIndexLimitWarning(indexContent: string): string | undefined;
