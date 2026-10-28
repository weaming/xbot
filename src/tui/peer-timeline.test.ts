/**
 * 会话间消息的时间线投影：重放（AgentEvent）与实时（UIEvent）两条路径都要
 * 落成带 peer 元数据的条目，且回合执行中要按段位插进助手气泡。
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import { ChatStore } from "./store.js";

function peerMessageEvent(seq: number, direction: "in" | "out", text: string, expectResult = false): AgentEvent {
    return {
        seq,
        ts: "2026-09-08T10:00:00+08:00",
        sessionId: "session-1",
        type: "peer_message",
        payload: {
            msgId: `msg-${seq}`,
            direction,
            peerId: "session-2",
            peerTitle: "写测试",
            text,
            ...(expectResult ? { expectResult: true } : {}),
            createdAt: "2026-09-08T10:00:00+08:00",
        },
    };
}

describe("会话间消息的时间线投影", () => {
    test("重放 peer_message 得到带 peer 元数据的系统条目", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([peerMessageEvent(1, "in", "把日志读一遍", true)]);

        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.role).toBe("system");
        expect(store.messages[0]?.text).toBe("把日志读一遍");
        expect(store.messages[0]?.peer).toEqual({
            direction: "in",
            msgId: "msg-1",
            peerId: "session-2",
            peerTitle: "写测试",
            expectResult: true,
        });
    });

    test("重放 peer_result 得到结果条目，丢失时带 lost 标记", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "peer_result",
                payload: {
                    msgId: "msg-1",
                    peerId: "session-2",
                    peerTitle: "写测试",
                    ok: true,
                    text: "结论是没问题",
                    stopReason: "stop",
                    createdAt: "2026-09-08T10:00:00+08:00",
                },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:01:00+08:00",
                sessionId: "session-1",
                type: "peer_result",
                payload: {
                    msgId: "msg-2",
                    peerId: "session-2",
                    ok: false,
                    lost: true,
                    text: "等待会话 session-2 的结果失败",
                    createdAt: "2026-09-08T10:01:00+08:00",
                },
            },
        ]);

        expect(store.messages).toHaveLength(2);
        expect(store.messages[0]?.peer?.isResult).toBe(true);
        expect(store.messages[0]?.peer?.ok).toBe(true);
        expect(store.messages[1]?.peer?.lost).toBe(true);
    });

    test("重放被取消的 peer_result 带 cancelled 标记，不与正常结果混淆", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "peer_result",
                payload: {
                    msgId: "msg-1",
                    peerId: "session-2",
                    ok: true,
                    text: "",
                    stopReason: "aborted",
                    createdAt: "2026-09-08T10:00:00+08:00",
                },
            },
        ]);

        expect(store.messages[0]?.peer?.cancelled).toBe(true);
    });

    test("重放同一消息的 lost 通知与迟到结果时保留两条事实", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "peer_result",
                payload: {
                    msgId: "msg-late",
                    peerId: "session-2",
                    ok: false,
                    lost: true,
                    text: "等待结果超时",
                    createdAt: "2026-09-08T10:00:00+08:00",
                },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:01:00+08:00",
                sessionId: "session-1",
                type: "peer_result",
                payload: {
                    msgId: "msg-late",
                    peerId: "session-2",
                    ok: true,
                    late: true,
                    text: "实际任务结果",
                    createdAt: "2026-09-08T10:01:00+08:00",
                },
            },
        ]);

        expect(store.messages).toHaveLength(2);
        expect(store.messages[0]?.peer?.lost).toBe(true);
        expect(store.messages[1]?.peer?.late).toBe(true);
        expect(store.messages[1]?.text).toBe("实际任务结果");
    });

    test("peer 来源的 user_message 不再单独渲染气泡", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([
            peerMessageEvent(1, "in", "把日志读一遍"),
            {
                seq: 2,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "把日志读一遍", turnId: "turn-1", trigger: "peer" },
            },
        ]);

        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.role).toBe("system");
    });

    test("回合内的 peer_message 按 turn_segment_start 段位插进助手气泡", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.loadHistory([
            {
                seq: 1,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "user_message",
                payload: { text: "开始", turnId: "turn-1", trigger: "user" },
            },
            {
                seq: 2,
                ts: "2026-09-08T10:00:00+08:00",
                sessionId: "session-1",
                type: "turn_segment_start",
                payload: { turnId: "turn-1", kind: "text" },
            },
            {
                seq: 3,
                ts: "2026-09-08T10:00:01+08:00",
                sessionId: "session-1",
                type: "turn_message",
                payload: { turnId: "turn-1", message: { role: "assistant", content: "先看日志" } },
            },
            peerMessageEvent(4, "in", "顺便看下指标"),
            {
                seq: 5,
                ts: "2026-09-08T10:00:02+08:00",
                sessionId: "session-1",
                type: "turn_commit",
                payload: {
                    turnId: "turn-1",
                    events: [],
                    userMessages: ["开始"],
                    stopReason: "stop",
                    usage: {
                        model: "test",
                        promptTokens: 0,
                        completionTokens: 0,
                        totalTokens: 0,
                        durationMs: 0,
                    },
                    interrupted: false,
                },
            },
        ]);

        const assistant = store.messages.find(message => message.role === "assistant");
        const types = (assistant?.timeline ?? []).map(item => item.type);
        expect(types).toContain("peer");
        const peerItem = (assistant?.timeline ?? []).find(item => item.type === "peer");
        expect(peerItem && "text" in peerItem ? peerItem.text : "").toBe("顺便看下指标");

        // 回合内的 peer 消息不再以独立消息重复出现
        expect(store.messages.filter(message => message.role === "system")).toHaveLength(0);
    });

    test("实时 peer_message 空闲时作为独立条目插入", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.applyEvent(1, "session-1", {
            type: "peer_message",
            direction: "out",
            msgId: "msg-out",
            peerId: "session-2",
            peerTitle: "写测试",
            text: "读一遍日志",
            expectResult: true,
            createdAt: "2026-09-08T10:00:00+08:00",
        });

        expect(store.messages).toHaveLength(1);
        expect(store.messages[0]?.peer?.direction).toBe("out");
        expect(store.messages[0]?.peer?.expectResult).toBe(true);
    });

    test("实时 peer_result 在回合执行中插进助手气泡段位", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.applyEvent(1, "session-1", { type: "turn_start", iteration: 1 });
        store.applyEvent(1, "session-1", { type: "text_delta", delta: "正在等结果" });
        store.applyEvent(1, "session-1", {
            type: "peer_result",
            msgId: "msg-out",
            peerId: "session-2",
            ok: true,
            text: "结果是没问题",
            stopReason: "stop",
        });

        const assistant = store.messages.find(message => message.role === "assistant");
        const peerItem = (assistant?.timeline ?? []).find(item => item.type === "peer");
        expect(peerItem && "text" in peerItem ? peerItem.text : "").toBe("结果是没问题");
        expect(store.messages.filter(message => message.role === "system")).toHaveLength(0);
    });

    test("实时 peer_result 丢失时标记 lost", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.applyEvent(1, "session-1", {
            type: "peer_result",
            msgId: "msg-out",
            peerId: "session-2",
            ok: false,
            lost: true,
            text: "等待会话 session-2 的结果失败",
        });

        expect(store.messages[0]?.peer?.lost).toBe(true);
        expect(store.messages[0]?.peer?.ok).toBe(false);
    });

    test("实时 peer_result 被取消时标记 cancelled", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.applyEvent(1, "session-1", {
            type: "peer_result",
            msgId: "msg-out",
            peerId: "session-2",
            ok: true,
            text: "",
            stopReason: "aborted",
        });

        expect(store.messages[0]?.peer?.cancelled).toBe(true);
    });

    test("实时 peer_result 迟到时标记 late", () => {
        const store = new ChatStore();
        store.setCurrentSession("session-1");

        store.applyEvent(1, "session-1", {
            type: "peer_result",
            msgId: "msg-late",
            peerId: "session-2",
            ok: true,
            late: true,
            text: "实际任务结果",
        });

        expect(store.messages[0]?.peer?.late).toBe(true);
        expect(store.messages[0]?.peer?.ok).toBe(true);
    });
});
