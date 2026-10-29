/**
 * HTTP 前端：把 SessionHost 暴露成可编程接口（REST + SSE）。
 *
 * 与 TUI 并列：不 import tui/，只依赖 host 契约与持久化事件的 seq 游标。
 * 事件流推的是持久化事实源（带唯一 seq），瞬态的逐 token 片段不在本接口范围内。
 */

import { timingSafeEqual } from "node:crypto";
import { describeClaimFailure } from "../control/channel.js";
import type { AgentEvent } from "../events/agent-events.js";
import {
    SessionArchivedError,
    SessionBusyError,
    SessionNotFoundError,
    type SessionHost,
} from "../host/session-host-types.js";

/** 默认心跳间隔：远小于任何中间层空闲超时，避免长连接被静默掐断。 */
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * 空闲超时关闭：SSE 需要无限期驻留，Bun 的 0 表示禁用。
 * 代价是 REST 路由同样失去空闲超时——本服务只绑回环、请求体有上限，可以接受。
 */
const IDLE_TIMEOUT_SECONDS = 0;
/** 单个请求体上限：任务文本与图片引用都不该很大，超过多半是误用。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
    host: SessionHost;
    /** 监听端口；0 表示由系统分配（测试用）。 */
    port: number;
    /** 监听地址，默认只绑本机回环。 */
    bind?: string;
    /** 访问令牌：请求需带 `Authorization: Bearer <token>` 或 `?token=`。 */
    token: string;
    heartbeatMs?: number;
}

