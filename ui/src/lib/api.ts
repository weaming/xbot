import type {
    AgentEvent,
    ImageAsset,
    Job,
    JobComment,
    JobSession,
    McpServer,
} from "./types";

const STORAGE_KEY = "zbot-token";

export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

/** 令牌来源：URL 参数（一次性）> localStorage。读 URL 后立刻从地址栏抹掉。 */
export function initToken(): string {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) {
        localStorage.setItem(STORAGE_KEY, fromUrl);
        history.replaceState({}, "", location.pathname);
        return fromUrl;
    }
    return localStorage.getItem(STORAGE_KEY) ?? "";
}

let token = initToken();

export function getToken(): string {
    return token;
}

export function saveToken(next: string): void {
    token = next;
    localStorage.setItem(STORAGE_KEY, next);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** SSE 只能用 query 传令牌（EventSource 不能自定义 header）。 */
export function sseUrl(path: string, since: number): string {
    return `${path}${path.includes("?") ? "&" : "?"}since=${since}&token=${encodeURIComponent(token)}`;
}

export const api = {
    listJobs: (includeArchived = false) =>
        request<Job[]>(`/api/jobs?limit=200${includeArchived ? "&archived=1" : ""}`),
    getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
    createJob: (body: Record<string, unknown>) => request<Job>("/api/jobs", jsonInit("POST", body)),
    patchJob: (id: string, patch: Record<string, unknown>) =>
        request<Job>(`/api/jobs/${id}`, jsonInit("PATCH", patch)),
    moveJob: (id: string, column: string) =>
        request<Job>(`/api/jobs/${id}/move`, jsonInit("POST", { column })),
    startJob: (id: string) => request<Job>(`/api/jobs/${id}/start`, { method: "POST" }),
    cancelJob: (id: string) => request<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
    archiveJob: (id: string) => request<Job>(`/api/jobs/${id}/archive`, { method: "POST" }),
    deleteJob: (id: string) => request<{ deleted: boolean }>(`/api/jobs/${id}`, { method: "DELETE" }),
    /** 会话的 MCP 选中集：只影响下一个回合 */
    getMcpSelection: (id: string) =>
        request<{ servers: string[]; initialized: boolean }>(`/api/jobs/${id}/mcp-selection`),
    setMcpSelection: (id: string, servers: string[]) =>
        request<{ servers: string[] }>(`/api/jobs/${id}/mcp-selection`, jsonInit("POST", { servers })),

    listComments: (id: string) => request<JobComment[]>(`/api/jobs/${id}/comments`),
    addComment: (id: string, body: string, sessionId?: string) =>
        request<JobComment>(`/api/jobs/${id}/comments`, jsonInit("POST", { body, sessionId })),
    updateComment: (id: string, commentId: string, body: string) =>
        request<JobComment>(`/api/jobs/${id}/comments/${commentId}`, jsonInit("PATCH", { body })),
    deleteComment: (id: string, commentId: string) =>
        request<JobComment>(`/api/jobs/${id}/comments/${commentId}`, { method: "DELETE" }),

    listSessions: (id: string) => request<JobSession[]>(`/api/jobs/${id}/sessions`),
    createSession: (id: string, prompt?: string) =>
        request<{ sessionId: string }>(`/api/jobs/${id}/sessions`, jsonInit("POST", { prompt })),

    /** 一次拉取历史事件；增量由 EventSource 接管。 */
    listEvents: (jobId: string, sessionId: string, since: number) =>
        request<AgentEvent[]>(
            `/api/jobs/${jobId}/events?sessionId=${encodeURIComponent(sessionId)}&since=${since}&format=json`,
        ),
    listJobEvents: (since: number) => request<Array<{ seq: number; jobId: string }>>(
        `/api/jobs/events?since=${since}&format=json`,
    ),

    listMcpServers: () => request<McpServer[]>("/api/jobs/mcp/servers"),

    /** 取服务端信息：新建任务时用 cwd 当输入框 placeholder。 */
    getHealth: () =>
        request<{ ok: boolean; pid: number; cwd: string; home: string; sessions: number }>("/api/healthz"),

    /** 随时输入：空闲直接开跑，忙则按模式排队。 */
    sendInput: (sessionId: string, text: string, mode: "request" | "turn", images?: ImageAsset[]) =>
        request<{ started: boolean; queued: boolean; pending: { request: number; turn: number } }>(
            `/api/sessions/${sessionId}/inputs`,
            jsonInit("POST", { text, mode, ...(images?.length ? { images } : {}) }),
        ),
    getPendingInputs: (sessionId: string) =>
        request<{ request: number; turn: number }>(`/api/sessions/${sessionId}/inputs`),

    /** 上传图片：data URL 或纯 base64，落盘后返回引用（发送消息时带上）。 */
    uploadAsset: (data: string, filename: string) =>
        request<{ id: string; path: string; filename: string; mimeType: string; sizeBytes: number }>(
            "/api/assets",
            jsonInit("POST", { data, filename }),
        ),

    /** 目录补全：按输入前缀返回可选的子目录（最多 20 个）。 */
    listDirs: (path: string) => request<string[]>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),
};
