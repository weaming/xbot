import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TodoBar } from "./todo-bar.js";
import type { TodoItem } from "../tools/todo-tool.js";

function makeTodo(id: number, status: TodoItem["status"], content: string): TodoItem {
    return { id, content, status, updatedAt: new Date().toISOString() };
}

function render(bar: TodoBar, width = 70): string[] {
    return bar.render(width).map(stripTerminalSequences);
}

describe("底部任务清单条", () => {
    test("全部完成时不占位", () => {
        const bar = new TodoBar();
        bar.setTodos([makeTodo(1, "done", "已完成"), makeTodo(2, "done", "也完成")]);

        expect(bar.lineCount()).toBe(0);
        expect(bar.render(70)).toEqual([]);
    });

    test("无清单时不占位", () => {
        const bar = new TodoBar();
        bar.setTodos([]);

        expect(bar.lineCount()).toBe(0);
        expect(bar.render(70)).toEqual([]);
    });

    test("逐条展示全部任务，已完成也列出", () => {
        const bar = new TodoBar();
        bar.setTodos([
            makeTodo(1, "done", "实现 grep 工具"),
            makeTodo(2, "in_progress", "下载 rg 二进制"),
            makeTodo(3, "pending", "写单元测试"),
        ]);

        const lines = render(bar);
        expect(bar.lineCount()).toBe(4);
        expect(lines[0]).toBe("📋 1/3 完成");
        expect(lines[1]).toBe("  ✅ #1 实现 grep 工具");
        expect(lines[2]).toBe("  🚧 #2 下载 rg 二进制");
        expect(lines[3]).toBe("  🗓️ #3 写单元测试");
    });

    test("不设行数上限，全部任务都渲染", () => {
        const bar = new TodoBar();
        const todos = Array.from({ length: 12 }, (_, index) => makeTodo(index + 1, "pending", `任务 ${index + 1}`));
        bar.setTodos(todos);

        expect(bar.lineCount()).toBe(13);
        expect(render(bar).at(-1)).toBe("  🗓️ #12 任务 12");
    });

    test("窄宽度按可见宽度截断", () => {
        const bar = new TodoBar();
        bar.setTodos([makeTodo(1, "pending", "这是一个很长的任务内容，需要被截断显示")]);

        const lines = render(bar, 16);
        const itemLine = lines[1]!;
        expect(stripTerminalSequences(itemLine).length).toBeLessThanOrEqual(16);
        expect(itemLine.endsWith("…")).toBe(true);
    });

    test("清单更新后反映最新状态", () => {
        const bar = new TodoBar();
        bar.setTodos([makeTodo(1, "in_progress", "做事"), makeTodo(2, "pending", "待办")]);
        expect(bar.lineCount()).toBe(3);

        bar.setTodos([makeTodo(1, "done", "做事"), makeTodo(2, "pending", "待办")]);
        const lines = render(bar);
        expect(lines[0]).toBe("📋 1/2 完成");
        expect(lines).toEqual(["📋 1/2 完成", "  ✅ #1 做事", "  🗓️ #2 待办"]);
    });
});
