import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PanelFrame } from "./panel-frame.js";

function makeFrame(lines: string[]): PanelFrame {
    return new PanelFrame({
        render: () => lines,
        invalidate: () => {},
    });
}

describe("浮窗边框", () => {
    test("上下边框闭合，左右竖线贴边", () => {
        const rendered = makeFrame(["内容", "第二行"]).render(20).map(stripTerminalSequences);

        expect(rendered[0]).toBe(`╭${"─".repeat(18)}╮`);
        expect(rendered[1]).toBe(`│内容${" ".repeat(14)}│`);
        expect(rendered[2]).toBe(`│第二行${" ".repeat(12)}│`);
        expect(rendered[3]).toBe(`╰${"─".repeat(18)}╯`);
        expect(rendered.every((line) => visibleWidth(line) === 20)).toBe(true);
    });

    test("内容行按可见列宽补齐，含 ANSI 时不破坏样式", () => {
        const rendered = makeFrame(["\x1b[1m标题\x1b[0m"]).render(12).map(stripTerminalSequences);

        expect(rendered[1]).toBe("│标题      │");
        expect(rendered.every((line) => visibleWidth(line) === 12)).toBe(true);
    });

    test("invalidate 透传给内部组件", () => {
        let calls = 0;
        const frame = new PanelFrame({ render: () => [], invalidate: () => { calls += 1; } });

        frame.invalidate();
        expect(calls).toBe(1);
    });
});
