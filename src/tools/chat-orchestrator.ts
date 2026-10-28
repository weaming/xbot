/**
 * Chat Completions API orchestrator
 * 使用 OpenAI Chat Completions 协议
 * 支持完整的 LLM 调用循环
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { recordLLMExchange, type LLMRequestKind, type LLMUsageLogEntry } from "../utils/logger.js";
import { normalizeToolDefinitionsForDeepSeek } from "./tool-schema.js";
import { patchArgumentsJson } from "./tool-kinds.js";
import {
  compactJsonToolOutput,
  type ToolExecutionOutput,
  type ToolExecutionResponse,
} from "./tool-interface.js";
import { getOpenAIProxyFetch } from "../utils/proxy.js";
import { DEEPSEEK_OFFICIAL_HOST, endpointHost } from "../pricing/deepseek.js";
import type { UIEvent } from "../events/ui-events.js";
import type { StreamDelta, UsageInfo } from "../types/chat.js";
import type { ChatMessage } from "../types/session.js";
import { partialAssistantMessage } from "../utils/stream-recovery.js";
import { fromOpenAIToolCalls, type ToolCall } from "../types/tool-call.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import {
  materializeDeepSeekImageMessages,
  materializeImageMessages,
  uploadDeepSeekFile,
  uploadDeepSeekFileData,
  resolveDeepSeekFilesAPI,
} from "../utils/image-assets.js";
import {
  decideNext,
  EMPTY_RESPONSE_RETRY_PROMPT,
  nextCounters,
} from "./orchestrator/decide.js";
import {
  buildUsageStats,
  isAccumulatedUsage,
  toUsageInfo,
} from "./orchestrator/usage.js";
import {
  isDeepSeekEndpoint,
  prepareRequest,
} from "./orchestrator/turn-request.js";
import { runToolCallsCollecting } from "./orchestrator/tool-loop.js";
import { runTurnLoop, type TurnContext } from "./orchestrator/turn-loop.js";
import { resolveProtocol } from "./orchestrator/request-builder.js";
import { normalizeResponsesResponse } from "./orchestrator/responses-shape.js";

/** 差分基准的会话上限，超出后按插入序淘汰最老的一条。 */
const ACCUMULATED_USAGE_BASELINE_MAX = 512;

/** 每个会话上一次读到的「上游累计 token」，用于把累计值差分成本请求新增。 */
const accumulatedUsageBaseline = new Map<string, number>();

/**
 * 上游是否只给「会话累计」token：网关（llm-deepseek-web）用 x_usage_source 标注，
 * 该值是随会话单调增长的累计量（含新增输入），不是本请求的生成量。
 */
/**
 * 把上游累计值差分成本请求新增（本请求 = 本次累计 − 上次累计）。
 * 累计回退（上游会话重建、网关重启）时无法差分，退回本次累计本身。
 */
function deltaOfAccumulatedUsage(sessionId: string | undefined, accumulated: number): number {
  if (!sessionId || accumulated <= 0) return accumulated;

  const baseline = accumulatedUsageBaseline.get(sessionId);
  accumulatedUsageBaseline.set(sessionId, accumulated);
  if (accumulatedUsageBaseline.size > ACCUMULATED_USAGE_BASELINE_MAX) {
    const oldest = accumulatedUsageBaseline.keys().next().value;
    if (oldest !== undefined) accumulatedUsageBaseline.delete(oldest);
  }

  if (baseline === undefined || accumulated <= baseline) return accumulated;
  return accumulated - baseline;
}


export function isAbortError(error: any): boolean {
  return error?.name === "AbortError" ||
    error?.name === "APIUserAbortError" ||
    error?.message === "Request was aborted." ||
    error?.message?.includes("abort");
}

// Chat Completions API 客户端
export interface ChatClient {
  baseURL: string;
  protocol?: "responses" | "chat_completions";
  create(params: any, options?: any): Promise<any>;
  createResponse?(params: any, options?: any): Promise<any>;
  uploadFile?(imagePath: string): Promise<{ id: string }>;
  uploadFileData?(data: string, filename: string, mimeType: string): Promise<{ id: string }>;
}

