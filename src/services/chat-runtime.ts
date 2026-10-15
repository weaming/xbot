import { isIP } from "node:net";
import { skillRegistry } from "../skills/skill-registry.js";
import { loadCoreMemoryContext, loadDailyMemoryContext, loadWorkspaceIdentity } from "../skills/base-skill.js";
import { DEFAULT_MEMORY_USER_ID, normalizeMemoryUserId } from "../utils/runtime-paths.js";
import { executeWithChat, createChatClient, isAbortError } from "../tools/chat-orchestrator.js";
import { executeMcpTool, getAllToolSummary, getOpenAIToolDefinitions } from "../tools/tool-registry.js";
import { createTodoReminderProvider } from "../tools/todo-tool.js";
import { runWithToolCwd } from "../utils/tool-cwd-context.js";
import { toolContentToImageContent, toolResultToText } from "../tools/tool-interface.js";
import type { ChatMessage, Session } from "../types/session.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import type { ToolCall } from "../types/tool-call.js";
import { getSessionContextHistory } from "../utils/conversation-history.js";
import type { LLMRequestKind } from "../utils/logger.js";
import type { UIEvent } from "../events/ui-events.js";
import { getSessionToolNames } from "../tools/session-tools.js";
import { getAskUserToolNames } from "../tools/ask-user-tool.js";
import { isDeepSeekCostStatEnabled } from "../pricing/deepseek.js";

export interface ChatApiSettings {
    apiKey: string;
    apiBase: string;
    model: string;
    /** ENABLE_DS_COST_STAT：开启后非官方端点（局域网网关）也按官方价格表估算费用。 */
    enableCostStat: boolean;
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
    let apiUrl: URL;
    try {
        apiUrl = new URL(settings.apiBase);
    } catch {
        return `OPENAI_BASE_URL 不是有效 URL：${settings.apiBase}`;
    }

    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
        return `OPENAI_BASE_URL 只支持 http 或 https：${settings.apiBase}`;
    }

    if (!settings.apiKey.trim() && !isLocalApiHostname(apiUrl.hostname)) {
        return "缺少 OPENAI_API_KEY（本地或局域网服务可省略）";
    }

    return undefined;
}

export function formatChatProviderError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const explicitStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const messageStatus = Number(message.match(/(?:^|\s)(\d{3})(?=\s|:|$)/)?.[1]);
    const status = Number.isFinite(explicitStatus) ? explicitStatus : messageStatus;

    if (status === 401 || status === 403) {
        return `LLM provider 请求失败（HTTP ${status}）：认证失败，请检查 OPENAI_API_KEY。`;
    }

    if (status === 429) {
        return `LLM provider 请求失败（HTTP 429）：provider 已限流或额度已用尽。${message}`;
    }

    if (status !== undefined && status >= 400) {
        return `LLM provider 请求失败（HTTP ${status}）：${message}`;
    }

    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
        return `LLM provider 请求失败：无法连接 ${getChatApiSettings().apiBase}，请检查 OPENAI_BASE_URL 和网络代理。`;
    }

    return `LLM provider 请求失败：${message}`;
}

export interface BuildSystemPromptOptions {
    userId: number;
    activeSkillName?: string;
    sentSkillsMtime?: Record<string, number>;
    extraToolsPreface?: string;
    includeMemory?: boolean;
    includeDailyMemory?: boolean;
    /** 会话绑定工作目录：identity 中 {{TUI_CWD}} 插值用它，缺省回退进程级 TUI_CWD。
     *  system prompt 按会话缓存，PWD 必须与该会话绑定目录一致。 */
    cwd?: string;
}

/** 工具调用规则：搜索到的工具会加入后续请求的 tools 参数。 */
function buildToolCallingRuleSection(): string {
    return [
        "## 工具调用规则",
        "只能调用当前 tools 参数中实际存在的工具，不得臆想或假设工具存在；认为某个工具可用前，先确认它的名字在 tools 列表中。",
        "可直接调用当前 tools 参数中声明的工具。",
        "如果所需工具不在当前 tools 参数中，先调用 search_tools 搜索它，搜索到的工具会加入可用列表，之后直接调用。",
        "也可以改用列表中的等价工具（如新闻用 mcphub__brave_web_search）。",
        "不要因为工具不在列表而停止回复，即使没有可用工具也要正常回复用户。",
        "todo 仅用于复杂、持续时间较长或需要跨多轮推进的任务；简单任务、步骤少且预计几次工具调用/对话往返即可完成的任务，不要调用 todo。复杂任务开始时用 todo write 建立清单，执行中保持同时只有 1 条 in_progress，并随任务状态变化及时更新；收尾前清零未完成项。",
    ].join("\n");
}

export interface BuildSystemPromptResult {
    systemPrompt: string;
    nextSentSkillsMtime?: Record<string, number>;
    updatedSkillListing: boolean;
}

