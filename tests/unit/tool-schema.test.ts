import { describe, expect, test } from "bun:test";
import {
    cleanParametersForOpenAI,
    formatToolDef,
    getCachedCleanedSchema,
    normalizeToolDefinitionsForDeepSeek,
} from "../../src/tools/tool-schema.js";

describe("tool schema", () => {
    test("removes unsupported fields recursively", () => {
        const schema = {
            type: "object",
            title: "ignored",
            additionalProperties: false,
            properties: {
                path: {
                    type: "string",
                    title: "ignored",
                    description: "",
                    default: "/tmp/demo.txt",
                },
                options: {
                    type: "object",
                    properties: {
                        depth: {
                            type: "number",
                            minimum: 1,
                            maximum: 3,
                            oneOf: [{ const: 1 }],
                        },
                    },
                },
                files: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                minLength: 1,
                                examples: ["a.txt"],
                            },
                        },
                    },
                },
            },
            required: ["path"],
        };

        expect(cleanParametersForOpenAI(schema)).toEqual({
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "",
                    default: "/tmp/demo.txt",
                },
                options: {
                    type: "object",
                    properties: {
                        depth: {
                            type: "number",
                            minimum: 1,
                            maximum: 3,
                        },
                    },
                },
                files: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                minLength: 1,
                            },
                        },
                    },
                },
            },
            required: ["path"],
        });
    });

    test("reuses cached cleaned schema and formats OpenAI tool definitions", () => {
        const schema = {
            type: "object",
            properties: {
                path: { type: "string", description: "file path" },
            },
        };

        const cleanedA = getCachedCleanedSchema(schema);
        const cleanedB = getCachedCleanedSchema(schema);

        expect(cleanedA).toBe(cleanedB);
        expect(formatToolDef({
            name: "read_file",
            description: "Read a file",
            inputSchema: schema,
            execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        })).toEqual({
            type: "function",
            function: {
                name: "read_file",
                description: "Read a file",
                parameters: cleanedA,
            },
        });
    });

    test("保留 MCP deferLoading 内部标记供 Responses 构造器使用", () => {
        const definition = formatToolDef({
            name: "remote__lookup",
            inputSchema: { type: "object" },
            deferLoading: true,
            execute: async () => ({ content: [] }),
        });

        expect(definition.deferLoading).toBe(true);
    });

    test("仅为 DeepSeek 转换 NUL 正则且不修改原工具定义", () => {
        const tool = {
            type: "function",
            function: {
                name: "analyze_javascript_application",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            pattern: "^[^\\0]*$",
                        },
                        nested: {
                            type: "array",
                            items: {
                                type: "string",
                                pattern: "^[^\\0]*$",
                            },
                        },
                    },
                },
            },
        };

        const normalized = normalizeToolDefinitionsForDeepSeek([tool]);

        expect(normalized[0].function.parameters.properties.path.pattern).toBe("^[^\\x00]*$");
        expect(normalized[0].function.parameters.properties.nested.items.pattern).toBe("^[^\\x00]*$");
        expect(tool.function.parameters.properties.path.pattern).toBe("^[^\\0]*$");
    });
});
