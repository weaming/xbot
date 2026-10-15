/**
 * Chat Completions API orchestrator
 * 使用 OpenAI Chat Completions 协议
 * 支持完整的 LLM 调用循环
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { recordLLMExchange, type LLMRequestKind, type LLMUsageLogEntry } from "../utils/logger.js";
import { getOpenAIToolDefinitionsByNames } from "./tool-registry.js";
import { normalizeToolDefinitionsForDeepSeek } from "./tool-schema.js";
import {
  compactJsonToolOutput,
  type ToolImageContent,
  type ToolExecutionOutput,
  type ToolExecutionResponse,
} from "./tool-interface.js";
import { getOpenAIProxyFetch } from "../utils/proxy.js";
import { DEEPSEEK_OFFICIAL_HOST, endpointHost } from "../pricing/deepseek.js";
import type { UIEvent } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { ChatMessage } from "../types/session.js";
import { fromOpenAIToolCalls, type ToolCall } from "../types/tool-call.js";
import { projectChatMessagesForPrompt } from "../utils/tool-result-context.js";
import { estimateTextTokens } from "../utils/token-estimator.js";
import { countMessagesTokens, countTextTokens } from "../utils/tokenizer.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import {
  materializeDeepSeekImageMessages,
  materializeImageMessages,
  uploadDeepSeekFile,
  uploadDeepSeekFileData,
  resolveDeepSeekFilesAPI,
} from "../utils/image-assets.js";

/** 空响应（无工具调用且无内容）最大重试次数 */
const MAX_EMPTY_RESPONSE_RETRIES = 2;
/** length 截断最大重试次数（同请求头重发，理论上不应再次截断；保底防 provider 抽风）。 */
const MAX_LENGTH_RETRIES = 2;
/** 空响应首次重试时追加的提示（后续重试不再追加，原样重发） */
const EMPTY_RESPONSE_RETRY_PROMPT =
  "Your last response was empty — no tool call and no content. This usually means the tool you intended to call is not available in the tools list or the arguments were wrong. Please re-examine the tools list and continue: either reply directly or call the correct tool.";

/** 差分基准的会话上限，超出后按插入序淘汰最老的一条。 */
const ACCUMULATED_USAGE_BASELINE_MAX = 512;

/** 每个会话上一次读到的「上游累计 token」，用于把累计值差分成本请求新增。 */
const accumulatedUsageBaseline = new Map<string, number>();

/**
 * 上游是否只给「会话累计」token：网关（llm-deepseek-web）用 x_usage_source 标注，
 * 该值是随会话单调增长的累计量（含新增输入），不是本请求的生成量。
 */
function isAccumulatedUsage(usage: any): boolean {
  return usage?.x_usage_source?.completion_tokens === "upstream";
}

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

/** 本地统计一次请求的输入 token（消息 + 工具 schema），仅用于上游不给输入侧 token 时的展示兜底。 */
async function estimateInputTokens(messages: any[], tools: any[], model?: string): Promise<number> {
  const total = await countMessagesTokens(messages, model);
  if (tools.length === 0) return total;
  return total + (await countTextTokens(JSON.stringify(tools), model));
}

/** 抛错前先把 stopReason 透传给上层，UI/TUI 能在 system 消息里直接显示原因。 */
function providerError(finishReason: string, message: string): Error {
    const err = new Error(message);
    (err as any).finishReason = finishReason;
    return err;
}

