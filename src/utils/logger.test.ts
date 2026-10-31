import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { recordLLMExchange } from "./logger.js";

const tempDirs: string[] = [];
const originalStateDir = process.env.ZBOT_STATE_DIR;

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
});

describe("recordLLMExchange tool echo", () => {
    function readEntries(stateDir: string, sessionId: string): any[] {
        const logFile = path.join(stateDir, "sessions", "http", `${sessionId}.jsonl`);
        return fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    }

    function createStateDir(): string {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-logger-"));
        tempDirs.push(stateDir);
        process.env.ZBOT_STATE_DIR = stateDir;
        return stateDir;
    }

    test("provider strict-schema normalization still writes a toolsRef", () => {
        const stateDir = createStateDir();

        const sessionId = "test-session";
        const requestId = "request-1";
        const tool = {
            type: "function",
            name: "sample",
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            },
        };

        recordLLMExchange("REQUEST", {
            requestId,
            input: [],
            tools: [tool],
        }, { sessionId, requestId });

        recordLLMExchange("WS_RECV", {
            type: "response.completed",
            response: {
                tools: [{
                    ...tool,
                    strict: true,
                    output_schema: null,
                    parameters: {
                        ...tool.parameters,
                        required: ["query"],
                        additionalProperties: false,
                    },
                }],
            },
        }, { sessionId });

        const entries = readEntries(stateDir, sessionId);
        expect(entries[1].content.response.tools).toBeUndefined();
        expect(entries[1].content.response.toolsRef).toBe(requestId);
    });

    test("请求 schema 变化不能被回显归一化掩盖", () => {
        const stateDir = createStateDir();
        const sessionId = "schema-change";
        const base = {
            type: "function",
            name: "sample",
            strict: false,
            output_schema: { type: "object" },
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            },
        };
        const variants = [
            base,
            { ...base, parameters: { ...base.parameters, required: [] } },
            { ...base, strict: true },
            { ...base, output_schema: { type: "string" } },
            { ...base, parameters: { ...base.parameters, additionalProperties: false } },
        ];

        for (const [index, tool] of variants.entries()) {
            recordLLMExchange("REQUEST", { input: [], tools: [tool] }, {
                sessionId,
                requestId: `request-${index}`,
            });
        }

        const entries = readEntries(stateDir, sessionId);
        expect(entries.map(entry => entry.content.tools?.[0])).toEqual(variants);
        expect(new Set(entries.map(entry => entry.content.toolsHash)).size).toBe(variants.length);
    });

    test("上游重排 custom 工具并补 web_search 默认值时仍引用请求", () => {
        const stateDir = createStateDir();
        const sessionId = "reordered-echo";
        const tools = [
            { type: "function", name: "sample", parameters: { type: "object" } },
            { type: "custom", name: "apply_patch", format: { type: "text" } },
            { type: "web_search" },
        ];
        recordLLMExchange("REQUEST", { input: [], tools }, { sessionId, requestId: "request-reorder" });

        const echoedTools = [
            { ...tools[0], strict: false, output_schema: null },
            {
                type: "web_search",
                return_token_budget: "default",
                search_content_types: ["text"],
                search_context_size: "medium",
                user_location: { type: "approximate", country: "US", city: null, region: null, timezone: null },
            },
            tools[1],
        ];
        for (const type of ["response.created", "response.in_progress", "response.completed"]) {
            recordLLMExchange("WS_RECV", { type, response: { tools: echoedTools } }, { sessionId });
        }

        const entries = readEntries(stateDir, sessionId);
        for (const entry of entries.slice(1)) {
            expect(entry.content.response.tools).toBeUndefined();
            expect(entry.content.response.toolsRef).toBe("request-reorder");
        }

        recordLLMExchange("WS_RECV", {
            type: "response.completed",
            response: { tools: [{ ...echoedTools[0], description: "changed" }, ...echoedTools.slice(1)] },
        }, { sessionId });
        expect(readEntries(stateDir, sessionId).at(-1).content.response.tools).toHaveLength(3);
    });
});
