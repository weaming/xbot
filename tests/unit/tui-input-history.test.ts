import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TUI 输入历史测试：全局单文件、条目按 sessionId 区分；
 * 滚动顺序 = 当前 session 倒序 + 其他 session 按时间倒序合并（含已删除 session）。
 */

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-input-history-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TUI 输入历史", () => {
    test("当前 session 历史优先，其他 session 按时间倒序补充（含已删除 session）", async () => {
        const { appendInputHistory, loadInputHistory } = await import("../../src/host/input-history.js");
        const sessionA = "01A";
        const sessionB = "01B";
        const deletedSession = "01C";

        await appendInputHistory(sessionA, "a1");
        await appendInputHistory(sessionB, "b1");
        await appendInputHistory(deletedSession, "c1");
        await appendInputHistory(sessionA, "a2");

        // A 的条目（最近的在前）+ 其他 session（含已删除的 C）按时间倒序
        const history = loadInputHistory(sessionA);
        expect(history[0]).toBe("a2");
        expect(history[1]).toBe("a1");
        expect(history.slice(2).sort()).toEqual(["b1", "c1"]);
    });

    test("刚启动的空 session 直接回滚其他 session 合并历史", async () => {
        const { appendInputHistory, loadInputHistory } = await import("../../src/host/input-history.js");
        await appendInputHistory("01A", "a1");
        await appendInputHistory("01B", "b1");
        await appendInputHistory("01A", "a2");

        const history = loadInputHistory("fresh-session");
        expect(history).toEqual(["a2", "b1", "a1"]);
    });

    test("同 session 最近一条重复时不重复写入", async () => {
        const { appendInputHistory, loadInputHistory } = await import("../../src/host/input-history.js");
        await appendInputHistory("01A", "same");
        await appendInputHistory("01A", "same");
        await appendInputHistory("01B", "same");

        // 各自 session 一条；滚动时 A 的在前、B 的作为其他 session 补充。
        expect(loadInputHistory("01A")).toEqual(["same", "same"]);
        expect(loadInputHistory("01B")).toEqual(["same", "same"]);
    });

    test("兼容旧 string[] 格式，旧条目归入其他 session 列表", async () => {
        fs.writeFileSync(path.join(tmpDir, "input-history.json"), JSON.stringify(["legacy-a", "legacy-b"]));
        const { loadInputHistory } = await import("../../src/host/input-history.js");

        const history = loadInputHistory("01A");
        expect(history).toEqual(["legacy-a", "legacy-b"]);
    });

    test("并发追加不丢失条目（文件锁读改写）", async () => {
        const { appendInputHistory, loadInputHistory } = await import("../../src/host/input-history.js");

        await Promise.all([
            appendInputHistory("01A", "x1"),
            appendInputHistory("01A", "x2"),
            appendInputHistory("01B", "y1"),
        ]);

        // 并发写入顺序不定，滚动列表含其他 session 的 y1；断言不丢条目即可。
        const history = loadInputHistory("01A");
        expect(history).toContain("x1");
        expect(history).toContain("x2");
        expect(history).toContain("y1");
        expect(loadInputHistory("01B")).toContain("y1");
    });
});
