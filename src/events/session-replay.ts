/**
 * 会话重放：从事件日志重放重建 Session 状态（快照 + 增量）。
 * 事件是事实源，状态是其投影——重放路径与增量路径产出同一状态。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir, getToolCwd } from "../utils/runtime-paths.js";
import { createUlid } from "../utils/ulid.js";
import { appendCompletedTurn, appendInterruptedTurn, appendStandaloneTurn, replaceWithCompactedContext } from "../utils/conversation-history.js";
import type { ChatMessage, Session } from "../types/session.js";
import type { AgentEvent, AgentEventPayloads } from "./agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { UserMessageInput } from "../types/image.js";
import { type EventLog } from "./event-log.js";
import { sanitizeSessionId } from "../utils/session-id.js";

/** 每 N 个事件写一次快照，避免日志无限增长时全量重放。 */
const SNAPSHOT_INTERVAL = 100;

/**
 * 只有回合闭合的事件才允许落快照：turn 进行中（user_message 已落盘、turn_commit 未落盘）
 * 写快照，会让该用户消息永远落在快照边界之前，重放时被排除、上下文丢失。
 */
const SNAPSHOT_SAFE_EVENT_TYPES = new Set<AgentEvent["type"]>([
    "session_created",
    "turn_commit",
    "standalone_turn",
    // 会话间消息不参与 Session 投影，落在快照边界上也不会丢上下文。
    "peer_message",
    "peer_result",
    "session_renamed",
    "session_archived",
    "session_unarchived",
]);

interface EventSnapshot {
    lastSeq: number;
    ts: string;
    session: Session;
}

/** 未闭合回合的增量现场：用户消息 + 已定稿消息（流式 delta 不落盘）。 */
interface PendingTurn {
    userMessages: UserMessageInput[];
    messages: ChatMessage[];
}

export interface ReplayResult {
    session: Session;
    lastSeq: number;
}

export class SessionReplay {
    constructor(private readonly eventLog: EventLog) {}

