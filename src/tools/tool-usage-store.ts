import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { withFileLock } from "../utils/file-lock.js";

export interface ToolUsageEntry {
    lastUsed: number;
    count: number;
}

export class ToolUsageStore {
    private readonly usageByToolName = new Map<string, ToolUsageEntry>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    load(): void {
        this.ensureStateDir();

        try {
            if (!fs.existsSync(this.filePath)) {
                return;
            }

            const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            for (const [name, raw] of Object.entries(data)) {
                // 兼容旧格式 {name: timestamp}：无次数信息，按 1 次计
                if (typeof raw === "number") {
                    this.usageByToolName.set(name, { lastUsed: raw, count: 1 });
                } else if (raw && typeof (raw as ToolUsageEntry).lastUsed === "number") {
                    const entry = raw as ToolUsageEntry;
                    this.usageByToolName.set(name, {
                        lastUsed: entry.lastUsed,
                        count: typeof entry.count === "number" ? entry.count : 1,
                    });
                }
            }
            console.log(`✅ [ToolLRU] Loaded ${this.usageByToolName.size} tool usage records`);
        } catch (error) {
            console.warn("⚠️ [ToolLRU] Failed to load:", error);
        }
    }

    getUsageMap(): ReadonlyMap<string, ToolUsageEntry> {
        return this.usageByToolName;
    }

    recordUsage(toolName: string): void {
        const entry = this.usageByToolName.get(toolName);
        this.usageByToolName.set(toolName, {
            lastUsed: Date.now(),
            count: (entry?.count ?? 0) + 1,
        });

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(() => this.save(), 2000);
    }

    private async save(): Promise<void> {
        try {
            await withFileLock(this.filePath, () => {
                this.ensureStateDir();
                const data: Record<string, ToolUsageEntry> = {};
                // 合并磁盘上其他实例写入的条目（多实例共享同一全局 LRU 文件），
                // 避免本实例写回覆盖对方的统计。
                try {
                    if (fs.existsSync(this.filePath)) {
                        const onDisk = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
                        for (const [name, raw] of Object.entries(onDisk)) {
                            if (!this.usageByToolName.has(name)) {
                                if (typeof raw === "number") {
                                    data[name] = { lastUsed: raw, count: 1 };
                                } else if (raw && typeof (raw as ToolUsageEntry).lastUsed === "number") {
                                    data[name] = raw as ToolUsageEntry;
                                }
                            }
                        }
                    }
                } catch {
                    // 磁盘文件损坏时忽略，仅写内存记录。
                }
                for (const [name, entry] of this.usageByToolName) {
                    data[name] = entry;
                }
                fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
            });
        } catch (error) {
            console.warn("⚠️ [ToolLRU] Failed to save:", error);
        }
    }

    private ensureStateDir(): void {
        try {
            const stateDir = path.dirname(this.filePath);
            fs.mkdirSync(stateDir, { recursive: true });
        } catch (error: any) {
            if (error.code !== "EROFS" && error.code !== "EEXIST") {
                console.warn("⚠️ [ToolLRU] Failed to create state directory:", error);
            }
        }
    }
}

// 工具 LRU 落在会话存储目录下。
// 各自一棵树，不污染 workspace 根目录；多实例写同一文件时靠文件锁合并。
const defaultLruFile = path.join(getSessionsDir(), "tool-lru.json");
export const toolUsageStore = new ToolUsageStore(defaultLruFile);
toolUsageStore.load();
