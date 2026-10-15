/**
 * 会话间控制通道：归属协商 + 消息投递 + 结果回传。
 *
 * 这是 TUI/agent 与 `src/control` 协议层之间唯一的编排点：
 * - 会话归属：认领 = 本进程 bind 其 socket；被占用时向持有者**协商**释放（不夺权）；
 * - 消息投递：目标在本进程直接走内存，否则走 socket；
 * - 结果回传：`expect_result` 的消息在目标回合结束后自动回来，进请求者的结果队列，
 *   由下一次 HTTP 请求附加，不额外驱动一轮；`waitForResult` 是可选的前台等待，
 *   命中时直接兑现给调用方（不入队）。
 *
 * 不支持的场景（有意为之）：目标不可达 / 目标忙 / 目标进程重启 —— 一律报错，不排队、不补投。
 */

import { PeerClientPool, PeerConnectError, requestOnce } from "./client.js";
import { getSocketPath } from "./paths.js";
import { createPeerMessage, type PeerMessage, type PeerResult } from "./protocol.js";
import { listOwnership, probeOwnership, type PeerOwnership } from "./registry.js";
import { PeerServer } from "./server.js";

/** `session_send` 的失败原因：只有 unreachable 表示目标不在线，busy 由调用方决定是否重试。 */
export type PeerSendError = "unreachable" | "busy" | "internal";

export class PeerSendFailure extends Error {
    constructor(
        readonly reason: PeerSendError,
        message: string,
    ) {
        super(message);
        this.name = "PeerSendFailure";
    }
}

export type ClaimResult =
    | { ok: true }
    | { ok: false; reason: "busy"; pid?: number }
    | { ok: false; reason: "unresponsive" }
    | { ok: false; reason: "error"; message: string };

export type SpawnResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** 前台等待的结果：除 ok 外都只解除等待（等待项保留），none 表示这条消息已不在等待表里。 */
export type WaitOutcome =
    | { ok: true; result: PeerResult }
    | { ok: false; reason: "timeout" | "lost" | "aborted" | "detached" | "none" };

/** 通道层需要宿主（agent/UI）提供的会话能力。 */
export interface SessionControlHost {
    /** 会话展示名（who 握手用）。 */
    title(sessionId: string): string | undefined;
    /** 是否正在跑 turn。 */
    isBusy(sessionId: string): boolean;
    /** 新建一个空会话（只进内存，不落盘）；cwd 缺省用宿主默认目录。 */
    createSession(cwd?: string): Promise<{ sessionId: string }>;
    /** 会话绑定的工作目录（派生新会话时继承父会话）。 */
    sessionCwd(sessionId: string): Promise<string>;
    /** 子会话已建立并认领：宿主把它加进会话列表 / 固化标题。 */
    onSessionSpawned(sessionId: string, title?: string): void;
    /**
     * 原子受理一条入站消息：抢不到互斥则返回 false（通道据此回 busy，且不落任何事实）。
     * 实现方负责落盘与启动回合；回合结束后调用 completeInbound 回传结果。
     */
    accept(message: PeerMessage): Promise<boolean> | boolean;
    /** 出站消息已成功投递（落时间线用）。 */
    onOutbound(from: string, message: PeerMessage): void;
    /** 结果到达请求者会话：已进结果队列，宿主负责落时间线与提示。 */
    onResult(requester: string, message: PeerMessage, result: PeerResult): void;
    /** 结果确定丢失（目标进程不可达或等待超时）。 */
    onLost(requester: string, msgIds: string[], target: string): void;
    /** 远端协商释放成功：宿主把会话从 tabs / activeSessions 摘掉。 */
    onReleased(sessionId: string): void;
}

export interface SessionControlOptions {
    /** `expect_result` 的等待上限，超时即判定结果丢失。 */
    resultTimeoutMs?: number;
    /** 归属探测超时。 */
    probeTimeoutMs?: number;
    /** 协商释放的应答超时；持有者无响应即放弃（不夺权）。 */
    negotiateTimeoutMs?: number;
    /** 单个会话最多保留多少条未消费结果。 */
    maxResultsPerSession?: number;
}

/** 默认等待结果的时长。 */
const DEFAULT_RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NEGOTIATE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESULTS_PER_SESSION = 50;
/** 结果暂存上限：对端一直不来取时避免内存无限增长。 */
const MAX_RESULT_STASH = 200;

/** 本实例同时派生的子会话上限：避免模型无限开子会话把进程压垮。 */
export const MAX_SPAWNED_SESSIONS = 8;

