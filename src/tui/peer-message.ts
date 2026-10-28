/**
 * 会话间消息渲染：头部（方向 + 对端 + 结果状态）+ 正文。
 * 与群消息同一套段位插入逻辑，因此保持「头部行 + 可整段 Markdown 正文」的形态：
 * pi-tui 的 Markdown 是块级渲染器，头部必须留在它外层。
 */

import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { Component, DefaultTextStyle } from "@earendil-works/pi-tui";
import { markdownTheme, theme } from "./theme.js";
import type { PeerMeta } from "./store-types.js";
import { isUlid, shortSessionId } from "../utils/session-id.js";

/** 会话间消息内容：独立消息（UiMessage）携带 text + peer 元数据。 */
export interface PeerContent {
    text: string;
    peer: PeerMeta;
}

/** 结果正文默认色：失败/丢失的结果整体置灰，成功结果保持正常对比度。 */
const PEER_MARKDOWN_TEXT_STYLE: DefaultTextStyle = { color: (text: string) => theme.chatBody(text) };

/** 与群消息一致：只在确实含 Markdown 语法时才走块级渲染。 */
const MARKDOWN_PATTERNS: RegExp[] = [
    /```/,
    /\*\*[^\s][\s\S]*?\*\*/,
    /`[^`\n]+`/,
    /^\s*(?:[-*+]|\d+\.)\s+\S/m,
    /^\s*>\s*\S/m,
    /^\s*\|.*\|\s*$/m,
];

function hasMarkdownSyntax(text: string): boolean {
    return MARKDOWN_PATTERNS.some((pattern) => pattern.test(text));
}

/** 对端展示：有标题时「标题 …短id」，否则只显示短 id。 */
function peerLabel(peer: PeerMeta): string {
    const title = peer.peerTitle?.trim();
    // 只截真正会话的 ULID；命令行发起方（`cli-<pid>`）这类短标识原样显示
    const label = isUlid(peer.peerId) ? shortSessionId(peer.peerId) : peer.peerId;
    if (title) return `${theme.chatRoom(title)} ${theme.dim(`…${label}`)}`;
    return theme.chatRoom(label);
}

/** 状态标记：结果（成功/未完成/已取消/丢失）、期望结果。 */
function peerTags(peer: PeerMeta): string[] {
    if (!peer.isResult) return peer.expectResult ? [theme.dim("期望结果")] : [];

    if (peer.lost) return [theme.chatMention("结果丢失")];
    if (peer.late) return [theme.statusWarn("迟到结果")];
    // 取消优先于 ok：被取消的回合没有产出，标「结果」会误导成正常回传
    if (peer.cancelled) return [theme.statusWarn("已取消")];
    return peer.ok ? [theme.chatSelf("结果")] : [theme.chatMention("结果（未完成）")];
}

/** 正文是否整体置灰：丢失、未完成、被取消的结果都没有可用产出。 */
function isBodyDimmed(peer: PeerMeta): boolean {
    return peer.isResult === true && !peer.lost && (peer.ok === false || peer.cancelled === true);
}

/** 正文兜底：没有产出时说明原因，避免只留一个没有内容的头部行。 */
function peerBody(message: PeerContent): string {
    if (message.text.trim() || !message.peer.isResult) return message.text;
    return message.peer.cancelled ? "（本轮被取消，没有输出）" : "（无文本输出）";
}

/** 头部：`→ 💬 「标题」…id · 期望结果: `；inlineBody=false 时去掉尾部分隔。 */
function renderPeerHead(peer: PeerMeta, inlineBody = true): string {
    const arrow = theme.dim(peer.direction === "out" ? "→" : "←");
    const icon = peer.direction === "out" ? theme.chatSelf("💬") : theme.chatMention("💬");
    const tags = peerTags(peer);
    const suffix = tags.length > 0 ? `${theme.dim(" · ")}${tags.join(theme.dim(" · "))}` : "";
    const tail = inlineBody ? theme.dim(": ") : "";
    return `${arrow} ${icon} ${peerLabel(peer)}${suffix}${tail}`;
}

/** 会话间消息纯文本形态：头部 + 全文（未完成或被取消的结果整体置灰）。 */
export function renderPeerPlain(message: PeerContent): string {
    const text = peerBody(message);
    const body = isBodyDimmed(message.peer) ? theme.chatBody(text) : text;
    return `${renderPeerHead(message.peer)}${body}`;
}

/** 整行铺背景的空白行（Text 对纯空白文本不渲染，故自建）。 */
function backgroundPadding(background: (text: string) => string): Component {
    return {
        render: (width: number) => [background(" ".repeat(Math.max(1, width)))],
        invalidate: () => {},
    };
}

/** 会话间消息组件：含 Markdown 时拆成「头部行 + Markdown 正文」。 */
export class PeerMessageView implements Component {
    private readonly root = new Container();
    private lastMessage?: PeerContent;

    constructor(message: PeerContent) {
        this.setMessage(message);
    }

    setMessage(message: PeerContent): void {
        if (message === this.lastMessage) return;
        this.lastMessage = message;
        this.rebuild(message);
    }

    private rebuild(message: PeerContent): void {
        this.root.clear();

        const background = theme.chatBackground;
        const body = peerBody(message);
        const useMarkdown = hasMarkdownSyntax(body);
        if (!useMarkdown) {
            this.root.addChild(backgroundPadding(background));
            const text = isBodyDimmed(message.peer) ? theme.chatBody(body) : body;
            this.root.addChild(new Text(`${renderPeerHead(message.peer)}${text}`, 1, 0, background));
            return;
        }

        this.root.addChild(backgroundPadding(background));
        this.root.addChild(new Text(renderPeerHead(message.peer, false), 1, 0, background));
        this.root.addChild(new Markdown(
            body,
            1,
            0,
            markdownTheme,
            isBodyDimmed(message.peer) ? { ...PEER_MARKDOWN_TEXT_STYLE, bgColor: background } : { bgColor: background },
        ));
    }

    render(width: number): string[] {
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }
}
