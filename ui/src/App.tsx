import { useCallback, useEffect, useRef, useState } from "react";
import { Board, COLUMNS } from "./components/Board";
import { CardDetail } from "./components/CardDetail";
import { CreateDialog } from "./components/CreateDialog";
import { Button, Field, Input } from "./components/ui";
import { api, ApiError, getToken, saveToken, sseUrl } from "./lib/api";
import type { BoardColumnKey, Job, McpServer } from "./lib/types";

export default function App() {
    const [token, setToken] = useState(getToken());
    const [jobs, setJobs] = useState<Job[]>([]);
    const [servers, setServers] = useState<McpServer[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    /** 键盘焦点：箭头/hjkl 移动，Enter 打开详情；与 selectedId（详情已打开）分开 */
    const [focusId, setFocusId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    // 主动换令牌时不清空既有 token：登录页可以取消返回，不至于把当前会话踢掉
    const [changingToken, setChangingToken] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [defaultCwd, setDefaultCwd] = useState("");
    const [home, setHome] = useState("");
    const [connected, setConnected] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);
    const [tokenDraft, setTokenDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const authorized = token.length > 0 && authError === null;
    const showAuth = !authorized || changingToken;

    const refresh = useCallback(async () => {
        try {
            const list = await api.listJobs(showArchived);
            setJobs(list);
            setError(null);
            return list;
        } catch (cause) {
            if (cause instanceof ApiError && cause.status === 401) {
                setAuthError("令牌无效，请重新输入");
            } else {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
            return [];
        }
    }, [showArchived]);

    // 首屏：列表 + MCP 选项 + 全局状态流
    useEffect(() => {
        if (!token) return;
        let source: EventSource | null = null;
        let cancelled = false;

        void (async () => {
            await refresh();
            if (cancelled) return;
            const health = await api.getHealth().catch(() => null);
            setDefaultCwd(health?.cwd ?? "");
            setHome(health?.home ?? "");
            setServers(await api.listMcpServers().catch(() => []));

            const history = await api.listJobEvents(0).catch(() => []);
            if (cancelled) return;
            const since = history.length > 0 ? history[history.length - 1].seq : 0;

            source = new EventSource(sseUrl("/api/jobs/events", since));
            source.onopen = () => setConnected(true);
            source.onerror = () => setConnected(false);
            source.onmessage = () => {
                // 状态流只用来触发刷新：卡片数少，重拉全量比增量合并更不容易出错
                if (refreshTimer.current) return;
                refreshTimer.current = setTimeout(() => {
                    refreshTimer.current = null;
                    void refresh();
                }, 200);
            };
        })();

        return () => {
            cancelled = true;
            source?.close();
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
        };
    }, [token, refresh]);

    /** 拖完先把本地状态改掉，真实结果由随后的 refresh 覆盖 */
    const OPTIMISTIC_STATE: Record<BoardColumnKey, Job["state"] | undefined> = {
        todo: "queued",
        manual: "queued",
        // doing 不改本地状态：后端对 queued 只写 autoStart，state 仍是 queued，
        // 乐观改成 running 会被随后的 refresh 弹回去（队列满/同目录忙时尤其明显）
        doing: undefined,
        review: undefined,
        done: "succeeded",
        cancelled: "cancelled",
    };

    const move = async (id: string, column: BoardColumnKey) => {
        const nextState = OPTIMISTIC_STATE[column];
        if (nextState) {
            setJobs(current => current.map(job => (job.id === id ? { ...job, state: nextState } : job)));
        }
        try {
            await api.moveJob(id, column);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        await refresh();
    };

    const selected = jobs.find(job => job.id === selectedId) ?? null;

    // 看板键盘导航：hjkl / 方向键移动焦点，Enter 打开，Esc 退回
    useEffect(() => {
        const NAV: Record<string, "up" | "down" | "left" | "right"> = {
            ArrowUp: "up",
            ArrowDown: "down",
            ArrowLeft: "left",
            ArrowRight: "right",
            k: "up",
            j: "down",
            h: "left",
            l: "right",
        };

        const moveFocus = (dir: "up" | "down" | "left" | "right") => {
            const groups = COLUMNS.map(column => ({
                key: column.key,
                jobs: jobs.filter(column.match),
            }));
            const gi = groups.findIndex(group => group.jobs.some(job => job.id === focusId));

            if (gi === -1) {
                const first = groups.findIndex(group => group.jobs.length > 0);
                if (first >= 0) setFocusId(groups[first]!.jobs[0]!.id);
                return;
            }

            const index = groups[gi]!.jobs.findIndex(job => job.id === focusId);
            if (dir === "up" || dir === "down") {
                const next = index + (dir === "down" ? 1 : -1);
                if (next >= 0 && next < groups[gi]!.jobs.length) setFocusId(groups[gi]!.jobs[next]!.id);
                return;
            }

            // 左右跨列：跳过空列，落到目标列里离原位置最近的一张
            const step = dir === "right" ? 1 : -1;
            for (let i = gi + step; i >= 0 && i < groups.length; i += step) {
                if (groups[i]!.jobs.length === 0) continue;
                const pos = Math.min(index, groups[i]!.jobs.length - 1);
                setFocusId(groups[i]!.jobs[pos]!.id);
                return;
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            // 输入类元素里的按键不抢（否则编辑器里没法打 j/k）
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
                return;
            }

            if (event.key === "Escape") {
                if (selectedId) setSelectedId(null);
                else setFocusId(null);
                return;
            }
            if (event.key === "Enter") {
                if (focusId) {
                    event.preventDefault();
                    setSelectedId(focusId);
                }
                return;
            }

            const dir = NAV[event.key] ?? (event.key.length === 1 ? NAV[event.key.toLowerCase()] : undefined);
            if (!dir) return;
            event.preventDefault();
            moveFocus(dir);
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [jobs, focusId, selectedId]);
    const running = jobs.filter(job => job.state === "running").length;
    const queued = jobs.filter(job => job.state === "queued").length;

    if (showAuth) {
        return (
            <div className="mx-auto mt-[10dvh] w-[min(420px,92vw)] rounded-xl border border-border bg-panel p-5">
                <h1 className="text-base font-semibold">输入访问令牌</h1>
                <p className="mt-1 text-xs text-muted">
                    令牌在 <code className="rounded bg-col px-1">~/.zbot/serve/token</code>；
                    也可以用 <code className="rounded bg-col px-1">/?token=…</code> 打开一次，之后会记住。
                </p>
                <form
                    className="mt-3 flex flex-col gap-2"
                    onSubmit={event => {
                        event.preventDefault();
                        const next = tokenDraft.trim();
                        if (!next) return;
                        saveToken(next);
                        setAuthError(null);
                        setToken(next);
                        setTokenDraft("");
                        setChangingToken(false);
                    }}
                >
                    <Field label="令牌">
                        <Input
                            type="password"
                            value={tokenDraft}
                            autoFocus
                            autoComplete="off"
                            onChange={event => setTokenDraft(event.target.value)}
                        />
                    </Field>
                    <Button variant="primary" type="submit">
                        进入
                    </Button>
                    {authorized && (
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                                setChangingToken(false);
                                setTokenDraft("");
                            }}
                        >
                            取消
                        </Button>
                    )}
                </form>
                {authError && <p className="mt-2 text-xs text-bad">{authError}</p>}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
                <h1 className="text-base font-semibold">zbot 任务</h1>
                <span
                    className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-ok" : "bg-bad"}`}
                    title="事件流连接状态"
                />
                <span className="hidden text-xs text-muted sm:inline">
                    进行中 {running} · 排队 {queued}
                </span>
                {error && <span className="text-xs text-bad">{error}</span>}
                <span className="flex-1" />
                {/* 选中靠颜色区分，不用勾选框：与标签、MCP 那类胶囊保持同一套视觉语言 */}
                <button
                    type="button"
                    onClick={() => setShowArchived(current => !current)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                        showArchived ? "border-accent text-accent" : "border-border text-muted hover:text-fg"
                    }`}
                >
                    含归档
                </button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                    + 新任务
                </Button>
                <Button variant="ghost" onClick={() => setChangingToken(true)}>
                    换令牌
                </Button>
            </header>

            <div className="relative flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                    <Board
                        jobs={jobs}
                        selectedId={selectedId}
                        focusId={focusId}
                        onSelect={id => {
                            setFocusId(id);
                            setSelectedId(id);
                        }}
                        onMove={(id, column) => void move(id, column)}
                    />
                </div>
                {selected && (
                    <aside className="absolute inset-0 z-20 flex w-full flex-col border-l border-border bg-panel md:static md:inset-auto md:w-[520px] md:shrink-0">
                        <CardDetail
                            // 换卡片必须换实例：标题/超时是 defaultValue，复用实例会把上一张卡的值写回去
                            key={selected.id}
                            job={selected}
                            servers={servers}
                            home={home}
                            onChanged={refresh}
                            onClose={() => setSelectedId(null)}
                        />
                    </aside>
                )}
            </div>

            <CreateDialog
                open={creating}
                servers={servers}
                defaultCwd={defaultCwd}
                home={home}
                onClose={() => setCreating(false)}
                onCreated={refresh}
            />
        </div>
    );
}
