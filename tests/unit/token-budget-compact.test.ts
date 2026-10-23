import { describe, expect, test } from "bun:test";
import {
    estimateMessageTokens,
    estimateTextTokens,
    estimateTurnsTokens,
    formatCompactTokens,
    getContextWindowForModel,
    getEffectiveContextWindowSize,
    getAutoCompactThreshold,
    shouldAutoCompact,
    splitTurnsForCompaction,
} from "../../src/utils/token-budget.js";
import {
    appendCompletedTurn,
    getSessionContextHistory,
    getSessionHistory,
    replaceWithCompactedContext,
} from "../../src/utils/conversation-history.js";
import { autoCompactIfNeeded } from "../../src/services/auto-compact.js";
import { createEmptySession } from "../../src/events/session-replay.js";
import type { Session } from "../../src/types/session.js";

describe("Token 预算与估算 (Token Budget & Estimation)", () => {
    test("estimateTextTokens 准确估算中英文与混合文本", async () => {
        expect(estimateTextTokens("")).toBe(0);
        expect(estimateTextTokens("hello world")).toBeGreaterThan(0);
        // 中文约 1.2 token/字
        const zhTokens = estimateTextTokens("你好世界");
        expect(zhTokens).toBeGreaterThanOrEqual(4);

        // 长文本
        const longText = "a".repeat(350);
        expect(estimateTextTokens(longText)).toBe(100);
    });

    test("formatCompactTokens 紧凑格式化 Token 数量（支持 K 与 M 缩写）", async () => {
        expect(formatCompactTokens(0)).toBe("0");
        expect(formatCompactTokens(250)).toBe("250");
        expect(formatCompactTokens(999)).toBe("999");
        expect(formatCompactTokens(1000)).toBe("1k");
        expect(formatCompactTokens(6400)).toBe("6.4k");
        expect(formatCompactTokens(35120)).toBe("35.1k");
        expect(formatCompactTokens(64000)).toBe("64k");
        expect(formatCompactTokens(200000)).toBe("200k");
        expect(formatCompactTokens(262144)).toBe("262.1k");
        expect(formatCompactTokens(1000000)).toBe("1M");
        expect(formatCompactTokens(1048576)).toBe("1.05M");
        expect(formatCompactTokens(1050000)).toBe("1.05M");
        expect(formatCompactTokens(1310720)).toBe("1.31M");
        expect(formatCompactTokens(2000000)).toBe("2M");
    });

    test("estimateMessageTokens 包含消息结构开销与 tool_calls", async () => {
        const textMsg = { role: "user" as const, content: "你好" };
        expect(estimateMessageTokens(textMsg)).toBeGreaterThan(4);

        const toolMsg = {
            role: "assistant" as const,
            content: null,
            tool_calls: [
                {
                    id: "call_1",
                    type: "function" as const,
                    function: { name: "execute_shell", arguments: '{"command":"ls -la"}' },
                },
            ],
        };
        expect(estimateMessageTokens(toolMsg)).toBeGreaterThan(20);
    });

    test("getContextWindowForModel 正确识别模型窗口与环境变量覆盖", async () => {
        expect(getContextWindowForModel("deepseek-v4-flash")).toBe(1_310_720);
        expect(getContextWindowForModel("deepseek-chat")).toBe(64_000);
        expect(getContextWindowForModel("gemini-3.7-flash")).toBe(1_048_576);
        expect(getContextWindowForModel("gemini-3.6-pro")).toBe(1_048_576);
        expect(getContextWindowForModel("gpt-5.6-sol")).toBe(1_050_000);
        expect(getContextWindowForModel("o3-mini")).toBe(200_000);
        expect(getContextWindowForModel("claude-sonnet-5")).toBe(1_000_000);
        expect(getContextWindowForModel("qwen3.8-max")).toBe(1_000_000);
        expect(getContextWindowForModel("glm-5.3-flash")).toBe(1_310_720);
        expect(getContextWindowForModel("unknown-model")).toBe(128_000);
    });

    test("getEffectiveContextWindowSize 与 getAutoCompactThreshold 计算准确（百分比与缓冲双重约束）", async () => {
        // gpt-4o: 128_000 total, 8_192 reserved -> 119_808 effective
        // percentageThreshold: floor(119_808 * 0.80) = 95_846
        // bufferThreshold: 119_808 - 15_000 = 104_808
        // threshold: min(95_846, 104_808) = 95_846
        const effective = getEffectiveContextWindowSize("gpt-4o");
        expect(effective).toBe(128_000 - 8_192);

        const threshold = getAutoCompactThreshold("gpt-4o");
        expect(threshold).toBe(Math.floor(effective * 0.80));
    });

    test("有上次 provider 实际输入 token 时优先使用实际值", async () => {
        const session = createEmptySession("sess-actual-prompt-tokens");
        appendCompletedTurn(session, ["短问题"], [{ role: "assistant", content: "短回复" }], true);
        const threshold = getAutoCompactThreshold("deepseek-chat");

        expect(await shouldAutoCompact(session, {
            model: "deepseek-chat",
            lastPromptTokens: threshold - 1,
        })).toBe(false);
        expect(await shouldAutoCompact(session, {
            model: "deepseek-chat",
            lastPromptTokens: threshold,
        })).toBe(true);
    });

    test("本地估算计入系统提示占用：历史没超、加上系统提示就超", async () => {
        const session = createEmptySession("sess-system-prompt-tokens");
        appendCompletedTurn(session, ["短问题"], [{ role: "assistant", content: "短回复" }], true);
        const threshold = getAutoCompactThreshold("deepseek-chat");

        // 只看历史远不到阈值
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(false);
        // 真实请求量 = 历史 + 系统提示（+ 工具定义），漏掉系统提示就会漏判、一路涨到 provider 400
        expect(await shouldAutoCompact(session, {
            model: "deepseek-chat",
            systemPromptTokens: threshold,
        })).toBe(true);
    });
});

