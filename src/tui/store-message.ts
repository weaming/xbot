/**
 * 消息与工具块原语：id 分配、时间线片段追加、工具块折叠文本渲染。
 * 全部为无状态纯函数，id 由调用方注入的自增序列器提供。
 */

import { formatToolBlockArgs } from "./tool-block-display.js";
import type { AssistantTimelineItem, ToolBlock, UiMessage } from "./store-types.js";

/**
 * 回合被中途打断时的收尾措辞：实时投影（store-projector 的 aborted 事件）与重放投影
 * （store-history）必须一字不差，否则同一回合中止后切个会话/重启一次，屏幕上那句话就换了词。
 * 用户主动中止是「已中止」；进程被强杀（只剩 turn_message 的未闭合回合）只能笼统叫「中断」。
 */
export const ABORT_LABEL = "（已中止）";
export const INTERRUPT_LABEL = "（中断）";

/**
 * 按 stopReason 选收尾措辞：只有用户主动中止（"aborted"）才叫「已中止」，
 * 其余（进程强杀、未知终态）笼统叫「中断」。实时与重放两侧都调它，
 * 避免各自实现导致同一回合在中止后措辞漂移。
 */
export function interruptLabel(stopReason: string | undefined): string {
    return stopReason === "aborted" ? ABORT_LABEL : INTERRUPT_LABEL;
}

/**
 * 收尾正文合成：有正文时空行分隔再附标记，只有标记时就是标记本身（不产生前导空行）。
 * 实时投影（store-projector 的 aborted）与重放投影（store-history 的 replyText）
 * 必须共用这一个拼接规则，否则中止后切会话/重启会出现多余空行或缺失。
 */
export function composeAbortText(content: string, label: string): string {
    return content ? `${content}\n\n${label}` : label;
}

/**
 * 时间线里的收尾段：正文段已各自在时间线中，这里只补标记段，
 * 有正文时空行分隔（不重复正文），没有正文时就是标记本身。
 * 实时（store-projector）与重放（store-history）两侧共用，避免一侧重复拼接正文。
 */
export function abortMarkText(hasContent: boolean, label: string): string {
    return hasContent ? `\n\n${label}` : label;
}

/** 构造一条 UI 消息；id 由 nextId 分配，sortKey 缺省取当前时间（块内最后一条内容的时间）。 */
export function createMessage(
    nextId: () => number,
    partial: Omit<UiMessage, "id" | "streaming" | "sortKey"> & { streaming?: boolean; sortKey?: number },
): UiMessage {
    return {
        id: nextId(),
        streaming: false,
        reasoning: undefined,
        ...partial,
        sortKey: partial.sortKey ?? Date.now(),
    };
}

/**
 * 按 sortKey 升序插入消息，并保证「流式消息恒为末位」：
 * 流式块随最新 delta 推进、key 永远是当前最大值，因此新消息只会插到它之前，
 * 等价于按 key 排序；流式块封口后位置定格，后续消息自然排到它之后。
 */
export function insertMessage(messages: UiMessage[], message: UiMessage): void {
    const openIndex = messages.findIndex(item => item.streaming);
    const limit = openIndex >= 0 ? openIndex : messages.length;
    let low = 0;
    let high = limit;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (messages[mid]!.sortKey > message.sortKey) high = mid;
        else low = mid + 1;
    }
    messages.splice(low, 0, message);
}

/** 参数为空（未设置 / 空串 / 空对象 {} / 空数组 []）时不展示参数部分。 */
export function isEmptyArgs(args?: string): boolean {
    return !args || args === "{}" || args === "[]";
}

export function appendTimelineText(message: UiMessage, type: "reasoning" | "text", text: string): void {
    message.timeline ??= [];
    appendTimelineTextToList(message.timeline, type, text);
}

/** 取 timeline 中最后一条**非空** text 片段（折叠态只渲染它）；自尾向前，空/无文本返回 undefined。 */
export function findLastTextItem(
    timeline: AssistantTimelineItem[] | undefined,
): AssistantTimelineItem | undefined {
    for (let index = (timeline?.length ?? 0) - 1; index >= 0; index -= 1) {
        const item = timeline?.[index];
        if (item?.type === "text" && item.text) return item;
    }
    return undefined;
}

/** 把 fromIndex 收敛到 timeline 的合法下标区间 [0, length]。 */
function clampIndex(timeline: AssistantTimelineItem[], fromIndex: number): number {
    return Math.max(0, Math.min(fromIndex, timeline.length));
}

/**
 * 流式增量与 message_end 的最终 content 对账：只动**本轮 LLM 迭代**的正文段。
 *
 * content 是最后一条无 tool_calls 的 assistant 消息的正文（**不含**此前工具轮的说明文本），
 * fromIndex 是 message_end 所属迭代开始时 timeline 的长度（由投影层传入）。
 * 所以锚点是「本轮的第一个 text 段」：把 content 写回它、并清空本轮其余 text 段（原地，不重建数组）。
 *
 * 教训（2026-09-10 实测）：旧实现把 content 写回**整条 timeline 的第一个** text 段并删掉其余段，
 * 多轮工具循环里最终回复就被搬到了工具调用之前（工具前的说明文本还被覆盖丢了）。
 * 原地改字而不是重建数组，是为了保持 item 对象引用稳定（折叠态 lastTextItem、流式视口块都按引用缓存）。
 * 本轮没有正文增量（非流式路径 / 增量全丢）时，按重放侧口径在末尾补一段。
 */
