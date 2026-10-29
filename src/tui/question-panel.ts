/**
 * 用户提问浮层：`ask_user` 工具的界面，逐题作答（单选题回车即选定，多选题 Space 勾选）。
 *
 * 出口只有两个：全部答完（submit）与用户取消（cancel）——没有超时，
 * 用户不在时问题一直挂着（会话 tab 打 `?` 标记，切过去底部面板自动出现）。
 * 已作答的题存在宿主传入的 answers 里（共享引用）：面板被意外关掉再打开时据此回显进度。
 */

import { CURSOR_MARKER, Editor, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
    CUSTOM_ANSWER_PREFIX,
    CUSTOM_OPTION_LABEL,
    questionLabel,
    type UserQuestion,
    type UserQuestionAnswer,
} from "../utils/user-question.js";
import { parseWheelDelta } from "./panel-input.js";
import { padColumns, truncatePlain, wrapPlain } from "../format/text.js";
import { PasteAssembler } from "./paste-assembler.js";
import { editorTheme, theme } from "./theme.js";

/** 题干正文起始列：标题前缀恒为 ` 1/3 `（题数 ≤ 5），选项行的首个可见内容与之对齐。 */
const CONTENT_COLUMN = 5;
/** 勾选框宽度：多选是 `[x]`，单选不占列（正文直接落在 CONTENT_COLUMN）。 */
const CHECK_COLUMNS = 3;

/**
 * 行 = 固定列宽的前缀 + 截断后的正文。
 * 前缀必须独立于截断：truncatePlain 会 trim 掉前导空格，整行交给它截断时
 * 选中标记（`❯` / 空格）一变，同一列的正文就左右移位。
 */
function composeLine(width: number, prefix: string, content: string): string {
    return `${prefix}${truncatePlain(content, Math.max(1, width - visibleWidth(prefix)))}`;
}

/**
 * 行 = 固定列宽的前缀 + 折行后的正文（正文超宽时折成多行，续行按前缀宽度缩进，
 * 与底部输入框的软换行同构）。信息完整优先，面板行数多出来的部分交给窗口化。
 */
function composeLines(width: number, prefix: string, content: string): string[] {
    const prefixWidth = visibleWidth(prefix);
    return wrapPlain(content, Math.max(1, width - prefixWidth))
        .map((line, index) => (index === 0 ? prefix + line : " ".repeat(prefixWidth) + line));
}

/** 一道题的行块：光标行（相对块起始）供窗口化时保证可见。 */
interface QuestionBlock {
    lines: string[];
    cursorRow: number;
}

export interface QuestionPanelOptions {
    tui: TUI;
    /** 全部题目（1-5 道，按顺序作答）。 */
    questions: UserQuestion[];
    /** 逐题作答（与宿主共享引用：面板写入，宿主重开面板时据此回显）。 */
    answers: (UserQuestionAnswer | null)[];
    /** 一次最多显示的内容行数（由终端高度推算，超出窗口化）。 */
    visibleRows: number;
    /** 全部答完：宿主读取 answers 结算。 */
    submit(): void;
    /** 用户取消整次提问（不作答）。 */
    cancel(): void;
    /** 暂时收起面板以阅读对话，答案进度保留。 */
    collapse?(): void;
}

export class QuestionPanel implements Component {
    focused = false;
    /** 当前题号。 */
    private step = 0;
    /** 光标位置：0..options.length-1 为选项，options.length 为「其他（自己输入）」。 */
    private cursor = 0;
    /** 多选题已勾选的选项下标。 */
    private chosen = new Set<number>();
    /** 正在自填答案。 */
    private editing = false;
    private readonly inputEditor: Editor;
    private readonly pasteAssembler = new PasteAssembler();
    /** 行内提示（如「至少选一项」），下一次按键清除。 */
    private notice = "";

