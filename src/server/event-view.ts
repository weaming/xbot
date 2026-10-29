/**
 * 会话事件的 HTTP 视图：只保留 Web 端真正会渲染的字段。
 *
 * 原始事件是给重放用的（工具输出全文、思考全文、段边界、提交元信息都在里面），
 * 一个中等长度的会话就能到 8~9 MB；而时间线只画「谁说了什么 + 工具名与用时」。
 * 体积差主要来自工具输出正文与推理正文，这里统统不进响应。
 *
 * 只作用于 HTTP（JSON 与 SSE），不影响磁盘上的事件日志与重放。
 */

import type { AgentEvent } from "../events/agent-events.js";
import { formatToolArguments } from "../utils/tool-progress.js";

/** 单次工具调用的参数超过这个长度就只发摘要：大型 patch/脚本正文能占掉整个响应的一半。 */
const ARGUMENTS_MAX_CHARS = 400;
/** 摘要一行够用，再长也只是噪音。 */
const SUMMARY_MAX_CHARS = 120;

function summarizeCall(name: string, rawArguments: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArguments);
    } catch {
        return oneLine(rawArguments);
    }
    // 命令类工具最有信息量的就是命令本身，别退化成 command=... cwd=... 一串
    const command = (parsed as { command?: unknown; cmd?: unknown })?.command ?? (parsed as { cmd?: unknown })?.cmd;
    if (typeof command === "string" && command.trim()) return oneLine(command);
    const formatted = formatToolArguments(parsed);
    return oneLine(formatted || rawArguments);
}

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS)}…` : flat;
}

export interface SessionEventView {
    seq: number;
    ts: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
}

/** 界面不渲染、也不参与排序的事件：直接不发。 */
const DROPPED_TYPES = new Set([
    "turn_segment_start",
    "turn_stream_delta",
    "usage_recorded",
    "standalone_turn",
    "session_created",
    "session_renamed",
    "session_archived",
    "session_unarchived",
    "session_cwd_changed",
    "model_selected",
    "lazy_mcp_changed",
]);

/**
 * 单条事件的视图；返回 null 表示这条不下发。
 * 保留：用户/会话间消息、AI 正文与工具调用、工具状态行、系统通知。
 */
export function toSessionEventView(event: AgentEvent): SessionEventView | null {
    if (DROPPED_TYPES.has(event.type)) return null;

    const base = { seq: event.seq, ts: event.ts, sessionId: event.sessionId, type: event.type as string };

    switch (event.type) {
        case "user_message": {
            const payload = event.payload;
            return {
                ...base,
                payload: {
                    text: payload.text,
                    trigger: payload.trigger,
                    // 图片只要 id（拉缩略图）与文件名（alt）；URL 形式的引用直接给 url
                    ...(payload.images?.length
                        ? {
                              images: payload.images.map(image => (
                                  "id" in image
                                      ? { id: image.id, filename: image.filename }
                                      : { url: image.url, filename: image.filename }
                              )),
                          }
                        : {}),
                },
            };
        }
        case "peer_message":
            return {
                ...base,
                payload: {
                    direction: event.payload.direction,
                    peerId: event.payload.peerId,
                    ...(event.payload.peerTitle ? { peerTitle: event.payload.peerTitle } : {}),
                    text: event.payload.text,
                },
            };
        case "peer_result":
            // 时间线只显示一行提示，正文不下发
            return { ...base, payload: { ok: event.payload.ok } };
        case "context_compacted":
        case "assistant_history_repaired":
            return { ...base, payload: {} };
        case "turn_commit":
            // 正文与事件 seq 列表都不需要；界面只关心"这一回合收尾了没有"
            return { ...base, payload: { turnId: event.payload.turnId } };
        case "turn_message": {
            const message = event.payload.message as Record<string, unknown>;
            const role = message.role;
            if (role === "assistant") {
                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                return {
                    ...base,
                    payload: {
                        // turnId 用于判断该回合是否已收尾（收尾后不再显示「思考中」）
                        turnId: event.payload.turnId,
                        message: {
                            role,
                            ...(typeof message.content === "string" && message.content ? { content: message.content } : {}),
                            // 只有"有没有想过"这件事有意义，推理正文不进响应
                            ...(typeof message.reasoning_content === "string" && message.reasoning_content
                                ? { hasReasoning: true }
                                : {}),
                            ...(toolCalls.length > 0
                                ? {
                                      tool_calls: toolCalls.map((call: any) => {
                                          const name = call?.function?.name ?? "工具";
                                          const rawArguments = typeof call?.function?.arguments === "string"
                                              ? call.function.arguments
                                              : "";
                                          return {
                                              ...(call?.id ? { id: call.id } : {}),
                                              name,
                                              // 摘要由服务端算好：界面只要一行字，不必为此传整份参数
                                              summary: summarizeCall(name, rawArguments),
                                              // 小参数照旧带上，界面还能展开看原文；大参数只留摘要
                                              ...(rawArguments.length <= ARGUMENTS_MAX_CHARS
                                                  ? { arguments: rawArguments }
                                                  : {}),
                                          };
                                      }),
                                  }
                                : {}),
                        },
                    },
                };
            }
            if (role === "tool") {
                const content = typeof message.content === "string" ? message.content : "";
                return {
                    ...base,
                    payload: {
                        // turnId 用于判断该回合是否已收尾（收尾后不再显示「思考中」）
                        turnId: event.payload.turnId,
                        message: {
                            role,
                            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
                            ...(typeof message.name === "string" ? { name: message.name } : {}),
                            ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
                            // 输出正文只留长度：界面只显示「← 工具 用时」，正文去日志看
                            contentLength: content.length,
                        },
                    },
                };
            }
            // 其余角色（例如历史里的 user）只留正文
            return { ...base, payload: { message: { role, content: message.content ?? "" } } };
        }
        default:
            return { ...base, payload: {} };
    }
}

/** 批量投影，null 结果被过滤掉。 */
export function toSessionEventViews(events: AgentEvent[]): SessionEventView[] {
    const views: SessionEventView[] = [];
    for (const event of events) {
        const view = toSessionEventView(event);
        if (view) views.push(view);
    }
    return views;
}
