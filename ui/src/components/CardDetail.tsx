/**
 * 卡片详情：属性 / 会话 / 评论 三个 tab。
 *
 * 数据按需加载（打开才拉），评论与会话改动后回调父组件刷新看板，
 * 保证卡片上的徽标与列表状态一致。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken, sseUrl } from "../lib/api";
import type { AgentEvent, ImageAsset, Job, JobComment, JobSession, McpServer } from "../lib/types";
import { cn } from "../lib/utils";
import { abbreviateHome } from "../lib/format";
import { Timeline } from "./Timeline";
import { TagInput } from "./TagInput";
import { MarkdownBlock } from "./Markdown";
import { MdEditor } from "./MdEditor";
import { Badge, Button, Field, Input, Tabs, Textarea } from "./ui";

type TabKey = "props" | "sessions" | "comments";

function formatTime(iso?: string): string {
    return iso ? new Date(iso).toLocaleString() : "";
}

export function CardDetail({
    job,
    servers,
    home,
    onChanged,
    onClose,
}: {
    job: Job;
    servers: McpServer[];
    /** 服务端的 home 目录：展示时把前缀缩成 ~ */
    home: string;
    onChanged: () => Promise<unknown>;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<TabKey>("props");
    const [comments, setComments] = useState<JobComment[]>([]);
    const [sessions, setSessions] = useState<JobSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(job.sessionId ?? null);
    const [events, setEvents] = useState<AgentEvent[]>([]);
    const [commentDraft, setCommentDraft] = useState("");
    /** 正在内联编辑的评论 id 与草稿；null 表示没有在编辑 */
    const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);
    const [promptDraft, setPromptDraft] = useState(job.input.prompt);
    const [editingPrompt, setEditingPrompt] = useState(false);
    const [inputDraft, setInputDraft] = useState("");
    const [pending, setPending] = useState({ request: 0, turn: 0 });
    /** 会话的 MCP 选中集（有执行会话时以它为准）；null = 还没拉/任务尚未开始 */
    const [mcpSelection, setMcpSelection] = useState<string[] | null>(null);
    /** 会话是否已落过选中集：false 时运行期等于"不限制"，界面回退成全选 */
    const [selectionInitialized, setSelectionInitialized] = useState(false);
    const [attachments, setAttachments] = useState<ImageAsset[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string | null>(null);
    const timelineRef = useRef<HTMLDivElement>(null);

    const refreshComments = useCallback(async () => {
        setComments(await api.listComments(job.id).catch(() => []));
    }, [job.id]);

    const refreshSessions = useCallback(async () => {
        const list = await api.listSessions(job.id).catch(() => []);
        setSessions(list);
        setActiveSessionId(current => {
            if (current && list.some(item => item.sessionId === current)) return current;
            return list.length > 0 ? list[list.length - 1].sessionId : (job.sessionId ?? null);
        });
    }, [job.id, job.sessionId]);

    // 排队输入的数量跟着会话走：切会话时重新拉
    useEffect(() => {
        if (!activeSessionId) {
            setPending({ request: 0, turn: 0 });
            return;
        }
        void api.getPendingInputs(activeSessionId).then(setPending).catch(() => undefined);
    }, [activeSessionId]);

    useEffect(() => {
        void refreshComments();
        void refreshSessions();
    }, [refreshComments, refreshSessions]);

    // 切换卡片时同步任务描述草稿
    useEffect(() => {
        setPromptDraft(job.input.prompt);
        setEditingPrompt(false);
        setEditingComment(null);
    }, [job.id, job.input.prompt]);

    // 时间线：先拉历史，再从最后一条 seq 接 SSE
    useEffect(() => {
        if (!activeSessionId) {
            setEvents([]);
            return;
        }
        let cancelled = false;
        let source: EventSource | null = null;

        void (async () => {
            const history = await api.listEvents(job.id, activeSessionId, 0).catch(() => []);
            if (cancelled) return;
            setEvents(history);
            const since = history.length > 0 ? history[history.length - 1].seq : 0;
            source = new EventSource(sseUrl(`/api/jobs/${job.id}/events?sessionId=${encodeURIComponent(activeSessionId)}`, since));
            source.onmessage = event => {
                const parsed = JSON.parse(event.data) as AgentEvent;
                setEvents(current => [...current, parsed]);
            };
            source.addEventListener("reset", () => setEvents([]));
        })();

        return () => {
            cancelled = true;
            source?.close();
        };
    }, [job.id, activeSessionId]);

    useEffect(() => {
        const node = timelineRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [events]);

    const patch = async (body: Record<string, unknown>) => {
        setError(null);
        try {
            await api.patchJob(job.id, body);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /**
     * 改 MCP 选中集：有执行会话时改会话的（落事件、下个回合生效），
     * 还没跑过就改任务入参，作为首次建会话的初值。
     */
    const applyMcpSelection = async (next: string[]) => {
        setError(null);
        if (!job.sessionId) {
            await patch({ mcpServers: next });
            return;
        }
        const previous = mcpSelection;
        setMcpSelection(next); // 乐观更新：网络往返期间不卡手感
        try {
            const saved = await api.setMcpSelection(job.id, next);
            setMcpSelection(saved.servers);
            setSelectionInitialized(true);
        } catch (cause) {
            setMcpSelection(previous);
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    const act = async (action: "start" | "cancel") => {
        setError(null);
        try {
            if (action === "start") await api.startJob(job.id);
            if (action === "cancel") await api.cancelJob(job.id);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    const submitComment = async () => {
        const body = commentDraft.trim();
        if (!body) return;
        setError(null);
        try {
            await api.addComment(job.id, body, activeSessionId ?? undefined);
            setCommentDraft("");
            await refreshComments();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /**
     * 向当前会话随时输入。两种「切入时机」用按钮表达，不再用一个 checkbox：
     * request = 下一次请求前带上（默认），turn = 等当前对话结束后再开始。
     */
    const sendInput = async (mode: "request" | "turn" = "request") => {
        const text = inputDraft.trim();
        if (!text || !activeSessionId) return;
        setError(null);
        try {
            const result = await api.sendInput(activeSessionId, text, mode, attachments);
            setInputDraft("");
            setAttachments([]);
            setPending(result.pending);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /** 选图/粘贴都走这里：先落到服务端资产目录，拿到引用再随消息发送。 */
    const uploadImage = async (file: File) => {
        if (!file.type.startsWith("image/")) {
            setError("只支持图片文件");
            return;
        }
        setUploading(true);
        setError(null);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result ?? ""));
                reader.onerror = () => reject(new Error("读取图片失败"));
                reader.readAsDataURL(file);
            });
            const asset = await api.uploadAsset(dataUrl, file.name || "paste.png");
            setAttachments(current => [...current, asset]);
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        } finally {
            setUploading(false);
        }
    };

    /** 在同一个任务下新开会话：换思路继续，不新建卡片。 */
    const openBranch = async () => {
        const prompt = window.prompt("在这个新会话里做什么？（留空只建空会话）");
        if (prompt === null) return;
        try {
            const created = await api.createSession(job.id, prompt || undefined);
            setActiveSessionId(created.sessionId);
            setTab("sessions");
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    const isActive = job.state === "running" || job.state === "leased";
    const isTerminal = ["succeeded", "failed", "lost", "cancelled", "interfered"].includes(job.state);

    return (
        <div className="flex h-full flex-col">
            <header className="flex flex-col gap-2 border-b border-border p-3">
                <div className="flex items-start gap-2">
                    <Input
                        defaultValue={job.input.title || job.input.prompt}
                        onBlur={event => {
                            const next = event.target.value.trim();
                            if (next && next !== (job.input.title || job.input.prompt)) void patch({ title: next });
                        }}
                        className="font-medium"
                    />
                    <Button variant="ghost" onClick={onClose} aria-label="关闭">
                        ×
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={isActive ? "accent" : isTerminal ? (job.state === "succeeded" ? "ok" : "warn") : "default"}>
                        {job.state}
                    </Badge>
                    <span className="font-mono">{job.id.slice(-8)}</span>
                    <span>{formatTime(job.createdAt)}</span>
                    {job.error && <span className="text-bad">{job.error}</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                    {job.state === "queued" && job.input.autoStart === false && (
                        <Button variant="primary" onClick={() => void act("start")}>
                            开始执行
                        </Button>
                    )}
                    {(job.state === "queued" || isActive) && (
                        <Button variant="danger" onClick={() => void act("cancel")}>
                            取消
                        </Button>
                    )}
                    {!isActive && (
                        <Button
                            onClick={async () => {
                                try {
                                    await api.archiveJob(job.id);
                                    onClose();
                                    await onChanged();
                                } catch (cause) {
                                    setError(cause instanceof ApiError ? cause.message : String(cause));
                                }
                            }}
                        >
                            归档
                        </Button>
                    )}
                    {!isActive && (
                        <Button
                            variant="danger"
                            onClick={async () => {
                                if (!window.confirm("删除这张卡片？评论与执行记录会一并删除（对话本身保留）。")) return;
                                try {
                                    await api.deleteJob(job.id);
                                    onClose();
                                    await onChanged();
                                } catch (cause) {
                                    setError(cause instanceof ApiError ? cause.message : String(cause));
                                }
                            }}
                        >
                            删除
                        </Button>
                    )}
                </div>
                {error && <p className="text-xs text-bad">{error}</p>}
            </header>

            <div className="px-3 pt-2">
                <Tabs
                    tabs={[
                        { key: "props", label: "属性" },
                        { key: "sessions", label: "会话", count: sessions.length },
                        { key: "comments", label: "评论", count: comments.length },
                    ]}
                    active={tab}
                    onChange={setTab}
                />
            </div>

            {/* 外层只负责给高度：各 tab 自己决定滚动，会话历史才能吃满剩余空间 */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                {tab === "props" && (
                    <div className="stable-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
                        {/* 上下结构：长内容（描述、MCP、结果）能用满面板宽度 */}
                        <Field label="工作目录">
                            <span className="break-all">{abbreviateHome(job.input.workspace, home)}</span>
                        </Field>

                        <Field label="任务描述">
                            {editingPrompt ? (
                                <div className="flex flex-col gap-1.5">
                                    <MdEditor value={promptDraft} onChange={setPromptDraft} rows={3} />
                                    <div className="flex gap-1.5">
                                        <Button
                                            variant="primary"
                                            onClick={async () => {
                                                const next = promptDraft.trim();
                                                if (!next) return;
                                                if (next !== job.input.prompt) await patch({ prompt: next });
                                                setEditingPrompt(false);
                                            }}
                                        >
                                            保存
                                        </Button>
                                        <Button
                                            onClick={() => {
                                                setPromptDraft(job.input.prompt);
                                                setEditingPrompt(false);
                                            }}
                                        >
                                            取消
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-1.5">
                                    <MarkdownBlock content={job.input.prompt} />
                                    <div>
                                        <Button onClick={() => setEditingPrompt(true)}>编辑</Button>
                                    </div>
                                </div>
                            )}
                        </Field>

                        <Field label="标签">
                            <TagInput
                                value={job.input.labels ?? []}
                                onChange={next => void patch({ labels: next })}
                                placeholder="输入后按逗号或回车"
                            />
                        </Field>

                        <Field label="超时（秒）">
                            <Input
                                type="number"
                                min={1}
                                defaultValue={job.input.timeoutSec ?? ""}
                                onBlur={event => {
                                    const value = Number(event.target.value);
                                    if (value > 0) void patch({ timeoutSec: value });
                                }}
                            />
                        </Field>

                        <Field label={job.sessionId ? "选中的 MCP（下个回合生效）" : "允许的 MCP"}>
                            <div className="flex flex-wrap gap-1.5">
                                {servers.length === 0 && <span className="text-xs text-muted">（没有可选的 MCP）</span>}
                                {servers.map(server => {
                                    // 有执行会话时以会话选中集为准；未初始化（老会话）或还没跑过都等于全选
                                    const current = mcpSelection !== null && selectionInitialized
                                        ? mcpSelection
                                        : (job.input.mcpServers ?? servers.map(item => item.name));
                                    const checked = current.includes(server.name);
                                    return (
                                        <button
                                            key={server.name}
                                            onClick={() => {
                                                const next = checked
                                                    ? current.filter(item => item !== server.name)
                                                    : [...current, server.name];
                                                void applyMcpSelection(next);
                                            }}
                                            className={cn(
                                                "rounded-full border px-2.5 py-0.5 text-xs",
                                                checked ? "border-accent text-accent" : "border-border text-muted",
                                            )}
                                        >
                                            {server.name} ({server.toolCount})
                                        </button>
                                    );
                                })}
                                {servers.length > 0 && (mcpSelection ?? job.input.mcpServers)?.length !== 0 && (
                                    <button
                                        onClick={() => void applyMcpSelection([])}
                                        className="ml-auto rounded-full px-2 py-0.5 text-xs text-muted underline-offset-2 hover:underline"
                                    >
                                        清空
                                    </button>
                                )}
                            </div>
                        </Field>

                        {job.result?.text && (
                            <Field label="结果">
                                <MarkdownBlock content={job.result.text} className="max-h-72 overflow-auto" />
                            </Field>
                        )}
                    </div>
                )}

                {tab === "sessions" && (
                    <div className="flex min-h-0 flex-1 flex-col gap-2">
                        <div className="flex shrink-0 items-center gap-2">
                            {sessions.length === 0 ? (
                                <span className="flex-1 text-xs text-muted">还没有执行会话</span>
                            ) : (
                                <select
                                    value={activeSessionId ?? ""}
                                    onChange={event => setActiveSessionId(event.target.value)}
                                    className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm"
                                >
                                    {sessions.map(item => (
                                        <option key={item.sessionId} value={item.sessionId}>
                                            {item.sessionId.slice(-8)} · {item.purpose} · {formatTime(item.createdAt)}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <Button onClick={() => void openBranch()}>+ 新会话</Button>
                        </div>
                        <div ref={timelineRef} className="stable-scroll flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                            <Timeline events={events} />
                        </div>
                        {activeSessionId && (
                            <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-2">
                                <Textarea
                                    value={inputDraft}
                                    placeholder="随时输入：空闲会立刻开始；正在跑就按下面的方式排队（可直接粘贴图片）"
                                    onChange={event => setInputDraft(event.target.value)}
                                    onPaste={event => {
                                        const file = Array.from(event.clipboardData.files)[0];
                                        if (!file) return;
                                        event.preventDefault();
                                        void uploadImage(file);
                                    }}
                                    onKeyDown={event => {
                                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                            event.preventDefault();
                                            void sendInput("request");
                                        }
                                    }}
                                />
                                {attachments.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {attachments.map(asset => (
                                            <div key={asset.id} className="relative">
                                                <img
                                                    src={`/api/assets/${asset.id}?token=${encodeURIComponent(getToken())}`}
                                                    alt={asset.filename}
                                                    className="h-16 w-16 rounded-md border border-border object-cover"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setAttachments(current =>
                                                            current.filter(item => item.id !== asset.id),
                                                        )
                                                    }
                                                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-panel text-xs text-muted hover:text-bad"
                                                    aria-label="移除图片"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={event => {
                                            const file = event.target.files?.[0];
                                            event.target.value = "";
                                            if (file) void uploadImage(file);
                                        }}
                                    />
                                    <Button
                                        variant="ghost"
                                        disabled={uploading}
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        {uploading ? "上传中…" : "图片"}
                                    </Button>
                                    <span className="flex-1" />
                                    {(pending.request > 0 || pending.turn > 0) && (
                                        <span>
                                            排队中 请求 {pending.request} · 回合 {pending.turn}
                                        </span>
                                    )}
                                    <Button onClick={() => void sendInput("turn")}>结束后</Button>
                                    <Button variant="primary" onClick={() => void sendInput("request")}>
                                        发送
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === "comments" && (
                    <div className="stable-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                        {comments.length === 0 && <p className="text-xs text-muted">还没有评论</p>}
                        {comments.map(comment => (
                            <div key={comment.id} className="flex flex-col gap-1.5">
                                <div className="flex items-center gap-2 text-xs text-muted">
                                    <span>{comment.author === "agent" ? "agent" : "我"}</span>
                                    <span>{formatTime(comment.createdAt)}</span>
                                    {comment.editedAt && <span>已编辑</span>}
                                </div>
                                {editingComment?.id === comment.id ? (
                                    <>
                                        <MdEditor
                                            value={editingComment.body}
                                            onChange={body => setEditingComment({ id: comment.id, body })}
                                            rows={4}
                                        />
                                        <div className="flex gap-1">
                                            <Button
                                                variant="primary"
                                                onClick={async () => {
                                                    const next = editingComment.body.trim();
                                                    if (!next) return;
                                                    await api.updateComment(job.id, comment.id, next).catch(() => {});
                                                    setEditingComment(null);
                                                    await refreshComments();
                                                }}
                                            >
                                                保存
                                            </Button>
                                            <Button variant="ghost" onClick={() => setEditingComment(null)}>
                                                取消
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                className="text-bad"
                                                onClick={async () => {
                                                    if (!window.confirm("删除这条评论？")) return;
                                                    await api.deleteComment(job.id, comment.id).catch(() => {});
                                                    setEditingComment(null);
                                                    await refreshComments();
                                                    await onChanged();
                                                }}
                                            >
                                                删除
                                            </Button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <MarkdownBlock content={comment.body} />
                                        <div className="flex gap-1">
                                        <Button
                                            variant="ghost"
                                            onClick={() => setEditingComment({ id: comment.id, body: comment.body })}
                                        >
                                            编辑
                                        </Button>
                                            <Button
                                                variant="ghost"
                                                className="text-bad"
                                                onClick={async () => {
                                                    if (!window.confirm("删除这条评论？")) return;
                                                    await api.deleteComment(job.id, comment.id).catch(() => {});
                                                    await refreshComments();
                                                    await onChanged();
                                                }}
                                            >
                                                删除
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                        <MdEditor
                            value={commentDraft}
                            onChange={setCommentDraft}
                            rows={3}
                            placeholder="写评论…（Ctrl/⌘ + Enter 提交）"
                            onSubmit={() => void submitComment()}
                        />
                        <div>
                            <Button variant="primary" onClick={() => void submitComment()}>
                                发表评论
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
