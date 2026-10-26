import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    acquireSessionLock,
    getSessionLockFilePath,
    getSessionLockHolder,
    isProcessAlive,
    isSessionLockedByOtherSync,
    releaseSessionLock,
    tryAcquireSessionLock,
} from "../../src/utils/session-lock.js";

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-session-lock-test-"));
    originalStateDir = process.env.XBOT_STATE_DIR;
    process.env.XBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.XBOT_STATE_DIR;
    else process.env.XBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Session File Lock", () => {
    test("isProcessAlive 准确识别进程存活状态", () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(1)).toBe(true); // init/launchd 永远存活
        expect(isProcessAlive(9999999)).toBe(false); // 不存在的超大 PID
        expect(isProcessAlive(-1)).toBe(false);
    });

    test("获取与释放锁基本流程", async () => {
        const sessionId = "session-lock-1";
        const lockPath = getSessionLockFilePath(sessionId);

        const handle = await acquireSessionLock(sessionId);
        expect(fs.existsSync(lockPath)).toBe(true);

        const content = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(content.pid).toBe(process.pid);
        expect(content.sessionId).toBe(sessionId);

        await handle.release();
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    test("同进程支持重入", async () => {
        const sessionId = "session-lock-reentrant";
        const res1 = await tryAcquireSessionLock(sessionId);
        expect(res1.acquired).toBe(true);

        const res2 = await tryAcquireSessionLock(sessionId);
        expect(res2.acquired).toBe(true);

        await releaseSessionLock(sessionId);
        expect(fs.existsSync(getSessionLockFilePath(sessionId))).toBe(true);

        await releaseSessionLock(sessionId);
        expect(isSessionLockedByOtherSync(sessionId)).toBe(false);
        expect(fs.existsSync(getSessionLockFilePath(sessionId))).toBe(false);
    });

    test("其他活跃进程持有锁时获取失败", async () => {
        const sessionId = "session-lock-busy";
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });

        // 模拟 PID 1 (launchd/systemd，存活进程) 持有锁
        const fakeLock = {
            pid: 1,
            sessionId,
            lockedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(lockPath, JSON.stringify(fakeLock), "utf8");

        expect(isSessionLockedByOtherSync(sessionId)).toBe(true);
        expect(await getSessionLockHolder(sessionId)).toBe(1);

        const res = await tryAcquireSessionLock(sessionId);
        expect(res.acquired).toBe(false);
        expect(res.holderPid).toBe(1);
        expect(res.error).toContain("PID: 1");

        await expect(acquireSessionLock(sessionId)).rejects.toThrow("PID: 1");
    });

    test("已死亡进程的残留死锁能够被自动检测并清理", async () => {
        const sessionId = "session-lock-stale";
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });

        // 模拟已退出进程持有残留锁
        const deadPid = 9999999;
        const staleLock = {
            pid: deadPid,
            sessionId,
            lockedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(lockPath, JSON.stringify(staleLock), "utf8");

        // 存活检测自动判断为未占用
        expect(isSessionLockedByOtherSync(sessionId)).toBe(false);

        // 再次获取锁成功，并覆盖旧文件
        const handle = await acquireSessionLock(sessionId);
        const updated = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(updated.pid).toBe(process.pid);

        await handle.release();
    });

    test("损坏且未过期的锁文件会阻止获取并提示稍后重试", async () => {
        const sessionId = "session-lock-corrupted-fresh";
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "{", "utf8");

        expect(isSessionLockedByOtherSync(sessionId)).toBe(true);
        const result = await tryAcquireSessionLock(sessionId);

        expect(result.acquired).toBe(false);
        expect(result.error).toContain("请稍后重试");
    });

    test("损坏且过期的锁文件会被清理后重新获取", async () => {
        const sessionId = "session-lock-corrupted-stale";
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "{", "utf8");
        const staleAt = new Date(Date.now() - 30_000);
        fs.utimesSync(lockPath, staleAt, staleAt);

        const handle = await acquireSessionLock(sessionId);
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
        await handle.release();
    });

    test("PID 被复用时会清理当前 PID 的残留锁并重新获取", async () => {
        const sessionId = "session-lock-pid-reused";
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            sessionId,
            lockedAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
            ownerId: "previous-process-owner",
        }), "utf8");

        const handle = await acquireSessionLock(sessionId);
        const updated = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(updated.pid).toBe(process.pid);
        expect(updated.ownerId).not.toBe("previous-process-owner");
        await handle.release();
    });

    test("ownerId 不匹配时释放不会删除他人新锁", async () => {
        const sessionId = "session-lock-owner-mismatch";
        const lockPath = getSessionLockFilePath(sessionId);
        const handle = await acquireSessionLock(sessionId);
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        fs.writeFileSync(lockPath, JSON.stringify({
            ...current,
            ownerId: "new-owner",
        }), "utf8");

        await handle.release();

        expect(fs.existsSync(lockPath)).toBe(true);
    });
});
