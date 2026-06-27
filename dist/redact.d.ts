export declare function redactSecrets(text: string): {
    text: string;
    count: number;
};
export declare function scrubMemoryFields(fields: {
    name: string;
    description: string;
    content: string;
}): {
    name: string;
    description: string;
    content: string;
    count: number;
};
