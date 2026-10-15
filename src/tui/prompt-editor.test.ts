import { describe, expect, test } from "bun:test";
import { PromptEditor } from "./prompt-editor.js";
import { editorTheme } from "./theme.js";

const tuiStub = { requestRender: () => {} } as any;

describe("草稿 marker 展开（落盘用）", () => {
    test("当前会话用编辑器 pastes 展开", () => {
        const editor = new PromptEditor(tuiStub, editorTheme);
        editor.setSessionContext("s1");
        (editor as any).pastes = new Map([[1, "第一段粘贴"], [2, "第二段"]]);

        expect(editor.expandSessionDraft("s1", "看这个 [paste #1 12 chars] 和 [paste #2 +3 lines]"))
            .toBe("看这个 第一段粘贴 和 第二段");
    });

    test("其他会话用 SessionPasteStore 缓存展开；无缓存保持 marker", () => {
        const editor = new PromptEditor(tuiStub, editorTheme);
        editor.setSessionContext("s1");
        (editor as any).pastes = new Map([[1, "旧内容"]]);
        // 切到别的会话会把 s1 的 pastes 存进会话缓存
        editor.setSessionContext("s2");

        expect(editor.expandSessionDraft("s1", "[paste #1 5 chars]")).toBe("旧内容");
        expect(editor.expandSessionDraft("s3", "[paste #9 5 chars]")).toBe("[paste #9 5 chars]");
    });

    test("无 marker 时原样返回", () => {
        const editor = new PromptEditor(tuiStub, editorTheme);

        expect(editor.expandSessionDraft("s1", "普通草稿")).toBe("普通草稿");
    });
});
