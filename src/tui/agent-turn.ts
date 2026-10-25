/**
 * turn 执行与上下文压缩：加锁 → 共享骨架执行（services/run-turn）→ 快照与用量收尾。
 * 宿主能力（事件日志、内存会话、锁、通知）通过 TurnHost 注入，便于脱离 TUI 单测。
 */

import { runTurnCore } from "../services/run-turn.js";
import {
    buildConversationHistory,
    getChatApiSettings,
    getOrCreateSessionSystemPrompt,
    runChatQuery,
} from "../services/chat-runtime.js";
import { buildCompactPrompt } from "../utils/compaction-prompt.js";
import { applyCompaction, autoCompactIfNeeded, buildCompactionHistory, findCompactionKeepFromPosition, planCompaction } from "../services/auto-compact.js";
import { acquireSessionLock, type SessionLockHandle } from "../utils/session-lock.js";
import { DEFAULT_MEMORY_USER_ID } from "../utils/runtime-paths.js";
import { emptyUsage, mergeUsage, type UIEvent } from "../events/ui-events.js";
import type { EventLog } from "../events/event-log.js";
import type { SessionReplay } from "../events/session-replay.js";
import type { UsageInfo } from "../types/chat.js";
import type { Session } from "../types/session.js";
import type { ActiveSession, TurnSpec } from "./agent-types.js";
import { toUserContent, type UserMessageInput } from "../types/image.js";
import { repairEmptyAssistantHistory } from "../utils/conversation-history.js";

/** turn 执行所需的宿主能力。 */
export interface TurnHost {
    eventLog: EventLog;
    replay: SessionReplay;
    activeSessions: Map<string, ActiveSession>;
    /** 分配请求 id（单调递增）。 */
    allocateRequestId(): number;
    notify(requestId: number, sessionId: string, event: UIEvent): void;
    requireActiveSession(sessionId: string): Promise<Session>;
    updateActiveSeq(sessionId: string, seq: number): void;
    accumulateInstanceUsage(sessionId: string, usage: UsageInfo): void;
    finishAndPersist(session: Session): Promise<void>;
    releaseSessionLockSafely(lock: SessionLockHandle | undefined): Promise<void>;
    beginSessionOperation(sessionId: string): void;
    endSessionOperation(sessionId: string): void;
}

