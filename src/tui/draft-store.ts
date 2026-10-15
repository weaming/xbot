/**
 * 会话级输入草稿持久化：把输入框内容按 sessionId 落盘，
 * 保证切换会话、归档、重启进程后切回来都不丢。
 * 写入沿用 input-history 的模式（文件锁 + 临时文件原子替换）。
 */

import fs from "fs";
import path from "path";
import { getTuiDraftsFile } from "../utils/tui-state-paths.js";
import { withFileLock } from "../utils/file-lock.js";
import type { TuiDraft } from "../types/image.js";

/** 读取全部草稿；文件缺失或损坏时返回空表。 */
export function loadDrafts(): Map<string, string> {
    try {
        const parsed = JSON.parse(fs.readFileSync(getTuiDraftsFile(), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const drafts = new Map<string, string>();
            for (const [sessionId, text] of Object.entries(parsed)) {
                if (typeof text === "string" && text) drafts.set(sessionId, text);
            }
            return drafts;
        }
    } catch {
        // 文件不存在或损坏时视为无草稿。
    }
    return new Map();
}

/** 全量写回草稿表（空草稿不落盘）。 */
export async function persistDrafts(drafts: Map<string, string>): Promise<void> {
    const file = getTuiDraftsFile();
    await withFileLock(file, () => {
        const payload: Record<string, string> = {};
        for (const [sessionId, text] of drafts) {
            if (text) payload[sessionId] = text;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
        fs.renameSync(tmp, file);
    });
}

/** 读取包含图片附件的新草稿格式；兼容旧字符串草稿。 */
export function loadRichDrafts(): Map<string, TuiDraft | string> {
    try {
        const parsed = JSON.parse(fs.readFileSync(getTuiDraftsFile(), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const drafts = new Map<string, TuiDraft | string>();
            for (const [sessionId, value] of Object.entries(parsed)) {
                if (typeof value === "string" && value) {
                    drafts.set(sessionId, value);
                    continue;
                }
                if (!value || typeof value !== "object") continue;
                const draft = value as Partial<TuiDraft>;
                if (typeof draft.text !== "string") continue;
                const images = Array.isArray(draft.images) ? draft.images : [];
                drafts.set(sessionId, { text: draft.text, images: images as TuiDraft["images"] });
            }
            return drafts;
        }
    } catch {
        // 文件不存在或损坏时视为无草稿。
    }
    return new Map();
}

/** 写入包含图片附件的草稿；空文本和空附件都不落盘。 */
export async function persistRichDrafts(drafts: Map<string, TuiDraft | string>): Promise<void> {
    const file = getTuiDraftsFile();
    await withFileLock(file, () => {
        const payload: Record<string, TuiDraft | string> = {};
        for (const [sessionId, draftValue] of drafts) {
            const draft = typeof draftValue === "string"
                ? { text: draftValue, images: [] }
                : draftValue;
            if (draft.text || draft.images.length > 0) {
                payload[sessionId] = draft.images.length > 0 ? draft : draft.text;
            }
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
        fs.renameSync(tmp, file);
    });
}
