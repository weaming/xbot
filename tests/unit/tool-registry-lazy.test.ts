import { afterAll, describe, expect, test } from "bun:test";
import { getOpenAIToolDefinitions } from "../../src/tools/tool-registry.js";
import { toolCatalog } from "../../src/tools/tool-catalog.js";
import type { ExecutableTool } from "../../src/tools/tool-interface.js";

const SERVER = "lazy-test-server";

function lazyTool(name: string, lazy: boolean): ExecutableTool {
    return {
        name,
        description: name,
        fromServer: SERVER,
        inputSchema: { type: "object", properties: {} },
        ...(lazy ? { lazy: true } : {}),
        execute: async () => ({ content: [] }),
    };
}

toolCatalog.syncRemoteTools(SERVER, [lazyTool("lazy__on_demand", true), lazyTool("lazy__always", false)]);

afterAll(() => {
    toolCatalog.syncRemoteTools(SERVER, []);
});

function names(options: Parameters<typeof getOpenAIToolDefinitions>[1]): string[] {
    return getOpenAIToolDefinitions([], options).map((tool: any) => tool.function.name);
}

describe("getOpenAIToolDefinitions 的 lazy 过滤", () => {
    test("不支持 tool_search 时 lazy 工具默认不下发", () => {
        const defined = names({ mcpServers: [SERVER], toolSearch: false });

        expect(defined).not.toContain("lazy__on_demand");
        expect(defined).toContain("lazy__always");
    });

    test("支持 tool_search 时 lazy 工具照常下发（由 defer 决定是否延迟加载）", () => {
        expect(names({ mcpServers: [SERVER], toolSearch: true })).toContain("lazy__on_demand");
    });

    test("会话临时启用的 server 即使不支持 tool_search 也下发", () => {
        const defined = names({ mcpServers: [SERVER], toolSearch: false, lazyServers: [SERVER] });

        expect(defined).toContain("lazy__on_demand");
    });
});
