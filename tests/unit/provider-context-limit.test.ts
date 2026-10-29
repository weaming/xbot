/**
 * 上游超窗口径识别：不同 provider 的 400 文案不同，
 * 漏识别会让「越窗后压缩重试」完全失效，回合直接以 400 结束。
 */

import { describe, expect, test } from "bun:test";
import { getPromptTooLongLimit, isInvalidAssistantMessageError } from "../../src/utils/provider-context-limit.js";

const deepseekOverflow = new Error(
    "LLM provider 请求失败（HTTP 400）：400 This model's maximum context length is 1048576 tokens. "
    + "However, you requested 1064363 tokens (1064363 in the messages, 0 in the completion). "
    + "Please reduce the length of the messages or completion.",
);

describe("getPromptTooLongLimit", () => {
    test("OpenAI / DeepSeek 文案返回模型窗口上限", () => {
        expect(getPromptTooLongLimit(deepseekOverflow)).toBe(1_048_576);
    });

    test("Anthropic 文案返回窗口上限", () => {
        const error = Object.assign(new Error("prompt is too long: 208,310 tokens > 200,000 maximum"), { status: 400 });
        expect(getPromptTooLongLimit(error)).toBe(200_000);
    });

    test("请求量未超上限或不是 400 时不算越窗", () => {
        expect(getPromptTooLongLimit(
            new Error("400 maximum context length is 1048576 tokens. However, you requested 1000 tokens"),
        )).toBeUndefined();
        expect(getPromptTooLongLimit(
            new Error("500 maximum context length is 1048576 tokens. However, you requested 1064363 tokens"),
        )).toBeUndefined();
        expect(getPromptTooLongLimit(new Error("network timeout"))).toBeUndefined();
    });

    test("空 assistant 消息的 400 仍走各自的识别分支", () => {
        expect(isInvalidAssistantMessageError(
            new Error("400 Invalid assistant message: content or tool_calls must be set"),
        )).toBe(true);
        expect(isInvalidAssistantMessageError(deepseekOverflow)).toBe(false);
    });
});
