/**
 * 续跑点推断：`/continue` 从会话最后一个回合的消息尾部决定怎么接上。
 *  - 有 assistant tool_calls 缺 tool 结果 → 补跑这些工具
 *  - 尾部是完整工具结果 → 直接发下一次请求（上游看到的请求与中断前一致）
 *  - 失败回合尾部是用户消息或部分助手文本 → 直接重试请求
 *  - 已完成回合尾部是普通 assistant 文本/空回合 → 没有可续跑点
 */

import { fromOpenAIToolCalls, type ToolCall } from "../types/tool-call.js";
import type { ChatMessage, Session } from "../types/session.js";

export interface ResumePlan {
    /** 需要补跑的工具调用（args 已反解析；解析失败的调用不在内，由历史修复兜底）。 */
    toolCalls: ToolCall[];
    /** 是否可以续跑（补跑工具或直接发请求）。 */
    canResume: boolean;
    /** 不可续跑时的原因，供 UI 提示。 */
    reason?: string;
}

export function planResume(session: Pick<Session, "turns">): ResumePlan {
    const lastTurn = session.turns.at(-1);
    if (!lastTurn) {
        return { toolCalls: [], canResume: false, reason: "没有可继续的上下文" };
    }
    const messages = lastTurn.messages;
    if (messages.length === 0) {
        return { toolCalls: [], canResume: false, reason: "没有可继续的上下文" };
    }

    const last = messages[messages.length - 1];
    const isFailed = lastTurn.status === "failed";
    const hasToolCalls = readToolCalls(last).length > 0;
    if (isFailed && (last.role === "user" || last.role === "assistant" && !hasToolCalls)) {
        return { toolCalls: [], canResume: true };
    }
    if (!hasToolCalls && last.role !== "tool") {
        return { toolCalls: [], canResume: false, reason: "上一轮已结束，没有未完成的动作" };
    }

    // 从尾部往回找最近的 assistant(tool_calls)：缺结果的调用都挂在它下面
    let anchorIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (readToolCalls(messages[index]).length > 0) {
            anchorIndex = index;
            break;
        }
    }
    if (anchorIndex < 0) {
        return { toolCalls: [], canResume: false, reason: "没有未完成的工具调用" };
    }

    const answered = new Set<string>();
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === "tool") answered.add(message.tool_call_id);
    }

    const toolCalls = readToolCalls(messages[anchorIndex])
        .filter(call => !answered.has(call.id) && call.args !== undefined);

    // 缺结果 → 补跑；结果齐全 → 直接发请求
    return { toolCalls, canResume: true };
}

function readToolCalls(message: ChatMessage | undefined): ToolCall[] {
    return fromOpenAIToolCalls((message as { tool_calls?: unknown } | undefined)?.tool_calls);
}
