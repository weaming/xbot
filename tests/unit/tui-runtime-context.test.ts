import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { redirectTuiLogsToFile } from "../../src/tui/runtime-context.js";
import { getTuiStartupLogFile } from "../../src/utils/tui-state-paths.js";

describe("TUI 日志重定向", () => {
    let tmpDir: string;
    let previousStateDir: string | undefined;
    let restoreLogs: (() => void) | undefined;

    afterEach(() => {
        restoreLogs?.();
        restoreLogs = undefined;

        if (previousStateDir === undefined) {
            delete process.env.XBOT_STATE_DIR;
        } else {
            process.env.XBOT_STATE_DIR = previousStateDir;
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("将 debug 日志写入文件，避免污染 TUI 终端输出", () => {
        previousStateDir = process.env.XBOT_STATE_DIR;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-tui-log-"));
        process.env.XBOT_STATE_DIR = tmpDir;
        restoreLogs = redirectTuiLogsToFile();

        console.debug("MCP stderr");

        expect(fs.readFileSync(getTuiStartupLogFile(), "utf8")).toContain("MCP stderr");
    });
});
