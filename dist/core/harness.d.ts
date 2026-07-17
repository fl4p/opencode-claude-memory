export declare const HARNESS_FEEDBACK_CATEGORIES: readonly ["tool-efficiency", "agent-behavior", "skill-design", "harness-config", "other"];
export type HarnessFeedbackCategory = (typeof HARNESS_FEEDBACK_CATEGORIES)[number];
export declare const HARNESS_FEEDBACK_FILE = "harness-feedback.md";
export declare function getHarnessFeedbackPath(worktree: string): string;
export declare function saveHarnessFeedback(worktree: string, title: string, category: HarnessFeedbackCategory, body: string, originSessionId?: string): string;
