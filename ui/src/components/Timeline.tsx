/**
 * 会话时间线：把持久化事件渲染成可读的对话流。
 *
 * 分类原则：谁说的比说了什么更重要 —— 用户输入（右、蓝）、AI 输出（左、markdown）、
 * 工具（调用参数可折叠、输出只留一行状态）、系统通知（居中细条）。
 * 和 TUI 一致：工具输出不铺开，只显示「工具名 + 用时」，要看细节去会话日志。
 */

import { Fragment, useState, type ReactNode } from "react";
import type { AgentEvent } from "../lib/types";
import { formatDuration } from "../lib/format";
import { AssetImage } from "./AssetImage";
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
            </div>
            {/* 手机屏窄，气泡放宽到 92%：85% 扣掉面板内边距后只剩两三个字一行 */}
            <div className="max-w-[92%] rounded-lg rounded-tr-sm bg-accent/10 px-3 py-2 text-sm break-words whitespace-pre-wrap md:max-w-[85%]">
                {event.payload.text}
            </div>
            {(event.payload.images?.length ?? 0) > 0 && (
                <div className="flex max-w-[92%] flex-wrap justify-end gap-2 md:max-w-[85%]">
                    {event.payload.images!.map(image => (
                        <AssetImage
                            key={image.id}
                            id={image.id}
                            alt={image.filename}
                            className="max-h-40 rounded-md border border-border object-contain"
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/** AI 回复：不再贴「AI」标签，靠左对齐 + 正文样式区分于用户消息（右对齐、气泡）。 */
function AssistantMessage({ content }: { content: string }) {
    return <MarkdownBlock content={content} />;
}

/** 思考：只留状态提示，不展开推理内容（和 TUI 的折叠口径一致）。 */
function Thinking() {
    return <div className="text-xs text-muted">🧠 思考中</div>;
}

function ToolCall({
    name,
    summary,
    args,
    durationMs,
    resultSize,
}: {
    name: string;
    summary: string;
    args?: string;
    /** 该工具调用的结果（同一条工具消息）已经到达：用时直接贴在原块上，不再另起一行 */
    durationMs?: number;
    resultSize?: number;
}) {
    const [open, setOpen] = useState(false);
    const hasResult = durationMs !== undefined || resultSize !== undefined;
    return (
        <div className="overflow-hidden rounded-md border border-border bg-col/60">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs"
            >
                <span className="text-accent">▸</span>
                {/* 工具名限宽截断：MCP 名字动辄二三十个字符，不限宽就会把右边的「参数」顶出行外 */}
                <span className="max-w-[38%] shrink-0 truncate font-mono">{name}</span>
                <span className="min-w-0 flex-1 truncate text-left font-mono text-muted">{summary}</span>
                {/* 尾部信息整组不许压缩，摘要让位给它们 */}
                <span className="ml-auto flex shrink-0 items-center gap-2">
                    {hasResult && (
                        <span
                            className="text-ok"
                            title={resultSize === undefined ? undefined : `输出 ${resultSize} 字`}
                        >
                            {durationMs === undefined ? "✓" : formatDuration(durationMs)}
                        </span>
                    )}
                    {/* 大参数只发摘要，参数面板自然也就没有 */}
                    {args !== undefined && <span className="text-muted">{open ? "收起" : "参数"}</span>}
                </span>
            </button>
            {open && args !== undefined && (
                <pre className="max-h-60 overflow-auto px-2.5 pb-2 font-mono text-xs break-all whitespace-pre-wrap">
                    {formatArgs(args)}
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
            <span className="min-w-0 truncate font-mono">{name}</span>
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

export function Timeline({ events, live }: { events: AgentEvent[]; live?: { text: string; thinking: boolean } }) {
    // 工具输出只有 tool_call_id，先扫一遍建立 id → 名字/结果的映射。
    // 结果回填到发起它的那个工具块上，时间线里不再单独占一行。
    const callNames = new Map<string, string>();
    const callResults = new Map<string, { durationMs?: number; size?: number }>();
    for (const event of events) {
        const message = event.payload.message;
        for (const call of message?.tool_calls ?? []) {
            if (call.id) callNames.set(call.id, call.name ?? call.function?.name ?? "工具");
        }
        if (message?.role === "tool" && message.tool_call_id) {
            callResults.set(message.tool_call_id, { durationMs: message.durationMs, size: message.contentLength });
        }
    }
    // 「思考中」只属于"还没收尾的那一轮的最后一条 assistant 消息"：
    // 历史轮回放时 turn_commit 早就在了，一律不显示。
    // 必须两趟：turn_commit 排在同回合消息之后，单趟扫描时它还没进集合
    const committedTurns = new Set<string>();
    for (const event of events) {
        if (event.type === "turn_commit" && event.payload.turnId) committedTurns.add(event.payload.turnId);
    }
    let pendingThinkSeq: number | undefined;
    for (const event of events) {
        const message = event.payload.message;
        if (event.type !== "turn_message" || message?.role !== "assistant") continue;
        const thinks = message.hasReasoning === true
            || (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0);
        if (!thinks) continue;
        const turnId = event.payload.turnId;
        // 每遇到一条就覆盖：只有最后一条可能还在等下一次响应
        pendingThinkSeq = turnId !== undefined && !committedTurns.has(turnId) ? event.seq : undefined;
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
                    // 只有"最后一轮、还没收尾"的那条 assistant 消息显示，历史轮不显示
                    const hasReasoning = event.seq === pendingThinkSeq;
                    nodes.push(
                        <Fragment key={event.seq}>
                            {hasReasoning && <Thinking />}
                            {hasContent && <AssistantMessage content={message.content as string} />}
                            {(message.tool_calls ?? []).map((call, index) => {
                                const name = call.name ?? call.function?.name ?? "工具";
                                const args = call.arguments ?? call.function?.arguments;
                                const summary = call.summary ?? (args ? summarizeToolCall(args) : "");
                                const result = call.id ? callResults.get(call.id) : undefined;
                                return (
                                    <ToolCall
                                        key={`${event.seq}-${index}`}
                                        name={name}
                                        summary={summary}
                                        args={args}
                                        durationMs={result?.durationMs}
                                        resultSize={result?.size}
                                    />
                                );
                            })}
                        </Fragment>,
                    );
                } else if (message.role === "tool") {
                    // 结果已经回填到上面的调用块里；只有找不到调用（历史被裁掉）时才单独显示
                    const attached = message.tool_call_id ? callNames.has(message.tool_call_id) : false;
                    if (!attached) {
                        const name = message.name ?? "工具";
                        nodes.push(
                            <ToolStatus
                                key={event.seq}
                                name={name}
                                durationMs={message.durationMs}
                                size={message.contentLength}
                            />,
                        );
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    // 正在发生的回合：正文边到边渲染；只收到推理增量时显示「思考中」
    if (live && (live.text || live.thinking)) {
        nodes.push(
            <div key="live" className="flex flex-col gap-1">
                {live.thinking && <Thinking />}
                {live.text && <MarkdownBlock content={live.text} />}
            </div>,
        );
    }

    return <div className="flex flex-col gap-2.5">{nodes}</div>;
}
