/** 思考（reasoning）渲染块：Markdown 表格边框同样使用 reasoning 配色。 */

import { Markdown, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { reasoningMarkdownTheme, theme } from "./theme.js";

class ReasoningMarkdown implements Component {
    private readonly markdown: Markdown;

    constructor(text: string) {
        this.markdown = new Markdown(text, 1, 0, reasoningMarkdownTheme, {
            color: (value: string): string => theme.reasoning(value),
        });
    }

    render(width: number): string[] {
        let isInsideTable = false;
        return this.markdown.render(width).map((line) => {
            const plainLine = stripTerminalSequences(line);
            if (plainLine.includes("┌")) isInsideTable = true;
            if (!isInsideTable) return line;

            const styledLine = line.replace(/[┌┐└┘├┤┬┴┼─│]/g, (border) => theme.reasoning(border));
            if (plainLine.includes("┘")) isInsideTable = false;
            return styledLine;
        });
    }

    invalidate(): void {
        this.markdown.invalidate();
    }
}

export class ReasoningBlock implements Component {
    private readonly header = new Text(theme.reasoning("🧠"), 1, 0);
    private readonly body: ReasoningMarkdown;

    constructor(text: string) {
        this.body = new ReasoningMarkdown(text.replace(/^\n+/, ""));
    }

    render(width: number): string[] {
        return [...this.header.render(width), ...this.body.render(width)];
    }

    invalidate(): void {
        this.header.invalidate();
        this.body.invalidate();
    }
}
