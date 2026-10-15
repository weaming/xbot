import path from "path";
import os from "os";
import { getAsyncToolCwd } from "./tool-cwd-context.js";

export function getWorkspaceRoot(): string {
    return path.resolve(expandEnv(process.env.WORKSPACE || "/app/workspace"));
}

export function getToolCwd(): string {
    const scopedCwd = getAsyncToolCwd();
    if (scopedCwd) return path.resolve(scopedCwd);
    return path.resolve(expandEnv(process.env.TUI_CWD || getWorkspaceRoot()));
}

/** 宿主机源码目录根（~/src 挂载点），容器内位于 workspace/src */
export function getSrcRoot(): string {
    return path.resolve(expandEnv(process.env.SRC_ROOT || "/app/workspace/src"));
}

/** @public */
export function getWorkspacePath(...parts: string[]): string {
    return path.join(getWorkspaceRoot(), ...parts);
}

export function getWorkspaceStateDir(...parts: string[]): string {
    const stateRoot = process.env.XBOT_STATE_DIR;
    return stateRoot
        ? path.join(path.resolve(expandEnv(stateRoot)), ...parts)
        : getWorkspacePath("state", ...parts);
}

export function getSkillsDir(...parts: string[]): string {
    return getWorkspacePath("skills", ...parts);
}

/** 用户级技能目录：优先 XBOT_STATE_DIR/skills（TUI 下即 ~/.xbot/skills），未设置时回退 workspace/skills。 */
export function getUserSkillsDir(...parts: string[]): string {
    const stateRoot = process.env.XBOT_STATE_DIR;
    return stateRoot
        ? path.join(path.resolve(expandEnv(stateRoot)), "skills", ...parts)
        : getWorkspacePath("skills", ...parts);
}

/** TUI 共享技能目录，兼容 ~/.agents/skills 中的用户级技能。 */
export function getAgentsSkillsDir(...parts: string[]): string {
    const homeDir = process.env.HOME || os.homedir();
    return path.join(homeDir, ".agents", "skills", ...parts);
}

const configuredMemoryUserId = Number.parseInt(process.env.XBOT_MEMORY_USER_ID || '0', 10);
export const DEFAULT_MEMORY_USER_ID = Number.isSafeInteger(configuredMemoryUserId) && configuredMemoryUserId >= 0
    ? configuredMemoryUserId
    : 0;

export function getMemoriesRootDir(...parts: string[]): string {
    return getWorkspacePath("memories", ...parts);
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
    const stateRoot = process.env.XBOT_STATE_DIR;
    return stateRoot
        ? path.join(path.resolve(expandEnv(stateRoot)), "sessions", ...parts)
        : getWorkspacePath("sessions", ...parts);
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
    return getWorkspaceStateDir("uploads", ...parts);
}

/** 展开 ${VAR} 形式的环境变量引用（compose 风格 .env 值在宿主机不会自动展开）。 */
function expandEnv(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}
