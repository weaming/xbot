/**
 * TUI 专用 agent：在当前宿主机进程内管理会话、调用工具并转发渲染事件。
 *
 * 拆分后的职责：
 * - agent-types.ts   公共接口（TuiAgent / TuiSessionSummary / InstanceNetworkStats）与内部数据结构
 * - agent-summary.ts 会话摘要与实例用量聚合（纯函数）
 * - agent-turn.ts    turn 执行与上下文压缩（宿主能力经 TurnHost 注入）
 *
 * 本文件只负责：会话容器与生命周期、锁与并发保护、对外门面。
 */

import fs from "fs";
import { getOrCreateSessionSystemPrompt } from "../services/chat-runtime.js";
import { createEmptySession, SessionReplay } from "../events/session-replay.js";
import { EventLog } from "../events/event-log.js";
import { getSessionExchangeLogFile } from "../utils/logger.js";
import { appendInputHistory, loadInputHistory } from "./input-history.js";
import { getTuiSessionLogFile } from "../utils/tui-state-paths.js";
import { getTuiStartupCwd } from "./runtime-context.js";
import { DEFAULT_MEMORY_USER_ID, getSessionsDir, getSessionTodosFile, getToolCwd } from "../utils/runtime-paths.js";
import { planResume } from "../services/resume-plan.js";
import {
    formatInboundPrompt,
    SessionControl,
    type ClaimResult,
    type SessionControlHost,
} from "../control/channel.js";
import {
    setPeerResultHistory,
    setSessionControl,
    setSessionDirectory,
    type PeerResultRecord,
} from "../control/runtime.js";
import type { PeerMessage, PeerResult } from "../control/protocol.js";
import type { PeerOwnership } from "../control/registry.js";
import { sortSessions } from "../utils/session-order.js";
import { createUlid } from "../utils/ulid.js";
import { getShanghaiISOString } from "../utils/time.js";
import { acquireSessionLock, isSessionLockedByOtherSync, type SessionLockHandle } from "../utils/session-lock.js";
import { mergeUsage, type UIEvent } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { AgentEvent, AgentEventPayloads } from "../events/agent-events.js";
import type { Session } from "../types/session.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { aggregateInstanceUsage, summarizeEvents } from "./agent-summary.js";
import { compactSessionContext, runSessionTurn, type TurnHost } from "./agent-turn.js";
import type {
    ActiveSession,
    InstanceNetworkStats,
    SessionReleaseCause,
    TuiAgent,
    TuiSessionSummary,
    TurnSpec,
    TurnUserMessage,
} from "./agent-types.js";
import { toUserContent, type UserMessageInput } from "../types/image.js";
import { backgroundTaskManager } from "../tools/background-tasks.js";
import { deleteSessionImageAssets } from "../utils/image-assets.js";

export type { InstanceNetworkStats, TuiAgent, TuiSessionSummary } from "./agent-types.js";
export { summarizeEvents } from "./agent-summary.js";

/** 退出时等待进行中的 turn 落盘的上限，超时后放弃等待直接退出。 */
const CLOSE_FLUSH_TIMEOUT_MS = 3_000;
/** 回查会话间结果时扫描的日志尾部窗口：结果事件稀疏，多读一点免得漏。 */
const PEER_RESULT_SCAN_EVENTS = 2_000;

/** 初始化 TUI 所需的技能和 MCP 连接。 */
export async function initializeTuiAgentRuntime(): Promise<void> {
    const { skillRegistry } = await import("../skills/skill-registry.js");
    await skillRegistry.init();

    const { initMcpClients } = await import("../mcp/client-manager.js");
    await initMcpClients({ mode: "tui" });
}

interface TuiRuntimeReloadResult {
    skillCount: number;
    mcpServerCount: number;
    mcpToolCount: number;
}

