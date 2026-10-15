import { describe, expect, test } from "bun:test";
import { StreamingReasoningBlock } from "../../src/tui/streaming-reasoning.js";

/**
 * StreamingReasoningBlock 流式视口测试：
 * - 增量 append 按 UI 行（屏幕行）wrap，不丢字符；
 * - 超过视口行数时只保留最后 10 个 UI 行（块高度恒定，历史不跳动）；
 * - 中文字符按双倍宽度折行。
 */

describe("StreamingReasoningBlock 流式视口", () => {
    test("增量 append 不丢字符，按 UI 行 wrap", () => {
        const block = new StreamingReasoningBlock();
        const text = "abcdefghijklmnopqrstuvwxyz";
        block.append(text.slice(0, 5), 10);
        block.append(text.slice(5), 10);

        expect(block.lines.join("")).toBe(text);
        for (const line of block.lines) {
            expect(line.length).toBeLessThanOrEqual(10);
        }
    });

    test("超过视口行数时只保留最后 10 个 UI 行", () => {
        const block = new StreamingReasoningBlock();
        // width=8：每行 8 字符，100 字符 -> 13 行，窗口固定为最后 10 行（9 满行 + 4 字符尾行）
        block.append("x".repeat(100), 8);

        expect(block.lines).toHaveLength(10);
        expect(block.lines.join("")).toBe("x".repeat(76));
        for (const line of block.lines) {
            expect(line.length).toBeLessThanOrEqual(8);
        }
    });

    test("换行符按行边界处理", () => {
        const block = new StreamingReasoningBlock();
        block.append("line1\nline2\nline3", 50);

        expect(block.lines.join("\n")).toBe("line1\nline2\nline3");
    });

    test("中文字符按双倍宽度折行", () => {
        const block = new StreamingReasoningBlock();
        block.append("中文a中文b", 6);

        expect(block.lines).toEqual(["中文a", "中文b"]);
    });

    test("reset 全量重建窗口（宽度变化/文本回退）", () => {
        const block = new StreamingReasoningBlock();
        block.append("aaaabbbbcccc", 8);
        block.reset("一二三四五六七八九", 4);

        expect(block.lines.join("")).toBe("一二三四五六七八九");
        expect(block.lines.length).toBeLessThanOrEqual(10);
    });

    test("append 时宽度变化会清空旧窗口", () => {
        const block = new StreamingReasoningBlock();
        block.append("aaaabbbb", 8);
        block.append("ccccdddd", 4);

        expect(block.lines.join("")).toBe("ccccdddd");
        for (const line of block.lines) {
            expect(line.length).toBeLessThanOrEqual(4);
        }
    });
});
