import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { skillRegistry } from "../skills/skill-registry.js";
import { loadCoreMemoryContext, loadDailyMemoryContext, loadIdentityContext } from "../skills/base-skill.js";
import { DEFAULT_MEMORY_USER_ID, normalizeMemoryUserId } from "../utils/runtime-paths.js";
import { executeWithChat, createChatClient, isAbortError } from "../tools/chat-orchestrator.js";
import { executeMcpTool, getOpenAIToolDefinitions } from "../tools/tool-registry.js";
import { createTodoReminderProvider } from "../tools/todo-tool.js";
import { runWithToolCwd } from "../utils/tool-cwd-context.js";
import {
    describeDroppedMedia,
    toolContentToAudioContent,
    toolContentToImageContent,
    toolResultToText,
} from "../tools/tool-interface.js";
import { supportsAudioInput } from "../tools/orchestrator/turn-request.js";
import { resolveProtocol } from "../tools/orchestrator/request-builder.js";
import type { ChatMessage, Session } from "../types/session.js";
import type { StreamDelta } from "../types/chat.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import type { ToolCall } from "../types/tool-call.js";
import { getSessionContextHistory } from "../utils/conversation-history.js";
import type { LLMRequestKind } from "../utils/logger.js";
import type { UIEvent } from "../events/ui-events.js";
import { getSessionToolNames } from "../tools/session-tools.js";
import { getAskUserToolNames } from "../tools/ask-user-tool.js";
import { isDeepSeekCostStatEnabled } from "../pricing/deepseek.js";
import type { ChatApiProtocol, ChatModelSelection } from "../types/chat-model.js";
import { getTuiModelPreferencesFile } from "../utils/tui-state-paths.js";
import { withFileLock } from "../utils/file-lock.js";

export interface ChatApiSettings {
    apiKey: string;
    apiBase: string;
    model: string;
    protocol?: ChatApiProtocol;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
    /** 托管工具类型（OPENAI_RESPONSES_HOSTED_TOOLS）：由上游执行，本地不执行。 */
    hostedTools: string[];
    /** ENABLE_DS_COST_STAT：开启后非官方端点（局域网网关）也按官方价格表估算费用。 */
    enableCostStat: boolean;
}

export type ChatModelOption = ChatModelSelection;

let defaultModelOption: ChatModelOption | null | undefined;

export function getDefaultChatModelOption(): ChatModelOption | undefined {
    if (defaultModelOption !== undefined) return defaultModelOption ?? undefined;
    try {
        const value = JSON.parse(fs.readFileSync(getTuiModelPreferencesFile(), "utf8")) as Partial<ChatModelOption>;
        if (
            (value.protocol === "responses" || value.protocol === "chat_completions")
            && typeof value.model === "string"
            && value.model.trim()
        ) {
            defaultModelOption = {
                protocol: value.protocol,
                model: value.model.trim(),
                ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}),
            };
            return defaultModelOption;
        }
    } catch {
        // 缺失或损坏的偏好文件使用环境变量默认值。
    }
    defaultModelOption = null;
    return undefined;
}