export interface ChatRunOptions {
    query: string;
    queryContent?: UserContent;
    systemPrompt: string;
    history?: any[];
    /** 会话绑定的工作目录：工具调用在该目录下执行（缺省时回退进程级 TUI_CWD）。 */
    cwd?: string;
    userId: number;
    sessionId?: string;
    contextEpochId?: string;
    initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
    signal?: AbortSignal;
    stream?: boolean;
    /** 禁止本次请求继续调用工具，仅根据已有历史生成文本。 */
    disableTools?: boolean;
    consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
    onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void;
    onToolCall?: (name: string, args: any, mode: "serial" | "parallel") => void;
    onToolResult?: (name: string, result: string) => void;
    onAssistantToolCallContent?: (content: string) => Promise<void> | void;
    onProgress?: (text: string) => void;
    onEvent?: (event: UIEvent) => void | Promise<void>;
    autoCompactActiveTurn?: boolean;
    /** 回合内每条完整消息定稿时的落盘回调（turn_message 事件源）。 */
    onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
    /** 续跑：不把 query 插入为 user 消息，保持上游请求与中断前一致。 */
    skipUserQuery?: boolean;
    /** 续跑：进入循环前先补跑这些工具调用（中断时缺结果的调用）。 */
    pendingToolCalls?: ToolCall[];
}

export function getChatApiSettings(): ChatApiSettings {
    return {
        apiKey: process.env.OPENAI_API_KEY || "",
        apiBase: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL || "",
        enableCostStat: isDeepSeekCostStatEnabled(),
    };
}

/** @public */
export function buildExtraToolsSection(preface?: string): string {
    const allTools = getAllToolSummary();

    const bySource: Record<string, string[]> = {};
    for (const tool of allTools) {
        const source = tool.source || "local";
        if (!bySource[source]) bySource[source] = [];
        bySource[source].push(tool.name);
    }

    const lines = Object.entries(bySource)
        .sort(([leftSource], [rightSource]) => leftSource.localeCompare(rightSource))
        .map(([source, names]) => `- ${source}: ${names.sort((left, right) => left.localeCompare(right)).join(", ")}`)
        .join("\n");

    const parts = ["## 更多可用工具"];
    if (preface) {
        parts.push(preface);
    }
    parts.push(`共有 ${allTools.length} 个可用工具。需要时调用 search_tools 搜索；传入独立的 keywords 列表（例如 ["hello", "world"]，不要写成 ["hello world"]），关键词匹配工具名、来源、标签和描述，任一命中即返回完整工具 schema。${lines ? `\n${lines}` : ""}`);
    return parts.join("\n\n");
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = { userId: DEFAULT_MEMORY_USER_ID }): BuildSystemPromptResult {
    const sections: string[] = [];
    const memoryUserId = normalizeMemoryUserId(options.userId);
    const identity = loadWorkspaceIdentity(options.cwd ? { TUI_CWD: options.cwd } : undefined).trim();
    if (identity) {
        sections.push(identity);
    }

    sections.push(buildExtraToolsSection(options.extraToolsPreface));

    let nextSentSkillsMtime = options.sentSkillsMtime;
    let updatedSkillListing = false;

    const skillListing = skillRegistry.buildSkillListing();
    sections.push(skillListing);
    if (options.sentSkillsMtime) {
        nextSentSkillsMtime = { ...options.sentSkillsMtime };
        for (const meta of skillRegistry.getAllSkillMetas()) {
            nextSentSkillsMtime[meta.name] = meta.mtime;
        }
        updatedSkillListing = true;
    }

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

    // 动态规则放末尾，离对话最近
    sections.push(buildToolCallingRuleSection());

    return {
        systemPrompt: sections.join("\n\n"),
        nextSentSkillsMtime,
        updatedSkillListing,
    };
}

