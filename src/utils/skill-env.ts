/**
 * Skill Environment Manager
 * 维护 skill 目录路径，并在执行命令时将 skill 路径添加到 PATH
 */

import * as path from 'path';
import { skillRegistry } from '../skills/skill-registry.js';

// 追踪已激活的 skill 路径集合
const activeSkillPaths = new Set<string>();

/**
 * 添加 skill 实际目录到 PATH 集合（技能可能位于用户级或共享目录）。
 */
export function addSkillPath(skillName: string): void {
    const skillPath = skillRegistry.getSkillDir(skillName);
    if (!skillPath) {
        console.warn(`⚠️ [SkillEnv] Skill not found: ${skillName}`);
        return;
    }
    activeSkillPaths.add(skillPath);
    console.log(`📂 [SkillEnv] Added to PATH: ${skillPath}`);
}

/**
 * 获取所有激活的 skill 路径
 */
function getActiveSkillPaths(): string[] {
    return Array.from(activeSkillPaths);
}

/**
 * 合并多段 PATH，去除重复条目，保留首次出现顺序
 */
function mergePaths(...segments: string[]): string {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const seg of segments) {
        for (const p of seg.split(path.delimiter)) {
            if (p && !seen.has(p)) {
                seen.add(p);
                result.push(p);
            }
        }
    }
    return result.join(path.delimiter);
}

/**
 * 构建执行命令时使用的环境变量
 * 包含系统环境变量 + 激活的 skill 路径
 */
export function buildExecutionEnv(): NodeJS.ProcessEnv {
    const currentPath = process.env.PATH || '';
    const currentTz = process.env.TZ || 'Asia/Hong_Kong';

    const skillPaths = getActiveSkillPaths();
    const newPath = mergePaths(skillPaths.join(path.delimiter), currentPath);

    return {
        ...process.env,
        PATH: newPath,
        TZ: currentTz,
    };
}

/**
 * 检查命令是否可执行（调试用）
 */
function canExecute(command: string): boolean {
    const { execSync } = require('child_process');
    try {
        execSync(`which ${command}`, { env: buildExecutionEnv(), stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}
