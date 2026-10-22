/**
 * 回合决策：给定「本轮响应 + 重试计数」，决定下一步做什么。
 *
 * 这是原先散在 `while(true)` 里 5 个 `continue` / `break` 的收敛点：
 * 所有终止条件、重试上限、优先级都在这里，纯函数、不产生副作用。
 * 契约：同一组输入必然产出同一个动作，便于表驱动测试覆盖全部组合。
 */

/** 空响应（无工具调用且无内容）最大重试次数。 */
export const MAX_EMPTY_RESPONSE_RETRIES = 2;
/** length 截断最大重试次数（同请求头重发）。 */
export const MAX_LENGTH_RETRIES = 2;

/** 空响应首次重试时追加的提示（后续重试不再追加，原样重发）。 */
export const EMPTY_RESPONSE_RETRY_PROMPT =
  "Your last response was empty — no tool call and no content. This usually means the tool you intended to call is not available in the tools list or the arguments were wrong. Please re-examine the tools list and continue: either reply directly or call the correct tool.";

export interface TurnCounters {
  emptyResponse: number;
  lengthRetry: number;
}

export interface DecisionInput {
  /** provider 归一的 finish_reason。 */
  finishReason: string;
  /** 本轮 assistant 文本（已 trim；空串表示无内容）。 */
  content: string;
  toolCallCount: number;
  counters: TurnCounters;
}

export type Decision =
  /** provider 显式拒绝或失败：不重试。 */
  | { kind: "fail"; reason: "content_filter" | "error"; message: string }
  /** 输出触达上限且无工具调用：同请求重发。 */
  | { kind: "retry_length" }
  /** 无工具调用且无内容：首次附带提示，后续原样重发。 */
  | { kind: "retry_empty"; appendPrompt: boolean }
  /** 有最终文本，回合结束。 */
  | { kind: "done"; content: string }
  /** 需要执行工具并继续下一轮。 */
  | { kind: "run_tools" };

/**
 * 决策优先级（顺序即语义，不可调换）：
 *   1. content_filter / error —— provider 明确表态，重试无意义
 *   2. length 且无工具调用 —— 可重发恢复，超限则失败
 *   3. 无工具调用 —— 有文本即结束，无文本进入空响应重试
 *   4. 有工具调用 —— 执行工具后继续（length + 工具调用也走这里）
 */
export function decideNext(input: DecisionInput): Decision {
  if (input.finishReason === "content_filter") {
    return { kind: "fail", reason: "content_filter", message: "LLM provider 拒绝响应（content_filter）：内容被安全策略过滤" };
  }
  if (input.finishReason === "error") {
    return { kind: "fail", reason: "error", message: "LLM provider 返回 error：响应被显式标为失败" };
  }

  if (input.finishReason === "length" && input.toolCallCount === 0) {
    if (input.counters.lengthRetry + 1 > MAX_LENGTH_RETRIES) {
      return { kind: "fail", reason: "error", message: "LLM 输出超长（finish_reason=length）且重试后仍被截断" };
    }
    return { kind: "retry_length" };
  }

  if (input.toolCallCount === 0) {
    if (input.content) return { kind: "done", content: input.content };
    if (input.counters.emptyResponse + 1 > MAX_EMPTY_RESPONSE_RETRIES) {
      return { kind: "done", content: "" };
    }
    return { kind: "retry_empty", appendPrompt: input.counters.emptyResponse === 0 };
  }

  return { kind: "run_tools" };
}

/** 结算计数：只有真正进入该分支才递增，避免无关分支污染判定。 */
export function nextCounters(current: TurnCounters, decision: Decision): TurnCounters {
  if (decision.kind === "retry_empty") {
    return { ...current, emptyResponse: current.emptyResponse + 1 };
  }
  if (decision.kind === "retry_length") {
    return { ...current, lengthRetry: current.lengthRetry + 1 };
  }
  return current;
}
