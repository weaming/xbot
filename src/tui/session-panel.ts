/**
 * 会话面板：居中浮层，模糊搜索 + 切换 / 重命名 / 删除 / 归档。
 * 面板打开时独占键盘输入（由 ChatApp 的全局输入监听转交），Esc 或 Ctrl+C 关闭。
 *
 * 列表行自行渲染（不用 SelectList）：会话行有固定列（轮数 / 时间 / 工作目录 / 状态），
 * 只有整批统一列宽才能对齐；列宽规划与单行拼装见 session-row.ts。
 */

import {
    decodeKittyPrintable,
    fuzzyFilter,
    Key,
    matchesKey,
    sliceByColumn,
    stripTerminalSequences,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { handlePanelScroll } from "./panel-scroll.js";
import { padColumns, truncatePlain } from "../format/text.js";
import { abbreviatePath } from "../format/path.js";
import { composeSessionRow, planSessionRows, type SessionRow } from "./session-row.js";
import { DEFAULT_SPINNER, sessionMarker, type SessionOwnerState } from "./session-marker.js";
import { selectListTheme, theme } from "./theme.js";
import { formatRelativeTime } from "../utils/time.js";

/** 面板列表一次最多显示的行数（超出滚动）。 */
const MAX_VISIBLE = 10;
/** 删除确认窗口：窗口内再按一次 ⌃X 才真正删除。 */
const REMOVE_CONFIRM_MS = 2_000;
/** 搜索框提示符与光标。 */
const SEARCH_PROMPT = "🔍 ";
const CURSOR = "▏";
/** 面板内容左侧留白（与 header / footer 对齐）。 */
const LEFT_PAD = " ";

export interface SessionPanelItem {
    sessionId: string;
    title?: string;
    /** 会话绑定的工作目录：多仓库并行时靠它区分同名会话。 */
    cwd?: string;
    messageCount: number;
    lastUserMessage?: string;
    updatedAt?: string;
    archived?: boolean;
    busy: boolean;
    active: boolean;
    /** 会话挂着未作答的提问：主列标记显示 `?`（优先于运行中）。 */
    question?: boolean;
    /** 归属状态：决定主列标记（本实例 ●○◐ / 他实例 ◎ / 未认领 ◌）。 */
    ownerState?: SessionOwnerState;
    /** 归属描述（本实例 · 等待 N / PID x · 忙 · 处理中 N / 未认领）：面板是唯一的认领入口，必须看得见。 */
    owner?: string;
}

export interface SessionPanelActions {
    select(sessionId: string): void;
    rename(sessionId: string): void;
    remove(sessionId: string): void;
    archive(sessionId: string): void;
    unarchive(sessionId: string): void;
    close(): void;
}

export interface SessionPanelOptions {
    /** 二次确认窗口（ms），默认 REMOVE_CONFIRM_MS；测试可缩短。 */
    confirmMs?: number;
    /** 初始 spinner 帧；打开面板后由 ChatApp 每帧同步。 */
    spinner?: string;
    /** 确认窗口到期后请求重绘，避免 footer 提示残留（由 ChatApp 注入）。 */
    requestRender?: () => void;
    /** home 目录：cwd 缩写为 `~/…`；缺省读环境变量 HOME。 */
    home?: string;
}

/** 标题折为单行：标题来自用户输入，先剥掉控制序列再交给渲染。 */
function flattenTitle(item: SessionPanelItem): string {
    return stripTerminalSequences(item.title ?? "").replace(/\s+/g, " ").trim();
}

export class SessionPanel implements Component {
    private readonly header = new TextLine();
    private readonly search = new TextLine();
    private readonly footer = new TextLine();
    private items: SessionPanelItem[];
    private spinner: string;
    private matched: SessionPanelItem[] = [];
    private cursor = 0;
    /**
     * 选中会话的 id：列表重排（归档 / 取消归档 / 更新时间变化）后按 id 重新定位，
     * 否则光标停在旧索引上，用户会突然选中另一个会话。
     */
    private selectedId: string | null = null;
    private query = "";
    /** 删除确认：首次按 ⌃X 记录会话与时间，窗口内再按一次才执行。 */
    private pendingRemove: { sessionId: string; armedAt: number } | null = null;
    /** 归档确认：归档会把会话移出会话条，同样要求窗口内再按一次 ⌃A。 */
    private pendingArchive: { sessionId: string; armedAt: number } | null = null;
    /** 确认窗口到期定时器：到期后清空待确认状态并重绘。 */
    private confirmTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        items: SessionPanelItem[],
        private readonly actions: SessionPanelActions,
        private readonly options: SessionPanelOptions = {},
    ) {
        this.items = items;
        this.spinner = options.spinner ?? DEFAULT_SPINNER;
        this.rebuild();
    }

    /**
     * 同步最新会话状态与 spinner 帧：面板打开期间 busy/active/archived 会变化，
     * 只比较关键字段，避免每帧无谓重建列表。
     */
    updateItems(items: SessionPanelItem[], spinner: string): void {
        if (spinner === this.spinner && sameItems(this.items, items)) return;
        this.spinner = spinner;
        this.items = items;
        this.rebuild();
    }

    /** 面板关闭时清理确认定时器。 */
    dispose(): void {
        this.clearPendingConfirm();
    }

    /** 独占键盘输入；未识别的按键被忽略，避免误落到输入框。 */
    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.actions.close();
            return;
        }
        if (matchesKey(data, Key.ctrl("r"))) {
            this.clearPendingConfirm();
            return this.actOnSelected(this.actions.rename);
        }
        if (matchesKey(data, Key.ctrl("x"))) {
            // 只清归档待确认：删除自身的二次确认需要保留
            this.pendingArchive = null;
            return this.actOnSelected((sessionId) => this.requestRemove(sessionId));
        }
        if (matchesKey(data, Key.ctrl("a"))) {
            // 只清删除待确认：归档自身的二次确认需要保留（见 requestArchive）
            this.pendingRemove = null;
            // 取消归档是异步的，落地前先重绘一次，footer 才不会留着"再按 ⌃X 确认删除"
            this.invalidate();
            const item = this.matched[this.cursor];
            if (!item) return;
            // 取消归档可逆，无需二次确认；归档会把会话移出会话条，仍需确认
            if (item.archived) this.actions.unarchive(item.sessionId);
            else this.requestArchive(item.sessionId);
            return;
        }
        if (matchesKey(data, Key.ctrl("u"))) return this.setQuery("");
        // ↑↓ 选择、PgUp / PgDn / ⌃D 与滚轮翻页；j/k 留给搜索输入、⌃U 留给清空搜索
        if (handlePanelScroll(data, {
            pageSize: MAX_VISIBLE,
            scrollBy: (delta) => this.moveCursor(delta),
            vimKeys: false,
            ctrlU: false,
        })) return;
        if (matchesKey(data, Key.enter)) {
            this.clearPendingConfirm();
            const selected = this.matched[this.cursor];
            if (selected) this.actions.select(selected.sessionId);
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            if (this.query) this.setQuery(this.query.slice(0, -1));
            return;
        }

        const printable = decodeKittyPrintable(data);
        if (printable) {
            this.setQuery(this.query + printable);
            return;
        }
        if (!data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) {
            this.setQuery(this.query + data);
        }
    }

    render(width: number): string[] {
        const contentWidth = Math.max(1, width - LEFT_PAD.length);
        const lines = [
            this.header.render(contentWidth, () => this.headerText(contentWidth)),
            this.search.render(contentWidth, () => this.searchText(contentWidth)),
            ...this.renderList(contentWidth),
            this.footer.render(contentWidth, () => this.footerText()),
        ];
        return lines.map((line) => LEFT_PAD + line);
    }

    invalidate(): void {
        this.header.invalidate();
        this.search.invalidate();
        this.footer.invalidate();
    }

    /** 当前选中的会话 id（无匹配时为 null）。 */
    getSelectedId(): string | null {
        return this.matched[this.cursor]?.sessionId ?? null;
    }

    getQuery(): string {
        return this.query;
    }

    private actOnSelected(action: (sessionId: string) => void): void {
        const sessionId = this.getSelectedId();
        if (sessionId) action(sessionId);
    }

    /** ⌃X 删除需二次确认：同一会话在窗口内连按两次才执行。 */
    private requestRemove(sessionId: string): void {
        const now = Date.now();
        const pending = this.pendingRemove;
        if (pending && pending.sessionId === sessionId && now - pending.armedAt <= this.confirmWindow()) {
            this.pendingRemove = null;
            this.actions.remove(sessionId);
            return;
        }
        this.pendingRemove = { sessionId, armedAt: now };
        this.armConfirmTimer();
        this.rebuild();
    }

    /** ⌃A 归档需二次确认：窗口内对同一会话连按两次才执行。 */
    private requestArchive(sessionId: string): void {
        const now = Date.now();
        const pending = this.pendingArchive;
        if (pending && pending.sessionId === sessionId && now - pending.armedAt <= this.confirmWindow()) {
            this.pendingArchive = null;
            this.actions.archive(sessionId);
            return;
        }
        this.pendingArchive = { sessionId, armedAt: now };
        this.armConfirmTimer();
        this.rebuild();
    }

    private moveCursor(delta: number): void {
        if (this.matched.length === 0) return;
        // 选中项变化后旧的确认目标不再适用，避免提示指向错误会话
        this.clearPendingConfirm();
        this.cursor = (this.cursor + delta + this.matched.length) % this.matched.length;
        this.selectedId = this.matched[this.cursor]?.sessionId ?? null;
        // footer 文案随选中项状态切换（归档项显示"取消归档"），必须一并刷新
        this.invalidate();
    }

    private confirmWindow(): number {
        return this.options.confirmMs ?? REMOVE_CONFIRM_MS;
    }

    /** 清空待确认状态与到期定时器（任何其他动作都应使确认失效）。 */
    private clearPendingConfirm(): void {
        this.pendingRemove = null;
        this.pendingArchive = null;
        if (this.confirmTimer) {
            clearTimeout(this.confirmTimer);
            this.confirmTimer = null;
        }
    }

    /** 确认窗口到期后清空提示：否则 footer 会一直显示"再按 ⌃X 确认"，误导用户。 */
    private armConfirmTimer(): void {
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            if (!this.pendingRemove && !this.pendingArchive) return;
            this.pendingRemove = null;
            this.pendingArchive = null;
            this.rebuild();
            this.options.requestRender?.();
        }, this.confirmWindow() + 50);
    }

    private setQuery(query: string): void {
        this.query = query;
        // 搜索是重新定位：排序结果按匹配度重排，光标回到最佳匹配，不再跟随旧会话
        this.selectedId = null;
        this.cursor = 0;
        this.rebuild();
    }

    private filter(): SessionPanelItem[] {
        const query = this.query.trim();
        if (!query) return this.items;
        return fuzzyFilter(this.items, query, (item) =>
            `${item.title ?? ""} ${item.sessionId} ${item.lastUserMessage ?? ""}`);
    }

    private rebuild(): void {
        const matched = this.filter();
        this.matched = matched;
        this.cursor = this.resolveCursor(matched);
        this.selectedId = matched[this.cursor]?.sessionId ?? null;
        this.invalidate();
    }

    /** 光标定位：优先跟随原选中会话，其余情况保留原索引（删除后自然落到下一项）。 */
    private resolveCursor(matched: SessionPanelItem[]): number {
        if (matched.length === 0) return 0;
        if (this.selectedId) {
            const index = matched.findIndex(item => item.sessionId === this.selectedId);
            if (index >= 0) return index;
        }
        return Math.max(0, Math.min(this.cursor, matched.length - 1));
    }

    /** 列表可见窗口：选中项尽量居中，与滚动提示一起构成窗口化列表。 */
    private visibleRange(): { start: number; end: number } {
        const total = this.matched.length;
        const start = Math.max(0, Math.min(this.cursor - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
        return { start, end: Math.min(start + MAX_VISIBLE, total) };
    }

    private renderList(width: number): string[] {
        if (this.matched.length === 0) {
            // 会话本身为空 vs 搜索无匹配是两回事，提示要分开
            const hint = this.items.length === 0 ? "还没有会话" : "没有匹配的会话";
            return [selectListTheme.noMatch(padColumns(truncatePlain(hint, width), width))];
        }

        const rows = this.matched.map(item => this.toRow(item));
        const plan = planSessionRows(rows, width);
        const { start, end } = this.visibleRange();
        const lines: string[] = [];

        for (let index = start; index < end; index += 1) {
            const isSelected = index === this.cursor;
            const { head, detail } = composeSessionRow(rows[index], plan, width, isSelected);
            if (isSelected) {
                lines.push(selectListTheme.selectedText(head + detail));
                continue;
            }
            lines.push(head + (detail ? selectListTheme.description(detail) : ""));
        }

        if (start > 0 || end < this.matched.length) {
            const counter = `(${this.cursor + 1}/${this.matched.length})`;
            lines.push(selectListTheme.scrollInfo(padColumns(truncatePlain(counter, width), width)));
        }
        return lines;
    }

    private toRow(item: SessionPanelItem): SessionRow {
        const status = this.statusOf(item);
        const cwd = item.cwd ? abbreviatePath(item.cwd, this.home()) : undefined;
        return {
            marker: sessionMarker(
                { archived: item.archived, busy: item.busy, active: item.active, question: item.question, owner: item.ownerState },
                this.spinner,
            ),
            title: flattenTitle(item) || item.sessionId.slice(0, 8),
            rounds: `${item.messageCount}轮`,
            time: formatRelativeTime(item.updatedAt),
            ...(cwd ? { cwd } : {}),
            ...(status ? { status } : {}),
        };
    }

    /** 副列状态标签：归属优先（面板是唯一认领入口），其余按需追加。 */
    private statusOf(item: SessionPanelItem): string {
        const parts: string[] = [];
        if (item.owner) parts.push(item.owner);
        if (item.question) parts.push("等你作答");
        if (item.busy && !item.archived) parts.push("运行中");
        if (item.archived) parts.push("已归档");
        return parts.join(" · ");
    }

    private home(): string | undefined {
        return this.options.home ?? process.env.HOME;
    }

    /** 标题行：左侧全局统计，右侧选中会话短 id（列里不再占宽）。 */
    private headerText(width: number): string {
        const summary = [`会话 ${this.items.length}`, `匹配 ${this.matched.length}`];
        const running = this.items.filter(item => item.busy && !item.archived).length;
        if (running > 0) summary.push(`运行 ${running}`);
        const awaiting = this.items.filter(item => item.question).length;
        if (awaiting > 0) summary.push(`待作答 ${awaiting}`);

        const left = theme.commandBorder(`⌘ ${summary.join(" · ")}`);
        const selected = this.matched[this.cursor];
        if (!selected) return left;
        const right = theme.dim(`…${selected.sessionId.slice(-8)}`);
        return padBetween(left, right, width);
    }

    /** 搜索行：query 超宽时保留尾部并把光标留在视野内，否则打字看不到输入。 */
    private searchText(width: number): string {
        const room = Math.max(1, width - visibleWidth(SEARCH_PROMPT) - visibleWidth(CURSOR));
        const queryWidth = visibleWidth(this.query);
        if (queryWidth <= room) return `${SEARCH_PROMPT}${this.query}${CURSOR}`;
        const tailWidth = Math.max(1, room - 1);
        const tail = sliceByColumn(this.query, queryWidth - tailWidth, tailWidth, true);
        return `${SEARCH_PROMPT}…${tail}${CURSOR}`;
    }

    private footerText(): string {
        if (this.pendingRemove) return theme.statusBad(`再按 ⌃X 确认删除「${this.selectedTitle()}」`);
        if (this.pendingArchive) return theme.statusBad(`再按 ⌃A 确认归档「${this.selectedTitle()}」`);
        return theme.dim(this.selectedArchived()
            ? "Enter 查看 · ⌃X 删除 · ⌃A 取消归档 · Esc 关闭"
            : "Enter 切换 · ⌃R 重命名 · ⌃X 删除 · ⌃A 归档 · Esc 关闭");
    }

    private selectedTitle(): string {
        const item = this.matched[this.cursor];
        if (!item) return "";
        return truncatePlain(item.title ?? item.sessionId.slice(0, 8), 24);
    }

    private selectedArchived(): boolean {
        return this.matched[this.cursor]?.archived === true;
    }
}

/** 左对齐 + 右对齐拼成一行（超出宽度时优先保留左侧）。 */
function padBetween(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (leftWidth + rightWidth + 1 > width) return truncatePlain(left, width);
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

/** 单行文本缓存：只有内容变化才重新渲染，避免每帧重复截断长文本。 */
class TextLine {
    private text = "";
    private width = 0;

    render(width: number, build: () => string): string {
        if (width !== this.width || !this.text) {
            this.width = width;
            // 标题/提示带 ANSI 样式，用 truncateToWidth 保留颜色（面板底色由浮层统一施加）
            this.text = truncateToWidth(build(), width, "…");
        }
        return this.text;
    }

    invalidate(): void {
        this.text = "";
    }
}

/** 逐项比较面板数据：任一会影响渲染的字段变化才需要重建列表。 */
function sameItems(left: SessionPanelItem[], right: SessionPanelItem[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => {
        const other = right[index];
        return item.sessionId === other.sessionId
            && item.title === other.title
            && item.cwd === other.cwd
            && item.messageCount === other.messageCount
            && item.lastUserMessage === other.lastUserMessage
            && item.updatedAt === other.updatedAt
            && item.archived === other.archived
            && item.busy === other.busy
            && item.active === other.active
            && item.question === other.question
            && item.ownerState === other.ownerState
            && item.owner === other.owner;
    });
}
