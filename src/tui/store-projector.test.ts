import { describe, expect, test } from "bun:test";
import type { UIEvent } from "../events/ui-events.js";
import { applyAgentEvent, type ProjectionDeps } from "./store-projector.js";
import { createSessionUiState, type SessionUiState } from "./store-types.js";

/** 记录通知次数并注入自增 id 的投影依赖，便于断言副作用发生时机。 */
function makeDeps(): { deps: ProjectionDeps; notifications: string[] } {
    let messageId = 0;
    let blockId = 0;
    const notifications: string[] = [];
    return {
        notifications,
        deps: {
            nextMessageId: () => ++messageId,
            nextBlockId: () => ++blockId,
            notifyMessages: () => notifications.push("messages"),
            notifyStatus: () => notifications.push("status"),
        },
    };
}

function apply(state: SessionUiState, deps: ProjectionDeps, requestId: number, event: UIEvent): void {
    applyAgentEvent(state, requestId, event, deps);
}

describe("applyAgentEvent 回合生命周期", () => {
    /** timeline 的段序：文本/思考段带上内容，其他只带类型。 */
    const segmentsOf = (state: SessionUiState): string[] =>
        (state.messages[0]!.timeline ?? []).map(item =>
            item.type === "text" || item.type === "reasoning" ? `${item.type}:${item.text}` : item.type);

    test("turn_start 创建流式 assistant 消息并重置阶段计时", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({ role: "assistant", streaming: true, text: "" });
        expect(state.activeRequestId).toBe(1);
        expect(state.activeAssistantId).toBe(state.messages[0]!.id);
        expect(state.requestStartedAt).toBeDefined();
        expect(state.firstTextAt).toBeUndefined();
    });

    test("同一 requestId 的后续轮次复用同一条 assistant 消息", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "turn_start", iteration: 1 });

        expect(state.messages).toHaveLength(1);
    });

    test("text_delta 与 reasoning_delta 分别累加正文与思考", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "reasoning_delta", delta: "想" });
        apply(state, deps, 1, { type: "text_delta", delta: "答" });
        apply(state, deps, 1, { type: "text_delta", delta: "案" });

        expect(state.messages[0]!.text).toBe("答案");
        expect(state.messages[0]!.reasoning).toBe("想");
        expect(state.firstTextAt).toBeDefined();
        expect(state.firstReasoningAt).toBeDefined();
    });

    test("message_end 用最终 content 校正时间线并结束回合", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "text_delta", delta: "半" });
        apply(state, deps, 1, { type: "message_end", content: "完整内容", stopReason: "stop" });

        expect(state.messages[0]!.text).toBe("完整内容");
        expect(state.messages[0]!.streaming).toBe(false);
        expect(state.messages[0]!.timeline).toEqual([{ type: "text", text: "完整内容" }]);
        expect(state.activeRequestId).toBeNull();
        expect(state.activeAssistantId).toBeNull();
    });

    test("aborted 追加中止标记并结束回合", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "text_delta", delta: "部分" });
        apply(state, deps, 1, { type: "aborted", stopReason: "aborted" });

        expect(state.messages[0]!.text).toBe("部分\n\n（已中止）");
        expect(state.activeAssistantId).toBeNull();
    });

    test("aborted 缺省 stopReason 按「中断」措辞（进程级中断）", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "text_delta", delta: "部分" });
        apply(state, deps, 1, { type: "aborted" });

        expect(state.messages[0]!.text).toBe("部分\n\n（中断）");
        expect(state.activeAssistantId).toBeNull();
    });

    test("error 追加系统消息并结束回合", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "error", message: "网络断了" });

        expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "⚠️ 网络断了" });
        expect(state.activeAssistantId).toBeNull();
    });

    test("assistant_text_before_tools 不改文本：段间分隔交给渲染层（与重放一致）", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "text_delta", delta: "先说话" });
        apply(state, deps, 1, { type: "assistant_text_before_tools", content: "先说话" });

        // 旧实现会给段尾追加 "\n\n"，实时渲染就比重放（切会话/重启）多出空白行
        expect(state.messages[0]!.text).toBe("先说话");
        expect(segmentsOf(state)).toEqual(["text:先说话"]);
    });

    // 实测 bug（2026-09-10）：多轮工具循环里最终回复被回填到工具调用之前的正文段，
    // 折叠态/详细态都看到「最终回复」排在中间的工具块之前，工具前的说明文本也丢了。
    test("工具循环多轮：最终回复留在工具调用之后，不回填到工具前的正文段", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        // 第 1 轮：先说一句、调用工具
        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "reasoning_delta", delta: "想A" });
        apply(state, deps, 1, { type: "text_delta", delta: "我先看看" });
        apply(state, deps, 1, { type: "assistant_text_before_tools", content: "我先看看" });
        apply(state, deps, 1, { type: "tool_start", toolId: 1, callId: "call_1", name: "read", args: {}, mode: "serial" });
        apply(state, deps, 1, {
            type: "tool_result", toolId: 1, callId: "call_1", name: "read", summary: "ok", isError: false, durationMs: 1,
        });

        // 第 2 轮：拿到工具结果后给出最终回复
        apply(state, deps, 1, { type: "turn_start", iteration: 1 });
        apply(state, deps, 1, { type: "reasoning_delta", delta: "想B" });
        apply(state, deps, 1, { type: "text_delta", delta: "最终回复" });
        apply(state, deps, 1, { type: "message_end", content: "最终回复", stopReason: "stop", reasoning: "想A想B" });

        expect(segmentsOf(state)).toEqual([
            "reasoning:想A",
            "text:我先看看",
            "tool",
            "reasoning:想B",
            "text:最终回复",
        ]);
        expect(state.messages[0]!.text).toBe("最终回复");
    });

    // reasoning 的最终值是**整回合累计值**，不能整体搬进第一段（那会把后面的思考段清空、
    // 让整回合思考跑到工具调用之前，与重放侧「每轮思考留在自己段位」不一致）。
    test("工具循环多轮：思考段各自留在原位，累计值只修正本轮", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "reasoning_delta", delta: "想A" });
        apply(state, deps, 1, { type: "tool_start", toolId: 1, callId: "call_1", name: "read", args: {}, mode: "serial" });
        apply(state, deps, 1, { type: "turn_start", iteration: 1 });
        apply(state, deps, 1, { type: "reasoning_delta", delta: "想B" });
        apply(state, deps, 1, { type: "text_delta", delta: "答案" });
        apply(state, deps, 1, { type: "message_end", content: "答案", stopReason: "stop", reasoning: "想A想B" });

        expect(segmentsOf(state)).toEqual(["reasoning:想A", "tool", "reasoning:想B", "text:答案"]);
        expect(state.messages[0]!.reasoning).toBe("想A想B");
    });
});