// 创建 Chat Completions 客户端
export function createChatClient(
  apiKey: string,
  baseURL?: string,
  protocol?: "responses" | "chat_completions",
): ChatClient {
  const finalURL = baseURL || "https://api.openai.com/v1";
  const normalizedApiKey = apiKey.trim();
  const client = new OpenAI({
    apiKey: normalizedApiKey || "zbot-local-no-auth",
    baseURL: finalURL,
    maxRetries: 0,
    defaultHeaders: {
      Authorization: normalizedApiKey ? undefined : null,
      "x-llm-caller": "zbot",
    },
    fetch: getOpenAIProxyFetch(),
  });
  return {
    baseURL: finalURL,
    protocol,
    async create(params, options) {
      // 对于需要完整路径的 API（如 DashScope），直接调用 chat.completions.create
      // 库会自动添加 /chat/completions
      const response = await client.chat.completions.create(params, options);
      return response;
    },
    async createResponse(params, options) {
      return client.responses.create(params, options);
    },
    async uploadFile(imagePath: string) {
      const fileID = await uploadDeepSeekFile(imagePath, {
        filesAPI: resolveDeepSeekFilesAPI(finalURL),
        apiKey: normalizedApiKey,
      });
      return { id: fileID };
    },
    async uploadFileData(data: string, filename: string, mimeType: string) {
      const fileID = await uploadDeepSeekFileData(data, filename, mimeType, {
        filesAPI: resolveDeepSeekFilesAPI(finalURL),
        apiKey: normalizedApiKey,
      });
      return { id: fileID };
    },
  };
}

export interface OrchestratorOptions {
  query: string;
  queryContent?: UserContent;
  client: ChatClient;
  model: string;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  toolChoice?: "auto" | "none";
  tools?: any[];
  /** 托管工具类型（Responses 专用，来自 OPENAI_RESPONSES_HOSTED_TOOLS）：声明给上游执行，本地没有对应实现。 */
  hostedTools?: string[];
  // 执行工具的函数
  executeTool?: (name: string, args: any) => Promise<ToolExecutionResponse>;
  // 获取系统提示词
  getSystemPrompt?: () => string;
  // 获取工具定义
  getToolDefinitions?: () => any[];
  /** 是否使用 Chat Completions 流式响应。 */
  stream?: boolean;
  onToolCall?: (name: string, args: any, mode: 'serial' | 'parallel') => void;
  onToolResult?: (name: string, result: string) => void;
  onAssistantToolCallContent?: (content: string) => Promise<void> | void;
  onInvalidAssistantHistory?: () => void;
  onProgress?: (text: string) => void;
  // 统一渲染事件流（流式增量 + 执行阶段 + 收尾），与 onToolCall 等回调并存
  onEvent?: (event: UIEvent) => void | Promise<void>;
  // 历史消息
  history?: ChatMessage[];
  // 会话标识，仅 zbot 对话请求提供
  sessionId?: string;
  contextEpochId?: string;
  initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
  /** 消费执行期间累积的 pending 消息（组合成一条附加到后续请求） */
  consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
  onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void | Promise<void>;
  /** 后续工具轮次发请求前，可替换仅用于请求的上下文；完整本轮消息仍单独保留。 */
  compactMessagesIfNeeded?: (messages: ChatMessage[], lastPromptTokens?: number, providerMaxTokens?: number) => Promise<ChatMessage[] | undefined>;
  /** 每轮请求前返回仅用于本次请求的提醒消息（不落盘、不进历史），用于任务清单等状态回环。 */
  getContextReminders?: () => string[] | undefined;
  /** 回合内每条完整消息定稿时的落盘回调（串行调用）。 */
  onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
  onStreamDelta?: (delta: StreamDelta, requestIndex: number) => Promise<void>;
  /** 续跑：不把 query 作为 user 消息插入（历史尾部已是待续上下文，上游无感）。 */
  skipUserQuery?: boolean;
  /** 续跑：进入循环前先执行的工具调用（补齐中断时缺结果的调用）。 */
  pendingToolCalls?: ToolCall[];
  // 中止信号
  signal?: AbortSignal;
}

