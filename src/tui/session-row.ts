/**
 * 会话面板列表行：整批统一列宽 + 按优先级裁剪，纯函数便于单测。
 * 列宽一律按 visibleWidth（显示列）计算，中文/emoji 不会错位。
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { truncatePlain } from "./panel-text.js";

/** 选中指针 `→ `。 */
const POINTER_WIDTH = 2;
/** 状态标记与标题之间的间隔。 */
const MARKER_WIDTH = 1;
const MARKER_GAP = 1;
/** 列间距。 */
const GAP = 2;
/** 标题自然宽度的上下限：太窄读不出内容，太宽把副列挤到屏幕边缘。 */
const TITLE_MIN = 12;
const TITLE_MAX = 40;
/** 标题列的绝对下限：窄屏也要留几个字，便于认出是哪个会话。 */
const TITLE_FLOOR = 8;
/** 状态列最小保留宽度：低于它就不显示状态，免得只留下一串省略号。 */
const STATUS_MIN = 8;
/** 状态列短于此宽度就不画：宁可少一列，也不要只剩一个省略号。 */
const STATUS_FLOOR = 6;
/** 工作目录列宽上限：够看清 `~/src/infra/deploy` 这种两级路径，再长就尾部省略。 */
const CWD_MAX = 20;
/** 工作目录列宽下限：再窄就只够看半截目录名，不如整列不显示。 */
const CWD_MIN = 10;
/** 状态列理想宽度：留够"本实例 · 等待 2"，目录列按剩余空间让位。 */
const STATUS_PREF = 16;

export interface SessionRow {
    /** 状态标记（●○◐◎◌✕?），单列宽。 */
    marker: string;
    /** 已折为单行的标题。 */
    title: string;
    /** 轮数文本（如 `12轮`）；0 轮也占位，保证副列起点一致。 */
    rounds: string;
    /** 相对时间文本（如 `3小时前`）。 */
    time: string;
    /** 已缩写的工作目录（`~` / `…/` 形式）。 */
    cwd?: string;
    /** 归属与状态标签：`本实例 · 等待 2` / `运行中` / `已归档`。 */
    status?: string;
}

/** 整批行共享的列宽：同一列在所有行上起点一致，视觉上成表。 */
export interface SessionRowPlan {
    title: number;
    rounds: number;
    time: number;
    /** 目录列宽；0 表示本批不显示目录列。 */
    cwd: number;
    /** 状态列可用宽度（吃剩余空间）；0 表示不显示状态列。 */
    status: number;
}

function maxWidth(texts: Iterable<string>): number {
    let width = 0;
    for (const text of texts) width = Math.max(width, visibleWidth(text));
    return width;
}

function padRight(text: string, columns: number): string {
    const width = visibleWidth(text);
    return width >= columns ? text : text + " ".repeat(columns - width);
}

function padLeft(text: string, columns: number): string {
    const width = visibleWidth(text);
    return width >= columns ? text : " ".repeat(columns - width) + text;
}

/**
 * 规划整批行的列宽，优先级：标题 > 轮数/时间 > 状态 > 工作目录。
 * 标题取本批自然宽度（不拉满），状态列吃剩余；宽度不足时先丢目录再压标题。
 * 返回的列宽只与「本批数据 + 可用宽度」有关，滚动或换行不会让列宽跳动。
 */