export class LocalTuiAgent implements TuiAgent {
    // TUI 会话数据直接使用 sessions/ 根目录。
    private readonly eventLog = new EventLog();
    private readonly replay = new SessionReplay(this.eventLog);
    private readonly activeSessions = new Map<string, ActiveSession>();
    private readonly sessionOperations = new Set<string>();
    /** 本进程内各会话真实网络请求的用量聚合（退出时展示）。 */
    private readonly instanceUsage = new Map<string, UsageInfo>();
    /** 进行中的 turn（sendMessage 全流程），退出时用于等待中断落盘。 */
    private readonly inflightTurns = new Set<Promise<unknown>>();
    /** 已进入退出流程：不再接受新的驱动回合（结果留在队列里即可）。 */
    private isClosing = false;
    private nextRequestId = 1;
    /** turn 执行器所需的宿主能力，随实例生命周期固定。 */
    private readonly turnHost: TurnHost = {
        eventLog: this.eventLog,
        replay: this.replay,
        activeSessions: this.activeSessions,
        allocateRequestId: () => this.nextRequestId++,
        notify: (requestId, sessionId, event) => this.notify(requestId, sessionId, event),
        requireActiveSession: sessionId => this.requireActiveSession(sessionId),
        updateActiveSeq: (sessionId, seq) => this.updateActiveSeq(sessionId, seq),
        accumulateInstanceUsage: (sessionId, usage) => this.accumulateInstanceUsage(sessionId, usage),
        finishAndPersist: session => this.finishAndPersist(session),
        releaseSessionLockSafely: lock => this.releaseSessionLockSafely(lock),
        beginSessionOperation: sessionId => this.beginSessionOperation(sessionId),
        endSessionOperation: sessionId => this.endSessionOperation(sessionId),
    };

    onEvent?: (requestId: number, sessionId: string, event: UIEvent) => void;
    /** 回合结束回调：宿主据此放行排队的用户输入（见 TuiAgent.onTurnFinished）。 */
    onTurnFinished?: (sessionId: string) => void;
    /** 会话持有被释放（/close 主动关闭 / 被其他实例拿走）时的回调（见 TuiAgent.onSessionReleased）。 */
    onSessionReleased?: (sessionId: string, cause: SessionReleaseCause) => void;
    /** 模型派生新子会话时的回调（见 TuiAgent.onSessionSpawned）。 */
    onSessionSpawned?: (sessionId: string, title?: string) => void;

    /**
     * 会话间控制通道：归属（本进程 bind socket）、消息投递、结果回传。
     * 归属完全由 socket 文件表达，没有租约、心跳与 sidecar 元数据。
     */
    private readonly control: SessionControl;

    constructor(private readonly runtimeReady: Promise<void> = Promise.resolve()) {
        const host: SessionControlHost = {
            title: (sessionId) => this.activeSessions.get(sessionId)?.session.title,
            isBusy: (sessionId) => this.isSessionBusy(sessionId),
            createSession: (cwd) => this.createSession(cwd),
            sessionCwd: (sessionId) => this.getSessionCwd(sessionId),
            onSessionSpawned: (sessionId, title) => this.onSessionSpawned?.(sessionId, title),
            archiveSpawnedSession: async (sessionId, automatic) => {
                await this.closeSession(sessionId);
                this.releaseSession(sessionId, { cause: automatic ? "auto" : "tool" });
            },
            accept: (message) => this.acceptPeerMessage(message),
            onOutbound: (from, message) => {
                void this.recordPeerMessage(from, message, "out").catch((error) => {
                    console.error("⚠️ [TUI] 会话间消息落盘失败:", error);
                });
            },
            onResult: (requester, message, result, resultOptions) => {
                void this.recordPeerResult(requester, {
                    msgId: message.id,
                    peerId: message.to,
                    ok: result.ok,
                    ...(resultOptions?.late ? { late: true } : {}),
                    text: result.text,
                    stopReason: result.stopReason,
                    createdAt: getShanghaiISOString(),
                })
                    .catch((error) => {
                        console.error("⚠️ [TUI] 会话间结果落盘失败:", error);
                    })
                    // 结果落盘后再继续一轮，避免新回合的 user 消息插到结果卡之前
                    .finally(() => this.driveQueuedResults(requester));
            },
            onLost: (requester, msgIds, target) => this.notifyPeerLost(requester, msgIds, target),
            onReleased: (sessionId) => this.unloadSession(sessionId),
        };
        this.control = new SessionControl(host);
        // 会话间工具通过进程级单例取通道与目录，必须在任何请求前就位
        setSessionControl(this.control);
        setSessionDirectory({
            list: async () => {
                const sessions = await this.listSessions();
                return sessions
                    .filter(session => !session.archived)
                    .map(session => ({
                        sessionId: session.sessionId,
                        ...(session.title ? { title: session.title } : {}),
                    }));
            },
        });
        setPeerResultHistory({
            recentResults: (sessionId, limit) => this.recentPeerResults(sessionId, limit),
        });
    }