export interface ChatExecutionResult {
  content: string;
  toolCalls?: number;
  messages: ChatMessage[];
}

/**
 * 执行 Chat Completions API 工具调用
 * 支持完整的 LLM 调用循环
 */
export async function executeWithChat(
  options: OrchestratorOptions,
): Promise<ChatExecutionResult> {
  const {
    query,
    queryContent,
    client,
    model,
    tools = [],
    hostedTools,
    toolChoice,
    executeTool,
    getSystemPrompt,
    getToolDefinitions,
    stream = false,
    onToolCall,
    onToolResult,
    onAssistantToolCallContent,
    onEvent,
    history = [],
    sessionId,
    contextEpochId,
    initialRequestKind = "user_request",
    consumePendingMessages,
    onConsumePending,
    compactMessagesIfNeeded,
    getContextReminders,
    onTurnMessage,
    onStreamDelta,
    skipUserQuery = false,
    pendingToolCalls,
    signal,
  } = options;

  const effectiveSessionId = sessionId ?? "standalone";

  // ── 消息容器与落盘：turn_message 串行落盘，保证事件顺序与消息顺序一致 ──
  const messages: ChatMessage[] = [];
  const turnMessages: ChatMessage[] = [];
  let persistChain: Promise<void> = Promise.resolve();
  let persistFailure: unknown;
  const persistMessage = (message: ChatMessage): void => {
    if (!onTurnMessage) return;
    // 必须传原对象：run-turn 靠对象身份去重（失败/中断回合按 partialMessages 补写），
    // 这里换成副本会让去重恒为 false 并重复落 turn_message。
    // audioContent 的剔除下沉到唯一落盘口 persistTurnMessage。
    persistChain = persistChain
      .then(() => onTurnMessage(message))
      .catch((error: any) => {
        persistFailure ??= error;
        console.error("⚠️ [Orchestrator] turn_message 落盘失败:", error?.message ?? error);
      });
  };
  const appendTurnMessage = (message: ChatMessage): void => {
    ctx.messages.push(message);
    turnMessages.push(message);
    persistMessage(message);
  };

  // 装配初始上下文
  if (getSystemPrompt) {
    const systemPrompt = getSystemPrompt();
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...history);
  // 续跑时不插入 query：历史尾部已是待续上下文，上游无感
  if (!skipUserQuery) messages.push({ role: "user", content: queryContent ?? query });

  const emit = (event: UIEvent): void => { void onEvent?.(event); };
  let toolIdCounter = 0;

  const runToolCalls = async (calls: ToolCall[]): Promise<void> => {
    if (calls.length === 0) return;
    const results = await runToolCallsCollecting(
      {
        ...(executeTool ? { executeTool } : {}),
        ...(onToolCall ? { onToolCall } : {}),
        ...(onToolResult ? { onToolResult } : {}),
        emit,
        nextToolId: () => ++toolIdCounter,
        assertNotAborted: () => {
          if (signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        },
      },
      calls,
    );
    // 统一入列：并行只影响耗时，不影响消息顺序
    for (const message of results) appendTurnMessage(message);
  };

  const ctx: TurnContext = {
    client,
    model,
    baseURL: client.baseURL,
    tools,
    ...(signal ? { signal } : {}),
    stream: !!stream,
    sessionId: effectiveSessionId,
    ...(contextEpochId ? { contextEpochId } : {}),
    initialRequestKind,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.reasoningEfforts ? { reasoningEfforts: options.reasoningEfforts } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    messages,
    turnMessages,
    counters: { emptyResponse: 0, lengthRetry: 0 },
    iteration: 0,
    ...(hostedTools?.length ? { hostedTools } : {}),
    emit,
    appendTurnMessage,
    persistMessage,
    ...(consumePendingMessages ? { consumePendingMessages } : {}),
    ...(onConsumePending ? { onConsumePending } : {}),
    ...(compactMessagesIfNeeded ? { compactMessagesIfNeeded } : {}),
    ...(getToolDefinitions ? { getToolDefinitions } : {}),
    ...(getContextReminders ? { getContextReminders } : {}),
    ...(onAssistantToolCallContent ? { onAssistantToolCallContent } : {}),
    ...(options.onInvalidAssistantHistory ? { onInvalidAssistantHistory: options.onInvalidAssistantHistory } : {}),
    runToolCalls,
    sendRequest: (requestBody: Record<string, any>) => sendProtocolRequest({
      client,
      protocol: resolveProtocol(client),
      requestBody,
      stream: !!stream,
      signal,
      emit,
      ...(onStreamDelta ? { persistDelta: (delta: StreamDelta) => onStreamDelta(delta, ctx.iteration) } : {}),
    }),
  };

  try {
    // 续跑：先把中断时缺结果的工具调用补跑完，请求体与中断前一致
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      await runToolCalls(pendingToolCalls);
    }
    return await runTurnLoop(ctx);
  } finally {
    // 回合结束（含中断/报错）前等增量消息落盘完成
    await persistChain;
    if (persistFailure) {
      const error: any = new Error("回合消息落盘失败，请检查会话存储目录", { cause: persistFailure });
      error.partialMessages = turnMessages;
      emit({ type: "error", message: error.message });
      throw error;
    }
  }
}

