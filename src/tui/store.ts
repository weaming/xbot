/**
 * TUI 状态层：会话级 UI 状态容器与对外门面。
 *
 * 拆分后的职责：
 * - store-types.ts     公共类型与会话状态形状
 * - store-message.ts   消息 / 工具块原语（纯函数）
 * - store-usage.ts     token、费用与生成速率累计（纯函数）
 * - store-projector.ts 渲染事件流投影（UIEvent → state）
 * - store-history.ts   领域事件重放投影（AgentEvent[] → state）
 *
 * 本文件只负责：会话容器与切换、监听器通知、对外查询与操作入口。
 */

import type { UIEvent } from "../events/ui-events.js";
import type { AgentEvent } from "../events/agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import { sortSessions } from "../utils/session-order.js";
import { createMessage, insertMessage } from "./store-message.js";
import { applyAgentEvent, type ProjectionDeps } from "./store-projector.js";
import { projectHistory } from "./store-history.js";
import {
    createSessionUiState,
    type ChatStoreOptions,
    type RequestRate,
    type SessionUiState,
    type SessionView,
    type StoreListeners,
    type ToolBlock,
    type UiMessage,
} from "./store-types.js";

export type {
    AssistantTimelineItem,
    ChatStoreOptions,
    RequestRate,
    SessionView,
    StoreListeners,
    ToolBlock,
    UiMessage,
} from "./store-types.js";

export class ChatStore {
    sessions: SessionView[] = [];
    currentSessionId: string | null = null;

    private currentState = createSessionUiState();
    private readonly sessionStates = new Map<string, SessionUiState>();
    private isBackgroundEvent = false;
    private readonly costFor?: (usage: UsageInfo, atMs: number) => number;

    private seq = 0;
    private blockSeq = 0;
    private listeners: StoreListeners | null = null;
    /** 消息 / 工具块索引：消息集变更后惰性重建，避免每次查找线性扫描。 */
    private messagesById = new Map<number, UiMessage>();
    private blocksById = new Map<number, ToolBlock>();
    private indexDirty = true;
    /** 索引对应的消息数组：切换会话 / 重放会整表替换，身份变了就必须重建（仅靠 dirty 标记会漏）。 */
    private indexOwner?: UiMessage[];
    /** 投影回调集合：id 分配、通知与计费器，随实例生命周期固定。 */
    private readonly deps: ProjectionDeps;

    constructor(options: ChatStoreOptions = {}) {
        this.costFor = options.costFor;
        this.deps = {
            nextMessageId: () => ++this.seq,
            nextBlockId: () => ++this.blockSeq,
            notifyMessages: () => this.notifyMessages(),
            notifyStatus: () => this.notifyStatus(),
            costFor: this.costFor,
        };
    }

    get messages(): UiMessage[] {
        return this.currentState.messages;
    }

    set messages(value: UiMessage[]) {
        this.currentState.messages = value;
    }

    get totalTokens(): number {
        return this.currentState.totalTokens;
    }

    get promptTokens(): number {
        return this.currentState.promptTokens;
    }

    get completionTokens(): number {
        return this.currentState.completionTokens;
    }

    get reasoningTokens(): number {
        return this.currentState.reasoningTokens;
    }

    get cacheHitTokens(): number {
        return this.currentState.cacheHitTokens;
    }

    get cacheMissTokens(): number {
        return this.currentState.cacheMissTokens;
    }

    get latestPromptTokens(): number {
        return this.currentState.latestPromptTokens;
    }

    get costYuan(): number {
        return this.currentState.costYuan;
    }

    get lastRate(): RequestRate | undefined {
        return this.currentState.lastRate;
    }

    setListeners(listeners: StoreListeners): void {
        this.listeners = listeners;
    }

    getMessageById(id: number): UiMessage | undefined {
        this.ensureIndex();
        return this.messagesById.get(id);
    }

    private getSessionState(sessionId?: string): SessionUiState {
        if (!sessionId || sessionId === this.currentSessionId) {
            return this.currentState;
        }
        let state = this.sessionStates.get(sessionId);
        if (!state) {
            state = createSessionUiState();
            this.sessionStates.set(sessionId, state);
        }
        return state;
    }

    getMessages(sessionId?: string): UiMessage[] {
        return this.getSessionState(sessionId).messages;
    }

    pushSystemMessage(text: string, sessionId?: string, peer?: UiMessage["peer"]): void {
        const state = this.getSessionState(sessionId);
        insertMessage(state.messages, this.newMessage({ role: "system", text, ...(peer ? { peer } : {}) }));
        if (!sessionId || sessionId === this.currentSessionId) {
            this.notifyMessages();
        }
    }

