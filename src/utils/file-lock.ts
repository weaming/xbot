/**
 * 跨进程文件锁：基于锁文件原子创建（O_EXCL），防止多 TUI 实例
 * 并发读改写同一状态文件（input-history / tool-lru）。
 * 锁文件带 stale 清理：持有者崩溃后超过 LOCK_STALE_MS 自动作废。
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 30;

/**
 * 对目标文件加锁后执行 fn，完成后释放锁。
 * 锁文件为 `<targetPath>.lock`；等待超时抛错。
 */
export async function withFileLock<T>(targetPath: string, fn: () => Promise<T> | T): Promise<T> {
    const lockPath = `${targetPath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const ownerId = randomUUID();

    for (;;) {
        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            const handle = fs.openSync(lockPath, "wx");
            try {
                fs.writeSync(handle, `${process.pid} ${Date.now()} ${ownerId}`);
            } finally {
                fs.closeSync(handle);
            }
            break;
        } catch (error: any) {
            if (error?.code !== "EEXIST") throw error;
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS && !isLockOwnerAlive(lockPath)) {
                    fs.unlinkSync(lockPath);
                }
            } catch {
                // 锁文件刚被清理，下一轮重试即可。
            }
            if (Date.now() >= deadline) {
                throw new Error(`获取文件锁超时: ${lockPath}`);
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
        }
    }

    try {
        return await fn();
    } finally {
        try {
            if (readLockOwnerId(lockPath) === ownerId) fs.unlinkSync(lockPath);
        } catch {
            // 锁文件已被过期清理，忽略。
        }
    }
}

function isLockOwnerAlive(lockPath: string): boolean {
    try {
        const [pidText] = fs.readFileSync(lockPath, "utf8").split(" ");
        const pid = Number(pidText);
        if (!Number.isInteger(pid) || pid <= 0) return false;

        try {
            process.kill(pid, 0);
            return true;
        } catch (error: any) {
            return error?.code === "EPERM";
        }
    } catch {
        return false;
    }
}

function readLockOwnerId(lockPath: string): string | null {
    try {
        const [, , ownerId] = fs.readFileSync(lockPath, "utf8").split(" ");
        return ownerId ?? null;
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}