/**
 * 按协议发起一次请求：流式走聚合器，非流式直接返回原始响应。
 * 协议分派只在这里出现一次，循环里不再判断 useResponses。
 */
async function sendProtocolRequest(input: {
  client: ChatClient;
  protocol: "responses" | "chat_completions";
  requestBody: Record<string, any>;
  stream: boolean;
  signal: AbortSignal | undefined;
  emit: (event: UIEvent) => void;
  persistDelta?: (delta: StreamDelta) => Promise<void>;
}): Promise<any> {
  const { client, protocol, requestBody, stream, signal, emit, persistDelta } = input;
  if (protocol === "responses") {
    return stream
      ? collectResponsesResponse(client, requestBody, signal, emit, persistDelta)
      : client.createResponse?.(requestBody, { signal });
  }
  return stream
    ? collectStreamResponse(client, requestBody, signal, emit, persistDelta)
    : client.create(requestBody, { signal });
}

/**
 * 遍历 Chat Completions 流式响应，聚合出与非流式一致的 assistantMsg，并顺带发出渲染事件。
 */
async function collectStreamResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
): Promise<any> {
  const stream = await client.create(requestBody, { signal });
  const { assistantMsg, usage, model, finishReason } = await collectStream(stream, emit, persistDelta);
  return {
    model,
    choices: [{ message: assistantMsg, finish_reason: finishReason }],
    usage,
  };
}

/** 托管搜索的事件族：web_search_call（联网）与 tool_search_call（工具发现）。 */
function isManagedSearchEvent(type: unknown): boolean {
  return typeof type === "string"
    && (type.startsWith("response.web_search_call.") || type.startsWith("response.tool_search_call."));
}

