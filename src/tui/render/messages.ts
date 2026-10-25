/**
 * 消息列表渲染：把 store 的消息视图投影成组件树。
 *
 * 从 ChatApp 抽出的纯投影层：只读 store 快照与少量显示开关，
 * 输出 Container 树，唯一的回写是流式 reasoning 的增量游标（`renderedOffset`），
 * 它属于渲染状态而非业务状态。
 *
 * 抽出的理由：这是 app.ts 里唯一还在做「从数据到组件」的区域，
 * 输入输出都明确，可以脱离 ChatApp 的完整装配单独验证。
 */

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { collectCollapsedFileBlocks } from "../app-helpers.js";
import { PeerMessageView, renderPeerPlain } from "../peer-message.js";
import { ReasoningBlock } from "../reasoning-block.js";
import { findLastTextItem } from "../store-message.js";
import { SPINNER_FRAMES } from "../session-marker.js";
import { StreamingReasoningBlock } from "../streaming-reasoning.js";
import { markdownTheme, theme } from "../theme.js";
import { ToolBlockText } from "../tool-block-text.js";
import type { Citation } from "../../types/session.js";
import {
    isAskUserTool,
    isFileMutationTool,
    isTodoTool,
    renderCollapsedFileBlocks,
    renderCollapsedToolBlock,
    renderExpandedToolBlock,
} from "../tool-block-display.js";
import type { AssistantTimelineItem, UiMessage } from "../store.js";

/** 单条消息的组件状态：组件树 + 重建所需的缓存。 */
export interface MessageComponents {
    messageId: number;
    root: Container;
    body?: Text;
    /** 群消息专用视图：按折叠态在单行文本与 Markdown 块之间切换。 */
    peerView?: PeerMessageView;
    timeline?: Container;
    /** 流式 reasoning 视口块缓存（按 timeline item 持久，增量追加）。 */
    reasoningBlocks?: Map<AssistantTimelineItem, StreamingReasoningBlock>;
    /** 上次渲染时的内容指纹：用于跳过未变化消息的重建。 */
    renderKey?: string;
}

/** 渲染所需的外部视图参数：都由宿主在调用时提供，渲染器不持有状态。 */
export interface RenderContext {
    /** 详细模式（Ctrl+O）：展开全部思考与工具块。 */
    detailed: boolean;
    /** 是否显示思考过程。 */
    showReasoning: boolean;
    /** 当前 spinner 帧下标。 */
    spinnerIndex: number;
    /** 终端列数（流式 reasoning 的视口宽度）。 */
    columns: number;
}

/**
 * 消息内容指纹：覆盖影响渲染的所有字段。流式消息随 text/timeline 变化，
 * 折叠态变化时通过前缀位一并纳入，保证切换后重绘。
 */
export function messageRenderKey(message: UiMessage, ctx: RenderContext): string {
    const flags = `${ctx.detailed ? 1 : 0}${ctx.showReasoning ? 1 : 0}`;
    if (message.role === "assistant") {
        const timeline = message.timeline ?? [];
        const last = timeline[timeline.length - 1];
        const lastText = last && "text" in last ? last.text.length : 0;
        // 只有流式且尚无 timeline 的等待态才受 spinner 影响，单独纳入，避免 120ms
        // tick 让所有历史消息指纹失效。用「timeline 长度 + 末段长度 + 流式标记 +
        // text 长度」近似内容，避免对长文本做完整字符串拼接。
        const waiting = message.streaming && timeline.length === 0
            ? `|s${ctx.spinnerIndex % SPINNER_FRAMES.length}`
            : "";
        // 工具块状态：result/expanded 就绪后 timeline 长度不变，须单列指纹
        const tools = (message.toolBlocks ?? [])
            .map(block => `${block.id}:${block.expanded ? 1 : 0}:${block.result === undefined ? 0 : block.result.length}`)
            .join(",");
        // 来源清单只随事件一次性到达，但长度变化要能触发重绘
        const sources = timeline.reduce((count, item) => item.type === "sources" ? count + item.items.length : count, 0);
        return `${flags}|a|${message.streaming ? 1 : 0}|${timeline.length}|${lastText}|${sources}|${message.text.length}|${message.reasoning?.length ?? 0}|${tools}${waiting}`;
    }
    return `${flags}|${message.role}|${message.text.length}|${message.peer ? 1 : 0}`;
}

/** 新建一条消息的组件骨架（按 role 分派）。 */
export function createMessageComponent(message: UiMessage): MessageComponents {
    const root = new Container();
    const base = { messageId: message.id, root };
    let result: MessageComponents;

    if (message.role === "assistant") {
        const timeline = new Container();
        root.addChild(timeline);
        result = { ...base, timeline, reasoningBlocks: new Map() };
    } else if (message.role === "user") {
        const body = new Text(theme.user(`❯ ${message.text}`), 1, 1, theme.userBackground);
        root.addChild(body);
        result = { ...base, body };
    } else if (message.peer) {
        // 会话间消息/结果：同一套视图，按方向与状态配色
        const peerView = new PeerMessageView({ text: message.text, peer: message.peer });
        root.addChild(peerView);
        result = { ...base, peerView };
    } else {
        const body = new Text(renderSystemText(message), 1, 0);
        root.addChild(body);
        result = { ...base, body };
    }

    // 消息底部空行：回复后分隔下一条消息，用户消息后与回复衔接
    root.addChild(new Spacer(1));
    return result;
}

