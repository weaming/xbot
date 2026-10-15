/** bracketed paste 组装器测试：各种分片/交错/合并时序下内容保持完整。 */

import { describe, expect, test } from "bun:test";
import { PasteAssembler, SessionPasteStore } from "../../src/tui/paste-assembler.js";

const START = "\x1b[200~";
const END = "\x1b[201~";

function pushAll(assembler: PasteAssembler, chunks: string[]): string[] {
    const out: string[] = [];
    for (const chunk of chunks) {
        out.push(...assembler.push(chunk));
    }
    return out;
}

describe("PasteAssembler", () => {
    test("单个完整 paste 一次到达", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push(`${START}hello${END}`)).toEqual([`${START}hello${END}`]);
    });

    test("一个 paste 分三个数据块到达", () => {
        const assembler = new PasteAssembler();
        const out = pushAll(assembler, [START, "中文内容\n第二行", END]);
        expect(out).toEqual([`${START}中文内容\n第二行${END}`]);
    });

    test("两次相邻 paste 合并在一个数据块", () => {
        const assembler = new PasteAssembler();
        const out = assembler.push(`${START}AAA${END}${START}BBB${END}`);
        expect(out).toEqual([`${START}AAA${END}`, `${START}BBB${END}`]);
    });

    test("两次粘贴分片交错到达不丢内容", () => {
        const assembler = new PasteAssembler();
        // 第一次 200~内容1 未闭合，第二次 200~内容2 紧随其后，最后两个 201~ 收尾。
        const out = pushAll(assembler, [`${START}内容1`, `${START}内容2`, `${END}${END}`]);
        // 两段分别完整，内容区不残留 200~ 残片。
        const contents = out.map(seq => seq.slice(START.length, seq.indexOf(END)));
        expect(out).toHaveLength(2);
        expect(contents.join(",")).toContain("内容1");
        expect(contents.join(",")).toContain("内容2");
        expect(contents.every(content => !content.includes(START))).toBe(true);
    });

    test("paste1 内容丢失场景：两次粘贴各自完成，内容都在", () => {
        const assembler = new PasteAssembler();
        const out = pushAll(assembler, [`${START}第一段${END}`, `${START}第二段${END}`]);
        expect(out).toEqual([`${START}第一段${END}`, `${START}第二段${END}`]);
    });

    test("普通数据原样透传", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push("abc")).toEqual(["abc"]);
        expect(assembler.push("\x1b[13u")).toEqual(["\x1b[13u"]);
    });

    test("前缀普通数据与 paste 在同一块", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push(`x${START}hi${END}y`)).toEqual(["x", `${START}hi${END}`, "y"]);
    });

    test("空 paste 不产生输出", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push(`${START}${END}`)).toEqual([]);
    });

    test("孤立结束标记被丢弃（不污染编辑层）", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push(`${END}abc`)).toEqual(["abc"]);
        expect(assembler.push(`${START}hi${END}${END}z`)).toEqual([`${START}hi${END}`, "z"]);
    });

    test("paste 后紧跟普通数据", () => {
        const assembler = new PasteAssembler();
        expect(assembler.push(`${START}hi${END}z`)).toEqual([`${START}hi${END}`, "z"]);
    });

    test("跨多次 push 的普通数据按序透传", () => {
        const assembler = new PasteAssembler();
        expect(pushAll(assembler, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });
});

describe("SessionPasteStore", () => {
    test("save/restore 保留内容并把 counter 设为 max(id)（下一个 id 连续）", () => {
        const store = new SessionPasteStore();
        const pastes = new Map([[1, "A"], [3, "C"]]);
        store.save("s1", pastes);

        const target = new Map<number, string>();
        const counter = { value: 0 };
        expect(store.restore("s1", target, counter)).toBe(true);
        expect(target.get(1)).toBe("A");
        expect(target.get(3)).toBe("C");
        expect(counter.value).toBe(3);
    });

    test("无缓存时 restore 返回 false 且不动 Map", () => {
        const store = new SessionPasteStore();
        const target = new Map([[9, "x"]]);
        const counter = { value: 5 };
        expect(store.restore("missing", target, counter)).toBe(false);
        expect(target.get(9)).toBe("x");
        expect(counter.value).toBe(5);
    });

    test("clear 删除缓存", () => {
        const store = new SessionPasteStore();
        store.save("s1", new Map([[1, "A"]]));
        store.clear("s1");
        expect(store.restore("s1", new Map(), { value: 0 })).toBe(false);
    });
});

/**
 * 模拟 pi-tui Editor 的 paste-marker 关键行为（不 import 真实 pi-tui：
 * bun 的 mock.module 会在 worker 内跨文件生效，污染真实模块）。
 */