async function collectResponsesResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
): Promise<any> {
  const stream = await client.createResponse?.(requestBody, { signal });
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    return stream;
  }

  let completedResponse: any;
  const outputItems: any[] = [];
  const functionCalls = new Map<string, {
    index: number;
    id: string;
    name: string;
    arguments: string;
    /** custom 是自由文本工具（apply_patch）：arguments 存的是裸补丁文本，不是 JSON。 */
    kind: "function" | "custom";
  }>();
  let model = "";
  let usage: any;
  let partialText = "";
  let partialReasoning = "";
  // 托管搜索的进度按 item_id 跟踪：同一轮可能连续搜多次，且会并行开多个
  const activeSearches = new Set<string>();
  let finishedSearches = 0;

  try {
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        await persistDelta?.({ text: event.delta });
        partialText += event.delta;
        emit({ type: "text_delta", delta: event.delta });
      } else if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
        await persistDelta?.({ reasoning: event.delta });
        partialReasoning += event.delta;
        emit({ type: "reasoning_delta", delta: event.delta });
      } else if (event.type === "response.output_item.added") {
        const item = event.item;
        if (item?.type === "function_call" || item?.type === "custom_tool_call") {
          const isCustom = item.type === "custom_tool_call";
          const call = {
            index: event.output_index ?? functionCalls.size,
            id: item.call_id ?? item.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
            name: item.name ?? "",
            arguments: (isCustom ? item.input : item.arguments) ?? "",
            kind: isCustom ? "custom" as const : "function" as const,
          };
          await persistDelta?.({ toolCalls: [{
            index: call.index,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          }] });
          functionCalls.set(item.id ?? call.id, call);
          emit({ type: "toolcall_start", index: call.index, id: call.id, name: call.name });
        }
      } else if (event.type === "response.function_call_arguments.delta"
        || event.type === "response.custom_tool_call_input.delta") {
        const key = event.item_id;
        const call = functionCalls.get(key) ?? {
          index: event.output_index ?? functionCalls.size,
          id: key,
          name: "",
          arguments: "",
          kind: event.type === "response.custom_tool_call_input.delta" ? "custom" as const : "function" as const,
        };
        const delta = typeof event.delta === "string" ? event.delta : "";
        await persistDelta?.({ toolCalls: [{ index: call.index, arguments: delta }] });
        call.arguments += delta;
        functionCalls.set(key, call);
        emit({ type: "toolcall_args_delta", index: call.index, delta });
      } else if (event.type === "response.custom_tool_call_input.done") {
        // 网关可能只在 done 里给完整文本；已有增量时不重复追加
        const key = event.item_id;
        const input = typeof event.input === "string" ? event.input : "";
        const call = functionCalls.get(key);
        if (call && call.arguments.length === 0 && input) {
          await persistDelta?.({ toolCalls: [{ index: call.index, arguments: input }] });
          call.arguments = input;
          emit({ type: "toolcall_args_delta", index: call.index, delta: input });
        }
      } else if (event.type === "response.output_text.done") {
        // 网关把增量合并成单个 done 事件时补上正文，已有 delta 时不重复追加
        const text = typeof event.text === "string" ? event.text : "";
        if (partialText.length === 0 && text) {
          await persistDelta?.({ text });
          partialText = text;
          emit({ type: "text_delta", delta: text });
        }
      } else if (event.type === "response.reasoning_text.done") {
        const text = typeof event.text === "string" ? event.text : "";
        if (partialReasoning.length === 0 && text) {
          await persistDelta?.({ reasoning: text });
          partialReasoning = text;
          emit({ type: "reasoning_delta", delta: text });
        }
      } else if (event.type === "response.function_call_arguments.done") {
        const key = event.item_id;
        const args = typeof event.arguments === "string" ? event.arguments : "";
        const call = functionCalls.get(key);
        if (call && call.arguments.length === 0 && args) {
          await persistDelta?.({ toolCalls: [{ index: call.index, arguments: args }] });
          call.arguments = args;
          emit({ type: "toolcall_args_delta", index: call.index, delta: args });
        }
      } else if (event.type === "response.output_item.done") {
        if (event.item && event.output_index !== undefined) {
          outputItems[event.output_index] = event.item;
        }
      } else if (isManagedSearchEvent(event.type)) {
        // 托管搜索由上游执行：in_progress / searching / completed 三个阶段都只转成进度提示，
        // 事件本身不带查询词与来源，action 只在 output_item.done 的 item 里出现
        const label = event.type.startsWith("response.tool_search_call.") ? "找工具" : "搜索";
        const key = typeof event.item_id === "string"
          ? event.item_id
          : `search_${event.output_index ?? activeSearches.size}`;
        if (event.type.endsWith(".completed")) {
          if (activeSearches.delete(key)) finishedSearches += 1;
          if (activeSearches.size === 0 && finishedSearches > 0) {
            emit({ type: "progress", message: `🌐 ${label}完成 ${finishedSearches}` });
          }
        } else if (!activeSearches.has(key)) {
          activeSearches.add(key);
          emit({ type: "progress", message: `🌐 ${label}中 ${activeSearches.size + finishedSearches}...` });
        }
      } else if (event.type === "response.completed") {
        completedResponse = event.response;
        model = event.response?.model ?? model;
        usage = event.response?.usage ?? usage;
      } else if (event.type === "response.failed" || event.type === "response.incomplete") {
        completedResponse = { ...(event.response ?? {}), status: event.type === "response.failed" ? "failed" : "incomplete" };
        model = event.response?.model ?? model;
        usage = event.response?.usage ?? usage;
      }
    }
  } catch (error) {
    throw withPartialMessage(error, partialAssistantMessage(partialText, partialReasoning, [...functionCalls.values()]));
  }

  for (const call of functionCalls.values()) {
    emit({
      type: "toolcall_end",
      index: call.index,
      id: call.id,
      name: call.name,
      argsJson: toolCallArgsJson(call.kind, call.arguments),
    });
  }

  const hasFailed = completedResponse?.status === "failed" || completedResponse?.status === "incomplete";
  const recovered = hasFailed
    ? partialAssistantMessage(partialText, partialReasoning, [...functionCalls.values()])
    : undefined;
  const fallbackText = typeof recovered?.content === "string" ? recovered.content : partialText;
  const streamedItems = outputItems.filter(Boolean);
  const suppliedItems = Array.isArray(completedResponse?.output) && completedResponse.output.length > 0
    ? completedResponse.output
    : streamedItems;
  const hasOutputText = suppliedItems.some((item: any) => item?.type === "message"
    && item.content?.some((part: any) => part?.type === "output_text"));
  const output = fallbackText && !hasOutputText
    ? [...suppliedItems, { type: "message", content: [{ type: "output_text", text: fallbackText }] }]
    : suppliedItems;
  // 流里出现过、但 output_item.done 与 completed.output 都缺的调用：用累积的名字与参数补齐
  const knownCallIds = new Set(output.map((item: any) => item?.call_id ?? item?.id).filter(Boolean));
  const missingCalls = [...functionCalls.values()]
    .filter(call => call.name && !knownCallIds.has(call.id))
    .map(call => (call.kind === "custom"
      ? { type: "custom_tool_call", id: call.id, call_id: call.id, name: call.name, input: call.arguments, status: "completed" }
      : { type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments }));
  const mergedOutput = missingCalls.length > 0 ? [...output, ...missingCalls] : output;
  if (completedResponse) completedResponse.output = mergedOutput;
  if (completedResponse && partialReasoning) completedResponse.reasoning_content = partialReasoning;
  return completedResponse ?? {
    model,
    output: mergedOutput,
    ...(partialReasoning ? { reasoning_content: partialReasoning } : {}),
    usage,
  };
}

