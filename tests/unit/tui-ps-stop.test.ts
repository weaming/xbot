/**
 * /ps 与 /stop：对齐 Codex 的进程视图与终止语义。
 *
 * /ps   —— 只列"还在跑"的：当前回合 + 后台任务
 * /stop —— 无参中止当前回合；<task_id> 或 all 终止后台任务
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tuiStub } from "./tui-stub.js";
import { isolateModelEnv } from "./test-env.js";

mock.module("@earendil-works/pi-tui", () => tuiStub);

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => ({ content: "stub", toolCalls: 0, messages: [] }),
}));

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");
const { backgroundTaskManager } = await import("../../src/tools/background-tasks.js");

const SESSION = "sess-ps-test";
let restoreModelEnv: () => void;

function makeAgent(overrides: Record<string, unknown> = {}) {
    const agent: any = {
        claimedSessionIds: () => [SESSION],
        isSessionBusy: () => false,
        isSessionClaimed: () => true,
        isSessionLockedByOther: () => false,
        abortSession: async () => true,
        listSessions: async () => [],
        readSessionEvents: async () => [],
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        detachPeerWaits: () => 0,
        takePeerResults: () => [],
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        getSessionCwd: async () => process.cwd(),
        ...overrides,
    };
    return agent;
}

function makeApp(agent = makeAgent()) {
    const store = new ChatStore();
    store.setCurrentSession(SESSION);
    const app: any = new ChatApp(agent, store);
    return { app, store, agent };
}

/** 取最后一条 system 消息文本。 */
function lastSystemText(store: any): string {
    const messages = store.messages.filter((m: any) => m.role === "system");
    return messages.at(-1)?.text ?? "";
}

/** 伪造一条"运行中"的后台任务，返回清理函数。 */
function fakeRunningTask(id: string, sessionId = SESSION, command = "npm run dev"): () => void {
    const manager: any = backgroundTaskManager;
    const summary = {
        id,
        sessionId,
        command,
        cwd: process.cwd(),
        status: "running",
        startedAt: new Date(Date.now() - 90_000).toISOString(),
    };
    const task = { summary, child: { pid: 1 }, pgid: 1, stdoutChunks: [], stderrChunks: [], stopRequested: false };
    manager.tasks.set(id, task);
    return () => manager.tasks.delete(id);
}

beforeEach(() => {
    restoreModelEnv = isolateModelEnv();
});

afterEach(() => {
    restoreModelEnv();
    // 清掉测试伪造的任务，避免影响其他文件
    const manager: any = backgroundTaskManager;
    for (const [id, task] of [...manager.tasks]) {
        if (task.summary.startedAt && id.startsWith("fake_")) manager.tasks.delete(id);
    }
});

describe("/ps", () => {
    test("无任何运行时提示没有正在运行的任务", async () => {
        const { app, store } = makeApp();
        await app.handleCommand("/ps");
        expect(lastSystemText(store)).toContain("没有正在运行的任务");
    });

    test("列出当前回合与后台任务", async () => {
        const cleanup = fakeRunningTask("fake_1");
        try {
            const { app, store } = makeApp(makeAgent({ isSessionBusy: () => true }));
            app.turnState.setPhase(SESSION, "tool", "bash");

            await app.handleCommand("/ps");
            const text = lastSystemText(store);

            expect(text).toContain("当前回合");
            expect(text).toContain("执行工具 bash");
            expect(text).toContain("fake_1");
            expect(text).toContain("npm run dev");
            // 运行时长以 m 结尾（伪造 90s 前启动）
            expect(text).toMatch(/运行中 1m/);
        } finally {
            cleanup();
        }
    });

    test("不含已完成的任务", async () => {
        const manager: any = backgroundTaskManager;
        manager.tasks.set("fake_done", {
            summary: { id: "fake_done", sessionId: SESSION, command: "done-cmd", cwd: "/", status: "completed", startedAt: new Date().toISOString() },
            child: null, pgid: undefined, stdoutChunks: [], stderrChunks: [], stopRequested: false,
        });
        try {
            const { app, store } = makeApp();
            await app.handleCommand("/ps");
            expect(lastSystemText(store)).not.toContain("fake_done");
        } finally {
            manager.tasks.delete("fake_done");
        }
    });

    test("提示里给出 /stop 用法", async () => {
        const cleanup = fakeRunningTask("fake_2");
        try {
            const { app, store } = makeApp();
            await app.handleCommand("/ps");
            expect(lastSystemText(store)).toContain("/stop");
        } finally {
            cleanup();
        }
    });
});

