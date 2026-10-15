/** 底部两行状态栏：左右对齐渲染，右侧留固定内边距。 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export class StatusBar implements Component {
    private static readonly RIGHT_PADDING = 2;
    private line1 = { left: "", right: "" };
    private line2 = { left: "", right: "" };

    setStatus(
        line1: { left: string; right?: string } | string,
        line2?: { left: string; right?: string } | string,
    ): void {
        if (typeof line1 === "string") {
            this.line1 = { left: line1, right: typeof line2 === "string" ? line2 : "" };
            this.line2 = { left: "", right: "" };
        } else {
            this.line1 = { left: line1.left, right: line1.right ?? "" };
            if (line2 && typeof line2 !== "string") {
                this.line2 = { left: line2.left, right: line2.right ?? "" };
            } else if (typeof line2 === "string") {
                this.line2 = { left: line2, right: "" };
            } else {
                this.line2 = { left: "", right: "" };
            }
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        const renderedLine1 = this.renderLine(this.line1.left, this.line1.right, safeWidth);
        const renderedLine2 = this.renderLine(this.line2.left, this.line2.right, safeWidth);
        return [renderedLine1, renderedLine2];
    }

    private renderLine(leftText: string, rightText: string, safeWidth: number): string {
        if (!leftText && !rightText) {
            return " ".repeat(safeWidth);
        }
        if (visibleWidth(leftText) >= safeWidth) {
            return truncateToWidth(leftText, safeWidth);
        }

        const availableRightWidth = Math.max(
            0,
            safeWidth - visibleWidth(leftText) - 1 - StatusBar.RIGHT_PADDING,
        );
        const truncatedRight = truncateToWidth(rightText, availableRightWidth, "…");
        const gap = Math.max(
            1,
            safeWidth
                - visibleWidth(leftText)
                - visibleWidth(truncatedRight)
                - StatusBar.RIGHT_PADDING,
        );
        return `${leftText}${" ".repeat(gap)}${truncatedRight}${" ".repeat(StatusBar.RIGHT_PADDING)}`;
    }

    invalidate(): void {}
}
