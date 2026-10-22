/**
 * 工具批处理：执行一批工具调用并把结果落进本回合消息。
 *
 * 两条不变量由本模块保证：
 *   1. search_tools 有副作用（会改变后续请求的工具表），必须串行
 *   2. 结果按调用顺序稳定入列 —— 并行执行只影响耗时，不影响消息顺序，
 *      否则下一轮的请求前缀会随调度时序抖动，破坏前缀缓存
 */

import type { ToolCall } from "../../types/tool-call.js";
import { getOpenAIToolDefinitionsByNames } from "../tool-registry.js";
import {
    compactJsonToolOutput,
    type ToolExecutionOutput,
    type ToolExecutionResponse,
} from "../tool-interface.js";
import type { UIEvent } from "../../events/ui-events.js";
import type { ChatMessage } from "../../types/session.js";

/** 声明式工具会改变后续请求的工具表，不能与其他工具并发。 */
const SIDE_EFFECT_TOOL = "search_tools";

function normalizeToolExecutionOutput(output: ToolExecutionResponse): ToolExecutionOutput {
    return typeof output === "string" ? { content: output } : output;
}

export interface ToolLoopHost {
    executeTool?: (name: string, args: any) => Promise<ToolExecutionResponse>;
    onToolCall?: (name: string, args: any, mode: "serial" | "parallel") => void;
    onToolResult?: (name: string, result: string) => void;
    /** 追加一条完整消息（含落盘），保持顺序。收集模式下不提供。 */
    appendTurnMessage?(message: ChatMessage): void;
    /** 收集模式：只返回消息，由调用方按调用顺序统一入列。 */
    collectMessages?: ChatMessage[];
    emit(event: UIEvent): void;
    /** 记录本轮新发现的工具名，供下一轮请求追加定义。 */
    recordDiscoveredTool(name: string): void;
    /** 分配工具事件的展示 id（单调递增）。 */
    nextToolId(): number;
    /** 中止检查：工具执行前发现已中止则抛出。 */
    assertNotAborted(): void;
}

/** 解析 search_tools 的返回，取出可注入的工具名列表。 */
function parseDiscoveredToolNames(output: string): string[] {
    try {
        const parsed = JSON.parse(output);
        if (!Array.isArray(parsed?.tools)) return [];
        return parsed.tools
            .map((tool: any) => tool?.function?.name)
            .filter((name: unknown): name is string => typeof name === "string");
    } catch {
        return [];
    }
}

/** 执行单个工具调用并把结果追加进本回合消息。 */
async function processToolCall(
    host: ToolLoopHost,
    toolCall: ToolCall,
    mode: "serial" | "parallel",
): Promise<void> {
    host.assertNotAborted();
    host.onToolCall?.(toolCall.name, toolCall.args, mode);
    const toolId = host.nextToolId();
    host.emit({ type: "tool_start", toolId, callId: toolCall.id, name: toolCall.name, args: toolCall.args, mode });
    const toolStartedAt = Date.now();

    let toolOutput = "";
    let toolFailed = false;
    let toolContextPolicy: ToolExecutionOutput["contextPolicy"];
    let toolImageContent: ToolExecutionOutput["imageContent"];

    if (host.executeTool) {
        try {
            const executionOutput = normalizeToolExecutionOutput(
                await host.executeTool(toolCall.name, toolCall.args),
            );
            toolOutput = executionOutput.content;
            toolContextPolicy = executionOutput.contextPolicy;
            toolImageContent = executionOutput.imageContent;

            if (toolCall.name === SIDE_EFFECT_TOOL) {
                const discoveredNames = parseDiscoveredToolNames(toolOutput);
                if (discoveredNames.length > 0) {
                    for (const tool of getOpenAIToolDefinitionsByNames(discoveredNames)) {
                        const toolName = tool.function?.name;
                        if (toolName) host.recordDiscoveredTool(toolName);
                    }
                    // schema 由下一轮 tools 参数提供，结果只回传名字列表省 token
                    toolOutput = JSON.stringify(discoveredNames);
                }
            }

            toolOutput = compactJsonToolOutput(toolOutput, toolCall.name);
        } catch (error: any) {
            if (error?.name === "AbortError") throw error;
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

    const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: toolOutput,
        ...(toolContextPolicy ? { contextPolicy: toolContextPolicy } : {}),
        ...(toolImageContent && toolImageContent.length > 0 ? { imageContent: toolImageContent } : {}),
    };
    if (host.collectMessages) host.collectMessages.push(toolMessage);
    else host.appendTurnMessage?.(toolMessage);

    host.onToolResult?.(toolCall.name, toolOutput);
    host.emit({
        type: "tool_result",
        toolId,
        callId: toolCall.id,
        name: toolCall.name,
        summary: toolOutput,
        isError: toolFailed,
        durationMs: Date.now() - toolStartedAt,
    });
}

/**
 * 执行一批工具调用。
 *
 * 并发只发生在「执行」阶段，落盘严格按调用顺序：
 * 先并行跑完，再按 calls 的原顺序逐条 append，避免结果顺序依赖完成时序。
 */
async function runToolCalls(host: ToolLoopHost, calls: ToolCall[]): Promise<void> {
    if (calls.length === 0) return;

    // search_tools 改变后续请求的工具表，必须独占执行
    if (calls.some(toolCall => toolCall.name === SIDE_EFFECT_TOOL)) {
        for (const toolCall of calls) {
            await processToolCall(host, toolCall, "serial");
        }
        return;
    }

    await Promise.all(calls.map(toolCall => processToolCall(host, toolCall, "parallel")));
}

/**
 * 执行一批工具调用，只返回消息、不决定入列顺序。
 *
 * 调用方据此保证「执行可以并行，入列必须按调用顺序」，
 * 让下一轮请求前缀不随调度时序抖动。
 */
export async function runToolCallsCollecting(
    host: Omit<ToolLoopHost, "appendTurnMessage" | "collectMessages">,
    calls: ToolCall[],
): Promise<ChatMessage[]> {
    if (calls.length === 0) return [];

    // search_tools 改变后续请求的工具表，必须串行执行（不能再走并行分支）
    if (calls.some(toolCall => toolCall.name === SIDE_EFFECT_TOOL)) {
        const collected: ChatMessage[] = [];
        for (const toolCall of calls) {
            await processToolCall({ ...host, collectMessages: collected }, toolCall, "serial");
        }
        return collected;
    }

    // 每通调用独立缓冲区：并行完成后由调用方按原顺序拼接
    const buffers = calls.map(() => [] as ChatMessage[]);
    await Promise.all(calls.map((toolCall, index) =>
        processToolCall({ ...host, collectMessages: buffers[index]! }, toolCall, "parallel"),
    ));
    return buffers.flat();
}
