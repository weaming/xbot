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

/**
 * 单次工具调用的参数超过这个长度就不带原文（只给 argumentSize）：
 * 大型 patch/脚本正文能占掉整个响应的一半，界面要看原文时按需再拉。
 */
const ARGUMENTS_MAX_CHARS = 400;
/** 摘要一行够用，再长也只是噪音。 */
const SUMMARY_MAX_CHARS = 120;

/** 一次 patch 里改动的单个文件。 */
interface PatchFileStat {
    path: string;
    kind: "add" | "update" | "delete";
    added: number;
    removed: number;
}

interface PatchStat {
    files: PatchFileStat[];
    added: number;
    removed: number;
}

/**
 * 工具的三种历史形状统一成 name + 参数原文：
 * - OpenAI chat：`{ id, function: { name, arguments } }`
 * - Responses custom tool：`{ id, custom: { name, input } }`（apply_patch 这类自由文本工具）
 * - 已经拍平的：`{ id, name, arguments }`
 */
export function readToolCall(call: any): { id?: string; name: string; rawArguments: string } {
    const fn = call?.function;
    const custom = call?.custom;
    const name = (typeof fn?.name === "string" && fn.name)
        || (typeof custom?.name === "string" && custom.name)
        || (typeof call?.name === "string" && call.name)
        || "工具";
    const rawArguments = typeof fn?.arguments === "string"
        ? fn.arguments
        : typeof custom?.input === "string"
          ? custom.input
          : typeof call?.arguments === "string"
            ? call.arguments
            : "";
    return { ...(typeof call?.id === "string" ? { id: call.id } : {}), name, rawArguments };
}

/**
 * apply_patch 的 patch 文本按文件统计增删行：
 * 界面要的是「改了哪些文件、各加减多少」，把整份 patch 摊在时间线上没人看。
 */
function patchStatOf(name: string, rawArguments: string): PatchStat | null {
    if (!/apply_patch/i.test(name)) return null;

    const files: PatchFileStat[] = [];
    let current: PatchFileStat | null = null;
    for (const line of rawArguments.split("\n")) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
        if (header) {
            current = {
                path: header[2]!,
                kind: header[1] === "Add" ? "add" : header[1] === "Update" ? "update" : "delete",
                added: 0,
                removed: 0,
            };
            files.push(current);
            continue;
        }
        if (line.startsWith("*** ")) {
            current = null;
            continue;
        }
        if (!current || line.startsWith("@@")) continue;
        if (line.startsWith("+")) current.added += 1;
        else if (line.startsWith("-")) current.removed += 1;
    }
    if (files.length === 0) return null;

    return {
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
}

function summarizePatch(stat: PatchStat): string {
    const counts = `${stat.files.length} 个文件`;
    // 只有一边有改动时别写成「+300 −0」
    const changed = [
        stat.added > 0 ? `+${stat.added}` : "",
        stat.removed > 0 ? `−${stat.removed}` : "",
    ].filter(Boolean);
    return changed.length > 0 ? `${counts} · ${changed.join(" ")}` : counts;
}

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
        case "steer_update":
            return {
                ...base,
                payload: {
                    turnId: event.payload.turnId,
                    responseId: event.payload.responseId,
                    phase: event.payload.phase,
                    ...(event.payload.text ? { text: event.payload.text } : {}),
                    ...(event.payload.isAwaitingToolInput ? { isAwaitingToolInput: true } : {}),
                },
            };
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
                                          const { id, name, rawArguments } = readToolCall(call);
                                          const patchStat = patchStatOf(name, rawArguments);
                                          return {
                                              ...(id ? { id } : {}),
                                              name,
                                              // 摘要由服务端算好：界面只要一行字，不必为此传整份参数
                                              summary: patchStat ? summarizePatch(patchStat) : summarizeCall(name, rawArguments),
                                              // patch 类给结构化的文件增删，界面按文件列表渲染
                                              ...(patchStat ? { patchStat } : {}),
                                              // 小参数照旧带上，界面还能展开看原文
                                              ...(rawArguments.length > 0 && rawArguments.length <= ARGUMENTS_MAX_CHARS
                                                  ? { arguments: rawArguments }
                                                  : {}),
                                              // 大参数只留长度：界面点开时再按需拉全文
                                              ...(rawArguments.length > ARGUMENTS_MAX_CHARS
                                                  ? { argumentSize: rawArguments.length }
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

/**
 * SSE 帧的 data：省掉客户端本来就知道的两个字段。
 * - `seq` 已经在 `id:` 行（断线续传的游标），data 里再放一份是纯冗余；
 * - `sessionId` 在 URL 里（/sessions/:id/live、/jobs/:id/live?sessionId=）。
 * 一帧省下约 50 字节，帧多时（长会话回放）就是可见的体积。
 */
export function toLiveEventPayload(view: SessionEventView): Omit<SessionEventView, "seq" | "sessionId"> {
    const { seq: _seq, sessionId: _sessionId, ...rest } = view;
    return rest;
}
