/** LLM 调用契约类型（与具体 provider/事件通道无关）。 */

/** 一次 provider 请求的用量；聚合多个请求时用 requestCount/latestPromptTokens。 */
export interface UsageInfo {
    model: string;
    /** 落盘时的 provider 端点 host（如 api.deepseek.com）；回放历史时按「当时端点」判定是否官方计费，旧记录缺失则回退当前配置。 */
    apiHost?: string;
    promptTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    completionTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
    /**
     * 本次生成的 token 估算：仅当上游不区分输入/输出（上报会话累计，如 llm-deepseek-web）时提供。
     * 这类上游的 completionTokens 是差分出的「本请求新增（含输入）」，用它算速率会偏高。
     */
    outputTokens?: number;
    durationMs: number;
    /** 聚合多个 provider 请求时使用；单次请求可省略。 */
    requestCount?: number;
    /** 聚合 usage 中最后一次请求由 provider 返回的 prompt token 数。 */
    latestPromptTokens?: number;
}

/** 一次流式响应片段；写盘成功后才展示，供异常退出时恢复最后的输出。 */
export interface StreamDelta {
    text?: string;
    reasoning?: string;
    toolCalls?: Array<{
        index: number;
        id?: string;
        name?: string;
        arguments?: string;
        thoughtSignature?: string;
    }>;
}

/** Responses steer 的展示事实；不作为模型输入。 */
export interface SteerUpdate {
    responseId: string;
    phase: "accepted" | "failed" | "completed" | "steered";
    text?: string;
    /** 云端等待客户端工具结果，下一条助手消息可能再次包含此段正文。 */
    isAwaitingToolInput?: boolean;
}
