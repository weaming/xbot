/**
 * 工具调用的唯一领域表示。OpenAI 兼容消息里的 `tool_calls`（参数是 JSON 字符串）
 * 与 `ToolCall` 之间只通过本文件的适配器互转，避免各模块重复解析/拼装。
 */

import { patchArgumentsJson } from "../tools/tool-kinds.js";

export interface ToolCall {
    id: string;
    name: string;
    /** 已反解析的参数；JSON 损坏时为 undefined（由历史修复补合成结果）。 */
    args?: unknown;
    /** 原始 arguments 字符串，回写 OpenAI 消息时保留。 */
    rawArgs: string;
}

interface RawToolCall {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    function?: { name?: unknown; arguments?: unknown };
    type?: unknown;
    custom?: { name?: unknown; input?: unknown };
}

/** OpenAI 消息里的 tool_calls（或同形结构）→ 领域类型；缺 id 的条目丢弃。 */
export function fromOpenAIToolCalls(raw: unknown): ToolCall[] {
    if (!Array.isArray(raw)) return [];
    const calls: ToolCall[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const record = item as RawToolCall;
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) continue;

        // 自由文本工具调用：input 是补丁原文，本地按 {"patch": input} 执行
        if (record.type === "custom" && record.custom) {
            const input = typeof record.custom.input === "string" ? record.custom.input : "";
            calls.push({
                id,
                name: typeof record.custom.name === "string" ? record.custom.name : "",
                rawArgs: patchArgumentsJson(input),
                args: { patch: input },
            });
            continue;
        }

        const name = typeof record.function?.name === "string"
            ? record.function.name
            : typeof record.name === "string"
                ? record.name
                : "";
        const rawArgs = typeof record.function?.arguments === "string"
            ? record.function.arguments
            : typeof record.arguments === "string"
                ? record.arguments
                : "{}";
        calls.push({ id, name, rawArgs, args: parseToolArgs(rawArgs) });
    }
    return calls;
}

/** JSON 参数解析：空串按空对象处理，损坏返回 undefined。 */
function parseToolArgs(raw: string): unknown | undefined {
    if (!raw || !raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}
