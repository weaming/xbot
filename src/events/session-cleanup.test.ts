import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { EventLog } from "./event-log.js";
import {
    ARCHIVE_RETENTION_ENV,
    cleanupArchivedSessions,
    DEFAULT_ARCHIVE_RETENTION_DAYS,
    resolveRetentionDays,
    sessionArtifactPaths,
} from "./session-cleanup.js";
import { getSessionsDir } from "../utils/runtime-paths.js";

let tmpDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-cleanup-"));
    savedEnv = {
        WORKSPACE: process.env.WORKSPACE,
        XBOT_STATE_DIR: process.env.XBOT_STATE_DIR,
        TUI_CWD: process.env.TUI_CWD,
        [ARCHIVE_RETENTION_ENV]: process.env[ARCHIVE_RETENTION_ENV],
    };
    process.env.XBOT_STATE_DIR = tmpDir;
    delete process.env.TUI_CWD;
    process.env.WORKSPACE = tmpDir;
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

beforeEach(() => {
    fs.rmSync(path.join(tmpDir, "sessions"), { recursive: true, force: true });
    delete process.env[ARCHIVE_RETENTION_ENV];
});

/** 造一个会话，按给定事件序列落盘，并把全部落点的 mtime 调到指定时间。 */
async function makeSession(
    sessionId: string,
    events: Array<{
        type: "session_archived" | "session_unarchived" | "user_message" | "standalone_turn";
        ts: string;
        injected?: boolean;
    }>,
    mtime: Date,
): Promise<void> {
    const log = new EventLog();
    for (const event of events) {
        if (event.type === "user_message") {
            await log.append(sessionId, "user_message", { text: "hi", turnId: "T1" });
        } else if (event.type === "standalone_turn") {
            await log.append(sessionId, "standalone_turn", {
                messages: [{ role: "system", content: "[群聊状态更新]\n现在…" } as never],
                ...(event.injected ? { injected: true } : {}),
            });
        } else {
            await log.append(sessionId, event.type, {});
        }
    }
    // 事件 ts 由 append 生成，这里按需覆盖为期望时间：直接改写事件文件的 ts
    const eventFile = getSessionsDir("events", `${sessionId}.jsonl`);
    const lines = fs.readFileSync(eventFile, "utf8").split("\n").filter(Boolean);
    const rewritten = lines.map((line, index) => {
        const parsed = JSON.parse(line);
        const ts = events[index]?.ts;
        if (ts) parsed.ts = ts;
        return JSON.stringify(parsed);
    });
    fs.writeFileSync(eventFile, `${rewritten.join("\n")}\n`, "utf8");

    for (const target of sessionArtifactPaths(sessionId)) {
        if (target.endsWith(`${sessionId}`)) {
            // assets 目录
            fs.mkdirSync(target, { recursive: true });
            fs.writeFileSync(path.join(target, "a.jpg"), "x");
        } else if (target.endsWith(".json") || target.endsWith(".log") || target.endsWith(".lock")) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, "x");
        }
    }
    for (const target of sessionArtifactPaths(sessionId)) {
        if (fs.existsSync(target)) fs.utimesSync(target, mtime, mtime);
    }
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("resolveRetentionDays", () => {
    it("默认 14 天", () => {
        expect(resolveRetentionDays({})).toBe(DEFAULT_ARCHIVE_RETENTION_DAYS);
        expect(DEFAULT_ARCHIVE_RETENTION_DAYS).toBe(14);
    });

    it("环境变量覆盖，0 与负数表示不清理", () => {
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "3" })).toBe(3);
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "1.9" })).toBe(1);
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "0" })).toBe(0);
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "-5" })).toBe(-5);
    });

    it("非法值回退默认", () => {
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "abc" })).toBe(DEFAULT_ARCHIVE_RETENTION_DAYS);
        expect(resolveRetentionDays({ [ARCHIVE_RETENTION_ENV]: "  " })).toBe(DEFAULT_ARCHIVE_RETENTION_DAYS);
    });
});

