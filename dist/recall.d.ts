import type { MemoryHeader } from "./memoryScan.js";
export type RecalledMemory = {
    fileName: string;
    filePath: string;
    name: string;
    type: string;
    description: string;
    content: string;
    ageInDays: number;
};
export declare function recallSelectedMemories(headers: readonly MemoryHeader[], selectedFilenames: readonly string[], alreadySurfaced?: ReadonlySet<string>): RecalledMemory[];
export declare function formatRecalledMemories(memories: RecalledMemory[]): string;
