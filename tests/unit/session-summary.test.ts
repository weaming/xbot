import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../../src/events/agent-events.js";
import { summarizeEvents } from "../../src/host/session-host.js";

const SESSION_ID = "01J00000000000000000000000";

function userMessage(seq: number, text: string): AgentEvent {
    return { seq, ts: "2026-01-01T00:00:00+08:00", sessionId: SESSION_ID, type: "user_message", payload: { text } };
}

function renamed(seq: number, title: string): AgentEvent {
    return { seq, ts: "2026-01-01T00:00:00+08:00", sessionId: SESSION_ID, type: "session_renamed", payload: { title } };
}

describe("summarizeEvents 标题派生", () => {
    test("标题固定为首条用户消息，不随后续问题变化", () => {
        const events = [
            { seq: 1, ts: "t", sessionId: SESSION_ID, type: "session_created", payload: { cwd: "/x" } },
            userMessage(2, "帮我查一下高德的路线"),
            userMessage(3, "换成开车路线呢"),
        ] as AgentEvent[];

        const summary = summarizeEvents(SESSION_ID, events);
        expect(summary.title).toBe("帮我查一下高德的路线");
        expect(summary.lastUserMessage).toBe("换成开车路线呢"); // 通知等仍用最新一条
    });

    test("session_renamed 优先于首条用户消息", () => {
        const events = [
            userMessage(1, "第一个问题"),
            renamed(2, "路线调研"),
            userMessage(3, "再问一个"),
        ] as AgentEvent[];

        const summary = summarizeEvents(SESSION_ID, events);
        expect(summary.title).toBe("路线调研");
    });

    test("空会话显式重命名后标题为自定义名", () => {
        const summary = summarizeEvents(SESSION_ID, [renamed(1, "临时草稿")]);
        expect(summary.title).toBe("临时草稿");
        expect(summary.messageCount).toBe(0);
    });

    test("无消息与重命名时标题为空", () => {
        const summary = summarizeEvents(SESSION_ID, [
            { seq: 1, ts: "t", sessionId: SESSION_ID, type: "session_created", payload: { cwd: "/x" } },
        ] as AgentEvent[]);
        expect(summary.title).toBeUndefined();
    });

    test("标题截断至 200 字符", () => {
        const longText = "长".repeat(500);
        const summary = summarizeEvents(SESSION_ID, [userMessage(1, longText)]);
        expect(summary.title?.length).toBe(200);
    });
});

describe("summarizeEvents 归档状态", () => {
    const archived = (seq: number): AgentEvent =>
        ({ seq, ts: "t", sessionId: SESSION_ID, type: "session_archived", payload: {} });
    const unarchived = (seq: number): AgentEvent =>
        ({ seq, ts: "t", sessionId: SESSION_ID, type: "session_unarchived", payload: {} });

    test("归档事件后 archived 为 true", () => {
        expect(summarizeEvents(SESSION_ID, [userMessage(1, "hi"), archived(2)]).archived).toBe(true);
    });

    test("取消归档事件覆盖归档事件，末态生效", () => {
        const restored = summarizeEvents(SESSION_ID, [userMessage(1, "hi"), archived(2), unarchived(3)]);
        expect(restored.archived).toBe(false);

        const rearchived = summarizeEvents(SESSION_ID, [archived(1), unarchived(2), archived(3)]);
        expect(rearchived.archived).toBe(true);
    });

    test("未归档的会话 archived 为 false", () => {
        expect(summarizeEvents(SESSION_ID, [userMessage(1, "hi")]).archived).toBe(false);
    });
});
