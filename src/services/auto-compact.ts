import type { ChatMessage, ConversationTurn, Session } from "../types/session.js";
import { getSessionContextHistory, replaceWithCompactedContext } from "../utils/conversation-history.js";
import {
    countSessionContextTokens,
    getAutoCompactThreshold,
    shouldAutoCompact,
    splitTurnsForCompaction,
} from "../utils/token-budget.js";
import { countMessagesTokens, countTextTokens } from "../utils/tokenizer.js";
import { buildCompactPrompt } from "../utils/compaction-prompt.js";
import { projectChatMessagesForPrompt } from "../utils/tool-result-context.js";
import { isAbortError } from "../tools/chat-orchestrator.js";
import { emptyUsage, mergeUsage } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { getOrCreateSessionSystemPrompt, runChatQuery } from "./chat-runtime.js";
import { DEFAULT_MEMORY_USER_ID, normalizeMemoryUserId } from "../utils/runtime-paths.js";

export interface AutoCompactOptions {
    model?: string;
    userId: number;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    onUsage?: (usage: UsageInfo) => void;
    persistCompactedEvent?: (payload: {
        compactedContext: string;
        keepFromMessageId?: string;
        keepFromPosition?: { turnIndex: number; messageIndex: number };
        usage?: UsageInfo;
    }) => Promise<void>;
}

export interface AutoCompactResult {
    wasCompacted: boolean;
    preTokens?: number;
    postTokens?: number;
    threshold?: number;
    usage?: UsageInfo;
}

interface ActiveTurnCompactOptions {
    model?: string;
    systemPrompt: string;
    userId: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    contextEpochId?: string;
    lastPromptTokens?: number;
    providerMaxTokens?: number;
    onUsage?: (usage: UsageInfo) => void;
    onFailure?: () => void;
}

/** 工具循环中压缩仅用于后续请求的临时上下文，完整消息由编排器另行保留。 */
export async function compactActiveTurnMessagesIfNeeded(
    messages: any[],
    options: ActiveTurnCompactOptions,
): Promise<any[] | undefined> {
    if (options.providerMaxTokens === undefined) {
        // 工具结果这类内容启发式会低估，正常路径需用真实分词计数预判。
        const currentTokens = await countMessagesTokens(projectChatMessagesForPrompt(messages), options.model);
        const threshold = getAutoCompactThreshold(options.model);
        const checkTokens = Math.max(options.lastPromptTokens ?? 0, currentTokens);
        if (checkTokens < threshold) return undefined;
    }

    options.onProgress?.("🗜️ 当前任务上下文达到上限，正在压缩本轮进展...");

    const history = messages.filter(message => message.role !== "system");
    try {
        const response = await runChatQuery({
            query: buildCompactPrompt("重点保留当前任务目标、已完成步骤、工具结果中的关键事实，以及下一步行动。"),
            systemPrompt: options.systemPrompt,
            userId: options.userId,
            history,
            sessionId: options.sessionId,
            modelSelection: options.modelSelection,
            contextEpochId: options.contextEpochId,
            initialRequestKind: "context_compaction",
            disableToolCalls: true,
            stream: true,
            signal: options.signal,
            onProgress: options.onProgress,
            onEvent: event => {
                if (event.type === "usage") options.onUsage?.(event.usage);
            },
        });
        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("本轮自动压缩结果为空");

        return [
            ...messages.filter(message => message.role === "system"),
            {
                role: "user",
                content: `<active_turn_summary>\n${compactedContext}\n</active_turn_summary>`,
            },
            {
                role: "assistant",
                content: "已确认上述当前任务进展，将从现有状态继续执行。",
            },
            {
                role: "user",
                content: "请继续完成当前任务；需要时继续调用工具，完成后给出最终答复。",
            },
        ];
    } catch (error: any) {
        if (isAbortError(error)) throw error;
        options.onFailure?.();
        const reason = error instanceof Error ? error.message : String(error);
        console.error("❌ [ActiveTurnCompact] Failed:", reason);
        throw new Error(`本轮上下文压缩失败，已停止请求以避免继续发送超长上下文：${reason}`);
    }
}

/**
 * 待压缩候选取自上次压缩点之后：那里也是上次保留段的起点，
 * 所以保留段会在下一次压缩时被一起吸收，不会一直堆在窗口里。
 */
function compactionCandidates(session: Session): ConversationTurn[] {
    const through = session.compactedThroughTurnId
        ? session.turns.findIndex(turn => turn.id === session.compactedThroughTurnId)
        : -1;
    return session.turns.slice(through + 1);
}

/** 保留段起点所在 turn 的前一个 turn：写入 compactedThroughTurnId，作为下次压缩的起点。 */
function turnBeforeKeepFrom(session: Session, keepFromMessageId: string): string | undefined {
    const index = session.turns.findIndex(turn =>
        turn.messages.some(message => message.id === keepFromMessageId),
    );
    return index > 0 ? session.turns[index - 1]!.id : undefined;
}

/** 压缩规划：待压缩回合 + 保留段起点（自动压缩与手动 /compact 共用同一套切分口径）。 */
export function planCompaction(
    session: Session,
    options: { retainedTailTokens?: number; model?: string } = {},
): Promise<{ turnsToCompact: ConversationTurn[]; keepFromMessageId?: string }> {
    return splitTurnsForCompaction(compactionCandidates(session), options);
}

