/**
 * 会话控制 socket 的路径约定：sessions/control/<sessionId>.sock。
 *
 * 会话归属完全由这个文件本身表达（bind 成功即持有），不引入任何 sidecar 元数据文件：
 * 归属探测靠 connect，持有者身份靠握手，stale 判定靠 connect 失败。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";

const SOCKET_SUFFIX = ".sock";

/** socket 目录：sessions/control/。 */
function getControlDir(): string {
    return getSessionsDir("control");
}

/** 单个会话的控制 socket 路径。 */
export function getSocketPath(sessionId: string): string {
    return path.join(getControlDir(), `${sanitizeSessionId(sessionId)}${SOCKET_SUFFIX}`);
}

/** 按需创建 socket 目录。 */
export function ensureControlDir(): void {
    fs.mkdirSync(getControlDir(), { recursive: true });
}

/** 列出磁盘上存在 socket 文件的会话 id；目录不存在时返回空数组。 */
export function listSocketSessionIds(): string[] {
    try {
        return fs
            .readdirSync(getControlDir())
            .filter((name) => name.endsWith(SOCKET_SUFFIX))
            .map((name) => name.slice(0, -SOCKET_SUFFIX.length));
    } catch {
        return [];
    }
}
