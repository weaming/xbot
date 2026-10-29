/**
 * 任务清单面板：Ctrl+T 打开，只读展示当前会话的 todo。
 * 内容无操作项，故不做行选中——↑↓ / jk 滚动一行，PgUp / PgDn / Ctrl+U / Ctrl+D 翻页，
 * 鼠标滚轮同样翻动；Esc / Ctrl+C / Ctrl+T 关闭。面板打开时独占键盘输入。
 */

import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { truncatePlain } from "../format/text.js";
import { theme } from "./theme.js";
import type { TodoItem, TodoStatus } from "../tools/todo-tool.js";

const STATUS_MARK: Record<TodoStatus, string> = {
    in_progress: "●",
    pending: "○",
    done: "✓",
};

export interface TodoPanelOptions {
    /** 一次最多显示的任务行数（由终端高度推算，超出滚动）。 */
    visibleRows: number;
    load(): TodoItem[];
    close(): void;
}

export class TodoPanel implements Component {
    private readonly root = new PanelBody();
    private readonly header = new Text("", 1, 0);
    private readonly footer = new Text("", 1, 0);
    private scrollTop = 0;

    constructor(private readonly options: TodoPanelOptions) {}

    /** 独占键盘输入；未识别的按键被忽略，避免误落到输入框。 */
    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("t"))) {
            this.options.close();
            return;
        }
        handlePanelScroll(data, {
            pageSize: this.options.visibleRows,
            scrollBy: (delta) => this.scrollBy(delta),
        });
    }

    /** 渲染前重新读取清单：agent 在执行中更新 todo 时面板保持实时。 */
    render(width: number): string[] {
        this.rebuild(width);
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }

    private scrollBy(delta: number): void {
        const total = this.options.load().length;
        const maxTop = Math.max(0, total - this.options.visibleRows);
        const next = Math.max(0, Math.min(this.scrollTop + delta, maxTop));
        if (next === this.scrollTop) return;
        this.scrollTop = next;
        this.root.invalidate();
    }

    private rebuild(width: number): void {
        const todos = this.options.load();
        if (todos.length === 0) {
            this.header.setText(theme.statusOk("☐ 任务清单"));
            this.footer.setText(theme.dim("Esc 关闭"));
            this.root.setChildren([
                this.header,
                new Text(theme.dim("当前会话还没有任务清单"), 1, 0),
                this.footer,
            ]);
            this.root.invalidate();
            return;
        }

        const windowSize = Math.max(1, Math.min(this.options.visibleRows, todos.length));
        const maxTop = Math.max(0, todos.length - windowSize);
        this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxTop));
        const visible = todos.slice(this.scrollTop, this.scrollTop + windowSize);
        const lines = visible.map((item) => new Text(this.renderLine(item, width), 1, 0));

        const doneCount = todos.filter((item) => item.status === "done").length;
        const range = todos.length > windowSize ? ` · ${this.scrollTop + 1}-${this.scrollTop + visible.length}` : "";
        this.header.setText(theme.statusOk(`☐ 任务清单 · ${doneCount}/${todos.length} 完成${range}`));
        this.footer.setText(theme.dim("↑↓ 滚动 · ⌃U / ⌃D 翻页 · 滚轮 · Esc 关闭"));
        this.root.setChildren([this.header, ...lines, this.footer]);
        this.root.invalidate();
    }

    /** 单行任务：`[3] ● 内容`；Text 左右各 1 列内边距，宽度预算先扣掉。 */
    private renderLine(item: TodoItem, width: number): string {
        const prefix = `[${item.id}] ${STATUS_MARK[item.status]} `;
        const budget = Math.max(8, width - prefix.length - 2);
        const line = `${prefix}${truncatePlain(item.content, budget)}`;
        if (item.status === "done") return theme.dim(line);
        if (item.status === "in_progress") return theme.statusOk(line);
        return line;
    }
}
