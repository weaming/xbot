import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { getTuiDraftsFile } from "../utils/tui-state-paths.js";
import { loadDrafts, persistDrafts } from "./draft-store.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-drafts-"));
    previousStateDir = process.env.XBOT_STATE_DIR;
    process.env.XBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    // 还原而非删除：preload 注入的隔离目录被删掉后，同进程后续测试会回退到真实 ~/.xbot。
    if (previousStateDir === undefined) {
        delete process.env.XBOT_STATE_DIR;
    } else {
        process.env.XBOT_STATE_DIR = previousStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("会话草稿持久化", () => {
    test("写回后可按 sessionId 读回", async () => {
        await persistDrafts(new Map([["s1", "草稿一"], ["s2", "草稿二"]]));

        const loaded = loadDrafts();
        expect(loaded.get("s1")).toBe("草稿一");
        expect(loaded.get("s2")).toBe("草稿二");
    });

    test("空草稿不落盘；文件缺失时返回空表", async () => {
        expect(loadDrafts().size).toBe(0);

        await persistDrafts(new Map([["s1", ""], ["s2", "有内容"]]));

        const loaded = loadDrafts();
        expect(loaded.has("s1")).toBe(false);
        expect(loaded.get("s2")).toBe("有内容");
    });

    test("损坏的 JSON 视为无草稿", () => {
        fs.mkdirSync(path.dirname(getTuiDraftsFile()), { recursive: true });
        fs.writeFileSync(getTuiDraftsFile(), "{ not json", "utf8");

        expect(loadDrafts().size).toBe(0);
    });
});
