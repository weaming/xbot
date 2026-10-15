import { describe, expect, test } from "bun:test";
import { buildToolSummary, getAllRegisteredSources, getAllRegisteredTags, getTopToolsByLRU, getVisibleTools } from "../../src/tools/tool-visibility.js";

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

describe("tool visibility", () => {
    test("getVisibleTools keeps core tools visible and appends LRU-ranked tools", () => {
        const allTools = [
            makeTool("memory", { tags: ["core"] }),
            makeTool("local_helper"),
            makeTool("remote_a", { tags: ["files"], source: "filesystem" }),
            makeTool("remote_b", { tags: ["search"], source: "web" }),
        ];

        const visible = getVisibleTools({
            allTools,
            useSkillTool: makeTool("use_skill", { tags: ["core"] }),
            searchTool: makeTool("search_tools", { tags: ["core"] }),
            usageByToolName: new Map([
                ["remote_b", 10],
                ["remote_a", 20],
            ]),
            pageSize: 1,
        });

        expect(visible.map((tool) => tool.name)).toEqual([
            "use_skill",
            "search_tools",
            "memory",
            "local_helper",
            "remote_a",
        ]);
    });

    test("getVisibleTools omits LRU-ranked tools when disabled", () => {
        const visible = getVisibleTools({
            allTools: [
                makeTool("memory", { tags: ["core"] }),
                makeTool("remote_a", { tags: ["files"] }),
            ],
            useSkillTool: makeTool("use_skill", { tags: ["core"] }),
            searchTool: makeTool("search_tools", { tags: ["core"] }),
            usageByToolName: new Map([["remote_a", 10]]),
            includeLruTools: false,
        });

        expect(visible.map((tool) => tool.name)).toEqual(["use_skill", "search_tools", "memory"]);
    });

    test("getTopToolsByLRU excludes always-visible tools and sorts by recent usage", () => {
        const ranked = getTopToolsByLRU(
            [
                makeTool("core_tool", { tags: ["core"] }),
                makeTool("use_skill", { tags: ["skills"] }),
                makeTool("tool_a", { tags: ["files"] }),
                makeTool("tool_b", { tags: ["files"] }),
            ],
            new Map([
                ["tool_b", { lastUsed: 1, count: 1 }],
                ["tool_a", { lastUsed: 2, count: 1 }],
                ["core_tool", { lastUsed: 99, count: 1 }],
                ["use_skill", { lastUsed: 100, count: 1 }],
            ]),
            5,
        );

        expect(ranked.map((tool) => tool.name)).toEqual(["tool_a", "tool_b"]);
    });

    test("getTopToolsByLRU ranks frequent tools higher than recent single-use tools", () => {
        const ranked = getTopToolsByLRU(
            [
                makeTool("tool_x", { tags: ["files"] }),
                makeTool("tool_y", { tags: ["files"] }),
            ],
            new Map([
                // x 使用时间更早但用过 5 次；y 更新但只用 1 次
                ["tool_x", { lastUsed: 1, count: 5 }],
                ["tool_y", { lastUsed: 2, count: 1 }],
            ]),
            5,
        );

        expect(ranked.map((tool) => tool.name)).toEqual(["tool_x", "tool_y"]);
    });

    test("collects unique tags and sources, and summarizes hidden tools", () => {
        const allTools = [
            makeTool("memory", { tags: ["core", "memory"] }),
            makeTool("file_search", { tags: ["files"], source: "filesystem" }),
            makeTool("repo_search", { tags: ["search", "files"], source: "github" }),
            makeTool("local_helper"),
        ];

        expect(getAllRegisteredTags(allTools)).toEqual(["files", "memory", "search"]);
        expect(getAllRegisteredSources(allTools)).toEqual(["filesystem", "github"]);

        const summary = buildToolSummary(allTools, [allTools[0], allTools[3]]);
        expect(summary).toEqual([
            { name: "file_search", tags: ["files"], source: "filesystem" },
            { name: "repo_search", tags: ["search", "files"], source: "github" },
        ]);
    });

    test("sessionScoped tools stay out of the default tool list", () => {
        const allTools = [
            makeTool("memory", { tags: ["core"] }),
            makeTool("session_send", { tags: ["chat"], sessionScoped: true }),
            makeTool("session_status", { tags: ["chat"], sessionScoped: true }),
            makeTool("remote_a", { tags: ["files"], source: "filesystem" }),
        ];

        const visible = getVisibleTools({
            allTools,
            useSkillTool: makeTool("use_skill", { tags: ["core"] }),
            searchTool: makeTool("search_tools", { tags: ["core"] }),
            usageByToolName: new Map([
                ["session_send", 100],
                ["remote_a", 1],
            ]),
            pageSize: 10,
        });

        expect(visible.map((tool) => tool.name)).toEqual(["use_skill", "search_tools", "memory", "remote_a"]);
    });
});