describe("applyAgentEvent 工具块", () => {
    test("tool_start 建块，tool_result 按 requestId + toolId 配对回填", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "tool_start", toolId: 1, name: "read", args: { path: "a.ts" }, mode: "serial" });
        apply(state, deps, 1, {
            type: "tool_result",
            toolId: 1,
            name: "read",
            summary: "内容",
            isError: false,
            durationMs: 5,
        });

        const block = state.messages[0]!.toolBlocks![0]!;
        expect(block).toMatchObject({ requestId: 1, toolId: 1, result: "内容", isError: false });
        expect(state.messages[0]!.timeline!.some(item => item.type === "tool")).toBe(true);
    });

    test("toolId 相同但 requestId 不同时不串块", () => {
        const state = createSessionUiState();
        const { deps } = makeDeps();

        apply(state, deps, 1, { type: "turn_start", iteration: 0 });
        apply(state, deps, 1, { type: "tool_start", toolId: 1, name: "read", args: {}, mode: "serial" });
        apply(state, deps, 2, {
            type: "tool_result",
            toolId: 1,
            name: "read",
            summary: "不该回填",
            isError: false,
            durationMs: 1,
        });

        expect(state.messages[0]!.toolBlocks![0]!.result).toBeUndefined();
    });
});

describe("applyAgentEvent 通知", () => {
    test("usage 只触发状态栏通知，不触发消息重绘", () => {
        const state = createSessionUiState();
        const { deps, notifications } = makeDeps();

        apply(state, deps, 1, {
            type: "usage",
            usage: {
                model: "deepseek-v4-flash",
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
                durationMs: 0,
            },
        });

        expect(notifications).toEqual(["status"]);
        expect(state.totalTokens).toBe(2);
    });

    test("忽略的事件类型不产生任何通知", () => {
        const state = createSessionUiState();
        const { deps, notifications } = makeDeps();

        apply(state, deps, 1, { type: "toolcall_start", index: 0, id: "x", name: "read" });
        apply(state, deps, 1, { type: "toolcall_end", index: 0, id: "x", name: "read", argsJson: "{}" });
        apply(state, deps, 1, { type: "turn_end", iteration: 0 });

        expect(notifications).toHaveLength(0);
        expect(state.messages).toHaveLength(0);
    });
});
