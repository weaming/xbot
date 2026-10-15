/**
 * 实时投影 vs 重放投影 一致性差分测试。
 *
 * 目的：同一段回合事实，分别经
 *   - 重放路径 projectHistory（持久化 AgentEvent[] → 状态）
 *   - 实时路径 applyAgentEvent（瞬态 UIEvent → 状态）
 * 投影后，断言二者产出的 assistant 消息时间线在
 *   - tool 块顺序（按 toolId）
 *   - reasoning 文本
 * 上一致。
 *
 * 这是「按 toolId 排序 tool 块 + reasoning 对账」两项修复的回归护栏。
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import type { UIEvent } from "../events/ui-events.js";
import type { ChatMessage } from "../types/session.js";
import type { UsageInfo } from "../types/chat.js";
import { applyAgentEvent, type ProjectionDeps } from "./store-projector.js";
import { projectHistory } from "./store-history.js";
import { createSessionUiState, type AssistantTimelineItem, type SessionUiState } from "./store-types.js";

const TURN_ID = "turn-1";

function makeDeps(): ProjectionDeps {
    let messageId = 0;
    let blockId = 0;
    return {
        nextMessageId: () => ++messageId,
        nextBlockId: () => ++blockId,
        notifyMessages: () => {},
        notifyStatus: () => {},
    };
}

function emptyUsage(): UsageInfo {
    return {
        model: "test-model",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: 0,
    };
}

function event<T extends AgentEvent["type"]>(
    seq: number,
    type: T,
    payload: Extract<AgentEvent, { type: T }>["payload"],
): AgentEvent {
    return { type, seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), payload } as AgentEvent;
}

/** 取 assistant 消息时间线里的 tool 块 toolId 序列。 */
function toolIdsOf(state: SessionUiState): number[] {
    const assistant = state.messages.find(message => message.role === "assistant");
    return (assistant?.timeline ?? [])
        .filter((item): item is Extract<AssistantTimelineItem, { type: "tool" }> => item.type === "tool")
        .map(item => item.block.toolId);
}

function reasoningTextOf(state: SessionUiState): string | undefined {
    const assistant = state.messages.find(message => message.role === "assistant");
    return assistant?.reasoning;
}

/** 取 assistant 消息时间线的段序（文本/思考带内容，工具带 toolId）。 */
function segmentsOf(state: SessionUiState): string[] {
    const assistant = state.messages.find(message => message.role === "assistant");
    return (assistant?.timeline ?? []).map(item => {
        if (item.type === "text" || item.type === "reasoning") return `${item.type}:${item.text}`;
        if (item.type === "tool") return `tool:${item.block.toolId}`;
        return item.type;
    });
}

function textOf(state: SessionUiState): string | undefined {
    return state.messages.find(message => message.role === "assistant")?.text;
}

/**
 * 重放路径：一条 assistant 消息带两个 tool_calls（id 序 = 数组序），
 * 两条 tool 结果乱序落盘（先 call_2 后 call_1），验证重放不受落盘顺序影响。
 */
function replayEvents(): AgentEvent[] {
    const assistantWithTools: ChatMessage = {
        role: "assistant",
        content: "",
        reasoning_content: "思考完整内容",
        tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } },
            { id: "call_2", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"x\"}" } },
        ],
    } as ChatMessage;

    return [
        event(1, "user_message", { text: "开始", turnId: TURN_ID }),
        event(2, "turn_message", { turnId: TURN_ID, message: assistantWithTools }),
        // tool 结果乱序落盘：call_2 在前
        event(3, "turn_message", {
            turnId: TURN_ID,
            message: { role: "tool", tool_call_id: "call_2", name: "grep", content: "结果2" } as ChatMessage,
        }),
        event(4, "turn_message", {
            turnId: TURN_ID,
            message: { role: "tool", tool_call_id: "call_1", name: "read", content: "结果1" } as ChatMessage,
        }),
        event(5, "turn_commit", {
            turnId: TURN_ID,
            usage: emptyUsage(),
            events: [2, 3, 4],
            userMessages: ["开始"],
            stopReason: "stop",
            interrupted: false,
        }),
    ];
}

/**
 * 实时路径：等价事件流，但 tool_start 乱序到达（先 toolId=2 后 toolId=1，
 * 模拟并行分支下事件交错），验证 message_end 的排序修复把它拉回数组序。
 */
