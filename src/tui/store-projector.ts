/**
 * 渲染事件流投影：把单条 UIEvent 折叠进会话 UI 状态。
 * 不持有状态，id 分配与通知通过 ProjectionDeps 回传，便于脱离 TUI 单测。
 */

import type { UIEvent } from "../events/ui-events.js";
import { isCancelledStopReason } from "../control/protocol.js";
import type { UsageInfo } from "../types/chat.js";
import type { PeerMeta, SessionUiState, ToolBlock, UiMessage } from "./store-types.js";
import {
    abortMarkText,
    appendTimelineText,
    createMessage,
    insertMessage,
    composeAbortText,
    interruptLabel,
    sortTimelineToolBlocks,
    syncTimelineFinalReasoning,
    syncTimelineFinalText,
} from "./store-message.js";
import { addTokenUsage } from "./store-usage.js";

export interface ProjectionDeps {
    /** 消息 id 自增分配（与 ChatStore 单实例序号一致）。 */
    nextMessageId: () => number;
    /** 工具块 id 自增分配。 */
    nextBlockId: () => number;
    /** 当前会话可见时通知渲染层；后台会话事件不应触发重绘。 */
    notifyMessages: () => void;
    /** 通知状态栏刷新（token / 速率）。 */
    notifyStatus: () => void;
    /** 单次 usage 的费用计算器（元）；缺省不计费。 */
    costFor?: (usage: UsageInfo, atMs: number) => number;
}

/** 新请求开始：同一请求内复用同一条 assistant 消息（工具循环多轮合并）。 */
function startAssistantTurn(state: SessionUiState, requestId: number, deps: ProjectionDeps): void {
    if (state.activeRequestId !== requestId || state.activeAssistantId === null) {
        state.activeRequestId = requestId;
        const message = createMessage(deps.nextMessageId, { role: "assistant", text: "", streaming: true });
        message.timeline = [];
        state.messages.push(message);
        state.activeAssistantId = message.id;
        state.activeAssistant = message;
        deps.notifyMessages();
    }
}

/** 取当前 assistant 消息，不存在则按需开启新回合。 */
function requireAssistant(state: SessionUiState, requestId: number, deps: ProjectionDeps): UiMessage {
    startAssistantTurn(state, requestId, deps);
    const assistant = state.activeAssistant;
    if (!assistant) {
        throw new Error("assistant 消息不存在");
    }
    return assistant;
}

/** 推进流式消息排序键：块内最后一条内容的时间，因此恒为当前最大值、永远排在末尾。 */
function touchAssistant(assistant: UiMessage): void {
    assistant.sortKey = Date.now();
}

function resetActiveTurn(state: SessionUiState): void {
    state.activeRequestId = null;
    state.activeAssistantId = null;
    state.activeAssistant = undefined;
    state.activeChatAnchor = undefined;
    state.iterationStartIndex = undefined;
}

/** 把单条渲染事件投影进 state。 */
/**
 * 插入一条会话间消息/结果：回合执行中插进当前助手气泡的段位，
 * 空闲时作为独立消息落进时间线（与群消息同一套段位语义）。
 */
function insertPeerEntry(state: SessionUiState, text: string, peer: PeerMeta, deps: ProjectionDeps): void {
    const assistant = state.activeAssistant;
    if (assistant?.timeline) {
        const anchor = Math.min(state.activeChatAnchor ?? assistant.timeline.length, assistant.timeline.length);
        assistant.timeline.splice(anchor, 0, { type: "peer", text, peer });
        state.activeChatAnchor = anchor + 1;
        deps.notifyMessages();
        return;
    }

    const message = createMessage(deps.nextMessageId, { role: "system", text });
    message.peer = peer;
    insertMessage(state.messages, message);
    deps.notifyMessages();
}