export function isAbortError(error: any): boolean {
  return error.name === "AbortError" ||
    error.name === "APIUserAbortError" ||
    error.message === "Request was aborted." ||
    error.message?.includes("abort");
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
    apiKey: normalizedApiKey || "xbot-local-no-auth",
    baseURL: finalURL,
    maxRetries: 0,
    defaultHeaders: {
      Authorization: normalizedApiKey ? undefined : null,
      "x-llm-caller": "xbot",
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

// 从响应中提取文本
function extractText(message: any): string | null {
  return message.content || null;
}

export interface OrchestratorOptions {
  query: string;
  queryContent?: UserContent;
  client: ChatClient;
  model: string;
  tools?: any[];
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
  onProgress?: (text: string) => void;
  // 统一渲染事件流（流式增量 + 执行阶段 + 收尾），与 onToolCall 等回调并存
  onEvent?: (event: UIEvent) => void | Promise<void>;
  // 历史消息
  history?: ChatMessage[];
  // 会话标识，仅 xbot 对话请求提供
  sessionId?: string;
  contextEpochId?: string;
  initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
  /** 消费执行期间累积的 pending 消息（组合成一条附加到后续请求） */
  consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
  onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void;
  /** 后续工具轮次发请求前，可替换仅用于请求的上下文；完整本轮消息仍单独保留。 */
  compactMessagesIfNeeded?: (messages: ChatMessage[], lastPromptTokens?: number) => Promise<ChatMessage[] | undefined>;
  /** 每轮请求前返回仅用于本次请求的提醒消息（不落盘、不进历史），用于任务清单等状态回环。 */
  getContextReminders?: () => string[] | undefined;
  /** 回合内每条完整消息定稿时的落盘回调（串行调用，单条失败只记日志）。 */
  onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
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

function normalizeToolExecutionOutput(output: ToolExecutionResponse): ToolExecutionOutput {
  return typeof output === "string" ? { content: output } : output;
}

function shouldUseResponses(client: ChatClient): boolean {
  if (!client.createResponse) return false;
  return client.protocol === "responses";
}

function responsesToolDefinitions(tools: any[]): any[] {
  return tools
    .filter(tool => tool?.type === "function" && tool.function?.name)
    .map(tool => ({
      type: "function",
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
    }));
}

function responseImagePart(part: any): any {
  return {
    type: "input_image",
    image_url: part.image_url?.url,
    detail: part.image_url?.detail ?? "original",
  };
}

async function materializeResponsesInput(messages: ChatMessage[]): Promise<any[]> {
  const materializedUsers = await materializeImageMessages(messages);
  const result: any[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const materialized = materializedUsers[index] as any;

    if (message.role === "tool") {
      const output: any[] = [{ type: "input_text", text: message.content }];
      if (message.imageContent && message.imageContent.length > 0) {
        const imageMessage = await materializeImageMessages([{
          role: "user",
          content: [
            { type: "text", text: "" },
            ...message.imageContent,
          ],
        } as ChatMessage]);
        for (const part of (imageMessage[0] as any).content.slice(1)) {
          if (part.type === "image_url") {
            output.push(responseImagePart(part));
          } else if (part.type === "text" && part.text) {
            output.push({ type: "input_text", text: part.text });
          }
        }
      }
      result.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output,
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.response_output)) {
      result.push(...message.response_output);
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        result.push({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        result.push({
          type: "function_call",
          id: toolCall.id,
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? "{}",
          status: "completed",
        });
      }
      continue;
    }

    if (message.role === "system") {
      result.push({ role: "system", content: message.content });
      continue;
    }

    if (typeof materialized.content === "string") {
      result.push({ role: "user", content: materialized.content });
      continue;
    }

    result.push({
      role: "user",
      content: materialized.content.map((part: any) => part.type === "text"
        ? { type: "input_text", text: part.text }
        : responseImagePart(part)),
    });
  }

  return result;
}

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

function normalizeResponsesResponse(response: any): any {
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

/** 把工具结果中的图片补成请求专用的用户多模态消息。 */
function expandToolImageMessages(messages: ChatMessage[]): ChatMessage[] {
  const expanded: ChatMessage[] = [];
  const pendingImages: ToolImageContent[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    expanded.push({
      role: "user",
      content: [
        { type: "text", text: "工具返回了图片，请结合工具结果分析图片内容。" },
        ...pendingImages,
      ],
    });
    pendingImages.length = 0;
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      flushImages();
      expanded.push(message);
      continue;
    }

    if (message.imageContent && message.imageContent.length > 0) {
      pendingImages.push(...message.imageContent);
      const { imageContent: _imageContent, ...toolMessage } = message;
      expanded.push(toolMessage as ChatMessage);
    } else {
      expanded.push(message);
    }
  }
  flushImages();
  return expanded;
}

function stripResponsesMetadata(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant" || !Array.isArray(message.response_output)) return message;
    const { response_output: _responseOutput, ...chatMessage } = message;
    return chatMessage as ChatMessage;
  });
}

/**
 * 执行 Chat Completions API 工具调用
 * 支持完整的 LLM 调用循环
 */
export async function executeWithChat(
  options: OrchestratorOptions
): Promise<ChatExecutionResult> {
  const {
    query,
    queryContent,
    client,
    model,
    tools = [],
    executeTool,
    getSystemPrompt,
    getToolDefinitions,
    stream = false,
    onToolCall,
    onToolResult,
    onAssistantToolCallContent,
    onProgress,
    onEvent,
    history = [],
    sessionId,
    contextEpochId,
    initialRequestKind = 'user_request',
    consumePendingMessages,
    onConsumePending,
    compactMessagesIfNeeded,
    getContextReminders,
    onTurnMessage,
    skipUserQuery = false,
    pendingToolCalls,
    signal,
  } = options;

  const effectiveSessionId = sessionId ?? "standalone";

  // 构建消息列表
  let messages: ChatMessage[] = [];
  const turnMessages: ChatMessage[] = [];

  // turn_message 落盘串行链：保证事件顺序与消息顺序一致；单条失败只记日志，不阻断回合。
  let persistChain: Promise<void> = Promise.resolve();
  const appendTurnMessage = (message: ChatMessage): void => {
    messages.push(message);
    turnMessages.push(message);
    if (!onTurnMessage) return;
    persistChain = persistChain
      .then(() => onTurnMessage(message))
      .catch((error: any) => {
        console.error("⚠️ [Orchestrator] turn_message 落盘失败:", error?.message ?? error);
      });
  };

  // 空响应重试计数：无工具调用且无内容时，不入历史并追加提示消息重新请求
  let emptyResponseCount = 0;
  // length 截断重试计数：与空响应重试分开，避免互相干扰
  let lengthRetryCount = 0;

  // 添加系统提示词
  if (getSystemPrompt) {
    const systemPrompt = getSystemPrompt();
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
  }

  // 添加历史消息
  messages.push(...history);

  // 添加当前查询（续跑时不插入，保持上游请求与中断前完全一致）
  if (!skipUserQuery) {
    messages.push({ role: "user", content: queryContent ?? query });
  }

  let iteration = 0;
  let finalContent = "";
  let lastFinishReason = "stop";
  let lastUsageInfo: UsageInfo | undefined;
  let lastReasoningContent = "";
  let turnReasoning = "";
  let toolIdCounter = 0;
  /**
   * 本回合所有请求里最大的 provider 输入 token（真实值）。
   * 回合内请求级压缩只把「后续请求」变小，持久上下文并没有变小，所以上报规模取本回合峰值：
   * 首个请求发的是未压缩的完整上下文，含 system prompt 与工具定义，能代表真实规模。
   * 字段隔离：latestPromptTokens 只承载 provider 数据，绝不用本地估算冒充。
   */
  let peakPromptTokens = 0;
  const discoveredToolNames = new Set<string>();

  // 统一事件出口：新增 onEvent 通道，现有回调仍在各自位置保持调用。
  const emit = (event: UIEvent): void => {
    void onEvent?.(event);
  };

  /** 执行单个工具调用并把结果追加进本回合消息。 */
  const processToolCall = async (toolCall: ToolCall, mode: 'serial' | 'parallel'): Promise<void> => {
    onToolCall?.(toolCall.name, toolCall.args, mode);
    const toolId = ++toolIdCounter;
    emit({ type: "tool_start", toolId, callId: toolCall.id, name: toolCall.name, args: toolCall.args, mode });
    const toolStartedAt = Date.now();

    let toolOutput = "";
    let toolFailed = false;
    let toolContextPolicy: ToolExecutionOutput["contextPolicy"];
    let toolImageContent: ToolExecutionOutput["imageContent"];

    if (executeTool) {
      try {
        const executionOutput = normalizeToolExecutionOutput(
          await executeTool(toolCall.name, toolCall.args),
        );
        toolOutput = executionOutput.content;
        toolContextPolicy = executionOutput.contextPolicy;
        toolImageContent = executionOutput.imageContent;

        // search_tools 返回的工具可按配置重新注入后续请求。
        if (toolCall.name === "search_tools") {
          let discoveredNames: string[] = [];
          try {
            const parsed = JSON.parse(toolOutput);
            if (Array.isArray(parsed?.tools)) {
              discoveredNames = parsed.tools
                .map((tool: any) => tool?.function?.name)
                .filter((name: unknown): name is string => typeof name === "string");
            }
          } catch {
            discoveredNames = [];
          }

          if (discoveredNames.length > 0) {
            const discoveredTools = getOpenAIToolDefinitionsByNames(discoveredNames);
            for (const tool of discoveredTools) {
              const toolName = tool.function?.name;
              if (toolName) {
                discoveredToolNames.add(toolName);
              }
            }
            // schema 由下一轮 tools 参数提供，结果只回传名字列表省 token
            toolOutput = JSON.stringify(discoveredNames);
          }
        }

        toolOutput = compactJsonToolOutput(toolOutput, toolCall.name);

      } catch (error: any) {
        if (isAbortError(error)) throw error;
        toolFailed = true;
        toolOutput = `Error: ${error.message}`;
      }
    } else {
      toolOutput = JSON.stringify({
        mock: true,
        tool: toolCall.name,
        args: toolCall.args,
        timestamp: new Date().toISOString(),
      });
      toolOutput = compactJsonToolOutput(toolOutput, toolCall.name);
    }

    appendTurnMessage({
      role: "tool",
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: toolOutput,
      ...(toolContextPolicy ? { contextPolicy: toolContextPolicy } : {}),
      ...(toolImageContent && toolImageContent.length > 0 ? { imageContent: toolImageContent } : {}),
    });

    onToolResult?.(toolCall.name, toolOutput);
    emit({ type: "tool_result", toolId, callId: toolCall.id, name: toolCall.name, summary: toolOutput, isError: toolFailed, durationMs: Date.now() - toolStartedAt });
  };

  /** 同一批工具调用：search_tools 有副作用必须串行，其余并行。 */
  const runToolCalls = async (calls: ToolCall[]): Promise<void> => {
    if (calls.some(toolCall => toolCall.name === "search_tools")) {
      for (const toolCall of calls) {
        await processToolCall(toolCall, 'serial');
      }
      return;
    }
    await Promise.all(calls.map(toolCall => processToolCall(toolCall, 'parallel')));
  };

  // 续跑：先把中断时缺结果的工具调用补跑完，再进入正常循环（请求体与中断前一致）
  if (pendingToolCalls && pendingToolCalls.length > 0) {
    await runToolCalls(pendingToolCalls);
  }

  try {
    while (true) {
      if (iteration > 0) emit({ type: "turn_end", iteration });
      iteration++;
      emit({ type: "turn_start", iteration });

      // 检查是否已中止
      if (signal?.aborted) throw new DOMException("User terminated the request", "AbortError");

      // 消费执行期间新进入的 pending 消息并注入本轮后续请求
      if (iteration > 1 && consumePendingMessages) {
        const pending = consumePendingMessages();
        if (pending && pending.length > 0) {
          const pendingInputs = pending.map(input => typeof input === "string" ? { text: input } : input);
          const pendingInput: UserMessageInput = {
            text: pendingInputs.map(input => input.text).join("\n"),
            images: pendingInputs.flatMap(input => input.images ?? []),
          };
          appendTurnMessage({ role: "user", content: toUserContent(pendingInput) });
          onConsumePending?.(pendingInput.text, pending);
        }
      }

      if (iteration > 1 && compactMessagesIfNeeded) {
        const compactedMessages = await compactMessagesIfNeeded(messages, lastUsageInfo?.promptTokens);
        if (compactedMessages) messages = compactedMessages;
      }

      // 获取工具定义
      let currentTools = tools;
      if (getToolDefinitions) {
        currentTools = getToolDefinitions();
      }
      // 初始工具按名称排序，保证工具注册顺序不影响请求前缀，利于缓存命中
      currentTools.sort((a: any, b: any) =>
        (a.function?.name ?? "").localeCompare(b.function?.name ?? ""));
      // 注入的工具只追加尾部（不再重排），同一会话内前缀稳定，每次只 miss 新增工具的定义
      if (discoveredToolNames.size > 0) {
        const injectedTools = getOpenAIToolDefinitionsByNames([...discoveredToolNames]);
        const currentToolNames = new Set(currentTools.map((tool: any) => tool.function?.name));
        currentTools = [
          ...currentTools,
          ...injectedTools.filter((tool: any) => !currentToolNames.has(tool.function?.name)),
        ];
      }

      // 提醒消息只追加在请求尾部：不进历史、不落盘，前缀不变仍可命中缓存
      const promptMessages = projectChatMessagesForPrompt(messages);
      const reminders = iteration > 1 ? getContextReminders?.() ?? [] : [];
      const isDeepSeekProvider = model.toLowerCase().includes("deepseek")
        || endpointHost(client.baseURL) === DEEPSEEK_OFFICIAL_HOST;
      const useResponses = shouldUseResponses(client);
      const requestSourceMessages: ChatMessage[] = reminders.length > 0
        ? [...promptMessages, ...reminders.map((content) => ({ role: "user" as const, content }))]
        : promptMessages;
      const requestMessages = useResponses
        ? requestSourceMessages
        : expandToolImageMessages(stripResponsesMetadata(requestSourceMessages));
      const materializedRequestMessages = useResponses
        ? await materializeResponsesInput(requestMessages)
        : isDeepSeekProvider
          ? await materializeDeepSeekImageMessages(requestMessages, async image => {
              const uploaded = "path" in image
                ? await (client.uploadFile
                  ? client.uploadFile(image.path)
                  : Promise.reject(new Error("当前 DeepSeek 客户端不支持 Files API")))
                : await (client.uploadFileData
                  ? client.uploadFileData(image.data, image.filename, image.mimeType)
                  : Promise.reject(new Error("当前 DeepSeek 客户端不支持内存图片上传")));
              return uploaded.id;
            })
          : await materializeImageMessages(requestMessages);
      const deepSeekTools = isDeepSeekProvider
        ? normalizeToolDefinitionsForDeepSeek(currentTools)
        : currentTools;
      const requestTools = useResponses
        ? responsesToolDefinitions(deepSeekTools)
        : deepSeekTools;

      const isMiniMax = model.startsWith("MiniMax-");
      const requestBody: Record<string, any> = useResponses
        ? {
          ...(model.trim() ? { model } : {}),
          input: materializedRequestMessages,
          tools: requestTools,
          tool_choice: requestTools.length > 0 ? "auto" : "none",
        }
        : {
          ...(model.trim() ? { model } : {}),
          messages: materializedRequestMessages,
          tools: requestTools,
          tool_choice: requestTools.length > 0 ? "auto" : "none",
        };
      if (stream) {
        requestBody.stream = true;
        if (!useResponses) requestBody.stream_options = { include_usage: true };
      }
      // MiniMax 模型启用 reasoning_split：content 不含 <think>，reasoning_details 单独提供
      if (isMiniMax && !useResponses) {
        requestBody.reasoning_split = true;
      }

      // 思考模式与思考强度：优先 REASONING_EFFORT / OPENAI_REASONING_EFFORT / DEEPSEEK_REASONING_EFFORT
      const rawEffort = process.env.REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || process.env.DEEPSEEK_REASONING_EFFORT;
      const reasoningEffort = rawEffort?.trim().toLowerCase();
      if (reasoningEffort && reasoningEffort !== "auto") {
        if (useResponses) {
          if (!['disabled', 'none', 'off'].includes(reasoningEffort)) {
            requestBody.reasoning = { effort: reasoningEffort };
          }
        } else if (model.toLowerCase().includes("deepseek")) {
          if (reasoningEffort === "disabled" || reasoningEffort === "none" || reasoningEffort === "off") {
            requestBody.thinking = { type: "disabled" };
          } else {
            requestBody.thinking = { type: "enabled" };
            requestBody.reasoning_effort = reasoningEffort;
          }
        } else {
          requestBody.reasoning_effort = (reasoningEffort === "disabled" || reasoningEffort === "off") ? "none" : reasoningEffort;
        }
      }
      // exchange 日志由 logger 按 session 维护请求链与消息增量。
      recordLLMExchange("REQUEST", requestBody, { sessionId: effectiveSessionId });

      const requestStartedAt = Date.now();
      let response;
      try {
        response = useResponses
          ? (stream
            ? await collectResponsesResponse(client, requestBody, signal, emit)
            : await client.createResponse?.(requestBody, { signal }))
          : (stream
            ? await collectStreamResponse(client, requestBody, signal, emit)
            : await client.create(requestBody, { signal }));
      } catch (error) {
        throw error;
      }
      const normalizedResponse = useResponses ? normalizeResponsesResponse(response) : response;
      const assistantMsg = normalizedResponse.choices?.[0]?.message;
      const finishReason = normalizedResponse.choices?.[0]?.finish_reason;
      lastFinishReason = typeof finishReason === "string" && finishReason ? finishReason : "unknown";
      // 先归一化：日志与 UI/计费共用同一份口径（累计型上游在 toUsageInfo 里差分）
      lastUsageInfo = toUsageInfo({
        model: normalizedResponse.model || model,
        usage: normalizedResponse.usage,
        durationMs: Date.now() - requestStartedAt,
        apiHost: endpointHost(client.baseURL),
        sessionId: effectiveSessionId,
        outputText: typeof assistantMsg?.content === "string" ? assistantMsg.content : "",
        reasoningText: typeof assistantMsg?.reasoning_content === "string" ? assistantMsg.reasoning_content : "",
          estimatedPromptTokens: isAccumulatedUsage(normalizedResponse.usage)
          ? await estimateInputTokens(materializedRequestMessages, requestTools, model)
          : undefined,
      });
      // 上报本回合峰值：请求级压缩后的请求量会偏小，不能代表持久上下文规模
      peakPromptTokens = Math.max(peakPromptTokens, lastUsageInfo.promptTokens);
      lastUsageInfo.latestPromptTokens = peakPromptTokens;
      const usageEntry = buildUsageStats(
        model,
        requestBody,
        normalizedResponse,
        requestStartedAt,
        iteration === 1 ? initialRequestKind : 'tool_response',
        effectiveSessionId,
        contextEpochId,
        lastUsageInfo,
      );
      recordLLMExchange("RESPONSE", response, {
        sessionId: effectiveSessionId,
        usage: usageEntry,
      });
      emit({ type: "usage", usage: lastUsageInfo });

      if (!assistantMsg) {
        throw new Error(`${useResponses ? "Responses" : "Chat Completions"} 响应格式无效`);
      }

      // MiniMax reasoning_split=True 时，将 reasoning_details 也存入历史，保证思维链连续
      const messageToStore = { ...assistantMsg };
      if (isMiniMax && assistantMsg.reasoning_details) {
        messageToStore.reasoning_details = assistantMsg.reasoning_details;
      }

      // 记录本轮最终思考内容：message_end 用它校正 timeline 的 reasoning 片段
      lastReasoningContent = typeof assistantMsg.reasoning_content === "string"
          ? assistantMsg.reasoning_content
          : (typeof assistantMsg.reasoning === "string" ? assistantMsg.reasoning : "");
      // 本回合可能多轮 LLM 调用：reasoning 需累计，与 projector/replay 的合并语义一致
      turnReasoning += lastReasoningContent;

      const toolCalls = fromOpenAIToolCalls(assistantMsg.tool_calls);

      // content_filter 与 error：provider 显式拒绝或失败，不重试。
      if (lastFinishReason === "content_filter") {
          throw providerError("content_filter", "LLM provider 拒绝响应（content_filter）：内容被安全策略过滤");
      }
      if (lastFinishReason === "error") {
          throw providerError("error", "LLM provider 返回 error：响应被显式标为失败");
      }

      // length：输出触达 max_tokens 被截断。
      //   - 若同时给了 tool_calls：保留 assistant message（含截断的 content）入历史，继续 tool loop。
      //   - 否则：同请求头重试（reasoning 模型偶发截断可恢复）；超限后报 LLMOutputTruncated。
      if (lastFinishReason === "length" && toolCalls.length === 0) {
          lengthRetryCount += 1;
          if (lengthRetryCount > MAX_LENGTH_RETRIES) {
              throw providerError("length", "LLM 输出超长（finish_reason=length）且重试后仍被截断");
          }
          continue;
      }

      if (toolCalls.length === 0) {
          const finalResponseContent = extractText(assistantMsg)?.trim() || "";
          if (finalResponseContent) {
              appendTurnMessage(messageToStore);
              finalContent = finalResponseContent;
              break;
          }

          // 无工具调用且无内容：不入历史；首次重试追加提示，后续重试原样重发相同请求
          emptyResponseCount += 1;
          if (emptyResponseCount > MAX_EMPTY_RESPONSE_RETRIES) {
              finalContent = "";
              break;
          }
          if (emptyResponseCount === 1) {
              appendTurnMessage({ role: "user", content: EMPTY_RESPONSE_RETRY_PROMPT });
          }
          continue;
      }

      appendTurnMessage(messageToStore);

      const toolCallResponseContent = extractText(assistantMsg)?.trim();
      if (toolCallResponseContent) {
        await onAssistantToolCallContent?.(toolCallResponseContent);
        emit({ type: "assistant_text_before_tools", content: toolCallResponseContent });
      }

      await runToolCalls(toolCalls);

      // 所有工具执行完后检查中止信号
      if (signal?.aborted) throw new DOMException("User terminated the request", "AbortError");

      // 有工具调用就继续下一轮，让模型基于工具结果生成响应
      continue;
    }

    emit({ type: "turn_end", iteration });
    emit({
      type: "message_end",
      content: finalContent,
      stopReason: lastFinishReason,
      usage: lastUsageInfo,
      reasoning: turnReasoning || undefined,
    });

    return {
      content: finalContent,
      toolCalls: iteration,
      messages: turnMessages,
    };
  } catch (error: any) {
    if (error && typeof error === "object") {
      error.partialMessages = turnMessages;
    }
    // 如果是中止错误，向上抛出
    if (isAbortError(error)) {
      // 走到这里的都是显式中止（Ctrl+C / /stop / 新消息顶掉旧请求 / 退出时的收尾），
      // 与重放侧 turn_commit.stopReason 同口径，避免实时与重放两侧措辞漂移
      emit({ type: "aborted", stopReason: "aborted" });
      throw error;
    }
    emit({ type: "error", message: error.message ?? String(error) });
    throw error;
  } finally {
    // 回合结束（含中断/报错）前等增量消息落盘完成，保证调用方看到的状态已持久化
    await persistChain;
  }
}

/**
 * 遍历 Chat Completions 流式响应，聚合出与非流式一致的 assistantMsg，并顺带发出渲染事件。
 */
async function collectStreamResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
): Promise<any> {
  const stream = await client.create(requestBody, { signal });
  const { assistantMsg, usage, model, finishReason } = await collectStream(stream, emit);
  return {
    model,
    choices: [{ message: assistantMsg, finish_reason: finishReason }],
    usage,
  };
}

