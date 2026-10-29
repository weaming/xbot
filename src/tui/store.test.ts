import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import type { UIEvent } from "../events/ui-events.js";
import { isDeepSeekPeakTime } from "../pricing/deepseek.js";
import { ChatStore } from "./store.js";

describe("ChatStore DeepSeek 费用统计", () => {
    const usageOf = (cacheMissTokens: number) => ({
        model: "deepseek-v4-flash",
        promptTokens: cacheMissTokens,
        cacheHitTokens: 0,
        cacheMissTokens,
        completionTokens: 0,
        totalTokens: cacheMissTokens,
        durationMs: 0,
        requestCount: 1,
    });

    test("注入 costFor 后实时 usage 事件按请求时刻累计费用", () => {
        const store = new ChatStore({
            costFor: (usage) => (usage.cacheMissTokens ?? 0) / 1_000_000 * 3,
        });
        store.setCurrentSession("session-1");

        apply(store, { type: "usage", usage: usageOf(1_000_000) });
        apply(store, { type: "usage", usage: usageOf(2_000_000) });

        expect(store.costYuan).toBeCloseTo(9, 6);
    });

    test("loadHistory 按事件 ts 区分峰谷计费", () => {
        const store = new ChatStore({
            costFor: (usage, atMs) => (usage.cacheMissTokens ?? 0) / 1_000_000 * (isDeepSeekPeakTime(atMs) ? 3 : 1.5),
        });
        store.setCurrentSession("session-1");

        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-07T01:00:00Z", // 北京周一 09:00（高峰）
                sessionId: "session-1",
                type: "turn_commit",
                payload: {
                    turnId: "T1",
                    events: [],
                    userMessages: ["q"],
                    stopReason: "end_turn",
                    usage: usageOf(1_000_000),
                    interrupted: false,
                },
            },
            {
                seq: 2,
                ts: "2026-09-12T02:00:00Z", // 北京周六（空闲）
                sessionId: "session-1",
                type: "usage_recorded",
                payload: { usage: usageOf(1_000_000) },
            },
        ]);

        expect(store.costYuan).toBeCloseTo(3 + 1.5, 6);
    });

    test("未注入 costFor 时不产生费用", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        apply(store, { type: "usage", usage: usageOf(1_000_000) });
        expect(store.costYuan).toBe(0);
    });
});

