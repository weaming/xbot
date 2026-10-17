import type { ChatMessage } from "../types/session.js";
import type { ConversationTurn, Session } from "../types/session.js";
import { getSessionContextHistory, replaceWithCompactedContext } from "../utils/conversation-history.js";
import {
    COMPACT_CHUNK_MIN_TOKENS,
    countSessionContextTokens,
    getAutoCompactThreshold,
    getEffectiveContextWindowSize,
    shouldAutoCompact,
    splitTurnsForCompaction,
    splitTurnsIntoChunks,
} from "../utils/token-budget.js";
import { countMessagesTokens, countTextTokens } from "../utils/tokenizer.js";
import { buildCompactPrompt } from "../utils/compaction-prompt.js";
import { isAbortError } from "../tools/chat-orchestrator.js";
import { emptyUsage, mergeUsage } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { getOrCreateSessionSystemPrompt, runChatQuery } from "./chat-runtime.js";
import { DEFAULT_MEMORY_USER_ID, normalizeMemoryUserId } from "../utils/runtime-paths.js";

/**
 * 单次摘要请求可用的输入预算占有效窗口的比例。
 * 0.85 留出系统提示、压缩提示与本地估算偏差（实测约 ±15%）的余量：
 * 正常阈值触发的压缩（阈值 0.8×窗口）因此始终只发一次请求，前缀与上一条请求一致，
 * 仍能命中 Prompt Cache；只有历史本身已经超过窗口（被请求级压缩藏住增长的极端情况）才分段。
 */
const COMPACT_INPUT_RATIO = 0.85;

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
        /** 保留段起始消息 id：重放时用它精确恢复上下文窗口。 */
        keepFromMessageId?: string;
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
    onUsage?: (usage: UsageInfo) => void;
    onFailure?: () => void;
}

/** 工具循环中压缩仅用于后续请求的临时上下文，完整消息由编排器另行保留。 */
export async function compactActiveTurnMessagesIfNeeded(
    messages: any[],
    options: ActiveTurnCompactOptions,
): Promise<any[] | undefined> {
    // 真实分词计数：工具结果这类内容启发式会低估两成以上，漏判就直接撞窗口
    const currentTokens = await countMessagesTokens(messages, options.model);
    const threshold = getAutoCompactThreshold(options.model);
    const checkTokens = Math.max(options.lastPromptTokens ?? 0, currentTokens);
    if (checkTokens < threshold) return undefined;

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
            stream: true,
            signal: options.signal,
            onEvent: event => {
                if (event.type === "usage") options.onUsage?.(event.usage);
            },
        });
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
        console.error("❌ [ActiveTurnCompact] Failed:", error.message);
        return undefined;
    }
}

/** 单次摘要请求的输入预算（估算 token）：有效窗口打个安全折扣，再扣除系统提示占用。 */
function getCompactChunkBudget(model: string | undefined, systemPromptTokens: number): number {
    const budget = Math.floor(getEffectiveContextWindowSize(model) * COMPACT_INPUT_RATIO) - systemPromptTokens;
    return Math.max(COMPACT_CHUNK_MIN_TOKENS, budget);
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
        // 待压缩历史可能已经超过模型窗口（回合内请求级压缩藏住了增长），一次性总结会被 provider 400，
        // 因此按预算分段折叠：每段输入 = 上一段的摘要前缀 + 该段 turns，逐段收敛成最终摘要。
        const budget = getCompactChunkBudget(options.model, systemPromptTokens);
        const chunks = await splitTurnsIntoChunks(turnsToCompact, budget, options.model);
        // turnsToCompact 非空 => chunks 至少一段，结束后必定是一段摘要正文
        let compactedContext = session.compactedContext ?? "";

        for (const [index, chunk] of chunks.entries()) {
            if (index > 0) {
                options.onProgress?.(`🗜️ 历史超出窗口，正在分段压缩（${index + 1}/${chunks.length}）...`);
            }
            // 构建用于总结的历史：已有摘要（或上一段摘要）+ 本段 turns
            const tempSession: Session = {
                ...session,
                turns: chunk,
                compactedContext,
                compactedThroughTurnId: undefined,
                compactedKeepFromMessageId: undefined,
            };
            const response = await runChatQuery({
                query: buildCompactPrompt(),
                systemPrompt,
                history: getSessionContextHistory(tempSession),
                userId,
                sessionId: session.sessionId,
                modelSelection: session.modelSelection,
                contextEpochId: session.contextEpochId,
                initialRequestKind: "context_compaction",
                signal: options.signal,
                onEvent: event => {
                    if (event.type !== "usage") return;
                    usage = mergeUsage(usage, event.usage);
                    options.onUsage?.(event.usage);
                },
            });

            const summary = response.content.trim();
            if (!summary) {
                throw new Error("自动压缩结果为空");
            }
            compactedContext = summary;
        }

        // 保留段起点之前（含上次保留段所在 turn 的头部）都折叠进摘要，保留段留在窗口里
        applyCompaction(session, compactedContext, { keepFromMessageId });

        if (options.persistCompactedEvent) {
            await options.persistCompactedEvent({
                compactedContext,
                ...(keepFromMessageId ? { keepFromMessageId } : {}),
                ...(usage.requestCount ? { usage } : {}),
            });
        }

        const postTokens = await countSessionContextTokens(session, { model: options.model });

        return {
            wasCompacted: true,
            preTokens,
            postTokens,
            threshold,
            usage: usage.requestCount ? usage : undefined,
        };
    } catch (error: any) {
        console.error("❌ [AutoCompact] Failed:", error.message);
        return {
            wasCompacted: false,
            usage: usage.requestCount ? usage : undefined,
        };
    }
}
