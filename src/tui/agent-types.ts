/**
 * TUI agent 的公共类型与内部数据结构。
 * 公共接口（TuiAgent / TuiSessionSummary / InstanceNetworkStats）由 agent.ts 统一 re-export。
 */

import type { UIEvent } from "../events/ui-events.js";
import type { AgentEvent, AgentEventPayloads } from "../events/agent-events.js";
import type { ClaimResult } from "../control/channel.js";
import type { PeerOwnership } from "../control/registry.js";
import type { Session } from "../types/session.js";
import type { ToolCall } from "../types/tool-call.js";
import type { LLMRequestKind } from "../utils/logger.js";
import type { ImageAssetRef, UserMessageInput } from "../types/image.js";
import type { ChatModelSelection } from "../types/chat-model.js";

export interface TuiSessionSummary {
    sessionId: string;
    createdAt?: string;
    updatedAt?: string;
    messageCount: number;
    lastUserMessage?: string;
    /** 会话标题：显式重命名优先，否则取首条用户消息（tab 固定展示，不随对话变化）。 */
    title?: string;
    archivedAt?: string;
    archived?: boolean;
    modelSelection?: ChatModelSelection;
}

/** 本实例（进程）内真正发起过网络请求（LLM 调用）的用量聚合。 */
export interface InstanceNetworkStats {
    /** 有过网络请求的会话数。 */
    sessionCount: number;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
}

/**
 * 会话释放的发起方：`peer` 被其他实例协商拿走，`user` 本实例主动关闭（/close）。
 * 宿主据此区分收尾文案，但两者都要把会话从 tab 条与内存里摘掉。
 */
export type SessionReleaseCause = "peer" | "user" | "tool" | "auto";

