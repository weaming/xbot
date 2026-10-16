import type { UsageInfo } from "../types/chat.js";

/**
 * UI 事件（流式，瞬态）：agent 运行时的实时事件流，驱动 UI 打字机渲染。
 * 不持久化；持久化事实源见 agent-events.ts。
 */

/** 无用量信息时的空值（迁移/失败事件用）。 */
export function emptyUsage(): UsageInfo {
    return {
        model: "",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: 0,
        requestCount: 0,
        latestPromptTokens: 0,
    };
}

/** 合并同一操作内多个 provider 请求的 usage。 */
export function mergeUsage(total: UsageInfo, usage: UsageInfo): UsageInfo {
    const latestPromptTokens = usage.latestPromptTokens ?? usage.promptTokens;
    // 输出估算只在累计型上游出现，普通上游缺省为 undefined，不参与合并
    const outputTokens = (total.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    // 输入估算取最新一次请求（上下文随轮次增长，旧值偏小没有意义）
    const estimatedPromptTokens = usage.estimatedPromptTokens ?? total.estimatedPromptTokens;
    return {
        model: usage.model || total.model,
        apiHost: usage.apiHost ?? total.apiHost,
        promptTokens: total.promptTokens + usage.promptTokens,
        cacheHitTokens: (total.cacheHitTokens ?? 0) + (usage.cacheHitTokens ?? 0),
        cacheMissTokens: (total.cacheMissTokens ?? 0) + (usage.cacheMissTokens ?? 0),
        completionTokens: total.completionTokens + usage.completionTokens,
        reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        totalTokens: total.totalTokens + usage.totalTokens,
        ...(outputTokens > 0 ? { outputTokens } : {}),
        ...(estimatedPromptTokens ? { estimatedPromptTokens } : {}),
        durationMs: total.durationMs + usage.durationMs,
        requestCount: (total.requestCount ?? 0) + (usage.requestCount ?? 1),
        latestPromptTokens: latestPromptTokens > 0
            ? latestPromptTokens
            : (total.latestPromptTokens ?? 0),
    };
}

export type UIEvent =
    // 回合边界
    | { type: "turn_start"; iteration: number }
    | { type: "turn_end"; iteration: number }
    | { type: "progress"; message: string }
    // 流式增量（来自 OpenAI stream chunk 的 delta）
    | { type: "text_delta"; delta: string }
    | { type: "reasoning_delta"; delta: string }
    | { type: "toolcall_start"; index: number; id: string; name: string }
    | { type: "toolcall_args_delta"; index: number; delta: string }
    | { type: "toolcall_end"; index: number; id: string; name: string; argsJson: string }
    // 执行阶段（对应现有回调语义）
    | { type: "assistant_text_before_tools"; content: string }
    | { type: "tool_start"; toolId: number; callId: string; name: string; args: any; mode: "serial" | "parallel" }
    | { type: "tool_result"; toolId: number; callId: string; name: string; summary: string; isError: boolean; durationMs: number }
    // 收尾
    | { type: "usage"; usage: UsageInfo }
    | { type: "message_end"; content: string; stopReason: string; usage?: UsageInfo; reasoning?: string }
    | { type: "error"; message: string }
    /**
     * 回合被中止：stopReason 与持久化侧 turn_commit.stopReason 同口径，
     * "aborted" 为用户主动中止，其余（缺省视为进程级中断）为「中断」。
     * 缺省是为了兼容旧发射点，届时按中断处理。
     */
    | { type: "aborted"; stopReason?: string }
    // 会话间消息（瞬态推送；事实源见 agent-events.peer_message）
    | {
        type: "peer_message";
        direction: "in" | "out";
        msgId: string;
        peerId: string;
        peerTitle?: string;
        text: string;
        expectResult?: boolean;
        replyTo?: string;
        createdAt: string;
    }
    /** 会话间结果：到达（lost=false）或确定丢失（lost=true）。 */
    | { type: "peer_result"; msgId: string; peerId: string; ok: boolean; lost?: boolean; text: string; stopReason?: string };
