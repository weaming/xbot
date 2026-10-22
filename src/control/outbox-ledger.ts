/**
 * 出站消息台账：一条出站消息的全部生命周期收敛成**一个实体**。
 *
 * 早前这些状态分散在三个容器里（expectations / queue / stash），
 * 删除一处忘记另一处就会产生「结果丢失却无日志」这类缺陷。
 * 现在用一张 Map<msgId, OutboundEntry> 表示，状态迁移必须显式经过本模块。
 *
 * 状态机（只进不退，除 queued → 被取走）：
 *
 *   awaiting ──结果到达──▶ queued ──宿主取走──▶ (移除)
 *      │
 *      ├──超时──────────▶ lost
 *      ├──对端丢失──────▶ lost
 *      └──close()───────▶ lost
 */

import type { PeerMessage, PeerResult } from "./protocol.js";

export type OutboundState = "awaiting" | "queued";

export interface OutboundEntry {
    msgId: string;
    /** 发起方会话。 */
    requester: string;
    target: string;
    /** 出站消息原文（onResult 回放用）。 */
    message: PeerMessage;
    state: OutboundState;
    /** 仅 awaiting：超时定时器。 */
    timer: ReturnType<typeof setTimeout> | null;
    /** 仅 awaiting：前台等待者（命中时直接兑现，不入队）。 */
    waiter: ((outcome: WaitOutcome) => void) | null;
    /** 仅 queued：待附加给模型的文本。 */
    text?: string;
}

export type WaitOutcome =
    | { ok: true; result: PeerResult }
    | { ok: false; reason: "timeout" | "lost" | "aborted" | "detached" | "none" };

export interface OutboxOptions {
    /** 单会话待附加结果上限；超出丢弃最早一条。 */
    maxQueuedPerSession: number;
    /** 暂存上限：对端一直不来取时避免内存无限增长。 */
    maxStashed: number;
}

/**
 * 台账本体。**不含定时器管理**：超时由调用方在 startAwaiting 时挂上，
 * 台账只负责状态与查询，便于用纯逻辑测试所有迁移。
 */
export class OutboxLedger {
    private readonly entries = new Map<string, OutboundEntry>();
    /** 未能送达的结果暂存（msgId 全局唯一），供发起方重连后取回。 */
    private readonly stash = new Map<string, PeerResult>();

    constructor(private readonly options: OutboxOptions) {}

    // ── 写入 ────────────────────────────────────────────────────

    /** 登记一条等待结果的消息；已存在则返回既有条目（幂等）。 */
    addAwaiting(input: { msgId: string; requester: string; target: string; message: PeerMessage }): OutboundEntry {
        const existing = this.entries.get(input.msgId);
        if (existing) return existing;

        const entry: OutboundEntry = {
            msgId: input.msgId,
            requester: input.requester,
            target: input.target,
            message: input.message,
            state: "awaiting",
            timer: null,
            waiter: null,
        };
        this.entries.set(entry.msgId, entry);
        return entry;
    }

    get(msgId: string): OutboundEntry | undefined {
        return this.entries.get(msgId);
    }

    /** 挂上超时定时器；同一条消息重复挂载时覆盖旧定时器。 */
    setTimer(msgId: string, timer: ReturnType<typeof setTimeout>): void {
        const entry = this.entries.get(msgId);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = timer;
    }

    /**
     * 结果到达：awaiting → queued。
     * 返回 null 表示这条消息已不在台账里（重复回传、或从未登记）。
     */
    settle(msgId: string, text: string): { entry: OutboundEntry; waiter: OutboundEntry["waiter"] } | null {
        const entry = this.entries.get(msgId);
        if (!entry || entry.state !== "awaiting") return null;

        if (entry.timer) clearTimeout(entry.timer);
        const waiter = entry.waiter;
        entry.waiter = null;
        entry.timer = null;

        // 有人在前台等：直接兑现，不入队、不通知宿主
        if (waiter) {
            this.entries.delete(msgId);
            return { entry, waiter };
        }

        entry.state = "queued";
        entry.text = text;
        this.evictQueued(entry.requester);
        return { entry, waiter: null };
    }

    /**
     * 超时或丢失：awaiting → lost（从台账移除）。
     * 返回被影响的条目；已不在 awaiting 时返回 null。
     */
    abandon(msgId: string): { entry: OutboundEntry; waiter: OutboundEntry["waiter"] } | null {
        const entry = this.entries.get(msgId);
        if (!entry || entry.state !== "awaiting") return null;

        if (entry.timer) clearTimeout(entry.timer);
        const waiter = entry.waiter;
        entry.waiter = null;
        entry.timer = null;
        this.entries.delete(msgId);
        return { entry, waiter };
    }

    /** 取走某会话已就绪的结果文本（下一次请求用），取后即清。 */
    takeQueued(sessionId: string): string[] {
        const texts: string[] = [];
        for (const [msgId, entry] of this.entries) {
            if (entry.state === "queued" && entry.requester === sessionId && entry.text !== undefined) {
                texts.push(entry.text);
                this.entries.delete(msgId);
            }
        }
        return texts;
    }

    // ── 查询 ────────────────────────────────────────────────────

    /** 该会话仍在等结果的消息数。 */
    awaitingCount(sessionId: string): number {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.state === "awaiting" && entry.requester === sessionId) count += 1;
        }
        return count;
    }

    /** 该会话待附加的结果条数。 */
    queuedCount(sessionId: string): number {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.state === "queued" && entry.requester === sessionId) count += 1;
        }
        return count;
    }

    /** 所有仍在等待的条目（close 时统一兑现）。 */
    awaitingEntries(): OutboundEntry[] {
        return [...this.entries.values()].filter(entry => entry.state === "awaiting");
    }

    /** 台账里的条目总数（诊断用）。 */
    get size(): number {
        return this.entries.size;
    }

    // ── 暂存（对端重连后取回） ───────────────────────────────────

    stashResult(result: PeerResult): void {
        this.stash.set(result.msgId, result);
        while (this.stash.size > this.options.maxStashed) {
            const oldest = this.stash.keys().next().value;
            if (oldest === undefined) break;
            this.stash.delete(oldest);
        }
    }

    takeStashed(msgIds: string[]): { done: PeerResult[]; pending: string[] } {
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

    clear(): void {
        for (const entry of this.entries.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.entries.clear();
        this.stash.clear();
    }

    /** 队列按会话限幅：只清该会话超出的最老条目。 */
    private evictQueued(sessionId: string): void {
        const queued = [...this.entries.values()]
            .filter(entry => entry.state === "queued" && entry.requester === sessionId);
        const overflow = queued.length - this.options.maxQueuedPerSession;
        if (overflow <= 0) return;
        for (const entry of queued.slice(0, overflow)) {
            this.entries.delete(entry.msgId);
        }
    }
}