export async function setDefaultChatModelOption(option: ChatModelOption): Promise<void> {
    if (!getChatModelOptions().some(candidate =>
        candidate.protocol === option.protocol && candidate.model === option.model,
    )) {
        throw new Error(`模型配置不存在：${option.protocol} · ${option.model}`);
    }

    const file = getTuiModelPreferencesFile();
    await withFileLock(file, () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporaryFile = `${file}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify(option, null, 2), "utf8");
        fs.renameSync(temporaryFile, file);
    });
    defaultModelOption = { ...option };
}

function isPrivateIPv4(hostname: string): boolean {
    if (isIP(hostname) !== 4) return false;

    const [first, second] = hostname.split(".").map(Number);
    return first === 10
        || first === 127
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
}

function isLocalApiHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
        normalized === "localhost"
        || normalized.endsWith(".localhost")
        || normalized.endsWith(".local")
        || normalized.endsWith(".lan")
        || normalized.endsWith(".internal")
    ) {
        return true;
    }

    if (isPrivateIPv4(normalized)) return true;
    if (isIP(normalized) === 0) return !normalized.includes(".");
    if (isIP(normalized) !== 6) return false;

    return normalized === "::1"
        || /^f[cd]/.test(normalized)
        || /^fe[89ab]/.test(normalized)
        || (normalized.startsWith("::ffff:") && isPrivateIPv4(normalized.slice("::ffff:".length)));
}

export function validateChatApiSettings(settings: ChatApiSettings): string | undefined {
    const baseName = settings.protocol === "responses"
        ? "OPENAI_RESPONSES_BASE_URL"
        : settings.protocol === "chat_completions"
            ? "OPENAI_CHAT_BASE_URL"
            : "OPENAI_BASE_URL";

    let apiUrl: URL;
    try {
        apiUrl = new URL(settings.apiBase);
    } catch {
        return `${baseName} 不是有效 URL：${settings.apiBase}`;
    }

    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
        return `${baseName} 只支持 http 或 https：${settings.apiBase}`;
    }

    if (!settings.apiKey.trim() && !isLocalApiHostname(apiUrl.hostname)) {
        const keyName = settings.protocol === "responses"
            ? "OPENAI_RESPONSES_API_KEY"
            : "OPENAI_CHAT_API_KEY";
        return `缺少 ${keyName} 或 OPENAI_API_KEY（本地或局域网服务可省略）`;
    }

    return undefined;
}

export function formatChatProviderError(error: unknown, currentSettings = getChatApiSettings()): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("回合消息落盘失败") || message.startsWith("流式消息落盘失败")) return message;
    const explicitStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const messageStatus = Number(message.match(/(?:^|\s)(\d{3})(?=\s|:|$)/)?.[1]);
    const status = Number.isFinite(explicitStatus) ? explicitStatus : messageStatus;

    if (status === 401 || status === 403) {
        const keyName = currentSettings.protocol === "responses"
            ? "OPENAI_RESPONSES_API_KEY"
            : "OPENAI_CHAT_API_KEY";
        return `LLM provider 请求失败（HTTP ${status}）：认证失败，请检查 ${keyName} 或 OPENAI_API_KEY。`;
    }

    if (status === 429) {
        return `LLM provider 请求失败（HTTP 429）：provider 已限流或额度已用尽。${message}`;
    }

    if (status !== undefined && status >= 400) {
        return `LLM provider 请求失败（HTTP ${status}）：${message}`;
    }

    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
        const baseName = currentSettings.protocol === "responses"
            ? "OPENAI_RESPONSES_BASE_URL"
            : "OPENAI_CHAT_BASE_URL";
        return `LLM provider 请求失败：无法连接 ${currentSettings.apiBase}，请检查 ${baseName} 或 OPENAI_BASE_URL 和网络代理。`;
    }

    return `LLM provider 请求失败：${message}`;
}

export interface BuildSystemPromptOptions {
    userId: number;
    activeSkillName?: string;
    includeMemory?: boolean;
    includeDailyMemory?: boolean;
    /** 会话绑定工作目录：identity 中 {{TUI_CWD}} 插值用它，缺省回退进程级 TUI_CWD。 */
    cwd?: string;
}

export interface ChatRunOptions {
    query: string;
    queryContent?: UserContent;
    systemPrompt: string;
    history?: any[];
    /** 会话绑定的工作目录：工具调用在该目录下执行（缺省时回退进程级 TUI_CWD）。 */
    cwd?: string;
    /**
     * 实时解析工具执行目录：命中时优先于 cwd。
     * 会话 cwd 可能在回合中间被 cwd 工具改写，后续工具应立即用新目录。
     */
    resolveCwd?: () => string | undefined;
    userId: number;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    modelOverride?: string;
    contextEpochId?: string;
    initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
    signal?: AbortSignal;
    stream?: boolean;
    /** 禁止本次请求继续调用工具，仅根据已有历史生成文本。 */
    disableToolCalls?: boolean;
    consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
    onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void | Promise<void>;
    onToolCall?: (name: string, args: any, mode: "serial" | "parallel") => void;
    onToolResult?: (name: string, result: string) => void;
    onAssistantToolCallContent?: (content: string) => Promise<void> | void;
    onInvalidAssistantHistory?: () => void;
    onProgress?: (text: string) => void;
    onEvent?: (event: UIEvent) => void | Promise<void>;
    autoCompactActiveTurn?: boolean;
    /** 续跑仅在 provider 明确报输入超窗时压缩，不做请求前预压缩。 */
    compactOnProviderOverflow?: boolean;
    /** 回合内每条完整消息定稿时的落盘回调（turn_message 事件源）。 */
    onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
    onStreamDelta?: (delta: StreamDelta, requestIndex: number) => Promise<void>;
    /** 续跑：不把 query 插入为 user 消息，保持上游请求与中断前一致。 */
    skipUserQuery?: boolean;
    /** 续跑：进入循环前先补跑这些工具调用（中断时缺结果的调用）。 */
    pendingToolCalls?: ToolCall[];
}

export function getChatApiSettings(sessionSelection?: ChatModelSelection): ChatApiSettings {
    const legacyModel = process.env.OPENAI_MODEL || "";
    const responsesModel = process.env.OPENAI_RESPONSES_MODEL || "";
    const chatModel = process.env.OPENAI_CHAT_MODEL || "";
    const hasResponsesSettings = [
        process.env.OPENAI_RESPONSES_API_KEY,
        process.env.OPENAI_RESPONSES_BASE_URL,
        responsesModel,
        process.env.OPENAI_RESPONSES_MODELS,
    ].some(value => value?.trim());
    const hasChatSettings = [
        process.env.OPENAI_CHAT_API_KEY,
        process.env.OPENAI_CHAT_BASE_URL,
        chatModel,
        process.env.OPENAI_CHAT_MODELS,
    ].some(value => value?.trim());
    let protocol: ChatApiProtocol;
    if (hasResponsesSettings && !hasChatSettings) {
        protocol = "responses";
    } else if (hasChatSettings && !hasResponsesSettings) {
        protocol = "chat_completions";
    } else {
        protocol = "chat_completions";
    }
    const profileModel = protocol === "responses"
        ? responsesModel || parseCommaList(process.env.OPENAI_RESPONSES_MODELS)[0] || ""
        : chatModel || parseCommaList(process.env.OPENAI_CHAT_MODELS)[0] || "";
    const requestedOption = sessionSelection ?? getDefaultChatModelOption();
    const activeOption = requestedOption && getChatModelOptions().some(option =>
        option.protocol === requestedOption.protocol && option.model === requestedOption.model,
    ) ? requestedOption : undefined;
    const activeProtocol = activeOption?.protocol ?? protocol;
    const activeProfileApiKey = activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_API_KEY
        : process.env.OPENAI_CHAT_API_KEY;
    const activeProfileApiBase = activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_BASE_URL
        : process.env.OPENAI_CHAT_BASE_URL;
    const configuredEfforts = parseCommaList(activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_EFFORTS
        : process.env.OPENAI_CHAT_EFFORTS);

    return {
        apiKey: activeProfileApiKey || process.env.OPENAI_API_KEY || "",
        apiBase: activeProfileApiBase || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model: activeOption?.model || profileModel || legacyModel,
        protocol: activeProtocol,
        reasoningEffort: activeOption?.reasoningEffort,
        reasoningEfforts: configuredEfforts.length > 0 ? configuredEfforts : undefined,
        hostedTools: parseCommaList(process.env.OPENAI_RESPONSES_HOSTED_TOOLS),
        enableCostStat: isDeepSeekCostStatEnabled(),
    };
}

/** 逗号分隔配置值 → 去重后的列表（模型名、托管工具类型共用）。 */
function parseCommaList(value?: string): string[] {
    return [...new Set((value || "").split(",").map(item => item.trim()).filter(Boolean))];
}

function profileHasSettings(protocol: ChatApiProtocol): boolean {
    const prefix = protocol === "responses" ? "OPENAI_RESPONSES" : "OPENAI_CHAT";
    return [
        process.env[`${prefix}_API_KEY`],
        process.env[`${prefix}_BASE_URL`],
        process.env[`${prefix}_MODEL`],
        process.env[`${prefix}_MODELS`],
    ].some(value => value?.trim());
}

export function getChatModelOptions(): ChatModelOption[] {
    const legacyModel = process.env.OPENAI_MODEL?.trim() || "";
    const configuredProtocols = (['responses', 'chat_completions'] as const)
        .filter(protocol => profileHasSettings(protocol));
    const legacyProtocol: ChatApiProtocol = "chat_completions";
    const protocols = new Set<ChatApiProtocol>(configuredProtocols);
    if (legacyModel && !configuredProtocols.includes(legacyProtocol)) protocols.add(legacyProtocol);

    const options: ChatModelOption[] = [];
    for (const protocol of protocols) {
        const prefix = protocol === "responses" ? "OPENAI_RESPONSES" : "OPENAI_CHAT";
        const models = [
            process.env[`${prefix}_MODEL`],
            ...parseCommaList(process.env[`${prefix}_MODELS`]),
            ...(protocol === legacyProtocol ? [legacyModel] : []),
        ].map(model => model?.trim()).filter((model): model is string => Boolean(model));
        for (const model of new Set(models)) options.push({ protocol, model });
    }

    return options;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = { userId: DEFAULT_MEMORY_USER_ID }): string {
    const sections: string[] = [];
    const memoryUserId = normalizeMemoryUserId(options.userId);
    const identity = loadIdentityContext(options.cwd ? { TUI_CWD: options.cwd } : undefined).trim();
    if (identity) {
        sections.push(identity);
    }

    const skillListing = skillRegistry.buildSkillListing();
    sections.push(skillListing);

    if (options.includeMemory !== false) {
        const coreMemory = loadCoreMemoryContext(memoryUserId).trim();
        if (coreMemory) {
            sections.push(coreMemory);
        }

        if (options.includeDailyMemory !== false) {
            const dailyMemory = loadDailyMemoryContext(memoryUserId).trim();
            if (dailyMemory) {
                sections.push(dailyMemory);
            }
        }
    }

    if (options.activeSkillName) {
        const activeSkill = skillRegistry.getSkill(options.activeSkillName);
        if (activeSkill) {
            sections.push(`## 当前激活技能：${options.activeSkillName}\n${activeSkill.getSystemPrompt()}`);
        }
    }

    return sections.join("\n\n");
}

