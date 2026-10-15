import { describe, expect, test } from "bun:test";
import { isClipboardPasteKey } from "../../src/tui/prompt-editor.js";

const CTRL_V = "\x16";
const SUPER_V = "\x1b[118;9u";

describe("PromptEditor 图片粘贴快捷键", () => {
    test("macOS 使用 Cmd+V", () => {
        expect(isClipboardPasteKey(SUPER_V, "darwin")).toBe(true);
        expect(isClipboardPasteKey(CTRL_V, "darwin")).toBe(false);
    });

    test("非 macOS 使用 Ctrl+V", () => {
        expect(isClipboardPasteKey(CTRL_V, "linux")).toBe(true);
        expect(isClipboardPasteKey(SUPER_V, "linux")).toBe(false);
    });
});
