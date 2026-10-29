import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    getDraftsFile,
    getInputHistoryFile,
    getSessionLogFile,
    getStartupLogFile,
} from "../../src/utils/state-paths.js";

/**
 * TUI state 路径布局测试：进程级状态平铺在 state root 根目录，
 * 会话草稿/日志与事件日志同域（sessions/）。
 */

let stateRoot: string;
let previousStateDir: string | undefined;

beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-state-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = stateRoot;
});

afterEach(() => {
    // 还原而非删除：preload 注入的隔离目录被删掉后，同进程后续测试会回退到真实 ~/.zbot。
    if (previousStateDir === undefined) {
        delete process.env.ZBOT_STATE_DIR;
    } else {
        process.env.ZBOT_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe("state-paths", () => {
    test("进程级状态文件平铺在 state root 根目录", () => {
        expect(getStartupLogFile(stateRoot)).toBe(path.join(stateRoot, "startup.log"));
        expect(getInputHistoryFile(stateRoot)).toBe(path.join(stateRoot, "input-history.json"));
    });

    test("会话草稿与日志在 sessions/ 下，路径不含 tui/", () => {
        expect(getDraftsFile(stateRoot)).toBe(path.join(stateRoot, "sessions", "session-drafts.json"));
        expect(getSessionLogFile("01JABC")).toBe(path.join(stateRoot, "sessions", "log", "01JABC.log"));
    });
});