async function collectResponsesResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
): Promise<any> {
  const stream = await client.createResponse?.(requestBody, { signal });
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    return stream;
  }

  let completedResponse: any;
  const outputItems: any[] = [];
  const functionCalls = new Map<string, { index: number; id: string; name: string; arguments: string }>();
  let model = "";
  let usage: any;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      emit({ type: "text_delta", delta: event.delta });
    } else if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
      emit({ type: "reasoning_delta", delta: event.delta });
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item?.type === "function_call") {
        const call = {
          index: event.output_index ?? functionCalls.size,
          id: item.call_id ?? item.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
          name: item.name ?? "",
          arguments: item.arguments ?? "",
        };
        functionCalls.set(item.id ?? call.id, call);
        emit({ type: "toolcall_start", index: call.index, id: call.id, name: call.name });
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const key = event.item_id;
      const call = functionCalls.get(key) ?? {
        index: event.output_index ?? functionCalls.size,
        id: key,
        name: "",
        arguments: "",
      };
      call.arguments += event.delta;
      functionCalls.set(key, call);
      emit({ type: "toolcall_args_delta", index: call.index, delta: event.delta });
    } else if (event.type === "response.output_item.done") {
      if (event.item && event.output_index !== undefined) {
        outputItems[event.output_index] = event.item;
      }
    } else if (event.type === "response.completed") {
      completedResponse = event.response;
      model = event.response?.model ?? model;
      usage = event.response?.usage ?? usage;
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      completedResponse = event.response;
      model = event.response?.model ?? model;
      usage = event.response?.usage ?? usage;
    }
  }

  for (const call of functionCalls.values()) {
    emit({
      type: "toolcall_end",
      index: call.index,
      id: call.id,
      name: call.name,
      argsJson: call.arguments,
    });
  }

  return completedResponse ?? {
    model,
    output: outputItems.filter(Boolean),
    usage,
  };
}