describe("压缩上下文与 Prompt Cache 复用 (Compact Assembly & Cache Friendly)", () => {
    test("总结消息以独立 user 消息注入并配合 assistant 确认", async () => {
        const session = createEmptySession("sess-cache-test");
        for (let i = 1; i <= 6; i++) {
            appendCompletedTurn(session, [`u${i}`], [{ role: "assistant", content: `a${i}` }], true);
        }

        const compactedThroughTurnId = session.turns[3].id;
        replaceWithCompactedContext(session, "## 任务背景与已修改文件", {
            compactedThroughTurnId,
        });

        const context = getSessionContextHistory(session);

        // 第一条为 user 总结消息
        expect(context[0].role).toBe("user");
        expect(context[0].content).toContain("<conversation_summary");
        expect(context[0].content).toContain("## 任务背景与已修改文件");

        // 第二条为 assistant 确认消息
        expect(context[1].role).toBe("assistant");
        expect(context[1].content).toContain("已确认上述历史上下文与关键进展");

        // 后面紧接着未被压缩的 turns (turn 5, 6)
        expect(context[2]).toEqual({ role: "user", content: "u5" });
        expect(context[3]).toEqual({ role: "assistant", content: "a5" });
        expect(context[4]).toEqual({ role: "user", content: "u6" });
        expect(context[5]).toEqual({ role: "assistant", content: "a6" });
    });

    test("压缩后追加新消息保持前缀严格单向递增 (Append-only Prefix)", async () => {
        const session = createEmptySession("sess-prefix-test");
        appendCompletedTurn(session, ["u1"], [{ role: "assistant", content: "a1" }], true);
        replaceWithCompactedContext(session, "Summary Phase 1");

        const prefix1 = getSessionContextHistory(session);

        appendCompletedTurn(session, ["u2"], [{ role: "assistant", content: "a2" }], true);
        const prefix2 = getSessionContextHistory(session);

        // prefix2 的前 N 条消息必须与 prefix1 完全一致，保证 100% 命中前缀缓存
        for (let i = 0; i < prefix1.length; i++) {
            expect(prefix2[i]).toEqual(prefix1[i]);
        }
    });
});

