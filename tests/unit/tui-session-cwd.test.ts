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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-tui-cwd-"));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-tui-other-"));
    originalStateDir = process.env.XBOT_STATE_DIR;
    originalTuiCwd = process.env.TUI_CWD;
    process.env.XBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.XBOT_STATE_DIR;
    else process.env.XBOT_STATE_DIR = originalStateDir;
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

});

// mock.module 是进程级全局：本文件跑完必须恢复，否则同 worker 的后续文件会拿到假实现
afterAll(() => {
    mock.restore();
});