    private snapshotFilePath(sessionId: string): string {
        return path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.snapshot.json`);
    }

    /**
     * 重放到目标 seq（缺省最新）。返回重建的 Session 与最后 seq。
     * 快照未覆盖的部分（或 upToSeq 早于快照）从日志全量/增量重放。
     */
    async replayTo(sessionId: string, upToSeq?: number): Promise<ReplayResult> {
        const snapshot = await this.readSnapshot(sessionId);
        const snapshotUsable =
            snapshot !== null && (upToSeq === undefined || upToSeq >= snapshot.lastSeq);

        const fromSeq = snapshotUsable ? snapshot.lastSeq + 1 : 1;
        const events = await this.eventLog.read(sessionId, fromSeq, undefined);
        const targetEvents = upToSeq !== undefined
            ? events.filter(event => event.seq <= upToSeq)
            : events;

        const session = snapshotUsable && snapshot
            ? { ...snapshot.session, cwd: snapshot.session.cwd ?? getToolCwd() }
            : createEmptySession(sessionId);

        // turn_message 让回合进行中的完整消息即时落盘；重放时按 turnId 归组，
        // turn_commit 出现则取该回合已落盘消息作为终态；始终未闭合的仅保留最后一个
        // （部分消息规则：最后一轮保留，中间残留丢弃）——进程被强杀也能恢复到最后一笔。
        const pendingTurns = new Map<string, PendingTurn>();
        for (const event of targetEvents) {
            if (event.type === "user_message") {
                const { text, images, turnId, trigger } = event.payload;
                getPendingTurn(pendingTurns, turnId).userMessages.push({ text, images, trigger });
                continue;
            }
            if (event.type === "turn_message") {
                getPendingTurn(pendingTurns, event.payload.turnId).messages.push(event.payload.message);
                continue;
            }
            if (event.type === "turn_commit") {
                const key = event.payload.turnId;
                // 更早的未闭合回合：用户消息是事实，物化为中断回合；partial 消息丢弃（部分消息规则）
                for (const [pendingKey, pending] of pendingTurns) {
                    if (pendingKey === key) continue;
                    if (pending.userMessages.length > 0) {
                        appendInterruptedTurn(session, pending.userMessages, [], "interrupted");
                    }
                }
                const pending = pendingTurns.get(key);
                const messages = pending?.messages ?? [];
                const pendingUserMessages = pending?.userMessages;
                pendingTurns.clear();
                applyCommit(session, event, messages, pendingUserMessages);
                continue;
            }
            applyEvent(session, event);
        }
        materializeLastPendingTurn(session, pendingTurns);

        const lastSeq = targetEvents.length > 0
            ? targetEvents[targetEvents.length - 1].seq
            : (snapshotUsable && snapshot ? snapshot.lastSeq : 0);
        return { session, lastSeq };
    }

    /**
     * 追加领域事件并维护快照：首事件自动补 session_created，
     * turn_commit 的用户消息先落 user_message。
     * writeUserMessages=false 时跳过 user_message（调用方已在请求前落盘，避免重复）。
     */
    async appendAgentEvent(
        session: Session,
        type: 'turn_commit' | 'context_compacted' | 'standalone_turn' | 'usage_recorded',
        payload: AgentEventPayloads[typeof type],
        writeUserMessages = true,
    ): Promise<void> {
        if ((await this.eventLog.lastSeq(session.sessionId)) === 0) {
            await this.eventLog.append(session.sessionId, "session_created", {
                cwd: session.cwd,
            });
        }
        if (writeUserMessages) {
            const { userMessages = [], turnId } = payload as { userMessages?: Array<string | UserMessageInput>; turnId: string };
            for (const input of userMessages) {
                const message = typeof input === "string" ? { text: input } : input;
                await this.eventLog.append(session.sessionId, "user_message", {
                    text: message.text,
                    ...(message.images?.length ? { images: message.images } : {}),
                    turnId,
                    trigger: message.trigger ?? "user",
                });
            }
        }
        await this.eventLog.append(session.sessionId, type, payload as any);
        if (type === "turn_commit" || type === "usage_recorded") {
            rememberPromptTokens(session, (payload as { usage?: UsageInfo }).usage);
        }
        await this.writeSnapshotIfDue(session.sessionId, session);
    }

    /** 事件数达到快照间隔时落盘当前状态快照。 */
    async writeSnapshotIfDue(sessionId: string, session: Session): Promise<void> {
        const lastSeq = await this.eventLog.lastSeq(sessionId);
        if (lastSeq === 0 || lastSeq % SNAPSHOT_INTERVAL !== 0) return;
        const tail = await this.eventLog.read(sessionId, lastSeq, 1);
        if (tail[0] && !SNAPSHOT_SAFE_EVENT_TYPES.has(tail[0].type)) return;

        const snapshot: EventSnapshot = {
            lastSeq,
            ts: new Date().toISOString(),
            session: serializeSession(session),
        };
        const filePath = this.snapshotFilePath(sessionId);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${createUlid()}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
            await fs.promises.rename(tempPath, filePath);
        } finally {
            await fs.promises.rm(tempPath, { force: true });
        }
    }

    /** 请求前落盘 user_message（首事件自动补 session_created），返回事件 seq。 */
    async appendUserMessage(
        session: Session,
        text: string,
        turnId: string,
        trigger: "user" | "pending" | "peer" = "user",
        images?: UserMessageInput["images"],
    ): Promise<number> {
        if ((await this.eventLog.lastSeq(session.sessionId)) === 0) {
            await this.eventLog.append(session.sessionId, "session_created", { cwd: session.cwd });
        }
        const event = await this.eventLog.append(session.sessionId, "user_message", {
            text,
            ...(images?.length ? { images } : {}),
            turnId,
            trigger,
        });
        return event.seq;
    }

    /** 回合内每条完整消息即时落盘（turn_message），返回事件 seq。 */
    async appendTurnMessage(sessionId: string, turnId: string, message: ChatMessage): Promise<number> {
        const event = await this.eventLog.append(sessionId, "turn_message", { turnId, message });
        return event.seq;
    }

    /** 段边界落盘（turn_segment_start），返回事件 seq。 */
    async appendSegmentStart(sessionId: string, payload: AgentEventPayloads["turn_segment_start"]): Promise<number> {
        const event = await this.eventLog.append(sessionId, "turn_segment_start", payload);
        return event.seq;
    }

    /** 删除会话快照（截断/回滚后快照过期，重放改为全量）。 */
    async deleteSnapshot(sessionId: string): Promise<void> {
        try {
            await fs.promises.unlink(this.snapshotFilePath(sessionId));
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
    }

    private async readSnapshot(sessionId: string): Promise<EventSnapshot | null> {
        try {
            const text = await fs.promises.readFile(this.snapshotFilePath(sessionId), "utf8");
            return JSON.parse(text) as EventSnapshot;
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof SyntaxError) {
                console.warn(`[SessionReplay] 忽略损坏快照 (session=${sessionId})`);
                return null;
            }
            throw error;
        }
    }
}

function getPendingTurn(pendingTurns: Map<string, PendingTurn>, turnId: string): PendingTurn {
    let unit = pendingTurns.get(turnId);
    if (!unit) {
        unit = { userMessages: [], messages: [] };
        pendingTurns.set(turnId, unit);
    }
    return unit;
}

/** 仅物化最后一个未闭合回合（部分消息规则），其余中间残留直接丢弃。 */
function materializeLastPendingTurn(session: Session, pendingTurns: Map<string, PendingTurn>): void {
    let last: PendingTurn | undefined;
    for (const unit of pendingTurns.values()) last = unit;
    if (!last) return;
    pendingTurns.clear();
    if (last.userMessages.length === 0 && last.messages.length === 0) return;
    appendInterruptedTurn(session, last.userMessages, last.messages, "interrupted");
}

/** turn_commit 投影：消息取自已落盘的 turn_message（终态不再重复内容）。 */
function applyCommit(
    session: Session,
    event: Extract<AgentEvent, { type: "turn_commit" }>,
    messages: ChatMessage[],
    pendingUserMessages?: UserMessageInput[],
): void {
    const { userMessages: committedUserMessages, interrupted, stopReason, usage } = event.payload;
    const userMessages = pendingUserMessages?.length
        ? pendingUserMessages.filter(input => input.trigger !== "pending" || !messages.some(message =>
            message.role === "user" && getUserMessageText(message) === input.text,
        ))
        : committedUserMessages;
    if (interrupted) {
        appendInterruptedTurn(session, userMessages, messages, "interrupted");
    } else if (stopReason === "error") {
        appendInterruptedTurn(session, userMessages, messages, "failed");
    } else {
        appendCompletedTurn(session, userMessages, messages, true);
    }
    rememberPromptTokens(session, usage);
}

function getUserMessageText(message: ChatMessage): string | undefined {
    if (message.role !== "user") return undefined;
    if (typeof message.content === "string") return message.content;
    return message.content.find(block => block.type === "text")?.text;
}

/** 事件投影：context_compacted / standalone_turn 等驱动状态变化，其余事件仅作展示记录。 */
function applyEvent(session: Session, event: AgentEvent): void {
    switch (event.type) {
        case "session_created":
            // 事件为事实源；旧事件无 cwd 字段时归一到当前工具目录（工厂/快照已保证非空）。
            session.cwd = event.payload.cwd ?? getToolCwd();
            break;
        case "context_compacted":
            replaceWithCompactedContext(session, event.payload.compactedContext, {
                ...(event.payload.instruction ? { instruction: event.payload.instruction } : {}),
                ...(event.payload.keepFromMessageId ? { keepFromMessageId: event.payload.keepFromMessageId } : {}),
            });
            break;
        case "standalone_turn":
            appendStandaloneTurn(session, event.payload.messages);
            break;
        case "usage_recorded":
            rememberPromptTokens(session, event.payload.usage);
            break;
        case "session_renamed":
            session.title = event.payload.title;
            break;
        case "model_selected":
            session.modelSelection = event.payload;
            break;
        default:
            break;
    }
}

/** 记录最近一次 provider 输入 token，供下一次自动压缩使用。 */
function rememberPromptTokens(session: Session, usage?: UsageInfo): void {
    const promptTokens = usage?.latestPromptTokens ?? usage?.promptTokens;
    if (promptTokens && promptTokens > 0) {
        session.lastPromptTokens = promptTokens;
    }
}

/** 新会话工厂：cwd 默认当前工具目录。 */
export function createEmptySession(sessionId: string, cwd = getToolCwd()): Session {
    const timestamp = new Date().toISOString();
    return {
        sessionId,
        cwd,
        contextEpochId: createUlid(),
        turns: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        contextState: {
            startedAt: timestamp,
            reason: "session_start",
            sourceUserTurnCount: 0,
            retainedUserTurnCount: 0,
        },
        totalUserTurnCount: 0,
        hardTrimCount: 0,
        compactCount: 0,
    };
}

/** 快照直接引用持久化 Session（无运行时字段可剥离）。 */
function serializeSession(session: Session): Session {
    return session;
}
