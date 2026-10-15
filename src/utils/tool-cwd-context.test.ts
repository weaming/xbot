import { describe, expect, test } from "bun:test";
import path from "path";
import { runWithToolCwd } from "./tool-cwd-context.js";
import { getToolCwd } from "./runtime-paths.js";

describe("工具 cwd 上下文", () => {
    test("runWithToolCwd 内 getToolCwd 返回绑定目录", () => {
        expect(runWithToolCwd("/proj/alpha", () => getToolCwd())).toBe(path.resolve("/proj/alpha"));
    });

    test("异步链内继承绑定目录", async () => {
        const result = await runWithToolCwd("/proj/alpha", async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return getToolCwd();
        });
        expect(result).toBe(path.resolve("/proj/alpha"));
    });

    test("无绑定时回退 TUI_CWD，再回退 WORKSPACE", () => {
        const previousCwd = process.env.TUI_CWD;
        const previousWorkspace = process.env.WORKSPACE;
        try {
            delete process.env.TUI_CWD;
            process.env.WORKSPACE = "/workspace-fallback";
            expect(getToolCwd()).toBe(path.resolve("/workspace-fallback"));

            process.env.TUI_CWD = "/tui-cwd";
            expect(getToolCwd()).toBe(path.resolve("/tui-cwd"));
        } finally {
            if (previousCwd === undefined) {
                delete process.env.TUI_CWD;
            } else {
                process.env.TUI_CWD = previousCwd;
            }
            if (previousWorkspace === undefined) {
                delete process.env.WORKSPACE;
            } else {
                process.env.WORKSPACE = previousWorkspace;
            }
        }
    });
});
