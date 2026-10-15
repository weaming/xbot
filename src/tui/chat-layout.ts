/** 垂直布局容器：在 VStack 基础上支持按组件设置最小高度（pending 列表动态占位）。 */

import { VStack } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export class ChatLayout extends VStack {
    setMinSize(component: Component, minSize: number): void {
        const entry = this.entries.find((item) => item.component === component);
        if (entry) entry.minSize = Math.max(0, Math.floor(minSize));
    }
}
