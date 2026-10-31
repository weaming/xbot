/**
 * 单个 turn 的共享执行骨架：
 *   落盘用户消息 → 请求前准备图片 → LLM 工具循环 → 按成功/中断/失败三种结局
 *   物化进 session 并落盘终态。
 * 调用方只提供「怎么持久化」和「怎么展示」两组钩子，避免两套 abort/error 逻辑漂移。
 *
 * 回合内的段边界（turn_segment_start）与完整消息（turn_message）在这里统一落盘并收集 seq，
 * 收尾时用一条 turn_commit 以 seq 列表指向它们（不再重复存内容）。
 */

import { emptyUsage, mergeUsage, type UIEvent } from "../events/ui-events.js";
import type { AgentEventPayloads } from "../events/agent-events.js";
import { getToolDefinitionsTokens, runChatQuery } from "./chat-runtime.js";
import { isAbortError, type ChatExecutionResult } from "../tools/chat-orchestrator.js";
import { appendCompletedTurn, appendInterruptedTurn } from "../utils/conversation-history.js";
import type { LLMRequestKind } from "../utils/logger.js";
import type { SteerUpdate, StreamDelta, UsageInfo } from "../types/chat.js";
import type { ChatMessage, Session } from "../types/session.js";
import type { ToolCall } from "../types/tool-call.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import { StreamRecovery } from "../utils/stream-recovery.js";
import { countSessionContextTokens } from "../utils/token-budget.js";
import { countTextTokens } from "../utils/tokenizer.js";

export interface TurnSpec {
    session: Session;
    turnId: string;
    /** 落盘与物化的用户消息；续跑为空。 */
    userMessages: UserMessageInput[];
    query: string;
    queryContent?: UserContent;
    systemPrompt: string;
    /** 当前模型名：只用于上下文规模估算的分词口径，不参与请求本身。 */
    model?: string;
    /**
     * 构造本回合请求历史。必须在请求前自动压缩之后才调用：
     * 自动压缩会改写 session.turns / compactedThroughTurnId，提前算好的历史会让压缩结果白做，
     * 本回合依旧把未压缩的全量历史发出去（历史已超窗时直接 400）。
     */
    buildHistory: () => ChatMessage[];
    signal: AbortSignal;
    cwd?: string;
    /** 实时解析会话 cwd：cwd 工具改过目录后，同回合的后续工具也要用新基准。 */
    resolveCwd?: () => string | undefined;
    userId: number;
    skipUserQuery?: boolean;
    pendingToolCalls?: ToolCall[];
    initialRequestKind?: Exclude<LLMRequestKind, "tool_response">;
    consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
    /** 工具循环中的请求级压缩（续跑时关闭，避免把待补的 tool_calls 前缀摘要掉）。 */
    autoCompactActiveTurn?: boolean;
    compactOnProviderOverflow?: boolean;
}

export interface TurnHooks {
    /** 请求前落盘用户消息（首事件需补 session_created）。 */
    persistUserMessages(userMessages: UserMessageInput[], turnId: string): Promise<void>;
    /** 执行中并入的 pending 消息落盘。 */
    persistPendingMessage(input: UserMessageInput, turnId: string): Promise<void>;
    /** 回合内每条完整消息即时落盘，返回分配到的 seq。 */
    persistTurnMessage(message: ChatMessage, turnId: string): Promise<number>;
    persistStreamDelta?(delta: StreamDelta, turnId: string, requestIndex: number): Promise<void>;
    persistSteerUpdate?(update: SteerUpdate, turnId: string): Promise<number>;
    /** 回合内压缩成功的落盘回调：摘要吸收掉的消息在重放时不能再物化。 */
    onTurnCompact?(compactedContext: string, turnId: string): Promise<void>;
    /** 段边界落盘，返回分配到的 seq。 */
    persistSegmentStart(payload: AgentEventPayloads["turn_segment_start"]): Promise<number>;
    /** 终态落盘（turn_commit 事件 + 会话索引）。 */
    persistTurn(payload: AgentEventPayloads["turn_commit"]): Promise<void>;
    /** 请求前的自动压缩；返回本次压缩产生的 usage（无需压缩时返回 undefined）。 */
    autoCompact?(): Promise<UsageInfo | undefined>;
    onEvent?(event: UIEvent): void | Promise<void>;
    onToolCall?(name: string, args: unknown, mode: "serial" | "parallel"): void | Promise<void>;
    onToolResult?(name: string, result: string): void;
    onAssistantToolCallContent?(content: string): Promise<void> | void;
}

