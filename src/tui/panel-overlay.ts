/**
 * 浮层统一入口：居中浮窗 + 圆角边框 + 面板底色。
 * 尺寸、边距与宽度上限集中在此，四处浮层（会话 / 任务清单 / 快捷键 / 提问）同宽。
 *
 * 面板矩形由 `panelBounds()` 自行按同一套布局参数推算，而不是读 OverlayHandle.getBounds()：
 * 后者只在渲染路径里赋值，实测在 TUI 里长期为 undefined（滚轮命中判定会退化成"不限制"）。
 */

import { Box } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, TuiAltScreen } from "@earendil-works/pi-tui";
import { PANEL_ACCENT, PanelFrame, type PanelKind } from "./panel-frame.js";
import { theme } from "./theme.js";

/** 浮窗高度占比。 */
const HEIGHT_RATIO = 0.7;
/** 浮窗宽度上限：终端更宽也不再变宽，只有可用宽度不足时才收缩。112 = 基准期望宽度 80 两侧各扩展 1/5。 */
const MAX_WIDTH = 112;
/** 浮窗上下留给 header / footer 的行数。 */
const CHROME_ROWS = 4;
/** 浮窗与终端边缘的留白（与 showOverlay 的 margin 一致）。 */
const MARGIN = 1;

/** 浮层在屏幕上的矩形（0-based）。 */
export interface OverlayBounds {
    row: number;
    col: number;
    width: number;
    height: number;
}

/** 打开后的浮层：句柄 + 实际渲染高度（含边框），滚轮命中判定用。 */
export interface PanelOverlay {
    handle: OverlayHandle;
    /** 最近一次渲染的行数（含边框）；尚未渲染时为 0。 */
    height(): number;
}

/** 坐标（0-based）是否落在浮层矩形内。 */
export function isInsideBounds(bounds: OverlayBounds, x: number, y: number): boolean {
    return x >= bounds.col && x < bounds.col + bounds.width
        && y >= bounds.row && y < bounds.row + bounds.height;
}

/** 读取浮层矩形；OverlayHandle 的类型声明未暴露 getBounds，运行时才有。 */
export function overlayBounds(handle: OverlayHandle | null): OverlayBounds | undefined {
    if (!handle) return undefined;
    const getter = (handle as unknown as { getBounds?: () => OverlayBounds | undefined }).getBounds;
    return getter?.call(handle);
}

/**
 * 浮窗宽度：所有浮层（会话 / 任务清单 / 快捷键 / 提问）同宽，都按会话列表的宽度渲染。
 * 宽度取满可用宽度（cols - 2*MARGIN）与 MAX_WIDTH 的较小值：窄终端以「不出屏」优先。
 * openPanelOverlay 与 panelBounds 共用本函数，避免两处夹取逻辑漂移。
 */
function panelWidth(cols: number): number {
    return Math.max(1, Math.min(MAX_WIDTH, cols - MARGIN * 2));
}

/** 浮窗最大高度：终端高度的 HEIGHT_RATIO（不低于 8 行），且不超出可用高度。 */
function panelMaxHeight(rows: number): number {
    const preferred = Math.max(8, Math.floor(rows * HEIGHT_RATIO));
    return Math.max(1, Math.min(preferred, Math.max(1, rows - MARGIN * 2)));
}

/**
 * 按 openPanelOverlay 的布局参数推算面板矩形（与 pi-tui resolveOverlayLayout 的
 * center + margin + clamp 行为一致），renderHeight 为含边框的实际渲染行数。
 */
export function panelBounds(tui: TuiAltScreen, renderHeight: number): OverlayBounds {
    const cols = Math.max(1, tui.terminal.columns || 80);
    const rows = Math.max(1, tui.terminal.rows || 24);
    const availW = Math.max(1, cols - MARGIN * 2);
    const availH = Math.max(1, rows - MARGIN * 2);

    const width = panelWidth(cols);
    const maxHeight = panelMaxHeight(rows);
    const height = Math.max(1, Math.min(renderHeight, maxHeight));

    const col = Math.max(MARGIN, Math.min(MARGIN + Math.floor((availW - width) / 2), cols - MARGIN - width));
    const row = Math.max(MARGIN, Math.min(MARGIN + Math.floor((availH - height) / 2), rows - MARGIN - height));
    return { row, col, width, height };
}

/** 按终端高度推算面板可用的内容行数（供窗口化滚动使用）。 */
export function panelContentRows(tui: TuiAltScreen): number {
    const rows = tui.terminal.rows || 24;
    return Math.max(6, Math.floor(rows * HEIGHT_RATIO) - CHROME_ROWS);
}

/** 打开浮层：面板内容套 PanelFrame 边框，居中显示并返回句柄与渲染高度读取器。 */
export function openPanelOverlay(tui: TuiAltScreen, panel: Component, kind: PanelKind): PanelOverlay {
    const cols = tui.terminal.columns || 80;
    const rows = tui.terminal.rows || 24;
    const frame = new Box(0, 0, theme.panelBackground);
    frame.addChild(new PanelFrame(panel, PANEL_ACCENT[kind]));

    let renderHeight = 0;
    const tracked: Component = {
        render: (width: number) => {
            const lines = frame.render(width);
            renderHeight = lines.length;
            return lines;
        },
        invalidate: () => frame.invalidate(),
    };

    const handle = tui.showOverlay(tracked, {
        width: panelWidth(cols),
        maxHeight: panelMaxHeight(rows),
        anchor: "center",
        margin: MARGIN,
    });

    return { handle, height: () => renderHeight };
}
