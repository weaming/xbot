/**
 * 待发消息队列：回合进行中用户继续输入时，消息先排队，等下一次迭代请求前再附加给模型。
 *
 * 改造前这些状态散在 ChatApp 的 `sessionPending` Map 里，读写都直接摸
 * `{ messages, index }` 结构，渲染、按键、消费三条路径各写一遍边界检查。
 * 这里把「队列 + 选中索引」当成一个实体，越界与清空规则只有一份。
 */

import type { ImageAssetRef } from "../types/image.js";

/** 一条待发消息：纯文本，或带图片附件的文本。 */
export type PendingMessage = string | {
    text: string;
    images: ImageAssetRef[];
    steer?: { state: "sending" | "accepted" | "failed" | "queued"; responseId?: string };
};

interface QueueState {
    messages: PendingMessage[];
    /** 当前选中项；↑/↓ 在键盘层调整它，用于删除或高亮。 */
    index: number;
}

/** 未指定会话时使用的键（新建会话前的"根"队列）。 */
const ROOT_KEY = "";

export class PendingQueue {
    private readonly queues = new Map<string, QueueState>();

    private stateOf(sessionId: string | null): QueueState {
        const key = sessionId ?? ROOT_KEY;
        let state = this.queues.get(key);
        if (!state) {
            state = { messages: [], index: 0 };
            this.queues.set(key, state);
        }
        return state;
    }

    messages(sessionId: string | null): PendingMessage[] {
        return this.stateOf(sessionId).messages;
    }

    /** 文本视图：带图片的消息退化成它的文本，供渲染与历史记录使用。 */
    textOf(sessionId: string | null, toText: (message: PendingMessage) => string): string[] {
        return this.stateOf(sessionId).messages.map(toText);
    }

    count(sessionId: string | null): number {
        return this.stateOf(sessionId).messages.length;
    }

    isEmpty(sessionId: string | null): boolean {
        return this.count(sessionId) === 0;
    }

    index(sessionId: string | null): number {
        return this.stateOf(sessionId).index;
    }

    /** 设置选中项；自动夹到合法区间，调用方不必自己判断越界。 */
    setIndex(sessionId: string | null, index: number): void {
        const state = this.stateOf(sessionId);
        if (state.messages.length === 0) {
            state.index = 0;
            return;
        }
        state.index = Math.max(0, Math.min(state.messages.length - 1, index));
    }

    /** 入队并选中最新一条（用户刚输入的内容总是他下一步想确认的）。 */
    push(sessionId: string | null, message: PendingMessage): void {
        const state = this.stateOf(sessionId);
        state.messages.push(message);
        state.index = state.messages.length - 1;
    }

    /** 整体替换（测试与草稿恢复使用）；索引随内容收敛。 */
    replace(sessionId: string | null, messages: PendingMessage[]): void {
        const state = this.stateOf(sessionId);
        state.messages = [...messages];
        if (state.messages.length === 0) state.index = 0;
        else if (state.index >= state.messages.length) state.index = state.messages.length - 1;
    }

    /**
     * 原子取走当前会话全部待发消息，索引归零。
     * 回合内每轮只消费一次：先取再渲染，避免"渲染时看到的"和"给模型的"不一致。
     */
    drain(sessionId: string | null): PendingMessage[] {
        const state = this.stateOf(sessionId);
        if (state.messages.length === 0) return [];
        const taken = state.messages.splice(0);
        state.index = 0;
        return taken;
    }

    /** 删除指定下标；越界返回 false。索引收敛到剩余范围。 */
    removeAt(sessionId: string | null, index: number): boolean {
        const state = this.stateOf(sessionId);
        if (index < 0 || index >= state.messages.length) return false;
        state.messages.splice(index, 1);
        if (state.messages.length === 0) state.index = 0;
        else if (state.index >= state.messages.length) state.index = state.messages.length - 1;
        return true;
    }

    /** 按对象身份移除已提交的 steering 消息。 */
    removeMessage(sessionId: string | null, message: PendingMessage): boolean {
        const index = this.stateOf(sessionId).messages.indexOf(message);
        return index >= 0 && this.removeAt(sessionId, index);
    }

    /** steer 回执按响应 ID 归属到仍在队列中的消息；同一响应的 steer 串行发送。 */
    updateSteerStatus(sessionId: string, responseId: string, state: "accepted" | "failed"): boolean {
        const messages = this.queues.get(sessionId)?.messages ?? [];
        const candidates = messages.filter((message): message is Exclude<PendingMessage, string> =>
            typeof message !== "string" && message.steer !== undefined);
        const message = candidates.find(item => item.steer?.responseId === responseId)
            ?? candidates.find(item => item.steer?.state === "sending" && !item.steer.responseId);
        if (!message?.steer) return false;
        message.steer = { state, responseId };
        return true;
    }

    /** 清空某会话队列（清空会话、新建、关闭、删除、退出时使用）。 */
    clear(sessionId: string | null): void {
        this.queues.delete(sessionId ?? ROOT_KEY);
    }

    /**
     * 把根队列（新建会话前输入的）整体搬到指定会话。
     * 新建会话时用户已经输入的内容要跟着走，否则消息会滞留在没人认领的根队列里。
     */
    adoptRoot(sessionId: string): void {
        const root = this.queues.get(ROOT_KEY);
        if (!root) return;
        this.queues.delete(ROOT_KEY);
        if (root.messages.length === 0) return;

        const target = this.stateOf(sessionId);
        target.messages = [...root.messages, ...target.messages];
        target.index = Math.max(0, target.messages.length - 1);
    }

    /**
     * 窗口化视图：只返回围绕选中项的一段，附带选中标记。
     * 属于纯计算，渲染层不必再各写一份窗口逻辑。
     */
    window(
        sessionId: string | null,
        maxVisible: number,
        toText: (message: PendingMessage) => string,
    ): Array<{ text: string; selected: boolean; ordinal: number }> {
        const state = this.stateOf(sessionId);
        const total = state.messages.length;
        if (total === 0) return [];

        const visible = Math.max(1, Math.min(maxVisible, total));
        // 围绕选中项居中，首尾自动贴边
        const half = Math.floor(visible / 2);
        let start = state.index - half;
        start = Math.max(0, Math.min(start, total - visible));

        return state.messages
            .slice(start, start + visible)
            .map((message, offset) => ({
                text: toText(message),
                selected: start + offset === state.index,
                ordinal: start + offset + 1,
            }));
    }
}
