/**
 * Job 领域模型：任务单、状态机与可判别错误。
 *
 * Job 是「要交付什么」，Session 只是它的执行载体：一个 Job 绑定一个 Session，
 * 重试默认复用同一个 Session（失败上下文有价值），要干净上下文时用 freshSession。
 */

import type { UsageInfo } from "../types/chat.js";

/** 终态不可逆：想再跑一次只能新建 Job 并记 retriedFrom。 */
export type JobState =
    | "queued"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "lost"
    | "interfered";

const TERMINAL_STATES: readonly JobState[] = ["succeeded", "failed", "cancelled", "lost", "interfered"];

/** 看板列：卡片放在哪一列由用户拖拽决定，与任务状态无关。 */
export const BOARD_COLUMNS = ["todo", "doing", "done", "cancelled"] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export function isBoardColumn(value: unknown): value is BoardColumn {
    return typeof value === "string" && (BOARD_COLUMNS as readonly string[]).includes(value);
}

/** 全部状态的规范顺序：用于校验外部输入与前端分组。 */
const JOB_STATES: readonly JobState[] = [
    "queued",
    "leased",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "lost",
    "interfered",
];

export function isJobState(value: string): value is JobState {
    return (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: JobState): boolean {
    return TERMINAL_STATES.includes(state);
}

/**
 * 允许的状态迁移。
 * lost 不回到 queued：worker 失联时 turn 可能已经产生副作用，自动重试不安全，
 * 只能由人确认后新建 Job。
 */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
    queued: ["leased", "cancelled", "failed"],
    leased: ["running", "queued", "lost", "cancelled", "failed"],
    running: ["succeeded", "failed", "cancelled", "lost", "interfered"],
    succeeded: [],
    failed: [],
    cancelled: [],
    lost: [],
    interfered: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
    return TRANSITIONS[from].includes(to);
}

export interface JobInput {
    /** 任务文本，必填。 */
    prompt: string;
    /** 执行的工作目录，必须是已存在目录。 */
    workspace: string;
    /** 卡片短标题：缺省取 prompt 前若干字。 */
    title?: string;
    /** 富说明（markdown），与 prompt 分开：prompt 给模型，description 给人看。 */
    description?: string;
    /** 标签，用于看板筛选。 */
    labels?: string[];
    /** 截止时间（ISO8601）。 */
    dueAt?: string;
    /** 自定义属性（键值均为字符串），不参与调度，只做展示与检索。 */
    meta?: Record<string, string>;
    /** 覆盖模型（缺省用宿主当前配置）。 */
    model?: string;
    /** 本任务允许使用的 MCP server 名；缺省表示全部。 */
    mcpServers?: string[];
    /** 越大越先跑；同优先级按创建时间 FIFO。 */
    priority?: number;
    /** 回合超时（秒），超时即取消并判 failed。 */
    timeoutSec?: number;
    /** 重试时是否新建 Session（默认复用，保留失败上下文）。 */
    freshSession?: boolean;
    /** 最大尝试次数（含首次）。 */
    maxAttempts?: number;
    /**
     * 是否已授权调度器执行：新建任务默认 false，用户点「开始」后才置 true。
     * 与看板列无关——卡片放在哪一列不影响它跑不跑。
     */
    autoStart?: boolean;
    /**
     * 卡片所在的看板列：纯粹是用户摆放位置，与任务状态无关。
     * 缺省（老卡片）按状态兜底推导，见 columnOf。
     */
    column?: BoardColumn;
    /** 归档时间：归档后从看板隐藏，但状态与历史都保留。 */
    archivedAt?: string;
}

/** 卡片的一次执行会话：每次 attempt 一个，也可手动开分支。 */
export interface JobSessionRecord {
    jobId: string;
    sessionId: string;
    /** run = 自动执行产生；branch = 人工新开。 */
    purpose: "run" | "branch";
    /** 第几次执行（branch 为 0）。 */
    attempt: number;
    createdAt: string;
}

