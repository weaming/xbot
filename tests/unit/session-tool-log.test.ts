/**
 * 任务会话的工具日志：serve 里跑的任务也要留下 sessions/log/<sessionId>.log。
 *
 * TUI 靠全局 console 重定向拿到日志；serve 并发跑任务不能这么干（A 的日志会写进 B 的文件），
 * 所以按任务上下文里的 sessionId 直接追加。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withJobContext } from "../../src/tools/job-context.js";
import { appendSessionToolLog } from "../../src/tools/session-log.js";
import { getSessionLogFile } from "../../src/utils/state-paths.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-session-log-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = stateDir;
});

afterEach(() => {
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("appendSessionToolLog", () => {
    test("任务上下文里按 sessionId 落盘，带 ISO 时间戳", async () => {
        await withJobContext({ jobId: "job-1", sessionId: "sess-42" }, async () => {
            appendSessionToolLog("✅ [Tool] bash success: /tmp");
        });

        const file = getSessionLogFile("sess-42");
        const content = fs.readFileSync(file, "utf8");
        expect(content).toContain("✅ [Tool] bash success: /tmp");
        // 行首时间戳：YYYY-MM-DD HH:MM:SS
        expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
    });

    test("并发任务各写各的文件，不串味", async () => {
        await Promise.all([
            withJobContext({ jobId: "job-a", sessionId: "sess-a" }, async () => {
                appendSessionToolLog("A 的工具日志");
            }),
            withJobContext({ jobId: "job-b", sessionId: "sess-b" }, async () => {
                appendSessionToolLog("B 的工具日志");
            }),
        ]);

        expect(fs.readFileSync(getSessionLogFile("sess-a"), "utf8")).toContain("A 的工具日志");
        expect(fs.readFileSync(getSessionLogFile("sess-b"), "utf8")).toContain("B 的工具日志");
        expect(fs.readFileSync(getSessionLogFile("sess-a"), "utf8")).not.toContain("B 的工具日志");
    });

    test("不在任务上下文（TUI 交互会话）时什么都不写", () => {
        appendSessionToolLog("不应该落盘");

        expect(fs.existsSync(path.join(stateDir, "sessions", "log"))).toBe(false);
    });
});
