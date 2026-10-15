import { describe, expect, test } from "bun:test";
import { buildGhArgs, ghTool } from "../../src/tools/gh-tool.js";
import { buildUrl2mdArgs, url2mdTool, validateHttpUrl } from "../../src/tools/url2md-tool.js";

describe("命令行工具", () => {
    test("gh 将潜在 shell 字符保留为独立参数", async () => {
        const result = await ghTool.execute({ args: [] });

        expect(ghTool.inputSchema.required).toEqual(["args"]);
        expect(buildGhArgs(["pr", "list", ";", "echo injected"])).toEqual([
            "pr",
            "list",
            ";",
            "echo injected",
        ]);
        expect(result.isError).toBe(true);
    });

    test("url2md 将潜在 shell 字符保留为单个参数", () => {
        const args = buildUrl2mdArgs("https://example.com/?query=$(whoami);echo", "http://proxy:7890");

        expect(args).toEqual([
            "-raw",
            "https://example.com/?query=$(whoami);echo",
            "--proxy",
            "http://proxy:7890",
        ]);
    });

    test("url2md 拒绝非 HTTP URL", async () => {
        expect(() => validateHttpUrl("file:///etc/passwd")).toThrow("仅支持 http 或 https");

        const result = await url2mdTool.execute({ url: "file:///etc/passwd" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("仅支持 http 或 https");
    });
});
