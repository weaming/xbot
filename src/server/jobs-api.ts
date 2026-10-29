/**
 * Job HTTP 接口：提交、查询、取消，以及两条事件流。
 *
 * 两条流分开是刻意的：
 * - `/jobs/events` 只推状态变迁（轻量），驱动列表徽标与排序；
 * - `/jobs/:id/events` 转发该 Job 绑定会话的执行事件（重），只给当前详情页看。
 * 合成一条会让某个任务的执行细节淹没整个列表。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionHost } from "../host/session-host-types.js";
import type { JobRunner } from "../jobs/runner.js";
import type { JobStore } from "../jobs/store.js";
import {
    isJobState,
    JobConflictError,
    JobNotFoundError,
    type CreateJobRequest,
    type JobInput,
    type JobRecord,
    type JobState,
} from "../jobs/types.js";
import { toolCatalog } from "../tools/tool-catalog.js";
import { fail, json, readJson } from "./respond.js";
import { openSseStream, parseSseCursor, type SseSource } from "./sse.js";

export interface JobsApiContext {
    store: JobStore;
    runner: JobRunner;
    host: SessionHost;
    heartbeatMs: number;
}

const DEFAULT_SOURCE = "http";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** 评论正文上限：超过基本是误贴文件，挡在入口比存进库更省事。 */
const MAX_COMMENT_CHARS = 10_000;

/** 看板列 → 语义动作。拖拽只表达「我要它去哪一列」，具体怎么变由这里决定。 */
type BoardColumn = "todo" | "manual" | "doing" | "done" | "cancelled";

const BOARD_COLUMNS: readonly BoardColumn[] = ["todo", "manual", "doing", "done", "cancelled"];

/** Job 状态流：所有任务的状态变迁，作为列表页数据源。 */
function jobListSource(store: JobStore): SseSource {
    return {
        label: "Job 状态流",
        readSince: async since => store.eventsSince(since).map(event => ({ seq: event.seq, payload: event })),
        subscribe: listener => store.subscribe(event => listener({ seq: event.seq, payload: event })),
    };
}

/** 详情执行流：转发该 Job 绑定会话的事件（重置信号原样透传）。 */
function sessionEventSource(host: SessionHost, sessionId: string, jobId: string): SseSource {
    return {
        label: `任务 ${jobId} 执行流`,
        readSince: async since =>
            (await host.readSessionEventsSince(sessionId, since)).map(event => ({ seq: event.seq, payload: event })),
        subscribe: listener =>
            host.subscribeEvents((changedSessionId, event) => {
                if (changedSessionId !== sessionId) return;
                listener(event === null ? null : { seq: event.seq, payload: event });
            }),
    };
}