export type CommentAuthor = "user" | "agent";

/** 卡片评论：人机同源，软删除保留历史。 */
export interface JobComment {
    id: string;
    jobId: string;
    /** 评论来自哪次执行会话（人对卡片评论时可缺省）。 */
    sessionId?: string;
    author: CommentAuthor;
    authorName?: string;
    body: string;
    createdAt: string;
    editedAt?: string;
    deletedAt?: string;
}

export interface JobResult {
    /** 回合最终输出文本。 */
    text: string;
    /** 回合是被取消的（不等于失败）。 */
    aborted: boolean;
    /** 结束时会话事件的最后 seq，客户端据此知道详情流读到哪。 */
    eventSeq: number;
    usage?: UsageInfo;
}

export interface JobRecord {
    id: string;
    /** 来源标识：区分不同调用方，与 idempotencyKey 组成唯一键。 */
    source: string;
    idempotencyKey?: string;
    input: JobInput;
    state: JobState;
    priority: number;
    sessionId?: string;
    attempts: number;
    maxAttempts: number;
    /** 租约持有者（进程实例 id）与到期时间；用于 worker 崩溃后判定 lost。 */
    leaseOwner?: string;
    leaseUntil?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    result?: JobResult;
    error?: string;
    /** 由哪个 Job 重试而来。 */
    retriedFrom?: string;
}

export type JobEventType =
    | "job_created"
    | "job_state"
    | "job_attempt"
    | "job_result"
    | "job_updated"
    | "session_added"
    | "comment_added"
    | "comment_updated"
    | "comment_deleted";

/** Job 级事件流：只记状态变迁，执行细节看该 Job 绑定的 Session 事件流。 */
export interface JobEvent {
    jobId: string;
    /** 全局单调递增，作为 SSE 列表流的游标。 */
    seq: number;
    type: JobEventType;
    ts: string;
    payload: Record<string, unknown>;
}

export interface CreateJobRequest {
    source: string;
    idempotencyKey?: string;
    input: JobInput;
    retriedFrom?: string;
}

/** 提交结果：created=false 表示幂等命中，返回的是既有 Job。 */
export interface CreateJobOutcome {
    job: JobRecord;
    created: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 1;

/**
 * 卡片所在的列：以用户摆放的 column 为准；老卡片没有该字段时按状态兜底一次，
 * 之后用户一拖就以拖拽结果为准（状态怎么变都不再挪动卡片）。
 */
export function columnOf(job: Pick<JobRecord, "state" | "input">): BoardColumn {
    if (job.input.column) return job.input.column;
    switch (job.state) {
        case "queued":
            return "todo";
        case "leased":
        case "running":
            return "doing";
        case "succeeded":
            return "done";
        case "cancelled":
            return "cancelled";
        default:
            // failed / lost / interfered：已经没有「待处理」列，落到待办等人工处理
            return "todo";
    }
}
/** 单个回合的默认上限：超过这个时间基本是卡死，继续等没有价值。 */
export const DEFAULT_TIMEOUT_SEC = 30 * 60;
/** 租约时长：worker 每 1/3 续租，连续三次失败才判 lost。 */
export const DEFAULT_LEASE_MS = 30_000;

/** 状态迁移非法（并发写、过期请求）。 */
export class JobInvalidTransitionError extends Error {
    constructor(id: string, from: JobState, to: JobState) {
        super(`Job ${id} 不能从 ${from} 迁移到 ${to}`);
        this.name = "JobInvalidTransitionError";
    }
}

export class JobNotFoundError extends Error {
    constructor(id: string) {
        super(`Job 不存在: ${id}`);
        this.name = "JobNotFoundError";
    }
}

export class CommentNotFoundError extends Error {
    constructor(id: string) {
        super(`评论不存在: ${id}`);
        this.name = "CommentNotFoundError";
    }
}

/** 当前状态不允许该操作（例如运行中归档/删除）。 */
export class JobConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "JobConflictError";
    }
}