class StubEditor {
    pastes = new Map<number, string>();
    pasteCounter = 0;
    lines: string[] = [""];

    getText(): string {
        return this.lines.join("\n");
    }

    setText(text: string): void {
        this.lines = text.split("\n");
        this.pastes.clear();
        this.pasteCounter = 0;
    }

    handlePaste(content: string): void {
        const lines = content.split("\n");
        const isLarge = lines.length > 10 || content.length > 1000;
        this.pasteCounter++;
        const id = this.pasteCounter;
        if (isLarge) {
            this.pastes.set(id, content);
            const marker = `[paste #${id} +${lines.length} lines]`;
            const last = this.lines[this.lines.length - 1] ?? "";
            this.lines[this.lines.length - 1] = last + marker;
        } else {
            const last = this.lines[this.lines.length - 1] ?? "";
            this.lines[this.lines.length - 1] = last + content;
        }
    }

    getExpandedText(): string {
        let result = this.getText();
        for (const [id, content] of this.pastes) {
            const regex = new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
            result = result.replace(regex, content);
        }
        return result;
    }
}

/** 与 app.ts PromptEditor 完全一致的会话级 paste 逻辑。 */
class SessionAwareStubEditor extends StubEditor {
    private readonly store = new SessionPasteStore();
    private sessionId: string | null = null;

    setSessionContext(sessionId: string | null): void {
        if (this.sessionId === sessionId) return;
        if (this.sessionId) {
            this.store.save(this.sessionId, this.pastes);
        }
        this.sessionId = sessionId;
        if (sessionId) {
            const counter = { value: this.pasteCounter };
            if (this.store.restore(sessionId, this.pastes, counter)) {
                this.pasteCounter = counter.value;
            }
        }
    }

    override setText(text: string): void {
        super.setText(text);
        if (this.sessionId && text.includes("[paste #")) {
            const counter = { value: this.pasteCounter };
            if (this.store.restore(this.sessionId, this.pastes, counter)) {
                this.pasteCounter = counter.value;
            }
        }
    }
}

const PART_A = Array.from({ length: 12 }, (_, i) => `AAA-${i}`).join("\n");
const PART_B = Array.from({ length: 12 }, (_, i) => `BBB-${i}`).join("\n");

describe("会话级 paste 恢复（stub 集成）", () => {
    test("修复前 bug 对照组：setText 清 Map 后粘贴，前一份被后一份覆盖", () => {
        const plain = new StubEditor();
        plain.handlePaste(PART_A); // marker #1 -> A
        plain.setText("[paste #1 +12 lines]"); // 模拟含 marker 的草稿恢复
        plain.handlePaste(PART_B); // 复用 id #1 -> B，覆盖 A
        const expanded = plain.getExpandedText();
        expect(expanded.includes("AAA-")).toBe(false); // A 内容丢失
        expect(expanded.includes("BBB-")).toBe(true);
    });

    test("会话切回 + 恢复含 marker 草稿后，两段内容都正确展开", () => {
        const editor = new SessionAwareStubEditor();

        editor.setSessionContext("s1");
        editor.handlePaste(PART_A); // marker #1 -> A
        expect(editor.getText()).toContain("[paste #1");

        editor.setSessionContext(null);
        editor.setText(""); // 模拟库 setText 清空 Map

        editor.setSessionContext("s1");
        editor.setText("[paste #1 +12 lines]"); // 旧 draft（含 marker）
        expect(editor.getExpandedText()).toContain("AAA-0");

        editor.handlePaste(PART_B); // 新 id 不与已恢复冲突（应为 #2）
        const expanded = editor.getExpandedText();
        expect(expanded).toContain("AAA-0");
        expect(expanded).toContain("AAA-11");
        expect(expanded).toContain("BBB-0");
        expect(expanded).toContain("BBB-11");
        expect(expanded.length).toBe(PART_A.length + PART_B.length);
    });

    test("恢复草稿后继续粘贴，marker 序号保持连续（无跳号）", () => {
        const editor = new SessionAwareStubEditor();
        editor.setSessionContext("s1");
        editor.handlePaste(PART_A); // #1
        editor.setSessionContext(null); // 切走（缓存）
        editor.setText("");
        editor.setSessionContext("s1"); // 切回（restore counter = 1）
        editor.setText("[paste #1 +12 lines]");
        editor.handlePaste(PART_B); // 应为 #2（连续），不是 #3
        const text = editor.getText();
        expect(text).toContain("[paste #1");
        expect(text).toContain("[paste #2");
        expect(text).not.toContain("[paste #3");
    });
});
