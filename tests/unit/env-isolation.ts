/** 测试环境隔离：在模块加载前剔除宿主环境变量，保证断言不受外部配置影响。 */

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach } from "bun:test";

delete process.env.CONTEXT_WINDOW_TOKENS;
delete process.env.XBOT_IDENTITY_FILE;
delete process.env.XBOT_EXTRA_IDENTITY_FILE;

// 单测默认关掉真实分词器：token 计数断言基于固定估算口径，
// 真实分词的精度与回退由 tests/unit/tokenizer.test.ts 单独覆盖。
process.env.XBOT_TOKENIZER = "off";
process.env.XBOT_MEMORY_USER_ID = "0";

// 宿主 shell 常导出 XBOT_STATE_DIR（如 ~/.xbot），直接用会写到真实状态目录；
// 也不能简单 delete——logger 的 exchange 路径在无变量时会回退 ~/.xbot。
// 统一指向临时目录，让 getSessionsDir 与 logger 落在同一棵隔离树里。
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-test-state-"));
process.env.XBOT_STATE_DIR = testStateDir;

// WORKSPACE 同理：无 XBOT_STATE_DIR 时 getSessionsDir 回退到 WORKSPACE/sessions，
// 不隔离会写进宿主真实的 ~/.xbot/workspace。
const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-test-workspace-"));
process.env.WORKSPACE = testWorkspace;

// 兜底：若某测试文件把隔离变量删掉（afterEach 未还原 preload 值），同进程后续用例
// 就会回退到真实 ~/.xbot；每个用例前仅在缺失时补回，不覆盖用例自设的临时目录。
beforeEach(() => {
    if (process.env.XBOT_STATE_DIR === undefined) process.env.XBOT_STATE_DIR = testStateDir;
    if (process.env.WORKSPACE === undefined) process.env.WORKSPACE = testWorkspace;
    if (process.env.XBOT_TOKENIZER === undefined) process.env.XBOT_TOKENIZER = "off";
});

process.on("exit", () => {
    try {
        fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {
        // 清理失败不影响测试结果
    }
    try {
        fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
        // 清理失败不影响测试结果
    }
});
