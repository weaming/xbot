/**
 * 会话面板：居中浮层，模糊搜索 + 切换 / 重命名 / 删除 / 归档。
 * 面板打开时独占键盘输入（由 ChatApp 的全局输入监听转交），Esc 或 Ctrl+C 关闭。
 */

import {
    decodeKittyPrintable,
    fuzzyFilter,
    Key,
    matchesKey,
    SelectList,
    stripTerminalSequences,
    Text,
} from "@earendil-works/pi-tui";
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { truncatePlain } from "./panel-text.js";
import { DEFAULT_SPINNER, sessionMarker, type SessionOwnerState } from "./session-marker.js";
import { selectListTheme, theme } from "./theme.js";

/** 面板列表一次最多显示的行数（超出滚动）。 */
const MAX_VISIBLE = 10;
/** 删除确认窗口：窗口内再按一次 ⌃X 才真正删除。 */
const REMOVE_CONFIRM_MS = 2_000;
/** 搜索框提示符与光标。 */
const SEARCH_PROMPT = "🔍 ";
const CURSOR = "▏";

export interface SessionPanelItem {
    sessionId: string;
    title?: string;
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
}

/** 相对时间：1 分钟内「刚刚」，1 小时内分钟，24 小时内小时，30 天内天，再早显示日期。 */
function formatRelativeTime(iso?: string): string {
    if (!iso) return "未落盘";
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) return "";

    const diffMs = Date.now() - time;
    if (diffMs < 60_000) return "刚刚";
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(time).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 列表主列文本：标题可能来自用户输入，先折为单行纯文本再交给 SelectList。 */
function labelOf(item: SessionPanelItem, spinner: string): string {
    const title = stripTerminalSequences(item.title ?? "").replace(/\s+/g, " ").trim();
    const marker = sessionMarker(
        { archived: item.archived, busy: item.busy, active: item.active, question: item.question, owner: item.ownerState },
        spinner,
    );
    return `${marker} ${title || item.sessionId.slice(0, 8)}`;
}

function describe(item: SessionPanelItem): string {
    const parts: string[] = [];
    if (item.messageCount > 0) parts.push(`${item.messageCount} 轮`);
    parts.push(formatRelativeTime(item.updatedAt));
    parts.push(`…${item.sessionId.slice(-8)}`);
    if (item.owner) parts.push(item.owner);
    if (item.question) parts.push("等你作答");
    if (item.busy && !item.archived) parts.push("运行中");
    if (item.archived) parts.push("已归档");
    return parts.join(" · ");
}

export class SessionPanel implements Component {
    private readonly root = new PanelBody();
    private readonly header = new Text("", 1, 0);
    private readonly search = new Text("", 1, 0);
    private readonly footer = new Text("", 1, 0);
    private items: SessionPanelItem[];
    private spinner: string;
    private list: SelectList | null = null;
    private matched: SessionPanelItem[] = [];
    private cursor = 0;
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
            // 只清删除待确认：归档自身的二次确认需要保留
            this.pendingRemove = null;
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
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
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
        this.list?.setSelectedIndex(this.cursor);
        // footer 文案随选中项状态切换（归档项显示"取消归档"），必须一并刷新
        this.updateFooter();
        this.root.invalidate();
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
        this.cursor = Math.max(0, Math.min(this.cursor, matched.length - 1));

        const selectItems: SelectItem[] = matched.map((item) => ({
            value: item.sessionId,
            label: labelOf(item, this.spinner),
            description: describe(item),
        }));
        const list = new SelectList(selectItems, MAX_VISIBLE, selectListTheme, {
            minPrimaryColumnWidth: 24,
            maxPrimaryColumnWidth: 44,
        });
        list.setSelectedIndex(this.cursor);
        this.list = list;

        this.header.setText(theme.commandBorder(`⌘ 会话 ${this.items.length} 个 · 匹配 ${matched.length} 个`));
        this.search.setText(`${SEARCH_PROMPT}${this.query}${CURSOR}`);
        this.updateFooter();

        this.root.setChildren([this.header, this.search, list, this.footer]);
        this.root.invalidate();
    }

    private updateFooter(): void {
        this.footer.setText(this.pendingRemove
            ? theme.statusBad(`再按 ⌃X 确认删除「${this.selectedTitle()}」`)
            : this.pendingArchive
                ? theme.statusBad(`再按 ⌃A 确认归档「${this.selectedTitle()}」`)
                : theme.dim(this.selectedArchived()
                    ? "Enter 查看 · ⌃X 删除 · ⌃A 取消归档 · Esc 关闭"
                    : "Enter 切换 · ⌃R 重命名 · ⌃X 删除 · ⌃A 归档 · Esc 关闭"));
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

/** 逐项比较面板数据：任一会影响渲染的字段变化才需要重建列表。 */
function sameItems(left: SessionPanelItem[], right: SessionPanelItem[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => {
        const other = right[index];
        return item.sessionId === other.sessionId
            && item.title === other.title
            && item.messageCount === other.messageCount
            && item.lastUserMessage === other.lastUserMessage
            && item.updatedAt === other.updatedAt
            && item.archived === other.archived
            && item.busy === other.busy
            && item.active === other.active
            && item.ownerState === other.ownerState
            && item.owner === other.owner;
    });
}
