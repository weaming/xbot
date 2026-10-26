import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "../../src/tools/tool-catalog.js";
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

describe("tool catalog", () => {
    test("lists tools in a stable name order regardless of registration order", () => {
        const catalog = new ToolCatalog();
        catalog.registerLocalTools([
            { name: "zebra", inputSchema: {}, execute: async () => ({ content: [] }) },
            { name: "alpha", inputSchema: {}, execute: async () => ({ content: [] }) },
        ]);
        catalog.syncRemoteTools("remote", [
            { name: "middle", inputSchema: {}, execute: async () => ({ content: [] }) },
        ]);

        expect(catalog.listAllTools().map((tool) => tool.name)).toEqual(["alpha", "middle", "zebra"]);
    });

    test("syncRemoteTools replaces tools atomically per server", () => {
        const catalog = new ToolCatalog();
        catalog.registerLocalTools([makeTool("local_a")]);

        const first = catalog.syncRemoteTools("mcp-hub", [
            makeTool("remote_a", { fromServer: "mcp-hub" }),
            makeTool("remote_b", { fromServer: "mcp-hub" }),
        ]);
        const second = catalog.syncRemoteTools("mcp-hub", [
            makeTool("remote_b", { fromServer: "mcp-hub" }),
            makeTool("remote_c", { fromServer: "mcp-hub" }),
        ]);

        expect(first.added).toEqual(["remote_a", "remote_b"]);
        expect(first.removed).toEqual([]);
        expect(second.added).toEqual(["remote_c"]);
        expect(second.removed).toEqual(["remote_a"]);
        expect(catalog.listAllTools().map((tool) => tool.name)).toEqual(["local_a", "remote_b", "remote_c"]);
    });

    test("syncRemoteTools skips reserved names and local conflicts", () => {
        const catalog = new ToolCatalog();
        catalog.reserveNames(["use_skill"]);
        catalog.registerLocalTools([makeTool("bash")]);

        const result = catalog.syncRemoteTools("mcp-hub", [
            makeTool("bash", { fromServer: "mcp-hub" }),
            makeTool("remote_ok", { fromServer: "mcp-hub" }),
        ]);

        expect(result.added).toEqual(["remote_ok"]);
        expect(result.skipped).toEqual(["bash"]);
        expect(catalog.getTool("bash")?.description).toBe("bash description");
        expect(catalog.getTool("remote_ok")?.description).toBe("remote_ok description");
    });
});
