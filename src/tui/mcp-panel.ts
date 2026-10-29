/**
 * MCP 浮层：列出服务、连接状态与选中项详情，并可对 lazy server 按「本会话」临时启用 / 停用。
 *
 * lazy server 的工具在接入端不支持 tool_search 时默认不下发；勾选状态按会话落盘
 * （lazy_mcp_changed），重启后仍生效。支持 tool_search 时 lazy 不拦下发，切换也就没有意义，
 * 面板会明确说明并忽略空格。
 * 面板打开时独占键盘输入：↑↓ / jk 选择，空格切换，Esc / ⌃C 关闭。
 */

import { Key, matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { McpServerStatus } from "../mcp/client-manager.js";
import { truncatePlain } from "../format/text.js";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { theme } from "./theme.js";

/** 面板固定占用的非列表行：标题 + 提示 + 底部键位。 */
const CHROME_LINES = 3;
/** 选中项详情最多占几行：目标 / 协议状态 / 错误 / OAuth / 工具清单，空间不足时按此顺序截断。 */
const MAX_DETAIL_LINES = 5;

export interface McpPanelOptions {
    /** MCP 服务状态快照（连接状态、工具数、是否 lazy）。 */
    servers: McpServerStatus[];
    /** 本会话临时启用的 lazy server。 */
    enabled: string[];
    /** 当前接入端是否支持 tool_search：支持时 lazy 工具按需加载，不必临时启用。 */
    toolSearch: boolean;
    /** 一次最多显示的内容行数（终端高度推算，含选中项详情）。 */
    visibleRows: number;
    close(): void;
    /** 新的会话级启用集（整份下发，避免连按时的读改写竞争）。 */
    toggle(servers: string[]): void;
}

export class McpPanel implements Component {
    private readonly root = new PanelBody();
    private readonly enabled: Set<string>;
    private cursor = 0;

    constructor(private readonly options: McpPanelOptions) {
        this.enabled = new Set(options.enabled);
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.options.close();
            return;
        }
        if (handlePanelScroll(data, {
            pageSize: this.options.visibleRows,
            scrollBy: delta => this.moveCursor(delta),
        })) return;
        if (matchesKey(data, Key.space)) {
            this.toggleCurrent();
        }
    }

    render(width: number): string[] {
        const servers = this.options.servers;
        // Text 左右各 1 列内边距：内容宽度预算要按 usable 算
        const usable = Math.max(8, width - 2);
        if (servers.length === 0) {
            this.root.setChildren([
                new Text(theme.commandBorder("🔌 MCP 服务"), 1, 0),
                new Text(theme.dim("未配置或未连接任何 MCP 服务"), 1, 0),
                new Text(theme.dim("Esc 关闭"), 1, 0),
            ]);
            this.root.invalidate();
            return this.root.render(width);
        }

        // 详情区固定预留：切光标时列表可视行数与浮窗高度都不跳（详情不足的行用空行补）
        const detailReserve = Math.min(MAX_DETAIL_LINES, Math.max(0, this.options.visibleRows - CHROME_LINES - 1));
        const listRows = Math.max(1, this.options.visibleRows - CHROME_LINES - detailReserve);
        const windowSize = Math.max(1, Math.min(listRows, servers.length));
        const start = Math.max(0, Math.min(this.cursor - windowSize + 1, servers.length - windowSize));
        const listLines = servers
            .slice(start, start + windowSize)
            .map((server, index) => new Text(this.renderRow(server, start + index === this.cursor, usable), 1, 0));
        const detail = this.detailLines(usable).slice(0, detailReserve);
        while (detail.length < detailReserve) detail.push("");
        const detailLines = detail.map(line => new Text(theme.dim(line), 1, 0));

        this.root.setChildren([
            new Text(theme.commandBorder(truncatePlain(`🔌 MCP 服务 · ${servers.length} 个服务`, usable)), 1, 0),
            new Text(theme.dim(truncatePlain(this.hintText(), usable)), 1, 0),
            ...listLines,
            ...detailLines,
            new Text(theme.dim(truncatePlain("↑↓ 选择 · 空格 启用/停用 · Esc 关闭", usable)), 1, 0),
        ]);
        this.root.invalidate();
        // 兜底：预算按行估算，任何宽度下都不许把浮窗撑过可用高度（底部键位与边框会被裁掉）
        return this.root.render(width).slice(0, Math.max(1, this.options.visibleRows));
    }

    invalidate(): void {
        this.root.invalidate();
    }

    /** lazy server 的当前启用集（整份回调给调用方落盘）。 */
    enabledServers(): string[] {
        return [...this.enabled].sort();
    }

    /** 落盘失败时由调用方回读真实状态重置面板，避免本地勾选与事件分叉。 */
    setEnabled(servers: string[]): void {
        this.enabled.clear();
        for (const name of servers) this.enabled.add(name);
        this.root.invalidate();
    }

    private toggleCurrent(): void {
        const server = this.options.servers[this.cursor];
        // 支持 tool_search 时 lazy 不拦下发，切换不生效，也不该无谓落一条事件
        if (!server?.lazy || this.options.toolSearch) return;
        if (this.enabled.has(server.name)) this.enabled.delete(server.name);
        else this.enabled.add(server.name);
        this.options.toggle(this.enabledServers());
        this.root.invalidate();
    }

    private moveCursor(delta: number): void {
        const maxIndex = Math.max(0, this.options.servers.length - 1);
        const next = Math.max(0, Math.min(maxIndex, this.cursor + delta));
        if (next === this.cursor) return;
        this.cursor = next;
        this.root.invalidate();
    }

    /** 顶部提示：说明 lazy 在当前接入端的表现，避免「启用了却看不到工具」的困惑。 */
    private hintText(): string {
        return this.options.toolSearch
            ? "当前模型支持 tool_search：lazy 工具按需加载，无需会话级启用"
            : "当前模型不支持 tool_search：lazy 工具默认不下发，空格可为本会话临时启用";
    }

    /**
     * 选中项详情：目标 / 协议与状态 / 错误 / OAuth / 工具清单，恢复文本时代的可见信息。
     * 每行都按「可用宽度 - 前缀宽度」截断，保证一条信息占一行（换行会撑破浮窗高度）。
     */
    private detailLines(usable: number): string[] {
        const server = this.options.servers[this.cursor];
        if (!server) return [];
        const lines: string[] = [];
        const push = (label: string, value: string): void => {
            const room = Math.max(4, usable - visibleWidth(label) - 1);
            lines.push(`${label} ${truncatePlain(value, room)}`);
        };

        push("目标", server.target || "（未指定）");
        push("协议", `${server.protocol} · ${this.statusLabel(server)} · ${server.toolNames.length} 个工具`);
        if (server.error) push("错误", server.error);
        if (server.oauth) {
            const label = server.oauth.authorizationUrl
                ? `待授权 ${server.oauth.authorizationUrl}`
                : server.oauth.error
                    ? `上次授权失败 ${server.oauth.error}`
                    : server.oauth.hasTokens ? "已授权（凭据已缓存）" : "未授权（首次连接会给出链接）";
            push("OAuth", label);
        }
        if (server.toolNames.length > 0) push("工具", server.toolNames.join(", "));
        return lines.slice(0, MAX_DETAIL_LINES);
    }

    private statusLabel(server: McpServerStatus): string {
        if (server.status === "connected") return "已连接";
        if (server.status === "connecting") return "连接中…";
        if (server.status === "authorizing") return "等待浏览器授权…";
        return server.status === "error" ? "连接错误" : "已断开";
    }

    /** 单行服务：`❯ ● mcp-hub  http · 42 工具 · lazy 已启用`；usable 已扣掉 Text 的左右内边距。 */
    private renderRow(server: McpServerStatus, selected: boolean, usable: number): string {
        const statusMark = server.status === "connected"
            ? "●"
            : (server.status === "connecting" || server.status === "authorizing" ? "◌" : "✕");
        const lazyLabel = !server.lazy
            ? ""
            : this.options.toolSearch
                ? " · lazy 按需加载"
                : this.enabled.has(server.name) ? " · lazy 已启用" : " · lazy 未启用";
        const body = `${statusMark} ${server.name}  ${server.type} · ${server.toolNames.length} 工具${lazyLabel}`;
        const prefix = selected ? "❯ " : "  ";
        const line = `${prefix}${truncatePlain(body, Math.max(8, usable - visibleWidth(prefix)))}`;
        if (server.lazy && !this.options.toolSearch && this.enabled.has(server.name)) return theme.statusOk(line);
        if (server.status === "connected") return selected ? theme.commandText(line) : line;
        return theme.dim(line);
    }
}
