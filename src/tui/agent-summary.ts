/**
 * 会话摘要与实例用量聚合：纯函数，不依赖 agent 实例状态。
 */

import type { AgentEvent } from "../events/agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { InstanceNetworkStats, TuiSessionSummary } from "./agent-types.js";

/**
 * 是否为自动注入的上下文事件（群聊状态更新等）：不算用户活动，不参与会话更新时间。
 * 兜底识别旧事件（injected 标记落地前写下的）：注入内容恒为一条以 "[群聊状态更新" 开头的 system 消息。
 */
function isInjectedContext(event: AgentEvent): boolean {
    if (event.type !== "standalone_turn") return false;
    if (event.payload.injected === true) return true;

    const messages = event.payload.messages ?? [];
    return messages.length > 0
        && messages.every(message => message.role === "system"
            && typeof message.content === "string"
            && message.content.startsWith("[群聊状态更新"));
}

/** 由事件流派生会话摘要（标题、消息数、归档态、更新时间）。 */
export function summarizeEvents(sessionId: string, events: AgentEvent[]): TuiSessionSummary {
    let messageCount = 0;
    let lastUserMessage: string | undefined;
    let firstUserMessage: string | undefined;
    let renamedTitle: string | undefined;
    let updatedAt: string | undefined;
    let archived = false;

    for (const event of events) {
        // 更新时间只认用户/模型活动：群聊状态这类自动注入每隔几分钟落一条，
        // 若计入就会把闲置会话顶到 tab 条最前，启动默认选中的会话也跟着跑偏。
        if (!isInjectedContext(event)) updatedAt = event.ts;
        // 归档与取消归档成对出现，末态决定会话是否归档。
        if (event.type === "session_archived") archived = true;
        else if (event.type === "session_unarchived") archived = false;
        if (event.type === "turn_commit" && !event.payload.interrupted) messageCount += 1;
        if (event.type === "user_message") {
            lastUserMessage = event.payload.text.slice(0, 120);
            firstUserMessage ??= event.payload.text.slice(0, 200);
        }
        if (event.type === "session_renamed") renamedTitle = event.payload.title;
    }

    return { sessionId, updatedAt, messageCount, lastUserMessage, title: renamedTitle ?? firstUserMessage, archived };
}

/** 聚合各会话的真实网络用量；未发起过请求的会话不计入。 */
export function aggregateInstanceUsage(usageBySession: Iterable<UsageInfo>): InstanceNetworkStats {
    let sessionCount = 0;
    let requestCount = 0;
    let promptTokens = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    for (const usage of usageBySession) {
        if (!usage.requestCount) continue;
        sessionCount += 1;
        requestCount += usage.requestCount;
        promptTokens += usage.promptTokens;
        cacheHitTokens += usage.cacheHitTokens ?? 0;
        cacheMissTokens += usage.cacheMissTokens ?? 0;
        completionTokens += usage.completionTokens;
        reasoningTokens += usage.reasoningTokens ?? 0;
    }
    return {
        sessionCount,
        requestCount,
        promptTokens,
        completionTokens,
        reasoningTokens,
        cacheHitTokens,
        cacheMissTokens,
    };
}
