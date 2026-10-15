import { describe, expect, test } from "bun:test";
import type { UsageInfo } from "../types/chat.js";
import { addTokenUsage, computeSessionRate, resetTokenUsage } from "./store-usage.js";
import { createSessionUiState, type SessionUiState } from "./store-types.js";

const usageOf = (partial: Partial<UsageInfo> = {}): UsageInfo => ({
    model: "deepseek-v4-flash",
    promptTokens: 100,
    cacheHitTokens: 0,
    cacheMissTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    totalTokens: 150,
    durationMs: 0,
    ...partial,
});

describe("addTokenUsage", () => {
    test("累计各 token 明细与 latestPromptTokens", () => {
        const state = createSessionUiState();
        addTokenUsage(state, usageOf({ latestPromptTokens: 80 }), 0);
        addTokenUsage(state, usageOf({ promptTokens: 10, completionTokens: 5, totalTokens: 15, latestPromptTokens: 20 }), 0);

        expect(state.promptTokens).toBe(110);
        expect(state.completionTokens).toBe(55);
        expect(state.totalTokens).toBe(165);
        expect(state.latestPromptTokens).toBe(20);
    });

    test("缺省 latestPromptTokens 时回落到 promptTokens", () => {
        const state = createSessionUiState();
        addTokenUsage(state, usageOf({ promptTokens: 42 }), 0);

        expect(state.latestPromptTokens).toBe(42);
    });

    test("costFor 只累加有限正值", () => {
        const state = createSessionUiState();
        const costs = [1.5, Number.NaN, -3, Number.POSITIVE_INFINITY];
        let index = 0;
        addTokenUsage(state, usageOf(), 0, () => costs[index++]!);

        expect(state.costYuan).toBeCloseTo(1.5, 10);
    });

    test("上游不给输入 token 时用估算兜底 latestPromptTokens", () => {
        const state = createSessionUiState();
        addTokenUsage(state, usageOf({ promptTokens: 0, cacheMissTokens: 0, estimatedPromptTokens: 3200 }), 0);

        expect(state.latestPromptTokens).toBe(3200);
    });
});

describe("computeSessionRate", () => {
    test("无耗时返回 undefined", () => {
        const state = createSessionUiState();

        expect(computeSessionRate(state, usageOf({ durationMs: 0 }), 0)).toBeUndefined();
    });

    test("按首包时间切分思考与输出阶段", () => {
        const state = createSessionUiState();
        state.requestStartedAt = 0;
        state.firstReasoningAt = 100;
        state.firstTextAt = 600;

        const rate = computeSessionRate(state, usageOf({ reasoningTokens: 200, completionTokens: 300, durationMs: 1000 }), 1000);

        // 总：300 completion / 1000ms；思考 200 token / 500ms；输出 100 token / 400ms
        expect(rate?.totalTps).toBeCloseTo(300, 5);
        expect(rate?.reasoningTps).toBeCloseTo(400, 5);
        expect(rate?.outputTps).toBeCloseTo(250, 5);
    });

    test("纯工具调用轮只计入总速率，不污染阶段速率", () => {
        const state = createSessionUiState();
        state.requestStartedAt = 0;
        state.firstTextAt = 900;

        const rate = computeSessionRate(state, usageOf({ reasoningTokens: 0, completionTokens: 100, durationMs: 1000 }), 1000);

        expect(rate?.totalTps).toBeCloseTo(100, 5);
        expect(rate?.reasoningTps).toBeUndefined();
        // 无 reasoning delta：输出 token 仍按 text 首包到请求结束切分
        expect(rate?.outputTps).toBeCloseTo(1000, 5);
    });

    test("多次请求 token 与耗时成对累计", () => {
        const state = createSessionUiState();
        addTokenUsage(state, usageOf({ completionTokens: 100, durationMs: 1000 }), 0);
        addTokenUsage(state, usageOf({ completionTokens: 300, durationMs: 1000 }), 0);

        expect(state.lastRate?.totalTps).toBeCloseTo(200, 5);
        expect(state.lastRate?.completionTokens).toBe(400);
    });

    test("累计型上游的生成速率改用 outputTokens 估算", () => {
        const state = createSessionUiState();
        state.requestStartedAt = 0;
        state.firstTextAt = 500;

        // completionTokens 是差分出的「本请求新增（含输入）」，速率分子不能被它带偏
        const rate = computeSessionRate(
            state,
            usageOf({ completionTokens: 5000, reasoningTokens: 0, outputTokens: 200, durationMs: 1000 }),
            1000,
        );

        // 总速率同样取估算生成量：200 token / 1000ms
        expect(rate?.totalTps).toBeCloseTo(200, 5);
        expect(rate?.outputTps).toBeCloseTo(400, 5);
    });
});

describe("resetTokenUsage", () => {
    test("清空全部累计字段与阶段时间戳", () => {
        const state: SessionUiState = createSessionUiState();
        addTokenUsage(state, usageOf({ durationMs: 500 }), 0);
        state.requestStartedAt = 1;
        state.firstReasoningAt = 2;
        state.firstTextAt = 3;

        resetTokenUsage(state);

        expect(state.totalTokens).toBe(0);
        expect(state.costYuan).toBe(0);
        expect(state.lastRate).toBeUndefined();
        expect(state.summedDurationMs).toBe(0);
        expect(state.requestStartedAt).toBeUndefined();
        expect(state.firstReasoningAt).toBeUndefined();
        expect(state.firstTextAt).toBeUndefined();
    });
});