async function collectStream(
  stream: AsyncIterable<any>,
  emit: (event: UIEvent) => void,
): Promise<{ assistantMsg: any; usage: any; model: string; finishReason: string }> {
  let content = "";
  let reasoningContent = "";
  const toolCalls = new Map<number, {
    id: string;
    name: string;
    arguments: string;
    thoughtSignature?: string;
  }>();
  let usage: any;
  let model = "";
  let finishReason = "";
  // 无 index 的 tool_call（非标准流或 mock）按出现顺序分配
  let toolCallCursor = 0;

  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    // usage 与 x_usage_source 同帧下发（网关收尾帧），一起留住以便判定口径
    if (chunk.usage) usage = chunk.usage;
    if (chunk.x_usage_source) usage = { ...(usage ?? {}), x_usage_source: chunk.x_usage_source };

    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};

    if (delta.content) {
      content += delta.content;
      emit({ type: "text_delta", delta: delta.content });
    }
    if (delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
      emit({ type: "reasoning_delta", delta: delta.reasoning_content });
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? toolCallCursor++;
        let slot = toolCalls.get(index);
        if (!slot) {
          slot = { id: "", name: "", arguments: "" };
          toolCalls.set(index, slot);
        }
        if (tc.id) slot.id = tc.id;
        const thoughtSignature = tc.thought_signature ?? tc.thoughtSignature;
        if (thoughtSignature) slot.thoughtSignature = thoughtSignature;
        if (tc.function?.name) {
          slot.name = tc.function.name;
          emit({ type: "toolcall_start", index, id: slot.id, name: slot.name });
        }
        if (tc.function?.arguments) {
          slot.arguments += tc.function.arguments;
          emit({ type: "toolcall_args_delta", index, delta: tc.function.arguments });
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  for (const [index, slot] of toolCalls) {
    emit({ type: "toolcall_end", index, id: slot.id, name: slot.name, argsJson: slot.arguments });
  }

  const assistantMsg: any = { role: "assistant", content: content || null };
  if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
  if (toolCalls.size > 0) {
    assistantMsg.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => ({
        id: slot.id || `call_${crypto.randomUUID().slice(0, 8)}`,
        type: "function",
        function: { name: slot.name, arguments: slot.arguments },
        ...(slot.thoughtSignature ? { thought_signature: slot.thoughtSignature } : {}),
      }));
  }
  return { assistantMsg, usage, model, finishReason };
}

