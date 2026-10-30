/**
 * 卡片详情：属性 / 会话 / 评论 三个 tab。
 *
 * 数据按需加载（打开才拉），评论与会话改动后回调父组件刷新看板，
 * 保证卡片上的徽标与列表状态一致。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, openEventStream } from "../lib/api";
import type { AgentEvent, ImageAsset, Job, JobComment, JobSession, McpServer } from "../lib/types";
import { cn } from "../lib/utils";
import { abbreviateHome, formatShortTime } from "../lib/format";
import { STATE_TONE, stateLabel } from "../lib/job-state";
import { useInlineEdit } from "../lib/use-inline-edit";
import { useNarrow } from "../lib/use-narrow";
import { AssetImage } from "./AssetImage";
import { DirInput } from "./DirInput";
import { Timeline } from "./Timeline";
import { TagInput } from "./TagInput";
import { MarkdownBlock } from "./Markdown";
import { MdEditor } from "./MdEditor";
import { Badge, Button, Field, Input, OverflowMenu, Tabs, Textarea } from "./ui";

type TabKey = "props" | "sessions" | "comments";

/** 时间线一页的事件条数：够铺几屏，又不至于为了首屏把整份日志传下来。 */
const EVENT_PAGE_SIZE = 200;

function formatTime(iso?: string): string {
    return iso ? new Date(iso).toLocaleString() : "";
}