    // ── 会话间消息 ──────────────────────────────────────────────

    /** 落盘一条会话间消息（时间线事实源；出入站各一条）。 */
    async appendPeerMessage(sessionId: string, payload: AgentEventPayloads["peer_message"]): Promise<void> {
        await this.appendAgentEvent(sessionId, "peer_message", payload);
    }

    /** 落盘一条会话间结果（时间线事实源）。 */
    async appendPeerResult(sessionId: string, payload: AgentEventPayloads["peer_result"]): Promise<void> {
        await this.appendAgentEvent(sessionId, "peer_result", payload);
    }

    /** 时间线事实源事件的统一落盘入口：首事件自动补 session_created。 */
    private async appendAgentEvent<T extends "peer_message" | "peer_result">(
        sessionId: string,
        type: T,
        payload: AgentEventPayloads[T],
    ): Promise<void> {
        if ((await this.eventLog.lastSeq(sessionId)) === 0) {
            const cwd = this.activeSessions.get(sessionId)?.session.cwd ?? getTuiStartupCwd();
            const created = await this.eventLog.append(sessionId, "session_created", { cwd });
            this.updateActiveSeq(sessionId, created.seq);
        }
        const event = await this.eventLog.append(sessionId, type, payload);
        this.updateActiveSeq(sessionId, event.seq);
    }

    /** 进程级通道：工具（session_send / session_status）与 UI 共用。 */
    get sessionControl(): SessionControl {
        return this.control;
    }

    async claimSession(sessionId: string): Promise<ClaimResult> {
        return this.control.claim(sessionId);
    }

    releaseSession(sessionId: string, options: { cause?: SessionReleaseCause } = {}): void {
        this.control.release(sessionId);
        this.unloadSession(sessionId, options.cause ?? "peer");
    }

    isSessionClaimed(sessionId: string): boolean {
        return this.control.isClaimed(sessionId);
    }

    claimedSessionIds(): string[] {
        return this.control.claimedSessionIds;
    }

    probeSession(sessionId: string): Promise<PeerOwnership> {
        return this.control.probe(sessionId);
    }

    listSessionOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>> {
        return this.control.listOwnership(sessionIds);
    }

    takePeerResults(sessionId: string): string[] {
        return this.control.takeResults(sessionId);
    }

    /** 本实例在该会话上的待交付计数：等待别人回传 + 已就绪待附加。 */
    peerPendingStats(sessionId: string): { awaiting: number; queued: number } {
        return {
            awaiting: this.control.awaitingResults(sessionId),
            queued: this.control.queuedResults(sessionId),
        };
    }

    /** ⌃B：把本会话正在前台等待的会话间结果放入后台，结果到达后自动继续。 */
    detachPeerWaits(sessionId: string): number {
        return this.control.detachWaits(sessionId);
    }

    /**
     * 受理一条入站消息：先原子占住会话互斥（抢不到即忙，不落任何事实），
     * 再落盘时间线并启动本回合；回合结束时把最终输出回传给发起方。
     */
    private async acceptPeerMessage(message: PeerMessage): Promise<boolean> {
        const sessionId = message.to;
        try {
            this.beginSessionOperation(sessionId);
        } catch {
            return false;
        }

        try {
            // 先确保会话已进内存（标题、cwd 与后续回合都依赖它），再落盘时间线
            await this.requireActiveSession(sessionId);
            await this.recordPeerMessage(sessionId, message, "in");
        } catch (error) {
            this.endSessionOperation(sessionId);
            throw error;
        }

        this.trackTurn(sessionId, this.runPeerTurn(sessionId, message));
        return true;
    }

