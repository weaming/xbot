import { describe, expect, test } from "bun:test";
import { handlePanelScroll, type PanelScrollOptions } from "./panel-scroll.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_U = "\x15";
const CTRL_D = "\x04";
const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";

function makeTracker(overrides: Partial<PanelScrollOptions> = {}): { deltas: number[]; options: PanelScrollOptions } {
    const deltas: number[] = [];
    return {
        deltas,
        options: { pageSize: 10, scrollBy: (delta) => deltas.push(delta), ...overrides },
    };
}

describe("面板滚动键", () => {
    test("↑↓ 与 j/k 滚动一行", () => {
        const { deltas, options } = makeTracker();

        for (const key of [UP, "k", DOWN, "j"]) {
            expect(handlePanelScroll(key, options)).toBe(true);
        }
        expect(deltas).toEqual([-1, -1, 1, 1]);
    });

    test("PgUp / PgDn 与 ⌃U / ⌃D 按可见行数翻页", () => {
        const { deltas, options } = makeTracker();

        for (const key of [PAGE_UP, CTRL_U, PAGE_DOWN, CTRL_D]) {
            expect(handlePanelScroll(key, options)).toBe(true);
        }
        expect(deltas).toEqual([-10, -10, 10, 10]);
    });

    test("滚轮滚动三行", () => {
        const { deltas, options } = makeTracker();

        expect(handlePanelScroll(WHEEL_DOWN, options)).toBe(true);
        expect(handlePanelScroll(WHEEL_UP, options)).toBe(true);
        expect(deltas).toEqual([3, -3]);
    });

    test("vimKeys=false 时 j/k 交还调用方（会话面板用于搜索输入）", () => {
        const { deltas, options } = makeTracker({ vimKeys: false });

        expect(handlePanelScroll("j", options)).toBe(false);
        expect(handlePanelScroll("k", options)).toBe(false);
        expect(handlePanelScroll(DOWN, options)).toBe(true);
        expect(deltas).toEqual([1]);
    });

    test("ctrlU=false 时 ⌃U 交还调用方（会话面板用于清空搜索）", () => {
        const { deltas, options } = makeTracker({ ctrlU: false });

        expect(handlePanelScroll(CTRL_U, options)).toBe(false);
        expect(handlePanelScroll(CTRL_D, options)).toBe(true);
        expect(deltas).toEqual([10]);
    });

    test("未识别的按键不消费", () => {
        const { deltas, options } = makeTracker();

        expect(handlePanelScroll("x", options)).toBe(false);
        expect(handlePanelScroll("\x1b[Z", options)).toBe(false);
        expect(deltas).toEqual([]);
    });
});
