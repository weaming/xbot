import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { eastAsianWidth } from "get-east-asian-width";

/** 提取指定位置的 ANSI 转义序列 */
function extractAnsi(str: string, pos: number): { code: string; length: number } | null {
    if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return null;
    const next = str[pos + 1];
    if (next === "[") {
        let j = pos + 2;
        while (j < str.length && !/[mGKHJ]/.test(str[j])) j++;
        if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
        return null;
    }
    if (next === "]") {
        let j = pos + 2;
        while (j < str.length) {
            if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
            if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
            j++;
        }
        return null;
    }
    return null;
}

function updateActiveAnsi(line: string, activeAnsi: string): string {
    let nextAnsi = activeAnsi;
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
        const parameters = match[1] ?? "0";
        if (parameters === "0" || parameters === "") {
            nextAnsi = "";
        } else {
            nextAnsi += match[0];
        }
    }
    return nextAnsi;
}

/** 单行快速硬换行（单遍扫描 O(N)，避免 O(N^2) 切片导致的卡顿）。 */
function wrapLineByColumns(line: string, width: number, activeAnsi = "", continuationIndent = 0): string[] {
    if (!line) return [activeAnsi];

    let isAsciiPrintable = true;
    let hasAnsi = false;
    for (let j = 0; j < line.length; j++) {
        const code = line.charCodeAt(j);
        if (code === 0x1b) hasAnsi = true;
        if (code < 0x20 || code > 0x7e) isAsciiPrintable = false;
    }

    if (isAsciiPrintable && !hasAnsi && !activeAnsi && continuationIndent === 0) {
        if (line.length <= width) return [line];
        const res: string[] = [];
        for (let j = 0; j < line.length; j += width) {
            res.push(line.slice(j, j + width));
        }
        return res;
    }

    const lines: string[] = [];
    let currentLine = activeAnsi;
    let currentCol = 0;
    let currentAnsi = activeAnsi;
    let currentLimit = width;
    let i = 0;

    while (i < line.length) {
        if (line.charCodeAt(i) === 0x1b) {
            const ansi = extractAnsi(line, i);
            if (ansi) {
                currentLine += ansi.code;
                currentAnsi = updateActiveAnsi(ansi.code, currentAnsi);
                i += ansi.length;
                continue;
            }
        }

        const charCode = line.charCodeAt(i);
        let charLen = 1;
        let charWidth = 1;

        if (charCode >= 0xd800 && charCode <= 0xdbff && i + 1 < line.length) {
            charLen = 2;
            const cp = line.codePointAt(i);
            charWidth = cp !== undefined ? eastAsianWidth(cp) : 1;
        } else if (charCode >= 0x80) {
            const cp = line.codePointAt(i);
            charWidth = cp !== undefined ? eastAsianWidth(cp) : 1;
        } else if (charCode < 0x20) {
            charWidth = charCode === 9 ? 3 : 0;
        }

        const charStr = line.slice(i, i + charLen);
        i += charLen;

        if (currentCol + charWidth > currentLimit && currentCol > 0) {
            lines.push(currentLine);
            const indentStr = continuationIndent > 0 ? " ".repeat(continuationIndent) : "";
            currentLine = indentStr + currentAnsi + charStr;
            currentCol = continuationIndent + charWidth;
            currentLimit = width;
        } else {
            currentLine += charStr;
            currentCol += charWidth;
        }
    }

    if (currentLine.length > 0 || lines.length === 0) {
        lines.push(currentLine);
    }
    return lines;
}

/** 以终端列为单位硬换行，保留压缩文本中的所有字符和 ANSI 样式。 */
export function wrapTextByColumns(text: string, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    let activeAnsi = "";
    const lines: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
        lines.push(...wrapLineByColumns(line, safeWidth, activeAnsi));
        activeAnsi = updateActiveAnsi(line, activeAnsi);
    }
    return lines;
}

/** 按代码内容列换行 diff 行，避免续行覆盖行号和增删标记。 */
export function wrapDiffTextByColumns(text: string, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    let activeAnsi = "";
    const lines: string[] = [];

    for (const line of text.split(/\r\n|\r|\n/)) {
        const continuationIndent = getDiffContinuationIndent(line);
        lines.push(...wrapLineByColumns(line, safeWidth, activeAnsi, continuationIndent));
        activeAnsi = updateActiveAnsi(line, activeAnsi);
    }

    return lines;
}

function getDiffContinuationIndent(line: string): number {
    const plainLine = stripTerminalSequences(line);
    const prefix = plainLine.match(/^(\s*\d+ (?:[+-] |  ))/)?.[1];
    return prefix ? visibleWidth(prefix) : 0;
}

export class ToolBlockText implements Component {
    private cachedText?: string;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(
        private readonly text: string,
        private readonly paddingX = 1,
        private readonly alignWrappedDiffLines = false,
    ) {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === safeWidth) {
            return this.cachedLines;
        }

        const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((safeWidth - 1) / 2)));
        const contentWidth = Math.max(1, safeWidth - paddingX * 2);
        const leftPadding = " ".repeat(paddingX);
        const wrap = this.alignWrappedDiffLines ? wrapDiffTextByColumns : wrapTextByColumns;
        const wrappedLines = wrap(this.text.replace(/\t/g, "   "), contentWidth);
        const lines = wrappedLines.map((line) => {
            const content = `${leftPadding}${line}${leftPadding}`;
            return content + " ".repeat(Math.max(0, safeWidth - visibleWidth(content)));
        });

        this.cachedText = this.text;
        this.cachedWidth = safeWidth;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}
