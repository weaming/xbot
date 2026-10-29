import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { LocalSessionHost } from "../../src/host/session-host.js";
import { clearMcpSelection, readMcpSelection, updateMcpSelection } from "../../src/tools/session-mcp-selection.js";

/**
 * 会话级 lazy MCP 启用集：/mcp 的切换要落盘成事件（重启/重开该会话仍生效），
 * 并同步到内存缓存供工具下发与 token 预算读取。
 */

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-lazy-mcp-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("会话级 lazy MCP 启用集", () => {
    test("落盘为事件：另一个实例重放后拿到同一份启用集", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();
        try {
            await agent.setSessionLazyMcpServers(sessionId, ["rea", "mcp-hub", "rea"]);
            expect(await agent.getSessionLazyMcpServers(sessionId)).toEqual(["mcp-hub", "rea"]);
        } finally {
            agent.close();
        }

        const reader = new LocalSessionHost();
        try {
            expect(await reader.getSessionLazyMcpServers(sessionId)).toEqual(["mcp-hub", "rea"]);
        } finally {
            reader.close();
        }
    });

    test("启用集不变时不重复落事件", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();
        try {
            await agent.setSessionLazyMcpServers(sessionId, ["rea"]);
            const seqAfterFirst = await agent.eventLog.lastSeq(sessionId);
            await agent.setSessionLazyMcpServers(sessionId, ["rea"]);
            expect(await agent.eventLog.lastSeq(sessionId)).toBe(seqAfterFirst);
        } finally {
            agent.close();
        }
    });

    test("清空启用集后缓存回到「全部默认不下发」", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();
        try {
            await agent.setSessionLazyMcpServers(sessionId, ["rea"]);
            expect(readMcpSelection(sessionId)).toEqual(["rea"]);
            await agent.setSessionLazyMcpServers(sessionId, []);
            expect(readMcpSelection(sessionId)).toEqual([]);
            expect(await agent.getSessionLazyMcpServers(sessionId)).toEqual([]);
        } finally {
            agent.close();
        }
    });
});

describe("会话 MCP 选中集内存缓存", () => {
    test("去重后保存；空集算「已初始化但一个不选」，释放后回到未初始化", () => {
        updateMcpSelection("s1", ["rea", "rea", "mcp-hub"]);
        expect(readMcpSelection("s1")).toEqual(["rea", "mcp-hub"]);

        // 空数组与 undefined 必须区分：前者是「明确一个都不选」，后者是「还没初始化」
        updateMcpSelection("s1", []);
        expect(readMcpSelection("s1")).toEqual([]);

        updateMcpSelection("s2", ["rea"]);
        clearMcpSelection("s2");
        expect(readMcpSelection("s2")).toBeUndefined();

        // 没有会话上下文 = 不限制
        expect(readMcpSelection(undefined)).toBeUndefined();
    });
});
