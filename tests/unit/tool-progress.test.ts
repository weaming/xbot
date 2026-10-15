import { describe, expect, test } from "bun:test";
import {
    formatAccumulatedToolProgress,
    formatBuiltinToolProgress,
    formatToolProgress,
} from "../../src/utils/tool-progress.js";

describe("tool progress", () => {
    test("显示本地 bash 的命令内容", () => {
        expect(formatToolProgress("bash", { command: "pwd && ls" })).toBe("bash\n$ pwd && ls");
    });

    test("显示 Shell bash pipeline 的命令内容", () => {
        expect(formatToolProgress("Shell__bash", { commands: ["printf out", "head -n 1"] })).toBe(
            "Shell__bash\n$ printf out | head -n 1",
        );
    });

    test("显示 Shell fish pipeline 的命令内容", () => {
        expect(formatToolProgress("Shell__fish", { commands: ["pwd", "string match '*' (ls)"] })).toBe(
            "Shell__fish\n$ pwd | string match '*' (ls)",
        );
    });

    test("累计多个同名 Shell bash 调用并逐行显示", () => {
        expect(formatAccumulatedToolProgress("Shell__bash", [
            { commands: ["pwd"] },
            { commands: ["git status", "head -n 20"] },
        ])).toBe("Shell__bash\n$ pwd\n$ git status | head -n 20");
    });

    test("非 shell 工具空参数只显示工具名", () => {
        expect(formatToolProgress("grep", {})).toBe("grep");
        expect(formatToolProgress("grep", null)).toBe("grep");
    });

    test("非 shell 工具参数非空时显示摘要", () => {
        expect(formatToolProgress("grep", { pattern: "secret", cwd: "src" })).toBe("grep pattern=secret cwd=src");
    });

    test("非 shell 工具超长对象参数显示摘要", () => {
        const progress = formatToolProgress("analyze_gex", { symbols: ["TSM.US", "ORCL.US", "GOOGL.US", "AVGO.US"] });
        const longJson = formatToolProgress("analyze_gex", { data: "x".repeat(500) });

        expect(progress).toContain("analyze_gex symbols=");
        expect(longJson.length).toBeLessThan(200);
        expect(longJson).toContain("(共 500 字符)");
    });

    test("内置工具显示完整参数", () => {
        expect(formatBuiltinToolProgress("grep", {
            pattern: "xxx",
            cwd: "src",
            path: "my project",
            limit: 20,
            hidden: false,
        })).toBe("grep pattern=xxx cwd=src path=`my project` limit=20 hidden=false");
    });

    test("内置工具没有参数时不显示空参数", () => {
        expect(formatBuiltinToolProgress("ls", {})).toBe("ls");
        expect(formatBuiltinToolProgress("ls", null)).toBe("ls");
    });

    test("命令内容过长时截断", () => {
        const progress = formatToolProgress("bash", { command: "x".repeat(2000) });

        expect(progress.length).toBeLessThan(1900);
        expect(progress.endsWith("...")).toBe(true);
    });

    test("内置工具超长字符串参数显示摘要", () => {
        const longContent = "# 标题\n" + "内容".repeat(500);
        const progress = formatBuiltinToolProgress("write_file", { path: "a.md", content: longContent });

        expect(progress.length).toBeLessThan(400);
        expect(progress).toContain("content=`# 标题\n内容内容");
        expect(progress).toContain("…` (共 1005 字符)");
        expect(progress).not.toContain("内容".repeat(100));
    });

    test("内置工具短字符串参数不受影响", () => {
        const progress = formatBuiltinToolProgress("write_file", { path: "a.md", content: "short" });

        expect(progress).toBe("write_file path=a.md content=short");
    });
});
