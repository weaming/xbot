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

describe("getOpenAIToolDefinitions 按会话选中集下发", () => {
    test("选中该 server → 全组工具下发，与 lazy 标记和 tool_search 都无关", () => {
        for (const toolSearch of [true, false]) {
            const defined = names({ mcpServers: [SERVER], toolSearch, selectedServers: [SERVER] });

            expect(defined).toContain("lazy__on_demand");
            expect(defined).toContain("lazy__always");
        }
    });

    test("选中集里没有该 server → 整组不下发（含未标 lazy 的工具）", () => {
        const defined = names({ mcpServers: [SERVER], selectedServers: [] });

        expect(defined).not.toContain("lazy__on_demand");
        expect(defined).not.toContain("lazy__always");
    });

    test("会话没有初始化选中集（老会话）→ 不限制，全部下发", () => {
        const defined = names({ mcpServers: [SERVER] });

        expect(defined).toContain("lazy__on_demand");
        expect(defined).toContain("lazy__always");
    });
});