/**
 * 逐次构建会话的 system prompt：不缓存、不落盘。
 * 技能清单、记忆文件、身份文件的改动下一次请求即生效，重启也不会带回旧文本。
 */
export function resolveSessionSystemPrompt(
    session: Pick<Session, 'cwd' | 'activeSkill'>,
    options: { includeMemory?: boolean; userId: number } = { userId: DEFAULT_MEMORY_USER_ID },
): string {
    return buildSystemPrompt({
        activeSkillName: session.activeSkill,
        includeMemory: options.includeMemory,
        userId: options.userId,
        cwd: session.cwd,
    });
}

export function buildConversationHistory(
    session: Pick<Session, "turns" | "compactedContext" | "compactedThroughTurnId"> & Partial<Pick<Session, "compactedKeepFromMessageId" | "contextEpochId">>,
    pendingMessages: Array<string | UserMessageInput>,
    options: { skipToolCallIds?: ReadonlySet<string> } = {},
): any[] {
    const extraMessages = pendingMessages.slice(0, -1);
    const history = getSessionContextHistory(session, options);
    history.push(...extraMessages.map(input => ({
        role: "user" as const,
        content: toUserContent(typeof input === "string" ? { text: input } : input),
    })));
    return history;
}

export async function runChatQuery(options: ChatRunOptions) {
    const settings = getChatApiSettings(options.modelSelection);
    if (options.modelOverride?.trim()) settings.model = options.modelOverride.trim();
    const settingsError = validateChatApiSettings(settings);
    if (settingsError) {
        throw new Error(`LLM provider 配置无效：${settingsError}`);
    }

    const client = createChatClient(settings.apiKey, settings.apiBase, settings.protocol);
    let activeTurnCompactionFailed = false;

    try {
        return await executeWithChat({
            query: options.query,
            queryContent: options.queryContent,
            client,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
            reasoningEfforts: settings.reasoningEfforts,
            ...(settings.hostedTools.length > 0 ? { hostedTools: settings.hostedTools } : {}),
            executeTool: async (name: string, args: any) => {
                if (options.signal?.aborted) {
                    throw new DOMException("User terminated the request", "AbortError");
                }

                const finalArgs = { ...(args || {}) };
                finalArgs.__userId = options.userId;
                if (options.sessionId !== undefined) finalArgs.__sessionId = options.sessionId;
                const execute = () => executeMcpTool(name, finalArgs, options.signal);
                const toolCwd = options.resolveCwd?.() ?? options.cwd;
                const result = toolCwd
                    ? await runWithToolCwd(toolCwd, execute)
                    : await execute();
                const content = toolResultToText(result);
                const audioContent = toolContentToAudioContent(result.content);
                // provider 能力判定留在这一层，说明函数只消费结果；
                // 用 resolveProtocol / client.baseURL 与实际生效路径（prepareRequest）保持同源
                const audioDropReason = resolveProtocol(client) === "responses"
                    ? "responses"
                    : supportsAudioInput(settings.model, client.baseURL) ? undefined : "endpoint";
                const mediaNotice = describeDroppedMedia(result.content, { audioDropReason });
                return {
                    content: mediaNotice ? `${content}${mediaNotice}` : content,
                    imageContent: await toolContentToImageContent(result.content, options.sessionId),
                    audioContent,
                    contextPolicy: result.contextPolicy,
                };
            },
            getSystemPrompt: () => options.systemPrompt,
            // 会话级工具按会话注入：会话间通信要控制通道、提问要有人能回答（见各自 getXxxToolNames）
            getToolDefinitions: () => getOpenAIToolDefinitions([
                ...getSessionToolNames(options.sessionId),
                ...getAskUserToolNames(options.sessionId),
            ]),
            ...(options.disableToolCalls ? { toolChoice: "none" as const } : {}),
            history: options.history ?? [],
            sessionId: options.sessionId,
            contextEpochId: options.contextEpochId,
            initialRequestKind: options.initialRequestKind,
            stream: options.stream,
            consumePendingMessages: options.consumePendingMessages,
            onConsumePending: options.onConsumePending,
            compactMessagesIfNeeded: options.autoCompactActiveTurn || options.compactOnProviderOverflow
                ? async (messages, lastPromptTokens, providerMaxTokens) => {
                    if (!options.autoCompactActiveTurn && providerMaxTokens === undefined) return undefined;
                    if (activeTurnCompactionFailed) return undefined;
                    const { compactActiveTurnMessagesIfNeeded } = await import("./auto-compact.js");
                    return compactActiveTurnMessagesIfNeeded(messages, {
                        model: settings.model,
                        systemPrompt: options.systemPrompt,
                        userId: options.userId,
                        signal: options.signal,
                        sessionId: options.sessionId,
                        modelSelection: options.modelSelection,
                        contextEpochId: options.contextEpochId,
                        lastPromptTokens,
                        providerMaxTokens,
                        onUsage: usage => options.onEvent?.({ type: "usage", usage }),
                        onProgress: message => {
                            options.onProgress?.(message);
                            options.onEvent?.({ type: "progress", message });
                        },
                        onFailure: () => { activeTurnCompactionFailed = true; },
                    });
                }
                : undefined,
            getContextReminders: options.sessionId ? createTodoReminderProvider(options.sessionId) : undefined,
            onToolCall: options.onToolCall,
            onToolResult: options.onToolResult,
            onAssistantToolCallContent: options.onAssistantToolCallContent,
            onInvalidAssistantHistory: options.onInvalidAssistantHistory,
            onProgress: options.onProgress,
            onTurnMessage: options.onTurnMessage,
            onStreamDelta: options.onStreamDelta,
            skipUserQuery: options.skipUserQuery,
            pendingToolCalls: options.pendingToolCalls,
            onEvent: event => {
                if (event.type === "error") {
                    options.onEvent?.({ ...event, message: formatChatProviderError(event.message, settings) });
                    return;
                }
                options.onEvent?.(event);
            },
            signal: options.signal,
        });
    } catch (error: any) {
        if (isAbortError(error)) {
            throw error;
        }
        const wrappedError: any = new Error(formatChatProviderError(error, settings), { cause: error });
        if (error?.partialMessages) {
            wrappedError.partialMessages = error.partialMessages;
        }
        throw wrappedError;
    }
}