function expandHome(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/**
 * 拖拽语义：前端只表达「拖到哪一列」，具体动作由这里决定。
 * 原则：不假装完成（运行中不能拖成 done），不隐式重跑（终态要重跑请新建卡片）。
 */
async function moveJob(ctx: JobsApiContext, job: JobRecord, column: BoardColumn): Promise<Response> {
    const isActive = job.state === "running" || job.state === "leased";

    switch (column) {
        case "todo":
            if (job.state !== "queued") {
                return fail(`任务当前是 ${job.state}，只有排队中的任务能回到待办`, 409);
            }
            // 回到待办 = 打开自动执行，交给调度器领走
            {
                const updated = ctx.store.startJob(job.id);
                ctx.runner.kick();
                return json(updated);
            }

        case "manual":
            if (job.state !== "queued") {
                return fail(`任务当前是 ${job.state}，只有排队中的任务能转成手动`, 409);
            }
            // 手动 = 关掉自动执行，停在「手动」列等人点开始
            return json(ctx.store.updateInput(job.id, { autoStart: false }));

        case "doing":
            if (job.state === "queued") {
                const started = ctx.store.startJob(job.id);
                ctx.runner.kick();
                return json(started);
            }
            // 已经在跑就是幂等
            if (isActive) return json(job);
            return fail(`任务已结束（${job.state}），要重跑请新建卡片`, 409);

        case "done":
            if (job.state === "succeeded") return json(job);
            if (isActive) return fail("任务还在执行，先取消再改状态", 409);
            return fail(`任务已结束（${job.state}），不能直接标成完成`, 409);

        case "cancelled":
            if (job.state === "cancelled") return json(job);
            if (job.state !== "queued" && !isActive) {
                return fail(`任务已结束（${job.state}），无需取消`, 409);
            }
            if (!(await ctx.runner.cancel(job.id))) return fail("取消失败", 409);
            return json(ctx.store.get(job.id));
    }
}

function positiveInt(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 把请求体里允许的卡片属性合并进 input（创建与 PATCH 共用同一套校验）。
 * 校验失败只回错误文案，不抛错——HTTP 层统一映射 400。
 */
function applyInputFields(target: JobInput, body: Record<string, unknown>): { ok: true } | { error: string } {
    if (typeof body.prompt === "string") {
        const next = body.prompt.trim();
        if (!next) return { error: "prompt 不能为空" };
        target.prompt = next.slice(0, 20_000);
    }
    if (typeof body.title === "string") target.title = body.title.trim().slice(0, 200);
    if (typeof body.description === "string") target.description = body.description.slice(0, 20_000);

    if (body.labels !== undefined) {
        if (!Array.isArray(body.labels)) return { error: "labels 必须是字符串数组" };
        target.labels = body.labels
            .filter((item): item is string => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 20);
    }

    if (typeof body.dueAt === "string" && body.dueAt.trim()) {
        const parsed = Date.parse(body.dueAt);
        if (Number.isNaN(parsed)) return { error: "dueAt 不是合法时间" };
        target.dueAt = new Date(parsed).toISOString();
    }

    if (body.meta !== undefined) {
        if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) {
            return { error: "meta 必须是对象" };
        }
        const meta: Record<string, string> = {};
        for (const [key, value] of Object.entries(body.meta as Record<string, unknown>)) {
            if (typeof value === "string") meta[key] = value;
        }
        target.meta = meta;
    }

    if (typeof body.model === "string" && body.model.trim()) target.model = body.model.trim();

    if (body.mcpServers !== undefined) {
        if (!Array.isArray(body.mcpServers)) return { error: "mcpServers 必须是字符串数组" };
        const servers = body.mcpServers
            .filter((item): item is string => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 50);
        // 空数组表示「不用任何 MCP」；undefined 才表示「不限制」，两者语义不同
        target.mcpServers = servers;
    }

    if (typeof body.priority === "number" && Number.isFinite(body.priority)) target.priority = Math.trunc(body.priority);
    const timeoutSec = positiveInt(body.timeoutSec);
    if (timeoutSec) target.timeoutSec = timeoutSec;
    const maxAttempts = positiveInt(body.maxAttempts);
    if (maxAttempts) target.maxAttempts = maxAttempts;
    if (body.freshSession === true) target.freshSession = true;
    if (body.autoStart === true || body.autoStart === false) target.autoStart = body.autoStart;

    return { ok: true };
}

/** 解析并校验创建参数：非法输入在入队前就拒绝，别等执行时才炸。 */
function parseCreateRequest(body: Record<string, unknown>): { input: JobInput; source: string; key?: string } | { error: string } {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return { error: "prompt 必填" };

    const workspaceRaw = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : process.cwd();
    const workspace = path.resolve(expandHome(workspaceRaw));
    if (!isDirectory(workspace)) return { error: `工作目录不存在或不是目录: ${workspace}` };

    const input: JobInput = { prompt, workspace };
    const applied = applyInputFields(input, body);
    if ("error" in applied) return applied;

    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : DEFAULT_SOURCE;
    const key = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : undefined;
    return { input, source, ...(key ? { key } : {}) };
}

/**
 * 处理 `/jobs` 下的所有路由；调用方已确认 segments[0] === "jobs"。
 * 返回 Response，不抛错（内部错误转 500）。
 */
export async function handleJobsRoute(
    ctx: JobsApiContext,
    req: Request,
    url: URL,
    segments: string[],
): Promise<Response> {
    try {
        const action = segments[1];

        // 可勾选的 MCP 来源：给「本任务允许哪些 MCP」提供选项，按 server 聚合工具数
        if (action === "mcp" && segments[2] === "servers" && req.method === "GET") {
            const counts = new Map<string, number>();
            for (const tool of toolCatalog.listRemoteTools()) {
                const name = tool.fromServer ?? "unknown";
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
            return json([...counts].map(([name, toolCount]) => ({ name, toolCount })));
        }

        // 列表状态流：/jobs/events（必须排在 /jobs/:id 之前，否则 "events" 会被当成 id）
        if (action === "events" && req.method === "GET") {
            const cursor = parseSseCursor(req, url);
            if ("error" in cursor) return fail(cursor.error, 400);
            if (url.searchParams.get("format") === "json") return json(ctx.store.eventsSince(cursor.since));
            return openSseStream(jobListSource(ctx.store), cursor.since, ctx.heartbeatMs, req.signal);
        }

        if (!action) {
            if (req.method === "GET") {
                const stateParam = url.searchParams.get("state");
                const states = stateParam ? stateParam.split(",").map(item => item.trim()).filter(Boolean) : [];
                const invalid = states.find(item => !isJobState(item));
                if (invalid) return fail(`state 非法: ${invalid}`, 400);

                const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
                const limit = Number.isFinite(rawLimit) && rawLimit > 0
                    ? Math.min(rawLimit, MAX_LIST_LIMIT)
                    : DEFAULT_LIST_LIMIT;
                // 归档的默认不出现在看板上，需要时带 ?archived=1
                const includeArchived = url.searchParams.get("archived") === "1";
                return json(
                    ctx.store.list({ states: states.length ? (states as never) : undefined, limit, includeArchived }),
                );
            }

            if (req.method === "POST") {
                const body = await readJson(req);
                if (!body) return fail("请求体必须是 JSON 对象", 400);

                const parsed = parseCreateRequest(body);
                if ("error" in parsed) return fail(parsed.error, 400);

                const request: CreateJobRequest = { source: parsed.source, input: parsed.input };
                if (parsed.key) request.idempotencyKey = parsed.key;
                if (typeof body.retriedFrom === "string" && body.retriedFrom.trim()) {
                    request.retriedFrom = body.retriedFrom.trim();
                }

                const outcome = ctx.store.create(request);
                // 新建才唤醒调度；幂等命中说明它已在队列里或已结束
                if (outcome.created) ctx.runner.kick();
                return json(outcome.job, outcome.created ? 201 : 200);
            }

            return fail("不支持的方法", 405);
        }

        const jobId = decodeURIComponent(action);
        const sub = segments[2];

        if (!sub && req.method === "GET") {
            const job = ctx.store.get(jobId);
            return job ? json(job) : fail("任务不存在", 404);
        }

        if (!sub && req.method === "PATCH") {
            const body = await readJson(req);
            if (!body) return fail("请求体必须是 JSON 对象", 400);

            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            if (job.state === "running" || job.state === "leased") {
                return fail("任务正在执行，先取消或等它结束再改属性", 409);
            }

            const merged: JobInput = { ...job.input };
            const applied = applyInputFields(merged, body);
            if ("error" in applied) return fail(applied.error, 400);
            return json(ctx.store.updateInput(jobId, merged));
        }

        if (sub === "start" && req.method === "POST") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            if (job.state !== "queued") {
                return fail(`任务当前是 ${job.state}，只有排队中的任务能手动开始`, 409);
            }
            const started = ctx.store.startJob(jobId);
            ctx.runner.kick();
            return json(started);
        }

        if (sub === "archive" && req.method === "POST") {
            return json(ctx.store.archiveJob(jobId));
        }

        if (sub === "unarchive" && req.method === "POST") {
            return json(ctx.store.unarchiveJob(jobId));
        }

        if (!sub && req.method === "DELETE") {
            ctx.store.deleteJob(jobId);
            return json({ deleted: true, id: jobId });
        }

        if (sub === "move" && req.method === "POST") {
            const body = await readJson(req);
            const column = typeof body?.column === "string" ? body.column : "";
            if (!BOARD_COLUMNS.includes(column as BoardColumn)) {
                return fail(`column 必须是 ${BOARD_COLUMNS.join(" / ")}`, 400);
            }
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            return moveJob(ctx, job, column as BoardColumn);
        }

        if (sub === "comments") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            const commentId = segments[3] ? decodeURIComponent(segments[3]) : undefined;
            if (!commentId && req.method === "GET") return json(ctx.store.listComments(jobId));

            if (!commentId && req.method === "POST") {
                const body = await readJson(req);
                const text = typeof body?.body === "string" ? body.body.trim() : "";
                if (!text) return fail("body 必填", 400);
                if (text.length > MAX_COMMENT_CHARS) return fail(`评论过长（上限 ${MAX_COMMENT_CHARS} 字）`, 400);
                const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
                return json(ctx.store.addComment({ jobId, body: text, author: "user", sessionId }), 201);
            }

            if (commentId && req.method === "PATCH") {
                const body = await readJson(req);
                const text = typeof body?.body === "string" ? body.body.trim() : "";
                if (!text) return fail("body 必填", 400);
                return json(ctx.store.updateComment(jobId, commentId, text));
            }

            if (commentId && req.method === "DELETE") {
                return json(ctx.store.deleteComment(jobId, commentId));
            }

            return fail("不支持的方法", 405);
        }

        if (sub === "sessions") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            if (req.method === "GET") return json(ctx.store.listSessions(jobId));

            if (req.method === "POST") {
                // 手动开一个新会话：同一张卡片下换思路继续，不新建卡片
                const body = await readJson(req);
                const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

                const created = await ctx.host.createSession(job.input.workspace);
                const claim = await ctx.host.claimSession(created.sessionId, { noNegotiate: true });
                if (!claim.ok) return fail("会话认领失败，请稍后重试", 409);

                const title = prompt || job.input.title || job.input.prompt;
                await ctx.host.renameSession(created.sessionId, title.slice(0, 40));
                ctx.store.addSession(jobId, created.sessionId, "branch", 0);

                if (prompt) {
                    void ctx.host
                        .sendMessage(created.sessionId, prompt)
                        .catch(error => console.error("[serve] 分支会话回合失败:", error));
                }
                return json({ sessionId: created.sessionId }, 201);
            }

            return fail("不支持的方法", 405);
        }

        if (sub === "cancel" && req.method === "POST") {
            const cancelled = await ctx.runner.cancel(jobId);
            if (!cancelled) return fail("任务不存在或已结束", 409);
            return json({ cancelled: true, job: ctx.store.get(jobId) });
        }

        if (sub === "events" && req.method === "GET") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            // 卡片可以有多个执行会话：默认看最近一个，也可用 sessionId 指定
            const requested = url.searchParams.get("sessionId")?.trim();
            const sessionId = requested || job.sessionId;
            if (!sessionId) return fail("任务尚未开始，暂无执行事件", 404);
            if (requested) {
                const owned = ctx.store.listSessions(jobId).some(item => item.sessionId === requested);
                if (!owned) return fail("该会话不属于此任务", 404);
            }

            const cursor = parseSseCursor(req, url);
            if ("error" in cursor) return fail(cursor.error, 400);
            if (url.searchParams.get("format") === "json") {
                return json(await ctx.host.readSessionEventsSince(sessionId, cursor.since));
            }
            return openSseStream(
                sessionEventSource(ctx.host, sessionId, jobId),
                cursor.since,
                ctx.heartbeatMs,
                req.signal,
            );
        }

        return fail("未知路径", 404);
    } catch (error) {
        if (error instanceof JobNotFoundError) return fail("任务不存在", 404);
        if (error instanceof JobConflictError) return fail(error.message, 409);
        console.error("[serve] Job 请求处理失败:", error);
        return fail("服务端内部错误，详见服务端日志", 500);
    }
}