interface OutboundExpectation {
    requester: string;
    message: PeerMessage;
    target: string;
    timer: ReturnType<typeof setTimeout> | null;
    /** 有人在阻塞等这条消息的结果：命中时直接兑现，不入队、不通知宿主。 */
    waiter: ((outcome: WaitOutcome) => void) | null;
}

/** 本实例发出的消息在等结果；未送达的结果暂存于此供对端重连后取回。 */
interface Outbox {
    expectations: Map<string, OutboundExpectation>;
    /** 已进请求者队列、等下一次请求附加的结果文本。 */
    queue: string[];
}

function emptyOutbox(): Outbox {
    return { expectations: new Map(), queue: [] };
}

export class SessionControl {
    private readonly servers = new Map<string, PeerServer>();
    /** 本实例派生的子会话（含已被别的实例接管或已删除的会在此处随 release 移除）。 */
    private readonly spawned = new Set<string>();
    /** 走本进程内存投递的入站消息 id：完成后直接回给本地请求者，不走 socket。 */
    private readonly localInbound = new Set<string>();
    private readonly outboxes = new Map<string, Outbox>();
    /** 未能送达的结果暂存（msgId 全局唯一），供发起方重连后取回。 */
    private readonly stash = new Map<string, PeerResult>();
    private readonly pool: PeerClientPool;
    private readonly resultTimeoutMs: number;
    private readonly probeTimeoutMs: number | undefined;
    private readonly negotiateTimeoutMs: number;
    private readonly maxResultsPerSession: number;

    constructor(
        private readonly host: SessionControlHost,
        options: SessionControlOptions = {},
    ) {
        this.resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
        this.probeTimeoutMs = options.probeTimeoutMs;
        this.negotiateTimeoutMs = options.negotiateTimeoutMs ?? DEFAULT_NEGOTIATE_TIMEOUT_MS;
        this.maxResultsPerSession = options.maxResultsPerSession ?? DEFAULT_MAX_RESULTS_PER_SESSION;
        this.pool = new PeerClientPool({
            onResult: (target, result) => this.handleRemoteResult(target, result),
            onLost: (target, msgIds) => this.handleRemoteLost(target, msgIds),
        });
    }

    // ── 归属 ────────────────────────────────────────────────────

    isClaimed(sessionId: string): boolean {
        return this.servers.has(sessionId);
    }

    get claimedSessionIds(): string[] {
        return [...this.servers.keys()];
    }

    /** 认领会话：本进程 bind 其 socket；被其他实例占用时协商释放，绝不夺权。 */
    async claim(sessionId: string): Promise<ClaimResult> {
        if (this.servers.has(sessionId)) return { ok: true };

        const server = new PeerServer(
            sessionId,
            {
                title: () => this.host.title(sessionId),
                isBusy: () => this.host.isBusy(sessionId),
                accept: (message) => this.host.accept(message),
                release: () => {
                    if (this.host.isBusy(sessionId)) return false;
                    this.servers.delete(sessionId);
                    this.spawned.delete(sessionId);
                    this.host.onReleased(sessionId);
                    return true;
                },
                pendingState: (msgIds) => this.takeStashedResults(msgIds),
            },
            this.probeTimeoutMs !== undefined ? { probeTimeoutMs: this.probeTimeoutMs } : {},
        );

        const first = await server.bind();
        if (first.ok) {
            this.servers.set(sessionId, server);
            return { ok: true };
        }
        if (first.reason === "error") return { ok: false, reason: "error", message: first.message };

        // 被其他实例持有：协商式转移，持有者忙则放弃
        if (first.pid === process.pid) return { ok: false, reason: "error", message: "会话已被本实例持有" };

        const negotiation = await this.requestRelease(sessionId);
        if (!negotiation.ok) return negotiation;

        const second = await server.bind();
        if (second.ok) {
            this.servers.set(sessionId, server);
            return { ok: true };
        }
        if (second.reason === "error") return { ok: false, reason: "error", message: second.message };
        if (second.pid === process.pid) return { ok: false, reason: "error", message: "会话已被本实例持有" };
        return { ok: false, reason: "unresponsive" };
    }

    /** 本实例主动放弃会话：关监听、释放 socket 文件、允许其他实例认领。 */
    release(sessionId: string): void {
        this.spawned.delete(sessionId);
        const server = this.servers.get(sessionId);
        if (!server) return;

        this.servers.delete(sessionId);
        server.unbind();
    }