/** 单个 turn：加锁 → 共享骨架执行 → 快照与用量收尾。 */
export async function runSessionTurn(
    host: TurnHost,
    sessionId: string,
    spec: TurnSpec,
    options: { alreadyReserved?: boolean } = {},
): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
    // 会话间投递在回 ack 前就已抢到互斥（见 LocalTuiAgent.acceptPeerMessage），
    // 这条路径不能再抢一次，否则自己把自己判成 busy。
    if (!options.alreadyReserved) host.beginSessionOperation(sessionId);
    const { turnId } = spec;
    const userMessages: UserMessageInput[] = spec.userMessages.map(message => ({
        text: message.text,
        images: message.images,
    }));

    const abortController = new AbortController();
    const requestId = host.allocateRequestId();
    let turnUsage = emptyUsage();
    let session: Session | undefined;
    let lock: SessionLockHandle | undefined;

    try {
        lock = await acquireSessionLock(sessionId);
        session = await host.requireActiveSession(sessionId);
        host.activeSessions.set(sessionId, {
            session,
            lastSeq: host.activeSessions.get(sessionId)?.lastSeq ?? 0,
            abortController,
        });
        const activeSession = session;

        const outcome = await runTurnCore({
            session: activeSession,
            turnId,
            userMessages,
            query: spec.query,
            queryContent: userMessages.at(-1) ? toUserContent(userMessages.at(-1)!) : undefined,
            systemPrompt: getOrCreateSessionSystemPrompt(activeSession, { includeMemory: false, userId: DEFAULT_MEMORY_USER_ID }),
            buildHistory: () =>
                buildConversationHistory(activeSession, userMessages, { skipToolCallIds: spec.skipToolCallIds }),
            signal: abortController.signal,
            userId: DEFAULT_MEMORY_USER_ID,
            cwd: activeSession.cwd,
            skipUserQuery: spec.skipUserQuery,
            pendingToolCalls: spec.pendingToolCalls,
            initialRequestKind: spec.initialRequestKind,
            consumePendingMessages: spec.consumePendingMessages,
            autoCompactActiveTurn: !spec.skipUserQuery,
            compactOnProviderOverflow: Boolean(spec.skipUserQuery),
        }, {
            persistUserMessages: async (texts, tid) => {
                if ((await host.eventLog.lastSeq(sessionId)) === 0) {
                    const created = await host.eventLog.append(sessionId, "session_created", { cwd: activeSession.cwd });
                    host.updateActiveSeq(sessionId, created.seq);
                }
                for (const [index, input] of texts.entries()) {
                    const userInput = typeof input === "string" ? { text: input } : input;
                    const appended = await host.eventLog.append(sessionId, "user_message", {
                        text: userInput.text,
                        ...(userInput.images?.length ? { images: userInput.images } : {}),
                        turnId: tid,
                        trigger: spec.userMessages[index]?.trigger ?? "user",
                    });
                    host.updateActiveSeq(sessionId, appended.seq);
                }
            },
            persistPendingMessage: async (input, tid) => {
                const userInput = typeof input === "string" ? { text: input } : input;
                const appended = await host.eventLog.append(sessionId, "user_message", {
                    text: userInput.text,
                    ...(userInput.images?.length ? { images: userInput.images } : {}),
                    turnId: tid,
                    trigger: "pending",
                });
                host.updateActiveSeq(sessionId, appended.seq);
            },
            persistTurnMessage: async (message, tid) => {
                const appended = await host.eventLog.append(sessionId, "turn_message", { turnId: tid, message });
                host.updateActiveSeq(sessionId, appended.seq);
                return appended.seq;
            },
            persistStreamDelta: async (delta, tid, requestIndex) => {
                const appended = await host.eventLog.append(sessionId, "turn_stream_delta", {
                    turnId: tid,
                    requestIndex,
                    delta,
                });
                host.updateActiveSeq(sessionId, appended.seq);
            },
            persistSegmentStart: async payload => {
                const appended = await host.eventLog.append(sessionId, "turn_segment_start", payload);
                host.updateActiveSeq(sessionId, appended.seq);
                return appended.seq;
            },
            persistTurn: async payload => {
                await host.replay.appendAgentEvent(activeSession, "turn_commit", payload, false);
                host.updateActiveSeq(sessionId, await host.eventLog.lastSeq(sessionId, { forceRefresh: true }));
            },
            // 续跑不做预压缩：压缩会把待补的 assistant(tool_calls) 前缀摘要掉，工具结果会悬空
            autoCompact: spec.skipUserQuery ? undefined : async () => {
                const result = await autoCompactIfNeeded(activeSession, {
                    model: getChatApiSettings(activeSession.modelSelection).model,
                    userId: DEFAULT_MEMORY_USER_ID,
                    sessionId,
                    signal: abortController.signal,
                    onProgress: message => host.notify(requestId, sessionId, { type: "progress", message }),
                    onUsage: usage => host.notify(requestId, sessionId, { type: "usage", usage }),
                    persistCompactedEvent: async ({ compactedContext, keepFromMessageId, keepFromPosition, usage }) => {
                        const event = await host.eventLog.append(sessionId, "context_compacted", {
                            compactedContext,
                            ...(keepFromMessageId ? { keepFromMessageId } : {}),
                            ...(keepFromPosition ? { keepFromPosition } : {}),
                            usage,
                        });
                        host.updateActiveSeq(sessionId, event.seq);
                    },
                });
                return result.wasCompacted ? undefined : result.usage;
            },
            onEvent: event => {
                // 会话间交付需要捕获本回合的收尾输出（结果回传）；不改变事件流本身
                spec.onEvent?.(event);
                host.notify(requestId, sessionId, event);
            },
        });

        turnUsage = outcome.usage;
        if (outcome.hasInvalidAssistantHistory) {
            const event = await host.eventLog.append(sessionId, "assistant_history_repaired", {});
            host.updateActiveSeq(sessionId, event.seq);
            repairEmptyAssistantHistory(activeSession);
            await host.replay.writeSnapshotIfDue(sessionId, activeSession);
        }
        if (outcome.aborted) return { aborted: true };
        if (outcome.error) {
            throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
        return {};
    } finally {
        try {
            if (session) {
                host.accumulateInstanceUsage(sessionId, turnUsage);
                await host.finishAndPersist(session);
            } else {
                const active = host.activeSessions.get(sessionId);
                if (active) delete active.abortController;
            }
        } finally {
            try {
                await host.releaseSessionLockSafely(lock);
            } finally {
                host.endSessionOperation(sessionId);
            }
        }
    }
}

