import { describe, expect, test } from "bun:test";

import {
    appendHostedTools,
    buildRequestBody,
    toHostedToolDefinitions,
    toResponsesToolDefinitions,
} from "../../src/tools/orchestrator/request-builder.js";
import { prepareRequest } from "../../src/tools/orchestrator/turn-request.js";

/** OPENAI_HOSTED_TOOLS 的托管工具声明：只声明，不执行，且不挤动 function 前缀。 */

const functionTools = [
    { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
];

describe("toHostedToolDefinitions", () => {
    test("逗号分隔值去空白、去空项、去重后变成扁平工具定义", () => {
        expect(toHostedToolDefinitions([" web_search ", "", "web_search_preview", "web_search"]))
            .toEqual([{ type: "web_search" }, { type: "web_search_preview" }]);
    });

    test("空列表不产生工具定义", () => {
        expect(toHostedToolDefinitions([])).toEqual([]);
    });
});

describe("appendHostedTools", () => {
    test("追加在尾部，同类型不重复", () => {
        const base = [...toResponsesToolDefinitions(functionTools), { type: "web_search" }];
        expect(appendHostedTools(base, [{ type: "web_search" }, { type: "web_search_preview" }])
            .map(tool => tool.type))
            .toEqual(["function", "function", "web_search", "web_search_preview"]);
    });
});

describe("Responses 请求体", () => {
    test("function 工具保持名称序，托管工具排在后面", () => {
        const tools = appendHostedTools(
            toResponsesToolDefinitions(functionTools),
            toHostedToolDefinitions(["web_search"]),
        );
        const body = buildRequestBody({
            protocol: "responses",
            model: "gpt-5.6-luna",
            baseURL: "http://127.0.0.1:3060/v1",
            messages: [{ role: "user", content: "hi" }],
            tools,
            stream: true,
            isMiniMax: false,
        });

        expect(body.tools.map((tool: any) => tool.type)).toEqual(["function", "function", "web_search"]);
        expect(body.tools[2]).toEqual({ type: "web_search" });
        expect(body.tool_choice).toBe("auto");
    });

    test("只有托管工具时也声明 tool_choice=auto", () => {
        const tools = toHostedToolDefinitions(["web_search"]);
        const body = buildRequestBody({
            protocol: "responses",
            model: "gpt-5.6-luna",
            baseURL: "http://127.0.0.1:3060/v1",
            messages: [{ role: "user", content: "今天有什么 AI 新闻？" }],
            tools,
            stream: false,
            isMiniMax: false,
        });

        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toBe("auto");
    });

    test("仅启用 tool_search 时把 defer=true 的 MCP function 标记 defer_loading", () => {
        const deferredMcpTool = {
            type: "function",
            deferLoading: true,
            function: { name: "remote__lookup", description: "Lookup", parameters: { type: "object" } },
        };
        expect(toResponsesToolDefinitions([deferredMcpTool], false)[0]).not.toHaveProperty("defer_loading");
        expect(toResponsesToolDefinitions([deferredMcpTool], true)[0]).toHaveProperty("defer_loading", true);
    });
});

describe("Chat Completions 请求体", () => {
    test("托管工具同样追加在 function 定义之后", () => {
        const tools = appendHostedTools(functionTools, toHostedToolDefinitions(["web_search"]));
        const body = buildRequestBody({
            protocol: "chat_completions",
            model: "gpt-5.6-luna",
            baseURL: "http://127.0.0.1:8787/provider/codex/v1",
            messages: [{ role: "user", content: "今天有什么 AI 新闻？" }],
            tools,
            stream: true,
            isMiniMax: false,
        });

        expect(body.tools.map((tool: any) => tool.type)).toEqual(["function", "function", "web_search"]);
        expect(body.stream_options).toEqual({ include_usage: true });
    });
});

test("prepareRequest 仅在启用 tool_search 时发出 defer_loading MCP 定义", async () => {
    const deferredMcpTool = {
        type: "function",
        deferLoading: true,
        function: { name: "remote__lookup", description: "Lookup", parameters: { type: "object" } },
    };
    const prepare = (hostedTools: string[]) => prepareRequest({
        client: {
            baseURL: "http://127.0.0.1:3060/v1",
            protocol: "responses",
            createResponse: async () => {},
        },
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "find" }] as any,
        tools: [deferredMcpTool],
        getToolDefinitions: () => [deferredMcpTool],
        normalizedTools: tools => tools,
        isFirstIteration: true,
        stream: false,
        hostedTools,
    });

    const enabled = await prepare(["tool_search"]);
    const disabled = await prepare(["web_search"]);
    expect(enabled.requestBody.tools).toContainEqual({
        type: "function",
        name: "remote__lookup",
        description: "Lookup",
        parameters: { type: "object" },
        defer_loading: true,
    });
    expect(enabled.requestBody.tools).toContainEqual({ type: "tool_search" });
    expect(disabled.requestBody.tools.find((tool: any) => tool.name === "remote__lookup"))
        .not.toHaveProperty("defer_loading");
    expect(disabled.requestBody.tools).toContainEqual({ type: "web_search" });
});
