export type JobState =
    | "queued"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "lost"
    | "interfered";

export interface JobInput {
    prompt: string;
    workspace: string;
    title?: string;
    description?: string;
    labels?: string[];
    dueAt?: string;
    meta?: Record<string, string>;
    model?: string;
    /** 空数组 = 不用任何 MCP；undefined = 不限制 */
    mcpServers?: string[];
    priority?: number;
    timeoutSec?: number;
    freshSession?: boolean;
    maxAttempts?: number;
    autoStart?: boolean;
    archivedAt?: string;
}

export interface JobResult {
    text: string;
    aborted: boolean;
    eventSeq: number;
}

export interface Job {
    id: string;
    source: string;
    idempotencyKey?: string;
    input: JobInput;
    state: JobState;
    priority: number;
    sessionId?: string;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    result?: JobResult;
    error?: string;
    retriedFrom?: string;
}

export interface JobComment {
    id: string;
    jobId: string;
    sessionId?: string;
    author: "user" | "agent";
    authorName?: string;
    body: string;
    createdAt: string;
    editedAt?: string;
    deletedAt?: string;
}

export interface JobSession {
    jobId: string;
    sessionId: string;
    purpose: "run" | "branch";
    attempt: number;
    createdAt: string;
}

export interface McpServer {
    name: string;
    toolCount: number;
}

/** 会话事件：只用到消息类，其余按类型丢弃。 */
export interface AgentEvent {
    seq: number;
    ts: string;
    sessionId: string;
    type: string;
    payload: {
        text?: string;
        /** user_message 的来源：user=本人输入，pending=回合中补发，peer=别的会话 */
        trigger?: "user" | "pending" | "peer";
        images?: Array<{ id: string; path: string; filename: string; mimeType: string }>;
        message?: {
            role: string;
            content?: string | null;
            /** 思考内容：界面只显示「思考中」，不把推理过程铺开 */
            reasoning_content?: string | null;
            tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }>;
            tool_call_id?: string;
        };
        direction?: "in" | "out";
        peerId?: string;
        peerTitle?: string;
        ok?: boolean;
    };
}

export type BoardColumnKey = "todo" | "manual" | "doing" | "review" | "done" | "cancelled";

/** 落盘后的图片引用（发送消息时带上）。 */
export interface ImageAsset {
    id: string;
    path: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
}