/** 会话下拉的选项文案：窄屏只留「#短 id · 用途」，时间挤不下就算了。 */
function sessionOptionLabel(item: JobSession, narrow: boolean): string {
    const head = `#${item.sessionId.slice(-8)} · ${item.purpose === "branch" ? "分支" : "执行"}`;
    const archived = item.archived ? " · 已归档" : "";
    return narrow ? `${head}${archived}` : `${head} · ${formatShortTime(item.createdAt)}${archived}`;
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
    /** 默认停在会话：跑过的卡片十次有九次是来看历史的，别再让用户先点一次 tab */
    const [tab, setTab] = useState<TabKey>(() => (job.sessionId ? "sessions" : "props"));
    /** 窄屏下底部输入区是否展开：不聚焦时收成一行，把高度让给历史 */
    const [composerFocus, setComposerFocus] = useState(false);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const narrow = useNarrow();
    const [comments, setComments] = useState<JobComment[]>([]);
    const [sessions, setSessions] = useState<JobSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(job.sessionId ?? null);
    const [events, setEvents] = useState<AgentEvent[]>([]);
    /** 更早的事件还有没有、是不是正在拉：时间线首屏只取最后一页，上翻再补 */
    const [older, setOlder] = useState({ hasMore: false, loading: false });
    /** 上翻插入历史后要还原滚动位置：记录插入前的 scrollHeight / scrollTop */
    const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
    const [commentDraft, setCommentDraft] = useState("");
    /** 正在内联编辑的评论 id 与草稿；null 表示没有在编辑 */
    const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);
    /** 工作目录显示值：home 前缀缩成 ~，与看板里的目录列同一口径 */
    const workspaceDisplay = abbreviateHome(job.input.workspace, home);
    const titleText = job.input.title || job.input.prompt;
    const [inputDraft, setInputDraft] = useState("");
    const [pending, setPending] = useState({ request: 0, turn: 0 });
    /** 正在发生的回合：正文增量与"是否在思考"（回合收尾即清空，交给持久化消息） */
    const [live, setLive] = useState<{ text: string; thinking: boolean }>({ text: "", thinking: false });
    /** 是否贴底：用户往上翻看历史时暂停自动滚动，翻回底部自动恢复 */
    const stickToBottom = useRef(true);
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

    // 切换卡片时收起评论编辑；标题/目录/描述由 useInlineEdit 按 job.id 自行复位
    useEffect(() => {
        setEditingComment(null);
    }, [job.id]);

    // 时间线：先拉历史，再从最后一条 seq 接 SSE
    useEffect(() => {
        if (!activeSessionId) {
            setEvents([]);
            return;
        }
        let cancelled = false;
        let stream: { close(): void } | null = null;
        setOlder({ hasMore: false, loading: false });
        scrollAnchor.current = null;

        void (async () => {
            // 首屏只要最后一页：长会话整份日志动辄上 MB，浏览器根本用不到全部
            const history = await api
                .listEvents(job.id, activeSessionId, 0, { limit: EVENT_PAGE_SIZE })
                .catch(() => []);
            if (cancelled) return;
            setEvents(history);
            setOlder({ hasMore: history.length >= EVENT_PAGE_SIZE, loading: false });
            // 打开或切换会话默认停在最新位置
            stickToBottom.current = true;
            const since = history.length > 0 ? history[history.length - 1].seq : 0;
            stream = openEventStream(
                `/api/jobs/${job.id}/live?sessionId=${encodeURIComponent(activeSessionId)}`,
                since,
                {
                    onMessage: (data, seq) => {
                        try {
                            const parsed = JSON.parse(data) as AgentEvent;
                            // 服务端省了 seq（在 id: 行）与 sessionId（在 URL 里），这里补回来
                            setEvents(current => [...current, { ...parsed, seq, sessionId: activeSessionId }]);
                        } catch {
                            // 半帧或未知格式：丢掉一帧即可，不必打断整条时间线
                        }
                    },
                    onReset: () => {
                        setEvents([]);
                        setLive({ text: "", thinking: false });
                    },
                    onLive: frame => {
                        if (frame.t === "text") {
                            // 正文开始 = 这轮思考结束，标记同步收掉
                            setLive(current => ({ text: current.text + frame.d, thinking: false }));
                        } else if (frame.t === "think") {
                            setLive(current => ({ ...current, thinking: frame.on }));
                        } else {
                            setLive({ text: "", thinking: false });
                        }
                    },
                },
            );
        })();

        return () => {
            cancelled = true;
            stream?.close();
        };
    }, [job.id, activeSessionId]);

    useEffect(() => {
        const node = timelineRef.current;
        if (!node) return;
        const onScroll = (): void => {
            stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            // 滚到顶部就是"要看更早的"：正在拉或已经拉到头时不重复请求
            if (node.scrollTop < 64) void loadOlder();
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        return () => node.removeEventListener("scroll", onScroll);
    }, [tab, activeSessionId, events, older]);

    /** 上翻一页：插入到已有事件之前，并把滚动位置钉在原处，视觉上不跳动。 */
    async function loadOlder(): Promise<void> {
        const oldest = events[0];
        if (!activeSessionId || !oldest || older.loading || !older.hasMore) return;
        setOlder(current => ({ ...current, loading: true }));
        const node = timelineRef.current;
        scrollAnchor.current = node ? { height: node.scrollHeight, top: node.scrollTop } : null;

        const page = await api
            .listEvents(job.id, activeSessionId, 0, { limit: EVENT_PAGE_SIZE, before: oldest.seq })
            .catch(() => null);
        if (!page) {
            scrollAnchor.current = null;
            setOlder(current => ({ ...current, loading: false }));
            return;
        }
        // 少于一页说明已经到文件头，别让滚顶反复触发同一个请求
        setOlder({ hasMore: page.length >= EVENT_PAGE_SIZE, loading: false });
        if (page.length > 0) setEvents(current => [...page, ...current]);
    }

    // 上翻插入后还原滚动位置：插在前面会让内容整体下移，不补偿就会跳到别处
    useEffect(() => {
        const anchor = scrollAnchor.current;
        if (!anchor) return;
        scrollAnchor.current = null;
        const node = timelineRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight - anchor.height + anchor.top;
    }, [events]);

    // 新消息与流式增量都跟着贴底，否则看不到正在生成的最后几行
    useEffect(() => {
        const node = timelineRef.current;
        if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
    }, [events, live.text, live.thinking]);

    // 点进「会话」页时容器才挂载：此时 events 没变，需要单独拉到底
    useEffect(() => {
        if (tab !== "sessions") return;
        stickToBottom.current = true;
        const raf = requestAnimationFrame(() => {
            const node = timelineRef.current;
            if (node) node.scrollTop = node.scrollHeight;
        });
        return () => cancelAnimationFrame(raf);
    }, [tab, activeSessionId]);

    /** 当前查看的会话是否已归档：归档态不能发消息，只能在卡片里取消归档。 */
    const activeSessionArchived = sessions.find(item => item.sessionId === activeSessionId)?.archived === true;

    const patch = async (body: Record<string, unknown>) => {
        setError(null);
        try {
            await api.patchJob(job.id, body);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    // 三处就地编辑共用同一套规则（Esc 放弃 / Cmd·Ctrl+Enter 提交 / 失焦提交），
    // resetKey 用 job.id：切卡片时即使新旧值恰好相同也要退出编辑
    const titleEdit = useInlineEdit(titleText, next => patch({ title: next }), {
        resetKey: job.id,
        commitOnEnter: true,
    });
    // 工作目录的 Enter 由 DirInput 自己处理（要区分补全态与编辑态），这里不开 commitOnEnter
    const workspaceEdit = useInlineEdit(workspaceDisplay, next => patch({ workspace: next }), { resetKey: job.id });
    const promptEdit = useInlineEdit(job.input.prompt, next => patch({ prompt: next }), { resetKey: job.id });

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

    const start = async () => {
        setError(null);
        try {
            await api.startJob(job.id);
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
            // 归档会话发送时服务端会自动取消归档：把「已归档」标记刷掉
            if (result.unarchived) await refreshSessions();
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

    /** 归档执行会话：历史仍保留，只是从默认列表隐藏。 */
    const archiveSession = async () => {
        if (!activeSessionId) return;
        if (!window.confirm("归档这个执行会话？会话会从列表隐藏，历史仍保留。")) return;
        try {
            await api.archiveSession(activeSessionId);
            // 归档后仍留在列表里（标「已归档」），否则取消归档的入口就没了
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    const unarchiveSession = async () => {
        if (!activeSessionId) return;
        try {
            await api.unarchiveSession(activeSessionId);
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    const isActive = job.state === "running" || job.state === "leased";
    /** 窄屏且没在输入：输入区只留一行，历史区多出两三行可见高度 */
    const composerExpanded = !narrow || composerFocus || attachments.length > 0;

    // 桌面铺成一行按钮，窄屏塞进「⋯」菜单：两处共用同一批动作，免得两套状态机各自演进
    const actionNodes = (
        <>
            {job.state === "queued" && job.input.autoStart !== true && (
                <Button variant="primary" onClick={() => void start()}>
                    开始
                </Button>
            )}
            {!isActive &&
                (job.input.archivedAt ? (
                    <Button
                        title="卡片回到看板（默认列表仍隐藏归档卡片，需要「含归档」才看得到）"
                        onClick={async () => {
                            try {
                                await api.unarchiveJob(job.id);
                                await onChanged();
                            } catch (cause) {
                                setError(cause instanceof ApiError ? cause.message : String(cause));
                            }
                        }}
                    >
                        取消归档
                    </Button>
                ) : (
                    <Button
                        title="卡片从看板隐藏，运行过的会话也一并归档"
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
                ))}
            {!isActive && (
                <Button
                    variant="danger"
                    onClick={async () => {
                        if (!window.confirm("删除这张卡片？评论、执行记录和它名下的会话都会被永久删除，不可恢复。")) return;
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
        </>
    );

    /** 标题：只读是按钮、点击原地变输入框，两个头部布局共用 */
    const titleNode = titleEdit.editing ? (
        <Input
            autoFocus
            value={titleEdit.draft}
            onChange={event => titleEdit.setDraft(event.target.value)}
            {...titleEdit.editorProps}
            // flex-1 让输入框和只读文字占据同一份宽度，否则会把右侧的关闭按钮挤走
            className="min-w-0 flex-1 font-medium"
        />
    ) : (
        <button
            type="button"
            title={titleText}
            onClick={titleEdit.begin}
            // 盒模型与编辑态的 <Input> 完全一致（含移动端 16px 字号断点）：
            // 切换只换边框颜色，不改变尺寸，下面一行不会跟着上下跳
            className="min-w-0 flex-1 cursor-text truncate rounded-md border border-transparent px-2.5 py-1.5 text-left text-base font-medium sm:text-sm hover:border-border hover:bg-col"
        >
            {titleText}
        </button>
    );

    return (
        <div
            className="flex h-full flex-col"
            onKeyDown={event => {
                if (event.key !== "Escape") return;
                // 编辑态（描述 / 工作目录 / 评论）的 Esc 已在自己的容器里处理并停掉冒泡；
                // 走到这里说明焦点在普通输入框里——先失焦退出，别让 window 那层 Esc 直接关掉卡片
                const target = event.target as HTMLElement | null;
                const isField = target?.tagName === "INPUT"
                    || target?.tagName === "TEXTAREA"
                    || target?.isContentEditable === true;
                if (!isField) return;
                target!.blur();
                event.stopPropagation();
            }}
        >
            {/* 窄屏：一行完事——状态、标题、⋯、关闭。卡片铺满整屏，纵向空间全给会话历史 */}
            <header className="flex flex-col gap-1 border-b border-border px-2 py-1.5 md:hidden">
                <div className="flex items-center gap-1">
                    <span className="shrink-0">
                        <Badge tone={STATE_TONE[job.state]}>{stateLabel(job)}</Badge>
                    </span>
                    {titleNode}
                    <OverflowMenu>
                        {actionNodes}
                        <div className="mt-0.5 border-t border-border px-2 py-1 text-xs text-muted">
                            #{job.id.slice(-8)} · {formatTime(job.createdAt)}
                        </div>
                    </OverflowMenu>
                    <Button variant="ghost" onClick={onClose} aria-label="关闭">
                        ×
                    </Button>
                </div>
                {(job.error || error) && <p className="text-xs text-bad">{job.error ?? error}</p>}
            </header>

            {/* 桌面：标题 / 元信息 / 动作三行，宽度够用不必收 */}
            <header className="hidden flex-col gap-2 border-b border-border p-3 md:flex">
                <div className="flex items-start gap-2">
                    {titleNode}
                    <Button variant="ghost" onClick={onClose} aria-label="关闭">
                        ×
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={STATE_TONE[job.state]}>{stateLabel(job)}</Badge>
                    <span className="font-mono">{job.id.slice(-8)}</span>
                    <span>{formatTime(job.createdAt)}</span>
                    {job.error && <span className="text-bad">{job.error}</span>}
                </div>
                <div className="flex flex-wrap gap-2">{actionNodes}</div>
                {error && <p className="text-xs text-bad">{error}</p>}
            </header>

            <div className="px-2 pt-1.5 md:px-3 md:pt-2">
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2 md:p-3">
                {tab === "props" && (
                    <div className="stable-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
                        {/* 上下结构：长内容（描述、MCP、结果）能用满面板宽度 */}
                        {/* 平时是普通文字，点一下才变成输入框：目录很少改，摊个输入框在那儿反而抢注意力 */}
                        <Field label="工作目录（只影响新会话）">
                            {workspaceEdit.editing ? (
                                <div {...workspaceEdit.editorProps}>
                                    <DirInput
                                        value={workspaceEdit.draft}
                                        placeholder={workspaceDisplay}
                                        onChange={workspaceEdit.setDraft}
                                        onSubmit={value => workspaceEdit.commitWith(value)}
                                        autoFocus
                                    />
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    title={workspaceDisplay}
                                    onClick={workspaceEdit.begin}
                                    // 与 DirInput 里的 <input> 同盒模型：切换时只换边框，不产生位移
                                    className="w-full cursor-text truncate rounded-md border border-transparent px-2.5 py-1.5 text-left text-base text-fg sm:text-sm hover:border-border hover:bg-col"
                                >
                                    {workspaceDisplay}
                                </button>
                            )}
                        </Field>

                        <Field label="任务描述">
                            {promptEdit.editing ? (
                                <div className="flex flex-col gap-1.5" {...promptEdit.editorProps}>
                                    <MdEditor value={promptEdit.draft} onChange={promptEdit.setDraft} rows={3} autoFocus />
                                    <div className="flex items-center gap-1.5">
                                        {/* 按钮抢焦点会让编辑器先失焦提交，mousedown 拦一下 */}
                                        <Button
                                            variant="primary"
                                            onMouseDown={event => event.preventDefault()}
                                            onClick={promptEdit.commit}
                                        >
                                            保存
                                        </Button>
                                        <Button onMouseDown={event => event.preventDefault()} onClick={promptEdit.cancel}>
                                            取消
                                        </Button>
                                        <span className="text-xs text-muted">⌘/Ctrl+Enter 保存 · Esc 取消</span>
                                    </div>
                                </div>
                            ) : (
                                /* 点正文即可进入编辑；链接与复制按钮照旧生效 */
                                <div
                                    className="cursor-text"
                                    onClick={event => {
                                        if ((event.target as HTMLElement).closest("a, button")) return;
                                        promptEdit.begin();
                                    }}
                                >
                                    {/* min-h 与 MdEditor 的 min-h-[96px] 对齐：进编辑态时高度不变，下面不跳 */}
                                    <MarkdownBlock content={job.input.prompt} className="min-h-[96px]" />
                                </div>
                            )}
                        </Field>

                        <Field label="标签">
                            <TagInput
                                value={job.input.labels ?? []}
                                onChange={next => void patch({ labels: next })}
                                placeholder="空格或回车添加"
                            />
                        </Field>

                        <Field label={job.sessionId ? "选中的 MCP（下个回合生效）" : "允许的 MCP"}>
                            <div className="flex flex-wrap gap-1.5">
                                {servers.length === 0 && <span className="text-xs text-muted">（没有可选的 MCP）</span>}
                                {servers.map(server => {
                                    // 有执行会话时以会话选中集为准；未初始化（老会话）或还没跑过都等于全选
                                    // 未初始化时与后端同口径：默认只选非 lazy 的服务
                                    const fallback = servers.filter(item => !item.lazy).map(item => item.name);
                                    const current = mcpSelection !== null && selectionInitialized
                                        ? mcpSelection
                                        : (job.input.mcpServers ?? fallback);
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
                    <div className="flex min-h-0 flex-1 flex-col gap-1.5 md:gap-2">
                        <div className="flex shrink-0 items-center gap-1.5">
                            {sessions.length === 0 ? (
                                <span className="flex-1 text-xs text-muted">还没有执行会话</span>
                            ) : (
                                <select
                                    value={activeSessionId ?? ""}
                                    onChange={event => setActiveSessionId(event.target.value)}
                                    className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                                >
                                    {sessions.map(item => (
                                        <option key={item.sessionId} value={item.sessionId}>
                                            {sessionOptionLabel(item, narrow)}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {/* 「+ 新会话」最常用，桌面直接摆出来；窄屏连它一起收进「⋯」，下拉才腾得出宽度 */}
                            <Button className="hidden md:inline-flex" onClick={() => void openBranch()}>
                                + 新会话
                            </Button>
                            <OverflowMenu>
                                <Button className="md:hidden" onClick={() => void openBranch()}>
                                    + 新会话
                                </Button>
                                {activeSessionId && (
                                    <Button
                                        variant="danger"
                                        disabled={activeSessionArchived}
                                        onClick={() => void archiveSession()}
                                    >
                                        归档会话
                                    </Button>
                                )}
                                {activeSessionArchived && (
                                    <Button onClick={() => void unarchiveSession()}>取消归档</Button>
                                )}
                            </OverflowMenu>
                        </div>
                        <div ref={timelineRef} className="stable-scroll flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                            <Timeline events={events} live={live} />
                        </div>
                        {activeSessionId && (
                            <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-2">
                                <div className={cn("flex gap-1.5", composerExpanded ? "flex-col" : "items-end")}>
                                    <Textarea
                                        ref={composerRef}
                                        rows={composerExpanded ? 3 : 1}
                                        // 收起态压成一行：标签页里的历史能多露出两三行；一行的高度没什么可拖的
                                        className={composerExpanded ? undefined : "min-h-0 resize-none py-1.5"}
                                        value={inputDraft}
                                        placeholder="你的创意灵感（可直接粘贴图片）"
                                        onFocus={() => setComposerFocus(true)}
                                        onBlur={() => setComposerFocus(false)}
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
                                    {/* 收起态在输入框旁留一个发送键：发一句话犯不上先展开整排按钮 */}
                                    {!composerExpanded && (
                                        <Button
                                            variant="primary"
                                            className="shrink-0"
                                            disabled={activeSessionArchived}
                                            onMouseDown={event => event.preventDefault()}
                                            onClick={() => void sendInput("request")}
                                        >
                                            发送
                                        </Button>
                                    )}
                                </div>
                                {/* 展开态的一排按钮：点按时别让输入框失焦，否则这一排刚点上去就自己收起来了 */}
                                {composerExpanded && (
                                    <div onMouseDown={event => event.preventDefault()} className="flex flex-col gap-2">
                                        {attachments.length > 0 && (
                                            <div className="flex flex-wrap gap-2">
                                                {attachments.map(asset => (
                                                    <div key={asset.id} className="relative">
                                                        <AssetImage
                                                            id={asset.id}
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
                                        {activeSessionArchived && (
                                            <Button
                                                onClick={() => void unarchiveSession()}
                                            >
                                                取消归档
                                            </Button>
                                        )}
                                        <Button disabled={activeSessionArchived} onClick={() => void sendInput("turn")}>
                                            排队
                                        </Button>
                                        <Button
                                            variant="primary"
                                            disabled={activeSessionArchived}
                                            onClick={() => void sendInput("request")}
                                        >
                                            尽快处理
                                        </Button>
                                    </div>
                                    </div>
                                )}
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
                                    /* Esc 先退出编辑（放弃改动），再按一次才轮到关闭卡片 */
                                    <div
                                        className="flex flex-col gap-1"
                                        onKeyDown={event => {
                                            if (event.key !== "Escape") return;
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setEditingComment(null);
                                        }}
                                    >
                                        <MdEditor
                                            value={editingComment.body}
                                            onChange={body => setEditingComment({ id: comment.id, body })}
                                            rows={4}
                                            autoFocus
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
                                    </div>
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