    /** 跑一轮"对方交付的"回合，并把最终输出作为结果回传。 */
    private async runPeerTurn(sessionId: string, message: PeerMessage): Promise<void> {
        const peerTitle = this.activeSessions.get(message.from)?.session.title;
        const prompt = formatInboundPrompt(message, peerTitle);
        let content = "";
        let stopReason = "stop";
        let failure: string | undefined;

        const spec: TurnSpec = {
            turnId: createUlid(),
            userMessages: [{ text: prompt, trigger: "peer" }],
            query: prompt,
            initialRequestKind: "peer_request",
            onEvent: (event) => {
                if (event.type === "message_end") {
                    content = event.content;
                    stopReason = event.stopReason;
                } else if (event.type === "aborted") {
                    stopReason = event.stopReason ?? "interrupted";
                } else if (event.type === "error") {
                    failure = event.message;
                }
            },
        };

        try {
            await this.runtimeReady;
            const outcome = await runSessionTurn(this.turnHost, sessionId, spec, { alreadyReserved: true });
            if (outcome.aborted && stopReason === "stop") stopReason = "aborted";
        } catch (error: any) {
            failure = error?.message ?? String(error);
            if (stopReason === "stop") stopReason = "error";
        } finally {
            const result: PeerResult = {
                msgId: message.id,
                ok: !failure,
                text: content,
                stopReason,
                ...(failure ? { error: failure } : {}),
            };
            try {
                this.control.completeInbound(sessionId, message, result);
            } catch (error) {
                console.error("⚠️ [TUI] 会话间结果回传失败:", error);
            }
        }
    }

    /** 落盘一条会话间消息并推给 UI：时间线在重启后也能还原。 */
    private async recordPeerMessage(sessionId: string, message: PeerMessage, direction: "in" | "out"): Promise<void> {
        const peerId = direction === "in" ? message.from : message.to;
        const peerTitle = this.activeSessions.get(peerId)?.session.title;
        const payload: AgentEventPayloads["peer_message"] = {
            msgId: message.id,
            direction,
            peerId,
            ...(peerTitle ? { peerTitle } : {}),
            text: message.text,
            ...(message.expectResult ? { expectResult: true } : {}),
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            createdAt: message.createdAt,
        };

        await this.appendPeerMessage(sessionId, payload);
        this.notify(this.nextRequestId++, sessionId, { type: "peer_message", ...payload });
    }

    /** 落盘一条结果并推给 UI：结果也是可复盘的事实，不能只留在内存。 */
    private async recordPeerResult(requester: string, payload: AgentEventPayloads["peer_result"]): Promise<void> {
        await this.appendAgentEvent(requester, "peer_result", payload);
        this.notify(this.nextRequestId++, requester, {
            type: "peer_result",
            msgId: payload.msgId,
            peerId: payload.peerId,
            ok: payload.ok,
            ...(payload.lost ? { lost: true } : {}),
            ...(payload.late ? { late: true } : {}),
            text: payload.text,
            ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
        });
    }

    private notifyPeerLost(requester: string, msgIds: string[], target: string): void {
        for (const msgId of msgIds) {
            void this.recordPeerResult(requester, {
                msgId,
                peerId: target,
                ok: false,
                lost: true,
                text: `等待会话 ${target} 的结果失败：对方未在期限内回传（进程可能已退出）`,
                createdAt: getShanghaiISOString(),
            }).catch((error) => {
                console.error("⚠️ [TUI] 会话间结果落盘失败:", error);
            });
        }
    }

    /** 会话被释放（被其他实例拿走 / 本实例主动关闭）：中止本地残留请求并清出内存，宿主负责同步 UI。 */
    private unloadSession(sessionId: string, cause: SessionReleaseCause = "peer"): void {
        const active = this.activeSessions.get(sessionId);
        active?.abortController?.abort();
        this.activeSessions.delete(sessionId);
        try {
            this.onSessionReleased?.(sessionId, cause);
        } catch {
            // 宿主回调异常不影响归属释放
        }
    }

    async createSession(cwd?: string): Promise<{ sessionId: string }> {
        const sessionId = createUlid();
        // 缺省 cwd 固定为 TUI 启动目录；TUI_CWD 随会话切换变化，不能作为新建会话默认值。
        const session = createEmptySession(sessionId, cwd ?? getTuiStartupCwd());
        this.activeSessions.set(sessionId, { session, lastSeq: 0 });
        return { sessionId };
    }