    constructor(private readonly options: QuestionPanelOptions) {
        this.inputEditor = new Editor(options.tui, editorTheme);
        this.step = firstUnanswered(options.answers);
        this.syncFromAnswer();
    }

    /** 独占键盘输入；未识别的按键被忽略，避免误落到输入框。 */
    handleInput(data: string): void {
        if (this.editing) {
            this.handleEditingInput(data);
            return;
        }

        this.notice = "";
        const wheel = parseWheelDelta(data);
        if (wheel !== undefined) {
            this.moveCursor(wheel > 0 ? 1 : -1);
            return;
        }
        if (matchesKey(data, Key.escape)) {
            if (this.options.collapse) this.options.collapse();
            else this.options.cancel();
            return;
        }
        if (matchesKey(data, Key.ctrl("c"))) {
            this.options.cancel();
            return;
        }
        if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
            this.goBack();
            return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
            this.moveCursor(-1);
            return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
            this.moveCursor(1);
            return;
        }

        const digit = /^[1-9]$/.exec(data);
        if (digit) {
            const index = Number.parseInt(digit[0], 10) - 1;
            if (index < this.options.questions[this.step]!.options.length) {
                this.cursor = index;
                this.confirm();
            }
            return;
        }
        if (matchesKey(data, Key.space)) {
            if (this.isMultiSelect()) this.toggleCursor();
            else this.confirm();
            return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
            this.confirm();
        }
    }

    render(width: number): string[] {
        const inner = Math.max(8, width);
        const budget = Math.max(1, this.options.visibleRows - 2);
        const blocks = this.options.questions.map((question, index) => this.renderQuestion(question, index, inner));
        const starts: number[] = [];
        let total = 0;
        for (const block of blocks) {
            starts.push(total);
            total += block.lines.length;
        }

        // 让当前题完整落在窗口里：能装下就尽量多带上下文，装不下就从该题开头截断；
        // 折行后当前题可能高于窗口，此时改为跟随光标行（选中项/自填输入必须可见）。
        const maxStart = Math.max(0, total - budget);
        const questionStart = starts[this.step] ?? 0;
        let start = Math.max(0, Math.min(questionStart, maxStart));
        const cursorRow = questionStart + (blocks[this.step]?.cursorRow ?? 0);
        if (cursorRow >= start + budget) start = Math.max(0, Math.min(cursorRow - budget + 1, maxStart));
        const body = blocks.flatMap(block => block.lines).slice(start, start + budget);
        return [this.renderHeader(inner), ...body, this.renderFooter(inner)];
    }

    invalidate(): void {
        // 面板内容全部即时生成，无缓存需要失效。
    }

    /** 自填态使用与对话输入框相同的编辑器处理光标、编辑和粘贴。 */
    private handleEditingInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.editing = false;
            return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
            const custom = this.inputEditor.getExpandedText().trim();
            this.editing = false;
            if (!custom) {
                this.notice = "没输入内容，已返回选项";
                return;
            }
            this.commit(this.selectedLabels(), custom);
            return;
        }
        if (matchesKey(data, Key.ctrl("c"))) {
            this.options.cancel();
            return;
        }
        for (const sequence of this.pasteAssembler.push(data)) {
            this.inputEditor.handleInput(sequence);
        }
    }

    /** 回车/数字键的落点：选项 -> 提交该题；「其他」-> 进入自填。 */
    private confirm(): void {
        const question = this.options.questions[this.step]!;
        if (this.cursor >= question.options.length) {
            this.editing = true;
            this.inputEditor.setText(this.options.answers[this.step]?.custom ?? this.inputEditor.getText());
            return;
        }
        if (question.multiSelect) {
            if (this.chosen.size === 0) {
                this.notice = "至少选一项（Space 勾选）";
                return;
            }
            this.commit(this.selectedLabels());
            return;
        }
        this.commit([question.options[this.cursor]!.label]);
    }

    /** 记录当前题的作答并前进：还有未答的题就跳过去，全答完则提交整次提问。 */
    private commit(selected: string[], custom?: string): void {
        const question = this.options.questions[this.step]!;
        this.options.answers[this.step] = {
            header: question.header,
            question: question.question,
            selected,
            ...(custom ? { custom } : {}),
        };

        const next = this.options.answers.findIndex((answer, index) => index > this.step && answer === null);
        if (next >= 0) {
            this.enterStep(next);
            return;
        }
        if (this.options.answers.every(answer => answer !== null)) {
            this.options.submit();
            return;
        }
        this.enterStep(firstUnanswered(this.options.answers));
    }

    private enterStep(index: number): void {
        this.step = index;
        this.cursor = 0;
        this.chosen = new Set();
        this.editing = false;
        this.inputEditor.setText("");
        this.notice = "";
        this.syncFromAnswer();
    }

    /** 回到已作答的题：把原有选择还原到光标与勾选态，便于改答案。 */
    private syncFromAnswer(): void {
        const answer = this.options.answers[this.step];
        if (!answer) return;

        const question = this.options.questions[this.step]!;
        question.options.forEach((option, index) => {
            if (answer.selected.includes(option.label)) this.chosen.add(index);
        });
        this.inputEditor.setText(answer.custom ?? "");
        if (this.chosen.size > 0) this.cursor = Math.max(...this.chosen);
        else if (answer.custom) this.cursor = question.options.length;
    }

    private goBack(): void {
        if (this.step === 0) {
            this.notice = "已经是第一题";
            return;
        }
        this.enterStep(this.step - 1);
    }

    private moveCursor(delta: number): void {
        const total = this.options.questions[this.step]!.options.length + 1;
        this.cursor = (this.cursor + delta + total) % total;
    }

    private toggleCursor(): void {
        const options = this.options.questions[this.step]!.options;
        if (this.cursor >= options.length) return;
        if (this.chosen.has(this.cursor)) this.chosen.delete(this.cursor);
        else this.chosen.add(this.cursor);
    }

    private selectedLabels(): string[] {
        const options = this.options.questions[this.step]!.options;
        return [...this.chosen].sort((left, right) => left - right).map(index => options[index]!.label);
    }

    private isMultiSelect(): boolean {
        return this.options.questions[this.step]!.multiSelect === true;
    }

    private renderHeader(width: number): string {
        const total = this.options.questions.length;
        return theme.statusWarn(truncatePlain(`❓ 提问 · ${this.step + 1}/${total}`, width));
    }

    /** 一道题的行块：当前题展开选项（超宽折行），其它题压缩成一行摘要。 */
    private renderQuestion(question: UserQuestion, index: number, width: number): QuestionBlock {
        if (index !== this.step) {
            const answer = this.options.answers[index];
            const summary = answer ? this.describeAnswer(answer) : "";
            const mark = answer ? "✓" : "·";
            const content = `${question.header || question.question}${summary ? ` → ${summary}` : ""}`;
            return { lines: [theme.dim(composeLine(width, ` ${mark} ${index + 1}. `, content))], cursorRow: 0 };
        }

        const lines = composeLines(width, this.titlePrefix(index), this.titleContent(question)).map(theme.commandText);
        if (this.editing) {
            const prefix = this.customPrefix(question, "❯");
            this.inputEditor.focused = this.focused;
            const inputLines = this.inputEditor.render(Math.max(1, width - visibleWidth(prefix))).slice(1, -1);
            const cursorLine = inputLines.findIndex(line => line.includes(CURSOR_MARKER));
            const cursorRow = lines.length + (cursorLine >= 0 ? cursorLine : inputLines.length - 1);
            lines.push(...inputLines.map(line => theme.statusOk(`${prefix}${line}`)));
            return { lines, cursorRow };
        }

        let cursorRow = lines.length;
        question.options.forEach((option, optionIndex) => {
            const cursorMark = optionIndex === this.cursor ? "❯" : " ";
            const checkMark = question.multiSelect ? (this.chosen.has(optionIndex) ? "[x]" : "[ ]") : "";
            const detail = option.description ? `  ${option.description}` : "";
            const prefix = this.optionPrefix(question, cursorMark, checkMark);
            if (optionIndex === this.cursor) cursorRow = lines.length;
            const optionLines = composeLines(width, prefix, `${option.label}${detail}`);
            lines.push(...optionLines.map(line => (optionIndex === this.cursor ? theme.toolSelected(line) : line)));
        });

        const onCustom = this.cursor >= question.options.length;
        const customText = this.options.answers[index]?.custom ?? this.inputEditor.getText();
        const customLines = composeLines(
            width,
            this.customPrefix(question, onCustom ? "❯" : " "),
            `${CUSTOM_OPTION_LABEL}${customText ? `：${customText}` : ""}`,
        );
        if (onCustom) cursorRow = lines.length;
        lines.push(...customLines.map(line => (onCustom ? theme.toolSelected(line) : line)));
        return { lines, cursorRow };
    }

    /**
     * 选项行前缀：标记列 + 对齐留白（多选再挂勾选框）。
     * 勾选框的 `[` 与题干首字同列，选项正文落在勾选框之后。
     */
    private optionPrefix(question: UserQuestion, mark: string, checkMark: string): string {
        const lead = this.markPrefix(mark);
        return question.multiSelect ? `${lead}${padColumns(checkMark, CHECK_COLUMNS)} ` : lead;
    }

    /** 「其他（自己输入）」行前缀：勾选列留空，`✎` 落在选项正文列。 */
    private customPrefix(question: UserQuestion, mark: string): string {
        const lead = this.markPrefix(mark);
        const check = question.multiSelect ? " ".repeat(CHECK_COLUMNS + 1) : "";
        return `${lead}${check}✎ `;
    }

    /** 标记列（` ❯ ` 或等宽空格）+ 留白，使后续内容落在 CONTENT_COLUMN。 */
    private markPrefix(mark: string): string {
        const markColumn = ` ${mark} `;
        return markColumn + " ".repeat(CONTENT_COLUMN - visibleWidth(markColumn));
    }

    /** 当前题的标题前缀：`2/3 `。 */
    private titlePrefix(index: number): string {
        return ` ${index + 1}/${this.options.questions.length} `;
    }

    /** 当前题的标题正文：`通知渠道 · 要不要顺手通知团队？（多选）`。 */
    private titleContent(question: UserQuestion): string {
        const tag = question.multiSelect ? "（多选）" : "";
        return `${questionLabel(question)}${tag}`;
    }

    private describeAnswer(answer: UserQuestionAnswer): string {
        return [...answer.selected, ...(answer.custom ? [`${CUSTOM_ANSWER_PREFIX}${answer.custom}`] : [])].join("、");
    }

    private renderFooter(width: number): string {
        const keys = this.editing
            ? "Enter 提交 · Esc 返回选项 · ⌃C 取消"
            : [
                this.isMultiSelect() ? "Space 勾选" : "",
                "↑↓ 选择",
                "Enter 确认",
                this.step > 0 ? "← 上一题" : "",
                this.options.collapse ? "Esc 阅读正文" : "Esc 取消",
                "⌃C 取消",
            ].filter(Boolean).join(" · ");
        const text = this.notice ? `${this.notice} · ${keys}` : keys;
        const plain = truncatePlain(text, width);
        return this.notice && plain.startsWith(this.notice)
            ? `${theme.statusWarn(this.notice)}${theme.dim(plain.slice(this.notice.length))}`
            : theme.dim(plain);
    }
}

/** 第一道未作答的题号；全答完时回到第一题（宿主随即会 submit）。 */
function firstUnanswered(answers: (UserQuestionAnswer | null)[]): number {
    const index = answers.findIndex(answer => answer === null);
    return index >= 0 ? index : 0;
}
