import { describe, expect, test } from "bun:test";
import {
    appendTimelineText,
    appendTimelineTextToList,
    createMessage,
    findLastTextItem,
    insertMessage,
    syncTimelineFinalText,
} from "./store-message.js";
import type { AssistantTimelineItem, ToolBlock, UiMessage } from "./store-types.js";

const messageOf = (partial: Partial<UiMessage> = {}): UiMessage => ({
    id: 1,
    role: "assistant",
    text: "",
    streaming: false,
    sortKey: 0,
    ...partial,
});

const blockOf = (partial: Partial<ToolBlock> = {}): ToolBlock => ({
    id: 1,
    requestId: 1,
    toolId: 1,
    name: "read",
    expanded: false,
    text: "",
    ...partial,
});

describe("createMessage", () => {
    test("id 取自注入的序列器，streaming 默认 false", () => {
        let seq = 0;
        const first = createMessage(() => ++seq, { role: "user", text: "hi" });
        const second = createMessage(() => ++seq, { role: "system", text: "ok" });

        expect(first).toMatchObject({ id: 1, role: "user", text: "hi", streaming: false });
        expect(second.id).toBe(2);
    });

    test("透传 streaming 与 chat 元数据", () => {
        const chat = { roomId: "g1", mentioned: true, sender: "alice" };
        const message = createMessage(() => 7, { role: "system", text: "x", streaming: true, chat });

        expect(message.streaming).toBe(true);
        expect(message.chat).toEqual(chat);
    });
});

describe("insertMessage", () => {
    test("流式消息恒为末位：新消息插到它之前", () => {
        const messages: UiMessage[] = [
            messageOf({ id: 1, sortKey: 100 }),
            messageOf({ id: 2, sortKey: 200, streaming: true }),
        ];

        insertMessage(messages, messageOf({ id: 3, sortKey: 300 }));

        expect(messages.map(message => message.id)).toEqual([1, 3, 2]);
    });

    test("无流式消息时按 sortKey 升序插入", () => {
        const messages: UiMessage[] = [
            messageOf({ id: 1, sortKey: 100 }),
            messageOf({ id: 2, sortKey: 300 }),
        ];

        insertMessage(messages, messageOf({ id: 3, sortKey: 200 }));

        expect(messages.map(message => message.id)).toEqual([1, 3, 2]);
    });
});

describe("appendTimelineTextToList", () => {
    test("同类型相邻片段合并，不新增条目", () => {
        const timeline: AssistantTimelineItem[] = [];
        appendTimelineTextToList(timeline, "text", "ab");
        appendTimelineTextToList(timeline, "text", "cd");

        expect(timeline).toEqual([{ type: "text", text: "abcd" }]);
    });

    test("类型切换时新建条目，reasoning 带 renderedOffset 初值", () => {
        const timeline: AssistantTimelineItem[] = [];
        appendTimelineTextToList(timeline, "text", "正文");
        appendTimelineTextToList(timeline, "reasoning", "思考");

        expect(timeline).toHaveLength(2);
        expect(timeline[1]).toEqual({ type: "reasoning", text: "思考", renderedOffset: 0 });
    });

    test("空文本忽略", () => {
        const timeline: AssistantTimelineItem[] = [];
        appendTimelineTextToList(timeline, "text", "");

        expect(timeline).toHaveLength(0);
    });
});

describe("appendTimelineText", () => {
    test("惰性初始化 timeline 并追加", () => {
        const message = messageOf();
        appendTimelineText(message, "text", "hi");

        expect(message.timeline).toEqual([{ type: "text", text: "hi" }]);
    });
});

