/**
 * PanelStack 的输入路由语义：拦截优先、滚轮下沉、其余归最上层。
 * 这些断言是重构前散落在 app.ts 各分支里的行为，现在集中在一处验证。
 */

import { describe, expect, test } from "bun:test";
import { PanelStack, type PanelLayer } from "../../src/tui/panel-stack.js";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

/** 与生产代码一致：翻页键与滚轮交给视口。 */
function isScrollInput(data: string): boolean {
    return data === PAGE_UP || data === PAGE_DOWN || data.startsWith("\x1b[<");
}

function makePanel() {
    const received: string[] = [];
    return {
        received,
        panel: { handleInput: (data: string) => received.push(data) },
    };
}

function makeStack(): PanelStack {
    return new PanelStack(isScrollInput);
}

describe("PanelStack 基本栈操作", () => {
    test("空栈不路由任何输入", () => {
        const stack = makeStack();
        expect(stack.routeInput("a")).toBe(false);
        expect(stack.isEmpty).toBe(true);
    });

    test("压栈后输入交给最上层", () => {
        const stack = makeStack();
        const lower = makePanel();
        const upper = makePanel();
        stack.push({ kind: "question", panel: lower.panel });
        stack.push({ kind: "shortcut", panel: upper.panel });

        expect(stack.routeInput("x")).toBe(true);
        expect(upper.received).toEqual(["x"]);
        expect(lower.received).toEqual([]);
    });

    test("同种面板至多一份：重复压入会先移除旧层并触发其关闭动作", () => {
        const stack = makeStack();
        const closings: string[] = [];
        const first = makePanel();
        const second = makePanel();

        stack.push({ kind: "session", panel: first.panel, onClose: () => closings.push("first") });
        stack.push({ kind: "session", panel: second.panel, onClose: () => closings.push("second") });

        expect(stack.depth).toBe(1);
        expect(closings).toEqual(["first"]);
        expect(stack.find("session")?.panel).toBe(second.panel);
    });

    test("pop 执行关闭动作并露出下一层", () => {
        const stack = makeStack();
        const lower = makePanel();
        const upper = makePanel();
        const closings: string[] = [];
        stack.push({ kind: "question", panel: lower.panel });
        stack.push({ kind: "model", panel: upper.panel, onClose: () => closings.push("model") });

        stack.pop();
        expect(closings).toEqual(["model"]);
        expect(stack.routeInput("y")).toBe(true);
        expect(lower.received).toEqual(["y"]);
    });

    test("remove 可移除中间层，打乱顺序也能删干净", () => {
        const stack = makeStack();
        const closings: string[] = [];
        stack.push({ kind: "session", panel: makePanel().panel, onClose: () => closings.push("session") });
        stack.push({ kind: "question", panel: makePanel().panel, onClose: () => closings.push("question") });

        stack.remove("session");
        expect(closings).toEqual(["session"]);
        expect(stack.has("session")).toBe(false);
        expect(stack.has("question")).toBe(true);
        expect(stack.depth).toBe(1);
    });

    test("clear 逐层关闭，不留残留", () => {
        const stack = makeStack();
        const closings: string[] = [];
        stack.push({ kind: "session", panel: makePanel().panel, onClose: () => closings.push("session") });
        stack.push({ kind: "question", panel: makePanel().panel, onClose: () => closings.push("question") });

        stack.clear();
        // 自顶向下关闭
        expect(closings).toEqual(["question", "session"]);
        expect(stack.isEmpty).toBe(true);
    });
});

describe("PanelStack 输入路由", () => {
    test("滚轮与翻页不交给面板，返回 false 让视口滚动", () => {
        const stack = makeStack();
        const { received, panel } = makePanel();
        stack.push({ kind: "session", panel });

        expect(stack.routeInput(PAGE_DOWN)).toBe(false);
        expect(stack.routeInput("\x1b[<64;10;5M")).toBe(false);
        expect(received).toEqual([]);
    });

    test("拦截声明优先于最上层：从栈顶向下查找", () => {
        const stack = makeStack();
        const consumed: string[] = [];
        const top = makePanel();

        stack.push({
            kind: "question",
            panel: makePanel().panel,
            intercept: (data) => {
                if (data !== "\x11") return false; // ⌃⇧Q
                consumed.push("collapse");
                return true;
            },
        });
        stack.push({ kind: "model", panel: top.panel });

        expect(stack.routeInput("\x11")).toBe(true);
        expect(consumed).toEqual(["collapse"]);
        expect(top.received).toEqual([]);
    });

    test("顶层未声明拦截时，普通输入仍归顶层", () => {
        const stack = makeStack();
        const top = makePanel();
        stack.push({ kind: "question", panel: makePanel().panel, intercept: () => false });
        stack.push({ kind: "model", panel: top.panel });

        expect(stack.routeInput("z")).toBe(true);
        expect(top.received).toEqual(["z"]);
    });

    test("拦截层不消费时返回 false 的语义不污染普通路由", () => {
        const stack = makeStack();
        const top = makePanel();
        let checks = 0;
        stack.push({
            kind: "question",
            panel: makePanel().panel,
            intercept: () => { checks += 1; return false; },
        });
        stack.push({ kind: "shortcut", panel: top.panel });

        stack.routeInput("q");
        expect(checks).toBe(1);
        expect(top.received).toEqual(["q"]);
    });
});
