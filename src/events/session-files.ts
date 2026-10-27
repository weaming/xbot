/**
 * 会话落盘文件的目录级枚举：不依赖 EventLog 实例，命令行与 TUI 共用同一口径。
 */

import fs from "fs";
import { getSessionsDir } from "../utils/runtime-paths.js";

/**
 * 磁盘上已落盘的会话 id（按 events/<id>.jsonl 推断），目录不存在时为空。
 * 跳过流式片段的旁路文件 `<id>.stream.jsonl`：它是同一条会话的附属日志，不是独立会话。
 */
export function listSavedSessionIds(): string[] {
    try {
        return fs
            .readdirSync(getSessionsDir("events"))
            .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".stream.jsonl"))
            .map((name) => name.slice(0, -".jsonl".length));
    } catch {
        return [];
    }
}