/** 工具调用的展示/落盘参数：custom 工具把裸文本重新包成 {"patch": ...}，与历史消息同形。 */
function toolCallArgsJson(kind: "function" | "custom", argumentsText: string): string {
  return kind === "custom" ? patchArgumentsJson(argumentsText) : argumentsText;
}

function withPartialMessage(error: unknown, message: ChatMessage | undefined): unknown {
  if (!message) return error;
  const wrapped = error && typeof error === "object" ? error : new Error(String(error));
  (wrapped as { partialMessage?: ChatMessage }).partialMessage = message;
  return wrapped;
}

async function collectStream(
  stream: AsyncIterable<any>,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
): Promise<{ assistantMsg: any; usage: any; model: string; finishReason: string }> {
  let content = "";
  let reasoningContent = "";
  const toolCalls = new Map<number, {
    id: string;
    name: string;
    arguments: string;
    kind: "function" | "custom";
    thoughtSignature?: string;
  }>();
  let usage: any;
  let model = "";
  let finishReason = "";
  // 无 index 的 tool_call（非标准流或 mock）按出现顺序分配
  let toolCallCursor = 0;

  try {
    for await (const chunk of stream) {
      if (chunk.model) model = chunk.model;
      // usage 与 x_usage_source 同帧下发（网关收尾帧），一起留住以便判定口径
      if (chunk.usage) usage = chunk.usage;
      if (chunk.x_usage_source) usage = { ...(usage ?? {}), x_usage_source: chunk.x_usage_source };

      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};
      const toolDeltas = (delta.tool_calls ?? []).map((call: any) => ({
        ...call,
        index: call.index ?? toolCallCursor++,
      }));
      // custom 的增量续片不一定重复带 type：按字段存在与否取值，才能拼出完整补丁
      const toolDeltaName = (call: any) => call?.custom?.name ?? call?.function?.name;
      const toolDeltaArgs = (call: any) => call?.custom?.input ?? call?.function?.arguments;
      const streamDelta: StreamDelta = {
        ...(delta.content ? { text: delta.content } : {}),
        ...(delta.reasoning_content ? { reasoning: delta.reasoning_content } : {}),
        ...(toolDeltas.length > 0 ? { toolCalls: toolDeltas.map((call: any) => ({
          index: call.index,
          ...(call.id ? { id: call.id } : {}),
          ...(toolDeltaName(call) ? { name: toolDeltaName(call) } : {}),
          ...(toolDeltaArgs(call) ? { arguments: toolDeltaArgs(call) } : {}),
          ...((call.thought_signature ?? call.thoughtSignature)
            ? { thoughtSignature: call.thought_signature ?? call.thoughtSignature }
            : {}),
        })) } : {}),
      };
      if (streamDelta.text || streamDelta.reasoning || streamDelta.toolCalls?.length) {
        await persistDelta?.(streamDelta);
      }

      if (delta.content) {
        content += delta.content;
        emit({ type: "text_delta", delta: delta.content });
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        emit({ type: "reasoning_delta", delta: delta.reasoning_content });
      }
      if (toolDeltas.length > 0) {
        for (const tc of toolDeltas) {
          const index = tc.index;
          let slot = toolCalls.get(index);
          if (!slot) {
            slot = {
              id: "",
              name: "",
              arguments: "",
              kind: tc.type === "custom" || tc.custom ? "custom" : "function",
            };
            toolCalls.set(index, slot);
          }
          if (tc.id) slot.id = tc.id;
          const thoughtSignature = tc.thought_signature ?? tc.thoughtSignature;
          if (thoughtSignature) slot.thoughtSignature = thoughtSignature;
          const name = toolDeltaName(tc);
          const argsDelta = toolDeltaArgs(tc);
          if (name) {
            slot.name = name;
            emit({ type: "toolcall_start", index, id: slot.id, name: slot.name });
          }
          if (argsDelta) {
            slot.arguments += argsDelta;
            emit({ type: "toolcall_args_delta", index, delta: argsDelta });
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (error) {
    throw withPartialMessage(error, partialAssistantMessage(content, reasoningContent, [...toolCalls.values()]));
  }

  for (const [index, slot] of toolCalls) {
    emit({
      type: "toolcall_end",
      index,
      id: slot.id,
      name: slot.name,
      argsJson: toolCallArgsJson(slot.kind, slot.arguments),
    });
  }

  const assistantMsg: any = { role: "assistant", content: content || null };
  if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
  if (toolCalls.size > 0) {
    assistantMsg.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => ({
        id: slot.id || `call_${crypto.randomUUID().slice(0, 8)}`,
        ...(slot.kind === "custom"
          ? { type: "custom", custom: { name: slot.name, input: slot.arguments } }
          : { type: "function", function: { name: slot.name, arguments: slot.arguments } }),
        ...(slot.thoughtSignature ? { thought_signature: slot.thoughtSignature } : {}),
      }));
  }
  return { assistantMsg, usage, model, finishReason };
}
