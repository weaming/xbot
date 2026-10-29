/**
 * 会话摘要与实例用量聚合：纯函数，不依赖 agent 实例状态。
 */

import { isInjectedContext, type AgentEvent } from "../events/agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { InstanceNetworkStats, SessionSummary } from "./session-host-types.js";

/** 由事件流派生会话摘要（标题、消息数、归档态、更新时间）。 */
export function summarizeEvents(sessionId: string, events: AgentEvent[]): SessionSummary {
    let messageCount = 0;
    let lastUserMessage: string | undefined;
    let firstUserMessage: string | undefined;
    let renamedTitle: string | undefined;
    let updatedAt: string | undefined;
    let archived = false;
    let modelSelection: SessionSummary["modelSelection"];
    let cwd: string | undefined;

    for (const event of events) {
        // 更新时间只认用户/模型活动：群聊状态这类自动注入每隔几分钟落一条，
        // 若计入就会把闲置会话顶到 tab 条最前，启动默认选中的会话也跟着跑偏。
        // 只改下发口径的事件（lazy MCP 启用集）不算活动：切换一下就把闲置会话顶到最前没有意义。
        if (!isInjectedContext(event) && event.type !== "lazy_mcp_changed") updatedAt = event.ts;
        // 归档与取消归档成对出现，末态决定会话是否归档。
        if (event.type === "session_archived") archived = true;
        else if (event.type === "session_unarchived") archived = false;
        if (event.type === "turn_commit" && !event.payload.interrupted) messageCount += 1;
        if (event.type === "user_message") {
            lastUserMessage = event.payload.text.slice(0, 120);
            firstUserMessage ??= event.payload.text.slice(0, 200);
        }
        if (event.type === "session_renamed") renamedTitle = event.payload.title;
        if (event.type === "model_selected") modelSelection = event.payload;
        if (event.type === "session_created") cwd = event.payload.cwd;
        if (event.type === "session_cwd_changed") cwd = event.payload.cwd;
    }

    return {
        sessionId,
        ...(cwd ? { cwd } : {}),
        updatedAt,
        messageCount,
        lastUserMessage,
        title: renamedTitle ?? firstUserMessage,
        archived,
        ...(modelSelection ? { modelSelection } : {}),
    };
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
