/**
 * 事件日志：append-only JSONL 文件，会话内 seq 递增，是会话状态的事实源。
 * 进程内缓存最后 seq，避免每次追加都扫文件尾。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";
import type { AgentEvent, AgentEventPayloads, AgentEventType } from "./agent-events.js";

/** 从文件尾部回读的窗口：一次读这么多字节找最后一行，不够再往前翻一倍。 */
const TAIL_WINDOW_BYTES = 8 * 1024;
const TAIL_WINDOW_MAX_BYTES = 1024 * 1024;

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

        const seq = await readLastSeqFromTail(this.eventFilePath(sessionId));
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

    /** 清掉某会话的 seq 缓存（日志已在外部删除时用）。 */
    forget(sessionId: string): void {
        this.seqCache.delete(sessionId);
    }

}

/**
 * 只读文件尾部求最后一条事件的 seq：大会话日志可达十几 MB，全量读入再逐行解析
 * 只为取一个数字，首次打开会卡顿并吃掉数十 MB 内存。这里从尾部按窗口回读，找到
 * 第一条有效事件即返回；窗口内没有（尾巴是超长行或大量损坏行）就往前翻倍。
 */
async function readLastSeqFromTail(filePath: string): Promise<number> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, "r");
    } catch (error: any) {
        if (error?.code === "ENOENT") return 0;
        throw error;
    }

    try {
        let { size } = await handle.stat();
        let window = TAIL_WINDOW_BYTES;
        let rest = "";
        while (size > 0) {
            const length = Math.min(window, size);
            const start = size - length;
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            // rest 是上次已读部分里属于最后一行之后的内容，需与本次拼接
            const text = buffer.subarray(0, bytesRead).toString("utf8") + rest;
            const lines = text.split("\n");
            // 窗口没覆盖到文件头时，首行很可能是被截断的半行
            const skipFirst = start > 0;
            for (let index = lines.length - 1; index >= (skipFirst ? 1 : 0); index--) {
                const seq = parseSeq(lines[index]);
                if (seq !== undefined) return seq;
            }
            if (!skipFirst) break;
            // 整窗都没有有效事件：保留首行（可能是跨窗口的一条）继续往前
            rest = lines[0];
            size = start;
            if (window >= TAIL_WINDOW_MAX_BYTES) {
                // 兜底：窗口已达上限，换整文件扫描，保证结果正确而非静默返回 0
                return await scanWholeFileForLastSeq(filePath);
            }
            window *= 2;
        }
        return 0;
    } finally {
        await handle.close();
    }
}

/** 解析一行事件取出 seq；空行或损坏行返回 undefined。 */
function parseSeq(line: string | undefined): number | undefined {
    if (!line || !line.trim()) return undefined;
    try {
        const event = JSON.parse(line) as AgentEvent;
        return Number.isSafeInteger(event.seq) ? event.seq : undefined;
    } catch {
        return undefined;
    }
}

/** 尾部回读放弃时的整文件兜底：只保留最大值，不保留解析结果。 */
async function scanWholeFileForLastSeq(filePath: string): Promise<number> {
    const text = await readFileIfExists(filePath);
    if (!text) return 0;
    let seq = 0;
    for (const line of text.split("\n")) {
        const value = parseSeq(line);
        if (value !== undefined && value > seq) seq = value;
    }
    return seq;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}