    async listSessions(): Promise<TuiSessionSummary[]> {
        const ids = this.listSavedSessionIds();
        for (const sessionId of this.activeSessions.keys()) ids.add(sessionId);
        const sessions: TuiSessionSummary[] = [];
        for (const sessionId of ids) {
            const events = await this.eventLog.read(sessionId);
            if (events.length > 0) {
                sessions.push(summarizeEvents(sessionId, events));
            }
        }
        return sortSessions(sessions);
    }

    /** 磁盘上已落盘的会话 id。 */
    listSavedSessionIds(): Set<string> {
        const ids = new Set<string>();
        try {
            for (const fileName of fs.readdirSync(getSessionsDir("events"))) {
                if (fileName.endsWith(".jsonl")) ids.add(fileName.slice(0, -".jsonl".length));
            }
        } catch {
            // 目录不存在时没有已保存会话。
        }
        return ids;
    }

    /** 本进程内存里正在使用的会话 id。 */
    listActiveSessionIds(): string[] {
        return [...this.activeSessions.keys()];
    }

    async readSessionEvents(sessionId: string): Promise<AgentEvent[]> {
        return this.eventLog.read(sessionId);
    }

    /** 丢弃某会话的缓存事件（清理后调用，避免用旧缓存把它又列出来）。 */
    forgetSession(sessionId: string): void {
        this.eventLog.forget(sessionId);
    }

    /** 会话最近收到的会话间结果（供 session_status 回查）：只扫日志尾部窗口。 */
    private async recentPeerResults(sessionId: string, limit: number): Promise<PeerResultRecord[]> {
        const lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        if (lastSeq === 0) return [];

        const fromSeq = Math.max(1, lastSeq - PEER_RESULT_SCAN_EVENTS + 1);
        const events = await this.eventLog.read(sessionId, fromSeq);
        const results: PeerResultRecord[] = [];
        for (const event of events) {
            if (event.type !== "peer_result") continue;
            results.push({
                peerId: event.payload.peerId,
                ...(event.payload.peerTitle ? { peerTitle: event.payload.peerTitle } : {}),
                ok: event.payload.ok,
                ...(event.payload.lost ? { lost: true } : {}),
                ...(event.payload.late ? { late: true } : {}),
                text: event.payload.text,
                ...(event.payload.stopReason ? { stopReason: event.payload.stopReason } : {}),
                createdAt: event.payload.createdAt,
            });
        }
        return results.slice(-limit);
    }

    async getSessionCwd(sessionId: string): Promise<string> {
        const active = this.activeSessions.get(sessionId);
        if (active) return active.session.cwd;
        const first = await this.eventLog.read(sessionId, 1, 1);
        if (first[0]?.type === "session_created") {
            // 旧事件无 cwd 字段时归一到当前工具目录。
            return first[0].payload.cwd || getToolCwd();
        }
        return getToolCwd();
    }

