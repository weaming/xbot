/**
 * 会话级输入草稿持久化：把输入框内容按 sessionId 落盘，
 * 保证切换会话、归档、重启进程后切回来都不丢。
 * 写入沿用 input-history 的模式（文件锁 + 临时文件原子替换）。
 */

import fs from "fs";
import path from "path";
import { getTuiDraftsFile } from "../utils/tui-state-paths.js";
import { withFileLock } from "../utils/file-lock.js";
import type { ImageAssetRef, TuiDraft } from "../types/image.js";

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

/** 草稿值：纯文本，或带图片附件的文本。 */
export type DraftValue = TuiDraft | string;

export interface DraftStoreOptions {
    /** 落盘：收到展开过 marker 的草稿表。 */
    persist: (drafts: Map<string, TuiDraft>) => Promise<void>;
    /** 把草稿文本展开成可落盘的原文（编辑器持有 paste 缓存）。 */
    expand: (sessionId: string, text: string) => string;
    /** 防抖间隔，默认 300ms。 */
    debounceMs?: number;
}

export class DraftStore {
    private readonly drafts = new Map<string, DraftValue>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly debounceMs: number;

    constructor(private readonly options: DraftStoreOptions) {
        this.debounceMs = options.debounceMs ?? 300;
    }

    /** 记录（或覆盖）某个会话的草稿；空内容视为删除。 */
    set(sessionId: string, text: string, images: ImageAssetRef[] = []): void {
        const expandedText = this.options.expand(sessionId, text);
        if (!expandedText && images.length === 0) {
            this.drafts.delete(sessionId);
        } else {
            this.drafts.set(sessionId, images.length > 0
                ? { text: expandedText, images: [...images] }
                : expandedText);
        }
        this.schedule();
    }

    get(sessionId: string): DraftValue | undefined {
        return this.drafts.get(sessionId);
    }

    /** 删除草稿；返回是否确有变动（用于决定是否必要落盘）。 */
    delete(sessionId: string): boolean {
        if (!this.drafts.delete(sessionId)) return false;
        this.schedule();
        return true;
    }

    get size(): number {
        return this.drafts.size;
    }

    /**
     * 落盘用视图：把 marker 展开为原文。
     * 重启后没有 paste 缓存，只有展开后的文本才能原样还原。
     */
    forPersist(): Map<string, TuiDraft> {
        const result = new Map<string, TuiDraft>();
        for (const [sessionId, value] of this.drafts) {
            const draft = typeof value === "string" ? { text: value, images: [] } : value;
            result.set(sessionId, {
                text: this.options.expand(sessionId, draft.text),
                images: [...draft.images],
            });
        }
        return result;
    }

    /** 防抖落盘：连续输入只在停顿后写一次。 */
    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.options.persist(this.forPersist()).catch(() => {
                // 草稿落盘失败不应打断输入
            });
        }, this.debounceMs);
        this.timer.unref?.();
    }

    /** 立即落盘（退出前调用，保证最后一次输入不丢）。 */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            await this.options.persist(this.forPersist());
        } catch {
            // 草稿落盘失败不阻塞退出
        }
    }

    /** 丢弃定时器（测试与强制退出用）。 */
    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
