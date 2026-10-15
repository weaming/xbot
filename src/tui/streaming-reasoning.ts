/**
 * reasoning 流式视口块：按 UI 行（屏幕行）增量滚动窗口，块高度恒定，历史不跳动。
 * 流式更新时只追加新增字符 wrap 出的 UI 行，顶部溢出行滚出视口，
 * 已渲染内容在屏幕上的位置保持稳定，而非每次按"文本最后几行"整体替换。
 */

import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

/** 视口固定 UI 行数（reasoning 块占用的屏幕行上限）。 */
const REASONING_VIEWPORT_LINES = 10;

export class StreamingReasoningBlock implements Component {
    private readonly header = new Text(theme.reasoning("🧠"), 1, 0);
    private readonly body = new Text("", 0, 0, theme.reasoning);
    private uiLines: string[] = [];
    private colWidths: number[] = [];
    /** 当前 wrap 宽度（供调用方检测终端 resize 后全量重建）。 */
    width = 0;

    /** 当前渲染的 UI 行（测试/调试用）。 */
    get lines(): readonly string[] {
        return this.uiLines;
    }

    /** 终端宽度变化或文本回退时全量重建窗口。 */
    reset(fullText: string, width: number): void {
        this.uiLines = [];
        this.colWidths = [];
        this.width = width;
        this.append(fullText, width);
    }

    /** 增量追加文本：按 UI 行 wrap，始终保留最后 REASONING_VIEWPORT_LINES 行。 */
    append(text: string, width: number): void {
        if (!text) return;
        if (this.width !== width) {
            this.uiLines = [];
            this.colWidths = [];
            this.width = width;
        }
        if (this.uiLines.length === 0) {
            this.uiLines.push("");
            this.colWidths.push(0);
        }
        let line = this.uiLines.length - 1;
        let col = this.colWidths[line];
        for (const ch of text) {
            const w = visibleWidth(ch);
            if (ch === "\n") {
                this.colWidths[line] = col;
                this.uiLines.push("");
                this.colWidths.push(0);
                line += 1;
                col = 0;
                continue;
            }
            if (col + w > width) {
                // 在 UI 行边界折行：已渲染的历史行保持原位，新内容进入下一行
                this.colWidths[line] = col;
                this.uiLines.push("");
                this.colWidths.push(0);
                line += 1;
                col = 0;
            }
            this.uiLines[line] += ch;
            col += w;
        }
        this.colWidths[line] = col;
        this.trimViewport();
        this.body.setText(this.uiLines.join("\n"));
        this.body.invalidate();
    }

    private trimViewport(): void {
        const overflow = this.uiLines.length - REASONING_VIEWPORT_LINES;
        if (overflow > 0) {
            this.uiLines.splice(0, overflow);
            this.colWidths.splice(0, overflow);
        }
    }

    render(width: number): string[] {
        // 行已按终端宽度预 wrap，渲染时直接输出，避免组件二次折行。
        return [...this.header.render(width), ...this.body.render(width)];
    }

    invalidate(): void {
        this.header.invalidate();
        this.body.invalidate();
    }
}