    /** 渲染事件流（来自 client.onEvent）。 */
    applyEvent(requestId: number, sessionId: string, event: UIEvent): void {
        const isCurrentSession = this.currentSessionId === sessionId;
        const previousState = this.currentState;
        if (!isCurrentSession) {
            this.currentState = this.sessionStates.get(sessionId) ?? createSessionUiState();
            this.sessionStates.set(sessionId, this.currentState);
        }
        const previousBackgroundState = this.isBackgroundEvent;
        this.isBackgroundEvent = !isCurrentSession;

        try {
            applyAgentEvent(this.currentState, requestId, event, this.deps);
        } finally {
            this.isBackgroundEvent = previousBackgroundState;
            if (!isCurrentSession) this.currentState = previousState;
        }
    }

    /** 用户发出消息时本地追加 user 消息。 */
    addUserMessage(text: string, sessionId?: string): void {
        const state = this.getSessionState(sessionId);
        insertMessage(state.messages, this.newMessage({ role: "user", text }));
        if (!sessionId || sessionId === this.currentSessionId) {
            this.notifyMessages();
        }
    }

    /** 消费执行期间新进入的 pending 消息并进入当前 assistant 消息时间线。 */
    addPendingUserMessage(text: string, sessionId?: string): void {
        const state = this.getSessionState(sessionId);
        const assistant = state.activeAssistant;
        if (assistant) {
            assistant.timeline ??= [];
            assistant.timeline.push({ type: "user", text });
            assistant.sortKey = Date.now();
            // 注入的用户消息自成一段：此后群消息排在它之后
            state.activeChatAnchor = assistant.timeline.length;
            if (!sessionId || sessionId === this.currentSessionId) {
                this.notifyMessages();
            }
            return;
        }
        this.addUserMessage(text, sessionId);
    }

    /** 领域事件历史 → 消息列表（切换会话时全量重建）。 */
    loadHistory(events: AgentEvent[], sessionId?: string): void {
        const state = this.getSessionState(sessionId);
        const isCurrent = !sessionId || sessionId === this.currentSessionId;
        projectHistory(state, events, this.deps, isCurrent);
        if (isCurrent) {
            this.listeners?.onStatusChanged();
        }
    }

    setSessions(sessions: SessionView[]): void {
        this.sessions = sortSessions(sessions);
        this.listeners?.onSessionsChanged();
    }

    setCurrentSession(sessionId: string | null): void {
        if (this.currentSessionId) {
            this.sessionStates.set(this.currentSessionId, this.currentState);
        }
        this.currentSessionId = sessionId;
        this.currentState = (sessionId ? this.sessionStates.get(sessionId) : undefined) ?? createSessionUiState();
        this.listeners?.onStatusChanged();
    }

    hasSessionView(sessionId: string): boolean {
        return this.sessionStates.has(sessionId);
    }

    removeSessionView(sessionId: string): void {
        this.sessionStates.delete(sessionId);
    }

    refreshView(): void {
        this.notifyMessages();
        this.notifyStatus();
    }

    /** 展开/收起单条工具调用块。 */
    toggleToolBlock(blockId: number): void {
        const block = this.findToolBlock(blockId);
        if (!block) return;
        block.expanded = !block.expanded;
        this.notifyMessages();
    }

    /** 全局设置所有工具块展开状态（Ctrl+O 详细模式）。 */
    setAllToolBlocksExpanded(expanded: boolean, notify = true): void {
        let changed = false;
        this.ensureIndex();
        for (const block of this.blocksById.values()) {
            if (block.expanded !== expanded) {
                block.expanded = expanded;
                changed = true;
            }
        }
        if (changed && notify) {
            this.notifyMessages();
        }
    }

    getToolBlock(blockId: number): ToolBlock | undefined {
        this.ensureIndex();
        return this.blocksById.get(blockId);
    }

    private newMessage(
        partial: Omit<UiMessage, "id" | "streaming" | "sortKey"> & { streaming?: boolean; sortKey?: number },
    ): UiMessage {
        return createMessage(this.deps.nextMessageId, partial);
    }

    private notifyMessages(): void {
        // 消息集可能已变，索引标脏；下次查找时惰性重建。
        this.indexDirty = true;
        if (!this.isBackgroundEvent) this.listeners?.onMessagesChanged();
    }

    /** 消息集变更后按需重建 id 索引（O(n) 一次），后续查找 O(1)。 */
    private ensureIndex(): void {
        const owner = this.currentState.messages;
        if (!this.indexDirty && this.indexOwner === owner) return;
        this.messagesById = new Map();
        this.blocksById = new Map();
        for (const message of owner) {
            this.messagesById.set(message.id, message);
            for (const block of message.toolBlocks ?? []) {
                this.blocksById.set(block.id, block);
            }
        }
        this.indexOwner = owner;
        this.indexDirty = false;
    }

    private notifyStatus(): void {
        if (!this.isBackgroundEvent) this.listeners?.onStatusChanged();
    }

    private findToolBlock(blockId: number): ToolBlock | undefined {
        this.ensureIndex();
        return this.blocksById.get(blockId);
    }
}
