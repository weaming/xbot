/**
 * 会话跨进程排他文件锁：
 * - 保证同一会话在多 TUI 实例或多进程并发时不发生双写与状态分叉。
 * - 锁文件记录持有者 PID、会话 ID 和时间戳。
 * - 支持自动检测并清理已退出进程的残留死锁（stale lock via process.kill(pid, 0)）。
 * - 支持同一进程内重入。
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { getSessionsDir } from "./runtime-paths.js";
import { sanitizeSessionId } from "./session-id.js";
import { getShanghaiISOString } from "./time.js";

const LOCK_STALE_MS = 10_000;

export interface SessionLockData {
    pid: number;
    sessionId: string;
    lockedAt: string;
    updatedAt: string;
    ownerId?: string;
}

export interface SessionLockHandle {
    sessionId: string;
    release: () => Promise<void>;
}

interface LocalLockState {
    count: number;
    ownerId: string;
}

const localLocks = new Map<string, LocalLockState>();
const pendingLockAcquisitions = new Map<string, Promise<void>>();

export function getSessionLockFilePath(sessionId: string): string {
    return path.join(getSessionsDir("locks"), `${sanitizeSessionId(sessionId)}.lock`);
}

/** 检查指定 PID 是否属于当前仍然存活的进程。 */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        // EPERM 说明进程存在但当前用户无权发送信号（进程仍然存活）；ESRCH 说明进程不存在。
        return err?.code === "EPERM";
    }
}

/** 同步读取锁文件内容，如不存在或损坏返回 null。 */
export function readSessionLockSync(sessionId: string): SessionLockData | null {
    const lockPath = getSessionLockFilePath(sessionId);
    try {
        if (!fs.existsSync(lockPath)) return null;
        const text = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(text) as SessionLockData;
        if (typeof data.pid === "number" && data.sessionId) {
            return data;
        }
        return null;
    } catch {
        return null;
    }
}

/** 同步判断会话是否被其他存活进程锁定。 */
export function isSessionLockedByOtherSync(sessionId: string): boolean {
    const lockPath = getSessionLockFilePath(sessionId);
    const lock = readSessionLockSync(sessionId);
    if (!lock) {
        if (!fs.existsSync(lockPath)) return false;
        if (isLockFileStale(lockPath)) {
            try {
                fs.unlinkSync(lockPath);
                return false;
            } catch {
                return true;
            }
        }
        return true;
    }
    if (lock.pid === process.pid) return false;
    if (!isProcessAlive(lock.pid)) {
        // 残留死锁，尝试清理
        try {
            fs.unlinkSync(lockPath);
            return false;
        } catch {
            return true;
        }
    }
    return true;
}

/** 获取持有该会话锁的其他活跃进程 PID（若无或自身持有返回 null）。 */
export async function getSessionLockHolder(sessionId: string): Promise<number | null> {
    return isSessionLockedByOtherSync(sessionId)
        ? readSessionLockSync(sessionId)?.pid ?? null
        : null;
}

/**
 * 尝试获取会话排他锁。
 * 若获取成功返回 { acquired: true }；
 * 若被其他活跃进程持有，返回 { acquired: false, holderPid, error }。
 */