function liveEvents(): UIEvent[] {
    return [
        { type: "turn_start", iteration: 0 },
        { type: "reasoning_delta", delta: "思考" },
        { type: "reasoning_delta", delta: "完整内容" },
        // 乱序到达：2 先于 1
        { type: "tool_start", toolId: 2, callId: "call_2", name: "grep", args: { pattern: "x" }, mode: "parallel" },
        { type: "tool_start", toolId: 1, callId: "call_1", name: "read", args: { path: "a.ts" }, mode: "parallel" },
        { type: "tool_result", toolId: 2, callId: "call_2", name: "grep", summary: "结果2", isError: false, durationMs: 1 },
        { type: "tool_result", toolId: 1, callId: "call_1", name: "read", summary: "结果1", isError: false, durationMs: 1 },
        { type: "message_end", content: "", stopReason: "stop", reasoning: "思考完整内容" },
    ];
}

/**
 * 一条多轮工具循环的回合（第 1 轮：思考 + 说明文本 + 工具；第 2 轮：思考 + 最终回复）。
 * 重放侧：两条 assistant 消息 + 一条 tool 消息；实时侧：等价渲染事件流。
 */
function replayMultiIterationEvents(): AgentEvent[] {
    return [
        event(1, "user_message", { text: "开始", turnId: TURN_ID }),
        event(2, "turn_message", {
            turnId: TURN_ID,
            message: {
                role: "assistant",
                content: "我先看看",
                reasoning_content: "想A",
                tool_calls: [
                    { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } },
                ],
            } as ChatMessage,
        }),
        event(3, "turn_message", {
            turnId: TURN_ID,
            message: { role: "tool", tool_call_id: "call_1", name: "read", content: "结果1" } as ChatMessage,
        }),
        event(4, "turn_message", {
            turnId: TURN_ID,
            message: { role: "assistant", content: "最终回复", reasoning_content: "想B" } as ChatMessage,
        }),
        event(5, "turn_commit", {
            turnId: TURN_ID,
            usage: emptyUsage(),
            events: [2, 3, 4],
            userMessages: ["开始"],
            stopReason: "stop",
            interrupted: false,
        }),
    ];
}

function liveMultiIterationEvents(): UIEvent[] {
    return [
        { type: "turn_start", iteration: 0 },
        { type: "reasoning_delta", delta: "想A" },
        { type: "text_delta", delta: "我先看看" },
        { type: "assistant_text_before_tools", content: "我先看看" },
        { type: "tool_start", toolId: 1, callId: "call_1", name: "read", args: { path: "a.ts" }, mode: "serial" },
        { type: "tool_result", toolId: 1, callId: "call_1", name: "read", summary: "结果1", isError: false, durationMs: 1 },
        { type: "turn_start", iteration: 1 },
        { type: "reasoning_delta", delta: "想B" },
        { type: "text_delta", delta: "最终回复" },
        { type: "message_end", content: "最终回复", stopReason: "stop", reasoning: "想A想B" },
    ];
}

