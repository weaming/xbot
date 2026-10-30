/**
 * 浮层面板栈：统一「谁能用键盘、输入往哪去」的路由。
 *
 * 改造前，五种面板靠 `activePanelEntry` 这个判别联合 + 每个面板一套 open/close 方法维护互斥，
 * 输入路由写死在 `handlePanelInput` 的 kind 分支里，特例（提问面板吃掉 ⌃⇧Q、
 * 却不吃滚轮/翻页）也硬编码在那一个函数中。改一个面板的行为要读遍所有分支。
 *
 * 这里把「一个面板在栈上」建模成一层 Layer：
 *   - 快捷键与滚轮这类全局输入由 Layer 自己声明是否拦截；
 *   - 其余输入默认交给最上层面板；
 *   - 关闭动作由 Layer 自带，栈不再需要记住每种面板怎么关。
 */

/** 面板种类：只用于展示与诊断，路由不依赖它。 */
export type PanelKind = "session" | "shortcut" | "model" | "question" | "mcp";

/** 面板必须提供的能力。 */
interface PanelLike {
    handleInput(data: string): void;
}

export interface PanelLayer {
    kind: PanelKind;
    /** 面板内容（实现 handleInput）。 */
    panel: PanelLike;
    /**
     * 全局输入拦截：返回 true 表示这一层消费了它，不再向下传递。
     * 缺省表示不拦截任何全局输入。
     */
    intercept?: (data: string) => boolean;
    /** 关闭这一层时执行（隐藏浮层、释放资源、还原焦点）。 */
    onClose?: () => void;
    /** 该层所属的会话（提问面板按会话挂载）。 */
    sessionId?: string;
    /** 附加数据：由调用方持有，栈不解释。 */
    meta?: unknown;
}

/**
 * 鼠标滚轮与翻页：面板自己不处理，交给聊天视口滚动。
 * 这类输入在栈里统一判定一次，不再由每种面板各自重复。
 */
export type ScrollInputPredicate = (data: string) => boolean;

export class PanelStack {
    private readonly layers: PanelLayer[] = [];

    constructor(private readonly isScrollInput: ScrollInputPredicate) {}

    get depth(): number {
        return this.layers.length;
    }

    get isEmpty(): boolean {
        return this.layers.length === 0;
    }

    top(): PanelLayer | undefined {
        return this.layers[this.layers.length - 1];
    }

    /** 从栈顶向下找第一个满足条件的层。 */
    find(kind: PanelKind): PanelLayer | undefined {
        for (let index = this.layers.length - 1; index >= 0; index -= 1) {
            if (this.layers[index]!.kind === kind) return this.layers[index];
        }
        return undefined;
    }

    has(kind: PanelKind): boolean {
        return this.find(kind) !== undefined;
    }

    /** 压入一层；同一 kind 已在栈上时先移除旧层，保证同类面板至多一份。 */
    push(layer: PanelLayer): void {
        const existingIndex = this.layers.findIndex(candidate => candidate.kind === layer.kind);
        if (existingIndex >= 0) {
            const [existing] = this.layers.splice(existingIndex, 1);
            existing?.onClose?.();
        }
        this.layers.push(layer);
    }

    /** 弹出最上层，并执行它的关闭动作。 */
    pop(): PanelLayer | undefined {
        const layer = this.layers.pop();
        layer?.onClose?.();
        return layer;
    }

    /** 移除指定种类的层（不论它在第几层），执行关闭动作。 */
    remove(kind: PanelKind): PanelLayer | undefined {
        const index = this.layers.findIndex(layer => layer.kind === kind);
        if (index < 0) return undefined;
        const [layer] = this.layers.splice(index, 1);
        layer?.onClose?.();
        return layer;
    }

    /** 清空整个栈（退出时收尾）。 */
    clear(): void {
        while (this.layers.length > 0) this.pop();
    }

    /**
     * 路由一次键盘输入。
     *
     * 顺序：
     *   1. 从栈顶向下，谁声明拦截就给谁（特例集中在这里，不再散落到各分支）；
     *   2. 滚轮/翻页交给视口滚动，返回 false；
     *   3. 其余交给最上层面板，返回 true。
     */
    routeInput(data: string): boolean {
        for (let index = this.layers.length - 1; index >= 0; index -= 1) {
            const layer = this.layers[index]!;
            if (layer.intercept?.(data)) return true;
        }

        const top = this.top();
        if (!top) return false;
        if (this.isScrollInput(data)) return false;

        top.panel.handleInput(data);
        return true;
    }
}