describe("ChatStore 工具块", () => {
    test("展开状态与压缩 JSON 结果都留在块上（渲染由 tool-block-display 负责）", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, {
            type: "turn_start",
        });
        apply(store, {
            type: "tool_start",
            toolId: 1,
            name: "yfinance__quote",
            args: { symbols: ["TSM"] },
            mode: "serial",
        });
        apply(store, {
            type: "tool_result",
            toolId: 1,
            name: "yfinance__quote",
            summary: '{"data":{"TSM":{"longName":"Taiwan Semiconductor Manufacturing Company Limited"}}}',
            isError: false,
            durationMs: 10,
        });

        store.setAllToolBlocksExpanded(true);

        expect(store.getToolBlock(1)).toMatchObject({
            expanded: true,
            args: '{"symbols":["TSM"]}',
            result: '{"data":{"TSM":{"longName":"Taiwan Semiconductor Manufacturing Company Limited"}}}',
            durationMs: 10,
        });
    });

    test("展开时块上保留非 JSON 工具输出原文", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, { type: "turn_start" });
        apply(store, {
            type: "tool_start",
            toolId: 1,
            name: "bash",
            args: {},
            mode: "serial",
        });
        apply(store, {
            type: "tool_result",
            toolId: 1,
            name: "bash",
            summary: "line 1\nline 2",
            isError: false,
            durationMs: 1,
        });

        store.setAllToolBlocksExpanded(true);

        expect(store.getToolBlock(1)).toMatchObject({
            expanded: true,
            result: "line 1\nline 2",
            durationMs: 1,
        });
    });

    test("同一 turn 的思考、工具和文本按时间线保留顺序", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "reasoning_delta", delta: "先检查" });
        apply(store, { type: "text_delta", delta: "开始处理" });
        apply(store, {
            type: "tool_start",
            toolId: 1,
            name: "read",
            args: { path: "a.txt" },
            mode: "serial",
        });
        apply(store, {
            type: "tool_result",
            toolId: 1,
            name: "read",
            summary: "旧内容",
            isError: false,
            durationMs: 1,
        });
        apply(store, { type: "reasoning_delta", delta: "再修改" });
        apply(store, { type: "text_delta", delta: "处理完成" });

        expect(store.messages[0]?.timeline?.map((item) => item.type)).toEqual([
            "reasoning",
            "text",
            "tool",
            "reasoning",
            "text",
        ]);
        expect(store.messages[0]?.timeline?.[2]).toMatchObject({
            type: "tool",
            block: { name: "read", result: "旧内容" },
        });
    });

    test("切换会话后仍保留后台会话的流式消息", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-a");

        store.applyEvent(1, "session-a", { type: "turn_start" });
        store.applyEvent(1, "session-a", { type: "text_delta", delta: "后台开始" });

        store.setCurrentSession("session-b");
        store.loadHistory([]);
        store.applyEvent(1, "session-a", { type: "text_delta", delta: "继续处理" });
        store.applyEvent(1, "session-a", {
            type: "message_end",
            content: "后台完成",
            stopReason: "stop",
        });

        store.setCurrentSession("session-a");

        expect(store.messages[0]?.text).toBe("后台完成");
        expect(store.messages[0]?.streaming).toBe(false);
        // message_end 对账：后台会话 timeline 也以最终 content 为准。
        expect(store.messages[0]?.timeline).toEqual([
            { type: "text", text: "后台完成" },
        ]);
    });

    test("未闭合回合（只剩 turn_message）恢复为（中断）助手消息并保留工具块", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "查行情", turnId: "T1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
                    },
                },
            },
            {
                seq: 3,
                ts: "2026-09-08T10:00:02+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: { role: "tool", tool_call_id: "c1", name: "bash", content: "结果" },
                },
            },
        ] as any);

        expect(store.messages.map(message => message.role)).toEqual(["user", "assistant"]);
        expect(store.messages[1]?.text).toContain("中断");
        const block = store.messages[1]?.toolBlocks?.[0];
        expect(block?.name).toBe("bash");
        expect(block?.result).toBe("结果");
    });

    test("重放工具块带回耗时，没有结果消息的工具标为取消", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "跑两个工具", turnId: "T1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            { id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } },
                            { id: "c2", function: { name: "bash", arguments: '{"command":"sleep 99"}' } },
                        ],
                    },
                },
            },
            {
                seq: 3,
                ts: "2026-09-08T10:00:02+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: { role: "tool", tool_call_id: "c1", name: "bash", content: "结果", durationMs: 1234 },
                },
            },
        ] as any);

        const [done, cancelled] = store.messages[1]?.toolBlocks ?? [];
        expect(done?.durationMs).toBe(1234);
        expect(done?.cancelled).toBeUndefined();
        expect(cancelled?.result).toBeUndefined();
        expect(cancelled?.cancelled).toBe(true);
    });

    test("多个未闭合回合都能从时间线恢复", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory(["T1", "T2"].flatMap((turnId, index) => [
            {
                seq: index * 2 + 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: turnId, turnId, trigger: "user" },
            },
            {
                seq: index * 2 + 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: { turnId, message: { role: "assistant", content: `${turnId} 输出` } },
            },
        ]) as any);

        const assistants = store.messages.filter(message => message.role === "assistant");
        expect(assistants).toHaveLength(2);
        expect(assistants[0]?.timeline?.[0]?.text).toContain("T1 输出");
        expect(assistants[1]?.timeline?.[0]?.text).toContain("T2 输出");
    });

    test("未闭合流式片段在重放后仍显示", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "问题", turnId: "T1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_stream_delta",
                payload: { turnId: "T1", requestIndex: 1, delta: { text: "已收到一半" } },
            },
        ] as any);

        expect(store.messages[1]?.timeline?.[0]?.text).toContain("已收到一半");
        expect(store.messages[1]?.text).toContain("中断");
    });

    test("失败终态缺完整消息时显示已落盘的流式片段", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "问题", turnId: "T1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_stream_delta",
                payload: { turnId: "T1", requestIndex: 1, delta: { text: "已收到一半" } },
            },
            {
                seq: 3,
                ts: "2026-09-08T10:00:02+08:00",
                sessionId: "session-1",
                type: "turn_commit",
                payload: {
                    turnId: "T1",
                    events: [],
                    userMessages: ["问题"],
                    stopReason: "error",
                    error: "Connection error.",
                    usage: { model: "test", promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0 },
                    interrupted: false,
                },
            },
        ] as any);

        expect(store.messages[1]?.text).toBe("已收到一半");
        expect(store.messages[2]?.text).toContain("Connection error.");
    });

    test("已闭合回合按 turn_message 渲染一次，不重复", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "查行情", turnId: "T1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: { role: "assistant", content: "最终答案" },
                },
            },
            {
                seq: 3,
                ts: "2026-09-08T10:00:02+08:00",
                sessionId: "session-1",
                type: "turn_commit",
                payload: {
                    turnId: "T1",
                    events: [2],
                    userMessages: ["查行情"],
                    stopReason: "stop",
                    usage: { model: "test-model", promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 },
                    interrupted: false,
                },
            },
        ] as any);

        expect(store.messages.map(message => message.role)).toEqual(["user", "assistant"]);
        expect(store.messages[1]?.text).toBe("最终答案");
    });

    test("从历史消息恢复工具输入参数", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory(turnEvents(
            { ts: "2026-08-29T00:00:00+08:00", sessionId: "session-1" },
            1,
            {
                userMessages: ["查询 TSM"],
                messages: [
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [{
                            id: "call-quote",
                            function: { name: "yfinance__quote", arguments: '{"symbols":["TSM"]}' },
                        }],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call-quote",
                        content: '{"data":{"TSM":{"regularMarketPrice":422.95}}}',
                    },
                    { role: "assistant", content: "TSM 当前价格为 422.95 美元。" },
                ],
                stopReason: "stop",
                usage: {
                    model: "test-model",
                    promptTokens: 1,
                    completionTokens: 1,
                    totalTokens: 2,
                    durationMs: 1,
                },
                interrupted: false,
            },
        ));

        expect(store.totalTokens).toBe(2);
        expect(store.promptTokens).toBe(1);
        expect(store.completionTokens).toBe(1);
        const block = store.messages[0]?.toolBlocks?.[0];
        expect(block?.name).toBe("yfinance__quote");
        expect(block?.args).toBe('{"symbols":["TSM"]}');
        expect(store.messages[0]?.timeline?.map((item) => item.type)).toEqual(["tool", "text"]);
    });

    // 用户主动中止（stopReason=aborted）：重放措辞与实时路径一致（实时的 aborted 事件写「（已中止）」），
    // 否则同一回合中止后切个会话/重启，屏幕上那句就换了词。空内容时不产生前导空行。
    test("空内容的中止消息只有标记、无前导空行", () => {
        const store = new ChatStore();

        store.loadHistory([{
            seq: 1,
            ts: "2026-08-29T00:00:00+08:00",
            sessionId: "session-1",
            type: "turn_commit",
            payload: {
                turnId: "T1",
                events: [],
                userMessages: [],
                stopReason: "aborted",
                interrupted: true,
                usage: {
                    model: "test-model",
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    durationMs: 0,
                },
            },
        }]);

        expect(store.messages[0]?.text).toBe("（已中止）");
    });

    test("累计 provider 返回的 token 明细", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, {
            type: "usage",
            usage: {
                model: "test-model",
                promptTokens: 100,
                completionTokens: 40,
                reasoningTokens: 10,
                cacheHitTokens: 80,
                cacheMissTokens: 20,
                totalTokens: 140,
                durationMs: 1,
            },
        });

        expect(store.totalTokens).toBe(140);
        expect(store.promptTokens).toBe(100);
        expect(store.contextTokens).toBe(100);
        expect(store.contextSource).toBe("provider");
        expect(store.completionTokens).toBe(40);
        expect(store.reasoningTokens).toBe(10);
        expect(store.cacheHitTokens).toBe(80);
        expect(store.cacheMissTokens).toBe(20);

        // 第二轮更新上下文占用为最新一轮的实测值
        apply(store, {
            type: "usage",
            usage: {
                model: "test-model",
                promptTokens: 250,
                completionTokens: 50,
                totalTokens: 300,
                durationMs: 1,
            },
        });

        expect(store.promptTokens).toBe(350);
        expect(store.contextTokens).toBe(250);
    });

    test("重放聚合 usage 时保留累计 token 与最后一次实测上下文", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory(turnEvents(
            { ts: "2026-09-02T00:00:00.000Z", sessionId: "session-1" },
            1,
            {
                userMessages: ["执行"],
                messages: [{ role: "assistant", content: "完成" }],
                stopReason: "stop",
                usage: {
                    model: "test-model",
                    promptTokens: 350,
                    completionTokens: 90,
                    totalTokens: 440,
                    durationMs: 20,
                    requestCount: 2,
                    latestPromptTokens: 250,
                },
                interrupted: false,
            },
        ));

        expect(store.totalTokens).toBe(440);
        expect(store.promptTokens).toBe(350);
        expect(store.completionTokens).toBe(90);
        expect(store.contextTokens).toBe(250);
    });

    test("重放压缩 usage 时计入状态栏累计 token", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([{
            seq: 1,
            ts: "2026-09-02T00:00:00.000Z",
            sessionId: "session-1",
            type: "context_compacted",
            payload: {
                compactedContext: "摘要",
                usage: {
                    model: "test-model",
                    promptTokens: 100,
                    completionTokens: 30,
                    totalTokens: 130,
                    durationMs: 10,
                },
            },
        }]);

        expect(store.totalTokens).toBe(130);
        expect(store.contextTokens).toBe(100);
    });

    test("message_end 用最终 content 校正被截断的时间线文本", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "text_delta", delta: "不完整的增量" });
        apply(store, { type: "message_end", content: "完整回复内容", stopReason: "stop" });

        expect(store.messages[0]?.text).toBe("完整回复内容");
        expect(store.messages[0]?.timeline).toEqual([{ type: "text", text: "完整回复内容" }]);
    });

    test("message_end 增量与 content 一致时保留时间线分段", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "text_delta", delta: "前半" });
        apply(store, {
            type: "tool_start",
            toolId: 1,
            name: "read",
            args: { path: "a.txt" },
            mode: "serial",
        });
        apply(store, {
            type: "tool_result",
            toolId: 1,
            name: "read",
            summary: "x",
            isError: false,
            durationMs: 1,
        });
        apply(store, { type: "text_delta", delta: "后半" });
        apply(store, { type: "message_end", content: "前半后半", stopReason: "stop" });

        expect(store.messages[0]?.timeline?.map(item => item.type)).toEqual(["text", "tool", "text"]);
    });

    test("工具调用前的文本段结束不改文本（段间分隔交给渲染层）", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "text_delta", delta: "正文" });
        apply(store, { type: "assistant_text_before_tools", content: "正文" });

        // 实时与重放（切会话/重启）必须逐字一致：正文不带额外空行
        expect(store.messages[0]?.text).toBe("正文");
        expect(store.messages[0]?.timeline).toEqual([{ type: "text", text: "正文" }]);
    });

    test("错误回合恢复历史时保留工具调用时间线并显示错误系统消息", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        store.loadHistory([
            {
                seq: 1,
                ts: "2026-08-29T00:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "do" },
            },
            {
                seq: 2,
                ts: "2026-08-29T00:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [{
                            id: "call-grep",
                            function: { name: "grep", arguments: '{"pattern":"hir_infer"}' },
                        }],
                    },
                },
            },
            {
                seq: 3,
                ts: "2026-08-29T00:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: {
                    turnId: "T1",
                    message: { role: "tool", tool_call_id: "call-grep", content: "Found 2 matches" },
                },
            },
            {
                seq: 4,
                ts: "2026-08-29T00:00:02+08:00",
                sessionId: "session-1",
                type: "turn_commit",
                payload: {
                    turnId: "T1",
                    events: [2, 3],
                    userMessages: ["do"],
                    stopReason: "error",
                    error: "LLM provider 请求失败（HTTP 502）：502 status code (no body)",
                    usage: {
                        model: "gemini-3.7-flash",
                        promptTokens: 100,
                        completionTokens: 20,
                        totalTokens: 120,
                        durationMs: 100,
                    },
                    interrupted: false,
                },
            },
        ]);

        expect(store.messages).toHaveLength(3);
        expect(store.messages[0]?.role).toBe("user");
        expect(store.messages[0]?.text).toBe("do");

        const assistant = store.messages[1];
        expect(assistant?.role).toBe("assistant");
        expect(assistant?.timeline).toHaveLength(1);
        expect(assistant?.timeline?.[0]?.type).toBe("tool");
        expect(assistant?.toolBlocks?.[0]?.name).toBe("grep");

        const systemMsg = store.messages[2];
        expect(systemMsg?.role).toBe("system");
        expect(systemMsg?.text).toBe("⚠️ LLM provider 请求失败（HTTP 502）：502 status code (no body)");
    });

    test("消费 pending 消息时进入当前 assistant 消息时间线，并在重放时保留", () => {
        const store = new ChatStore();
        store.currentSessionId = "session-pending";

        // 1. 发起用户提问与 assistant turn_start
        store.addUserMessage("第一条提问", "session-pending");
        store.applyEvent(1, "session-pending", { type: "turn_start", iteration: 1 });
        store.applyEvent(1, "session-pending", {
            type: "tool_start",
            toolId: 1,
            name: "bash",
            args: { command: "ls" },
        });

        // 2. 在工具执行期间消费 pending 消息
        store.addPendingUserMessage("补充的 pending 消息", "session-pending");

        // 3. assistant 输出后续正文并结束
        store.applyEvent(1, "session-pending", {
            type: "text_delta",
            delta: "收到补充，继续回答",
        });
        store.applyEvent(1, "session-pending", {
            type: "message_end",
            content: "收到补充，继续回答",
            stopReason: "stop",
        });

        // 验证消息结构：只有 1 条 user 和 1 条 assistant，pending 进入了 timeline
        expect(store.messages).toHaveLength(2);
        const assistant = store.messages[1];
        expect(assistant?.timeline?.map(item => item.type)).toEqual(["tool", "user", "text"]);
        expect(assistant?.timeline?.[1]).toEqual({ type: "user", text: "补充的 pending 消息" });

        // 4. 重放历史时包含 user 节点，且 pending 消息不再单独渲染气泡（只留在助手时间线）
        const historyStore = new ChatStore();
        historyStore.loadHistory([
            {
                seq: 1,
                type: "user_message",
                payload: { text: "第一条提问", turnId: "turn-1", trigger: "user" },
            },
            {
                seq: 2,
                type: "user_message",
                payload: { text: "补充的 pending 消息", turnId: "turn-1", trigger: "pending" },
            },
            ...turnEvents({
                seq: 3,
                payload: {
                    turnId: "turn-1",
                    userMessages: ["第一条提问"],
                    messages: [
                        {
                            role: "assistant",
                            tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
                        },
                        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
                        { role: "user", content: "补充的 pending 消息" },
                        { role: "assistant", content: "收到补充，继续回答" },
                    ],
                    content: "收到补充，继续回答",
                    usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, durationMs: 100 },
                    interrupted: false,
                },
            }),
        ]);

        expect(historyStore.messages.map(message => message.role)).toEqual(["user", "assistant"]);
        expect(historyStore.messages[0]?.text).toBe("第一条提问");
        expect(historyStore.messages[1]?.timeline?.map(item => item.type)).toEqual(["tool", "user", "text"]);
        expect(historyStore.messages[1]?.timeline?.[1]).toEqual({ type: "user", text: "补充的 pending 消息" });
    });

    test("多会话系统消息与历史加载隔离，不发生跨会话串扰", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-A");

        // 模拟向后台 session-B 发送系统消息
        store.pushSystemMessage("🗜️ 已压缩上下文", "session-B");

        // session-A 的消息列表应当完全为空
        expect(store.getMessages("session-A")).toHaveLength(0);
        expect(store.messages).toHaveLength(0);

        // session-B 的消息列表应当包含该消息
        expect(store.getMessages("session-B")).toHaveLength(1);
        expect(store.getMessages("session-B")[0]?.text).toBe("🗜️ 已压缩上下文");

        // 模拟后台加载 session-B 历史
        store.loadHistory([
            {
                seq: 1,
                type: "context_compacted",
                payload: { compactedContext: "历史总结" },
            },
        ], "session-B");

        // 当前 session-A 依然不受影响
        expect(store.messages).toHaveLength(0);

        // 切换到 session-B 后呈现其独立历史
        store.setCurrentSession("session-B");
        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.text).toBe("🗜️ 已压缩上下文");
    });







    test("同 turnId 重复落盘时只渲染终态一次并只计一次费用", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-dup");
        const usage = { model: "test-model", promptTokens: 10, completionTokens: 20, totalTokens: 30, durationMs: 1 };

        store.loadHistory([
            ...turnEvents({
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-dup",
                payload: {
                    turnId: "T1",
                    userMessages: [],
                    messages: [{ role: "assistant", content: "半截" }],
                    stopReason: "aborted",
                    usage,
                    interrupted: true,
                },
            }),
            ...turnEvents({
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-dup",
                payload: {
                    turnId: "T1",
                    userMessages: [],
                    messages: [{ role: "assistant", content: "最终答案" }],
                    stopReason: "stop",
                    usage,
                    interrupted: false,
                },
            }),
        ] as any);

        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.text).toBe("最终答案");
        expect(store.totalTokens).toBe(30);
    });

    test("同 turnId 重复落盘：渲染与计费都取最后一条终态", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-dup2");
        const usageOf = (total: number) => ({
            model: "test-model",
            promptTokens: total,
            completionTokens: 0,
            totalTokens: total,
            durationMs: 1,
        });

        store.loadHistory([
            ...turnEvents({
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-dup2",
                payload: {
                    turnId: "T1",
                    userMessages: [],
                    messages: [{ role: "assistant", content: "半截" }],
                    content: "半截",
                    stopReason: "aborted",
                    usage: usageOf(10),
                    interrupted: true,
                },
            }),
            ...turnEvents({
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-dup2",
                payload: {
                    turnId: "T1",
                    userMessages: [],
                    messages: [{ role: "assistant", content: "最终答案" }],
                    content: "最终答案",
                    stopReason: "stop",
                    usage: usageOf(20),
                    interrupted: false,
                },
            }),
        ] as any);

        // 渲染与计费同口径：都取最后一条终态（半截 10 → 最终答案 20）
        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.text).toBe("最终答案");
        expect(store.totalTokens).toBe(20);
    });
});

