import { BaseSkill, parseSkillMarkdown } from "./base-skill.js";
import { readdirSync, existsSync, statSync } from "fs";
import path from "path";
import chokidar from "chokidar";
import { getAgentsSkillsDir, getSkillsDir, getUserSkillsDir } from "../utils/runtime-paths.js";

/** 技能根目录列表：用户级优先，workspace 级兜底（同名技能以用户级为准）。 */
function getSkillRegistryDirs(): string[] {
    const dirs = [getUserSkillsDir()];
    if (process.env.TUI_PLATFORM) dirs.push(getAgentsSkillsDir());
    dirs.push(getSkillsDir());
    return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

// 技能更新状态追踪
interface SkillMeta {
    name: string;
    description: string;
    mtime: number;
}

export class SkillRegistry {
    private skills: Map<string, BaseSkill> = new Map();
    private skillMetas: Map<string, SkillMeta> = new Map();
    private skillDirs: Map<string, string> = new Map();

    async init(): Promise<void> {
        await this.load();
        this.startFileWatcher();
    }

    private startFileWatcher(): void {
        const patterns = getSkillRegistryDirs().map((dir) => path.join(dir, "**", "SKILL.md"));
        if (patterns.length === 0) return;

        try {
            const watcher = chokidar.watch(patterns, {
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 1000,
                    pollInterval: 100,
                },
            });

            watcher
                .on("add", () => {
                    console.log(`📝 [Skills] added, reloading...`);
                    this.load().catch((err) => {
                        console.error("❌ [Skills] File watcher reload failed:", err.message);
                    });
                })
                .on("change", () => {
                    console.log(`📝 [Skills] changed, reloading...`);
                    this.load().catch((err) => {
                        console.error("❌ [Skills] File watcher reload failed:", err.message);
                    });
                })
                .on("unlink", () => {
                    console.log(`📝 [Skills] removed, reloading...`);
                    this.load().catch((err) => {
                        console.error("❌ [Skills] File watcher reload failed:", err.message);
                    });
                })
                .on("error", (err: unknown) => {
                    console.warn(`⚠️ [Skills] File watcher error:`, (err as Error).message);
                });

            console.log(`👁️ [Skills] File watcher started on ${getSkillRegistryDirs().join(", ")}`);
        } catch (err) {
            console.warn(`⚠️ [Skills] Failed to start file watcher:`, err);
        }
    }

    async load(): Promise<void> {
        const next = new Map<string, BaseSkill>();
        const newMetas = new Map<string, SkillMeta>();
        const newSkillDirs = new Map<string, string>();

        // 用户级目录先加载，同名技能在 workspace 级跳过
        for (const dir of getSkillRegistryDirs()) {
            this.loadSkillDir(dir, next, newMetas, newSkillDirs);
        }

        // 检查新增或更新的技能
        const changes: string[] = [];
        for (const [name, meta] of newMetas) {
            const old = this.skillMetas.get(name);
            if (!old) {
                changes.push(`+ ${name}`);
            } else if (old.mtime !== meta.mtime) {
                changes.push(`~ ${name}`);
            }
        }

        // 检查已删除的技能
        for (const name of this.skillMetas.keys()) {
            if (!newMetas.has(name)) {
                changes.push(`- ${name}`);
            }
        }

        if (changes.length > 0) {
            console.log(`📦 [Skills] ${changes.join(", ")}`);
        }

        this.skills = next;
        this.skillMetas = newMetas;
        this.skillDirs = newSkillDirs;
    }

    private loadSkillDir(
        skillDir: string,
        next: Map<string, BaseSkill>,
        newMetas: Map<string, SkillMeta>,
        newSkillDirs: Map<string, string>,
    ): void {
        if (!existsSync(skillDir)) return;

        for (const entry of readdirSync(skillDir).sort()) {
            const fullPath = path.join(skillDir, entry);
            if (!statSync(fullPath).isDirectory()) continue;

            const skillMdPath = path.join(fullPath, "SKILL.md");
            if (!existsSync(skillMdPath)) continue;

            try {
                const stat = statSync(skillMdPath);
                const config = parseSkillMarkdown(fullPath);
                if (next.has(config.name)) continue;

                next.set(config.name, new BaseSkill(config));
                newMetas.set(config.name, {
                    name: config.name,
                    description: config.description,
                    mtime: stat.mtimeMs,
                });
                newSkillDirs.set(config.name, fullPath);
            } catch (err: any) {
                console.error(`❌ [Skills] Failed to load "${entry}" (${skillDir}):`, err.message);
            }
        }
    }

    async reload(): Promise<string[]> {
        await this.load();
        return Array.from(this.skills.keys());
    }

    register(skill: BaseSkill): void {
        this.skills.set(skill.config.name, skill);
    }

    getSkill(name: string): BaseSkill | undefined {
        return this.skills.get(name);
    }

    getAllSkills(): BaseSkill[] {
        return Array.from(this.skills.values());
    }

    getSkillNames(): string[] {
        return Array.from(this.skills.keys());
    }

    getSkillEnum(): string[] {
        return Array.from(this.skills.keys());
    }

    hasSkill(name: string): boolean {
        return this.skills.has(name);
    }

    getSkillMeta(name: string): SkillMeta | undefined {
        return this.skillMetas.get(name);
    }

    getAllSkillMetas(): SkillMeta[] {
        return Array.from(this.skillMetas.values());
    }

    /** 返回当前技能集合的稳定指纹，用于判断 system prompt 缓存是否仍然有效。 */
    getFingerprint(): string {
        return JSON.stringify(
            this.getAllSkillMetas()
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((skill) => [skill.name, skill.description, skill.mtime]),
        );
    }

    /** 技能实际所在目录（含 SKILL.md），便于定位脚本等伴生文件。 */
    getSkillDir(name: string): string | undefined {
        return this.skillDirs.get(name);
    }

    /** 返回相比上次注入有变化的技能（新增或文件已更新）*/
    getChangedSkills(sentSkillsMtime: Record<string, number>): SkillMeta[] {
        return this.getAllSkillMetas().filter(meta => {
            const lastSentMtime = sentSkillsMtime[meta.name];
            return lastSentMtime === undefined || lastSentMtime !== meta.mtime;
        });
    }

    /** 构建按名称稳定排序的完整技能列表。 */
    buildSkillListing(): string {
        const lines = this.getAllSkillMetas()
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((skill) => `- ${skill.name}: ${skill.description}`);
        return `## 可用技能\n技能通过 use_skill(skill) 工具动态加载。\n${lines.length > 0 ? lines.join('\n') : '- 暂无可用技能'}`;
    }

    getUseSkillDescription(): string {
        return "加载并执行指定技能，获取该领域的完整工作流指令。当用户需求匹配某个技能领域时调用。";
    }
}

export const skillRegistry = new SkillRegistry();
