import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
    createTodoReminderProvider,
    readTodoProgress,
    todoTool,
} from "../../src/tools/todo-tool.js";
import { toolResultToText } from "../../src/tools/tool-interface.js";
import { useTmpWorkspace, type TmpWorkspace } from "./test-env.js";

let tmpDir: string;
let workspace: TmpWorkspace;

beforeEach(() => {
    workspace = useTmpWorkspace("xbot-todo-test-");
    tmpDir = workspace.dir;
});

afterEach(() => {
    workspace.cleanup();
});

async function todoResult(args: any): Promise<{ text: string; isError: boolean }> {
    const result = await todoTool.execute(args);
    return { text: toolResultToText(result), isError: result.isError === true };
}

function todoFile(sessionId: string): string {
    return path.join(tmpDir, "sessions", "todos", `${sessionId}.json`);
}

const SESSION_A = { __sessionId: "session-1" };
const SESSION_B = { __sessionId: "session-2" };

describe("todo 工具", () => {
    test("write 整表覆盖并回显进度，未列出的任务被删除", async () => {
        const first = await todoResult({
            action: "write",
            todos: [
                { content: "实现 grep 工具", status: "in_progress" },
                { content: "下载 rg 二进制", status: "pending" },
                { content: "写单测", status: "pending" },
            ],
            ...SESSION_A,
        });
        expect(first.isError).toBe(false);
        expect(first.text).toContain("0/3 完成 · 进行中 #1 实现 grep 工具");
        expect(first.text).toContain("[2] [pending] 下载 rg 二进制");

        const second = await todoResult({
            action: "write",
            todos: [
                { content: "实现 grep 工具", status: "done" },
                { content: "写单测", status: "pending" },
            ],
            ...SESSION_A,
        });
        expect(second.text).toContain("1/2 完成");
        expect(second.text).toContain("[2] [pending] 写单测");
        expect(second.text).not.toContain("下载 rg 二进制");
    });

    test("write 后 list 读到同一份清单，clear 清空", async () => {
        await todoResult({ action: "write", todos: [{ content: "任务 A", status: "done" }], ...SESSION_A });

        const listed = await todoResult({ action: "list", ...SESSION_A });
        expect(listed.text).toContain("1/1 完成");
        expect(listed.text).toContain("[1] [done] 任务 A");

        const cleared = await todoResult({ action: "clear", ...SESSION_A });
        expect(cleared.isError).toBe(false);
        expect((await todoResult({ action: "list", ...SESSION_A })).text).toBe("任务清单为空");
    });

    test("同时最多 1 条 in_progress", async () => {
        const result = await todoResult({
            action: "write",
            todos: [
                { content: "任务 1", status: "in_progress" },
                { content: "任务 2", status: "in_progress" },
            ],
            ...SESSION_A,
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("最多只能有 1 条 in_progress");
        // 失败不写入
        expect(fs.existsSync(todoFile("session-1"))).toBe(false);
    });

    test("存储路径为 sessions/todos/<sessionId>.json（无 default 层级）", async () => {
        await todoResult({ action: "write", todos: [{ content: "任务", status: "pending" }], ...SESSION_A });
        expect(fs.existsSync(todoFile("session-1"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "default"))).toBe(false);
    });

    test("不同会话的任务隔离", async () => {
        await todoResult({ action: "write", todos: [{ content: "A 的任务", status: "pending" }], ...SESSION_A });
        await todoResult({ action: "write", todos: [{ content: "B 的任务", status: "pending" }], ...SESSION_B });

        const listA = await todoResult({ action: "list", ...SESSION_A });
        const listB = await todoResult({ action: "list", ...SESSION_B });

        expect(listA.text).toContain("A 的任务");
        expect(listA.text).not.toContain("B 的任务");
        expect(listB.text).toContain("B 的任务");
        expect(listB.text).not.toContain("A 的任务");
    });

    test("同会话并发写不损坏文件（promise 链锁）", async () => {
        const results = await Promise.all(
            Array.from({ length: 10 }, (_, index) => todoResult({
                action: "write",
                todos: [{ content: `任务 ${index}`, status: "pending" }],
                ...SESSION_A,
            })),
        );

        expect(results.every((result) => !result.isError)).toBe(true);
        const stored = JSON.parse(fs.readFileSync(todoFile("session-1"), "utf-8"));
        expect(Array.isArray(stored)).toBe(true);
        expect(stored).toHaveLength(1);
    });

    test("参数校验", async () => {
        expect((await todoResult({ ...SESSION_A })).isError).toBe(true);
        expect((await todoResult({ action: "write", ...SESSION_A })).isError).toBe(true);
        expect((await todoResult({ action: "write", todos: [{ status: "pending" }], ...SESSION_A })).isError).toBe(true);
        expect((await todoResult({ action: "write", todos: [{ content: "x", status: "bogus" }], ...SESSION_A })).isError).toBe(true);
        expect((await todoResult({ action: "nope", ...SESSION_A })).isError).toBe(true);
        expect((await todoResult({ action: "list" })).isError).toBe(true);
    });

    test("readTodoProgress 返回进度，无任务时为 undefined", async () => {
        expect(readTodoProgress("session-1")).toBeUndefined();
        expect(readTodoProgress(undefined)).toBeUndefined();

        await todoResult({
            action: "write",
            todos: [
                { content: "任务 1", status: "done" },
                { content: "任务 2", status: "in_progress" },
            ],
            ...SESSION_A,
        });
        expect(readTodoProgress("session-1")).toEqual({ total: 2, done: 1 });
    });
});

describe("todo 提醒注入", () => {
    test("有未完成任务时返回提醒，且包含状态与进度", async () => {
        await todoResult({
            action: "write",
            todos: [
                { content: "任务 1", status: "done" },
                { content: "任务 2", status: "in_progress" },
                { content: "任务 3", status: "pending" },
            ],
            ...SESSION_A,
        });

        const provider = createTodoReminderProvider("session-1");
        const first = provider();
        expect(first).toHaveLength(1);
        expect(first![0]).toContain("<todo_reminder>");
        expect(first![0]).toContain("未完成 2 项");
        expect(first![0]).toContain("#2 [in_progress] 任务 2");
        expect(first![0]).toContain("#3 [pending] 任务 3");
    });

    test("清单未变化时节流到第 2 轮，变化时立即提示", async () => {
        await todoResult({ action: "write", todos: [{ content: "任务 1", status: "pending" }], ...SESSION_A });
        const provider = createTodoReminderProvider("session-1");

        expect(provider()).toHaveLength(1);
        expect(provider()).toBeUndefined();
        expect(provider()).toHaveLength(1);

        await todoResult({ action: "write", todos: [{ content: "任务 1 改了", status: "pending" }], ...SESSION_A });
        expect(provider()![0]).toContain("任务 1 改了");
    });

    test("无未完成任务或空清单时不提示", async () => {
        const emptyProvider = createTodoReminderProvider("session-1");
        expect(emptyProvider()).toBeUndefined();

        await todoResult({ action: "write", todos: [{ content: "任务 1", status: "done" }], ...SESSION_A });
        expect(createTodoReminderProvider("session-1")()).toBeUndefined();
    });
});
