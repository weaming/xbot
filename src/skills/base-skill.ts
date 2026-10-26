import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getToolCwd, getUserMemoryFilePath, getUserMemoriesDir } from "../utils/runtime-paths.js";
import { getDateStringOffsetDays, getTodayDateString } from "../utils/time.js";

const IDENTITY_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
let embeddedIdentity: string | undefined;

/**
 * 读取文件内容，空内容返回 '空'
 */
function readFileContent(filePath: string): string {
    if (!fs.existsSync(filePath)) return '空';
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return content || '空';
}

/**
 * 加载最近记忆上下文（MEMORY.md + today + yesterday）。
 * 无长度限制，全部加载。
 */
export function loadCoreMemoryContext(userId: number): string {
    const sections: string[] = [];
    sections.push(`<!-- 核心记忆 (MEMORY.md) -->\n${readFileContent(getUserMemoryFilePath(userId))}`);
    return sections.join('\n\n');
}

export function loadDailyMemoryContext(userId: number): string {
    const memoryDir = getUserMemoriesDir(userId);
    const today = getTodayDateString();
    const yesterday = getDateStringOffsetDays(-1);
    const sections: string[] = [];
    sections.push(`<!-- 昨日记忆 (${yesterday}) -->\n${readFileContent(path.join(memoryDir, `${yesterday}.md`))}`);
    sections.push(`<!-- 今日记忆 (${today}) -->\n${readFileContent(path.join(memoryDir, `${today}.md`))}`);
    return sections.join('\n\n');
}

/**
 * 将内容中的 {{VAR_NAME}} 替换为对应的环境变量值（overrides 优先于 process.env）。
 * 变量均不存在时保留原始占位符。
 */
function interpolateEnvVars(content: string, overrides?: Record<string, string>): string {
    return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => {
        return overrides?.[name] ?? process.env[name] ?? match;
    });
}

/**
 * 从应用配置根目录加载身份文件（AGENTS.md / SOUL.md / IDENTITY.md / USER.md）。
 * 文件内容支持 {{VAR_NAME}} 格式的环境变量插值（envOverrides 优先于 process.env，
 * 用于按会话覆盖 {{TUI_CWD}} 等随会话变化的占位）。
 * 文件不存在时跳过，全部不存在则返回空字符串。
 */
export function loadIdentityContext(envOverrides?: Record<string, string>): string {
    const identityOverride = process.env.ZBOT_IDENTITY_FILE;
    const extraIdentityFile = process.env.ZBOT_EXTRA_IDENTITY_FILE;

    if (embeddedIdentity) {
        const parts = [formatIdentityContent(embeddedIdentity, "AGENTS.md", envOverrides)];
        if (extraIdentityFile && fs.existsSync(extraIdentityFile)) {
            parts.push(readIdentityOverride(extraIdentityFile, envOverrides));
        }
        return parts.filter(Boolean).join('\n\n');
    }

    if (identityOverride) {
        const parts = [readIdentityOverride(identityOverride, envOverrides)];
        if (extraIdentityFile && fs.existsSync(extraIdentityFile)) {
            parts.push(readIdentityOverride(extraIdentityFile, envOverrides));
        }
        return parts.filter(Boolean).join('\n\n');
    }

    if (extraIdentityFile && fs.existsSync(extraIdentityFile)) {
        return readIdentityOverride(extraIdentityFile, envOverrides);
    }

    const identityRoot = getToolCwd();
    const parts: string[] = [];

    for (const filename of IDENTITY_FILES) {
        const filePath = path.join(identityRoot, filename);
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (raw) {
                const expectedHeader = `# ${filename}`;
                const content = raw.startsWith(expectedHeader)
                    ? raw
                    : `${expectedHeader}\n\n${raw}`;
                parts.push(`<!-- ${filename} -->\n${interpolateEnvVars(content, envOverrides)}`);
            }
        }
    }

    return parts.join('\n\n');
}

export function setEmbeddedIdentity(content?: string): void {
    embeddedIdentity = content?.trim() || undefined;
}

function readIdentityOverride(filePath: string, envOverrides?: Record<string, string>): string {
    try {
        const raw = fs.readFileSync(filePath, "utf-8").trim();
        return formatIdentityContent(raw, path.basename(filePath), envOverrides);
    } catch (error: any) {
        console.warn(`⚠️ 身份文件读取失败: ${filePath}: ${error.message}`);
        return "";
    }
}

function formatIdentityContent(raw: string, name: string, envOverrides?: Record<string, string>): string {
    return raw ? `<!-- ${name} -->\n${interpolateEnvVars(raw, envOverrides)}` : "";
}


export interface SkillConfig {
    name: string;
    description: string;
    systemPrompt: string;
}

/**
 * 技能类，可直接实例化，无需子类
 */
export class BaseSkill {
    config: SkillConfig;

    constructor(config: SkillConfig) {
        this.config = config;
    }

    getSystemPrompt(): string {
        return this.config.systemPrompt;
    }

}

/**
 * 解析 SKILL.md，只有 name 是必填项，其余字段均有默认值。
 * 兼容社区极简格式：只需 name + prompt body。
 */
export function parseSkillMarkdown(skillDir: string): SkillConfig {
    const filePath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(filePath)) {
        throw new Error(`SKILL.md not found in ${skillDir}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // 支持有 frontmatter 和无 frontmatter 两种格式
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    let meta: Partial<SkillConfig> = {};
    let systemPrompt = content.trim();

    if (match) {
        meta = (yaml.load(match[1]) as Partial<SkillConfig>) || {};
        systemPrompt = match[2].trim();
    }

    if (!meta.name) {
        // 无 frontmatter：用目录名作为 name
        meta.name = path.basename(skillDir);
    }

    return {
        name: meta.name,
        description: meta.description || '',
        systemPrompt,
    };
}