describe("后台任务完成后驱动新一轮", () => {
    test("回合已结束：结果直接驱动一轮，且时间线只显示摘要", async () => {
        const sends: Array<{ text: string; sessionId: string; display?: string }> = [];
        const { app } = makeApp();
        // 会话视图存在，才允许驱动（防止操作已失效视图）
        app.store.hasSessionView = () => true;
        app.send = async (text: string, sessionId: string, _images: unknown, display?: string) => {
            sends.push({ text, sessionId, ...(display ? { display } : {}) });
        };

        app.handleBackgroundTaskCompleted({
            id: "fake_9",
            sessionId: SESSION,
            command: "npm run build",
            cwd: "/",
            status: "completed",
            startedAt: new Date().toISOString(),
            exitCode: 0,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(sends).toHaveLength(1);
        expect(sends[0]!.sessionId).toBe(SESSION);
        // 给模型的是结构化通知
        expect(sends[0]!.text).toContain("background_task_completed");
        expect(sends[0]!.text).toContain("fake_9");
        // 时间线只显示可读摘要
        expect(sends[0]!.display).toBe("⚙ 后台任务 fake_9 已完成");
    });

    test("回合进行中：不驱动新一轮，结果挂到 pending 等下一次请求", async () => {
        const sends: unknown[] = [];
        const { app } = makeApp();
        app.store.hasSessionView = () => true;
        app.send = async (...args: unknown[]) => { sends.push(args); };
        // 模拟本会话有活跃回合
        app.activeTurnSessions.add(SESSION);

        app.handleBackgroundTaskCompleted({
            id: "fake_10",
            sessionId: SESSION,
            command: "x",
            cwd: "/",
            status: "completed",
            startedAt: new Date().toISOString(),
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(sends).toHaveLength(0);
        const pending = app.pendingBackgroundResults.get(SESSION) ?? [];
        expect(pending).toHaveLength(1);
        expect(pending[0].text).toContain("fake_10");
    });

    test("会话视图不存在时不动（防操作已失效视图）", async () => {
        const sends: unknown[] = [];
        const { app } = makeApp();
        app.store.hasSessionView = () => false;
        app.send = async (...args: unknown[]) => { sends.push(args); };

        app.handleBackgroundTaskCompleted({
            id: "fake_11",
            sessionId: SESSION,
            command: "x",
            cwd: "/",
            status: "completed",
            startedAt: new Date().toISOString(),
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(sends).toHaveLength(0);
    });

    test("失败的任务摘要是「失败」而不是「已完成」", async () => {
        const displays: string[] = [];
        const { app } = makeApp();
        app.store.hasSessionView = () => true;
        app.send = async (_t: string, _s: string, _i: unknown, display?: string) => {
            if (display) displays.push(display);
        };

        app.handleBackgroundTaskCompleted({
            id: "fake_12",
            sessionId: SESSION,
            command: "x",
            cwd: "/",
            status: "failed",
            startedAt: new Date().toISOString(),
            exitCode: 1,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(displays[0]).toBe("⚙ 后台任务 fake_12 失败");
    });
});

describe("/stop", () => {
    test("无参数且空闲时提示没有正在运行的回合", async () => {
        const { app, store } = makeApp(makeAgent({ isSessionBusy: () => false }));
        await app.handleCommand("/stop");
        expect(lastSystemText(store)).toContain("当前没有正在运行的回合");
    });

    test("无参数且回合进行中时中止当前回合", async () => {
        let aborted = "";
        const { app, store } = makeApp(makeAgent({
            isSessionBusy: () => true,
            abortSession: async (sessionId: string) => {
                aborted = sessionId;
                return true;
            },
        }));

        await app.handleCommand("/stop");
        expect(aborted).toBe(SESSION);
        expect(lastSystemText(store)).toContain("已请求中止当前回合");
    });

    test("无会话时提示无可中止的回合", async () => {
        const store = new ChatStore();
        store.setCurrentSession(null);
        const app: any = new ChatApp(makeAgent(), store);

        await app.handleCommand("/stop");
        expect(lastSystemText(store)).toContain("没有打开的会话");
    });

    test("带 task_id 终止对应后台任务", async () => {
        const cleanup = fakeRunningTask("fake_3");
        try {
            const manager: any = backgroundTaskManager;
            let stopped: string | undefined;
            const originalStop = manager.stop.bind(manager);
            manager.stop = (taskId: string, sessionId?: string) => {
                stopped = taskId;
                manager.tasks.delete(taskId);
                return true;
            };
            try {
                const { app, store } = makeApp();
                await app.handleCommand("/stop fake_3");
                expect(stopped).toBe("fake_3");
                expect(lastSystemText(store)).toContain("已请求终止后台任务 fake_3");
            } finally {
                manager.stop = originalStop;
            }
        } finally {
            cleanup();
        }
    });

    test("带 all 终止本会话全部运行中任务", async () => {
        const cleanupA = fakeRunningTask("fake_4");
        const cleanupB = fakeRunningTask("fake_5");
        try {
            const manager: any = backgroundTaskManager;
            const stopped: string[] = [];
            const originalStop = manager.stop.bind(manager);
            manager.stop = (taskId: string) => {
                stopped.push(taskId);
                manager.tasks.delete(taskId);
                return true;
            };
            try {
                const { app, store } = makeApp();
                await app.handleCommand("/stop all");
                expect(stopped.sort()).toEqual(["fake_4", "fake_5"]);
                expect(lastSystemText(store)).toContain("已请求终止 2 个后台任务");
            } finally {
                manager.stop = originalStop;
            }
        } finally {
            cleanupA();
            cleanupB();
        }
    });

    test("all 但没有运行中任务时如实提示", async () => {
        const { app, store } = makeApp();
        await app.handleCommand("/stop all");
        expect(lastSystemText(store)).toContain("没有正在运行的后台任务");
    });

    test("未知 task_id 如实报错", async () => {
        const { app, store } = makeApp();
        await app.handleCommand("/stop no_such_task");
        expect(lastSystemText(store)).toContain("不存在或不属于当前会话");
    });

    test("任务已结束时不谎报终止", async () => {
        const manager: any = backgroundTaskManager;
        manager.tasks.set("fake_finished", {
            summary: { id: "fake_finished", sessionId: SESSION, command: "x", cwd: "/", status: "completed", startedAt: new Date().toISOString() },
            child: null, pgid: undefined, stdoutChunks: [], stderrChunks: [], stopRequested: false,
        });
        try {
            const { app, store } = makeApp();
            await app.handleCommand("/stop fake_finished");
            expect(lastSystemText(store)).toContain("当前状态：completed");
        } finally {
            manager.tasks.delete("fake_finished");
        }
    });
});
