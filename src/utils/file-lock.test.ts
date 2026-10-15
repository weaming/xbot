import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { withFileLock } from "./file-lock.js";

describe("跨进程文件锁", () => {
    it("串行执行同一文件的临界区", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-file-lock-"));
        const file = path.join(dir, "state.json");
        let activeCount = 0;
        let maxActiveCount = 0;

        try {
            await Promise.all([
                withFileLock(file, async () => {
                    activeCount += 1;
                    maxActiveCount = Math.max(maxActiveCount, activeCount);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    activeCount -= 1;
                }),
                withFileLock(file, async () => {
                    activeCount += 1;
                    maxActiveCount = Math.max(maxActiveCount, activeCount);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    activeCount -= 1;
                }),
            ]);

            expect(maxActiveCount).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("清理已退出进程留下的过期锁", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-file-lock-"));
        const file = path.join(dir, "state.json");
        const lockFile = `${file}.lock`;

        try {
            fs.writeFileSync(lockFile, "2147483647 0 abandoned-owner");
            const staleTime = new Date(Date.now() - 20_000);
            fs.utimesSync(lockFile, staleTime, staleTime);

            await withFileLock(file, () => {
                expect(fs.existsSync(lockFile)).toBe(true);
            });

            expect(fs.existsSync(lockFile)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("释放时保留由其他持有者创建的新锁", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-file-lock-"));
        const file = path.join(dir, "state.json");
        const lockFile = `${file}.lock`;

        try {
            await withFileLock(file, () => {
                fs.unlinkSync(lockFile);
                fs.writeFileSync(lockFile, "2147483647 0 replacement-owner", { flag: "wx" });
            });

            expect(fs.readFileSync(lockFile, "utf8")).toBe("2147483647 0 replacement-owner");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
