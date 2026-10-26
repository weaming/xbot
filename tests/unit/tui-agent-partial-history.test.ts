import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { getSessionContextHistory } from "../../src/utils/conversation-history.js";

/**
 * 把 runChatQuery 替换为可注入 spy，同时透传 chat-runtime 的其余命名导出，
 * 避免影响 chat-runtime.test.ts 等其他测试套件对同一模块的依赖。
 * LocalTuiAgent 的 abort/错误/成功路径把用户消息与已产生的工具段物化为
 * interrupted/failed turn，不需要真 LLM 调用也不需要真 buildConversationHistory。
 */

type RunChatQueryImpl = (options: any) => Promise<any>;

let runChatQueryImpl: RunChatQueryImpl = async () => {
    throw new Error("runChatQuery 未在测试中设置");
};

const realChatRuntime = await import("../../src/services/chat-runtime.js");

mock.module("../../src/services/chat-runtime.js", () => {
    return {
        ...realChatRuntime,
        runChatQuery: (options: any) => runChatQueryImpl(options),
    };
});

const { LocalTuiAgent } = await import("../../src/tui/agent.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let originalEnvAgents: string | undefined;
let originalExtraAgents: string | undefined;
let agent: InstanceType<typeof LocalTuiAgent>;
let sessionId: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-tui-agent-partial-"));
    originalStateDir = process.env.XBOT_STATE_DIR;
    originalEnvAgents = process.env.XBOT_IDENTITY_FILE;
    originalExtraAgents = process.env.XBOT_EXTRA_IDENTITY_FILE;
    process.env.XBOT_STATE_DIR = tmpDir;
    delete process.env.XBOT_IDENTITY_FILE;
    delete process.env.XBOT_EXTRA_IDENTITY_FILE;

    agent = new LocalTuiAgent();
    const { sessionId: id } = await agent.createSession();
    sessionId = id;
});

