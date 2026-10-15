/**
 * 提问浮层：逐题作答、多选、自填、返回上一题、取消、窗口化。
 * 键序列用真实转义序列（\x1b[A 等），与 TUI 里收到的一致。
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionPanel } from "../../src/tui/question-panel.js";
import type { UserQuestion, UserQuestionAnswer } from "../../src/utils/user-question.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ENTER = "\r";
const SPACE = " ";
const ESC = "\x1b";
const CTRL_C = "\x03";
const BACKSPACE = "\x7f";

/** 去掉 CSI 颜色序列，只看可见文本。 */
function plain(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 某段文本在行内的起始可见列（0-based）。 */
function columnOf(line: string, needle: string): number {
    return visibleWidth(line.slice(0, line.indexOf(needle)));
}

function question(overrides: Partial<UserQuestion> = {}): UserQuestion {
    return {
        header: "部署方式",
        question: "这次部署走哪条路？",
        options: [{ label: "方案 A" }, { label: "方案 B" }],
        ...overrides,
    };
}

function harness(questions: UserQuestion[], visibleRows = 20, answers: (UserQuestionAnswer | null)[] = []) {
    const state = {
        answers: answers.length > 0 ? answers : questions.map(() => null),
        submitted: 0,
        cancelled: 0,
        payload: [] as UserQuestionAnswer[],
    };
    const panel = new QuestionPanel({
        questions,
        answers: state.answers,
        visibleRows,
        submit: () => {
            state.submitted += 1;
            state.payload = state.answers.filter((answer): answer is UserQuestionAnswer => answer !== null);
        },
        cancel: () => {
            state.cancelled += 1;
        },
    });

    return {
        state,
        panel,
        press: (...keys: string[]) => keys.forEach(key => panel.handleInput(key)),
        lines: (width = 60) => {
            const rendered = panel.render(width).map(plain);
            return { rendered, text: rendered.join("\n") };
        },
    };
}

describe("提问浮层 · 单选", () => {
    test("首帧展示题干与选项，光标在第一项", () => {
        const { lines } = harness([question()]);

        const { rendered, text } = lines();
        expect(text).toContain("❓ 提问 · 1/1");
        expect(text).toContain("这次部署走哪条路？");
        expect(rendered.some(line => line.includes("❯") && line.includes("方案 A"))).toBe(true);
        expect(rendered.some(line => line.includes("✎ 其他（自己输入）"))).toBe(true);
        expect(text).toContain("Esc 取消");
    });

    test("回车即选定当前项，单题答完直接提交", () => {
        const { state, press } = harness([question()]);

        press(ENTER);
        expect(state.answers[0]!.selected).toEqual(["方案 A"]);
        expect(state.submitted).toBe(1);
        expect(state.payload[0]!.question).toBe("这次部署走哪条路？");
    });

    test("↓ 移动光标、数字键直选", () => {
        const first = harness([question()]);
        first.press(DOWN, ENTER);
        expect(first.state.answers[0]!.selected).toEqual(["方案 B"]);

        const second = harness([question()]);
        second.press("2");
        expect(second.state.answers[0]!.selected).toEqual(["方案 B"]);
    });
});

describe("提问浮层 · 多选", () => {
    const multi = question({ multiSelect: true, options: [{ label: "邮件" }, { label: "Slack" }, { label: "短信" }] });

    test("Space 勾选多项后回车提交", () => {
        const { state, press } = harness([multi]);

        press(SPACE, DOWN, SPACE, ENTER);
        expect(state.answers[0]!.selected).toEqual(["邮件", "Slack"]);
    });

    test("一项没勾就回车：留在本题并提示", () => {
        const { state, press, lines } = harness([multi]);

        press(ENTER);
        expect(state.answers[0]).toBeNull();
        expect(state.submitted).toBe(0);
        expect(lines().text).toContain("至少选一项");
        expect(lines().text).toContain("Space 勾选");
    });
});

describe("提问浮层 · 自己输入", () => {
    test("选「其他」进入自填，回车写入 custom", () => {
        const { state, press, lines } = harness([question()]);

        press(DOWN, DOWN, ENTER);
        expect(lines().text).toContain("✎");
        press("e", "c", "h", "o", " ", "h", "i", ENTER);
        expect(state.answers[0]!.custom).toBe("echo hi");
        expect(state.answers[0]!.selected).toEqual([]);
        expect(state.submitted).toBe(1);
    });

    test("自填态退格与清空；空内容回车退回选项", () => {
        const { state, press } = harness([question()]);

        press(DOWN, DOWN, ENTER, "a", "b", BACKSPACE, "c", ENTER);
        expect(state.answers[0]!.custom).toBe("ac");

        const empty = harness([question()]);
        empty.press(DOWN, DOWN, ENTER, ENTER);
        expect(empty.state.answers[0]).toBeNull();
        expect(empty.lines().text).toContain("没输入内容");
    });

    test("自填态 Esc 返回选项（不取消整次提问）", () => {
        const { state, press } = harness([question()]);

        press(DOWN, DOWN, ENTER, ESC);
        expect(state.cancelled).toBe(0);
        expect(state.answers[0]).toBeNull();
        // 回到选项列表（光标仍停在「其他」行），数字键直选第一项
        press("1");
        expect(state.answers[0]!.selected).toEqual(["方案 A"]);
    });
});

describe("提问浮层 · 前缀对齐", () => {
    test("切换选项时正文列不移动：标记列固定占位", () => {
        const { press, lines } = harness([question()]);
        const labelColumns = () => lines().rendered
            .filter(line => line.includes("方案"))
            .map(line => columnOf(line, "方案"));

        expect(labelColumns()).toEqual([5, 5]);
        press(DOWN);
        expect(labelColumns()).toEqual([5, 5]);
    });

    test("标题保留前导缩进，不被截断逻辑吃掉", () => {
        const { lines } = harness([question()]);

        expect(lines().rendered[1]!.startsWith(" 1/1 ")).toBe(true);
    });

    test("单选：选项正文与「其他」行的 ✎ 同列", () => {
        const { lines } = harness([question()]);
        const rendered = lines().rendered;

        expect(columnOf(rendered.find(line => line.includes("方案 A"))!, "方案")).toBe(5);
        expect(columnOf(rendered.find(line => line.includes("其他"))!, "✎")).toBe(5);
    });

    test("多选：勾选框与题干首字同列，正文与「其他」行的 ✎ 仍同列", () => {
        const multi = question({ multiSelect: true, options: [{ label: "邮件" }, { label: "Slack" }] });
        const { lines } = harness([multi]);
        const rendered = lines().rendered;

        expect(columnOf(rendered[1]!, "部署方式")).toBe(5);
        expect(columnOf(rendered.find(line => line.includes("邮件"))!, "[")).toBe(5);
        expect(columnOf(rendered.find(line => line.includes("邮件"))!, "邮件")).toBe(9);
        expect(columnOf(rendered.find(line => line.includes("Slack"))!, "Slack")).toBe(9);
        expect(columnOf(rendered.find(line => line.includes("其他"))!, "✎")).toBe(9);
    });

    test("窄宽度下正文折行，前缀原样保留且续行按前缀缩进", () => {
        const label = "很长的方案名称".repeat(6);
        const long = question({ options: [{ label }] });
        const { lines } = harness([long]);
        const rendered = lines(30).rendered;
        const start = rendered.findIndex(line => line.includes("❯"));
        const optionLines = [rendered[start]!];
        for (const line of rendered.slice(start + 1)) {
            if (!plain(line).startsWith(" ".repeat(5)) || plain(line).includes("✎")) break;
            optionLines.push(line);
        }

        expect(rendered[start]!.startsWith(" ❯   ")).toBe(true);
        expect(rendered.every(line => visibleWidth(line) <= 30)).toBe(true);
        expect(optionLines.map(line => plain(line).slice(5)).join("")).toBe(label);
    });
});

describe("提问浮层 · 多题与回退", () => {
    const questions = [
        question(),
        question({ header: "通知", question: "要不要通知团队？" }),
    ];

    test("答完一题自动进入下一题，全答完提交", () => {
        const { state, press, lines } = harness(questions);

        press(ENTER);
        expect(state.answers[0]!.selected).toEqual(["方案 A"]);
        expect(lines().text).toContain("❓ 提问 · 2/2");
        press(ENTER);
        expect(state.submitted).toBe(1);
        expect(state.payload).toHaveLength(2);
    });

    test("← 回到上一题改答案（回显原选择）", () => {
        const { state, press, lines } = harness(questions);

        press(ENTER, LEFT);
        expect(lines().text).toContain("❓ 提问 · 1/2");
        // 回显：第一题已选「方案 A」，光标停在该项
        press(DOWN, ENTER);
        expect(state.answers[0]!.selected).toEqual(["方案 B"]);
        // 已经答过的第二题不会被重置，补齐下一题后提交
        press(ENTER);
        expect(state.submitted).toBe(1);
        expect(state.payload[0]!.selected).toEqual(["方案 B"]);
    });

    test("第一题再按 ← 只提示，不越界", () => {
        const { press, lines } = harness(questions);

        press(LEFT);
        expect(lines().text).toContain("已经是第一题");
    });
});

describe("提问浮层 · 取消与窗口化", () => {
    test("Esc / ⌃C 都按「取消整次提问」结算，且只结算一次", () => {
        const escaped = harness([question()]);
        escaped.press(ESC);
        expect(escaped.state.cancelled).toBe(1);
        expect(escaped.state.submitted).toBe(0);

        const ctrlC = harness([question()]);
        ctrlC.press(CTRL_C);
        expect(ctrlC.state.cancelled).toBe(1);
    });

    test("内容超高时窗口跟随当前题，且始终保留标题与页脚", () => {
        const many = Array.from({ length: 5 }, (_, index) => question({ header: `第 ${index + 1} 问` }));
        const { press, lines, panel } = harness(many, 6);

        // 逐题作答走到最后一题
        for (let index = 0; index < 4; index += 1) press(ENTER);
        expect(lines().text).toContain("❓ 提问 · 5/5");

        const rendered = panel.render(60).map(plain);
        expect(rendered).toHaveLength(6);
        expect(plain(rendered[0]!)).toContain("❓ 提问");
        expect(plain(rendered[rendered.length - 1]!)).toContain("Esc 取消");
        expect(rendered.some(line => line.includes("这次部署走哪条路？"))).toBe(true);
    });
});
