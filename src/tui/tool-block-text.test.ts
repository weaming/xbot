import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { wrapDiffTextByColumns, wrapTextByColumns } from "./tool-block-text.js";

describe("工具块文本换行", () => {
    test("压缩 JSON 按列硬换行且不丢失字符串中的空格", () => {
        const text = '{"longName":"Taiwan Semiconductor Manufacturing Company Limited","quoteType":"EQUITY"}';
        const lines = wrapTextByColumns(`\x1b[35m${text}\x1b[0m`, 24);

        expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
        expect(lines.map(stripTerminalSequences).join("")).toBe(text);
    });

    test("整体 ANSI 样式跨越原始换行后仍然有效", () => {
        const lines = wrapTextByColumns("\x1b[90m第一行\n第二行\n第三行\x1b[0m", 24);

        expect(lines).toHaveLength(3);
        expect(lines.every((line) => line.startsWith("\x1b[90m"))).toBe(true);
        expect(lines.map(stripTerminalSequences)).toEqual(["第一行", "第二行", "第三行"]);
    });

    test("diff 超宽续行从代码列开始，不覆盖行号", () => {
        const lines = wrapDiffTextByColumns("103 + very-long-content-123456789", 20);

        expect(lines.length).toBeGreaterThan(1);
        expect(lines[0]).toContain("103 +");
        expect(lines[1]?.startsWith("      ")).toBe(true);
        expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
    });
});