describe("实时 vs 重放 投影一致性", () => {
    test("tool 块顺序一致（按 toolId，不受到达/落盘顺序影响）", () => {
        const replayState = createSessionUiState();
        projectHistory(replayState, replayEvents(), makeDeps(), false);

        const liveState = createSessionUiState();
        const deps = makeDeps();
        for (const uiEvent of liveEvents()) {
            applyAgentEvent(liveState, 1, uiEvent, deps);
        }

        expect(toolIdsOf(liveState)).toEqual([1, 2]);
        expect(toolIdsOf(replayState)).toEqual([1, 2]);
        expect(toolIdsOf(liveState)).toEqual(toolIdsOf(replayState));
    });

    test("reasoning 文本一致（message_end 对账后与重放一致）", () => {
        const replayState = createSessionUiState();
        projectHistory(replayState, replayEvents(), makeDeps(), false);

        const liveState = createSessionUiState();
        const deps = makeDeps();
        for (const uiEvent of liveEvents()) {
            applyAgentEvent(liveState, 1, uiEvent, deps);
        }

        expect(reasoningTextOf(liveState)).toBe("思考完整内容");
        expect(reasoningTextOf(replayState)).toBe("思考完整内容");
        expect(reasoningTextOf(liveState)).toBe(reasoningTextOf(replayState));
    });

    test("工具结果按 callId 正确回填到对应块（不串块）", () => {
        const liveState = createSessionUiState();
        const deps = makeDeps();
        for (const uiEvent of liveEvents()) {
            applyAgentEvent(liveState, 1, uiEvent, deps);
        }

        const assistant = liveState.messages.find(message => message.role === "assistant");
        const blocks = (assistant?.timeline ?? [])
            .filter((item): item is Extract<AssistantTimelineItem, { type: "tool" }> => item.type === "tool")
            .map(item => item.block);

        const readBlock = blocks.find(block => block.toolId === 1);
        const grepBlock = blocks.find(block => block.toolId === 2);
        expect(readBlock?.name).toBe("read");
        expect(readBlock?.result).toBe("结果1");
        expect(grepBlock?.name).toBe("grep");
        expect(grepBlock?.result).toBe("结果2");
    });

    // 实测 bug（2026-09-10）：实时路径把最终回复对账到了整条时间线的第一个文本段，
    // 于是「最终回复」被搬到中间工具调用之前，与重放（切会话/重启后）的顺序不一致。
    test("多轮工具循环：段序与最终回复位置与重放一致", () => {
        const liveState = createSessionUiState();
        const deps = makeDeps();
        for (const uiEvent of liveMultiIterationEvents()) {
            applyAgentEvent(liveState, 1, uiEvent, deps);
        }
        const replayState = createSessionUiState();
        projectHistory(replayState, replayMultiIterationEvents(), makeDeps(), false);

        // 最终回复必须排在工具块之后，且实时与重放逐字一致（段序、正文、思考都对得上）
        expect(segmentsOf(liveState)).toEqual([
            "reasoning:想A",
            "text:我先看看",
            "tool:1",
            "reasoning:想B",
            "text:最终回复",
        ]);
        expect(segmentsOf(replayState)).toEqual([
            "reasoning:想A",
            "text:我先看看",
            "tool:1",
            "reasoning:想B",
            "text:最终回复",
        ]);
        expect(segmentsOf(liveState)).toEqual(segmentsOf(replayState));
        expect(textOf(liveState)).toBe("最终回复");
        expect(textOf(liveState)).toBe(textOf(replayState));
        expect(reasoningTextOf(liveState)).toBe("想A想B");
        expect(reasoningTextOf(liveState)).toBe(reasoningTextOf(replayState));
    });

    // 用户主动中止：实时（aborted 事件）与重放（turn_commit.interrupted + stopReason=aborted）
    // 的段与措辞必须一致，否则中止后切个会话/重启，屏幕上那句话就换了词。
    test("用户中止：实时与重放的收尾段逐字一致", () => {
        const liveState = createSessionUiState();
        const deps = makeDeps();
        applyAgentEvent(liveState, 1, { type: "turn_start", iteration: 0 }, deps);
        applyAgentEvent(liveState, 1, { type: "reasoning_delta", delta: "想一半" }, deps);
        applyAgentEvent(liveState, 1, { type: "text_delta", delta: "说到一半" }, deps);
        applyAgentEvent(liveState, 1, { type: "aborted", stopReason: "aborted" }, deps);

        const replayState = createSessionUiState();
        projectHistory(
            replayState,
            [
                event(1, "user_message", { text: "开始", turnId: TURN_ID }),
                event(2, "turn_message", {
                    turnId: TURN_ID,
                    message: { role: "assistant", content: "说到一半", reasoning_content: "想一半" } as ChatMessage,
                }),
                event(3, "turn_commit", {
                    turnId: TURN_ID,
                    usage: emptyUsage(),
                    events: [2],
                    userMessages: ["开始"],
                    stopReason: "aborted",
                    interrupted: true,
                }),
            ],
            makeDeps(),
            false,
        );

        expect(segmentsOf(liveState)).toEqual(["reasoning:想一半", "text:说到一半\n\n（已中止）"]);
        expect(segmentsOf(replayState)).toEqual(segmentsOf(liveState));
        expect(textOf(replayState)).toBe(textOf(liveState));
    });

    test("用户中止且还没出字：只有标记不产生前导空行，实时与重放一致", () => {
        const liveState = createSessionUiState();
        const deps = makeDeps();
        applyAgentEvent(liveState, 1, { type: "turn_start", iteration: 0 }, deps);
        applyAgentEvent(liveState, 1, { type: "aborted", stopReason: "aborted" }, deps);

        const replayState = createSessionUiState();
        projectHistory(
            replayState,
            [
                event(1, "user_message", { text: "开始", turnId: TURN_ID }),
                event(2, "turn_commit", {
                    turnId: TURN_ID,
                    usage: emptyUsage(),
                    events: [],
                    userMessages: ["开始"],
                    stopReason: "aborted",
                    interrupted: true,
                }),
            ],
            makeDeps(),
            false,
        );

        expect(segmentsOf(liveState)).toEqual(["text:（已中止）"]);
        expect(segmentsOf(replayState)).toEqual(segmentsOf(liveState));
        expect(textOf(replayState)).toBe(textOf(liveState));
    });
});
