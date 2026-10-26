/**
 * TUI 进程专属 state 路径（state root 即 ~/.zbot，TUI 独占、无任何 tui/ 子目录）：
 *  - 输入历史 `input-history.json`（全局，条目按 sessionId 区分）
 *  - 会话草稿 `sessions/session-drafts.json`（与事件/交换日志同域）
 *  - 日志按 session 分离到 `sessions/log/<sessionId>.log`（与事件日志同域），
 *    启动阶段写 `startup.log`
 */

import os from "os";
import path from "path";

function resolveStateRoot(stateRoot?: string): string {
    return stateRoot
        ? path.resolve(stateRoot)
        : process.env.ZBOT_STATE_DIR
            ? path.resolve(process.env.ZBOT_STATE_DIR)
            : path.join(os.homedir(), ".zbot");
}

/** 启动阶段（session 未知）的 TUI 日志。 */
export function getTuiStartupLogFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "startup.log");
}

/** 单个会话的 TUI 日志：sessions/log/ 下，删除会话时一起清理。 */
export function getTuiSessionLogFile(sessionId: string): string {
    return path.join(resolveStateRoot(), "sessions", "log", `${sessionId}.log`);
}

export function getTuiInputHistoryFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "input-history.json");
}

/** 会话级输入草稿：落 sessions/ 下，切会话 / 重启后输入框内容不丢失。 */
export function getTuiDraftsFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "sessions", "session-drafts.json");
}

/** TUI 默认模型选择：所有未单独设置模型的会话共用。 */
export function getTuiModelPreferencesFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "model-preferences.json");
}

/** 滚轮诊断日志：独立文件，便于直接 cat 复制（定位"面板外滚动仍滚面板"用）。 */
export function getTuiWheelLogFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "logs", "tui-wheel.log");
}
