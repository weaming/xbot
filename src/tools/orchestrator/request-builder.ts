/**
 * 请求体构造：把「协议 / 消息 / 工具 / 思考强度」映射成上游请求体。
 *
 * 这里只做纯变换，不读环境、不发请求、不写日志：
 * 同样的输入必须产出同样的请求体，否则前缀缓存会因为调用次数而抖动。
 */

import { getReasoningProvider } from "../../utils/reasoning-effort.js";
import { buildReasoningEffortParams } from "../../utils/reasoning-effort.js";
import type { ChatMessage } from "../../types/session.js";

/** 上游协议：由 client.protocol 决定，不由「有没有 createResponse」推断。 */
export type ChatProtocol = "responses" | "chat_completions";

export function resolveProtocol(client: { protocol?: ChatProtocol; createResponse?: unknown }): ChatProtocol {
    if (!client.createResponse) return "chat_completions";
    return client.protocol === "responses" ? "responses" : "chat_completions";
}

/** Chat Completions 的 function 定义 → Responses 的扁平工具定义。 */
export function toResponsesToolDefinitions(tools: any[]): any[] {
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

/** 托管工具类型（上游执行、本地没有对应函数）：名字本身就是 Responses 的工具 type。 */
export function toHostedToolDefinitions(types: string[]): any[] {
    const seen = new Set<string>();
    const definitions: any[] = [];
    for (const raw of types) {
        const type = raw.trim();
        if (!type || seen.has(type)) continue;
        seen.add(type);
        definitions.push({ type });
    }
    return definitions;
}

/**
 * 托管工具追加在 function 定义之后：不参与排序，已发出的前缀不会因新增类型而移动。
 * 同类型已存在则跳过，避免上游收到重复工具。
 */
export function appendHostedTools(base: any[], hosted: any[]): any[] {
    const existing = new Set(base.map(tool => tool?.type).filter(Boolean));
    return [...base, ...hosted.filter(tool => !existing.has(tool.type))];
}

/**
 * 工具定义排序：按名称升序，保证注册顺序不影响请求前缀（前缀稳定才能命中缓存）。
 * 返回新数组，不修改入参。
 */
export function sortToolsByName<T extends { function?: { name?: string } }>(tools: T[]): T[] {
    return [...tools].sort((left, right) =>
        (left.function?.name ?? "").localeCompare(right.function?.name ?? ""));
}

/**
 * 追加后续发现的工具：只在尾部追加，不参与重排。
 * 这样同一会话内前缀不变，每次最多 miss 新增那几个工具的定义。
 */
export function appendDiscoveredTools<T extends { function?: { name?: string } }>(
    base: T[],
    discovered: T[],
): T[] {
    const existing = new Set(base.map(tool => tool.function?.name));
    return [...base, ...discovered.filter(tool => !existing.has(tool.function?.name))];
}

export interface ReasoningParamsInput {
    protocol: ChatProtocol;
    model: string;
    baseURL: string;
    /** 会话级设置优先于环境变量默认值。 */
    effort: string | undefined;
    configuredEfforts?: string[];
}

/** 思考强度参数：按当前协议与厂家派生，值原样下发给上游。 */
function buildReasoningParams(input: ReasoningParamsInput): Record<string, unknown> {
    const provider = getReasoningProvider(input.protocol, input.model, input.baseURL);
    return buildReasoningEffortParams({
        protocol: input.protocol,
        provider,
        effort: input.effort,
        configuredEfforts: input.configuredEfforts,
    });
}

export interface BuildRequestBodyOptions {
    protocol: ChatProtocol;
    model: string;
    baseURL: string;
    /** 已按协议物化好的消息（图片已展开/上传）。 */
    messages: any[];
    /** 已按协议转换好的工具定义。 */
    tools: any[];
    stream: boolean;
    reasoning?: ReasoningParamsInput;
    /** MiniMax：content 不含 <think>，reasoning_details 单独提供。 */
    isMiniMax: boolean;
}

/** 组装最终请求体。纯函数：不读 env、不发请求。 */
export function buildRequestBody(options: BuildRequestBodyOptions): Record<string, any> {
    const usesResponses = options.protocol === "responses";
    const hasTools = options.tools.length > 0;

    const body: Record<string, any> = usesResponses
        ? {
            ...(options.model.trim() ? { model: options.model } : {}),
            input: options.messages,
            tools: options.tools,
            tool_choice: hasTools ? "auto" : "none",
        }
        : {
            ...(options.model.trim() ? { model: options.model } : {}),
            messages: options.messages,
            tools: options.tools,
            tool_choice: hasTools ? "auto" : "none",
        };

    if (options.stream) {
        body.stream = true;
        if (!usesResponses) body.stream_options = { include_usage: true };
    }
    if (options.isMiniMax && !usesResponses) {
        body.reasoning_split = true;
    }
    if (options.reasoning) {
        Object.assign(body, buildReasoningParams(options.reasoning));
    }

    return body;
}

/** 会话级设置 → 环境变量默认值的读取顺序（目前散在 app 与 orchestrator 两处）。 */
export function resolveEffort(
    sessionEffort: string | undefined,
    env: Record<string, string | undefined> = process.env,
): string | undefined {
    return sessionEffort
        ?? env.REASONING_EFFORT
        ?? env.OPENAI_REASONING_EFFORT
        ?? env.DEEPSEEK_REASONING_EFFORT;
}
