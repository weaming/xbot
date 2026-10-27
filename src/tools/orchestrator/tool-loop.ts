/**
 * 工具批处理：执行一批工具调用并把结果落进本回合消息。
 *
 * 结果按调用顺序稳定入列。并行执行只影响耗时，不影响消息顺序，
 * 否则下一轮的请求前缀会随调度时序抖动，破坏前缀缓存。
 */

import type { ToolCall } from "../../types/tool-call.js";
import {
    compactJsonToolOutput,
    type ToolExecutionOutput,
    type ToolExecutionResponse,
} from "../tool-interface.js";
import type { UIEvent } from "../../events/ui-events.js";
import type { ChatMessage } from "../../types/session.js";

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
    /** 分配工具事件的展示 id（单调递增）。 */
    nextToolId(): number;
    /** 中止检查：工具执行前发现已中止则抛出。 */
    assertNotAborted(): void;
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
    let toolAudioContent: ToolExecutionOutput["audioContent"];

    if (host.executeTool) {
        try {
            const executionOutput = normalizeToolExecutionOutput(
                await host.executeTool(toolCall.name, toolCall.args),
            );
            toolOutput = executionOutput.content;
            toolContextPolicy = executionOutput.contextPolicy;
            toolImageContent = executionOutput.imageContent;
            toolAudioContent = executionOutput.audioContent;

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

    // 耗时随工具消息落盘（本地渲染元数据，上行前会被剥离），会话重开后仍能显示
    const durationMs = Date.now() - toolStartedAt;
    const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: toolOutput,
        durationMs,
        ...(toolContextPolicy ? { contextPolicy: toolContextPolicy } : {}),
        ...(toolImageContent && toolImageContent.length > 0 ? { imageContent: toolImageContent } : {}),
        ...(toolAudioContent && toolAudioContent.length > 0 ? { audioContent: toolAudioContent } : {}),
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
        durationMs,
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

    // 每通调用独立缓冲区：并行完成后由调用方按原顺序拼接
    const buffers = calls.map(() => [] as ChatMessage[]);
    await Promise.all(calls.map((toolCall, index) =>
        processToolCall({ ...host, collectMessages: buffers[index]! }, toolCall, "parallel"),
    ));
    return buffers.flat();
}
