/**
 * 特征测试：锁住重构前必须保持不变的对外行为。
 *
 * 这些断言不描述"理想设计"，只记录当前实现真实表现出的性质。
 * 重构（尤其是 orchestrator 状态机化、工具装配纯函数化）之后必须继续成立；
 * 一旦失败，说明行为发生了未声明的变化，应视为回归而非"测试需要更新"。
 */

import { describe, expect, test } from "bun:test";
import { executeWithChat } from "../../src/tools/chat-orchestrator.js";

/** 造一个只返回固定响应的 Chat Completions 客户端，并记录每次请求体。 */
function recordingClient(respond: (body: any, callIndex: number) => any) {
    const requests: any[] = [];
    const client = {
        baseURL: "https://api.example.com/v1",
        protocol: "chat_completions" as const,
        create: async (body: any) => {
            requests.push(structuredClone(body));
            return respond(body, requests.length - 1);
        },
    };
    return { client, requests };
}

function toolDef(name: string) {
    return { type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } };
}

describe("特征：请求装配", () => {
    test("工具定义按名称排序下发，与传入顺序无关", async () => {
        const { client, requests } = recordingClient(() => ({
            choices: [{ message: { content: "done" } }],
        }));

        await executeWithChat({
            query: "hi",
            client,
            model: "m",
            tools: [toolDef("zeta"), toolDef("alpha"), toolDef("mid")],
        });

        const names = requests[0].tools.map((tool: any) => tool.function.name);
        expect(names).toEqual(["alpha", "mid", "zeta"]);
    });

    test("同一组工具两次调用产出的请求前缀完全一致（缓存可用性前提）", async () => {
        const first = recordingClient(() => ({ choices: [{ message: { content: "a" } }] }));
        await executeWithChat({ query: "q", client: first.client, model: "m", tools: [toolDef("b"), toolDef("a")] });

        const second = recordingClient(() => ({ choices: [{ message: { content: "a" } }] }));
        await executeWithChat({ query: "q", client: second.client, model: "m", tools: [toolDef("a"), toolDef("b")] });

        expect(JSON.stringify(second.requests[0].tools)).toBe(JSON.stringify(first.requests[0].tools));
    });

    test("system prompt 在消息列表最前，用户消息在最后", async () => {
        const { client, requests } = recordingClient(() => ({ choices: [{ message: { content: "ok" } }] }));

        await executeWithChat({
            query: "问题",
            client,
            model: "m",
            getSystemPrompt: () => "系统提示",
            history: [{ role: "user", content: "历史" }],
        });

        const messages = requests[0].messages;
        expect(messages[0]).toEqual({ role: "system", content: "系统提示" });
        expect(messages.at(-1)).toEqual({ role: "user", content: "问题" });
    });

    test("无工具时 tool_choice 为 none，有工具时为 auto", async () => {
        const withoutTools = recordingClient(() => ({ choices: [{ message: { content: "ok" } }] }));
        await executeWithChat({ query: "q", client: withoutTools.client, model: "m" });
        expect(withoutTools.requests[0].tool_choice).toBe("none");

        const withTools = recordingClient(() => ({ choices: [{ message: { content: "ok" } }] }));
        await executeWithChat({ query: "q", client: withTools.client, model: "m", tools: [toolDef("a")] });
        expect(withTools.requests[0].tool_choice).toBe("auto");
    });
});

describe("特征：工具循环", () => {
    test("工具结果按 tool_call_id 回填，且请求数等于轮次", async () => {
        const { client, requests } = recordingClient((_body, index) => {
            if (index === 0) {
                return {
                    choices: [{
                        message: {
                            content: null,
                            tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    }],
                };
            }
            return { choices: [{ message: { content: "完成" } }] };
        });

        const result = await executeWithChat({
            query: "q",
            client,
            model: "m",
            tools: [toolDef("echo")],
            executeTool: async () => ({ content: "tool-output" }),
        });

        expect(requests).toHaveLength(2);
        const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
        expect(toolMessage.tool_call_id).toBe("call_1");
        expect(toolMessage.content).toBe("tool-output");
        expect(result.content).toBe("完成");
    });

    test("工具抛错时把错误文本作为结果回填，回合继续", async () => {
        const { client, requests } = recordingClient((_body, index) => {
            if (index === 0) {
                return {
                    choices: [{
                        message: {
                            content: null,
                            tool_calls: [{ id: "call_x", type: "function", function: { name: "boom", arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    }],
                };
            }
            return { choices: [{ message: { content: "已处理错误" } }] };
        });

        const result = await executeWithChat({
            query: "q",
            client,
            model: "m",
            tools: [toolDef("boom")],
            executeTool: async () => { throw new Error("工具炸了"); },
        });

        const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
        expect(toolMessage.content).toContain("工具炸了");
        expect(result.content).toBe("已处理错误");
    });

    test("相邻工具调用并行执行，结果顺序与调用顺序一致", async () => {
        const order: string[] = [];
        const { client, requests } = recordingClient((_body, index) => {
            if (index === 0) {
                return {
                    choices: [{
                        message: {
                            content: null,
                            tool_calls: ["slow", "fast"].map((name, i) => ({
                                id: `call_${i}`,
                                type: "function",
                                function: { name, arguments: "{}" },
                            })),
                        },
                        finish_reason: "tool_calls",
                    }],
                };
            }
            return { choices: [{ message: { content: "ok" } }] };
        });

        await executeWithChat({
            query: "q",
            client,
            model: "m",
            tools: [toolDef("slow"), toolDef("fast")],
            executeTool: async (name: string) => {
                await new Promise(resolve => setTimeout(resolve, name === "slow" ? 20 : 1));
                order.push(name);
                return { content: `${name}-done` };
            },
        });

        // 并行：快的先结束
        expect(order).toEqual(["fast", "slow"]);
        // 已修正的时序缺陷：此前工具消息按**完成顺序**追加，下一轮请求前缀会随调度时序抖动。
        // 现在并行只影响耗时，入列严格按调用顺序。
        const toolMessages = requests[1].messages.filter((message: any) => message.role === "tool");
        expect(toolMessages.map((message: any) => message.tool_call_id)).toEqual(["call_0", "call_1"]);
    });
});

describe("特征：增量消息落盘顺序", () => {
    test("onTurnMessage 按消息产生顺序依次收到，且回合结束前全部完成", async () => {
        const received: string[] = [];
        const { client } = recordingClient((_body, index) => {
            if (index === 0) {
                return {
                    choices: [{
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    }],
                };
            }
            return { choices: [{ message: { role: "assistant", content: "最终回答" } }] };
        });

        const toolOutput = await executeWithChat({
            query: "q",
            client,
            model: "m",
            tools: [toolDef("t")],
            executeTool: async () => ({ content: "tool-result" }),
            onTurnMessage: async (message) => {
                // 故意慢一点：若实现不串行，后一条会抢在前面
                await new Promise(resolve => setTimeout(resolve, 5));
                received.push(`${message.role}:${message.content ?? ""}`);
            },
        });

        expect(toolOutput.content).toBe("最终回答");
        expect(received).toEqual([
            "assistant:",
            "tool:tool-result",
            "assistant:最终回答",
        ]);
    });
});