    async clearSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const session = await this.requireActiveSession(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
                throw new Error(`会话不存在: ${sessionId}`);
            }
            await this.eventLog.truncate(sessionId, 0);
            await this.replay.deleteSnapshot(sessionId);
            await deleteSessionImageAssets(sessionId);
            await this.eventLog.append(sessionId, "session_created", { cwd: getToolCwd() });
            if (session.modelSelection) {
                await this.eventLog.append(sessionId, "model_selected", session.modelSelection);
            }
            const replayed = await this.replay.replayTo(sessionId);
            this.activeSessions.set(sessionId, { session: replayed.session, lastSeq: replayed.lastSeq });
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async renameSession(sessionId: string, title: string): Promise<void> {
        const cleanTitle = title.trim().slice(0, 200);
        if (!cleanTitle) return;

        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const active = this.activeSessions.get(sessionId);
            if (active) active.session.title = cleanTitle;

            let lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
            if (lastSeq === 0) {
                // 空临时会话未落盘：先补 session_created（cwd 取绑定目录），让改名后的会话可持久化
                const created = await this.eventLog.append(sessionId, "session_created", {
                    cwd: active?.session.cwd ?? getToolCwd(),
                });
                lastSeq = created.seq;
            }
            const renamed = await this.eventLog.append(sessionId, "session_renamed", { title: cleanTitle });
            this.updateActiveSeq(sessionId, renamed.seq);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async getSessionModelSelection(sessionId: string): Promise<ChatModelSelection | undefined> {
        return (await this.requireActiveSession(sessionId)).modelSelection;
    }

    async setSessionModelSelection(sessionId: string, selection: ChatModelSelection): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const session = await this.requireActiveSession(sessionId);
            const lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
            if (lastSeq === 0) {
                const created = await this.eventLog.append(sessionId, "session_created", { cwd: session.cwd });
                this.updateActiveSeq(sessionId, created.seq);
            }

            const event = await this.eventLog.append(sessionId, "model_selected", selection);
            session.modelSelection = selection;
            this.updateActiveSeq(sessionId, event.seq);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            await this.eventLog.delete(sessionId);
            await this.replay.deleteSnapshot(sessionId);
            await deleteSessionImageAssets(sessionId);
            this.activeSessions.delete(sessionId);
            // 同步清理该会话的 console 日志。
            try {
                fs.unlinkSync(getTuiSessionLogFile(sessionId));
            } catch {
                // 日志文件不存在时无需处理。
            }
            // 同步清理该会话的 LLM 交换日志。
            try {
                fs.unlinkSync(getSessionExchangeLogFile(sessionId));
            } catch {
                // 日志文件不存在时无需处理。
            }
            // 同步清理该会话的任务清单。
            try {
                fs.unlinkSync(getSessionTodosFile(sessionId));
            } catch {
                // 文件不存在时无需处理。
            }
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    isSessionBusy(sessionId: string): boolean {
        if (this.sessionOperations.has(sessionId) || this.activeSessions.get(sessionId)?.abortController !== undefined) {
            return true;
        }
        return isSessionLockedByOtherSync(sessionId);
    }

    /** 当前会话是否被其他实例（进程）持有排他锁，本实例无法中止其请求。 */
    isSessionLockedByOther(sessionId: string): boolean {
        return isSessionLockedByOtherSync(sessionId);
    }

    async getSystemPrompt(sessionId: string): Promise<string> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const active = this.activeSessions.get(sessionId);
        if (active && active.lastSeq >= diskSeq) {
            return getOrCreateSessionSystemPrompt(active.session, { includeMemory: false, userId: DEFAULT_MEMORY_USER_ID });
        }

        if (diskSeq === 0) {
            if (active) return getOrCreateSessionSystemPrompt(active.session, { includeMemory: false, userId: DEFAULT_MEMORY_USER_ID });
            throw new Error(`会话不存在: ${sessionId}`);
        }

        const replayed = await this.replay.replayTo(sessionId);
        this.activeSessions.set(sessionId, {
            session: replayed.session,
            lastSeq: replayed.lastSeq,
            abortController: active?.abortController,
        });
        return getOrCreateSessionSystemPrompt(replayed.session, { includeMemory: false, userId: DEFAULT_MEMORY_USER_ID });
    }

