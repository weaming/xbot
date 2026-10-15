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
    /** 输入侧 token 的本地估算：仅当上游不给输入 token 时提供，用于状态栏上下文占用兜底。 */
    estimatedPromptTokens?: number;
    durationMs: number;
    /** 聚合多个 provider 请求时使用；单次请求可省略。 */
    requestCount?: number;
    /** 聚合 usage 中最后一次请求的 prompt token 数。 */
    latestPromptTokens?: number;
}
