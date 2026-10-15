/**
 * 事件日志：append-only JSONL 文件，会话内 seq 递增，是会话状态的事实源。
 * 进程内缓存最后 seq，避免每次追加都扫文件尾。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";
import type { AgentEvent, AgentEventPayloads, AgentEventType } from "./agent-events.js";

export class EventLog {
    private readonly seqCache = new Map<string, number>();
    private readonly appendLocks = new Map<string, Promise<void>>();

    private eventFilePath(sessionId: string): string {
        return path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
    }

    /** 会话当前最后 seq（无日志时 0）。支持 forceRefresh 绕过内存缓存重新读取磁盘。 */
    async lastSeq(sessionId: string, options?: { forceRefresh?: boolean }): Promise<number> {
        if (!options?.forceRefresh) {
            const cached = this.seqCache.get(sessionId);
            if (cached !== undefined) return cached;
        }

        const text = await readFileIfExists(this.eventFilePath(sessionId));
        let seq = 0;
        if (text) {
            for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line) as AgentEvent;
                    if (Number.isSafeInteger(event.seq) && event.seq > seq) seq = event.seq;
                } catch {
                    // 跳过损坏行并继续查找有效序号。
                }
            }
        }
        this.seqCache.set(sessionId, seq);
        return seq;
    }

    /** 追加一条事件，返回带 seq 的完整事件。 */
    async append<T extends AgentEventType>(
        sessionId: string,
        type: T,
        payload: AgentEventPayloads[T],
    ): Promise<AgentEvent> {
        const previous = this.appendLocks.get(sessionId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        const queued = previous.then(() => current);
        this.appendLocks.set(sessionId, queued);
        await previous;

        try {
            const seq = (await this.lastSeq(sessionId)) + 1;
            const event = {
            seq,
            ts: new Date().toISOString(),
            sessionId,
            type,
            payload,
        } as AgentEvent;

        const filePath = this.eventFilePath(sessionId);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
            this.seqCache.set(sessionId, seq);
            return event;
        } finally {
            release();
            if (this.appendLocks.get(sessionId) === queued) this.appendLocks.delete(sessionId);
        }
    }

    /** 读取事件序列：fromSeq 起（默认从头），limit 限制条数（默认全部）。 */
    async read(sessionId: string, fromSeq = 1, limit?: number): Promise<AgentEvent[]> {
        const text = await readFileIfExists(this.eventFilePath(sessionId));
        if (!text) return [];

        const events: AgentEvent[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let event: AgentEvent;
            try {
                event = JSON.parse(line);
            } catch {
                // 追加中断可能留下半行，跳过损坏行，不阻断整条日志
                console.warn(`[EventLog] 跳过损坏事件行 (session=${sessionId}): ${line.slice(0, 120)}`);
                continue;
            }
            if (event.seq < fromSeq) continue;
            events.push(event);
            if (limit !== undefined && events.length >= limit) break;
        }
        return events;
    }

    /** 截断日志到 upToSeq（时间点恢复 = 该点之后的未来全部作废）。 */
    async truncate(sessionId: string, upToSeq: number): Promise<void> {
        const filePath = this.eventFilePath(sessionId);
        const text = await readFileIfExists(filePath);
        if (!text) return;

        const keptLines: string[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line) as AgentEvent;
                if (event.seq <= upToSeq) keptLines.push(line);
            } catch {
                continue;
            }
        }
        await fs.promises.writeFile(filePath, keptLines.join("\n") + "\n", "utf8");
        this.seqCache.set(sessionId, upToSeq);
    }

    /** 删除会话的完整事件日志（/delete 彻底删除）。 */
    async delete(sessionId: string): Promise<void> {
        try {
            await fs.promises.unlink(this.eventFilePath(sessionId));
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
        this.seqCache.delete(sessionId);
    }

}

async function readFileIfExists(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}