    async closeSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) > 0) {
                await this.eventLog.append(sessionId, "session_archived", {});
            }
            this.activeSessions.delete(sessionId);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async unarchiveSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
                throw new Error(`会话不存在: ${sessionId}`);
            }
            await this.eventLog.append(sessionId, "session_unarchived", {});
            // 丢弃内存缓存，下次访问按新事件序列重放重建。
            this.activeSessions.delete(sessionId);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async sendMessage(
        sessionId: string,
        text: string,
        options?: {
            consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
            displayText?: string;
            images?: import("../types/image.js").ImageAssetRef[];
        },
    ): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
        if (!text.trim()) throw new Error("text 必填");
        // displayText 未传或为空串时退回 text，避免落一条空用户消息
        const current: TurnUserMessage = {
            text: options?.displayText || text,
            images: options?.images,
        };
        return this.trackTurn(sessionId, this.runTurn(sessionId, {
            turnId: createUlid(),
            // 等待中的会话间结果在前（下一次 HTTP 请求时附加），本轮驱动消息在后
            userMessages: [...this.pendingPeerUserMessages(sessionId), current],
            query: text,
            consumePendingMessages: options?.consumePendingMessages,
        }));
    }

    /**
     * 续跑：按续跑点补跑缺失的工具调用或直接发下一次请求。不插入任何用户消息，
     * 上游请求与中断前保持一致；没有可续跑点时直接返回原因。
     */
    async resumeSession(sessionId: string): Promise<{ resumed: boolean; reason?: string; aborted?: boolean }> {
        const session = await this.requireActiveSession(sessionId);
        const plan = planResume(session);
        if (!plan.canResume) return { resumed: false, reason: plan.reason };

        const result = await this.trackTurn(sessionId, this.runTurn(sessionId, {
            turnId: createUlid(),
            userMessages: [],
            query: "",
            skipUserQuery: true,
            pendingToolCalls: plan.toolCalls,
            skipToolCallIds: new Set(plan.toolCalls.map(call => call.id)),
            initialRequestKind: "turn_resume",
        }));
        return { resumed: true, aborted: result.aborted };
    }

    async abortSession(sessionId: string): Promise<boolean> {
        const active = this.activeSessions.get(sessionId);
        if (!active?.abortController) return false;
        active.abortController.abort();
        return true;
    }

    /** 取走等待附加的会话间结果，作为本轮请求前置的 user 消息。 */
    private pendingPeerUserMessages(sessionId: string): TurnUserMessage[] {
        return this.control.takeResults(sessionId).map(text => ({ text, trigger: "peer" as const }));
    }

    /**
     * 有待附加的会话间结果就继续一轮：结果到达时与回合结束时都调用，
     * 忙（或别的实例在跑）就先不动，结果原样留在队列里等下一次。
     * 结果文本作为本轮 user 消息（trigger=peer，不渲染成用户气泡），最后一条即本轮 query。
     */
    private driveQueuedResults(sessionId: string): void {
        if (this.isClosing) return;
        if (!this.activeSessions.has(sessionId)) return;
        if (this.control.queuedResults(sessionId) === 0) return;
        // 别的实例正在跑：不要取走结果，等它收尾或用户下次说话时再附加
        if (this.isSessionLockedByOther(sessionId)) return;
        // 先占住互斥再取结果：抢不到时结果必须原样留在队列里
        try {
            this.beginSessionOperation(sessionId);
        } catch {
            return;
        }

        const results = this.control.takeResults(sessionId);
        if (results.length === 0) {
            this.endSessionOperation(sessionId);
            return;
        }

        const spec: TurnSpec = {
            turnId: createUlid(),
            userMessages: results.map(text => ({ text, trigger: "peer" as const })),
            query: results[results.length - 1]!,
            initialRequestKind: "peer_request",
        };
        void this.trackTurn(sessionId, this.runtimeReady.then(() => runSessionTurn(this.turnHost, sessionId, spec, { alreadyReserved: true })))
            .catch((error) => {
                console.error("⚠️ [TUI] 会话间结果驱动失败:", error);
            });
    }

    /** 统计本实例内真实发起过网络请求的会话用量（退出时展示用）。 */
    getInstanceNetworkStats(): InstanceNetworkStats {
        return aggregateInstanceUsage(this.instanceUsage.values());
    }

    async compactSession(sessionId: string, instruction?: string): Promise<void> {
        await compactSessionContext(this.turnHost, sessionId, instruction);
    }

    loadInputHistory(sessionId: string): string[] {
        return loadInputHistory(sessionId);
    }

    async appendInputHistory(sessionId: string, text: string, ts?: string): Promise<void> {
        await appendInputHistory(sessionId, text, ts);
    }

    /**
     * 中止所有进行中的请求并等待其落盘：abort 后 runTurn 的 catch 分支会
     * 物化 interrupted turn（含已产生的工具段），否则进程退出会丢掉本轮上下文。
     */
    async close(): Promise<void> {
        this.isClosing = true;
        for (const active of this.activeSessions.values()) {
            active.abortController?.abort();
        }
        backgroundTaskManager.stopAll();
        // 释放全部 socket 与连接：让等待接管的实例能立刻认领
        this.control.close();
        if (this.inflightTurns.size === 0) return;
        const inflight = Promise.allSettled([...this.inflightTurns]);
        const timeout = new Promise<void>(resolve => {
            setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS);
        });
        await Promise.race([inflight, timeout]);
    }

    /** 重读磁盘技能和 MCP 工具，并清理当前进程中的 system prompt 缓存。 */
    async reloadRuntime(): Promise<TuiRuntimeReloadResult> {
        const [{ skillRegistry }, mcp] = await Promise.all([
            import("../skills/skill-registry.js"),
            import("../mcp/client-manager.js"),
        ]);

        await Promise.all([
            skillRegistry.reload(),
            mcp.reloadMcpClients({ mode: "tui" }),
        ]);

        for (const active of this.activeSessions.values()) {
            delete active.session.cachedSystemPrompt;
            delete active.session.cachedSystemPromptIncludesMemory;
            delete active.session.cachedSystemPromptUserId;
            delete active.session.cachedSystemPromptCwd;
            delete active.session.cachedSystemPromptRuntimeFingerprint;
        }

        const statuses = mcp.getMcpServersStatus();
        return {
            skillCount: skillRegistry.getAllSkillMetas().length,
            mcpServerCount: statuses.length,
            mcpToolCount: statuses.reduce((sum, status) => sum + status.toolNames.length, 0),
        };
    }

    private async runTurn(
        sessionId: string,
        spec: TurnSpec,
    ): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
        await this.runtimeReady;
        if (this.isClosing) throw new Error("TUI 已关闭，无法开始回合");
        return runSessionTurn(this.turnHost, sessionId, spec);
    }

    private async trackTurn<T>(sessionId: string, turn: Promise<T>): Promise<T> {
        this.inflightTurns.add(turn);
        try {
            return await turn;
        } finally {
            this.inflightTurns.delete(turn);
            // 回合结束后通知宿主：群消息驱动等非用户回合也要放行排队的输入
            try {
                this.onTurnFinished?.(sessionId);
            } catch {
                // 宿主回调异常不影响回合结果
            }
            // 回合执行期间到达、当时没能驱动的结果，在这里补一次
            this.driveQueuedResults(sessionId);
        }
    }

    private async requireActiveSession(sessionId: string): Promise<Session> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const active = this.activeSessions.get(sessionId);

        // 内存缓存未落后磁盘 seq，直接复用
        if (active && active.lastSeq >= diskSeq) {
            return active.session;
        }

        if (diskSeq === 0) {
            if (active) return active.session;
            throw new Error(`会话不存在: ${sessionId}`);
        }

        const tail = await this.eventLog.read(sessionId, diskSeq, 1);
        if (tail[0]?.type === "session_archived") {
            throw new Error(`会话已归档，请先取消归档: ${sessionId}`);
        }

        // 磁盘有新事件（如被其他实例推进），增量/全量重放更新内存缓存
        const replayed = await this.replay.replayTo(sessionId);
        this.activeSessions.set(sessionId, {
            session: replayed.session,
            lastSeq: replayed.lastSeq,
            abortController: active?.abortController,
        });
        return replayed.session;
    }

    private updateActiveSeq(sessionId: string, seq: number): void {
        const active = this.activeSessions.get(sessionId);
        if (active && seq > active.lastSeq) {
            active.lastSeq = seq;
        }
    }

    private beginSessionOperation(sessionId: string): void {
        if (this.sessionOperations.has(sessionId) || this.activeSessions.get(sessionId)?.abortController !== undefined) {
            throw new Error("busy: 有请求处理中，请先中止当前请求");
        }
        this.sessionOperations.add(sessionId);
    }

    private endSessionOperation(sessionId: string): void {
        this.sessionOperations.delete(sessionId);
    }

    private accumulateInstanceUsage(sessionId: string, usage: UsageInfo): void {
        if (!usage.requestCount) return;
        const prev = this.instanceUsage.get(sessionId);
        this.instanceUsage.set(sessionId, prev ? mergeUsage(prev, usage) : usage);
    }

    private async releaseSessionLockSafely(lock: SessionLockHandle | undefined): Promise<void> {
        if (!lock) return;
        try {
            await lock.release();
        } catch (error) {
            console.error(`⚠️ [TUI] 释放会话锁失败 (${lock.sessionId}):`, error);
        }
    }

    private async finishAndPersist(session: Session): Promise<void> {
        const active = this.activeSessions.get(session.sessionId);
        if (active) delete active.abortController;
        await this.replay.writeSnapshotIfDue(session.sessionId, session);
    }

    private notify(requestId: number, sessionId: string, event: UIEvent): void {
        this.onEvent?.(requestId, sessionId, event);
    }
}