export async function tryAcquireSessionLock(
    sessionId: string,
): Promise<{ acquired: boolean; holderPid?: number; error?: string }> {
    const lockPath = getSessionLockFilePath(sessionId);
    const pending = pendingLockAcquisitions.get(lockPath);
    if (pending) {
        await pending;
        const local = localLocks.get(lockPath);
        if (local) {
            local.count += 1;
            return { acquired: true };
        }
    }

    let releaseAcquisition: (() => void) | undefined;
    const acquisition = new Promise<void>(resolve => {
        releaseAcquisition = resolve;
    });
    pendingLockAcquisitions.set(lockPath, acquisition);

    try {
        await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

        const local = localLocks.get(lockPath);
        if (local) {
            local.count += 1;
            return { acquired: true };
        }

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const ownerId = randomUUID();
            const payload: SessionLockData = {
                pid: process.pid,
                sessionId,
                lockedAt: getShanghaiISOString(),
                updatedAt: getShanghaiISOString(),
                ownerId,
            };

            try {
                const handle = await fs.promises.open(lockPath, "wx");
                try {
                    await handle.writeFile(JSON.stringify(payload, null, 2), "utf8");
                } finally {
                    await handle.close();
                }
                localLocks.set(lockPath, { count: 1, ownerId });
                return { acquired: true };
            } catch (error: any) {
                if (error?.code !== "EEXIST") {
                    return {
                        acquired: false,
                        error: `获取会话锁失败: ${error?.message ?? error}`,
                    };
                }

                const existing = readSessionLockSync(sessionId);
                if (existing) {
                    if (existing.pid === process.pid && !localLocks.has(lockPath)) {
                        // 当前进程没有本地持锁记录，说明这是 PID 复用后的残留锁。
                        try {
                            await fs.promises.unlink(lockPath);
                        } catch (unlinkError: any) {
                            if (unlinkError?.code !== "ENOENT") {
                                return {
                                    acquired: false,
                                    error: `清理 PID 复用残留锁失败: ${unlinkError?.message ?? unlinkError}`,
                                };
                            }
                        }
                        continue;
                    }

                    if (isProcessAlive(existing.pid)) {
                        return {
                            acquired: false,
                            holderPid: existing.pid,
                            error: `会话正由其他实例 (PID: ${existing.pid}) 运行中，请等待其完成`,
                        };
                    }

                    try {
                        await fs.promises.unlink(lockPath);
                    } catch (unlinkError: any) {
                        if (unlinkError?.code !== "ENOENT") {
                            return {
                                acquired: false,
                                error: `清理残留会话锁失败: ${unlinkError?.message ?? unlinkError}`,
                            };
                        }
                    }
                    continue;
                }

                if (isLockFileStale(lockPath)) {
                    try {
                        await fs.promises.unlink(lockPath);
                    } catch (unlinkError: any) {
                        if (unlinkError?.code !== "ENOENT") {
                            return {
                                acquired: false,
                                error: `清理损坏会话锁失败: ${unlinkError?.message ?? unlinkError}`,
                            };
                        }
                    }
                    continue;
                }

                return {
                    acquired: false,
                    error: "会话锁文件正在写入或已损坏，请稍后重试",
                };
            }
        }

        return { acquired: false, error: "会话锁正在被其他实例竞争，请稍后重试" };
    } finally {
        if (pendingLockAcquisitions.get(lockPath) === acquisition) {
            pendingLockAcquisitions.delete(lockPath);
            releaseAcquisition?.();
        }
    }
}

/**
 * 获取会话排他锁；若被占用则抛出有意义的错误。
 */
export async function acquireSessionLock(sessionId: string): Promise<SessionLockHandle> {
    const result = await tryAcquireSessionLock(sessionId);
    if (!result.acquired) {
        throw new Error(result.error ?? "获取会话锁失败");
    }

    let released = false;
    return {
        sessionId,
        release: async () => {
            if (released) return;
            released = true;
            await releaseSessionLock(sessionId);
        },
    };
}

/** 释放会话排他锁（仅当当前进程持有该锁时删除）。 */
export async function releaseSessionLock(sessionId: string): Promise<void> {
    const lockPath = getSessionLockFilePath(sessionId);
    const local = localLocks.get(lockPath);
    if (!local) return;

    if (local.count > 1) {
        local.count -= 1;
        return;
    }

    localLocks.delete(lockPath);
    try {
        const existing = readSessionLockSync(sessionId);
        if (existing && existing.pid === process.pid && existing.ownerId === local.ownerId) {
            await fs.promises.unlink(lockPath);
        }
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }
}

/** 仅判断损坏/半写锁文件；合法锁按持有进程判断，不因 10 秒阈值误删长任务锁。 */
function isLockFileStale(lockPath: string): boolean {
    try {
        return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch (error: any) {
        return error?.code === "ENOENT";
    }
}
