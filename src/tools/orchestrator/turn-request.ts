/**
 * 单轮请求：准备消息与工具 → 组装请求体 → 发起调用 → 归一化响应。
 *
 * 抽出来的目的是让「协议差异」与「图片物化」不再纠缠在循环体内，
 * 循环只剩：准备一轮 → 决策 → 执行工具。
 */

import { DEEPSEEK_OFFICIAL_HOST, endpointHost } from "../../pricing/deepseek.js";
import type { ChatMessage } from "../../types/session.js";
import { projectChatMessagesForPrompt } from "../../utils/tool-result-context.js";
import {
  materializeDeepSeekImageMessages,
  materializeImageMessages,
} from "../../utils/image-assets.js";
import type { UIEvent } from "../../events/ui-events.js";
/** 只声明本模块用到的最小客户端形状，避免与主模块形成循环依赖。 */
export interface RequestClient {
    baseURL: string;
    protocol?: "responses" | "chat_completions";
    createResponse?: unknown;
    uploadFile?: (imagePath: string) => Promise<{ id: string }>;
    uploadFileData?: (data: string, filename: string, mimeType: string) => Promise<{ id: string }>;
}

type ChatClient = RequestClient;
import {
  buildRequestBody,
  resolveEffort,
  resolveProtocol,
  sortToolsByName,
  appendHostedTools,
  toResponsesToolDefinitions,
  toHostedToolDefinitions,
} from "./request-builder.js";
import {
  expandToolImageMessages,
  materializeResponsesInput,
  stripResponsesMetadata,
} from "./messages.js";

/** 把工具结果中的图片上传成 DeepSeek Files，返回 file id。 */
async function uploadImageForDeepSeek(client: ChatClient, image: any): Promise<string> {
    const uploaded = "path" in image
        ? await (client.uploadFile
            ? client.uploadFile(image.path)
            : Promise.reject(new Error("当前 DeepSeek 客户端不支持 Files API")))
        : await (client.uploadFileData
            ? client.uploadFileData(image.data, image.filename, image.mimeType)
            : Promise.reject(new Error("当前 DeepSeek 客户端不支持内存图片上传")));
    return uploaded.id;
}

/**
 * DeepSeek 兼容：部分兼容端点要求接入 DeepSeek 模型。另外价格表依赖官方 host 判定。
 */
export function isDeepSeekEndpoint(model: string, baseURL: string): boolean {
    return model.toLowerCase().includes("deepseek") || endpointHost(baseURL) === DEEPSEEK_OFFICIAL_HOST;
}

export interface PrepareRequestOptions {
    client: ChatClient;
    model: string;
    /** 当前完整消息列表（含本轮已产生消息）。 */
    messages: ChatMessage[];
    /** 基础工具定义（未排序）。 */
    tools: any[];
    getToolDefinitions?: () => any[];
    /** 托管工具类型（上游执行，本地不执行）：调用方解析 OPENAI_HOSTED_TOOLS 后传入。 */
    hostedTools?: string[];
    getContextReminders?: () => string[] | undefined;
    normalizedTools: (tools: any[]) => any[];
    toolChoice?: "auto" | "none";
    isFirstIteration: boolean;
    stream: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
}

export interface PreparedRequest {
    protocol: "responses" | "chat_completions";
    requestBody: Record<string, any>;
    isMiniMax: boolean;
}

/** 把一轮请求的输入全部算好；纯装配，不发请求。 */
export async function prepareRequest(options: PrepareRequestOptions): Promise<PreparedRequest> {
    const { client, model } = options;
    const protocol = resolveProtocol(client);
    const useResponses = protocol === "responses";

    // 全量工具始终按名称排序，确保不同请求使用稳定的工具前缀。
    const currentTools = sortToolsByName(options.getToolDefinitions ? options.getToolDefinitions() : options.tools);

    // 提醒消息只追加在请求尾部：不进历史、不落盘，前缀不变仍可命中缓存
    const promptMessages = projectChatMessagesForPrompt(options.messages);
    const reminders = options.isFirstIteration ? [] : options.getContextReminders?.() ?? [];
    const sourceMessages: ChatMessage[] = reminders.length > 0
        ? [...promptMessages, ...reminders.map((content) => ({ role: "user" as const, content }))]
        : promptMessages;

    const requestMessages = useResponses
        ? sourceMessages
        : expandToolImageMessages(stripResponsesMetadata(sourceMessages));

    const materializedMessages = useResponses
        ? await materializeResponsesInput(requestMessages)
        : isDeepSeekEndpoint(model, client.baseURL)
            ? await materializeDeepSeekImageMessages(requestMessages, image => uploadImageForDeepSeek(client, image))
            : await materializeImageMessages(requestMessages);

    const normalizedTools = options.normalizedTools(currentTools);
    const enableDeferredLoading = useResponses
        && (options.hostedTools?.includes("tool_search") ?? false)
        && normalizedTools.some(tool => tool.deferLoading === true);
    // 托管工具只在 Responses 协议声明：Chat Completions 只接受 function 类型，
    // 严格的上游会直接以 422 unknown variant 拒绝 web_search 等类型。
    // tool_search 依赖至少一个延迟加载的 Responses function 工具。
    const hostedTools = useResponses
        ? toHostedToolDefinitions(options.hostedTools ?? [])
            .filter(tool => tool.type !== "tool_search" || enableDeferredLoading)
        : [];
    const requestTools = useResponses
        ? appendHostedTools(toResponsesToolDefinitions(normalizedTools, enableDeferredLoading), hostedTools)
        : normalizedTools.map(({ deferLoading: _deferLoading, ...tool }) => tool);

    const isMiniMax = model.startsWith("MiniMax-");
    const requestBody = buildRequestBody({
        protocol,
        model,
        baseURL: client.baseURL,
        messages: materializedMessages,
        tools: requestTools,
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        stream: options.stream,
        isMiniMax,
        reasoning: {
            protocol,
            model,
            baseURL: client.baseURL,
            effort: resolveEffort(options.reasoningEffort),
            ...(options.reasoningEfforts ? { configuredEfforts: options.reasoningEfforts } : {}),
        },
    });

    return { protocol, requestBody, isMiniMax };
}
