/**
 * 浮窗边框：圆角框 + 强调色，套在面板内容外层（内容区精确补齐，右竖线贴边）。
 * 会话 / 任务清单 / 快捷键三处浮层共用同一套边框，靠颜色区分。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { padColumns } from "../format/text.js";
import { theme } from "./theme.js";

/** 各浮层的边框强调色。 */
export const PANEL_ACCENT = {
    session: theme.commandBorder,
    todo: theme.statusOk,
    shortcut: theme.statusWarn,
    question: theme.question,
    model: theme.statusOk,
    mcp: theme.tool,
} as const;

export type PanelKind = keyof typeof PANEL_ACCENT;

export class PanelFrame implements Component {
    constructor(
        private readonly inner: Component,
        private readonly accent: (text: string) => string = PANEL_ACCENT.session,
    ) {}

    render(width: number): string[] {
        const innerWidth = Math.max(1, width - 2);
        const side = this.accent("│");
        const body = this.inner.render(innerWidth).map((line) => {
            const fitted = visibleWidth(line) > innerWidth ? line : padColumns(line, innerWidth);
            return `${side}${fitted}${side}`;
        });
        const horizontal = "─".repeat(innerWidth);
        return [this.accent(`╭${horizontal}╮`), ...body, this.accent(`╰${horizontal}╯`)];
    }

    invalidate(): void {
        this.inner.invalidate?.();
    }
}
