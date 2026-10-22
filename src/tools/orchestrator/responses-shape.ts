/**
 * Responses API 响应归一化：把 output 数组形态收成与 Chat Completions 一致的 choices 结构。
 *
 * 响应两侧（实时与重放）都依赖同一份归一化，避免措辞与字段口径漂移。
 */

function normalizeResponsesUsage(usage: any): any {
  if (!usage || usage.input_tokens === undefined) return usage;
  return {
    ...usage,
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.input_tokens + (usage.output_tokens ?? 0)),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens } }
      : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens } }
      : {}),
  };
}

export function normalizeResponsesResponse(response: any): any {
  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts = output.flatMap((item: any) => item?.type === "message"
    ? (item.content ?? [])
      .filter((part: any) => part?.type === "output_text")
      .map((part: any) => part.text ?? "")
    : []);
  const content = textParts.join("") || response?.output_text || null;
  const toolCalls = output
    .filter((item: any) => item?.type === "function_call")
    .map((item: any) => ({
      id: item.call_id ?? item.id,
      type: "function",
      function: {
        name: item.name,
        arguments: item.arguments ?? "{}",
      },
    }));
  const message: any = {
    role: "assistant",
    content,
    response_output: output,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const finishReason = response?.status === "failed"
    ? "error"
    : response?.status === "incomplete"
    ? (response.incomplete_details?.reason === "max_output_tokens" ? "length" : "incomplete")
    : toolCalls.length > 0 ? "tool_calls" : "stop";
  return {
    ...response,
    choices: [{ message, finish_reason: finishReason }],
    usage: normalizeResponsesUsage(response?.usage),
  };
}
