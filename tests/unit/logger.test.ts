import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    applyConsoleTimestamps,
    CONSOLE_TIMESTAMP_MARK,
    formatAIInteractionLogEntry,
    recordLLMExchange,
} from "../../src/utils/logger.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-logger-"));
    process.env.XBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    delete process.env.XBOT_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("console 时间戳", () => {
    function makeConsole(): { target: Console; calls: any[][] } {
        const calls: any[][] = [];
        const target = {
            log: (...args: any[]) => calls.push(args),
            info: (...args: any[]) => calls.push(args),
            warn: (...args: any[]) => calls.push(args),
            error: (...args: any[]) => calls.push(args),
        } as unknown as Console;
        return { target, calls };
    }

    test("加上本地时间戳前缀且重复调用幂等", () => {
        const { target, calls } = makeConsole();

        applyConsoleTimestamps(target);
        applyConsoleTimestamps(target);
        target.log("hello");

        expect(calls.length).toBe(1);
        expect(calls[0][0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
        expect(calls[0][1]).toBe("hello");
    });

    test("已被 TUI 日志重定向接管（标记存在）时跳过，避免两个时间戳", () => {
        const { target, calls } = makeConsole();
        (target as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK] = true;

        applyConsoleTimestamps(target);
        target.log("hello");

        expect(calls).toEqual([["hello"]]);
    });
});

describe("AI 交互日志", () => {
    test("将每次交互编码为可独立解析的 JSONL 记录", () => {
        const content = {
            messages: [{ role: "user", content: "包含\n换行的内容" }],
            enabled: true,
        };

        const entry = JSON.parse(formatAIInteractionLogEntry("REQUEST", content));

        expect(entry).toEqual({
            schemaVersion: 1,
            timestamp: expect.any(String),
            type: "REQUEST",
            content,
        });
        expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    test("保留字符串内容而不生成额外日志行", () => {
        const entry = formatAIInteractionLogEntry("ERROR", "第一行\n第二行");

        expect(entry).not.toContain("\n");
        expect(JSON.parse(entry)).toMatchObject({
            type: "ERROR",
            content: "第一行\n第二行",
        });
    });
});

describe("LLM exchange 链式增量记录", () => {
    const toolsA = [{ type: "function", function: { name: "t1" } }];

    function readRequests(): any[] {
        const text = fs.readFileSync(path.join(tmpDir, "logs", "llm-exchange.jsonl"), "utf8");
        return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    }

    test("REQUEST 只记录相对上一请求新增的 messages，tools 未变化只写 hash", () => {
        recordLLMExchange("REQUEST", {
            model: "m",
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
            ],
            tools: toolsA,
        }, { requestId: "r1" });

        recordLLMExchange("REQUEST", {
            model: "m",
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
                { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
                { role: "tool", tool_call_id: "c1", name: "t1", content: "res" },
            ],
            tools: toolsA,
        }, { requestId: "r2", parentRequestId: "r1", prevMessageCount: 2 });

        const requests = readRequests().filter(entry => entry.type === "REQUEST").map(entry => entry.content);
        expect(requests).toHaveLength(2);
        expect(requests[1].messages).toEqual([
            { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
            { role: "tool", tool_call_id: "c1", name: "t1", content: "res" },
        ]);
        expect(requests[1].parentRequestId).toBe("r1");
        expect(requests[1].toolsHash).toBeDefined();
        expect(requests[1].tools).toBeUndefined();
    });

    test("tools 变化时写入全量定义", () => {
        const toolsT2 = [{ type: "function", function: { name: "t2" } }];
        recordLLMExchange("REQUEST", { messages: [], tools: toolsT2 }, { requestId: "r1" });
        recordLLMExchange("REQUEST", { messages: [], tools: [{ type: "function", function: { name: "t2b" } }] }, { requestId: "r2", prevMessageCount: 0 });

        const r2 = readRequests()[1].content;
        expect(r2.tools).toEqual([{ type: "function", function: { name: "t2b" } }]);
    });

    test("RESPONSE 关联到对应 requestId", () => {
        recordLLMExchange("REQUEST", { messages: [], tools: toolsA }, { requestId: "r1" });
        recordLLMExchange("RESPONSE", { choices: [{ message: { role: "assistant", content: "hi" } }] }, { requestId: "r1" });

        const response = readRequests()[1];
        expect(response.type).toBe("RESPONSE");
        expect(response.content.requestId).toBe("r1");
    });

    test("RESPONSE 合并 usage 统计（原 llm-usage 行）", () => {
        recordLLMExchange("RESPONSE", { choices: [] }, {
            requestId: "r1",
            usage: {
                timestamp: "2026-08-31T00:00:00.000Z",
                caller: "xbot",
                request_kind: "user_request",
                model: "m",
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                input_chars: 34,
                output_chars: 4,
                duration_ms: 1,
                token_usage_source: "provider",
            } as any,
        });

        const response = readRequests()[0];
        expect(response.content.usage.prompt_tokens).toBe(10);
        expect(response.content.usage.total_tokens).toBe(15);
    });

    test("有 sessionId 时按 session 分离写入 sessions/<id>.exchange.jsonl", () => {
        recordLLMExchange("REQUEST", { messages: [{ role: "user", content: "q" }], tools: toolsA }, {
            requestId: "r1",
            sessionId: "sess-1",
        });

        const sessionFile = path.join(tmpDir, "sessions", "http", "sess-1.jsonl");
        expect(fs.existsSync(sessionFile)).toBe(true);
        const entry = JSON.parse(fs.readFileSync(sessionFile, "utf8").trim());
        expect(entry.content.requestId).toBe("r1");
        // 全局文件不写入
        expect(fs.existsSync(path.join(tmpDir, "logs", "llm-exchange.jsonl"))).toBe(false);
    });

    test("同 session 跨调用自动成链并只写消息增量（调用方无需维护链状态）", () => {
        const toolsT4 = [{ type: "function", function: { name: "t4" } }];

        // 第一次 sendMessage：仅传 sessionId
        recordLLMExchange("REQUEST", {
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "q1" }],
            tools: toolsT4,
        }, { sessionId: "sess-3" });

        // 第二次 sendMessage（新 executeWithChat，但同 session）：自动成链 + 增量
        recordLLMExchange("REQUEST", {
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
                { role: "assistant", content: "a1" },
                { role: "user", content: "q2" },
            ],
            tools: toolsT4,
        }, { sessionId: "sess-3" });

        const file = path.join(tmpDir, "sessions", "http", "sess-3.jsonl");
        const requests = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
            .map(line => JSON.parse(line).content)
            .filter(c => c.requestId);

        expect(requests).toHaveLength(2);
        expect(requests[0].messages).toHaveLength(2);      // 首次全量
        expect(requests[0].parentRequestId).toBeUndefined();
        expect(requests[1].parentRequestId).toBe(requests[0].requestId); // 自动成链
        expect(requests[1].messages).toEqual([             // 只写新增
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ]);
    });

    test("RESPONSE 自动关联最近一次 REQUEST", () => {
        recordLLMExchange("REQUEST", { messages: [{ role: "user", content: "q" }], tools: toolsA }, { sessionId: "sess-4" });
        recordLLMExchange("RESPONSE", { choices: [] }, { sessionId: "sess-4" });

        const response = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "sessions", "http", "sess-4.jsonl"), "utf8").trim().split("\n")[1],
        );
        expect(response.type).toBe("RESPONSE");
        expect(response.content.requestId).toBeTypeOf("string");
    });

});
