import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TodoPanel } from "./todo-panel.js";
import type { TodoItem } from "../tools/todo-tool.js";

const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_T = "\x14";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_DOWN = "\x1b[<65;10;5M";

function makeTodo(id: number, status: TodoItem["status"], content: string): TodoItem {
    return { id, content, status, updatedAt: new Date().toISOString() };
}

const TODOS: TodoItem[] = [
    makeTodo(1, "done", "实现 grep 工具"),
    makeTodo(2, "in_progress", "下载 rg 二进制"),
    makeTodo(3, "pending", "写单元测试"),
];

function makePanel(todos: TodoItem[] = TODOS, visibleRows = 12): { panel: TodoPanel; calls: string[] } {
    const calls: string[] = [];
    const panel = new TodoPanel({ visibleRows, load: () => todos, close: () => calls.push("close") });
    return { panel, calls };
}

function renderText(panel: TodoPanel, width = 70): string {
    return panel.render(width).map(stripTerminalSequences).join("\n");
}

describe("任务清单面板", () => {
    test("渲染进度头与逐条任务", () => {
        const { panel } = makePanel();
        const output = renderText(panel);

        expect(output).toContain("☐ 任务清单 · 1/3 完成");
        expect(output).toContain("[1] ✓ 实现 grep 工具");
        expect(output).toContain("[2] ● 下载 rg 二进制");
        expect(output).toContain("[3] ○ 写单元测试");
        expect(panel.render(70).every((line) => visibleWidth(line) <= 70)).toBe(true);
    });

    test("空清单给出提示", () => {
        const { panel } = makePanel([]);
        const output = renderText(panel);

        expect(output).toContain("☐ 任务清单");
        expect(output).toContain("当前会话还没有任务清单");
    });

    test("↑↓ 滚动一行，超出窗口时显示范围", () => {
        const todos = Array.from({ length: 20 }, (_, index) => makeTodo(index + 1, "pending", `任务 ${index + 1}`));
        const { panel } = makePanel(todos);

        expect(renderText(panel)).toContain("· 1-12");

        panel.handleInput(DOWN);
        const output = renderText(panel);
        expect(output).toContain("· 2-13");
        expect(output).not.toContain("任务 1\n");
    });

    test("j/k 也能滚动", () => {
        const todos = Array.from({ length: 20 }, (_, index) => makeTodo(index + 1, "pending", `任务 ${index + 1}`));
        const { panel } = makePanel(todos);

        panel.handleInput("j");
        expect(renderText(panel)).toContain("· 2-13");

        panel.handleInput("k");
        expect(renderText(panel)).toContain("· 1-12");
    });

    test("⌃D / PgDn 与滚轮翻页", () => {
        const todos = Array.from({ length: 30 }, (_, index) => makeTodo(index + 1, "pending", `任务 ${index + 1}`));
        const { panel } = makePanel(todos, 5);

        panel.handleInput(CTRL_D);
        expect(renderText(panel)).toContain("· 6-10");

        panel.handleInput(PAGE_DOWN);
        expect(renderText(panel)).toContain("· 11-15");

        panel.handleInput(WHEEL_DOWN);
        expect(renderText(panel)).toContain("· 14-18");
    });

    test("Esc / Ctrl+C / Ctrl+T 关闭面板", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(ESCAPE);
        panel.handleInput(CTRL_C);
        panel.handleInput(CTRL_T);

        expect(calls).toEqual(["close", "close", "close"]);
    });

    test("渲染时重新读取清单，agent 更新后即时可见", () => {
        let todos = TODOS;
        const panel = new TodoPanel({ visibleRows: 12, load: () => todos, close: () => {} });

        expect(renderText(panel)).toContain("1/3 完成");

        todos = [makeTodo(1, "done", "实现 grep 工具"), makeTodo(2, "done", "下载 rg 二进制")];
        expect(renderText(panel)).toContain("2/2 完成");
    });

    test("超长任务内容按可见列宽截断", () => {
        const { panel } = makePanel([makeTodo(1, "pending", "很长的任务内容".repeat(20))]);
        const lines = panel.render(40);

        expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
        expect(stripTerminalSequences(lines.join("\n"))).toContain("…");
    });

    test("未识别按键不改变滚动位置", () => {
        const todos = Array.from({ length: 20 }, (_, index) => makeTodo(index + 1, "pending", `任务 ${index + 1}`));
        const { panel } = makePanel(todos);

        panel.handleInput("\x1b[5~");
        expect(renderText(panel)).toContain("· 1-12");
    });
});
