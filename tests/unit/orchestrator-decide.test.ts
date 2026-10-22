/**
 * 回合决策的表驱动测试。
 *
 * 这些组合在原实现里散落在 `while(true)` 的多个 continue/break 中，无法单独验证；
 * 收敛成纯函数后，每个终态与每个重试边界都能直接断言。
 */

import { describe, expect, test } from "bun:test";
import {
    decideNext,
    MAX_EMPTY_RESPONSE_RETRIES,
    MAX_LENGTH_RETRIES,
    nextCounters,
    type DecisionInput,
    type TurnCounters,
} from "../../src/tools/orchestrator/decide.js";

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
    return {
        finishReason: "stop",
        content: "",
        toolCallCount: 0,
        counters: { emptyResponse: 0, lengthRetry: 0 },
        ...overrides,
    };
}

describe("provider 显式失败优先于一切", () => {
    test("content_filter 直接失败，即使带工具调用也不重试", () => {
        const decision = decideNext(input({ finishReason: "content_filter", toolCallCount: 3 }));
        expect(decision.kind).toBe("fail");
        expect((decision as any).reason).toBe("content_filter");
    });

    test("error 直接失败", () => {
        expect(decideNext(input({ finishReason: "error" })).kind).toBe("fail");
    });
});

describe("length 截断", () => {
    test("无工具调用时重试，计数未达上限", () => {
        const decision = decideNext(input({ finishReason: "length", counters: { emptyResponse: 0, lengthRetry: 0 } }));
        expect(decision.kind).toBe("retry_length");
    });

    test("达到重试上限后失败", () => {
        const decision = decideNext(input({
            finishReason: "length",
            counters: { emptyResponse: 0, lengthRetry: MAX_LENGTH_RETRIES },
        }));
        expect(decision.kind).toBe("fail");
        expect((decision as any).message).toContain("超长");
    });

    test("带工具调用时走工具流程，不算截断重试", () => {
        const decision = decideNext(input({ finishReason: "length", toolCallCount: 1 }));
        expect(decision.kind).toBe("run_tools");
    });
});

describe("空响应重试", () => {
    test("首轮空响应附带提示", () => {
        const decision = decideNext(input({ counters: { emptyResponse: 0, lengthRetry: 0 } }));
        expect(decision).toEqual({ kind: "retry_empty", appendPrompt: true });
    });

    test("后续空响应重试不再附带提示", () => {
        const decision = decideNext(input({ counters: { emptyResponse: 1, lengthRetry: 0 } }));
        expect(decision).toEqual({ kind: "retry_empty", appendPrompt: false });
    });

    test("超过重试上限后以空内容结束", () => {
        const decision = decideNext(input({ counters: { emptyResponse: MAX_EMPTY_RESPONSE_RETRIES, lengthRetry: 0 } }));
        expect(decision).toEqual({ kind: "done", content: "" });
    });
});

describe("正常结束", () => {
    test("有文本且无工具调用时结束", () => {
        expect(decideNext(input({ content: "完成" }))).toEqual({ kind: "done", content: "完成" });
    });

    test("有工具调用时执行工具", () => {
        expect(decideNext(input({ toolCallCount: 2 })).kind).toBe("run_tools");
    });

    test("有工具调用时即便同时有文本也先执行工具", () => {
        expect(decideNext(input({ content: "先说明", toolCallCount: 1 })).kind).toBe("run_tools");
    });
});

describe("计数结算", () => {
    const zero: TurnCounters = { emptyResponse: 0, lengthRetry: 0 };

    test("空响应重试只递增自己的计数", () => {
        expect(nextCounters(zero, { kind: "retry_empty", appendPrompt: true }))
            .toEqual({ emptyResponse: 1, lengthRetry: 0 });
    });

    test("长度重试不污染空响应计数", () => {
        expect(nextCounters(zero, { kind: "retry_length" }))
            .toEqual({ emptyResponse: 0, lengthRetry: 1 });
    });

    test("终态与工具分支不改变计数", () => {
        expect(nextCounters(zero, { kind: "done", content: "x" })).toBe(zero);
        expect(nextCounters(zero, { kind: "run_tools" })).toBe(zero);
    });
});

describe("两类重试互不干扰", () => {
    test("长度重试若干次后遇到空响应，空响应计数仍从 0 起算", () => {
        let counters: TurnCounters = { emptyResponse: 0, lengthRetry: 0 };

        counters = nextCounters(counters, decideNext(input({ finishReason: "length", counters })));
        expect(counters).toEqual({ emptyResponse: 0, lengthRetry: 1 });

        counters = nextCounters(counters, decideNext(input({ counters })));
        expect(counters).toEqual({ emptyResponse: 1, lengthRetry: 1 });

        // 空响应首次重试才带提示
        expect(decideNext(input({ counters }))).toEqual({ kind: "retry_empty", appendPrompt: false });
    });
});
