import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grepFileTool } from "../../src/tools/grep-tool.js";
import { toolResultToText } from "../../src/tools/tool-interface.js";
import { useTmpWorkspace, type TmpWorkspace } from "./test-env.js";

let tmpDir: string;
let outsideDir: string;
let workspace: TmpWorkspace;

beforeEach(() => {
    workspace = useTmpWorkspace("xbot-grep-test-");
    tmpDir = workspace.dir;
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-grep-outside-"));
    delete process.env.RG_BIN;
});

afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    workspace.cleanup();
});

function writeTemp(relPath: string, content: string): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

async function grepResult(args: any): Promise<{ text: string; isError: boolean }> {
    const result = await grepFileTool.execute(args);
    return { text: toolResultToText(result), isError: result.isError === true };
}

describe("grep 工具", () => {
    test("搜索匹配内容，按文件分组输出行号", async () => {
        writeTemp("src/a.ts", "const alpha = 1;\nconst beta = 2;\n");
        writeTemp("src/b.ts", "function beta() { return 3; }\n");

        const { text, isError } = await grepResult({ cwd: ".", pattern: "beta" });

        expect(isError).toBe(false);
        expect(text).toContain("Found 2 matches");
        expect(text).toContain("src/a.ts:");
        expect(text).toContain("  Line 2: const beta = 2;");
        expect(text).toContain("src/b.ts:");
        expect(text).toContain("  Line 1: function beta() { return 3; }");
    });

    test("无匹配时返回提示", async () => {
        writeTemp("src/a.ts", "const alpha = 1;\n");

        const { text, isError } = await grepResult({ cwd: ".", pattern: "not_exist" });

        expect(isError).toBe(false);
        expect(text).toBe("No matches found");
    });

    test("正则语法错误返回错误", async () => {
        writeTemp("src/a.ts", "const alpha = 1;\n");

        const { text, isError } = await grepResult({ cwd: ".", pattern: "(" });

        expect(isError).toBe(true);
        expect(text).toContain("Invalid regex pattern");
    });

    test("include 过滤文件", async () => {
        writeTemp("src/a.ts", "const beta = 1;\n");
        writeTemp("src/b.js", "const beta = 2;\n");

        const { text } = await grepResult({ cwd: ".", pattern: "beta", include: "*.ts" });

        expect(text).toContain("Found 1 matches");
        expect(text).toContain("src/a.ts");
        expect(text).not.toContain("src/b.js");
    });

    test("limit 截断并提示", async () => {
        const lines = Array.from({ length: 5 }, (_, index) => `line${index} beta`).join("\n");
        writeTemp("src/a.ts", lines);

        const { text } = await grepResult({ cwd: ".", pattern: "beta", limit: 2 });

        expect(text).toContain("Found 2 matches");
        expect(text).toContain("已截断，仅显示前 2 条匹配");
    });

    test("path 限定子目录", async () => {
        writeTemp("src/a.ts", "const beta = 1;\n");
        writeTemp("other/b.ts", "const beta = 2;\n");

        const { text } = await grepResult({ cwd: ".", pattern: "beta", path: "src" });

        expect(text).toContain("Found 1 matches");
        expect(text).toContain("a.ts");
        expect(text).not.toContain("other/b.ts");
    });

    test("路径越界返回错误", async () => {
        const { isError } = await grepResult({ cwd: ".", pattern: "beta", path: path.join(outsideDir, "x") });

        expect(isError).toBe(true);
    });

    test("缺失 pattern 返回错误", async () => {
        const { isError } = await grepResult({ cwd: "." });

        expect(isError).toBe(true);
    });

    test("缺失 cwd 返回错误", async () => {
        const { text, isError } = await grepResult({ pattern: "beta" });

        expect(isError).toBe(true);
        expect(text).toContain("Missing required argument: cwd");
    });
});
