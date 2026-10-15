import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { UserQuestion, UserQuestionAnswer } from "../utils/user-question.js";
import { QuestionPanel } from "./question-panel.js";

const DOWN = "\x1b[B";
const ENTER = "\r";

/** 无空格长中文选项：折行断言不受空白折叠影响。 */
const LONG_LABEL = "把压缩边界改成按完整回合保留最近十二 k token 并且顺便把分词器换成真的那一个";
const LONG_DESCRIPTION = "说明文字同样要折行显示不要被省略号吞掉后半段";

function makePanel(
    questions: UserQuestion[],
    visibleRows = 14,
    initialAnswers?: (UserQuestionAnswer | null)[],
): { panel: QuestionPanel; answers: (UserQuestionAnswer | null)[]; calls: string[] } {
    const calls: string[] = [];
    const answers = initialAnswers ?? (questions.map(() => null) as (UserQuestionAnswer | null)[]);
    const panel = new QuestionPanel({
        questions,
        answers,
        visibleRows,
        submit: () => calls.push("submit"),
        cancel: () => calls.push("cancel"),
    });
    return { panel, answers, calls };
}

function renderLines(panel: QuestionPanel, width = 60): string[] {
    return panel.render(width).map(line => stripTerminalSequences(line));
}

/** 去掉全部空白：折行后拼回的正文与原文等价。 */
function squeeze(text: string): string {
    return text.replace(/\s+/g, "");
}

describe("提问面板行渲染", () => {
    test("超宽选项折行显示，无省略号且续行按前缀缩进", () => {
        const { panel } = makePanel([{
            header: "压缩",
            question: "保留多少尾部历史？",
            options: [{ label: LONG_LABEL, description: LONG_DESCRIPTION }],
        }]);
        const lines = renderLines(panel, 42);
        const optionStart = lines.findIndex(line => line.includes("❯ "));

        expect(optionStart).toBeGreaterThan(-1);
        expect(lines.join("\n")).not.toContain("…");
        expect(lines.every(line => visibleWidth(line) <= 42)).toBe(true);

        // 选中项折了多行，续行以「前缀等宽空格」开头（单选选项前缀 = 5 列：` ❯   `）
        const continuation = lines[optionStart + 1]!;
        expect(continuation.startsWith(" ".repeat(5))).toBe(true);

        const optionLines = [lines[optionStart]!, ...lines.slice(optionStart + 1).filter(line => line.startsWith(" ".repeat(5)))];
        expect(squeeze(optionLines.join(""))).toContain(squeeze(`${LONG_LABEL}${LONG_DESCRIPTION}`));
    });

    test("窗口跟随光标：折行后当前选项整块可见", () => {
        const options = Array.from({ length: 6 }, (_, index) => ({ label: `选项${index}：${"很长".repeat(30)}` }));
        const { panel } = makePanel([{ header: "压缩", question: "选哪个？", options }], 8);

        let lines = renderLines(panel, 40);
        expect(lines.join("\n")).toContain("选项0");

        panel.handleInput(DOWN);
        panel.handleInput(DOWN);
        lines = renderLines(panel, 40);

        expect(lines.join("\n")).toContain("选项2");
        expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
    });

    test("自填输入超长折行，光标落在可见行末尾", () => {
        const { panel } = makePanel([{ header: "备注", question: "要不要补充？", options: [{ label: "不用" }] }], 12);
        panel.handleInput(DOWN);
        panel.handleInput(ENTER);
        for (let index = 0; index < 60; index += 1) panel.handleInput("汉");

        const lines = renderLines(panel, 30);
        const cursorLine = lines.find(line => line.includes("▌"));

        expect(cursorLine).toBeDefined();
        expect(cursorLine!.endsWith("▌")).toBe(true);
        expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
    });

    test("折叠题目保持一行摘要，回到该题后自填答案完整折行回显", () => {
        const answer = "先按完整回合保留，实在装不下再按消息细切，切点不能拆开工具调用和它的结果";
        const { panel } = makePanel(
            [
                { header: "备注", question: "要不要补充？", options: [{ label: "不用" }] },
                { header: "确认", question: "还有别的吗？", options: [{ label: "没有" }] },
            ],
            14,
            [{ header: "备注", question: "要不要补充？", selected: [], custom: answer }, null],
        );

        const lines = renderLines(panel, 34);
        const folded = lines.find(line => line.includes("1."))!;

        // 折叠的题只占一行：超长答案用 … 收尾（回到该题即可看全）
        expect(folded.endsWith("…")).toBe(true);

        panel.handleInput("\x1b[D");
        const expanded = renderLines(panel, 34);

        expect(expanded.join("\n")).not.toContain("…");
        expect(squeeze(expanded.join(""))).toContain(squeeze(answer));
    });
});