afterEach(() => {
    agent.close();
    if (originalStateDir === undefined) delete process.env.XBOT_STATE_DIR;
    else process.env.XBOT_STATE_DIR = originalStateDir;
    if (originalEnvAgents === undefined) delete process.env.XBOT_IDENTITY_FILE;
    else process.env.XBOT_IDENTITY_FILE = originalEnvAgents;
    if (originalExtraAgents === undefined) delete process.env.XBOT_EXTRA_IDENTITY_FILE;
    else process.env.XBOT_EXTRA_IDENTITY_FILE = originalExtraAgents;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readSession(): any[] {
    const eventsPath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    const text = fs.readFileSync(eventsPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.map(line => JSON.parse(line));
}

function stripMeta(messages: any[]): any[] {
    return messages.map(({ id, createdAt, ...message }) => message);
}

function makeAbortError(partialMessages: any[]): any {
    const error: any = new Error("Request was aborted.");
    error.name = "AbortError";
    error.partialMessages = partialMessages;
    return error;
}

const partialMessages = [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", name: "bash", content: "result-1" },
    { role: "assistant", content: "partial answer" },
];

describe("LocalTuiAgent.sendMessage interrupted/failed turn materialization", () => {
    test("abort path materializes an interrupted turn with user message and partial tool segments", async () => {
        runChatQueryImpl = async () => {
            throw makeAbortError(partialMessages);
        };

        const result = await agent.sendMessage(sessionId, "查一下行情");
        expect(result).toEqual({ aborted: true });

        // 事件日志：user_message + turn_message(partial 逐条) + turn_commit(interrupted=true)
        const events = readSession();
        const commit = events.find(event => event.type === "turn_commit");
        expect(commit).toBeDefined();
        expect(commit.payload.interrupted).toBe(true);
        expect(commit.payload.stopReason).toBe("aborted");
        expect(events.filter(event => event.type === "turn_message").map(event => event.payload.message)).toEqual(partialMessages);

        // 关键断言：中断 turn 物化进 session.turns，用户消息 + 工具段全量保留
        const session = (agent as any).activeSessions.get(sessionId).session;
        expect(session.turns).toBeArrayOfSize(1);
        expect(session.turns[0].status).toBe("interrupted");
        expect(stripMeta(session.turns[0].messages)).toEqual([
            { role: "user", content: "查一下行情" },
            ...partialMessages,
        ]);
        expect(session.totalUserTurnCount).toBe(1);
    });

    test("successful turn after abort keeps the interrupted turn intact without replaying its segments", async () => {
        runChatQueryImpl = async () => {
            throw makeAbortError(partialMessages);
        };
        await agent.sendMessage(sessionId, "先找工具");

        // 第二次：成功，turns 追加一个 completed turn，中断段不重复拼接
        runChatQueryImpl = async (options: any) => {
            await options.onTurnMessage?.({ role: "assistant", content: "完成" });
            return {
                content: "完成",
                toolCalls: 1,
                messages: [{ role: "assistant", content: "完成" }],
            };
        };
        const second = await agent.sendMessage(sessionId, "继续");
        expect(second).toEqual({});

        const session = (agent as any).activeSessions.get(sessionId).session;
        expect(session.turns).toBeArrayOfSize(2);
        expect(session.turns[0].status).toBe("interrupted");
        expect(session.turns[1].status).toBe("completed");
        expect(stripMeta(session.turns[1].messages)).toEqual([
            { role: "user", content: "继续" },
            { role: "assistant", content: "完成" },
        ]);

        // 事件日志：两次 turn_commit，第一条 interrupted、第二条正常
        const events = readSession();
        const commits = events.filter(event => event.type === "turn_commit");
        expect(commits).toBeArrayOfSize(2);
        expect(commits[0].payload.interrupted).toBe(true);
        expect(commits[1].payload.interrupted).toBe(false);
        // 正文在 turn_message 里，终态只存关系
        const lastTurnMessage = events.filter(event => event.type === "turn_message").at(-1);
        expect(lastTurnMessage.payload.message).toMatchObject({ role: "assistant", content: "完成" });
    });

    test("displayText 只影响落盘与历史，发给模型的 query 仍是完整文本", async () => {
        let seenQuery = "";
        runChatQueryImpl = async (options: any) => {
            seenQuery = options.query;
            return {
                content: "收到",
                toolCalls: 0,
                messages: [{ role: "assistant", content: "收到" }],
            };
        };

        await agent.sendMessage(sessionId, "[群消息 #general] Peer: hi\n\n>>> 这条消息 @ 了你。", {
            displayText: "[群消息 #general] Peer: hi",
        });

        expect(seenQuery).toBe("[群消息 #general] Peer: hi\n\n>>> 这条消息 @ 了你。");
        const userEvent = readSession().find(event => event.type === "user_message");
        expect(userEvent.payload.text).toBe("[群消息 #general] Peer: hi");

        const session = (agent as any).activeSessions.get(sessionId).session;
        expect(stripMeta(session.turns[0].messages)[0]).toEqual({
            role: "user",
            content: "[群消息 #general] Peer: hi",
        });
    });

    test("持久化同一 turn 内所有 provider 请求的 usage", async () => {
        runChatQueryImpl = async (options) => {
            options.onEvent?.({
                type: "usage",
                usage: {
                    model: "test-model",
                    promptTokens: 100,
                    completionTokens: 20,
                    totalTokens: 120,
                    durationMs: 10,
                },
            });
            options.onEvent?.({
                type: "usage",
                usage: {
                    model: "test-model",
                    promptTokens: 250,
                    completionTokens: 30,
                    totalTokens: 280,
                    durationMs: 20,
                },
            });
            return {
                content: "完成",
                messages: [{ role: "assistant", content: "完成" }],
            };
        };

        await agent.sendMessage(sessionId, "执行");

        const commit = readSession().find(event => event.type === "turn_commit");
        expect(commit?.payload.usage).toMatchObject({
            promptTokens: 350,
            completionTokens: 50,
            totalTokens: 400,
            requestCount: 2,
            latestPromptTokens: 250,
        });
        expect((agent as any).activeSessions.get(sessionId).session.lastPromptTokens).toBe(250);

        agent.close();
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(replayed.lastPromptTokens).toBe(250);
    });

    test("non-abort error path materializes a failed turn keeping the user message and partial tool segments in history", async () => {
        const networkError = Object.assign(new Error("LLM provider 请求失败（HTTP 502）：502 status code (no body)"), {
            status: 502,
            partialMessages,
        });
        runChatQueryImpl = async () => {
            throw networkError;
        };

        await expect(agent.sendMessage(sessionId, "再来")).rejects.toThrow("502");

        // session 物化：用户消息与失败前已产生的工具段全部保留在 failed turn
        const session = (agent as any).activeSessions.get(sessionId).session;
        expect(session.turns).toBeArrayOfSize(1);
        expect(session.turns[0].status).toBe("failed");
        expect(stripMeta(session.turns[0].messages)).toEqual([
            { role: "user", content: "再来" },
            ...partialMessages,
        ]);
        expect(session.totalUserTurnCount).toBe(1);

        // 事件日志：turn_commit(stopReason=error) 保留 partial tool calls 消息
        const events = readSession();
        const errorCommit = events.find((event: any) => event.type === "turn_commit" && event.payload.stopReason === "error");
        expect(errorCommit).toBeDefined();
        expect(errorCommit.payload.error).toContain("502");
        expect(events.filter((event: any) => event.type === "turn_message").map((event: any) => event.payload.message)).toEqual(partialMessages);

        // 模拟重启恢复：从事件日志重放重建会话
        agent.close();
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(replayed.turns).toBeArrayOfSize(1);
        expect(replayed.turns[0].status).toBe("failed");
        expect(stripMeta(replayed.turns[0].messages)).toEqual([
            { role: "user", content: "再来" },
            ...partialMessages,
        ]);
        expect(getSessionContextHistory(replayed).map(message => message.content)).toContain("再来");
        freshAgent.close();
    });

    test("abort then error keeps both turns materialized independently", async () => {
        runChatQueryImpl = async () => {
            throw makeAbortError(partialMessages);
        };
        await agent.sendMessage(sessionId, "跑一下");

        const networkError = new Error("fetch failed");
        runChatQueryImpl = async () => {
            throw networkError;
        };
        await expect(agent.sendMessage(sessionId, "再来")).rejects.toThrow("fetch failed");

        // 连续中断/失败不再有对位丢弃：两段各自物化，一次也不丢
        const session = (agent as any).activeSessions.get(sessionId).session;
        expect(session.turns).toBeArrayOfSize(2);
        expect(session.turns[0].status).toBe("interrupted");
        expect(stripMeta(session.turns[0].messages)).toEqual([
            { role: "user", content: "跑一下" },
            ...partialMessages,
        ]);
        expect(session.turns[1].status).toBe("failed");
        expect(stripMeta(session.turns[1].messages)).toEqual([
            { role: "user", content: "再来" },
        ]);
    });

    test("失败后的下一轮请求包含失败消息，重启后也能继续", async () => {
        runChatQueryImpl = async () => { throw new Error("Connection error."); };
        await expect(agent.sendMessage(sessionId, "保留这个问题")).rejects.toThrow("Connection error.");

        await agent.close();
        const freshAgent = new LocalTuiAgent();
        let capturedHistory: any[] = [];
        runChatQueryImpl = async options => {
            capturedHistory = options.history;
            await options.onTurnMessage?.({ role: "assistant", content: "我记得" });
            return { content: "我记得", messages: [{ role: "assistant", content: "我记得" }] };
        };
        await freshAgent.sendMessage(sessionId, "接着说");

        expect(capturedHistory.map(message => message.content)).toContain("保留这个问题");
        await freshAgent.close();
    });

    test("失败后 /continue 重试原请求，不重复写用户消息", async () => {
        runChatQueryImpl = async () => { throw new Error("Connection error."); };
        await expect(agent.sendMessage(sessionId, "重试的问题")).rejects.toThrow("Connection error.");

        let captured: any;
        runChatQueryImpl = async options => {
            captured = options;
            await options.onTurnMessage?.({ role: "assistant", content: "完成" });
            return { content: "完成", messages: [{ role: "assistant", content: "完成" }] };
        };
        expect((await agent.resumeSession(sessionId)).resumed).toBe(true);
        expect(captured.skipUserQuery).toBe(true);
        expect(captured.history.map((message: any) => message.content)).toContain("重试的问题");
        expect(readSession().filter((event: any) => event.type === "user_message")).toHaveLength(1);
    });

    test("失败终态仍从流式检查点恢复未形成完整消息的文字", async () => {
        runChatQueryImpl = async options => {
            await options.onStreamDelta?.({ text: "已显示的部分" }, 1);
            throw new Error("Connection error.");
        };
        await expect(agent.sendMessage(sessionId, "问题")).rejects.toThrow("Connection error.");

        const events = readSession();
        expect(events.some((event: any) => event.type === "turn_stream_delta" && event.payload.delta.text === "已显示的部分"))
            .toBe(true);
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(getSessionContextHistory(replayed).map(message => message.content)).toEqual(["问题", "已显示的部分"]);
        await freshAgent.close();
    });

    test("interrupted turn survives restart via event log replay", async () => {
        runChatQueryImpl = async () => {
            throw makeAbortError(partialMessages);
        };
        await agent.sendMessage(sessionId, "中断一下");
        agent.close();

        // 模拟重启：新 agent 实例从事件日志全量重放重建会话
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(replayed.turns).toBeArrayOfSize(1);
        expect(replayed.turns[0].status).toBe("interrupted");
        expect(stripMeta(replayed.turns[0].messages)).toEqual([
            { role: "user", content: "中断一下" },
            ...partialMessages,
        ]);
        expect(replayed.totalUserTurnCount).toBe(1);
        freshAgent.close();
    });

    test("非 abort 错误路径把 error message 写入 turn_commit 事件", async () => {
        const networkError = Object.assign(new Error("fetch failed"), { status: 502 });
        runChatQueryImpl = async () => {
            throw networkError;
        };

        await expect(agent.sendMessage(sessionId, "first")).rejects.toThrow("fetch failed");

        const events = readSession();
        const errorCommit = events.find((event: any) => event.type === "turn_commit" && event.payload.stopReason === "error");
        expect(errorCommit).toBeDefined();
        expect(errorCommit.payload.error).toContain("fetch failed");
    });

    test("close() 等待进行中的 turn 落盘后再返回（处理中退出不丢上下文）", async () => {
        runChatQueryImpl = options => new Promise((_resolve, reject) => {
            // 中止后网络请求稍晚才抛出，验证 close 会等到 turn 物化完成
            options.signal.addEventListener("abort", () => {
                setTimeout(() => reject(makeAbortError(partialMessages)), 20);
            });
        });

        const sending = agent.sendMessage(sessionId, "退出前的消息");
        await new Promise(resolve => setTimeout(resolve, 10));
        // 此刻只有 user_message 落盘，turn_commit 尚未写入
        expect(readSession().some(event => event.type === "user_message")).toBe(true);
        expect(readSession().some(event => event.type === "turn_commit")).toBe(false);

        await agent.close();
        expect(await sending).toEqual({ aborted: true });

        const commit = readSession().find(event => event.type === "turn_commit");
        expect(commit?.payload.interrupted).toBe(true);
        expect(commit?.payload.userMessages).toEqual(["退出前的消息"]);

        // 模拟重启：新 agent 从事件日志重放，用户消息与工具段仍在上下文
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(replayed.turns).toBeArrayOfSize(1);
        expect(replayed.turns[0].status).toBe("interrupted");
        expect(stripMeta(replayed.turns[0].messages)).toEqual([
            { role: "user", content: "退出前的消息" },
            ...partialMessages,
        ]);
        await freshAgent.close();
    });

    test("onTurnMessage 把回合内每条完整消息写成 turn_message（同一 turnId）", async () => {
        runChatQueryImpl = async options => {
            await options.onTurnMessage?.({
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
            });
            await options.onTurnMessage?.({ role: "tool", tool_call_id: "c1", name: "bash", content: "结果" });
            return {
                content: "完成",
                messages: [{ role: "assistant", content: "完成" }],
            };
        };

        await agent.sendMessage(sessionId, "查一下");

        const events = readSession();
        const userEvent = events.find(event => event.type === "user_message");
        const turnMessages = events.filter(event => event.type === "turn_message");
        expect(turnMessages).toHaveLength(2);
        // 增量与终态、用户消息共享同一个 turnId
        expect(turnMessages[0].payload.turnId).toBe(userEvent.payload.turnId);
        expect(turnMessages[1].payload.turnId).toBe(userEvent.payload.turnId);
        expect(turnMessages[1].payload.message).toMatchObject({ role: "tool", content: "结果" });
        // 落盘顺序 = 消息顺序
        expect(turnMessages.map(event => event.payload.message.role)).toEqual(["assistant", "tool"]);
        expect(events.at(-1).payload.turnId).toBe(userEvent.payload.turnId);
    });

    test("resumeSession 重跑缺失工具且不产生用户消息（对上游无感）", async () => {
        // 先造一个中断回合：assistant(tool_calls) 无结果
        runChatQueryImpl = async () => {
            throw makeAbortError([
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
                },
            ]);
        };
        await agent.sendMessage(sessionId, "查一下");

        let captured: any;
        runChatQueryImpl = async options => {
            captured = options;
            await options.onTurnMessage?.({ role: "tool", tool_call_id: "c1", name: "bash", content: "重跑结果" });
            await options.onTurnMessage?.({ role: "assistant", content: "完成" });
            return {
                content: "完成",
                messages: [
                    { role: "tool", tool_call_id: "c1", name: "bash", content: "重跑结果" },
                    { role: "assistant", content: "完成" },
                ],
            };
        };

        const result = await agent.resumeSession(sessionId);
        expect(result.resumed).toBe(true);
        expect(result.aborted).toBeUndefined();

        // 请求对上游无感：不插 user 消息，补跑缺失工具
        expect(captured.skipUserQuery).toBe(true);
        expect(captured.pendingToolCalls).toEqual([
            { id: "c1", name: "bash", args: { cmd: "ls" }, rawArgs: '{"cmd":"ls"}' },
        ]);
        expect(captured.initialRequestKind).toBe("turn_resume");

        const events = readSession();
        // 续跑不写 user_message
        expect(events.filter(event => event.type === "user_message")).toHaveLength(1);
        const commits = events.filter(event => event.type === "turn_commit");
        expect(commits).toHaveLength(2);
        expect(commits[1].payload.userMessages).toEqual([]);
        expect(commits[1].payload.turnId).not.toBe(commits[0].payload.turnId);

        // 重启重放：中断回合 + 无用户消息的续跑回合，工具消息紧跟 assistant
        const freshAgent = new LocalTuiAgent();
        const replayed = await (freshAgent as any).requireActiveSession(sessionId);
        expect(replayed.turns).toBeArrayOfSize(2);
        expect(replayed.turns[0].status).toBe("interrupted");
        expect(replayed.turns[1].status).toBe("completed");
        expect(replayed.turns[1].messages.map((message: any) => message.role)).toEqual(["tool", "assistant"]);
        await freshAgent.close();
    });

    test("resumeSession 无可续跑点时返回原因且不发请求", async () => {
        let requestCount = 0;
        runChatQueryImpl = async () => {
            requestCount += 1;
            return { content: "答", messages: [{ role: "assistant", content: "答" }] };
        };
        await agent.sendMessage(sessionId, "问");
        requestCount = 0;

        const result = await agent.resumeSession(sessionId);
        expect(result.resumed).toBe(false);
        expect(result.reason).toBeTruthy();
        expect(requestCount).toBe(0);
    });
});

// mock.module 是进程级全局：本文件跑完必须恢复，否则同 worker 的后续文件会拿到假实现
afterAll(() => {
    mock.restore();
});
