import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import { sortSessions } from "../utils/session-order.js";
import { aggregateInstanceUsage, summarizeEvents } from "./summary.js";

const usageOf = (partial: Partial<UsageInfo> = {}): UsageInfo => ({
    model: "deepseek-v4-flash",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    durationMs: 1000,
    requestCount: 1,
    ...partial,
});

describe("aggregateInstanceUsage", () => {
    test("空输入返回全零", () => {
        expect(aggregateInstanceUsage([])).toEqual({
            sessionCount: 0,
            requestCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
        });
    });

    test("跳过未发起过网络请求的会话", () => {
        const stats = aggregateInstanceUsage([usageOf(), usageOf({ requestCount: 0 })]);

        expect(stats.sessionCount).toBe(1);
        expect(stats.requestCount).toBe(1);
    });

    test("累加各字段，可选项缺失按 0 计", () => {
        const stats = aggregateInstanceUsage([
            usageOf({ requestCount: 2, promptTokens: 10, completionTokens: 5, cacheHitTokens: 3, cacheMissTokens: 7 }),
            usageOf({ requestCount: 1, promptTokens: 20, completionTokens: 8, reasoningTokens: 4 }),
        ]);

        expect(stats).toEqual({
            sessionCount: 2,
            requestCount: 3,
            promptTokens: 30,
            completionTokens: 13,
            reasoningTokens: 4,
            cacheHitTokens: 3,
            cacheMissTokens: 7,
        });
    });
});

describe("summarizeEvents 会话更新时间", () => {
    const at = (minute: number): string => `2026-09-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const eventOf = (type: string, ts: string, payload: Record<string, unknown> = {}): AgentEvent =>
        ({ type, seq: 1, ts, sessionId: "s", payload } as unknown as AgentEvent);
    const created = (minute: number): AgentEvent => eventOf("session_created", at(minute), { cwd: "/tmp" });
    /** 群聊状态更新注入：落在事件日志里，但不是用户活动。 */
    const injected = (minute: number): AgentEvent =>
        eventOf("standalone_turn", at(minute), { messages: [{ role: "system", content: "[群聊状态更新：已加入群]" }], injected: true });

    test("自动注入的群聊状态不顶掉 updatedAt（否则闲置会话被挤到 tab 条最前）", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" }),
            injected(30),
            injected(31),
        ]);

        expect(summary.updatedAt).toBe(at(5));
        expect(summary.messageCount).toBe(0);
    });

    test("旧事件（没有 injected 标记）按内容兜底识别，同样不顶掉 updatedAt", () => {
        const legacyInjection: AgentEvent = eventOf("standalone_turn", at(40), {
            messages: [{ role: "system", content: "[群聊状态更新：已加入群]\n你现在以 agent 身份「s」参与群聊，已加入：#general。" }],
        });
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" }),
            legacyInjection,
        ]);

        expect(summary.updatedAt).toBe(at(5));
    });

    test("只有 system 消息但不是群聊状态更新的独立回合仍计入更新时间", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("standalone_turn", at(40), { messages: [{ role: "system", content: "系统提示" }] }),
        ]);

        expect(summary.updatedAt).toBe(at(40));
    });

    test("真实的独立回合仍计入更新时间", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("standalone_turn", at(30), { messages: [{ role: "assistant", content: "图片内容" }] }),
        ]);

        expect(summary.updatedAt).toBe(at(30));
    });

    test("日志里只有建会话 + 注入时，updatedAt 取建会话时间（不会掉进\"未落盘优先\"那一档）", () => {
        const summary = summarizeEvents("s", [created(0), injected(20)]);

        expect(summary.updatedAt).toBe(at(0));
    });

    test("摘要带出会话的工作目录（面板目录列的数据来源）", () => {
        const summary = summarizeEvents("s", [created(0), eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" })]);

        expect(summary.cwd).toBe("/tmp");
    });

    test("旧事件没有 cwd 字段时摘要不带 cwd（面板留空列，由宿主回退）", () => {
        const summary = summarizeEvents("s", [eventOf("session_created", at(0), {})]);

        expect(summary.cwd).toBeUndefined();
    });

    test("cwd 变更事件覆盖 session_created 的目录（面板显示最新目录）", () => {
        const summary = summarizeEvents("s", [
            eventOf("session_created", at(0), { cwd: "/tmp" }),
            eventOf("session_cwd_changed", at(10), { cwd: "/opt/work" }),
        ]);

        expect(summary.cwd).toBe("/opt/work");
    });

    test("注水多但无用户活动的会话不会排到活跃会话前面", () => {
        const idle = summarizeEvents("idle", [created(0), injected(50), injected(55)]);
        const active = summarizeEvents("active", [created(0), eventOf("user_message", at(30), { text: "在跑", turnId: "t1", trigger: "user" })]);

        expect(sortSessions([idle, active]).map(session => session.sessionId)).toEqual(["active", "idle"]);
    });
});