export interface TurnOutcome {
    /** 成功时的模型响应；中断/失败时为空。 */
    response?: ChatExecutionResult;
    usage: UsageInfo;
    stopReason: string;
    aborted: boolean;
    /** 非中断错误（provider/网络等），由调用方决定如何展示。 */
    error?: unknown;
    hasInvalidAssistantHistory?: boolean;
}

type SegmentKind = AgentEventPayloads["turn_segment_start"]["kind"];

function serializeUserMessages(userMessages: UserMessageInput[]): Array<string | UserMessageInput> {
    return userMessages.map(input => {
        if (input.images?.length || (input.trigger && input.trigger !== "user")) return input;
        return input.text;
    });
}

/**
 * 段级时间线跟踪：把渲染事件折叠成「当前开放的段」，段开始时落一条 turn_segment_start。
 * 群消息按 seq 与段起始边界比较，即可在重放时插到与实时一致的段位。
 */
class SegmentTracker {
    private open: SegmentKind | null = null;

    constructor(private readonly onStart: (kind: SegmentKind) => void) {}

    on(event: UIEvent): void {
        switch (event.type) {
            case "reasoning_delta":
                this.start("reasoning");
                break;
            case "text_delta":
                this.start("text");
                break;
            case "tool_start":
                this.start("tool");
                break;
            case "tool_result":
            case "assistant_text_before_tools":
            case "turn_end":
            case "aborted":
            case "error":
                this.open = null;
                break;
            default:
                break;
        }
    }

    /** 开启一个段；与当前段同类型时延续（tool 每次都算新段）。 */
    private start(kind: SegmentKind): void {
        if (kind !== "tool" && this.open === kind) return;
        this.open = kind;
        this.onStart(kind);
    }

    /** 外部注入（如 pending 用户消息）切开新段：清空当前段并落一条 user 段边界。 */
    pendingUser(): void {
        this.open = null;
        this.onStart("user");
    }
}