export function planSessionRows(rows: SessionRow[], width: number): SessionRowPlan {
    const rounds = maxWidth(rows.map(row => row.rounds));
    const time = maxWidth(rows.map(row => row.time));
    const hasStatus = rows.some(row => row.status);
    const cwdWanted = rows.some(row => row.cwd) ? maxWidth(rows.map(row => row.cwd ?? "")) : 0;
    const titleWanted = Math.max(TITLE_MIN, Math.min(TITLE_MAX, maxWidth(rows.map(row => row.title))));
    const statusPref = hasStatus ? Math.min(STATUS_PREF, maxWidth(rows.map(row => row.status ?? ""))) : 0;

    const prefix = POINTER_WIDTH + MARKER_WIDTH + MARKER_GAP;
    const gaps = (columns: number): number => GAP * (columns - 1);
    /** 不含标题与目录的固定列宽（含列间距）。 */
    const fixedWidth = (hasCwd: boolean): number =>
        prefix + gaps(3 + (hasCwd ? 1 : 0) + (hasStatus ? 1 : 0)) + rounds + time;
    const statusReserve = hasStatus ? Math.max(STATUS_MIN, statusPref) : 0;

    // 工作目录优先级最低：先按剩余空间收缩，低于下限就整列丢弃
    let cwd = Math.min(CWD_MAX, cwdWanted);
    if (cwd > 0) {
        const room = width - fixedWidth(true) - titleWanted - statusReserve;
        cwd = Math.min(cwd, Math.max(0, room));
        if (cwd < CWD_MIN) cwd = 0;
    }
    const base = fixedWidth(cwd > 0) + cwd;

    // 标题优先：只给状态预留最小宽度，剩余不足时才压缩标题
    const title = Math.max(TITLE_FLOOR, Math.min(titleWanted, width - base - (hasStatus ? STATUS_MIN : 0)));
    const rawStatus = hasStatus ? Math.max(0, width - base - title) : 0;
    // 与渲染层的状态下限保持一致，避免留下"算了但没画"的空列
    const status = rawStatus >= STATUS_FLOOR ? rawStatus : 0;
    return { title, rounds, time, cwd, status };
}

/** 尾部截断：保留末尾（目录名比前缀更有信息量），按显示列计算。 */
function truncateTail(text: string, columns: number): string {
    const flat = stripTerminalSequences(text);
    const width = visibleWidth(flat);
    if (width <= columns) return flat;
    const tail = sliceByColumn(flat, width - Math.max(0, columns - 1), Math.max(0, columns - 1), true);
    return `…${tail}`;
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

/** 按列宽截断路径：保留尾部，并尽量让断开点落在目录分隔符上（`…/src/zbot` 好过 `…rc/zbot`）。 */
function truncatePath(text: string, columns: number): string {
    const tail = truncateTail(text, columns);
    if (!tail.startsWith("…")) return tail;
    const cut = tail.indexOf("/", 1);
    return cut > 0 ? `…${tail.slice(cut)}` : tail;
}

/**
 * 渲染一行并切成两段：`head`（指针 + 标记 + 标题列，含补白）与 `detail`（副列）。
 * 分段是为了让面板分别着色：标题保持默认色、副列置灰、选中行整行高亮。
 */
export function composeSessionRow(
    row: SessionRow,
    plan: SessionRowPlan,
    width: number,
    isSelected = false,
): { head: string; detail: string } {
    const pointer = isSelected ? "→ " : "  ";
    // 标题从尾部截断（保留开头），只有目录用尾部截断（目录名更有信息量）
    let head = `${pointer}${row.marker} `;
    head += padRight(truncatePlain(row.title, plan.title), plan.title);

    const headWidth = visibleWidth(head);
    if (headWidth >= width) return { head: sliceByColumn(head, 0, width, true), detail: "" };

    // 列按优先级保留：宽度不足时从低优先级整列丢弃（目录 → 时间 → 轮数），不硬切半个时间
    const budget = width - headWidth;
    let hasCwd = plan.cwd > 0;
    let hasTime = true;
    let hasRounds = true;
    const detailWidth = (): number => {
        const cells = [hasRounds ? plan.rounds : 0, hasTime ? plan.time : 0, hasCwd ? plan.cwd : 0];
        const used = cells.filter(width => width > 0);
        return used.reduce((sum, width) => sum + width, 0) + GAP * used.length;
    };
    if (detailWidth() > budget) hasCwd = false;
    if (detailWidth() > budget) hasTime = false;
    if (detailWidth() > budget) hasRounds = false;

    let detail = "";
    if (hasRounds) detail += " ".repeat(GAP) + padLeft(row.rounds, plan.rounds);
    if (hasTime) detail += " ".repeat(GAP) + padRight(row.time, plan.time);
    if (hasCwd) {
        // 没有目录的会话用空白占位：否则后面的状态列会左移，整批列对不齐
        detail += " ".repeat(GAP) + padRight(row.cwd ? truncatePath(row.cwd, plan.cwd) : "", plan.cwd);
    }
    if (plan.status > 0 && row.status) {
        const remaining = width - headWidth - visibleWidth(detail) - GAP;
        if (remaining >= STATUS_FLOOR) detail += " ".repeat(GAP) + truncatePlain(row.status, remaining);
    }
    return { head, detail };
}
