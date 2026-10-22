/** TUI 全局输入历史：单文件、条目按 sessionId 区分，跨实例文件锁保护。 */

import fs from "fs";
import path from "path";
import { getTuiInputHistoryFile } from "../utils/tui-state-paths.js";
import { withFileLock } from "../utils/file-lock.js";

const MAX_HISTORY = 100;

interface InputHistoryEntry {
    sessionId: string;
    text: string;
    /** ISO 时间戳；旧格式迁移条目为空字符串，排序时排最后。 */
    ts: string;
}

function readEntries(): InputHistoryEntry[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(getTuiInputHistoryFile(), "utf8"));
        if (Array.isArray(parsed)) {
            return parsed
                .map((entry) => {
                    if (typeof entry === "string") return { sessionId: "", text: entry, ts: "" };
                    if (entry && typeof entry.text === "string") {
                        return { sessionId: String(entry.sessionId ?? ""), text: entry.text, ts: String(entry.ts ?? "") };
                    }
                    return null;
                })
                .filter((entry): entry is InputHistoryEntry => entry !== null);
        }
    } catch {
        // 文件不存在或损坏时视为空历史。
    }
    return [];
}

/**
 * 按 ↑ 回滚顺序返回历史：当前 session 的条目（最近的在前）优先，
 * 滚动结束后接其他 session 合并列表（按时间倒序）——刚启动的新 session
 * 自然落在其他 session 的历史上。
 */
export function loadInputHistory(sessionId: string): string[] {
    const entries = readEntries();
    const byTimeDesc = (left: InputHistoryEntry, right: InputHistoryEntry): number => right.ts.localeCompare(left.ts);
    const current = entries.filter(entry => entry.sessionId === sessionId).sort(byTimeDesc);
    const others = entries.filter(entry => entry.sessionId !== sessionId).sort(byTimeDesc);
    return [...current, ...others].slice(0, MAX_HISTORY).map(entry => entry.text);
}

/** 追加一条输入：文件锁内读改写 + 原子替换（临时文件 rename）。 */
export async function appendInputHistory(sessionId: string, text: string, ts = new Date().toISOString()): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    await withFileLock(getTuiInputHistoryFile(), () => {
        const entries = readEntries();
        const latestOfSession = entries.find(entry => entry.sessionId === sessionId);
        if (latestOfSession?.text === trimmed) return;

        entries.unshift({ sessionId, text: trimmed, ts });
        entries.sort((left, right) => right.ts.localeCompare(left.ts));
        if (entries.length > MAX_HISTORY) entries.length = MAX_HISTORY;

        const filePath = getTuiInputHistoryFile();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
        fs.renameSync(tmpPath, filePath);
    });
}