export async function runTurnCore(spec: TurnSpec, hooks: TurnHooks): Promise<TurnOutcome> {
    const { session, turnId, userMessages } = spec;
    let usage = emptyUsage();
    let stopReason = "stop";
    let hasInvalidAssistantHistory = false;

    /**
     * 回合收尾时的历史规模（本地估算）。
     * 失败回合拿不到 provider usage，状态栏需要它揭示真实上下文占用。
     */
    const estimateContextTokens = async (): Promise<number | undefined> => {
        try {
            // 与压缩判定同口径：系统提示与工具定义都不进历史，但确实占窗口
            const [systemPromptTokens, toolsTokens] = await Promise.all([
                countTextTokens(spec.systemPrompt, spec.model),
                getToolDefinitionsTokens({
                    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
                    model: spec.model,
                    ...(session.modelSelection ? { modelSelection: session.modelSelection } : {}),
                }),
            ]);
            return await countSessionContextTokens(session, {
                model: spec.model,
                systemPromptTokens: systemPromptTokens + toolsTokens,
            });
        } catch {
            return undefined;
        }
    };

    // 本回合底层事件 seq（turn_message / turn_segment_start），按落盘顺序；收尾写进 turn_commit.events
    const eventSeqs: Promise<number>[] = [];
    // 已定稿并落盘的完整消息，用于中断/失败时补落尚未定稿的 partial 消息（按引用去重）
    const persistedMessages: ChatMessage[] = [];
    const streamRecovery = new StreamRecovery();
    const tracker = new SegmentTracker(kind => {
        eventSeqs.push(hooks.persistSegmentStart({ turnId, kind }));
    });
    const commitEvents = async (): Promise<number[]> => Promise.all(eventSeqs);

    try {
        await hooks.persistUserMessages(userMessages, turnId);
        if (hooks.autoCompact) {
            const compactUsage = await hooks.autoCompact();
            if (compactUsage) usage = mergeUsage(usage, compactUsage);
        }

        const response = await runChatQuery({
            query: spec.query,
            queryContent: spec.queryContent,
            systemPrompt: spec.systemPrompt,
            // 压缩之后才构造历史：把刚写回的摘要/尾部边界带上，避免本回合再发一遍全量历史
            history: spec.buildHistory(),
            userId: spec.userId,
            sessionId: session.sessionId,
            modelSelection: session.modelSelection,
            cwd: spec.cwd,
            resolveCwd: spec.resolveCwd,
            contextEpochId: session.contextEpochId,
            initialRequestKind: spec.initialRequestKind ?? "user_request",
            autoCompactActiveTurn: spec.autoCompactActiveTurn,
            compactOnProviderOverflow: spec.compactOnProviderOverflow,
            stream: true,
            signal: spec.signal,
            skipUserQuery: spec.skipUserQuery,
            pendingToolCalls: spec.pendingToolCalls,
            consumePendingMessages: spec.consumePendingMessages,
            onConsumePending: async (pendingText, pending) => {
                await hooks.persistPendingMessage({
                    text: pendingText,
                    images: pending.flatMap(input => typeof input === "string" ? [] : input.images ?? []),
                }, turnId);
                tracker.pendingUser();
            },
            onSteerUpdate: async update => {
                const seq = await hooks.persistSteerUpdate?.(update, turnId);
                if (seq !== undefined) eventSeqs.push(Promise.resolve(seq));
                void hooks.onEvent?.({ type: "steer_update", ...update });
            },
            onTurnMessage: async message => {
                const seqPromise = hooks.persistTurnMessage(message, turnId);
                eventSeqs.push(seqPromise);
                try {
                    await seqPromise;
                    persistedMessages.push(message);
                    if (message.role === "assistant") streamRecovery.clear();
                } catch (error) {
                    const index = eventSeqs.indexOf(seqPromise);
                    if (index >= 0) eventSeqs.splice(index, 1);
                    throw error;
                }
            },
            ...(hooks.persistStreamDelta
                ? { onStreamDelta: async (delta: StreamDelta, requestIndex: number) => {
                    try {
                        await hooks.persistStreamDelta!(delta, turnId, requestIndex);
                    } catch (error) {
                        throw new Error("流式消息落盘失败，请检查会话存储目录", { cause: error });
                    }
                    streamRecovery.push(requestIndex, delta);
                } }
                : {}),
            ...(hooks.onTurnCompact
                ? { onTurnCompact: (compactedContext: string) => hooks.onTurnCompact!(compactedContext, turnId) }
                : {}),
            onToolCall: hooks.onToolCall,
            onToolResult: hooks.onToolResult,
            onAssistantToolCallContent: hooks.onAssistantToolCallContent,
            onInvalidAssistantHistory: () => { hasInvalidAssistantHistory = true; },
            onEvent: event => {
                tracker.on(event);
                if (event.type === "usage") usage = mergeUsage(usage, event.usage);
                if (event.type === "message_end") stopReason = event.stopReason;
                void hooks.onEvent?.(event);
            },
        });

        const messages = response.messages as ChatMessage[];
        appendCompletedTurn(session, userMessages, messages, true);
        await hooks.persistTurn({
            turnId,
            events: await commitEvents(),
            userMessages: serializeUserMessages(userMessages),
            stopReason,
            usage,
            contextTokens: await estimateContextTokens(),
            interrupted: false,
        });
        return { response, usage, stopReason, aborted: false, hasInvalidAssistantHistory };
    } catch (error: any) {
        const partial = [...(error?.partialMessages ?? [])] as ChatMessage[];
        const recovered = streamRecovery.message();
        if (recovered && !partial.some(message =>
            message.role === "assistant" && message.content === recovered.content,
        )) partial.push(recovered);
        const aborted = isAbortError(error);
        // 先保住内存会话：即使后续事件日志仍不可写，也不丢本进程中的失败现场。
        appendInterruptedTurn(session, userMessages, partial, aborted ? "interrupted" : "failed");
        // 中断/失败现场同样要落 turn_message，否则重放后只剩 user 消息（已落盘的不重复写）
        for (const message of partial) {
            if (persistedMessages.includes(message)) continue;
            const seq = await hooks.persistTurnMessage(message, turnId);
            persistedMessages.push(message);
            eventSeqs.push(Promise.resolve(seq));
        }

        if (aborted) {
            // 用户消息与已发起的工具调用/结果一起进 turns：续跑时能看到中断现场，避免重跑副作用
            await hooks.persistTurn({
                turnId,
                events: await commitEvents(),
                userMessages: serializeUserMessages(userMessages),
                stopReason: "aborted",
                usage,
                contextTokens: await estimateContextTokens(),
                interrupted: true,
            });
            return { usage, stopReason: "aborted", aborted: true, hasInvalidAssistantHistory };
        }

        await hooks.persistTurn({
            turnId,
            events: await commitEvents(),
            userMessages: serializeUserMessages(userMessages),
            stopReason: "error",
            error: error?.message ?? String(error),
            usage,
            contextTokens: await estimateContextTokens(),
            interrupted: false,
        });
        return { usage, stopReason: "error", aborted: false, error, hasInvalidAssistantHistory };
    }
}
