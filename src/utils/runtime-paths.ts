import path from "path";
import os from "os";
import { getAsyncToolCwd } from "./tool-cwd-context.js";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".xbot");

export function getStateDir(...parts: string[]): string {
    const stateRoot = process.env.XBOT_STATE_DIR || DEFAULT_STATE_DIR;
    return path.join(path.resolve(expandEnv(stateRoot)), ...parts);
}

export function getToolCwd(): string {
    const scopedCwd = getAsyncToolCwd();
    if (scopedCwd) return path.resolve(scopedCwd);

    const tuiCwd = process.env.TUI_CWD || process.cwd();
    return path.resolve(expandEnv(tuiCwd));
}

export function getUserSkillsDir(...parts: string[]): string {
    return getStateDir("skills", ...parts);
}

/** TUI 共享技能目录，兼容 ~/.agents/skills 中的用户级技能。 */
export function getAgentsSkillsDir(...parts: string[]): string {
    const homeDir = process.env.HOME || os.homedir();
    return path.join(homeDir, ".agents", "skills", ...parts);
}

const configuredMemoryUserId = Number.parseInt(process.env.XBOT_MEMORY_USER_ID || "0", 10);
export const DEFAULT_MEMORY_USER_ID = Number.isSafeInteger(configuredMemoryUserId) && configuredMemoryUserId >= 0
    ? configuredMemoryUserId
    : 0;

export function getMemoriesRootDir(...parts: string[]): string {
    return getStateDir("memories", ...parts);
}

export function normalizeMemoryUserId(userId?: number | string): number {
    if (userId === undefined || userId === "") return DEFAULT_MEMORY_USER_ID;

    const parsedUserId = typeof userId === "number" ? userId : Number(userId);
    return Number.isSafeInteger(parsedUserId) && parsedUserId >= 0
        ? parsedUserId
        : DEFAULT_MEMORY_USER_ID;
}

export function getUserMemoriesDir(userId: number, ...parts: string[]): string {
    return getMemoriesRootDir(String(userId), ...parts);
}

export function getUserMemoryFilePath(userId: number): string {
    return getUserMemoriesDir(userId, "MEMORY.md");
}

export function getSessionsDir(...parts: string[]): string {
    return getStateDir("sessions", ...parts);
}

/** 会话任务清单目录：sessions/todos/。 */
export function getSessionTodosDir(...parts: string[]): string {
    return getSessionsDir("todos", ...parts);
}

/** 单个会话的任务清单文件：sessions/todos/<sessionId>.json（删除会话时一并清理）。 */
export function getSessionTodosFile(sessionId: string): string {
    return getSessionTodosDir(`${sessionId}.json`);
}

export function getUploadsDir(...parts: string[]): string {
    return getStateDir("uploads", ...parts);
}

/** 展开 ${VAR} 形式的环境变量引用。 */
function expandEnv(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}
