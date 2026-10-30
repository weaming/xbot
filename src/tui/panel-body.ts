/**
 * 浮层内部纵向容器：只按顺序渲染子组件，不参与布局分配（高度自适应内容）。
 * 会话面板与快捷键面板共用。
 */

import type { Component } from "@earendil-works/pi-tui";

export class PanelBody implements Component {
    private children: Component[] = [];

    setChildren(children: Component[]): void {
        this.children = children;
    }

    render(width: number): string[] {
        const lines: string[] = [];
        for (const child of this.children) lines.push(...child.render(width));
        return lines;
    }

    invalidate(): void {
        for (const child of this.children) child.invalidate?.();
    }
}