describe("syncTimelineFinalText", () => {
    test("增量与最终 content 一致时保留原有分段", () => {
        const message = messageOf({
            timeline: [
                { type: "reasoning", text: "想", renderedOffset: 0 },
                { type: "text", text: "abc" },
            ],
        });
        syncTimelineFinalText(message, "abc");

        expect(message.timeline).toHaveLength(2);
    });

    test("不一致时用 content 校正首段文本，其余段原地清空", () => {
        const message = messageOf({
            timeline: [
                { type: "text", text: "ab" },
                { type: "reasoning", text: "想", renderedOffset: 0 },
                { type: "text", text: "c" },
            ],
        });
        syncTimelineFinalText(message, "abcd");

        // 首段文本原位写回 content；其余文本段原地清空（不删、不重建数组），reasoning 位置不变
        expect(message.timeline).toHaveLength(3);
        expect(message.timeline[0]).toEqual({ type: "text", text: "abcd" });
        expect(message.timeline[1]).toMatchObject({ type: "reasoning", text: "想" });
        expect(message.timeline[2]).toEqual({ type: "text", text: "" });
    });

    test("工具块在前的文本片段保持原位，不整体挪到开头", () => {
        const message = createMessage(() => 1, { role: "assistant", text: "x" });
        message.timeline = [
            { type: "tool", block: { id: 1, requestId: 1, toolId: 1, name: "bash", expanded: false, text: "" } },
            { type: "text", text: "before" },
            { type: "text", text: " after" },
        ];
        // content 与增量拼接不一致（模拟丢 chunk），触发对账
        syncTimelineFinalText(message, "beforeafter-final");
        // 首段文本位置（工具块之后）保留，其余文本段原地清空
        expect(message.timeline[0]).toMatchObject({ type: "tool" });
        expect(message.timeline[1]).toEqual({ type: "text", text: "beforeafter-final" });
        expect(message.timeline[2]).toEqual({ type: "text", text: "" });
    });

    // 工具循环多轮的实测 bug（2026-09-10）：最终回复不能回填到工具调用之前的正文段。
    test("fromIndex 限定本轮范围：工具轮之前的正文段不受对账影响", () => {
        const message = createMessage(() => 1, { role: "assistant", text: "x" });
        message.timeline = [
            { type: "text", text: "我先看看" },
            { type: "tool", block: blockOf() },
            { type: "text", text: "最终回" },
        ];
        syncTimelineFinalText(message, "最终回复", 2);

        expect(message.timeline[0]).toEqual({ type: "text", text: "我先看看" });
        expect(message.timeline[2]).toEqual({ type: "text", text: "最终回复" });
    });

    test("本轮没有任何正文段时在末尾补一段（与重放侧口径一致）", () => {
        const message = messageOf({ timeline: [{ type: "reasoning", text: "想", renderedOffset: 0 }] });
        syncTimelineFinalText(message, "内容");
        expect(message.timeline).toEqual([
            { type: "reasoning", text: "想", renderedOffset: 0 },
            { type: "text", text: "内容" },
        ]);

        // 本轮范围为空（工具轮之后还没出字）：补在末尾，不动工具轮之前的正文
        const afterTool = messageOf({
            timeline: [
                { type: "text", text: "我先看看" },
                { type: "tool", block: blockOf() },
            ],
        });
        syncTimelineFinalText(afterTool, "最终回复", 2);
        expect(afterTool.timeline).toEqual([
            { type: "text", text: "我先看看" },
            { type: "tool", block: blockOf() },
            { type: "text", text: "最终回复" },
        ]);
    });

    test("findLastTextItem 取最后一条文本片段", () => {
        const timeline: AssistantTimelineItem[] = [
            { type: "text", text: "first" },
            { type: "tool", block: blockOf() },
            { type: "text", text: "last" },
        ];
        expect(findLastTextItem(timeline)?.text).toBe("last");
        expect(findLastTextItem([{ type: "tool", block: blockOf() }])).toBeUndefined();
        expect(findLastTextItem(undefined)).toBeUndefined();
    });

    test("findLastTextItem 跳过被清空的尾段（不影响折叠态渲染哪一段）", () => {
        const timeline: AssistantTimelineItem[] = [
            { type: "text", text: "最终回复" },
            { type: "text", text: "" },
        ];
        expect(findLastTextItem(timeline)?.text).toBe("最终回复");
    });

    test("content 为空时不改动", () => {
        const withText = messageOf({ timeline: [{ type: "text", text: "ab" }] });
        syncTimelineFinalText(withText, "");
        expect(withText.timeline).toEqual([{ type: "text", text: "ab" }]);
    });
});

