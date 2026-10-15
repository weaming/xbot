/**
 * 底部常驻任务清单条：只在有未完成项时占位，始终反映最新清单。
 * todo 不再渲染进事件流（见 app.ts 的 shouldShowTool），这里是常驻展示入口；
 * 列出全部任务（含已完成），无行数上限；全部完成或没有清单时高度归零。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { theme } from "./theme.js";
import type { TodoItem } from "../tools/todo-tool.js";

const STATUS_MARK: Record<TodoItem["status"], string> = {
    in_progress: "🚧",
    pending: "🗓️",
    done: "✅",
};

export class TodoBar implements Component {
    private lines: string[] = [];

    /** 传入完整清单（含已完成）：全部逐条展示，无行数上限。 */
    setTodos(todos: TodoItem[]): void {
        const unfinished = todos.filter((item) => item.status !== "done");
        if (unfinished.length === 0) {
            this.lines = [];
            return;
        }

        const done = todos.length - unfinished.length;
        this.lines = [
            theme.dim(`📋 ${done}/${todos.length} 完成`),
            ...todos.map((item) => this.renderItem(item)),
        ];
    }

    /** 当前占位行数（0 表示不显示）。 */
    lineCount(): number {
        return this.lines.length;
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        return this.lines.map((line) => truncateToWidth(line, safeWidth, "…"));
    }

    invalidate(): void {}

    /** 单行任务：`  ✅ #1 内容`；进行中高亮，已完成/待办置灰。 */
    private renderItem(item: TodoItem): string {
        const line = `  ${STATUS_MARK[item.status]} #${item.id} ${item.content}`;
        return item.status === "in_progress" ? theme.statusWarn(line) : theme.dim(line);
    }
}
