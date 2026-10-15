import { describe, expect, test } from "bun:test";
import { parseWheelDelta, parseWheelEvent } from "./panel-input.js";

describe("滚轮序列解析", () => {
    test("向上滚为负、向下滚为正", () => {
        expect(parseWheelDelta("\x1b[<64;10;5M")).toBe(-3);
        expect(parseWheelDelta("\x1b[<65;10;5M")).toBe(3);
    });

    test("解析鼠标坐标（SGR 1-based → 0-based）", () => {
        expect(parseWheelEvent("\x1b[<65;10;5M")).toEqual({ delta: 3, x: 9, y: 4 });
        expect(parseWheelEvent("\x1b[<64;1;1M")).toEqual({ delta: -3, x: 0, y: 0 });
        expect(parseWheelEvent("\x1b[B")).toBeUndefined();
    });

    test("兼容 X10 编码（ESC [ M Cb Cx Cy）", () => {
        const x10 = (button: number, x: number, y: number) =>
            `\x1b[M${String.fromCharCode(button + 32, x + 32, y + 32)}`;

        expect(parseWheelEvent(x10(65, 10, 5))).toEqual({ delta: 3, x: 9, y: 4 });
        expect(parseWheelEvent(x10(64, 1, 1))).toEqual({ delta: -3, x: 0, y: 0 });
        // 左键点击（button 0）不是滚轮
        expect(parseWheelEvent(x10(0, 10, 5))).toBeUndefined();
    });

    test("非滚轮事件返回 undefined", () => {
        expect(parseWheelDelta("\x1b[<0;10;5M")).toBeUndefined();
        expect(parseWheelDelta("\x1b[<32;10;5M")).toBeUndefined();
        expect(parseWheelDelta("\x1b[B")).toBeUndefined();
        expect(parseWheelDelta("a")).toBeUndefined();
    });
});