/** 压缩请求的输入历史：已有摘要前缀 + 指定回合（保留原 turn 分组与工具结果投影规则）。 */
export function buildCompactionHistory(session: Session, turns: ConversationTurn[]): ChatMessage[] {
    const tempSession: Session = {
        ...session,
        turns,
        compactedContext: session.compactedContext,
        compactedThroughTurnId: undefined,
        compactedKeepFromMessageId: undefined,
    };
    return getSessionContextHistory(tempSession);
}

/** 写回压缩结果：摘要 + 保留段边界（turn 级字段供旧数据与重放兜底）。 */
export function applyCompaction(
    session: Session,
    compactedContext: string,
    options: { keepFromMessageId?: string | undefined; instruction?: string | undefined } = {},
): void {
    const { keepFromMessageId, instruction } = options;
    const compactedThroughTurnId = keepFromMessageId
        ? turnBeforeKeepFrom(session, keepFromMessageId)
        : session.turns.at(-1)?.id;
    replaceWithCompactedContext(session, compactedContext, {
        ...(instruction ? { instruction } : {}),
        ...(compactedThroughTurnId ? { compactedThroughTurnId } : {}),
        ...(keepFromMessageId ? { keepFromMessageId } : {}),
    });
}

/** 将内存消息 id 转为可跨重启重放的回合位置。 */
export function findCompactionKeepFromPosition(
    session: Session,
    keepFromMessageId?: string,
): { turnIndex: number; messageIndex: number } | undefined {
    if (!keepFromMessageId) return undefined;
    for (const [turnIndex, turn] of session.turns.entries()) {
        const messageIndex = turn.messages.findIndex(message => message.id === keepFromMessageId);
        if (messageIndex >= 0) return { turnIndex, messageIndex };
    }
    throw new Error(`压缩保留消息不存在: ${keepFromMessageId}`);
}

/**
 * 检查会话是否达到 Token 压缩阈值，并在需要时自动执行压缩。
 * 压缩把上次压缩点之后的全部回合折叠成一段摘要：压缩后的上下文从总结开始，
 * 不再附带被压缩范围内的尾部历史（只保留压缩之后新产生的回合）。
 */
export async function autoCompactIfNeeded(
    session: Session,
    options: AutoCompactOptions = { userId: DEFAULT_MEMORY_USER_ID },
): Promise<AutoCompactResult> {
    const userId = normalizeMemoryUserId(options.userId);
    // 判定要带上系统提示的占用：只有历史估算会低估真实请求量，漏判就直接涨到 provider 400
    const systemPrompt = getOrCreateSessionSystemPrompt(session, { includeMemory: false, userId });
    const systemPromptTokens = await countTextTokens(systemPrompt, options.model);
    if (!(await shouldAutoCompact(session, {
        model: options.model,
        systemPromptTokens,
        lastPromptTokens: session.lastPromptTokens,
    }))) {
        return { wasCompacted: false };
    }

    const preTokens = session.lastPromptTokens ?? (await countSessionContextTokens(session, { model: options.model }));
    const threshold = getAutoCompactThreshold(options.model);

    // 待压缩回合 + 保留段（优先保留完整 turn，尾部单轮超预算才消息级细切）
    const { turnsToCompact, keepFromMessageId } = await splitTurnsForCompaction(compactionCandidates(session), {
        model: options.model,
    });

    if (turnsToCompact.length === 0) {
        return { wasCompacted: false };
    }

    options.onProgress?.("🗜️ 上下文 Token 达到上限，正在自动压缩历史...");

    let usage = emptyUsage();
    try {
        const response = await runChatQuery({
            query: buildCompactPrompt(),
            systemPrompt,
            history: buildCompactionHistory(session, turnsToCompact),
            userId,
            sessionId: session.sessionId,
            modelSelection: session.modelSelection,
            contextEpochId: session.contextEpochId,
            initialRequestKind: "context_compaction",
            disableToolCalls: true,
            stream: true,
            signal: options.signal,
            onEvent: event => {
                if (event.type !== "usage") return;
                usage = mergeUsage(usage, event.usage);
                options.onUsage?.(event.usage);
            },
        });

        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("自动压缩结果为空");

        const keepFromPosition = findCompactionKeepFromPosition(session, keepFromMessageId);
        const compactedSession = { ...session };
        applyCompaction(compactedSession, compactedContext, { keepFromMessageId });
        const postTokens = await countSessionContextTokens(compactedSession, { model: options.model });
        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");

        if (options.persistCompactedEvent) {
            await options.persistCompactedEvent({
                compactedContext,
                ...(keepFromMessageId ? { keepFromMessageId } : {}),
                ...(keepFromPosition ? { keepFromPosition } : {}),
                ...(usage.requestCount ? { usage } : {}),
            });
        }
        Object.assign(session, compactedSession);

        return {
            wasCompacted: true,
            preTokens,
            postTokens,
            threshold,
            usage: usage.requestCount ? usage : undefined,
        };
    } catch (error: any) {
        if (isAbortError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        console.error("❌ [AutoCompact] Failed:", reason);
        throw new Error(`会话上下文压缩失败，已停止请求以避免继续发送超长上下文：${reason}`);
    }
}
