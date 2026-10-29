/**
 * 路径显示格式化：home 缩写与按列宽的尾部截断。
 *
 * 与界面无关，供 TUI、命令行与 HTTP 前端共用（会话列表、状态栏、CLI 输出同一口径）。
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** 会话列表里目录列的默认可用列宽。 */
export const CWD_MAX = 20;

/** 尾部截断：保留末尾（目录名比前缀更有信息量），按显示列计算。 */
function truncateTail(text: string, columns: number): string {
    const flat = stripTerminalSequences(text);
    const width = visibleWidth(flat);
    if (width <= columns) return flat;
    const tail = sliceByColumn(flat, width - Math.max(0, columns - 1), Math.max(0, columns - 1), true);
    return `…${tail}`;
}

/** 按列宽截断路径：保留尾部，并尽量让断开点落在目录分隔符上（`…/src/zbot` 好过 `…rc/zbot`）。 */
export function truncatePath(text: string, columns: number): string {
    const tail = truncateTail(text, columns);
    if (!tail.startsWith("…")) return tail;
    const cut = tail.indexOf("/", 1);
    return cut > 0 ? `…${tail.slice(cut)}` : tail;
}

/** 路径缩写：home 前缀换成 `~`，超宽时保留尾部并在目录边界断开（`…/src/zbot`）。 */
export function abbreviatePath(path: string, home?: string, maxColumns = CWD_MAX): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (!trimmed) return "";
    const short = home && trimmed === home
        ? "~"
        : home && trimmed.startsWith(`${home}/`) ? `~${trimmed.slice(home.length)}` : trimmed;
    if (visibleWidth(short) <= maxColumns) return short;

    return truncatePath(short, maxColumns);
}