export function syncTimelineFinalText(message: UiMessage, content: string, fromIndex = 0): void {
    const timeline = message.timeline;
    if (!timeline || !content) return;
    const own = timeline
        .slice(clampIndex(timeline, fromIndex))
        .filter((item): item is Extract<AssistantTimelineItem, { type: "text" }> => item.type === "text");
    if (own.length === 0) {
        appendTimelineTextToList(timeline, "text", content);
        return;
    }
    own[0].text = content;
    for (const item of own.slice(1)) item.text = "";
}

/**
 * 流式增量与 message_end 的最终 reasoning 对账。
 *
 * 与文本对账语义不同：event.reasoning 是**整回合多轮迭代的累计值**
 * （orchestrator 里 turnReasoning += 每轮 reasoning），跨迭代，不能整体搬进第一段 ——
 * 那样后面的思考段会被清空、整回合思考都跑到工具调用之前（与重放侧「每轮思考留在自己段位」不一致）。
 *
 * 口径：fromIndex 之前的思考段视为已定稿，用「累计值 − 已定稿前缀」得到本轮思考，
 * 写回本轮首段、清空本轮其余段。段位置不变，且各段之和恒等于累计值（前几轮丢 chunk 也能自然补回）。
 * 前缀对不上累计值时（丢 chunk 丢在无法定位的地方）不猜，保持原样。
 */
export function syncTimelineFinalReasoning(message: UiMessage, reasoning?: string, fromIndex = 0): void {
    const timeline = message.timeline;
    if (!timeline || !reasoning) return;
    const start = clampIndex(timeline, fromIndex);
    const settled = timeline
        .slice(0, start)
        .map(item => (item.type === "reasoning" ? item.text : ""))
        .join("");
    if (!reasoning.startsWith(settled)) return;

    const iteration = reasoning.slice(settled.length);
    const own = timeline
        .slice(start)
        .filter((item): item is Extract<AssistantTimelineItem, { type: "reasoning" }> => item.type === "reasoning");
    if (own.length === 0) {
        if (iteration) appendTimelineTextToList(timeline, "reasoning", iteration);
        return;
    }
    own[0].text = iteration;
    for (const item of own.slice(1)) item.text = "";
}

/**
 * 按 toolId 稳定重排 timeline 里的 tool 项，使其与重放侧（tool_calls 数组序）一致。
 * 只重排 tool 项之间的相对次序，不改变它们与 text/reasoning/chat 段的位置关系：
 * 把所有 tool 项抽出排序后，依次填回原来的 tool 槽位。
 */
export function sortTimelineToolBlocks(message: UiMessage): void {
    const timeline = message.timeline;
    if (!timeline || timeline.length < 2) return;
    const toolItems = timeline.filter(
        (item): item is Extract<AssistantTimelineItem, { type: "tool" }> => item.type === "tool",
    );
    if (toolItems.length < 2) return;
    const sorted = [...toolItems].sort((left, right) => left.block.toolId - right.block.toolId);
    let cursor = 0;
    message.timeline = timeline.map(item => (item.type === "tool" ? sorted[cursor++]! : item));
}

/** 追加文本片段：与上一片段同类型则合并，否则新建（reasoning 片段带 renderedOffset 初值）。 */
export function appendTimelineTextToList(
    timeline: AssistantTimelineItem[],
    type: "reasoning" | "text",
    text: string,
): void {
    if (!text) return;
    const last = timeline.at(-1);
    if (last?.type === type) {
        last.text += text;
        return;
    }
    timeline.push(type === "reasoning" ? { type, text, renderedOffset: 0 } : { type, text });
}

/** 按折叠态构建工具块显示文本。 */
export function renderToolBlock(block: ToolBlock): void {
    const formattedArgs = formatToolBlockArgs(block.name, block.args);
    if (block.expanded) {
        const argsPart = !isEmptyArgs(formattedArgs) ? ` ${formattedArgs}` : "";
        const header = `🔧 ${block.name}${argsPart}`;
        const lines: string[] = [header];
        if (block.result !== undefined) {
            lines.push(block.result);
        }
        block.text = lines.join("\n");
        return;
    }

    const header = `🔧 ${block.name}${block.result !== undefined ? (block.isError ? " ❌" : " ✅") : ""}`;
    const lines: string[] = [header];
    if (!isEmptyArgs(formattedArgs)) {
        lines.push(formattedArgs);
    }
    block.text = lines.join("\n");
}

/** 从历史原始消息中收集 tool_call id → {name, args} 映射。 */
export function extractToolCalls(
    messages: Array<{ role: string; [key: string]: any }>,
): Map<string, { name?: string; args?: string }> {
    const toolCalls = new Map<string, { name?: string; args?: string }>();
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
        for (const toolCall of message.tool_calls) {
            const id = toolCall?.id ?? toolCall?.call_id;
            if (typeof id !== "string" || !id) continue;
            const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments;
            toolCalls.set(id, {
                name: toolCall?.function?.name ?? toolCall?.name,
                args: typeof rawArgs === "string" ? rawArgs : rawArgs === undefined ? undefined : JSON.stringify(rawArgs),
            });
        }
    }
    return toolCalls;
}