export interface HttpServerHandle {
    readonly url: string;
    readonly port: number;
    stop(): Promise<void>;
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

function fail(message: string, status: number): Response {
    return json({ error: message }, status);
}

/** 定长比较：避免用 `===` 逐字节短路泄露令牌前缀。 */
function safeEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** SSE 用 query 传令牌（EventSource 不能自定义 header），其余走 Bearer。 */
function isAuthorized(req: Request, url: URL, token: string): boolean {
    const header = req.headers.get("authorization");
    if (header?.startsWith("Bearer ")) return safeEqual(header.slice("Bearer ".length).trim(), token);
    return safeEqual(url.searchParams.get("token") ?? "", token);
}

/** 读 JSON body；非法 JSON 返回 undefined，由调用方给 400。 */
async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed = await req.json();
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 宿主可判别错误 → HTTP 状态码。
 * 按类型分流而不是匹配文案：文案属于展示层，改词不该影响协议行为。
 */
function mapHostError(error: unknown): Response | undefined {
    if (error instanceof SessionNotFoundError) return fail("会话不存在", 404);
    if (error instanceof SessionArchivedError) return fail("会话已归档，请先取消归档", 409);
    if (error instanceof SessionBusyError) return fail("会话正在执行中", 409);
    return undefined;
}

/**
 * 打开一条事件流：先回放 `since` 之后的持久化事件，再推新增的。
 *
 * 顺序必须是「先订阅、后回放」：回放期间到达的事件先入缓冲（含重置信号），
 * 回放结束后按 seq 去重补推，这样既不漏（订阅早于读盘）也不重（seq 单调过滤）。
 */
function eventStream(
    host: SessionHost,
    sessionId: string,
    since: number,
    heartbeatMs: number,
    signal: AbortSignal,
): Response {
    const encoder = new TextEncoder();
    let dispose = (): void => {};

    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            let lastSeq = since;
            let replaying = true;
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            const buffered: Array<AgentEvent | null> = [];

            const write = (text: string): boolean => {
                if (closed) return false;
                try {
                    controller.enqueue(encoder.encode(text));
                    return true;
                } catch {
                    // 客户端已断开：中途层静默断连不会触发 cancel，这里兜住资源清理
                    return false;
                }
            };
            const send = (event: AgentEvent | null): void => {
                if (event === null) {
                    // 时间轴重置：id 必须归零，否则客户端会带着失效的 Last-Event-ID 重连且永久静默
                    lastSeq = 0;
                    if (!write("id: 0\nevent: reset\ndata: {}\n\n")) dispose();
                    return;
                }
                if (event.seq <= lastSeq) return;
                lastSeq = event.seq;
                if (!write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) dispose();
            };

            const unsubscribe = host.subscribeEvents((changedSessionId, event) => {
                if (changedSessionId !== sessionId) return;
                if (replaying) buffered.push(event);
                else send(event);
            });

            const finish = (): void => {
                if (closed) return;
                closed = true;
                unsubscribe();
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = undefined;
                try {
                    controller.close();
                } catch {
                    // 已关闭
                }
            };
            dispose = finish;
            signal.addEventListener("abort", finish, { once: true });

            try {
                for (const event of await host.readSessionEventsSince(sessionId, since)) {
                    if (closed) break;
                    send(event);
                }
            } catch (error) {
                // 注释帧只放固定文案：错误文本可能含换行，会破坏帧结构
                console.error(`[serve] 会话 ${sessionId} 事件回放失败:`, error);
                write(": 回放失败\n\n");
            }
            replaying = false;
            for (const event of buffered) {
                if (closed) break;
                send(event);
            }
            buffered.length = 0;

            // 回放期间已断开就别再建定时器：否则 interval 无人清理，会永久空转
            if (closed) return;
            heartbeat = setInterval(() => {
                if (!write(": ping\n\n")) dispose();
            }, heartbeatMs);
        },
        cancel() {
            dispose();
        },
    });

    return new Response(body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        },
    });
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
    const { host, port, bind = "127.0.0.1", token, heartbeatMs = DEFAULT_HEARTBEAT_MS } = options;

    const server = Bun.serve({
        port,
        hostname: bind,
        idleTimeout: IDLE_TIMEOUT_SECONDS,
        maxRequestBodySize: MAX_BODY_BYTES,
        async fetch(req) {
            const url = new URL(req.url);
            if (!isAuthorized(req, url, token)) return fail("未授权：缺少或错误的访问令牌", 401);

            const segments = url.pathname.split("/").filter(Boolean);
            if (segments.length === 0) {
                return json({
                    name: "zbot serve",
                    endpoints: [
                        "GET  /healthz",
                        "GET  /sessions",
                        "POST /sessions {cwd?, title?}",
                        "GET  /sessions/:id",
                        "GET  /sessions/:id/events?since=<seq>（SSE，format=json 一次性拉取）",
                        "POST /sessions/:id/messages {text, wait?}",
                        "POST /sessions/:id/cancel",
                    ],
                });
            }

            if (segments[0] === "healthz") {
                if (req.method !== "GET") return fail("不支持的方法", 405);
                return json({ ok: true, pid: process.pid, sessions: host.listActiveSessionIds().length });
            }

            if (segments[0] !== "sessions") return fail("未知路径", 404);

            try {
                if (segments.length === 1) {
                    if (req.method === "GET") return json(await host.listSessions());
                    if (req.method === "POST") {
                        const body = (await readJson(req)) ?? {};
                        const { sessionId } = await host.createSession(
                            typeof body.cwd === "string" ? body.cwd : undefined,
                        );
                        if (typeof body.title === "string" && body.title.trim()) {
                            await host.renameSession(sessionId, body.title);
                        }
                        // 认领即成为持有者（bind 控制 socket）：命令行 zbot session send 也能投递。
                        const claim = await host.claimSession(sessionId);
                        if (!claim.ok) return fail(describeClaimFailure(claim), 409);
                        return json({ sessionId }, 201);
                    }
                    return fail("不支持的方法", 405);
                }

                // Bun 会在进入 handler 前拒绝非法百分号编码，这里不再重复校验
                const sessionId = decodeURIComponent(segments[1]!);
                const action = segments[2];

                if (!action && req.method === "GET") {
                    const summary = (await host.listSessions()).find(item => item.sessionId === sessionId);
                    return summary ? json(summary) : fail("会话不存在", 404);
                }

                if (action === "events" && req.method === "GET") {
                    // 断线重连时 EventSource 会自动带 Last-Event-ID，优先于显式 since
                    const headerId = req.headers.get("last-event-id")?.trim();
                    const querySince = url.searchParams.get("since")?.trim();
                    const raw = headerId || querySince || null;
                    let since = 0;
                    if (raw !== null) {
                        if (!/^\d+$/.test(raw)) return fail("since 必须是非负整数", 400);
                        since = Number.parseInt(raw, 10);
                    }
                    if (url.searchParams.get("format") === "json") {
                        return json(await host.readSessionEventsSince(sessionId, since));
                    }
                    return eventStream(host, sessionId, since, heartbeatMs, req.signal);
                }

                if (action === "messages" && req.method === "POST") {
                    const body = await readJson(req);
                    const text = typeof body?.text === "string" ? body.text.trim() : "";
                    if (!text) return fail("text 必填", 400);
                    if (host.isSessionBusy(sessionId)) return fail("会话正在执行中", 409);

                    // 未持有才认领；被别的实例持有则拒绝，绝不做协商式夺权（那会把会话从对方 TUI 里挤掉）
                    if (!host.isSessionClaimed(sessionId)) {
                        const ownership = await host.probeSession(sessionId);
                        if (ownership.state === "other") {
                            return fail("会话由其他实例持有，请先释放或归档后再投递", 409);
                        }
                        // noNegotiate：即使探测与绑定之间有窗口，也不会协商式夺权
                        const claim = await host.claimSession(sessionId, { noNegotiate: true });
                        if (!claim.ok) {
                            // 用宿主给的说明（含对方 PID），但语义上仍是「被别人持有」
                            return fail(`${describeClaimFailure(claim)}；本接口不做协商式接管`, 409);
                        }
                    }

                    const turn = host.sendMessage(sessionId, text);
                    if (body?.wait !== true) {
                        // 202 只代表已受理：后台失败只落日志
                        turn.catch(error => console.error(`[serve] 会话 ${sessionId} 回合失败:`, error));
                        return json({ accepted: true, sessionId }, 202);
                    }
                    try {
                        const result = await turn;
                        return json({ ok: !result.aborted, aborted: result.aborted === true, sessionId });
                    } catch (error) {
                        // 预检与真正抢锁之间可能有竞态：这里把 busy 收敛成 409，而不是 500
                        const mapped = mapHostError(error);
                        if (mapped) return mapped;
                        throw error;
                    }
                }

                if (action === "cancel" && req.method === "POST") {
                    const cancelled = await host.abortSession(sessionId);
                    return json({ cancelled, sessionId });
                }

                return fail("未知路径", 404);
            } catch (error) {
                const mapped = mapHostError(error);
                if (mapped) return mapped;
                console.error("[serve] 请求处理失败:", error);
                // 只回通用文案：内部错误信息可能带会话 id、路径等实现细节
                return fail("服务端内部错误，详见服务端日志", 500);
            }
        },
    });

    return {
        url: `http://${bind}:${server.port}`,
        port: server.port,
        stop: async () => {
            await server.stop(true);
        },
    };
}
