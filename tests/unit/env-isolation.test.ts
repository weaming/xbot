/**
 * 隔离哨兵：测试进程的状态目录必须落在临时目录里。
 *
 * 历史事故：某测试文件在 afterEach 里 delete XBOT_STATE_DIR 而不还原 preload 值，
 * 同进程后续用例便回退到真实 ~/.xbot，把 test-model 的交换日志写进 sessions/http/cli.jsonl。
 * preload（tests/unit/env-isolation.ts）的全局 beforeEach 会补回缺失变量，这里断言该不变量成立。
 */

import { describe, expect, test } from "bun:test";
import os from "os";
import path from "path";

describe("测试环境隔离", () => {
    test("状态目录与工作目录不落真实 HOME", () => {
        const stateDir = process.env.XBOT_STATE_DIR;
        const workspace = process.env.WORKSPACE;
        expect(stateDir).toBeDefined();
        expect(workspace).toBeDefined();

        const realStateDir = path.join(os.homedir(), ".xbot");
        expect(stateDir!.startsWith(realStateDir)).toBe(false);
        expect(workspace!.startsWith(realStateDir)).toBe(false);
    });
});
