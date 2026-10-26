/**
 * 会话间工具：session_spawn / session_send / session_status 的语义与下发条件。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_SPAWNED_SESSIONS, SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import type { PeerMessage } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import {
    setPeerResultHistory,
    setSessionControl,
    setSessionDirectory,
    type PeerResultRecord,
} from "../../src/control/runtime.js";
import { getSessionToolNames, SESSION_TOOLS } from "../../src/tools/session-tools.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
let control: SessionControl;
const accepted: string[] = [];
const outbound: PeerMessage[] = [];
const busy = new Set<string>();
const spawned: string[] = [];
const closed: Array<{ sessionId: string; automatic: boolean }> = [];
/** 目标会话受理后自动回传的结果文本：设了才回，模拟对方跑完一轮。 */
const replies = new Map<string, string>();
/** 各会话历史收到的会话间结果：模拟事件日志里的 peer_result。 */
const peerResults = new Map<string, PeerResultRecord[]>();

const SESSIONS = [
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA1", title: "重构 session 模块" },
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA2", title: "写测试" },
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA3" },
];

function makeHost(): SessionControlHost {
    return {
        title: (sessionId) => SESSIONS.find(item => item.sessionId === sessionId)?.title,
        isBusy: (sessionId) => busy.has(sessionId),
        createSession: async () => ({ sessionId: `01JSPAWN${String(spawned.length + 1).padStart(18, "0")}` }),
        sessionCwd: async (sessionId) => `/tmp/cwd-${sessionId.slice(-1)}`,
        onSessionSpawned: (sessionId, title) => {
            spawned.push(title ? `${sessionId}:${title}` : sessionId);
        },
        archiveSpawnedSession: async (sessionId, automatic) => {
            closed.push({ sessionId, automatic });
            control.release(sessionId);
        },
        accept: (message) => {
            if (busy.has(message.to)) return false;
            accepted.push(message.id);
            const reply = replies.get(message.to);
            if (reply !== undefined) {
                setTimeout(() => {
                    control.completeInbound(message.to, message, {
                        msgId: message.id,
                        ok: true,
                        text: reply,
                        stopReason: "stop",
                    });
                }, 0);
            }
            return true;
        },
        onOutbound: (_from, message) => {
            outbound.push(message);
        },
        onResult: () => undefined,
        onLost: () => undefined,
        onReleased: () => undefined,
    };
}

function tool(name: string) {
    const found = SESSION_TOOLS.find(item => item.name === name);
    if (!found) throw new Error(`工具不存在: ${name}`);
    return found;
}