    // ── 派生子会话 ──────────────────────────────────────────────

    /** 本实例当前派生、仍持有的子会话数。 */
    get spawnedCount(): number {
        return this.spawned.size;
    }

    /**
     * 派生一个子会话并立即认领：只负责建会话，派活由调用方随后 send。
     * 子会话继承父会话的工作目录；数量受 MAX_SPAWNED_SESSIONS 限制。
     */
    async spawnSession(parentSessionId: string, title?: string): Promise<SpawnResult> {
        if (this.spawned.size >= MAX_SPAWNED_SESSIONS) {
            return {
                ok: false,
                error: `本实例派生的子会话已达上限（${MAX_SPAWNED_SESSIONS} 个），请先让用户清理不再需要的子会话`,
            };
        }

        const cwd = await this.host.sessionCwd(parentSessionId);
        const { sessionId } = await this.host.createSession(cwd);

        const claimed = await this.claim(sessionId);
        if (!claimed.ok) {
            // 认领失败（极端情况）：把它从宿主会话列表摘掉，不留一个谁都用不了的会话
            this.host.onReleased(sessionId);
            return { ok: false, error: `子会话已建立但认领失败：${describeClaimFailure(claimed)}` };
        }

        this.spawned.add(sessionId);
        this.host.onSessionSpawned(sessionId, title);
        return { ok: true, sessionId };
    }

    probe(sessionId: string): Promise<PeerOwnership> {
        return probeOwnership(sessionId, this.probeTimeoutMs);
    }

    listOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>> {
        return listOwnership(sessionIds, this.probeTimeoutMs);
    }

    // ── 消息 ────────────────────────────────────────────────────

    /**
     * 发一条消息。目标不可达或正忙时抛 PeerSendFailure（不排队、不重试）。
     * `expect_result` 时结果稍后自动回传，进请求者的结果队列。
     */
    async send(
        from: string,
        to: string,
        text: string,
        options: { expectResult?: boolean; replyTo?: string } = {},
    ): Promise<PeerMessage> {
        if (from === to) throw new PeerSendFailure("internal", "不能给自己发消息");

        const message = createPeerMessage({
            from,
            to,
            text,
            ...(options.replyTo ? { replyTo: options.replyTo } : {}),
            ...(options.expectResult ? { expectResult: true } : {}),
        });

        if (this.servers.has(to)) {
            // 同进程直投：不经过 socket，省一次序列化与连接
            this.localInbound.add(message.id);
            let accepted = false;
            try {
                accepted = await this.host.accept(message);
            } catch {
                accepted = false;
            }
            if (!accepted) {
                this.localInbound.delete(message.id);
                throw new PeerSendFailure("busy", `会话 ${to} 正在执行中，请稍后重试`);
            }
        } else {
            await this.deliverRemote(to, message);
        }

        if (message.expectResult) this.trackExpectation(from, message, to);
        this.host.onOutbound(from, message);
        return message;
    }

    /**
     * 回传一轮 turn 的结果；由宿主在回合结束时调用。
     *
     * 结果**无条件暂存**一份：推送只是快路径，对端半死连接上的 write 会"成功"但实际丢失，
     * 所以真正的可靠性由发起方重连后 query_pending 兜住（暂存有上限，不会无限增长）。
     */
    completeInbound(sessionId: string, message: PeerMessage, result: PeerResult): void {
        if (this.localInbound.delete(message.id)) {
            this.handleRemoteResult(sessionId, result);
            return;
        }

        this.stashResult(result);
        this.servers.get(sessionId)?.pushResult(result);
    }

    /** 取走请求者待附加的结果（下一次 HTTP 请求用），取后即清。 */
    takeResults(sessionId: string): string[] {
        const outbox = this.outboxes.get(sessionId);
        if (!outbox || outbox.queue.length === 0) return [];

        const texts = outbox.queue.splice(0);
        this.evictOutboxes();
        return texts;
    }

    /** 本实例发出的、仍在等结果的消息数。 */
    awaitingResults(sessionId: string): number {
        const outbox = this.outboxes.get(sessionId);
        if (!outbox) return 0;
        let count = 0;
        for (const expectation of outbox.expectations.values()) {
            if (expectation.requester === sessionId) count += 1;
        }
        return count;
    }

    /** 已就绪、等待下一次请求附加的结果条数。 */
    queuedResults(sessionId: string): number {
        return this.outboxes.get(sessionId)?.queue.length ?? 0;
    }