interface UsageInput {
  model: string;
  /** provider 原始 usage（可能带网关附带的 x_usage_source）。 */
  usage: any;
  durationMs: number;
  apiHost?: string;
  sessionId?: string;
  /** 本次回复的正文与思考文本：上游不区分输入/输出时用它们估算生成量。 */
  outputText?: string;
  reasoningText?: string;
  /** 本次请求输入的本地估算：上游不给输入侧 token 时供展示兜底。 */
  estimatedPromptTokens?: number;
}

/**
 * 把 provider usage 转换为统一的 UsageInfo（与 logResponseUsage 的取值口径一致）。
 * 对只给「会话累计」的上游（llm-deepseek-web）先差分出本请求新增，避免下游逐轮累加出天文数字；
 * 这类上游的差值含新增输入，生成速率另用正文/思考的本地估算（outputTokens）。
 */
function toUsageInfo(input: UsageInput): UsageInfo {
  const { model, usage, durationMs, apiHost, sessionId } = input;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const accumulated = isAccumulatedUsage(usage);
  const completionTokens = accumulated
    ? deltaOfAccumulatedUsage(sessionId, usage?.completion_tokens ?? 0)
    : (usage?.completion_tokens ?? 0);
  const totalTokens = accumulated ? completionTokens : (usage?.total_tokens ?? promptTokens + completionTokens);
  return {
    model,
    // 记录落盘时的端点 host：回放历史按当时端点判定官方计费，不受日后更换 endpoint 影响
    ...(apiHost ? { apiHost } : {}),
    promptTokens,
    cacheHitTokens,
    cacheMissTokens: usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHitTokens, 0),
    completionTokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens,
    durationMs,
    ...(accumulated
      ? {
        outputTokens: estimateTextTokens(input.outputText ?? "") + estimateTextTokens(input.reasoningText ?? ""),
      }
      : {}),
    ...(input.estimatedPromptTokens ? { estimatedPromptTokens: input.estimatedPromptTokens } : {}),
  };
}

