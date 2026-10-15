import { describe, expect, test } from "bun:test";
import { buildStatusBarModel, type StatusBarInput } from "./status-bar-model.js";

const inputOf = (partial: Partial<StatusBarInput> = {}): StatusBarInput => ({
    modelName: "deepseek-v4-flash",
    effort: "auto",
    sessionId: "s1",
    spinnerIndex: 0,
    now: 0,
    latestPromptTokens: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costYuan: 0,
    cwd: "/tmp",
    isChatObserver: false,
    contextWindow: 1_310_720,
    ...partial,
});

describe("buildStatusBarModel token 统计", () => {
    test("输入侧 token 不可得时不显示 0=>", () => {
        const model = buildStatusBarModel(inputOf({ completionTokens: 1234, totalTokens: 1234 }));

        expect(model.line2.left).toContain("Σ1.2k");
        expect(model.line2.left).toContain("→1.2k");
        expect(model.line2.left).not.toContain("0=>");
    });

    test("有输入侧 token 时保持 输入=>输出", () => {
        const model = buildStatusBarModel(inputOf({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }));

        expect(model.line2.left).toContain("100=>50");
    });

    test("估算的 latestPromptTokens 参与上下文占用展示", () => {
        const model = buildStatusBarModel(inputOf({ latestPromptTokens: 131_072, contextWindow: 1_310_720 }));

        expect(model.line2.left).toContain("131.1k/1.31M(10.0%)");
    });
});
