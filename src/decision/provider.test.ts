/**
 * provider 的网络行为测试：用注入的假 axios 实例，不打真实网络。
 */

import { describe, expect, test } from "bun:test";
import type { AxiosInstance } from "axios";
import { DecisionError } from "./errors.js";
import { DecisionProvider } from "./provider.js";
import type { DecisionRequest } from "./types.js";

const REQUEST: DecisionRequest = {
    state: "payouts failing",
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
};

function okBody() {
    return {
        model: "d1",
        answers: { urgent: { type: "noul", noul: 0.97 } },
        usage: { input_tokens: 40, output_tokens: 0, cost: 8e-7 },
    };
}

/** 按预设序列返回响应的假 axios。 */
function fakeHttp(responses: Array<{ status: number; data: unknown; headers?: Record<string, string> }>): AxiosInstance {
    let index = 0;
    return {
        post: async () => {
            const resp = responses[Math.min(index, responses.length - 1)];
            index++;
            return { status: resp.status, data: resp.data, headers: resp.headers ?? {} };
        },
    } as unknown as AxiosInstance;
}

function provider(responses: Parameters<typeof fakeHttp>[0], maxRetries = 2): DecisionProvider {
    return new DecisionProvider("test", {
        baseUrl: "https://example.test",
        apiKey: "k",
        model: "d1",
        backoffMs: 1,
        maxRetries,
        http: fakeHttp(responses),
    });
}

describe("DecisionProvider", () => {
    test("成功路径归一化 usage 与 answers", async () => {
        const p = provider([{ status: 200, data: okBody() }]);
        const result = await p.decide(REQUEST);
        expect(result.model).toBe("d1");
        expect(result.usage.input_tokens).toBe(40);
        expect(result.usage.cost).toBeCloseTo(8e-7);
        expect(result.retries).toBe(0);
    });

    test("422 不重试，直接抛出", async () => {
        const p = provider([
            { status: 422, data: { error: { message: "bad criteria" } } },
        ]);
        const err = await p.decide(REQUEST).catch((e) => e);
        expect(err).toBeInstanceOf(DecisionError);
        expect((err as DecisionError).status).toBe(422);
        expect((err as DecisionError).retriable).toBe(false);
    });

    test("429 重试后成功", async () => {
        const p = provider([
            { status: 429, data: { error: { message: "slow down" } }, headers: { "retry-after": "0" } },
            { status: 200, data: okBody() },
        ]);
        const result = await p.decide(REQUEST);
        expect(result.retries).toBe(1);
    });

    test("重试耗尽后抛出最后一次错误", async () => {
        const p = provider([{ status: 500, data: { error: { message: "boom" } } }], 1);
        const err = await p.decide(REQUEST).catch((e) => e);
        expect((err as DecisionError).status).toBe(500);
    });

    test("响应缺少 answers 时报错", async () => {
        const p = provider([{ status: 200, data: { model: "d1" } }]);
        const err = await p.decide(REQUEST).catch((e) => e);
        expect(err).toBeInstanceOf(DecisionError);
        expect((err as Error).message).toContain("answers");
    });
});

