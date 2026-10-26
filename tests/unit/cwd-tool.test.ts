import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    cwdTool,
    formatDisplayPath,
    resolveCwdInput,
    setSessionCwdHandler,
} from "../../src/tools/cwd-tool.js";

let root: string;
let originalTuiCwd: string | undefined;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-cwd-tool-"));
    fs.mkdirSync(path.join(root, "project", "sub"), { recursive: true });
    originalTuiCwd = process.env.TUI_CWD;
    process.env.TUI_CWD = path.join(root, "project");
});

afterEach(() => {
    if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = originalTuiCwd;
    setSessionCwdHandler(null);
    fs.rmSync(root, { recursive: true, force: true });
});

const run = (args: Record<string, unknown>) => cwdTool.execute(args);
const textOf = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";

describe("路径解析", () => {
    test("HOME 前缀显示为 ~", () => {
        expect(formatDisplayPath("/Users/garden/src/zbot", "/Users/garden")).toBe("~/src/zbot");
        expect(formatDisplayPath("/Users/garden/", "/Users/garden")).toBe("~");
        expect(formatDisplayPath("/opt/work", "/Users/garden")).toBe("/opt/work");
    });

    test("~ 与 ~/x 展开，相对路径相对 base，绝对路径不变", () => {
        expect(resolveCwdInput("~", "/base", "/home/u")).toBe("/home/u");
        expect(resolveCwdInput("~/src", "/base", "/home/u")).toBe("/home/u/src");
        expect(resolveCwdInput("sub", "/base/project", "/home/u")).toBe("/base/project/sub");
        expect(resolveCwdInput("/abs/path", "/base", "/home/u")).toBe("/abs/path");
    });
});

describe("cwd 工具", () => {
    test("默认查看当前目录，HOME 前缀显示为 ~", async () => {
        process.env.TUI_CWD = path.join(root, "project");
        const result = await run({});

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toContain("project");
        expect(textOf(result).startsWith("/")).toBe(true);
    });

    test("set 相对路径：解析后交给会话落盘，并回报新目录", async () => {
        const calls: Array<{ sessionId: string; cwd: string }> = [];
        setSessionCwdHandler(async (sessionId, cwd) => {
            calls.push({ sessionId, cwd });
        });

        const result = await run({ action: "set", path: "sub", __sessionId: "s1" });

        expect(result.isError).toBeUndefined();
        expect(calls).toEqual([{ sessionId: "s1", cwd: path.join(root, "project", "sub") }]);
        expect(textOf(result)).toContain("sub");
    });

    test("省略 action 时给 path 即视为 set", async () => {
        const calls: string[] = [];
        setSessionCwdHandler(async (_sessionId, cwd) => {
            calls.push(cwd);
        });

        await run({ path: "sub", __sessionId: "s1" });

        expect(calls).toEqual([path.join(root, "project", "sub")]);
    });

    test("没有会话上下文时回退进程级目录", async () => {
        const target = path.join(root, "project", "sub");

        const result = await run({ action: "set", path: target });

        expect(result.isError).toBeUndefined();
        expect(process.env.TUI_CWD).toBe(target);
        expect(textOf(result)).toContain("未落盘");
    });

    test("有会话但宿主未注入落盘入口时报错，不谎报切换", async () => {
        setSessionCwdHandler(null);

        const result = await run({ action: "set", path: "sub", __sessionId: "s1" });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("未注入落盘入口");
        expect(process.env.TUI_CWD).toBe(path.join(root, "project"));
    });

    test("目录不存在与非目录都报错且不改基准", async () => {
        const filePath = path.join(root, "project", "note.txt");
        fs.writeFileSync(filePath, "x");

        const missing = await run({ action: "set", path: "nope", __sessionId: "s1" });
        const notDir = await run({ action: "set", path: filePath, __sessionId: "s1" });

        expect(missing.isError).toBe(true);
        expect(textOf(missing)).toContain("目录不存在");
        expect(notDir.isError).toBe(true);
        expect(textOf(notDir)).toContain("不是目录");
        expect(process.env.TUI_CWD).toBe(path.join(root, "project"));
    });

    test("set 缺少 path 时报错", async () => {
        const result = await run({ action: "set" });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("需要 path");
    });
});
