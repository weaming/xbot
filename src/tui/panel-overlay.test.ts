import { describe, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { isInsideBounds, openPanelOverlay, overlayBounds, panelBounds, type OverlayBounds } from "./panel-overlay.js";

const BOUNDS: OverlayBounds = { row: 10, col: 20, width: 40, height: 10 };

describe("浮层矩形推算", () => {
    const tui = { terminal: { columns: 80, rows: 24 } } as any;

    test("80x24 终端居中（与 pi-tui 实际布局一致）", () => {
        // 3 个会话的面板：高 8 行
        expect(panelBounds(tui, 8)).toEqual({ row: 8, col: 1, width: 78, height: 8 });
        // 内容超长：被 maxHeight（70% 终端高度）截断
        expect(panelBounds(tui, 40)).toEqual({ row: 4, col: 1, width: 78, height: 16 });
    });

    test("窄终端下宽度被可用空间夹住", () => {
        const narrow = { terminal: { columns: 30, rows: 10 } } as any;
        const bounds = panelBounds(narrow, 6);

        expect(bounds.width).toBe(28);
        expect(bounds.col).toBe(1);
        expect(bounds.height).toBe(6);
    });

    test("期望最小宽度不是硬下限：可用宽度不足时以不出屏优先", () => {
        const width = (cols: number) => panelBounds({ terminal: { columns: cols, rows: 24 } } as any, 6).width;

        // 可用宽度 = cols - 2；cols = 41 时可用宽度 39 < 40，浮窗收缩
        expect(width(41)).toBe(39);
        // 恰好够用时恢复期望下限
        expect(width(42)).toBe(40);
        // 宽终端仍受上限约束（期望上限放大 1.4 倍）
        expect(width(200)).toBe(112);
    });

    test("所有浮层同宽：期望宽度放大 1.4 倍后再让位给可用宽度", () => {
        const width = (cols: number) => panelBounds({ terminal: { columns: cols, rows: 24 } } as any, 6).width;

        // 期望上限 80 放大到 112；窄终端仍受可用宽度夹取
        expect(width(200)).toBe(112);
        expect(width(100)).toBe(98);
        // 可用宽度不足期望下限时收缩到可用宽度（41 - 2 = 39）
        expect(width(41)).toBe(39);
    });

    test("openPanelOverlay 传给 showOverlay 的宽高与 panelBounds 推算一致（防两处漂移）", () => {
        for (const [cols, rows] of [[80, 24], [41, 24], [200, 12]] as const) {
            let options: any;
            const tui = {
                terminal: { columns: cols, rows },
                showOverlay: (_component: any, opts: any) => {
                    options = opts;
                    return { hide() {} };
                },
            } as any;

            for (const kind of ["session", "todo", "shortcut", "question"] as const) {
                openPanelOverlay(tui, new Text("panel"), kind);

                expect(options.width).toBe(panelBounds(tui, 0).width);
                // 渲染高度无上限时 panelBounds 的夹取结果即 maxHeight
                expect(options.maxHeight).toBe(panelBounds(tui, Number.MAX_SAFE_INTEGER).height);
            }
        }
    });
});

describe("浮层坐标判断", () => {
    test("矩形内为 true，边界与外部为 false", () => {
        expect(isInsideBounds(BOUNDS, 20, 10)).toBe(true);
        expect(isInsideBounds(BOUNDS, 59, 19)).toBe(true);

        expect(isInsideBounds(BOUNDS, 19, 10)).toBe(false);
        expect(isInsideBounds(BOUNDS, 60, 10)).toBe(false);
        expect(isInsideBounds(BOUNDS, 20, 9)).toBe(false);
        expect(isInsideBounds(BOUNDS, 20, 20)).toBe(false);
    });

    test("overlayBounds 兼容未渲染（无 bounds）与空句柄", () => {
        expect(overlayBounds(null)).toBeUndefined();
        expect(overlayBounds({ getBounds: () => undefined } as any)).toBeUndefined();
        expect(overlayBounds({} as any)).toBeUndefined();
        expect(overlayBounds({ getBounds: () => BOUNDS } as any)).toEqual(BOUNDS);
    });
});
