/**
 * 引用来源的实时投影与重放投影必须一致：
 *   - 实时：citations UIEvent → applyAgentEvent
 *   - 重放：持久化 message.citations → projectHistory
 * 两条路径都要在正文之后产出一条 sources 段。
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import type { UIEvent } from "../events/ui-events.js";
import type { Citation } from "../types/session.js";
import { applyAgentEvent, type ProjectionDeps } from "./store-projector.js";
import { projectHistory } from "./store-history.js";
import { createSessionUiState, type AssistantTimelineItem, type SessionUiState } from "./store-types.js";

const TURN_ID = "turn-1";
const CITATIONS: Citation[] = [
    { url: "https://a.example/1", title: "A", startIndex: 0, endIndex: 9 },
    { url: "https://b.example/2", title: "B", startIndex: 10, endIndex: 20 },
];

function makeDeps(): ProjectionDeps {
    let messageId = 0;
    let blockId = 0;
    return {
        nextMessageId: () => ++messageId,
        nextBlockId: () => ++blockId,
        notifyMessages: () => {},
        notifyStatus: () => {},
    };
}

function sourcesOf(state: SessionUiState): Citation[] {
    const assistant = state.messages.find(message => message.role === "assistant");
    const items = (assistant?.timeline ?? []).filter(
        (item): item is Extract<AssistantTimelineItem, { type: "sources" }> => item.type === "sources",
    );
    expect(items).toHaveLength(1);
    return items[0]!.items;
}

test("实时：citations 事件追加到正文之后", () => {
    const state = createSessionUiState();
    const deps = makeDeps();
    const events: UIEvent[] = [
        { type: "turn_start", iteration: 1 },
        { type: "text_delta", delta: "今天有三条新闻。" },
        { type: "citations", items: CITATIONS },
        { type: "message_end", content: "今天有三条新闻。", stopReason: "stop" },
    ];
    for (const event of events) applyAgentEvent(state, 1, event, deps);

    const assistant = state.messages.find(message => message.role === "assistant")!;
    expect(assistant.timeline?.map(item => item.type)).toEqual(["text", "sources"]);
    expect(sourcesOf(state)).toEqual(CITATIONS);
});

test("实时：重复下发覆盖而不是堆叠", () => {
    const state = createSessionUiState();
    const deps = makeDeps();
    applyAgentEvent(state, 1, { type: "text_delta", delta: "正文" }, deps);
    applyAgentEvent(state, 1, { type: "citations", items: CITATIONS }, deps);
    applyAgentEvent(state, 1, { type: "citations", items: [CITATIONS[0]!] }, deps);

    expect(sourcesOf(state)).toEqual([CITATIONS[0]!]);
});

test("重放：消息里保存的 citations 投影成同一段", () => {
    const state = createSessionUiState();
    const deps = makeDeps();
    const events: AgentEvent[] = [
        {
            type: "turn_message",
            seq: 1,
            ts: new Date(1_700_000_000_000).toISOString(),
            payload: {
                turnId: TURN_ID,
                message: {
                    id: "m-1",
                    createdAt: new Date(1_700_000_000_000).toISOString(),
                    role: "assistant",
                    content: "今天有三条新闻。",
                    citations: CITATIONS,
                },
            },
        } as AgentEvent,
    ];
    projectHistory(state, events, deps, false);

    expect(sourcesOf(state)).toEqual(CITATIONS);
});
