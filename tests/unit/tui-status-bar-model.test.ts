/**
 * 状态栏模型单测：纯函数，注入时间与数值，断言两行文本。
 */

import { describe, expect, test } from "bun:test";
import { buildStatusBarModel, formatRateTag, type StatusBarInput } from "../../src/tui/status-bar-model.js";

/** 去掉 CSI 颜色与 OSC 超链接，只看可见文本。 */
function plain(text: string): string {
    return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function input(overrides: Partial<StatusBarInput> = {}): StatusBarInput {
    return {
        modelName: "deepseek-chat",
        effort: "high",
        sessionId: "sess-abcdef123456",
        spinnerIndex: 0,
        now: 1_000_000,
        latestPromptTokens: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costYuan: 0,
        cwd: "/workspace/project",
        isChatObserver: false,
        isDeepSeekPriced: false,
        contextWindow: 0,
        ...overrides,
    };
}

describe("状态栏模型", () => {
    test("无 token 统计时第二行左为空，右侧显示会话 id", () => {
        const model = buildStatusBarModel(input());

        expect(plain(model.line1.left)).toContain("deepseek-chat · 🧠 high");
        expect(model.line2.left).toBe("");
        expect(plain(model.line2.right)).toBe("sess-abcdef123456");
    });

    test("无会话时显示「无会话」", () => {
        const model = buildStatusBarModel(input({ sessionId: null }));

        expect(plain(model.line2.right)).toBe("无会话");
    });

    test("Token 统计逐项出现：上下文占用 / 累计 / 输入输出 / 思考 / 缓存", () => {
        const model = buildStatusBarModel(input({
            latestPromptTokens: 12_000,
            contextWindow: 64_000,
            totalTokens: 34_000,
            promptTokens: 20_000,
            completionTokens: 14_000,
            reasoningTokens: 5_000,
            cacheHitTokens: 8_000,
            cacheMissTokens: 2_000,
        }));
        const text = plain(model.line2.left);

        expect(text).toContain("12k/64k(18.8%)");
        expect(text).toContain("Σ34k");
        expect(text).toContain("20k=>14k");
        expect(text).toContain("🤔5k");
        expect(text).toContain("🎯80.0%(8k/2k)");
    });

    test("执行阶段提示与工具耗时", () => {
        const reasoning = buildStatusBarModel(input({
            phase: { phase: "reasoning", startTime: 999_000 },
        }));
        expect(plain(reasoning.line1.right)).toContain("思考中");

        const tool = buildStatusBarModel(input({
            phase: { phase: "tool", toolName: "bash", startTime: 990_000, toolStartTime: 995_000 },
        }));
        const text = plain(tool.line1.right);
        expect(text).toContain("执行工具 bash");
        expect(text).toContain("5.0s | 10.0s");
    });

    test("DeepSeek 峰谷倒计时：有 token 时用 · 分隔，无统计时不出现孤立分隔点", () => {
        const withTokens = buildStatusBarModel(input({
            isDeepSeekPriced: true,
            deepSeek: { phase: "peak", switchInMs: 90 * 60_000 },
            totalTokens: 1_000,
        }));
        expect(plain(withTokens.line2.left)).toContain(" · 高峰剩");

        const noTokens = buildStatusBarModel(input({
            isDeepSeekPriced: true,
            deepSeek: { phase: "offpeak", switchInMs: 30 * 60_000 },
        }));
        const text = plain(noTokens.line2.left);
        expect(text).toContain("空闲剩");
        expect(text.trimStart().startsWith("·")).toBe(false);
    });

    test("速率标签：请求进行中置灰", () => {
        const rate = { totalTps: 45.4, outputTps: 10.2, reasoningTps: 35.1 };
        expect(plain(formatRateTag(rate, false))).toBe("⚡45T/s (🤔35 ✏️10)");
        expect(formatRateTag(rate, true)).not.toBe(formatRateTag(rate, false));
        expect(formatRateTag(rate, true)).toContain("\x1b[2m");
    });

    test("有提问在等作答时第 1 行右侧提示（提问不一定在当前会话上）", () => {
        const asking = buildStatusBarModel(input({ awaitingAnswer: 2 }));
        expect(plain(asking.line1.right)).toContain("❓2 待作答");

        const idle = buildStatusBarModel(input());
        expect(plain(idle.line1.right)).not.toContain("待作答");
    });
});
