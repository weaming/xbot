/**
 * 纯文本与列宽工具：折为单行、按可见列宽截断/折行/补白。
 *
 * 与界面无关，供 TUI、命令行与 HTTP 前端共用。依赖 pi-tui 只为显示宽度计算
 * （宽字符/emoji 两列），不引入任何渲染逻辑。
 *
 * 注意：不要用 truncateToWidth 替代 truncatePlain——它会在省略号前后插入 ANSI 复位码，
 * 破坏浮层面板底色。例外：已经着色、又必须保留颜色的一行（会话面板标题行与 footer），
 * 改用 truncateToWidth（见 session-panel.ts 的 TextLine），底色由浮层统一补回。
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** 折单行并截断到 maxColumns 可见列，超出部分用 … 收尾。 */
export function truncatePlain(text: string, maxColumns: number): string {
    const flat = stripTerminalSequences(text).replace(/\s+/g, " ").trim();
    if (visibleWidth(flat) <= maxColumns) return flat;
    return `${sliceByColumn(flat, 0, Math.max(0, maxColumns - 1), true)}…`;
}

/**
 * 折单行后按可见列宽折成多行（优先在空白处断，长词按字符拆，宽字符按列宽计）。
 * 纯文本输入下 wrapTextWithAnsi 不会插入 ANSI，与 truncatePlain 同口径。
 */
export function wrapPlain(text: string, maxColumns: number): string[] {
    const flat = stripTerminalSequences(text).replace(/\s+/g, " ").trim();
    if (!flat) return [""];
    return wrapTextWithAnsi(flat, Math.max(1, maxColumns));
}

/** 按可见列宽右补空格（对齐键位列，中文/emoji 宽度不一致时仍对齐）。 */
export function padColumns(text: string, columns: number): string {
    const width = visibleWidth(text);
    return width >= columns ? text : text + " ".repeat(columns - width);
}
