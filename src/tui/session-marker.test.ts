import { describe, expect, test } from "bun:test";
import { DEFAULT_SPINNER, sessionMarker, SPINNER_FRAMES } from "./session-marker.js";

describe("会话状态标记", () => {
    test("优先级：归档 > 运行中 > 选中 > 空闲", () => {
        expect(sessionMarker({ archived: true, busy: true, active: true }, "◐")).toBe("✕");
        expect(sessionMarker({ busy: true, active: true }, "◐")).toBe("◐");
        expect(sessionMarker({ busy: false, active: true }, "◐")).toBe("●");
        expect(sessionMarker({ busy: false, active: false }, "◐")).toBe("○");
    });

    test("待作答提问优先于运行中：asking 时显示 1 列宽的 ?", () => {
        expect(sessionMarker({ busy: true, active: false, question: true }, "◐")).toBe("?");
        expect(sessionMarker({ busy: false, active: true, question: true }, "◐")).toBe("?");
        // 归档优先于提问（归档会话不可能在跑回合）
        expect(sessionMarker({ archived: true, busy: true, active: false, question: true }, "◐")).toBe("✕");
    });

    test("面板归属覆盖忙碌/选中：他实例 ◎，未认领 ◌，归档仍优先", () => {
        expect(sessionMarker({ busy: true, active: true, owner: "other" }, "◐")).toBe("◎");
        expect(sessionMarker({ busy: false, active: false, owner: "free" }, "◐")).toBe("◌");
        expect(sessionMarker({ archived: true, busy: false, active: false, owner: "free" }, "◐")).toBe("✕");
    });

    test("缺省归属视为本实例：tab 条不传 owner 时语义不变", () => {
        expect(sessionMarker({ busy: false, active: true, owner: "mine" }, "◐")).toBe("●");
        expect(sessionMarker({ busy: false, active: true }, "◐")).toBe("●");
    });

    test("缺省 spinner 为帧序列首帧", () => {
        expect(DEFAULT_SPINNER).toBe(SPINNER_FRAMES[0]);
        expect(sessionMarker({ busy: true, active: false })).toBe(DEFAULT_SPINNER);
    });

    test("spinner 帧使用几何四分区字符（非 Braille 点阵，保证与 ●○ 重心一致）", () => {
        for (const frame of SPINNER_FRAMES) {
            const code = frame.codePointAt(0) ?? 0;
            expect(code).toBeGreaterThanOrEqual(0x25d0);
            expect(code).toBeLessThanOrEqual(0x25d3);
        }
    });
});
