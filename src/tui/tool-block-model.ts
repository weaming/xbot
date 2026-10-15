/**
 * 工具块数据模型：折叠态/展开态块、todo 快照、文件变更 diff、提问问答。
 * 解析层与渲染层共用这些类型，避免两者互相依赖。
 */

/** 折叠态/展开态工具块的最小输入。 */
export interface CollapsedToolBlock {
    name: string;
    args?: string;
    result?: string;
    isError?: boolean;
}

/** 单个文件的变更摘要。 */
export interface EditFileDiff {
    path: string;
    oldPath?: string;
    action?: "edit" | "write" | "delete";
    additions: number;
    removals: number;
    lines: EditFileDiffLine[];
}

/** 变更中的单行 diff。 */
export interface EditFileDiffLine {
    type: "context" | "added" | "removed";
    lineNumber: number;
    text: string;
}

/** 提问块的单道题干（选项不参与事件流展示，解析时不需要保留）。 */
export interface AskUserPrompt {
    header: string;
    question: string;
    multiSelect: boolean;
}

/** 一道题的问答：题干 + 用户选择。 */
export interface AskUserQA extends AskUserPrompt {
    /** 用户选中的选项 label（未作答为空）。 */
    selected: string[];
    /** 「其他（自己输入）」的内容。 */
    custom?: string;
}

/** 一次提问在事件流里的展示数据。 */
export interface AskUserDigest {
    questions: AskUserQA[];
    /** pending = 还在等作答；answered = 用户已作答；cancelled = 用户取消，整次不作答。 */
    state: "pending" | "answered" | "cancelled";
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
