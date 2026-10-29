/**
 * 会话 token / 费用 / 生成速率的累计与重置。
 * 全部作用于传入的 SessionUiState，不持有实例状态。
 */

import type { UsageInfo } from "../types/chat.js";
import type { RequestRate, SessionUiState } from "./store-types.js";

export function resetTokenUsage(state: SessionUiState): void {
    state.totalTokens = 0;
    state.promptTokens = 0;
    state.completionTokens = 0;
    state.reasoningTokens = 0;
    state.cacheHitTokens = 0;
    state.cacheMissTokens = 0;
    state.contextTokens = 0;
    state.contextSource = undefined;
    state.costYuan = 0;
    state.lastRate = undefined;
    state.summedCompletionTokens = 0;
    state.summedReasoningTokens = 0;
    state.summedOutputTokens = 0;
    state.summedDurationMs = 0;
    state.summedReasoningMs = 0;
    state.summedOutputMs = 0;
    state.requestStartedAt = undefined;
    state.firstReasoningAt = undefined;
    state.firstTextAt = undefined;
}

export function addTokenUsage(
    state: SessionUiState,
    usage: UsageInfo,
    atMs: number,
    costFor?: (usage: UsageInfo, atMs: number) => number,
): void {
    state.promptTokens += usage.promptTokens;
    state.completionTokens += usage.completionTokens;
    state.reasoningTokens += usage.reasoningTokens ?? 0;
    state.cacheHitTokens += usage.cacheHitTokens ?? 0;
    state.cacheMissTokens += usage.cacheMissTokens ?? 0;
    state.totalTokens += usage.totalTokens;
    if (costFor) {
        const cost = costFor(usage, atMs);
        if (Number.isFinite(cost) && cost > 0) {
            state.costYuan += cost;
        }
    }
    // 上游明确给了输入侧用量就以它为准（含 0：说明该请求确实没报输入），
    // 本地估算只在回合收尾时通过 recordEstimatedContextTokens 兜底
    state.contextTokens = usage.latestPromptTokens ?? usage.promptTokens;
    state.contextSource = state.contextTokens > 0 ? "provider" : undefined;
    const rate = computeSessionRate(state, usage, atMs);
    if (rate) state.lastRate = rate;
}

/**
 * 回合结束时的本地估算结果：只在它比当前值更大时接管。
 * 失败回合拿不到 provider usage，靠这条把真实占用（含思维链/媒体）暴露到状态栏；
 * 回合内压缩后 provider 值偏小的场景也由它纠正。
 */
export function recordEstimatedContextTokens(state: SessionUiState, tokens?: number): void {
    if (!tokens || tokens <= 0) return;
    // 已经以估算为准时跟随最新估算：压缩之后上下文会变小，状态栏要跟着收敛
    if (state.contextSource === "local") {
        state.contextTokens = tokens;
        return;
    }
    // 实测值缺失（失败回合）或明显不反映当前历史（回合内压缩后偏小）才接管；
    // 10% 容差用于吃掉分词口径差异，避免两路数值接近时逐回合来回切换来源
    if (state.contextTokens === 0 || tokens > state.contextTokens * 1.1) {
        state.contextTokens = tokens;
        state.contextSource = "local";
    }
}

/**
 * 会话累计平均速率：每次 usage 把 token 与耗时累加进分母，比值即整个会话的平均速度。
 * 阶段耗时按「首个 reasoning delta → 首个 text delta → 请求结束」切分（本地时间戳，非估算），
 * 且 token 与耗时**成对累加**：没有该阶段 delta 的请求（如纯工具调用轮）不计入分子，
 * 否则会出现「有 token 无耗时」的错配，让阶段速率数量级失真。
 */
export function computeSessionRate(
    state: SessionUiState,
    usage: UsageInfo,
    atMs: number,
): RequestRate | undefined {
    if (!(usage.durationMs > 0)) return undefined;

    const startedAt = state.requestStartedAt ?? atMs - usage.durationMs;
    const endedAt = startedAt + usage.durationMs;
    const reasoningTokens = usage.reasoningTokens ?? 0;
    // 累计型上游（llm-deepseek-web）的 completionTokens 含新增输入，速率改用本地估算的生成量
    const outputTokens = usage.outputTokens ?? Math.max(usage.completionTokens - reasoningTokens, 0);

    // 累计型上游（llm-deepseek-web）的 completionTokens 含新增输入，速率分子改用本地估算的生成量
    state.summedCompletionTokens += usage.outputTokens ?? usage.completionTokens;
    state.summedDurationMs += usage.durationMs;

    const { firstReasoningAt, firstTextAt } = state;
    if (reasoningTokens > 0 && firstReasoningAt !== undefined) {
        const reasoningEnd = firstTextAt !== undefined && firstTextAt > firstReasoningAt ? firstTextAt : endedAt;
        const reasoningMs = reasoningEnd - firstReasoningAt;
        if (reasoningMs > 0) {
            state.summedReasoningTokens += reasoningTokens;
            state.summedReasoningMs += reasoningMs;
        }
    }
    if (outputTokens > 0 && firstTextAt !== undefined && endedAt > firstTextAt) {
        state.summedOutputTokens += outputTokens;
        state.summedOutputMs += endedAt - firstTextAt;
    }

    if (!(state.summedCompletionTokens > 0)) return undefined;

    const rate: RequestRate = {
        totalTps: state.summedCompletionTokens / (state.summedDurationMs / 1000),
        completionTokens: state.summedCompletionTokens,
        reasoningTokens: state.summedReasoningTokens,
        durationMs: state.summedDurationMs,
    };

    if (state.summedReasoningTokens > 0 && state.summedReasoningMs > 0) {
        rate.reasoningTps = state.summedReasoningTokens / (state.summedReasoningMs / 1000);
    }
    if (state.summedOutputTokens > 0 && state.summedOutputMs > 0) {
        rate.outputTps = state.summedOutputTokens / (state.summedOutputMs / 1000);
    }
    return rate;
}