describe("cleanupArchivedSessions", () => {
    it("删除过期归档会话的全部落点", async () => {
        await makeSession("old-archived", [{ type: "session_archived", ts: daysAgo(30).toISOString() }], daysAgo(30));

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual(["old-archived"]);
        expect(result.failed).toEqual([]);
        for (const target of sessionArtifactPaths("old-archived")) {
            expect(fs.existsSync(target)).toBe(false);
        }
    });

    it("未归档的会话再老也不动", async () => {
        await makeSession("old-active", [{ type: "user_message", ts: daysAgo(90).toISOString() }], daysAgo(90));

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(getSessionsDir("events", "old-active.jsonl"))).toBe(true);
    });

    it("归档未满保留期不删", async () => {
        await makeSession("recent-archived", [{ type: "session_archived", ts: daysAgo(3).toISOString() }], daysAgo(3));

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(getSessionsDir("events", "recent-archived.jsonl"))).toBe(true);
    });

    it("归档后又继续对话的会话不删（归档失效）", async () => {
        await makeSession(
            "reopened",
            [
                { type: "session_archived", ts: daysAgo(40).toISOString() },
                { type: "user_message", ts: daysAgo(1).toISOString() },
            ],
            daysAgo(1),
        );

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual([]);
    });

    it("取消归档后不删", async () => {
        await makeSession(
            "unarchived",
            [
                { type: "session_archived", ts: daysAgo(40).toISOString() },
                { type: "session_unarchived", ts: daysAgo(39).toISOString() },
            ],
            daysAgo(39),
        );

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual([]);
    });

    it("归档后的自动注入事件不让归档失效（真实场景：dream compiler）", async () => {
        // 归档后群里仍在落 [群聊状态更新]，注入事件不是用户活动，不能阻止清理
        await makeSession(
            "dream-compiler",
            [
                { type: "session_archived", ts: daysAgo(30).toISOString() },
                { type: "standalone_turn", ts: daysAgo(29).toISOString() },
                { type: "standalone_turn", ts: daysAgo(20).toISOString(), injected: true },
                { type: "standalone_turn", ts: daysAgo(10).toISOString() },
            ],
            daysAgo(10),
        );

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual(["dream-compiler"]);
    });

    it("归档后被注入事件带走后真的继续对话，仍不删", async () => {
        await makeSession(
            "resumed-after-archive",
            [
                { type: "session_archived", ts: daysAgo(40).toISOString() },
                { type: "standalone_turn", ts: daysAgo(39).toISOString() },
                { type: "user_message", ts: daysAgo(1).toISOString() },
                { type: "standalone_turn", ts: daysAgo(1).toISOString() },
            ],
            daysAgo(1),
        );

        const result = await cleanupArchivedSessions({ retentionDays: 14 });

        expect(result.removed).toEqual([]);
    });

    it("环境变量控制保留期", async () => {
        await makeSession("five-days", [{ type: "session_archived", ts: daysAgo(5).toISOString() }], daysAgo(5));

        process.env[ARCHIVE_RETENTION_ENV] = "3";
        const expired = await cleanupArchivedSessions();
        expect(expired.retentionDays).toBe(3);
        expect(expired.removed).toEqual(["five-days"]);
    });

    it("保留期为 0 时不清理", async () => {
        await makeSession("ancient", [{ type: "session_archived", ts: daysAgo(999).toISOString() }], daysAgo(999));

        const result = await cleanupArchivedSessions({ retentionDays: 0 });

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(getSessionsDir("events", "ancient.jsonl"))).toBe(true);
    });

    it("正在使用的会话永不删除", async () => {
        await makeSession("in-use", [{ type: "session_archived", ts: daysAgo(60).toISOString() }], daysAgo(60));

        const result = await cleanupArchivedSessions({ retentionDays: 14, protectedIds: ["in-use"] });

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(getSessionsDir("events", "in-use.jsonl"))).toBe(true);
    });

    it("事件目录不存在时静默返回", async () => {
        const result = await cleanupArchivedSessions({ retentionDays: 14 });
        expect(result.removed).toEqual([]);
        expect(result.failed).toEqual([]);
    });
});