    /**
     * 前台阻塞等待某条自己发出的消息的结果：命中时直接返回结果，
     * 不入「待附加」队列、不触发驱动轮，省掉一次 HTTP 往返。
     * 超时 / 丢失 / 中止 / 转后台只解除等待，等待项仍在，结果此后到达仍按原路入队。
     */
    waitForResult(msgId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
        const expectation = this.findOutboxByMsgId(msgId)?.expectations.get(msgId);
        if (!expectation || expectation.waiter) return Promise.resolve({ ok: false, reason: "none" });
        if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });

        return new Promise<WaitOutcome>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const settle = (outcome: WaitOutcome) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                expectation.waiter = null;
                resolve(outcome);
            };
            const onAbort = () => settle({ ok: false, reason: "aborted" });

            timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
            timer.unref?.();
            expectation.waiter = settle;
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * 把某会话正在前台等待的结果放入后台（⌃B）：兑现为 `detached`，
     * 调用方立刻拿回控制权，等待项保留，结果到达后照原路入队并驱动下一轮。
     * 返回本次放下的等待数（0 表示没有可放后台的等待）。
     */
    detachWaits(sessionId: string): number {
        const outbox = this.outboxes.get(sessionId);
        if (!outbox) return 0;

        let count = 0;
        for (const expectation of outbox.expectations.values()) {
            const waiter = expectation.waiter;
            if (!waiter) continue;
            expectation.waiter = null;
            count += 1;
            waiter({ ok: false, reason: "detached" });
        }
        return count;
    }

    /** 退出前释放全部监听与连接。 */
    close(): void {
        for (const server of this.servers.values()) server.unbind();
        this.servers.clear();
        this.spawned.clear();
        for (const outbox of this.outboxes.values()) {
            for (const expectation of outbox.expectations.values()) {
                if (expectation.timer) clearTimeout(expectation.timer);
                const waiter = expectation.waiter;
                expectation.waiter = null;
                waiter?.({ ok: false, reason: "aborted" });
            }
        }
        this.outboxes.clear();
        this.localInbound.clear();
        this.pool.closeAll();
    }

    // ── 内部 ────────────────────────────────────────────────────

    private async deliverRemote(to: string, message: PeerMessage): Promise<void> {
        let reply;
        try {
            reply = await this.pool.deliver(to, message);
        } catch (error) {
            if (error instanceof PeerConnectError) {
                throw new PeerSendFailure("unreachable", `会话 ${to} 不可达（未认领或进程已退出）`);
            }
            throw new PeerSendFailure("internal", `发送到会话 ${to} 失败：${(error as Error)?.message ?? error}`);
        }

        if (reply.type !== "ack") {
            throw new PeerSendFailure("internal", `会话 ${to} 返回了非预期的应答`);
        }
        if (!reply.ok) {
            if (reply.error === "busy") throw new PeerSendFailure("busy", `会话 ${to} 正在执行中，请稍后重试`);
            throw new PeerSendFailure("unreachable", `会话 ${to} 拒绝了消息（${reply.error}）`);
        }
    }

    /** 向持有者发起协商释放；持有者忙或无应答都算失败（不夺权）。 */
    private async requestRelease(sessionId: string): Promise<ClaimResult> {
        let reply;
        try {
            reply = await requestOnce(
                getSocketPath(sessionId),
                { type: "release", id: `release-${sessionId}` },
                this.negotiateTimeoutMs,
            );
        } catch (error) {
            if (error instanceof PeerConnectError && error.code === "connect") {
                // 无监听者：残留文件，交给 bind 的重试逻辑清理
                return { ok: true };
            }
            return { ok: false, reason: "unresponsive" };
        }

        if (reply.type !== "release_result") return { ok: false, reason: "unresponsive" };
        if (reply.ok) return { ok: true };
        return { ok: false, reason: "busy" };
    }

    private trackExpectation(requester: string, message: PeerMessage, target: string): void {
        const outbox = this.outbox(requester);
        const expectation: OutboundExpectation = { requester, message, target, timer: null, waiter: null };
        expectation.timer = setTimeout(() => {
            outbox.expectations.delete(message.id);
            const waiter = expectation.waiter;
            expectation.waiter = null;
            waiter?.({ ok: false, reason: "timeout" });
            this.host.onLost(requester, [message.id], target);
        }, this.resultTimeoutMs);
        expectation.timer.unref?.();
        outbox.expectations.set(message.id, expectation);
    }

    /** 结果到达：有前台等待者就直给，否则进请求者队列等下一次请求附加。 */
    private handleRemoteResult(sourceSessionId: string, result: PeerResult): void {
        const outbox = this.findOutboxByMsgId(result.msgId);
        if (!outbox) return;

        const expectation = outbox.expectations.get(result.msgId);
        if (!expectation) return;

        outbox.expectations.delete(result.msgId);
        if (expectation.timer) clearTimeout(expectation.timer);

        const waiter = expectation.waiter;
        expectation.waiter = null;
        if (waiter) {
            waiter({ ok: true, result });
            return;
        }

        outbox.queue.push(formatResultText(expectation.target, result));
        this.evictOutboxes();
        this.host.onResult(expectation.requester, expectation.message, result);
    }

    private handleRemoteLost(target: string, msgIds: string[]): void {
        for (const msgId of msgIds) {
            const outbox = this.findOutboxByMsgId(msgId);
            const expectation = outbox?.expectations.get(msgId);
            if (!outbox || !expectation) continue;

            outbox.expectations.delete(msgId);
            if (expectation.timer) clearTimeout(expectation.timer);
            const waiter = expectation.waiter;
            expectation.waiter = null;
            waiter?.({ ok: false, reason: "lost" });
            this.host.onLost(expectation.requester, [msgId], target);
        }
    }

    /** 暂存未能送达的结果：等发起方重连后 query_pending 取回。 */
    private stashResult(result: PeerResult): void {
        this.stash.set(result.msgId, result);

        while (this.stash.size > MAX_RESULT_STASH) {
            const oldest = this.stash.keys().next().value;
            if (oldest === undefined) break;
            this.stash.delete(oldest);
        }
    }

    private takeStashedResults(msgIds: string[]): { done: PeerResult[]; pending: string[] } {
        const done: PeerResult[] = [];
        const pending: string[] = [];

        for (const msgId of msgIds) {
            const result = this.stash.get(msgId);
            if (result) {
                this.stash.delete(msgId);
                done.push(result);
            } else {
                pending.push(msgId);
            }
        }
        return { done, pending };
    }

    private outbox(sessionId: string): Outbox {
        const existing = this.outboxes.get(sessionId);
        if (existing) return existing;

        const created = emptyOutbox();
        this.outboxes.set(sessionId, created);
        return created;
    }

    private findOutboxByMsgId(msgId: string): Outbox | undefined {
        for (const outbox of this.outboxes.values()) {
            if (outbox.expectations.has(msgId)) return outbox;
        }
        return undefined;
    }

    /** 结果队列按会话限幅：超出丢弃最早的一条，避免长会话无限增长。 */
    private evictOutboxes(): void {
        for (const outbox of this.outboxes.values()) {
            while (outbox.queue.length > this.maxResultsPerSession) outbox.queue.shift();
        }
    }
}