beforeEach(() => {
    stateDir = useTmpStateDir("xbot-session-tools-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    accepted.length = 0;
    outbound.length = 0;
    busy.clear();
    spawned.length = 0;
    closed.length = 0;
    replies.clear();
    peerResults.clear();

    control = new SessionControl(makeHost(), { probeTimeoutMs: 100, negotiateTimeoutMs: 200 });
    setSessionControl(control);
    setSessionDirectory({ list: async () => SESSIONS });
    setPeerResultHistory({
        recentResults: async (sessionId, limit) => (peerResults.get(sessionId) ?? []).slice(-limit),
    });
});

afterEach(() => {
    control.close();
    setSessionControl(undefined);
    setSessionDirectory(undefined);
    setPeerResultHistory(undefined);
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

describe("下发条件", () => {
    test("没有会话上下文时不注入", () => {
        expect(getSessionToolNames(undefined)).toEqual([]);
    });

    test("有会话上下文即注入，不必已认领（回合运行期间持有权不会被释放）", () => {
        expect(getSessionToolNames(SESSIONS[0]!.sessionId)).toEqual([
            "session_spawn",
            "session_send",
            "session_status",
            "session_close",
        ]);
    });

    test("进程未装配控制通道时不注入", () => {
        setSessionControl(undefined);
        expect(getSessionToolNames(SESSIONS[0]!.sessionId)).toEqual([]);
    });
});

describe("session_spawn", () => {
    test("缺少会话上下文时报错", async () => {
        const result = await tool("session_spawn").execute({});
        expect(result.isError).toBe(true);
    });

    test("派生 + 认领 + 通知宿主，并返回完整 id", async () => {
        const result = await tool("session_spawn").execute({
            title: "读日志",
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已派生并接管会话");
        expect(text).toContain("session_send");
        expect(spawned.length).toBe(1);
        expect(spawned[0]).toEndWith(":读日志");
        expect(control.spawnedCount).toBe(1);
    });

    test("auto_close=true 在首个期望结果回传后自动归档并释放", async () => {
        const spawn = await tool("session_spawn").execute({
            auto_close: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        replies.set(sessionId, "任务完成");

        const result = await tool("session_send").execute({
            session: sessionId,
            text: "执行任务",
            expect_result: true,
            wait_seconds: 1,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(result.isError).toBeUndefined();
        expect(closed).toEqual([{ sessionId, automatic: true }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("auto_close 不会在未请求回传结果时关闭子会话", async () => {
        const spawn = await tool("session_spawn").execute({
            auto_close: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        replies.set(sessionId, "任务完成");

        await tool("session_send").execute({
            session: sessionId,
            text: "执行任务",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(closed).toEqual([]);
        expect(control.spawnedCount).toBe(1);
    });

    test("session_close 只归档本实例派生子会话并保留历史", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";

        const result = await tool("session_close").execute({
            session: sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("历史保留");
        expect(closed).toEqual([{ sessionId, automatic: false }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("session_close 不允许归档普通会话", async () => {
        await control.claim(SESSIONS[1]!.sessionId);
        const result = await tool("session_close").execute({
            session: SESSIONS[1]!.sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("只能关闭本实例派生");
        expect(closed).toEqual([]);
    });

    test("session_close 不允许归档正在执行的子会话", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        busy.add(sessionId);

        const result = await tool("session_close").execute({
            session: sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("正在执行");
        expect(closed).toEqual([]);
    });

    test("派生的子会话可直接派活（本进程直投）", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";

        const send = await tool("session_send").execute({
            session: sessionId,
            text: "把日志读一遍",
            expect_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(send.isError).toBeUndefined();
        expect(accepted.length).toBe(1);
    });

    test("超出上限时报错并提示清理", async () => {
        for (let index = 0; index < MAX_SPAWNED_SESSIONS; index++) {
            const result = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
            expect(result.isError).toBeUndefined();
        }

        const overflow = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        expect(overflow.isError).toBe(true);
        expect(overflow.content[0]?.text).toContain("上限");
    });

    test("释放后名额归还", async () => {
        const first = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(first.content[0]?.text ?? "")?.[1] ?? "";
        expect(control.spawnedCount).toBe(1);

        control.release(sessionId);
        expect(control.spawnedCount).toBe(0);
    });
});

describe("session_send", () => {
    test("缺少会话上下文时报错", async () => {
        const result = await tool("session_send").execute({ session: "…1", text: "hi" });
        expect(result.isError).toBe(true);
    });

    test("必填参数缺失时报错", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const noSession = await tool("session_send").execute({ text: "hi", __sessionId: SESSIONS[0]!.sessionId });
        expect(noSession.isError).toBe(true);
        const noText = await tool("session_send").execute({ session: SESSIONS[1]!.sessionId, __sessionId: SESSIONS[0]!.sessionId });
        expect(noText.isError).toBe(true);
    });

    test("送达后返回 msgId，期望结果时提示稍后回传", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            text: "把日志读一遍",
            expect_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已发送到会话");
        expect(text).toContain("结果稍后自动回传");
        expect(accepted.length).toBe(1);
    });

    test("目标未认领时给出不可达错误", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "在吗",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("不可达");
    });

    test("目标忙时给出可重试的错误提示", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        busy.add(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "插队",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("正在执行中");
    });

    test("不能给自己发消息", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_send").execute({
            session: SESSIONS[0]!.sessionId,
            text: "自问自答",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
    });

    test("wait_seconds 命中时结果直接作为工具结果返回，且不入队", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        replies.set(SESSIONS[1]!.sessionId, "日志读完了");

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            text: "把日志读一遍",
            wait_seconds: 5,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("日志读完了");
        // wait_seconds 隐含 expect_result
        expect(outbound[0]?.expectResult).toBe(true);
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(0);
        expect(control.queuedResults(SESSIONS[0]!.sessionId)).toBe(0);
    });

    test("wait_seconds 超时返回提示，等待项保留给自动附加", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "慢慢来",
            wait_seconds: 0.05,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("未见结果");
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(1);
    });

    test("wait_seconds 为零时发完即返回", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        replies.set(SESSIONS[1]!.sessionId, "不该被等到");

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "通知一下",
            wait_seconds: 0,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.content[0]?.text).not.toContain("不该被等到");
        expect(result.content[0]?.text).not.toContain("结果稍后自动回传");
        expect(outbound[0]?.expectResult).toBeUndefined();
    });

    test("等待被中止时报错", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const controller = new AbortController();
        controller.abort();
        const result = await tool("session_send").execute(
            {
                session: SESSIONS[1]!.sessionId,
                text: "慢慢来",
                wait_seconds: 5,
                __sessionId: SESSIONS[0]!.sessionId,
            },
            controller.signal,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("被中止");
    });

    test("等待期间放入后台时立刻返回提示，结果仍会自动附加", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const pending = tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "慢慢来",
            wait_seconds: 5,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        // 模拟用户按 ⌃B：等工具登记好等待项再放后台
        let detached = 0;
        for (let attempt = 0; attempt < 50 && detached === 0; attempt++) {
            await Bun.sleep(1);
            detached = control.detachWaits(SESSIONS[0]!.sessionId);
        }
        expect(detached).toBe(1);

        const result = await pending;
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("放入后台");
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(1);
    });
});

describe("session_status", () => {
    test("省略 session 时列出全部会话与归属", async () => {
        await control.claim(SESSIONS[0]!.sessionId);

        const result = await tool("session_status").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("重构 session 模块");
        expect(text).toContain("写测试");
        expect(text).toContain("本实例");
        expect(text).toContain("未认领");
        expect(text).toContain("← 你");
    });

    test("指定 session 时给出详情", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });

        const text = result.content[0]?.text ?? "";
        expect(text).toContain("归属：未认领");
        expect(text).toContain("session_send");
    });

    test("查询自己时明确提示不能自发", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_status").execute({
            session: SESSIONS[0]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("不能给自己发消息");
    });

    test("没有会话目录时报错", async () => {
        setSessionDirectory(undefined);
        const result = await tool("session_status").execute({});
        expect(result.isError).toBe(true);
    });

    test("省略 session + include_result 时附上自己最近收到的结果原文", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[1]!.sessionId,
                peerTitle: "写测试",
                ok: true,
                text: "已完成：tests/unit/foo.test.ts 新增 3 例",
                stopReason: "stop",
                createdAt: "2026-02-03T10:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("重构 session 模块");
        expect(text).toContain("最近结果（来自");
        expect(text).toContain("写测试");
        expect(text).toContain("2026-02-03T10:00:00+08:00");
        expect(text).toContain("已完成：tests/unit/foo.test.ts 新增 3 例");
    });

    test("指定 session 时读的是该会话自己的结果日志", async () => {
        peerResults.set(SESSIONS[1]!.sessionId, [
            {
                peerId: SESSIONS[2]!.sessionId,
                ok: true,
                text: "对方会话作为请求方收到的结果",
                createdAt: "2026-02-03T09:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("对方会话作为请求方收到的结果");
    });

    test("默认不返回结果原文", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[1]!.sessionId,
                ok: true,
                text: "不该出现的结果原文",
                createdAt: "2026-02-03T10:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).not.toContain("不该出现的结果原文");
    });

    test("没有历史结果时明确提示", async () => {
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("最近结果：（无）");
    });

    test("未装配结果历史时提示不可查", async () => {
        setPeerResultHistory(undefined);
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("未装配结果历史");
    });

    test("结果丢失时标记状态", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[2]!.sessionId,
                ok: false,
                lost: true,
                text: "等待会话的结果失败：对方未在期限内回传",
                createdAt: "2026-02-03T11:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[0]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已丢失");
        expect(text).toContain("对方未在期限内回传");
    });
});
