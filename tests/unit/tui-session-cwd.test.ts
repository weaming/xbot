import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 新会话初始 cwd 测试：cwd 必须固定为 TUI 启动目录（getTuiStartupCwd 回退
 * process.cwd），不能继承已被激活会话改写的进程级 TUI_CWD。
 */

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => {
        throw new Error("runChatQuery 不应在 cwd 测试中被调用");
    },
}));

const { LocalTuiAgent } = await import("../../src/tui/agent.js");
const { getTuiStartupCwd } = await import("../../src/tui/runtime-context.js");

let tmpDir: string;
let otherDir: string;
let originalStateDir: string | undefined;
let originalTuiCwd: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-cwd-"));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-other-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    originalTuiCwd = process.env.TUI_CWD;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = originalTuiCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
});

describe("新会话初始 cwd", () => {
    test("固定为启动目录，不继承被会话切换改写的 TUI_CWD", async () => {
        const agent = new LocalTuiAgent();
        try {
            // 模拟切换到一个 cwd 为 otherDir 的旧会话：进程级 TUI_CWD 被改写。
            process.env.TUI_CWD = otherDir;

            const { sessionId } = await agent.createSession();
            expect(await agent.getSessionCwd(sessionId)).toBe(getTuiStartupCwd());
            expect(await agent.getSessionCwd(sessionId)).not.toBe(otherDir);
            expect(await agent.getSessionCwd(sessionId)).toBe(process.cwd());
        } finally {
            agent.close();
        }
    });

    test("切换 cwd 会落盘：另一个实例只读事件日志也能取回新目录", async () => {
        const agent = new LocalTuiAgent();
        try {
            const { sessionId } = await agent.createSession();
            await agent.setSessionCwd(sessionId, otherDir);
            expect(await agent.getSessionCwd(sessionId)).toBe(otherDir);

            // 新实例没有内存态：命中"恢复"分支，只能倒扫事件日志重建
            const restored = new LocalTuiAgent();
            try {
                expect(await restored.getSessionCwd(sessionId)).toBe(otherDir);
            } finally {
                restored.close();
            }
        } finally {
            agent.close();
        }
    });

    test("回合进行中（会话忙）也能切换 cwd：不能被 busy 判据挡住", async () => {
        const agent = new LocalTuiAgent();
        try {
            const { sessionId } = await agent.createSession();
            // 模拟回合进行中：abortController 已挂上，cwd 工具正是在这种时刻被调用
            const active = (agent as unknown as {
                activeSessions: Map<string, { abortController?: AbortController }>;
            }).activeSessions.get(sessionId);
            expect(active).toBeDefined();
            active!.abortController = new AbortController();

            await expect(agent.setSessionCwd(sessionId, otherDir)).resolves.toBeUndefined();
            expect(await agent.getSessionCwd(sessionId)).toBe(otherDir);
        } finally {
            agent.close();
        }
    });

});

// mock.module 是进程级全局：本文件跑完必须恢复，否则同 worker 的后续文件会拿到假实现
afterAll(() => {
    mock.restore();
});
