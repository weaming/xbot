import { describe, expect, test } from "bun:test";

import { extractCitations } from "../../src/tools/orchestrator/citations.js";
import { stripResponsesMetadata } from "../../src/tools/orchestrator/messages.js";
import type { ChatMessage } from "../../src/types/session.js";

/** 托管 web_search 的引用：Responses 挂在 part.annotations，Chat 投影到 message.annotations。 */

const responsesMessage = {
    role: "assistant",
    content: "今天有三条新闻。",
    response_output: [
        { type: "reasoning", id: "rs_1" },
        { type: "web_search_call", id: "ws_1", action: { type: "search", queries: ["AI news"] } },
        {
            type: "message",
            role: "assistant",
            content: [{
                type: "output_text",
                text: "今天有三条新闻。",
                annotations: [
                    { type: "url_citation", url: "https://a.example/1", title: "A", start_index: 0, end_index: 9 },
                    { type: "url_citation", url: "https://b.example/2", title: "B", start_index: 10, end_index: 20 },
                    { type: "url_citation", url: "https://a.example/1", title: "A 重复" },
                ],
            }],
        },
    ],
};

describe("extractCitations", () => {
    test("从 Responses output 的 annotations 提取并按 URL 去重", () => {
        expect(extractCitations(responsesMessage)).toEqual([
            { url: "https://a.example/1", title: "A", startIndex: 0, endIndex: 9 },
            { url: "https://b.example/2", title: "B", startIndex: 10, endIndex: 20 },
        ]);
    });

    test("从 Chat 消息级 annotations 提取（网关投影形态）", () => {
        expect(extractCitations({
            role: "assistant",
            content: "正文",
            annotations: [{ type: "url_citation", url: "https://c.example/3?utm_source=openai&id=7", title: "C" }],
        })).toEqual([{ url: "https://c.example/3?id=7", title: "C" }]);
    });

    test("移除任意值的 utm_source，保留其他查询参数", () => {
        expect(extractCitations({
            annotations: [
                { url: "https://a.example/?utm_source=openai&x=1" },
                { url: "https://b.example/?utm_source=partner&x=1" },
            ],
        })).toEqual([
            { url: "https://a.example/?x=1" },
            { url: "https://b.example/?x=1" },
        ]);
    });

    test("没有 annotations 或没有 url 时返回空", () => {
        expect(extractCitations({ role: "assistant", content: "无引用" })).toEqual([]);
        expect(extractCitations({ annotations: [{ type: "file_citation", file_id: "f_1" }] })).toEqual([]);
    });

    test("web_search_call 的来源：兼容 action.sources 与 results，仍按 URL 去重", () => {
        expect(extractCitations({
            role: "assistant",
            content: "正文",
            response_output: [
                {
                    type: "web_search_call",
                    id: "ws_1",
                    action: {
                        type: "search",
                        sources: [
                            { type: "url", url: "https://a.example/1?utm_source=openai", title: "A" },
                            { url: "https://a.example/1" },
                        ],
                        results: [{ url: "https://b.example/2", title: "B" }],
                    },
                },
                {
                    type: "message",
                    content: [{ type: "output_text", text: "正文", annotations: [{ url: "https://b.example/2" }] }],
                },
            ],
        })).toEqual([
            // 正文注解先出现（带位置/标题），搜索来源补齐其余 URL
            { url: "https://b.example/2" },
            { url: "https://a.example/1", title: "A" },
        ]);
    });

    test("DeepSeek 形态：annotations 为空，来源取 open_page 的 url 并去掉 ws_call_id 标记", () => {
        // 结构取样自 deepseek-v4-pro 的真实流式响应
        expect(extractCitations({
            role: "assistant",
            content: "最近 24 小时内两条重要 AI 新闻……",
            response_output: [
                { type: "reasoning", id: "rs_1" },
                {
                    type: "web_search_call",
                    id: "call_00_abc",
                    status: "completed",
                    action: { type: "search", queries: ["AI news last 24 hours"] },
                },
                {
                    type: "web_search_call",
                    id: "call_01_abc",
                    status: "completed",
                    action: { type: "open_page", url: "https://www.yicai.com/news/103407983.html#ws_call_id=call_01_abc" },
                },
                {
                    type: "web_search_call",
                    id: "call_02_abc",
                    status: "failed",
                    action: { type: "open_page", url: "https://tv.cctv.com/2026/10/26/VIDE.shtml#ws_call_id=call_02_abc" },
                },
                {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "最近 24 小时内两条重要 AI 新闻……", annotations: [] }],
                },
            ],
        })).toEqual([
            { url: "https://www.yicai.com/news/103407983.html" },
            { url: "https://tv.cctv.com/2026/10/26/VIDE.shtml" },
        ]);
    });

    test("超过上限时截断", () => {
        const many = {
            annotations: Array.from({ length: 20 }, (_, index) => ({
                type: "url_citation",
                url: `https://d.example/${index}`,
            })),
        };
        expect(extractCitations(many)).toHaveLength(12);
    });
});

describe("stripResponsesMetadata", () => {
    test("citations 属于本地渲染事实，不上行", () => {
        const stored = { ...responsesMessage, citations: extractCitations(responsesMessage) };
        const messages = [stored, { role: "user", content: "继续" }] as unknown as ChatMessage[];
        const stripped = stripResponsesMetadata(messages);

        expect("response_output" in (stripped[0] as any)).toBe(false);
        expect("citations" in (stripped[0] as any)).toBe(false);
        expect((stripped[0] as any).content).toBe("今天有三条新闻。");
        expect(stripped[1]).toEqual({ role: "user", content: "继续" });
    });
});