/** 手动压缩会话上下文：写入 context_compacted 事件并同步内存会话。 */
export async function compactSessionContext(
    host: TurnHost,
    sessionId: string,
    instruction?: string,
): Promise<void> {
    host.beginSessionOperation(sessionId);
    let lock: SessionLockHandle | undefined;
    const abortController = new AbortController();
    const requestId = host.allocateRequestId();
    let usage = emptyUsage();
    let session: Session | undefined;

    try {
        lock = await acquireSessionLock(sessionId);
        session = await host.requireActiveSession(sessionId);
        // 手动压缩不保留尾部：把当前全部候选历史折叠进摘要
        const { turnsToCompact, keepFromMessageId } = await planCompaction(session, {
            model: getChatApiSettings(session.modelSelection).model,
            retainedTailTokens: 0,
        });
        if (turnsToCompact.length === 0) throw new Error("当前没有可压缩的对话历史");
        const history = buildCompactionHistory(session, turnsToCompact);

        host.activeSessions.set(sessionId, {
            session,
            lastSeq: host.activeSessions.get(sessionId)?.lastSeq ?? 0,
            abortController,
        });
        host.notify(requestId, sessionId, { type: "progress", message: "🗜️ 正在压缩会话上下文..." });
        const response = await runChatQuery({
            query: buildCompactPrompt(instruction),
            systemPrompt: getOrCreateSessionSystemPrompt(session, { includeMemory: false, userId: DEFAULT_MEMORY_USER_ID }),
            history,
            sessionId,
            modelSelection: session.modelSelection,
            cwd: session.cwd,
            contextEpochId: session.contextEpochId,
            userId: DEFAULT_MEMORY_USER_ID,
            initialRequestKind: "context_compaction",
            stream: true,
            signal: abortController.signal,
            onProgress: message => host.notify(requestId, sessionId, { type: "progress", message }),
            onEvent: event => {
                if (event.type === "usage") usage = mergeUsage(usage, event.usage);
                host.notify(requestId, sessionId, event);
            },
        });
        if (abortController.signal.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("压缩结果为空");
        const keepFromPosition = findCompactionKeepFromPosition(session, keepFromMessageId);
        const event = await host.eventLog.append(sessionId, "context_compacted", {
            compactedContext,
            instruction,
            ...(keepFromMessageId ? { keepFromMessageId } : {}),
            ...(keepFromPosition ? { keepFromPosition } : {}),
            usage: usage.requestCount ? usage : undefined,
        });
        applyCompaction(session, compactedContext, { instruction, keepFromMessageId });
        host.updateActiveSeq(sessionId, event.seq);
    } catch (error) {
        if (session && usage.requestCount) {
            try {
                await host.replay.appendAgentEvent(session, "usage_recorded", { usage }, false);
            } catch (persistError) {
                console.error("❌ [TUI] 压缩 usage 持久化失败:", persistError);
            }
        }
        throw error;
    } finally {
        host.notify(requestId, sessionId, { type: "progress", message: "" });
        try {
            if (session) {
                host.accumulateInstanceUsage(sessionId, usage);
                await host.finishAndPersist(session);
            } else {
                const active = host.activeSessions.get(sessionId);
                if (active) delete active.abortController;
            }
        } finally {
            try {
                await host.releaseSessionLockSafely(lock);
            } finally {
                host.endSessionOperation(sessionId);
            }
        }
    }
}