function apply(store: ChatStore, event: UIEvent): void {
    store.applyEvent(1, "session-1", event);
}

/**
 * 测试便捷：把「旧式回合载荷」展开为新格式事件（turn_message + turn_commit）。
 * 两种写法：turnEvents(base, startSeq, payload) 或 turnEvents({ ...base, seq, payload })。
 * startSeq 为第一个 turn_message 的 seq，commit 的 seq 顺延；无 messages 时只有 commit。
 */
function turnEvents(base: Record<string, any>, startSeq?: number, payload?: Record<string, any>): any[] {
    if (payload === undefined) {
        const { seq, payload: raw, ...rest } = base;
        return expandTurnEvents(rest, seq as number, raw);
    }
    return expandTurnEvents(base, startSeq as number, payload);
}

function expandTurnEvents(base: Record<string, any>, startSeq: number, payload: Record<string, any>): any[] {
    const turnId = payload.turnId ?? `turn-${startSeq}`;
    const events: any[] = [];
    const seqs: number[] = [];
    let seq = startSeq;
    for (const message of payload.messages ?? []) {
        events.push({ ...base, seq, type: "turn_message", payload: { turnId, message } });
        seqs.push(seq);
        seq += 1;
    }
    events.push({
        ...base,
        seq,
        type: "turn_commit",
        payload: {
            turnId,
            events: seqs,
            userMessages: payload.userMessages ?? [],
            stopReason: payload.stopReason ?? "stop",
            usage: payload.usage,
            interrupted: payload.interrupted === true,
            ...(payload.error ? { error: payload.error } : {}),
        },
    });
    return events;
}