export function applyAgentEvent(
    state: SessionUiState,
    requestId: number,
    event: UIEvent,
    deps: ProjectionDeps,
): void {
    switch (event.type) {
        case "progress":
            break;
        case "peer_message":
            insertPeerEntry(state, event.text, {
                direction: event.direction,
                msgId: event.msgId,
                peerId: event.peerId,
                ...(event.peerTitle ? { peerTitle: event.peerTitle } : {}),
                ...(event.expectResult ? { expectResult: true } : {}),
            }, deps);
            break;
        case "peer_result":
            insertPeerEntry(state, event.text, {
                direction: "in",
                msgId: event.msgId,
                peerId: event.peerId,
                isResult: true,
                ok: event.ok,
                ...(event.lost ? { lost: true } : {}),
                ...(event.late ? { late: true } : {}),
                ...(isCancelledStopReason(event.stopReason) ? { cancelled: true } : {}),
            }, deps);
            break;
        case "turn_start":
            startAssistantTurn(state, requestId, deps);
            // 本轮迭代的起点：message_end 的最终值只属于这一轮，对账时以此为边界。
            state.iterationStartIndex = state.activeAssistant?.timeline?.length ?? 0;
            // 每次请求（含工具循环的后续轮次）重置阶段计时，用于速率切分
            state.requestStartedAt = Date.now();
            state.firstReasoningAt = undefined;
            state.firstTextAt = undefined;
            break;
        case "steer_update": {
            if (event.phase === "accepted" || event.phase === "failed") break;
            const assistant = requireAssistant(state, requestId, deps);
            const timeline = assistant.timeline ??= [];
            const ownText = timeline.slice(state.iterationStartIndex ?? 0)
                .filter(item => item.type === "text");
            if (ownText.length > 0) {
                ownText[0]!.text = event.text ?? ownText.map(item => item.text).join("");
                for (const item of ownText.slice(1)) item.text = "";
            } else if (event.text) {
                timeline.push({ type: "text", text: event.text });
            }
            timeline.push({ type: "steer_status", responseId: event.responseId, phase: event.phase });
            state.iterationStartIndex = timeline.length;
            state.activeChatAnchor = timeline.length;
            touchAssistant(assistant);
            deps.notifyMessages();
            break;
        }
        case "text_delta":
            {
                if (state.firstTextAt === undefined) state.firstTextAt = Date.now();
                const assistant = requireAssistant(state, requestId, deps);
                assistant.text += event.delta;
                appendTimelineText(assistant, "text", event.delta);
                touchAssistant(assistant);
                // 当前文本段是开放段：此后到达的群消息插到它之前
                state.activeChatAnchor = Math.max(0, (assistant.timeline?.length ?? 0) - 1);
            }
            deps.notifyMessages();
            break;
        case "reasoning_delta":
            {
                if (state.firstReasoningAt === undefined) state.firstReasoningAt = Date.now();
                const assistant = requireAssistant(state, requestId, deps);
                assistant.reasoning = (assistant.reasoning ?? "") + event.delta;
                appendTimelineText(assistant, "reasoning", event.delta);
                touchAssistant(assistant);
                state.activeChatAnchor = Math.max(0, (assistant.timeline?.length ?? 0) - 1);
            }
            deps.notifyMessages();
            break;
        case "tool_start": {
            const assistant = state.activeAssistant;
            if (assistant) {
                assistant.toolBlocks ??= [];
                const block: ToolBlock = {
                    id: deps.nextBlockId(),
                    requestId,
                    toolId: event.toolId,
                    callId: event.callId,
                    name: event.name,
                    args: JSON.stringify(event.args),
                    expanded: false,
                    startedAt: Date.now(),
                };
                assistant.toolBlocks.push(block);
                assistant.timeline ??= [];
                assistant.timeline.push({ type: "tool", block });
                touchAssistant(assistant);
                // 工具块视为起始即完成：此后到达的群消息排在它之后
                state.activeChatAnchor = assistant.timeline.length;
            }
            deps.notifyMessages();
            break;
        }
        case "tool_result": {
            const assistant = state.activeAssistant;
            // 优先按稳定 callId 配对；缺 callId（旧事件）时回退 requestId + toolId。
            const block = assistant?.toolBlocks?.find(
                item => (item.callId && item.callId === event.callId)
                    || (!item.callId && item.requestId === requestId && item.toolId === event.toolId),
            );
            if (block) {
                block.result = event.summary;
                block.isError = event.isError;
                block.durationMs = event.durationMs;
                block.cancelled = false;
            }
            if (assistant) {
                touchAssistant(assistant);
                state.activeChatAnchor = assistant.timeline?.length ?? 0;
            }
            deps.notifyMessages();
            break;
        }
        case "citations": {
            // 来源清单落在消息末尾：重试或后续轮次重复下发时覆盖最后一条，不重复堆叠
            const assistant = requireAssistant(state, requestId, deps);
            const timeline = assistant.timeline ??= [];
            if (timeline[timeline.length - 1]?.type === "sources") {
                timeline[timeline.length - 1] = { type: "sources", items: event.items };
            } else {
                timeline.push({ type: "sources", items: event.items });
            }
            touchAssistant(assistant);
            deps.notifyMessages();
            break;
        }
        case "message_end": {
            const assistant = state.activeAssistant;
            if (assistant) {
                assistant.streaming = false;
                // text 保留最终 assistant 回复，timeline 保留整个 turn 的时间线。
                assistant.text = event.content;
                // reasoning 同理取最终值（event.reasoning 是整回合累计值，reasoning_delta 只是流式增量）。
                assistant.reasoning = event.reasoning ?? assistant.reasoning;
                // 流式增量与最终值对账：只校正**本轮迭代**的段，避免最终回复被搬到工具调用之前的段里。
                syncTimelineFinalText(assistant, event.content, state.iterationStartIndex ?? 0);
                syncTimelineFinalReasoning(assistant, event.reasoning, state.iterationStartIndex ?? 0);
                // 工具块按 toolId 稳定排序，与重放侧（tool_calls 数组序）对齐。
                sortTimelineToolBlocks(assistant);
                touchAssistant(assistant);
            }
            resetActiveTurn(state);
            deps.notifyMessages();
            break;
        }
        case "aborted": {
            const assistant = state.activeAssistant;
            if (assistant) {
                // 执行中被中止的工具没有结果事件：按其起始时刻结算已运行时间并标为取消
                for (const block of assistant.toolBlocks ?? []) {
                    if (block.result !== undefined || block.cancelled) continue;
                    block.cancelled = true;
                    if (block.startedAt !== undefined) block.durationMs = Date.now() - block.startedAt;
                }
                // 与重放侧同源：按 stopReason 选措辞、按 composeAbortText 拼接，
                // 避免同一回合中止后实时与重放屏幕上换词或多空行。缺省按中断处理。
                const label = interruptLabel(event.stopReason);
                const hasText = Boolean(assistant.text);
                assistant.text = composeAbortText(assistant.text, label);
                assistant.streaming = false;
                // timeline 只追加标记段（有正文时带前导空行），正文段已在流式中累积；
                // 与重放侧 buildHistoryTimeline 的 interruptMark 追加口径一致。
                appendTimelineText(assistant, "text", abortMarkText(hasText, label));
                touchAssistant(assistant);
            }
            resetActiveTurn(state);
            deps.notifyMessages();
            break;
        }
        case "error": {
            const assistant = state.activeAssistant;
            if (assistant) {
                assistant.streaming = false;
                touchAssistant(assistant);
            }
            insertMessage(
                state.messages,
                createMessage(deps.nextMessageId, { role: "system", text: `⚠️ ${event.message}` }),
            );
            resetActiveTurn(state);
            deps.notifyMessages();
            break;
        }
        case "usage":
            addTokenUsage(state, event.usage, Date.now(), deps.costFor);
            deps.notifyStatus();
            break;
        case "turn_end":
        case "toolcall_start":
        case "toolcall_args_delta":
        case "toolcall_end":
            break;
        case "assistant_text_before_tools":
            // 工具调用前的正文段到此结束。这里**不改**时间线文本：段与段之间的分隔由渲染层用
            // Spacer 负责，往段尾追加空行只会让实时渲染比重放（切会话/重启后）多出空白行。
            // 也不推进 activeChatAnchor：该段的 turn_segment_start 起点在它之前，
            // 重放会把群消息同样落在它之前。
            break;
    }
}
