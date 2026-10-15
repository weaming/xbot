import { describe, it, expect } from "bun:test";
import { executeWithChat, type ChatClient } from "./chat-orchestrator.js";
import type { UIEvent } from "../events/ui-events.js";

function textChunk(content: string, extra: any = {}): any {
    return {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        ...extra,
    };
}

function toolCallChunk(partial: any, finishReason: string | null = null): any {
    return {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: { tool_calls: [partial] }, finish_reason: finishReason }],
    };
}

function fakeClient(chunks: any[], followUp?: any[]): ChatClient {
    let callCount = 0;
    return {
        baseURL: "http://test.local/v1",
        create: async () => ({
            [Symbol.asyncIterator]: async function* () {
                callCount++;
                const current = callCount === 1 ? chunks : (followUp ?? [
                    textChunk("完成"),
                    { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                ]);
                for (const chunk of current) yield chunk;
            },
        }),
    };
}

describe("executeWithChat 流式聚合", () => {
    it("text_delta 事件序列与聚合结果", async () => {
        const chunks = [
            textChunk("你"),
            textChunk("好"),
            {
                ...textChunk(""),
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
        ];
        const events: UIEvent[] = [];
        const result = await executeWithChat({
            query: "hi",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            onEvent: event => events.push(event),
        });

        expect(result.content).toBe("你好");
        expect(events.filter(event => event.type === "text_delta").map(event => (event as any).delta))
            .toEqual(["你", "好"]);
        expect(events.some(event => event.type === "message_end")).toBe(true);

        const assistant = result.messages.find(message => message.role === "assistant");
        expect(assistant?.content).toBe("你好");
        expect(assistant?.role).toBe("assistant");
    });

    it("tool_calls 按 index 聚合增量并执行", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-1", function: { name: "search_tools", arguments: "" } }),
            toolCallChunk({ index: 0, function: { arguments: '{"q":' } }),
            toolCallChunk({ index: 0, function: { arguments: '"x"}' } }, "tool_calls"),
        ];
        const events: UIEvent[] = [];
        const calls: Array<{ name: string; args: any }> = [];
        const result = await executeWithChat({
            query: "q",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "ok";
            },
            onEvent: event => events.push(event),
        });

        expect(calls).toEqual([{ name: "search_tools", args: { q: "x" } }]);
        expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
        expect(events.filter(event => event.type === "toolcall_args_delta")).toHaveLength(2);
        expect(events.some(event => event.type === "tool_start" && event.name === "search_tools")).toBe(true);
        expect(events.some(event => event.type === "tool_result" && event.name === "search_tools")).toBe(true);
        expect(result.toolCalls).toBeGreaterThan(1);
    });

    it("保留流式工具调用的 thought_signature", async () => {
        const chunks = [
            toolCallChunk({
                index: 0,
                id: "call-1",
                thought_signature: "c2lnbmF0dXJl",
                function: { name: "search_tools", arguments: "{}" },
            }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => "ok",
        });

        expect(requests[1].messages.at(-2)?.tool_calls?.[0]?.thought_signature)
            .toBe("c2lnbmF0dXJl");
    });

    it("reasoning_content 聚合进 assistant 消息并发出 reasoning_delta", async () => {
        const chunks = [
            { ...textChunk(""), choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
            textChunk("答案"),
            { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        const events: UIEvent[] = [];
        const result = await executeWithChat({
            query: "q",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            onEvent: event => events.push(event),
        });

        expect(events.some(event => event.type === "reasoning_delta" && event.delta === "think")).toBe(true);
        const assistant = result.messages.find(message => message.role === "assistant");
        expect(assistant?.reasoning_content).toBe("think");
    });

    it("超大工具结果在请求中被投影，完整历史仍保留原文", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-big", function: { name: "big_tool", arguments: "{}" } }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const hugeResult = "x".repeat(50_000);
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => hugeResult,
        });

        const toolInRequest = requests[1].messages.at(-1);
        expect(toolInRequest.role).toBe("tool");
        expect(toolInRequest.tool_call_id).toBe("call-big");
        expect(toolInRequest.content).toContain("[工具结果已截取");
        expect(toolInRequest.content.length).toBeLessThan(hugeResult.length);

        const toolInHistory = result.messages.find(message => message.role === "tool");
        expect(toolInHistory?.tool_call_id).toBe("call-big");
        expect(toolInHistory?.content).toBe(hugeResult);
    });

    it("preserveFull 工具结果在请求中完整保留且剥离 contextPolicy", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-full", function: { name: "full_tool", arguments: "{}" } }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const hugeResult = "y".repeat(50_000);
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => ({
                content: hugeResult,
                contextPolicy: { mode: "full" },
            }),
        });

        const toolInRequest = requests[1].messages.at(-1);
        expect(toolInRequest.role).toBe("tool");
        expect(toolInRequest.tool_call_id).toBe("call-full");
        expect(toolInRequest.content).toBe(hugeResult);
        expect(toolInRequest).not.toHaveProperty("contextPolicy");

        const toolInHistory = result.messages.find(message => message.role === "tool");
        expect(toolInHistory?.content).toBe(hugeResult);
    });

    it("并行多工具调用按 tool_call_id 正确配对且各自投影", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-a", function: { name: "tool_a", arguments: "{}" } }),
            toolCallChunk({ index: 1, id: "call-b", function: { name: "tool_b", arguments: "{}" } }),
            toolCallChunk({ index: 0 }, "tool_calls"),
            toolCallChunk({ index: 1 }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const called: string[] = [];
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async (name) => {
                called.push(name);
                return name === "tool_a" ? "ok" : "b".repeat(100_000);
            },
        });

        expect(called.sort()).toEqual(["tool_a", "tool_b"]);
        const requestMessages = requests[1].messages;
        const toolMessages = requestMessages.filter((message: any) => message.role === "tool");
        expect(toolMessages).toHaveLength(2);
        expect(toolMessages.map((message: any) => message.tool_call_id).sort())
            .toEqual(["call-a", "call-b"]);

        const toolA = toolMessages.find((message: any) => message.tool_call_id === "call-a");
        const toolB = toolMessages.find((message: any) => message.tool_call_id === "call-b");
        expect(toolA.content).toBe("ok");
        expect(toolB.content).toContain("[工具结果已截取");

        const assistantCalls = requestMessages.find((message: any) => message.role === "assistant")?.tool_calls;
        expect(assistantCalls.map((call: any) => call.id).sort()).toEqual(["call-a", "call-b"]);

        const historyToolB = result.messages.find(message => message.role === "tool" && message.tool_call_id === "call-b");
        expect(historyToolB?.content).toBe("b".repeat(100_000));
    });

    it("skipUserQuery 不把 query 插入请求消息（续跑对上游无感）", async () => {
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "不应出现",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            history: [{ role: "user", content: "查行情" }],
            skipUserQuery: true,
        });

        expect(requests[0].messages).toEqual([
            { role: "system", content: "sys" },
            { role: "user", content: "查行情" },
        ]);
    });

    it("续跑补跑结果紧跟在 assistant(tool_calls) 之后，不出现重复 tool 消息", async () => {
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            // 历史修复跳过 c1（待重跑），因此这里没有合成的 tool 结果
            history: [
                { role: "user", content: "查行情" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
                },
            ],
            skipUserQuery: true,
            pendingToolCalls: [{ id: "c1", name: "bash", args: {}, rawArgs: "{}" }],
            executeTool: async () => "真实结果",
        });

        const messages = requests[0].messages;
        const toolMessages = messages.filter((message: any) => message.role === "tool");
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0].content).toBe("真实结果");
        const assistantIndex = messages.findIndex((message: any) => message.role === "assistant");
        expect(messages[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    });

    it("pendingToolCalls 在进入循环前补跑并落进消息与 onTurnMessage", async () => {
        const calls: Array<{ name: string; args: any }> = [];
        const persisted: any[] = [];
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const result = await executeWithChat({
            query: "",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            history: [
                { role: "user", content: "查行情" },
                { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
            ],
            skipUserQuery: true,
            pendingToolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" }, rawArgs: '{"cmd":"ls"}' }],
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "重跑结果";
            },
            onTurnMessage: message => { persisted.push(message); },
        });

        expect(calls).toEqual([{ name: "bash", args: { cmd: "ls" } }]);
        expect(result.messages[0]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "重跑结果" });
        // 补跑结果先于最终 assistant 文本落盘
        expect(persisted.map(message => message.role)).toEqual(["tool", "assistant"]);
        const requestMessages = requests[0].messages;
        expect(requestMessages.filter((message: any) => message.role === "tool")).toHaveLength(1);
    });
});