describe("ChatStore 生成速率", () => {
    afterEach(() => setSystemTime());

    const usageOf = (overrides: Record<string, unknown> = {}) => ({
        model: "test-model",
        promptTokens: 100,
        completionTokens: 1000,
        reasoningTokens: 600,
        totalTokens: 1100,
        durationMs: 10_000,
        ...overrides,
    });

    test("总速率用 durationMs，思考/输出按首包时间切分阶段", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        setSystemTime(1000);
        apply(store, { type: "reasoning_delta", delta: "想" });
        setSystemTime(6000);
        apply(store, { type: "text_delta", delta: "写" });
        setSystemTime(10_000);
        apply(store, { type: "usage", usage: usageOf() } as UIEvent);

        const rate = store.lastRate;
        expect(rate?.totalTps).toBeCloseTo(100, 6);
        expect(rate?.reasoningTps).toBeCloseTo(120, 6);
        expect(rate?.outputTps).toBeCloseTo(100, 6);
    });

    test("纯思考无正文时只给总速率与思考速率", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        setSystemTime(2000);
        apply(store, { type: "reasoning_delta", delta: "想" });
        setSystemTime(12_000);
        apply(store, { type: "usage", usage: usageOf({ completionTokens: 800, reasoningTokens: 800 }) } as UIEvent);

        const rate = store.lastRate;
        expect(rate?.totalTps).toBeCloseTo(80, 6);
        expect(rate?.reasoningTps).toBeCloseTo(100, 6);   // 800 / (10000-2000)ms
        expect(rate?.outputTps).toBeUndefined();
    });

    test("多次请求累加进会话平均：token 与耗时都作为分母累计", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");
        expect(store.lastRate).toBeUndefined();

        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        setSystemTime(10_000);
        apply(store, { type: "usage", usage: usageOf() } as UIEvent);
        expect(store.lastRate?.totalTps).toBeCloseTo(100, 6);

        // 第二轮 500 tokens / 10s（聚合 usage）：累计 1500 tokens / 20s = 75 T/s
        setSystemTime(20_000);
        apply(store, { type: "turn_start", iteration: 1 });
        setSystemTime(30_000);
        apply(store, {
            type: "usage",
            usage: usageOf({ completionTokens: 500, reasoningTokens: 0, totalTokens: 550, requestCount: 2 }),
        } as UIEvent);

        expect(store.lastRate?.completionTokens).toBe(1500);
        expect(store.lastRate?.durationMs).toBe(20_000);
        expect(store.lastRate?.totalTps).toBeCloseTo(75, 6);
    });

    test("无耗时或零产出的 usage 不产生速率", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "usage", usage: usageOf({ durationMs: 0 }) } as UIEvent);
        expect(store.lastRate).toBeUndefined();

        apply(store, {
            type: "usage",
            usage: usageOf({ completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }),
        } as UIEvent);
        expect(store.lastRate).toBeUndefined();
    });

    test("纯工具调用轮只计入总速率，不污染阶段速率", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        // 第 1 轮：有思考与正文
        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        setSystemTime(1000);
        apply(store, { type: "reasoning_delta", delta: "想" });
        setSystemTime(6000);
        apply(store, { type: "text_delta", delta: "写" });
        setSystemTime(10_000);
        apply(store, { type: "usage", usage: usageOf() } as UIEvent);

        expect(store.lastRate?.totalTps).toBeCloseTo(100, 6);
        expect(store.lastRate?.reasoningTps).toBeCloseTo(120, 6);   // 600 / (6000-1000)ms
        expect(store.lastRate?.outputTps).toBeCloseTo(100, 6);      // 400 / (10000-6000)ms

        // 第 2 轮：纯工具调用（无 reasoning/text delta），token 只进总速率分子
        setSystemTime(12_000);
        apply(store, { type: "turn_start", iteration: 2 });
        setSystemTime(14_000);
        apply(store, {
            type: "usage",
            usage: usageOf({ completionTokens: 800, reasoningTokens: 0, totalTokens: 900, durationMs: 2000 }),
        } as UIEvent);

        expect(store.lastRate?.totalTps).toBeCloseTo(150, 6);       // 1800 / 12000ms
        expect(store.lastRate?.reasoningTps).toBeCloseTo(120, 6);   // 阶段速率不受第 2 轮影响
        expect(store.lastRate?.outputTps).toBeCloseTo(100, 6);
    });

    test("切换会话后各自保留自己的速率", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        setSystemTime(0);
        apply(store, { type: "turn_start", iteration: 1 });
        apply(store, { type: "usage", usage: usageOf() } as UIEvent);
        expect(store.lastRate?.totalTps).toBeCloseTo(100, 6);

        store.setCurrentSession("session-2");
        expect(store.lastRate).toBeUndefined();
    });
});

