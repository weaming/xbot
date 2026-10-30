import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { redirectLogsToFile, setLogSession } from "../../src/host/runtime-context.js";
import { getSessionLogFile, getStartupLogFile } from "../../src/utils/state-paths.js";

describe("TUI 日志重定向", () => {
    let tmpDir: string;
    let previousStateDir: string | undefined;
    let restoreLogs: (() => void) | undefined;

    afterEach(() => {
        restoreLogs?.();
        restoreLogs = undefined;

        if (previousStateDir === undefined) {
            delete process.env.ZBOT_STATE_DIR;
        } else {
            process.env.ZBOT_STATE_DIR = previousStateDir;
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("将 debug 日志写入文件，避免污染 TUI 终端输出", () => {
        previousStateDir = process.env.ZBOT_STATE_DIR;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-log-"));
        process.env.ZBOT_STATE_DIR = tmpDir;
        restoreLogs = redirectLogsToFile();

        console.debug("MCP stderr");

        expect(fs.readFileSync(getStartupLogFile(), "utf8")).toContain("MCP stderr");
    });

    test("删除当前会话前切回启动日志，避免重建已删除的会话日志", () => {
        previousStateDir = process.env.ZBOT_STATE_DIR;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-log-delete-"));
        process.env.ZBOT_STATE_DIR = tmpDir;
        restoreLogs = redirectLogsToFile();
        setLogSession("sess-deleted");
        console.debug("before delete");

        const sessionFile = getSessionLogFile("sess-deleted");
        fs.unlinkSync(sessionFile);
        setLogSession(null);
        console.debug("after delete");

        expect(fs.existsSync(sessionFile)).toBe(false);
        expect(fs.readFileSync(getStartupLogFile(), "utf8")).toContain("after delete");
    });
});