/** 为会话创建并缓存 system prompt，后续请求复用同一份内容。 */
export function getOrCreateSessionSystemPrompt(
    session: Pick<Session, 'cwd' | 'cachedSystemPrompt' | 'cachedSystemPromptIncludesMemory' | 'cachedSystemPromptCwd' | 'cachedSystemPromptUserId' | 'cachedSystemPromptRuntimeFingerprint' | 'activeSkill' | 'sentSkillsMtime'>,
    options: { includeMemory?: boolean; userId: number } = { userId: DEFAULT_MEMORY_USER_ID },
): string {
    const includeMemory = options.includeMemory !== false;
    const memoryUserId = normalizeMemoryUserId(options.userId);
    const hasCompatibleCachedPrompt = includeMemory
        ? session.cachedSystemPromptIncludesMemory !== false
        : session.cachedSystemPromptIncludesMemory === false;
    const cachedMemoryUserId = session.cachedSystemPromptUserId ?? DEFAULT_MEMORY_USER_ID;
    const cachedMemoryScopeMatches = !includeMemory || cachedMemoryUserId === memoryUserId;
    // 缓存里的 PWD 必须与该会话绑定目录一致（旧缓存无记录时重建一次以纠正错位 PWD）
    const cachedCwdMatchesSession = session.cachedSystemPromptCwd === session.cwd;
    const runtimeFingerprint = JSON.stringify({
        skills: skillRegistry.getFingerprint(),
        tools: getAllToolSummary(),
    });
    const cachedRuntimeMatches = session.cachedSystemPromptRuntimeFingerprint === runtimeFingerprint;
    if (session.cachedSystemPrompt && hasCompatibleCachedPrompt && cachedCwdMatchesSession && cachedMemoryScopeMatches && cachedRuntimeMatches) {
        return session.cachedSystemPrompt;
    }

    const promptResult = buildSystemPrompt({
        activeSkillName: session.activeSkill,
        sentSkillsMtime: session.sentSkillsMtime ?? {},
        includeMemory,
        userId: memoryUserId,
        cwd: session.cwd,
    });
    if (promptResult.updatedSkillListing && promptResult.nextSentSkillsMtime) {
        session.sentSkillsMtime = promptResult.nextSentSkillsMtime;
    }

    session.cachedSystemPrompt = promptResult.systemPrompt;
    session.cachedSystemPromptIncludesMemory = includeMemory;
    session.cachedSystemPromptUserId = memoryUserId;
    session.cachedSystemPromptCwd = session.cwd;
    session.cachedSystemPromptRuntimeFingerprint = runtimeFingerprint;
    return session.cachedSystemPrompt;
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
    const settings = getChatApiSettings();
    const settingsError = validateChatApiSettings(settings);
    if (settingsError) {
        throw new Error(`LLM provider 配置无效：${settingsError}`);
    }

    const client = createChatClient(settings.apiKey, settings.apiBase);

    try {
        return await executeWithChat({
            query: options.query,
            queryContent: options.queryContent,
            client,
            model: settings.model,
            executeTool: async (name: string, args: any) => {
                if (options.signal?.aborted) {
                    throw new DOMException("User terminated the request", "AbortError");
                }

                const finalArgs = { ...(args || {}) };
                finalArgs.__userId = options.userId;
                if (options.sessionId !== undefined) finalArgs.__sessionId = options.sessionId;
                const execute = () => executeMcpTool(name, finalArgs, options.signal);
                const result = options.cwd
                    ? await runWithToolCwd(options.cwd, execute)
                    : await execute();
                return {
                    content: toolResultToText(result),
                    imageContent: toolContentToImageContent(result.content),
                    contextPolicy: result.contextPolicy,
                };
            },
            getSystemPrompt: () => options.systemPrompt,
            // 会话级工具按会话注入：会话间通信要控制通道、提问要有人能回答（见各自 getXxxToolNames）
            getToolDefinitions: options.disableTools
                ? () => []
                : () => getOpenAIToolDefinitions(true, [
                    ...getSessionToolNames(options.sessionId),
                    ...getAskUserToolNames(options.sessionId),
                ]),
            history: options.history ?? [],
            sessionId: options.sessionId,
            contextEpochId: options.contextEpochId,
            initialRequestKind: options.initialRequestKind,
            stream: options.stream,
            consumePendingMessages: options.consumePendingMessages,
            onConsumePending: options.onConsumePending,
            compactMessagesIfNeeded: options.autoCompactActiveTurn
                ? async (messages, lastPromptTokens) => {
                    const { compactActiveTurnMessagesIfNeeded } = await import("./auto-compact.js");
                    return compactActiveTurnMessagesIfNeeded(messages, {
                        model: settings.model,
                        systemPrompt: options.systemPrompt,
                        userId: options.userId,
                        signal: options.signal,
                        sessionId: options.sessionId,
                        contextEpochId: options.contextEpochId,
                        lastPromptTokens,
                        onUsage: usage => options.onEvent?.({ type: "usage", usage }),
                        onProgress: options.onProgress,
                    });
                }
                : undefined,
            getContextReminders: options.sessionId ? createTodoReminderProvider(options.sessionId) : undefined,
            onToolCall: options.onToolCall,
            onToolResult: options.onToolResult,
            onAssistantToolCallContent: options.onAssistantToolCallContent,
            onProgress: options.onProgress,
            onTurnMessage: options.onTurnMessage,
            skipUserQuery: options.skipUserQuery,
            pendingToolCalls: options.pendingToolCalls,
            onEvent: event => {
                if (event.type === "error") {
                    options.onEvent?.({ ...event, message: formatChatProviderError(event.message) });
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
        const wrappedError: any = new Error(formatChatProviderError(error), { cause: error });
        if (error?.partialMessages) {
            wrappedError.partialMessages = error.partialMessages;
        }
        throw wrappedError;
    }
}