describe("ChatStore 会话切换与 id 索引", () => {
    // 索引惰性重建：切换会话会整表换掉消息数组，若只看 dirty 标记，切回去后就会拿着另一个
    // 会话的索引（表现：A→B→A 后 Ctrl+O 展不开工具块 / 展开思考时按 id 找不到消息）。
    test("会话 A→B→A 后按 id 查消息 / 工具块仍命中 A", () => {
        const store = new ChatStore();
        const turn = (sessionId: string, name: string) => {
            store.applyEvent(1, sessionId, { type: "turn_start", iteration: 0 });
            store.applyEvent(1, sessionId, { type: "tool_start", toolId: 1, callId: `call_${name}`, name, args: {}, mode: "serial" });
            return { messageId: store.messages[0]!.id, blockId: store.messages[0]!.toolBlocks![0]!.id };
        };

        store.setCurrentSession("session-a");
        const a = turn("session-a", "read");
        expect(store.getToolBlock(a.blockId)?.name).toBe("read"); // 建起 A 的索引

        store.setCurrentSession("session-b");
        const b = turn("session-b", "bash");
        expect(store.getToolBlock(b.blockId)?.name).toBe("bash"); // 建起 B 的索引

        store.setCurrentSession("session-a");
        expect(store.getMessageById(a.messageId)?.id).toBe(a.messageId);
        expect(store.getToolBlock(a.blockId)?.name).toBe("read");
    });
});

describe("ChatStore 消息排序", () => {
    afterEach(() => setSystemTime());


});
