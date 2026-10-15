/**
 * use_skill 工具：动态加载指定技能的内容
 * LLM 通过此工具获取技能的完整说明和指令
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { skillRegistry } from "../skills/skill-registry.js";
import { addSkillPath } from "../utils/skill-env.js";

function buildInputSchema() {
  const skills = skillRegistry.getSkillEnum();
  return {
    type: "object" as const,
    properties: {
      skill: {
        type: "string" as const,
        description: "技能名称",
        ...(skills.length > 0 && { enum: skills }),
      },
    },
    required: ["skill"] as string[],
  };
}

/** 递归列出技能目录下除 SKILL.md 外的文件，便于 LLM 感知可用的脚本/资源。 */
function listSkillFiles(skillDir: string): string {
  const lines: string[] = [];

  function walk(dir: string, prefix = ''): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'SKILL.md') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}📁 ${entry.name}/`);
        walk(fullPath, prefix + '  ');
      } else {
        lines.push(`${prefix}📄 ${entry.name}`);
      }
    }
  }

  walk(skillDir);
  return lines.length > 0 ? `\n\n---\n\n### 其他文件\n\n${lines.join('\n')}` : '';
}

function createUseSkillToolInstance(): ExecutableTool {
  return {
    name: "use_skill",
    description: skillRegistry.getUseSkillDescription(),
    tags: ["core"],
    inputSchema: buildInputSchema(),
    execute: async (args: { skill: string }): Promise<ToolExecutionResult> => {
      const { skill } = args;

      if (!skill) {
        return {
          content: [{ type: "text", text: "错误：未指定技能名称" }],
          isError: true,
        };
      }

      try {
        const skillDir = skillRegistry.getSkillDir(skill);
        if (!skillDir) {
          return {
            content: [{
              type: "text",
              text: `错误：技能 "${skill}" 不存在。\n\n可用技能：${skillRegistry.getSkillEnum().join(", ")}`,
            }],
            isError: true,
          };
        }

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), 'utf-8');

        // 解析 frontmatter，只返回正文内容
        const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
        const skillContent = match ? match[1].trim() : content.trim();

        // 将技能目录加入 PATH，供技能中的命令直接使用
        addSkillPath(skill);

        return {
          content: [{
            type: "text",
            text: `## ${skill} 技能\n\n${skillContent}${listSkillFiles(skillDir)}`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `加载技能失败：${err.message}` }],
          isError: true,
        };
      }
    },
  };
}

// 缓存工具实例
let cachedTool: ExecutableTool | null = null;

export function getUseSkillTool(): ExecutableTool {
  if (!cachedTool) {
    cachedTool = createUseSkillToolInstance();
  }
  return cachedTool;
}

// 获取带最新 schema 和描述的工具实例
export function getUseSkillToolWithFreshSchema(): ExecutableTool {
  return createUseSkillToolInstance();
}
