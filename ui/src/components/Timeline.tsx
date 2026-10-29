/**
 * 会话时间线：把持久化事件渲染成可读的对话流。
 *
 * 分类原则：谁说的比说了什么更重要 —— 用户输入（右、蓝）、AI 输出（左、markdown）、
 * 工具（调用参数可折叠、输出只留一行状态）、系统通知（居中细条）。
 * 和 TUI 一致：工具输出不铺开，只显示「工具名 + 用时」，要看细节去会话日志。
 */

import { Fragment, useState, type ReactNode } from "react";
import type { AgentEvent } from "../lib/types";
import { getToken } from "../lib/api";
import { formatDuration } from "../lib/format";
import { MarkdownBlock } from "./Markdown";

function oneLine(text: string, max = 120): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 参数尽量 pretty print，解析不了就原样显示 */
function formatArgs(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

/**
 * 工具调用的一行摘要：与 TUI 一致，优先显示「这个工具在操作什么」，
 * 而不是把整段 JSON 摆出来（bash 显示命令、文件类显示路径、其余 k=v）。
 */
function summarizeToolCall(raw: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return oneLine(raw);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return oneLine(raw);
    const args = parsed as Record<string, unknown>;

    if (typeof args.command === "string" && args.command.trim()) return oneLine(args.command.trim());
    if (Array.isArray(args.commands) && args.commands.every(item => typeof item === "string")) {
        return oneLine(args.commands.join(" | "));
    }
    for (const key of ["path", "file_path", "filePath", "pattern", "query", "url", "prompt", "text"]) {
        if (typeof args[key] === "string" && (args[key] as string).trim()) return oneLine(args[key] as string);
    }
    const pairs = Object.entries(args)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    return oneLine(pairs.join(" "));
}

function Notice({ text }: { text: string }) {
    return (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            <span className="shrink-0">{text}</span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

function UserMessage({ event, isFirst }: { event: AgentEvent; isFirst: boolean }) {
    const trigger = event.payload.trigger ?? "user";
    const imageCount = event.payload.images?.length ?? 0;
    return (
        <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5 text-xs text-muted">
                {isFirst && <span className="rounded bg-col px-1.5 py-0.5">任务起始</span>}
                {trigger === "pending" && <span className="rounded bg-col px-1.5 py-0.5">回合中补发</span>}
                {trigger === "peer" && (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">会话间</span>
                )}
                {imageCount > 0 && <span>🖼 {imageCount}</span>}
                <span>你</span>
            </div>
            <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-accent/10 px-3 py-2 text-sm break-words whitespace-pre-wrap">
                {event.payload.text}
            </div>
            {(event.payload.images?.length ?? 0) > 0 && (
                <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                    {event.payload.images!.map(image => (
                        <img
                            key={image.id}
                            src={`/api/assets/${image.id}?token=${encodeURIComponent(getToken())}`}
                            alt={image.filename}
                            className="max-h-40 rounded-md border border-border object-contain"
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function AssistantMessage({ content }: { content: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">AI</span>
            <MarkdownBlock content={content} />
        </div>
    );
}

/** 思考：只留状态提示，不展开推理内容（和 TUI 的折叠口径一致）。 */
function Thinking() {
    return <div className="text-xs text-muted">🧠 思考中</div>;
}

function ToolCall({ name, args }: { name: string; args: string }) {
    const [open, setOpen] = useState(false);
    const pretty = formatArgs(args);
    const summary = summarizeToolCall(args);
    return (
        <div className="rounded-md border border-border bg-col/60">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs"
            >
                <span className="text-accent">▸</span>
                <span className="shrink-0 font-mono">{name}</span>
                <span className="flex-1 truncate text-left font-mono text-muted">{summary}</span>
                <span className="ml-auto shrink-0 text-muted">{open ? "收起" : "参数"}</span>
            </button>
            {open && (
                <pre className="max-h-60 overflow-auto px-2.5 pb-2 font-mono text-xs break-all whitespace-pre-wrap">
                    {pretty}
                </pre>
            )}
        </div>
    );
}

/**
 * 工具输出：与 TUI 一致，只留一行「← 工具名 + 用时」，不铺开内容 ——
 * 一段日志能把整屏占满，而真正要排查时该去看 sessions/log 里的原始记录。
 * 输出长度放 title 里，鼠标悬停即可看到大小，不额外占视觉。
 */
function ToolStatus({ name, durationMs, size }: { name: string; durationMs?: number; size?: number }) {
    return (
        <div
            className="flex items-center gap-2 pl-1 text-xs text-muted"
            title={size === undefined ? undefined : `${name} 输出 ${size} 字`}
        >
            <span aria-hidden>←</span>
            <span className="font-mono">{name}</span>
            {typeof durationMs === "number" && <span className="text-ok">{formatDuration(durationMs)}</span>}
        </div>
    );
}

function PeerMessage({ event }: { event: AgentEvent }) {
    const incoming = event.payload.direction !== "out";
    return (
        <div className="flex flex-col items-start gap-1">
            <span className="text-xs text-muted">
                {incoming ? "收到" : "发给"} {event.payload.peerTitle ?? event.payload.peerId?.slice(-6) ?? "会话"}
            </span>
            <div className="w-[85%]">
                <MarkdownBlock content={event.payload.text ?? ""} className="border-accent/30 bg-accent/5" />
            </div>
        </div>
    );
}

export function Timeline({ events }: { events: AgentEvent[] }) {
    // 工具输出只有 tool_call_id，先扫一遍建立 id → 名字的映射
    const callNames = new Map<string, string>();
    for (const event of events) {
        for (const call of event.payload.message?.tool_calls ?? []) {
            if (call.id) callNames.set(call.id, call.function.name);
        }
    }
    const firstUserSeq = events.find(event => event.type === "user_message")?.seq;

    const nodes: ReactNode[] = [];
    for (const event of events) {
        const payload = event.payload;
        switch (event.type) {
            case "user_message":
                nodes.push(
                    <UserMessage key={event.seq} event={event} isFirst={event.seq === firstUserSeq} />,
                );
                break;
            case "peer_message":
                nodes.push(<PeerMessage key={event.seq} event={event} />);
                break;
            case "peer_result":
                nodes.push(
                    <Notice key={event.seq} text={payload.ok === false ? "会话间结果回传失败" : "收到会话间结果"} />,
                );
                break;
            case "context_compacted":
                nodes.push(<Notice key={event.seq} text="上下文已压缩" />);
                break;
            case "assistant_history_repaired":
                nodes.push(<Notice key={event.seq} text="历史消息已修复" />);
                break;
            case "turn_message": {
                const message = payload.message;
                if (!message) break;
                if (message.role === "assistant") {
                    const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
                    const hasReasoning = typeof message.reasoning_content === "string" && message.reasoning_content.length > 0;
                    nodes.push(
                        <Fragment key={event.seq}>
                            {hasReasoning && <Thinking />}
                            {hasContent && <AssistantMessage content={message.content as string} />}
                            {(message.tool_calls ?? []).map((call, index) => (
                                <ToolCall
                                    key={`${event.seq}-${index}`}
                                    name={call.function.name}
                                    args={call.function.arguments}
                                />
                            ))}
                        </Fragment>,
                    );
                } else if (message.role === "tool") {
                    const text =
                        typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
                    const name = message.tool_call_id ? (callNames.get(message.tool_call_id) ?? "工具") : "工具";
                    nodes.push(
                        <ToolStatus key={event.seq} name={name} durationMs={message.durationMs} size={text.length} />,
                    );
                }
                break;
            }
            default:
                break;
        }
    }

    return <div className="flex flex-col gap-2.5">{nodes}</div>;
}