/** 结果进入模型上下文时的文本形态：与时间线展示同源，避免两处措辞漂移。 */
export function formatResultText(target: string, result: PeerResult): string {
    const header = `[会话 ${target} 的结果${result.ok ? "" : "（未正常完成）"}]`;
    const body = result.text.trim() || "（无文本输出）";
    return [header, body, `（stopReason: ${result.stopReason}）`].join("\n");
}

/** 入站消息给模型的文本：结果由机器回传，模型不需要为此调用工具。 */
export function formatInboundPrompt(message: PeerMessage, peerTitle?: string): string {
    const who = peerTitle ? `${message.from}（${peerTitle}）` : message.from;
    const lines = [`[会话 ${who} 发来的消息]`, message.text];

    if (message.expectResult) {
        lines.push(
            "",
            ">>> 这条消息期望结果：请完成这件事。",
            "你的本轮最终输出会自动作为结果回传给对方，不需要为回信调用任何工具。",
            `要中途先说一句时才用 session_send(..., reply_to="${message.id}")。`,
        );
    }
    return lines.join("\n");
}

/** 认领失败的展示文案：UI flash 与 UI 工具提示共用，避免两处措辞漂移。 */
export function describeClaimFailure(result: ClaimResult): string {
    if (result.ok) return "";
    if (result.reason === "busy") {
        return result.pid
            ? `会话正由其他实例（PID ${result.pid}）执行中，turn 结束后才能接管`
            : "会话正由其他实例执行中，turn 结束后才能接管";
    }
    if (result.reason === "unresponsive") return "无法确认持有者状态（未应答），暂不能接管";
    return result.message;
}