describe("autoCompactIfNeeded 自动压缩流程与熔断 (Auto-compaction & Circuit Breaker)", () => {
    test("低于阈值时不触发压缩", async () => {
        const session = createEmptySession("sess-low-tokens");
        appendCompletedTurn(session, ["短问题"], [{ role: "assistant", content: "短回复" }], true);

        const result = await autoCompactIfNeeded(session, { model: "gpt-4o" });
        expect(result.wasCompacted).toBe(false);
    });

    test("上下文极大时应当触发压缩", async () => {
        const session = createEmptySession("sess-failure-test");

        // 模拟一个极小阈值使得 shouldAutoCompact 为 true
        for (let i = 0; i < 20; i++) {
            appendCompletedTurn(
                session,
                [`Question ${i} with super long detailed requirements `.repeat(100)],
                [{ role: "assistant", content: `Response ${i} with detailed data `.repeat(100)}],
                true,
            );
        }

        // shouldAutoCompact 在上下文极大时为 true
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(true);
    });
});

describe("splitTurnsForCompaction 保留段切分 (Retained Tail Splitting)", () => {
    const longText = (tokens: number) => "a".repeat(Math.round(tokens * 3.5));

    test("显式设置 0 时不保留任何尾部消息", async () => {
        const session = createEmptySession("sess-split-no-tail");
        appendCompletedTurn(session, ["问题 1"], [{ role: "assistant", content: "回复 1" }], true);
        appendCompletedTurn(session, ["问题 2"], [{ role: "assistant", content: "回复 2" }], true);

        const { turnsToCompact, keepFromMessageId } = await splitTurnsForCompaction(session.turns, {
            retainedTailTokens: 0,
        });

        expect(turnsToCompact).toEqual(session.turns);
        expect(keepFromMessageId).toBeUndefined();
    });

    test("失败回合参与压缩规划与估算", async () => {
        const session = createEmptySession("sess-split-failed");
        appendCompletedTurn(session, ["旧问题"], [{ role: "assistant", content: "旧回答" }], true);
        appendCompletedTurn(session, ["失败的问题"], [], true);
        session.turns[1]!.status = "failed";

        const { turnsToCompact } = await splitTurnsForCompaction(session.turns, { retainedTailTokens: 0 });
        expect(turnsToCompact.map(turn => turn.id)).toEqual(session.turns.map(turn => turn.id));
        expect(estimateTurnsTokens(session.turns)).toBeGreaterThan(estimateTurnsTokens([session.turns[0]!]));
    });
    test("预算够时保留完整 turn，切点落在 turn 边界", async () => {
        const session = createEmptySession("sess-split-turns");
        for (let index = 1; index <= 3; index++) {
            appendCompletedTurn(session, [`问题 ${index}`], [{ role: "assistant", content: longText(3_000) }], true);
        }

        const { turnsToCompact, keepFromMessageId } = await splitTurnsForCompaction(session.turns, {
            retainedTailTokens: 5_000,
        });

        // 尾部两个 turn 才够 5k 预算：保留 turn2/turn3，只压 turn1
        expect(turnsToCompact).toHaveLength(1);
        expect(keepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);
    });

    test("尾部单个 turn 超预算时在 turn 内细切，切点不是 tool 消息", async () => {
        const session = createEmptySession("sess-split-inside");
        appendCompletedTurn(session, ["早期问题"], [{ role: "assistant", content: longText(3_000) }], true);
        appendCompletedTurn(session, ["晚期问题"], [
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
            } as any,
            { role: "tool", tool_call_id: "call_1", name: "read", content: longText(6_000) } as any,
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{}" } }],
            } as any,
            { role: "tool", tool_call_id: "call_2", name: "read", content: longText(6_000) } as any,
        ], true);

        const { keepFromMessageId } = await splitTurnsForCompaction(session.turns, { retainedTailTokens: 7_000 });

        // 从尾部累到 7k 会停在第一条 tool 结果上，必须回退到它所属的 assistant(tool_calls)
        const messages = session.turns[1]!.messages;
        const start = messages.findIndex(message => message.id === keepFromMessageId);
        expect(start).toBe(1);
        expect(messages[start]!.role).toBe("assistant");

        // 用这个边界拼上下文：工具配对完整，不会出现合成的「工具调用被中断」占位
        replaceWithCompactedContext(session, "SUMMARY", { keepFromMessageId });
        const context = getSessionContextHistory(session);
        expect(JSON.stringify(context)).not.toContain("工具调用被中断");
        const declared = new Set(
            context
                .filter((message: any) => message.role === "assistant")
                .flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => call.id)),
        );
        const results = context.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((id: string) => declared.has(id))).toBe(true);
    });
});