export interface TuiAgent {
    onEvent?: (requestId: number, sessionId: string, event: UIEvent) => void;
    /** 新建会话（内存态，未认领）；cwd 缺省用 TUI 启动目录。 */
    createSession(cwd?: string): Promise<{ sessionId: string }>;
    listSessions(): Promise<TuiSessionSummary[]>;
    /** 本进程内存里正在使用的会话 id（清理时必须跳过，避免删掉活跃会话）。 */
    listActiveSessionIds(): string[];
    /** 丢弃该会话的进程内缓存（磁盘上的日志已删除时调用）。 */
    forgetSession(sessionId: string): void;
    readSessionEvents(sessionId: string): Promise<AgentEvent[]>;
    clearSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    isSessionBusy(sessionId: string): boolean;
    /** 当前会话是否被其他实例（进程）持有排他锁，本实例无法中止其请求。 */
    isSessionLockedByOther(sessionId: string): boolean;
    getSystemPrompt(sessionId: string): Promise<string>;
    /** 重读磁盘技能与 MCP 工具，并让后续请求使用新的运行时上下文。 */
    reloadRuntime(): Promise<{ skillCount: number; mcpServerCount: number; mcpToolCount: number }>;
    closeSession(sessionId: string): Promise<void>;
    /** 取消归档：追加 session_unarchived 事件，使会话重新可写。 */
    unarchiveSession(sessionId: string): Promise<void>;
    /**
     * 发送一条用户消息并驱动一轮 LLM。
     * displayText 只影响落盘与历史：群消息把带行动指令的 prompt 发给模型，
     * 但会话历史与重启后的时间线只保留原始消息，避免指令文本被当作用户输入。
     */
    sendMessage(
        sessionId: string,
        text: string,
        options?: {
            consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
            displayText?: string;
            images?: ImageAssetRef[];
        },
    ): Promise<{ aborted?: boolean; contextTrimmed?: boolean }>;
    /** 续跑：按续跑点补跑缺失工具或直接发请求；无可续跑点时返回原因。 */
    resumeSession(
        sessionId: string,
        options?: { consumePendingMessages?: () => Array<string | UserMessageInput> | undefined },
    ): Promise<{ resumed: boolean; reason?: string; aborted?: boolean }>;
    abortSession(sessionId: string): Promise<boolean>;
    compactSession(sessionId: string, instruction?: string): Promise<void>;
    /** 本实例内发起过网络请求的会话用量统计（退出时展示用）。 */
    getInstanceNetworkStats(): InstanceNetworkStats;
    loadInputHistory(sessionId: string): string[];
    appendInputHistory(sessionId: string, text: string, ts?: string): Promise<void>;
    /** 会话绑定的工作目录（无持久化记录时回退当前工具目录）。 */
    getSessionCwd(sessionId: string): Promise<string>;
    /** 重命名会话标题：空会话先落盘再记录，标题为空时不生效。 */
    renameSession(sessionId: string, title: string): Promise<void>;
    getSessionModelSelection(sessionId: string): Promise<ChatModelSelection | undefined>;
    setSessionModelSelection(sessionId: string, selection: ChatModelSelection): Promise<void>;
    /** 落盘一条会话间消息（时间线事实源；出入站各一条）。 */
    appendPeerMessage(sessionId: string, payload: AgentEventPayloads["peer_message"]): Promise<void>;
    /**
     * 认领会话：本实例成为该会话的唯一持有者。
     * 被其他实例持有时发起协商式转移，持有者忙或无应答则失败（绝不夺权）。
     */
    claimSession(sessionId: string): Promise<ClaimResult>;
    /**
     * 放弃会话持有：关闭监听、释放 socket 文件，并摘掉本实例的内存视图。
     * 事件日志不动，别的实例（或本实例面板）随后可重新认领。
     */
    releaseSession(sessionId: string, options?: { cause?: SessionReleaseCause }): void;
    isSessionClaimed(sessionId: string): boolean;
    /** 本实例当前持有的会话 id。 */
    claimedSessionIds(): string[];
    /** 探测会话归属（不触发认领）。 */
    probeSession(sessionId: string): Promise<PeerOwnership>;
    listSessionOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>>;
    /** 取走等待附加的会话间结果（下一次 HTTP 请求用），取后即清。 */
    takePeerResults(sessionId: string): string[];
    /** 本实例在该会话上的待交付计数：等待别人回传 + 已就绪待附加。 */
    peerPendingStats(sessionId: string): { awaiting: number; queued: number };
    /**
     * 把该会话正在前台等待（session_send 的 wait_seconds）的结果放入后台；
     * 返回放下的等待数，0 表示当前没有在等的会话结果。
     */
    detachPeerWaits(sessionId: string): number;
    /**
     * 持有权释放时的回调：宿主据此把会话从 tabs / 内存状态摘掉。
     * 与 onTurnFinished 同理，非用户主动发起的状态变化也要让宿主知情。
     */
    onSessionReleased?: (sessionId: string, cause: SessionReleaseCause) => void;
    /**
     * 模型派生了新的子会话（session_spawn）时回调：宿主据此把会话加进列表并固化标题。
     * 与 onSessionReleased 同理，非用户主动发起的状态变化也要让宿主知情。
     */
    onSessionSpawned?: (sessionId: string, title?: string) => void;
    /**
     * 回合真正结束（会话锁已释放）时回调，宿主据此放行排队的用户输入。
     * 非用户发起的回合（群消息驱动、回写追问、续跑）不会经过 ChatApp.send，
     * 没有这个通知时排队的输入会一直等到用户切会话才发出去。
     */
    onTurnFinished?: (sessionId: string) => void;
    /** 中止所有进行中的请求并等待其落盘（退出前调用，避免 turn 丢失）。 */
    close(): Promise<void>;
}

export interface ActiveSession {
    session: Session;
    lastSeq: number;
    abortController?: AbortController;
}

/** 一次 turn 的请求规格：普通消息与续跑共用同一条执行路径。 */
/** 一条进会话历史的用户消息：会话间消息/结果注入时标记 trigger。 */
export interface TurnUserMessage {
    text: string;
    images?: ImageAssetRef[];
    /** 该条消息的来源：决定事件 trigger 与时间线渲染（peer = 会话间消息/结果）。 */
    trigger?: "user" | "peer";
}

/** 一次 turn 的请求规格：普通消息与续跑共用同一条执行路径。 */
export interface TurnSpec {
    turnId: string;
    /** 逐条落盘 user_message 并进历史；最后一条是本轮驱动消息，续跑为空（对上游无感）。 */
    userMessages: TurnUserMessage[];
    query: string;
    skipUserQuery?: boolean;
    pendingToolCalls?: ToolCall[];
    /** 续跑时跳过历史修复的调用 id（会由 pendingToolCalls 补上真实结果）。 */
    skipToolCallIds?: ReadonlySet<string>;
    consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
    initialRequestKind?: Exclude<LLMRequestKind, "tool_response">;
    /** 观察本回合的事件流（会话间交付捕获收尾输出用）；不参与事件分发。 */
    onEvent?: (event: UIEvent) => void;
}
