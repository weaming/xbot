import { describe, expect, test } from "bun:test";

import {
    filterAndTransformTools,
    matchToolPattern,
    type RawRemoteToolDef,
} from "../../src/mcp/filter.js";

describe("mcp filter", () => {
    test("matchToolPattern 支持精确匹配、通配符和正则表达式", () => {
        expect(matchToolPattern("bash", "bash")).toBe(true);
        expect(matchToolPattern("bash", "grep")).toBe(false);

        expect(matchToolPattern("*", "any_tool")).toBe(true);
        expect(matchToolPattern("local_*", "local_bash")).toBe(true);
        expect(matchToolPattern("local_*", "remote_bash")).toBe(false);
        expect(matchToolPattern("*search*", "mcphub__brave_web_search")).toBe(true);
        expect(matchToolPattern("tool_?", "tool_1")).toBe(true);
        expect(matchToolPattern("tool_?", "tool_12")).toBe(false);

        expect(matchToolPattern("/^direct_/i", "direct_amap")).toBe(true);
        expect(matchToolPattern("/^direct_/i", "indirect_amap")).toBe(false);
    });

    test("filterAndTransformTools 无配置时保留全部工具", () => {
        const tools: RawRemoteToolDef[] = [
            { name: "bash", inputSchema: {} },
            { name: "grep", inputSchema: {} },
        ];
        const results = filterAndTransformTools(tools);
        expect(results).toEqual([
            { rawName: "bash", toolDef: { name: "bash", inputSchema: {} } },
            { rawName: "grep", toolDef: { name: "grep", inputSchema: {} } },
        ]);
    });

    test("传 serverName 时默认加 `<server>__` 前缀，避免不同 server 同名工具互顶", () => {
        const tools: RawRemoteToolDef[] = [{ name: "quote", inputSchema: {} }];

        expect(filterAndTransformTools(tools, undefined, "LongPort")[0])
            .toEqual({ rawName: "quote", toolDef: { name: "LongPort__quote", inputSchema: {} } });
        // 已带同名前缀不重复添加
        expect(filterAndTransformTools(
            [{ name: "LongPort__quote", inputSchema: {} }],
            undefined,
            "LongPort",
        )[0].toolDef.name).toBe("LongPort__quote");
        // server 名里的非法字符替换为下划线
        expect(filterAndTransformTools(tools, undefined, "my.server")[0].toolDef.name).toBe("my_server__quote");
        // 显式 prefix 覆盖默认前缀，rename 优先级最高
        expect(filterAndTransformTools(tools, { prefix: "lp_" }, "LongPort")[0].toolDef.name).toBe("lp_quote");
        expect(filterAndTransformTools(tools, { rename: { quote: "get_quote" } }, "LongPort")[0].toolDef.name)
            .toBe("get_quote");
    });

    test("filterAndTransformTools 支持白名单 includeTools", () => {
        const tools: RawRemoteToolDef[] = [
            { name: "take_screenshot", inputSchema: {} },
            { name: "navigate_page", inputSchema: {} },
            { name: "click_element", inputSchema: {} },
        ];
        const results = filterAndTransformTools(tools, {
            includeTools: ["take_screenshot", "navigate_*"],
        });

        expect(results.map((r) => r.toolDef.name)).toEqual(["take_screenshot", "navigate_page"]);
    });

    test("filterAndTransformTools 支持黑名单 excludeTools", () => {
        const tools: RawRemoteToolDef[] = [
            { name: "local_bash", inputSchema: {} },
            { name: "local_cat", inputSchema: {} },
            { name: "query_db", inputSchema: {} },
        ];
        const results = filterAndTransformTools(tools, {
            excludeTools: ["local_*"],
        });

        expect(results.map((r) => r.toolDef.name)).toEqual(["query_db"]);
    });

    test("filterAndTransformTools 支持 prefix 和 rename，同时保留 rawName", () => {
        const tools: RawRemoteToolDef[] = [
            { name: "query", inputSchema: {} },
            { name: "execute", inputSchema: {} },
        ];
        const results = filterAndTransformTools(tools, {
            prefix: "db_",
            rename: {
                execute: "run_sql",
            },
        });

        expect(results).toEqual([
            { rawName: "query", toolDef: { name: "db_query", inputSchema: {} } },
            { rawName: "execute", toolDef: { name: "run_sql", inputSchema: {} } },
        ]);
    });
});
