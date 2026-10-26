/**
 * 真实分词器（DeepSeek V4 tokenizer.json）计数：精度对齐、缓存与回退。
 *
 * preload（tests/unit/env-isolation.ts）默认把 `ZBOT_TOKENIZER` 设为 off，
 * 本文件在用例前清掉该开关，走真实分词路径。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const previousTokenizerMode = process.env.ZBOT_TOKENIZER;

const {
    countTextTokens,
    countTurnsTokens,
    loadTokenizer,
    supportsRealTokenizer,
} = await import("../../src/utils/tokenizer.js");
const { estimateTextTokens } = await import("../../src/utils/token-estimator.js");
const { createEmptySession } = await import("../../src/events/session-replay.js");
const { appendCompletedTurn } = await import("../../src/utils/conversation-history.js");

beforeEach(() => {
    // preload 只在变量缺失时补 off，这里用显式值覆盖（空串在 Bun 里等于删除变量，会把它放回来）
    process.env.ZBOT_TOKENIZER = "on";
});

afterAll(() => {
    process.env.ZBOT_TOKENIZER = previousTokenizerMode ?? "off";
});

describe("真实分词器计数", () => {
    test("词表可加载，计数与官方绑定一致", async () => {
        expect(await loadTokenizer()).not.toBeNull();
        // 同一句在 HF 官方 Python 绑定（tokenizers.Tokenizer.from_file）里也是 21
        expect(await countTextTokens("上下文压缩的触发判定必须准确，否则请求会超过模型窗口并返回 400 错误。"))
            .toBe(21);
    });

    test("启发式在 JSON / 工具结果上低估，真分词纠正", async () => {
        const json = '{"count": 12, "items": [{"id": "01J8Z", "title": "重构 session 模块", "score": 0.87}, {"id": "01J9A", "title": "写测试", "score": 0.51}]}';

        expect(await countTextTokens(json)).toBe(61);
        // 低估方向正是「估算没到阈值、真实请求捅穿窗口」的那类内容
        expect(estimateTextTokens(json)).toBeLessThan(61);
    });

    test("回合计数包含 failed 回合，且按消息 id 复用结果", async () => {
        const session = createEmptySession("sess-tokenizer-turns");
        appendCompletedTurn(session, ["问题"], [{ role: "assistant", content: "回答" }], true);
        appendCompletedTurn(session, ["失败的问题"], [{ role: "assistant", content: "失败的回答" }], false);
        session.turns[1]!.status = "failed";

        const counted = await countTurnsTokens(session.turns);
        // 第二次走缓存，值不变
        expect(await countTurnsTokens(session.turns)).toBe(counted);
        expect(counted).toBeGreaterThan(0);
        const first = await countTurnsTokens([session.turns[0]!]);
        const failed = await countTurnsTokens([session.turns[1]!]);
        expect(failed).toBeGreaterThan(0);
        expect(counted).toBe(first + failed);
    });

    test("非 DeepSeek 模型回退启发式（各家 tokenizer 不同）", async () => {
        expect(supportsRealTokenizer("deepseek-chat")).toBe(true);
        expect(supportsRealTokenizer("gemini-2.5-pro")).toBe(false);

        const text = "上下文压缩的触发判定";
        expect(await countTextTokens(text, "gemini-2.5-pro")).toBe(estimateTextTokens(text));
    });

    test("ZBOT_TOKENIZER=off 时整体回退启发式", async () => {
        process.env.ZBOT_TOKENIZER = "off";
        const text = "上下文压缩的触发判定";
        expect(await countTextTokens(text)).toBe(estimateTextTokens(text));
    });
});