function buildUsageStats(
  model: string,
  requestBody: Record<string, any>,
  response: any,
  requestStartedAt: number,
  requestKind: LLMRequestKind,
  sessionId?: string,
  contextEpochId?: string,
  /** 归一化后的用量：累计型上游已差分，日志与 UI/计费保持同一口径。 */
  normalized?: UsageInfo,
): LLMUsageLogEntry {
  const usage = response.usage;
  const promptTokens = normalized?.promptTokens ?? usage?.prompt_tokens ?? 0;
  const cacheHitTokens = normalized?.cacheHitTokens ?? usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMissTokens = normalized?.cacheMissTokens ?? usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHitTokens, 0);
  const completionTokens = normalized?.completionTokens ?? usage?.completion_tokens ?? 0;
  const reasoningTokens = normalized?.reasoningTokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const totalTokens = normalized?.totalTokens ?? usage?.total_tokens ?? promptTokens + completionTokens;
  const responseContent = response.choices?.[0]?.message?.content ?? '';
  const outputText = typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent);

  // 前缀 hash：分别对 system prompt 和工具 schema 取 hash，用于诊断缓存命中变化
  const systemContent = requestBody.messages?.[0]?.role === 'system'
    ? requestBody.messages[0].content
    : requestBody.input?.find((item: any) => item?.role === 'system')?.content ?? '';
  const systemHash = createHash('sha256').update(systemContent).digest('hex').slice(0, 16);
  const toolsHash = createHash('sha256').update(JSON.stringify(requestBody.tools ?? [])).digest('hex').slice(0, 16);
  const inputPayload = requestBody.messages ?? requestBody.input ?? [];

  const entry: LLMUsageLogEntry = {
    timestamp: new Date().toISOString(),
    caller: 'xbot',
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(contextEpochId ? { context_epoch_id: contextEpochId } : {}),
    request_kind: requestKind,
    model: response.model || model,
    prompt_tokens: promptTokens,
    cache_hit_tokens: cacheHitTokens,
    cache_miss_tokens: cacheMissTokens,
    completion_tokens: completionTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    input_chars: Array.from(JSON.stringify(inputPayload)).length,
    output_chars: Array.from(outputText).length,
    duration_ms: Date.now() - requestStartedAt,
    token_usage_source: usage ? 'provider' : 'unavailable',
    token_usage_semantics: isAccumulatedUsage(usage) ? 'accumulated_delta' : 'provider',
    system_hash: systemHash,
    tools_hash: toolsHash,
  };
  console.log(
    `[LLM] caller=${entry.caller}${entry.session_id ? ` session_id=${entry.session_id}` : ""}${entry.context_epoch_id ? ` context_epoch_id=${entry.context_epoch_id}` : ""}`
    + ` model=${entry.model} prompt_tokens=${entry.prompt_tokens}`
    + ` cache_hit_tokens=${entry.cache_hit_tokens} cache_miss_tokens=${entry.cache_miss_tokens}`
    + ` completion_tokens=${entry.completion_tokens} reasoning_tokens=${entry.reasoning_tokens} total_tokens=${entry.total_tokens}`
    + ` duration_ms=${entry.duration_ms} token_usage_source=${entry.token_usage_source}`,
  );
  return entry;
}
