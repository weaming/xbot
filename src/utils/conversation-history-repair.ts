import type { ChatMessage, Session } from "../types/session.js";
import { fromOpenAIToolCalls } from "../types/tool-call.js";

const MISSING_TOOL_RESULT_TEXT = "[工具调用被中断，未返回结果]";

/** 删除空 assistant 历史消息，并修正被删除消息上的压缩边界。 */
export function repairEmptyAssistantHistory(session: Session): number {
  let removed = 0;
  let nextKeepFromId: string | undefined;
  let hasRemovedKeepFrom = false;

  for (const turn of session.turns) {
    turn.messages = turn.messages.filter((message) => {
      const isEmptyAssistant = message.role === "assistant"
        && !message.content
        && !message.tool_calls?.length;
      if (isEmptyAssistant) {
        removed += 1;
        if (message.id === session.compactedKeepFromMessageId) hasRemovedKeepFrom = true;
        return false;
      }
      if (hasRemovedKeepFrom && !nextKeepFromId) nextKeepFromId = message.id;
      return true;
    });
  }

  if (hasRemovedKeepFrom) {
    session.compactedKeepFromMessageId = nextKeepFromId;
    if (!nextKeepFromId) session.compactedThroughTurnId = session.turns.at(-1)?.id;
  }
  return removed;
}

/** 修复工具调用/结果配对；补全被中断调用，并丢弃没有声明的孤立结果。 */
export function repairToolCallPairing(
  messages: ChatMessage[],
  skipToolCallIds?: ReadonlySet<string>,
): ChatMessage[] {
  const repaired: ChatMessage[] = [];
  const pending = new Map<string, string>();

  const flushMissing = (): void => {
    for (const [id, name] of pending) {
      if (skipToolCallIds?.has(id)) continue;
      repaired.push({
        role: "tool",
        tool_call_id: id,
        name: name || undefined,
        content: MISSING_TOOL_RESULT_TEXT,
      });
    }
    pending.clear();
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.has(message.tool_call_id)) continue;
      pending.delete(message.tool_call_id);
      repaired.push(message);
      continue;
    }

    flushMissing();
    repaired.push(message);
    if (message.role === "assistant") {
      for (const call of fromOpenAIToolCalls(message.tool_calls)) pending.set(call.id, call.name);
    }
  }

  flushMissing();
  return repaired;
}

/** 移除 Chat Completions 不接受的空 assistant 消息。 */
export function filterEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== "assistant"
    || Boolean(message.content)
    || Boolean(message.tool_calls?.length));
}
