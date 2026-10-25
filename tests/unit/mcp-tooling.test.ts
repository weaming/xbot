import { describe, expect, test } from "bun:test";
import { buildProxyToolFromRemoteDefinition, createProxyTool, parseToolMetadataFromDescription, sanitizeToolArgs, summarizeAddedToolsByNamePrefix } from "../../src/mcp/tooling.js";

import type { ExecutableTool } from "../../src/tools/tool-interface.js";

function makeTool(name: string, overrides: Partial<ExecutableTool> = {}): ExecutableTool {
    return {
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: name }] }),
        ...overrides,
    };
}

describe("mcp tooling", () => {
    test("parses tool metadata prefixes", () => {
        expect(parseToolMetadataFromDescription("[source:filesystem] [tags:files,read] Read files")).toEqual({
            source: "filesystem",
            tags: ["files", "read"],
            cleanDesc: "Read files",
        });

        expect(parseToolMetadataFromDescription("Plain description")).toEqual({
            source: "",
            tags: [],
            cleanDesc: "Plain description",
        });
    });

    test("sanitizes synthetic args and groups added tools by name prefix", () => {
        expect(sanitizeToolArgs({ path: "/tmp/a.txt", __userId: 1, __trace: "x" })).toEqual({
            path: "/tmp/a.txt",
        });

        const summary = summarizeAddedToolsByNamePrefix([
            "LongPort__quote",
            "LongPortPrivate__submit_order",
            "LongPort__now",
            "mcphub__list_all_tools",
        ]);

        expect(summary).toBe("LongPort(2), LongPortPrivate(1), mcphub(1)");
    });

    test("builds proxy tools with cleaned metadata and normalized execution results", async () => {
        let receivedArgs: any = null;
        const tool = buildProxyToolFromRemoteDefinition({
            toolDef: {
                name: "read_file",
                description: "[source:filesystem] [tags:files,read] Read file contents",
                inputSchema: { type: "object", properties: {} },
            },
            serverName: "mcp-hub",
            executeRemote: async (args) => {
                receivedArgs = args;
                return { content: [{ text: "ok" }] };
            },
        });

        const result = await tool.execute({ path: "/tmp/a.txt", __userId: 9 });

        expect(tool.description).toBe("Read file contents");
        expect(tool.source).toBe("filesystem");
        expect(tool.tags).toEqual(["files", "read"]);
        expect(tool.fromServer).toBe("mcp-hub");
        expect(receivedArgs).toEqual({ path: "/tmp/a.txt" });
        expect(result).toEqual({
            content: [{ type: "text", text: "ok" }],
            isError: false,
        });
        expect(tool.contextPolicy).toBeUndefined();
    });

    test("deferLoading is retained on MCP proxy tools", () => {
        const tool = buildProxyToolFromRemoteDefinition({
            toolDef: { name: "remote_lookup", inputSchema: { type: "object" } },
            serverName: "remote",
            deferLoading: true,
            executeRemote: async () => ({ content: [] }),
        });

        expect(tool.deferLoading).toBe(true);
    });

    test("codegraph 系列工具声明 contextPolicy full（代码探索需完整输出）", () => {
        const tool = createProxyTool({
            toolDef: {
                name: "Sandbox__codegraph_explore",
                description: "Explore code",
                inputSchema: { type: "object", properties: {} },
            },
            tags: ["code"],
            fromServer: "Sandbox",
            executeRemote: async () => ({ content: [] }),
        });

        expect(tool.contextPolicy).toEqual({ mode: "full" });
    });

    test("非 codegraph 远程工具不强制完整输出", () => {
        const tool = createProxyTool({
            toolDef: {
                name: "Sandbox__repo_list",
                description: "List repos",
                inputSchema: { type: "object", properties: {} },
            },
            tags: ["code"],
            fromServer: "Sandbox",
            executeRemote: async () => ({ content: [] }),
        });

        expect(tool.contextPolicy).toBeUndefined();
    });

    test("returns a structured error when remote execution fails", async () => {
        const tool = createProxyTool({
            toolDef: {
                name: "broken_tool",
                description: "Broken tool",
                inputSchema: { type: "object", properties: {} },
            },
            tags: ["test"],
            executeRemote: async () => {
                throw new Error("boom");
            },
        });

        const result = await tool.execute({});

        expect(result.isError).toBe(true);
        expect(result.content[0]).toEqual({
            type: "text",
            text: "External tool error: boom",
        });
    });
});
