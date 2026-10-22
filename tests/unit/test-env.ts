/**
 * 测试环境隔离：把会话/状态目录指向临时目录，并在清理时恢复原值。
 *
 * 必须同时处理 WORKSPACE 与 XBOT_STATE_DIR：getSessionsDir 优先读后者，
 * 只设 WORKSPACE 时若宿主 shell 导出了 XBOT_STATE_DIR，测试会写到真实 ~/.xbot。
 * （bunfig.toml 的 preload 已全局删除一次，这里再显式处理，保证单文件直跑也安全。）
 */

import fs from "fs";
import os from "os";
import path from "path";

export interface TmpWorkspace {
    /** 临时目录绝对路径。 */
    dir: string;
    /** 删除临时目录并恢复环境变量。 */
    cleanup: () => void;
}

/** 创建临时 workspace 并设为会话目录根。 */
export function useTmpWorkspace(prefix: string): TmpWorkspace {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const previousWorkspace = process.env.WORKSPACE;
    const previousStateDir = process.env.XBOT_STATE_DIR;

    process.env.WORKSPACE = dir;
    // logger 的 exchange 路径只认 XBOT_STATE_DIR（不读 WORKSPACE），同步指向临时目录保证两者同源。
    process.env.XBOT_STATE_DIR = dir;

    return {
        dir,
        cleanup: () => {
            fs.rmSync(dir, { recursive: true, force: true });
            restoreEnv("WORKSPACE", previousWorkspace);
            restoreEnv("XBOT_STATE_DIR", previousStateDir);
        },
    };
}

/** 恢复环境变量：原值为 undefined 时删除而不是写回字符串 "undefined"。 */
export function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

/**
 * 模型/思考强度相关的环境变量。
 * 宿主 shell 常导出 OPENAI_CHAT_MODEL 之类的真实配置，
 * 不隔离时 getChatApiSettings 会返回宿主的模型，断言"默认模型"必然失败。
 */
export const MODEL_ENV_KEYS = [
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_CHAT_MODEL",
    "OPENAI_CHAT_MODELS",
    "OPENAI_CHAT_API_KEY",
    "OPENAI_CHAT_BASE_URL",
    "OPENAI_CHAT_EFFORTS",
    "OPENAI_RESPONSES_MODEL",
    "OPENAI_RESPONSES_MODELS",
    "OPENAI_RESPONSES_API_KEY",
    "OPENAI_RESPONSES_BASE_URL",
    "OPENAI_RESPONSES_EFFORTS",
    "REASONING_EFFORT",
    "OPENAI_REASONING_EFFORT",
    "DEEPSEEK_REASONING_EFFORT",
    "ENABLE_DS_COST_STAT",
] as const;

/**
 * 清空模型配置环境变量，返回恢复函数。
 * 用法：`const restore = isolateModelEnv(); ... ; restore()`。
 */
export function isolateModelEnv(): () => void {
    const saved = new Map<string, string | undefined>();
    for (const name of MODEL_ENV_KEYS) {
        saved.set(name, process.env[name]);
        delete process.env[name];
    }

    return () => {
        for (const [name, value] of saved) {
            restoreEnv(name, value);
        }
    };
}