/** 内容变化时就地更新已存在的组件，避免整棵树重建。 */
export function updateMessageComponent(
    entry: MessageComponents,
    message: UiMessage,
    ctx: RenderContext,
): void {
    if (message.role === "assistant" && entry.timeline) {
        updateAssistantTimeline(entry, message, ctx);
        entry.root.children = [entry.timeline, new Spacer(1)];
        entry.root.invalidate();
        return;
    }

    if (entry.peerView) {
        entry.peerView.setMessage({ text: message.text, peer: message.peer! });
        entry.peerView.invalidate();
        return;
    }

    if (!entry.body) return;
    if (message.role === "user") {
        entry.body.setText(theme.user(`❯ ${message.text}`));
    } else {
        entry.body.setText(renderSystemText(message));
    }
    entry.body.invalidate();
}

/** 系统消息的纯文本形态：会话间消息/结果走专用渲染，其余原样。 */
export function renderSystemText(message: UiMessage): string {
    if (message.peer) return renderPeerPlain({ text: message.text, peer: message.peer });
    return message.text;
}

/** 按 assistant turn 的时间线渲染思考、正文和工具调用。 */
function updateAssistantTimeline(entry: MessageComponents, message: UiMessage, ctx: RenderContext): void {
    const container = entry.timeline!;
    const timeline = message.timeline ?? (message.text ? [{ type: "text", text: message.text }] : []);
    const showDetail = message.streaming || ctx.detailed;
    const children: Component[] = [];
    // 末条正文只渲染一次：循环外算好，避免每个 text item 都从尾扫一遍 timeline
    const lastTextItem = findLastTextItem(timeline);

    if (message.streaming && timeline.length === 0) {
        const spinnerChar = SPINNER_FRAMES[ctx.spinnerIndex % SPINNER_FRAMES.length];
        children.push(new Text(theme.dim(`${spinnerChar} 等待响应...`), 1, 0));
    }

    for (let index = 0; index < timeline.length; index++) {
        const item = timeline[index]!;
        const fileBlocks = !showDetail ? collectCollapsedFileBlocks(timeline, index) : [];
        const component = fileBlocks.length > 0
            ? new ToolBlockText(renderCollapsedFileBlocks(fileBlocks), 1, true)
            : renderTimelineItem(item, lastTextItem, showDetail, entry, ctx);
        if (!component) continue;
        if (children.length > 0) children.push(new Spacer(1));
        children.push(component);
        if (fileBlocks.length > 0) index += fileBlocks.length - 1;
    }

    container.children = children;
    container.invalidate();
}

function renderTimelineItem(
    item: AssistantTimelineItem,
    lastTextItem: AssistantTimelineItem | undefined,
    showDetail: boolean,
    entry: MessageComponents,
    ctx: RenderContext,
): Component | undefined {
    if (item.type === "reasoning") {
        if (!showDetail || !ctx.showReasoning) return undefined;
        if (ctx.detailed) {
            // 详细模式：完整 Markdown（人工展开全量内容）
            return new ReasoningBlock(item.text);
        }
        return syncStreamingReasoning(entry, item, ctx);
    }

    if (item.type === "user") {
        if (!item.text) return undefined;
        // 与独立用户消息一致：上下各留 1 行同色背景
        return new Text(theme.user(`❯ ${item.text}`), 1, 1, theme.userBackground);
    }

    if (item.type === "peer") {
        // 回合执行中到达的会话间消息/结果：同样始终渲染全文
        return new PeerMessageView({ text: item.text, peer: item.peer });
    }

    if (item.type === "sources") {
        const text = renderSources(item.items);
        return text ? new ToolBlockText(text, 1) : undefined;
    }

    if (item.type === "text") {
        if (!item.text) return undefined;
        const isLastText = lastTextItem === item;
        if (!showDetail && !isLastText) return undefined;
        return new Markdown(item.text, 1, 0, markdownTheme);
    }

    if (item.type !== "tool") return undefined;

    // todo 已由底部常驻条展示最新状态，不再出现在事件流里
    if (item.block && isTodoTool(item.block.name)) return undefined;
    const isFileMutation = item.block && isFileMutationTool(item.block.name);
    // 提问与文件变更同理：折叠态也要看得见「问了什么、答了什么」
    const isAskUser = item.block && isAskUserTool(item.block.name);
    // 文件变更工具在折叠模式下也保留（结果就绪后）
    const shouldShowTool = showDetail || isAskUser || (isFileMutation && item.block.result !== undefined);
    if (!shouldShowTool) return undefined;
    const text = item.block.expanded
        ? renderExpandedToolBlock(item.block)
        : renderCollapsedToolBlock(item.block);
    return new ToolBlockText(text, 1, isFileMutation);
}

/** 托管搜索的来源清单：标题在前、URL 在后，折叠态也展示。 */
function renderSources(items: Citation[]): string {
    if (items.length === 0) return "";
    const lines = [theme.dim(`🌐 来源 ${items.length}`)];
    items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title ? `${item.title} — ${item.url}` : item.url}`);
    });
    return lines.join("\n");
}

/** 流式 reasoning：增量消费 item.text，渲染固定 UI 行视口（块高恒定，历史不跳动）。 */
function syncStreamingReasoning(
    entry: MessageComponents,
    item: Extract<AssistantTimelineItem, { type: "reasoning" }>,
    ctx: RenderContext,
): StreamingReasoningBlock {
    const blocks = entry.reasoningBlocks ??= new Map();
    let block = blocks.get(item);
    if (!block) {
        block = new StreamingReasoningBlock();
        blocks.set(item, block);
    }
    const width = Math.max(10, ctx.columns - 2);
    const offset = item.renderedOffset ?? 0;
    if (item.text.length < offset || block.width !== width) {
        // 文本回退或终端 resize：全量重建窗口
        block.reset(item.text, width);
    } else {
        block.append(item.text.slice(offset), width);
    }
    item.renderedOffset = item.text.length;
    return block;
}
