import { todoTool } from "./todo-tool.js";
import { getUseSkillTool, getUseSkillToolWithFreshSchema } from "./use-skill.js";
import { executeShellTool } from "./execute-shell.js";
import { backgroundTaskTool } from "./background-task-tool.js";
import { ghTool } from "./gh-tool.js";
import { url2mdTool } from "./url2md-tool.js";
import { cwdTool } from "./cwd-tool.js";
import { FILE_OPS_TOOLS } from "./file-ops.js";
import { toolResultToText } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";
import { formatToolDef } from "./tool-schema.js";

import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
export type { ExecutableTool, ToolExecutionResult };

const coreTools: ExecutableTool[] = [
    todoTool,
    ...FILE_OPS_TOOLS,
    backgroundTaskTool,
];

let useSkillToolInstance: ExecutableTool | null = null;
function getUseSkillToolCached(): ExecutableTool {
    if (!useSkillToolInstance) {
        useSkillToolInstance = getUseSkillTool();
    }
    return useSkillToolInstance;
}

const getUseSkillToolDef = () => getUseSkillToolWithFreshSchema();

const localRegisteredTools: ExecutableTool[] = [
    ...coreTools,
    executeShellTool,
    cwdTool,
    ghTool,
    url2mdTool,
];

toolCatalog.reserveNames(["use_skill"]);
toolCatalog.registerLocalTools(localRegisteredTools);

/** 所有非会话工具始终下发；会话工具仅在对应会话显式启用时下发。 */
export const getOpenAIToolDefinitions = (extraToolNames: string[] = []) => {
    const tools = toolCatalog.listAllTools().filter((tool) =>
        !tool.sessionScoped || extraToolNames.includes(tool.name),
    );
    return [getUseSkillToolDef(), ...tools].map(formatToolDef);
};

/** 获取所有已注册工具的稳定摘要，供 system prompt 构建完整工具列表。 */
export const getAllToolSummary = (): Array<{ name: string; tags: string[]; source?: string }> =>
    toolCatalog.listAllTools()
        .map((tool) => ({ name: tool.name, tags: [...(tool.tags ?? [])].sort(), source: tool.source }))
        .sort((left, right) => {
            const sourceOrder = (left.source || 'local').localeCompare(right.source || 'local');
            return sourceOrder !== 0 ? sourceOrder : left.name.localeCompare(right.name);
        });

const validateToolLimits = () => {
    const tools = getOpenAIToolDefinitions();
    if (tools.length > 100) {
        console.warn(`🚨 TOOL LIMIT WARNING: ${tools.length} tools, exceeding 100!`);
    }
};

setTimeout(validateToolLimits, 5000);

export const executeMcpTool = async (name: string, args: any, signal?: AbortSignal): Promise<ToolExecutionResult> => {
    const tool = name === "use_skill" ? getUseSkillToolCached() : toolCatalog.getTool(name);

    if (!tool) {
        console.warn(`❌ [Tool] Unknown: ${name}`);
        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }

    try {
        const result = await tool.execute(args, signal);
        if (result.isError) {
            console.warn(`⚠️ [Tool] ${name} returned error`);
        } else {
            const preview = (toolResultToText(result) || "empty").slice(0, 100);
            console.log(`✅ [Tool] ${name} success: ${preview}${preview.length >= 100 ? "..." : ""}`);
        }
        if (!result.contextPolicy && tool.contextPolicy) {
            result.contextPolicy = tool.contextPolicy;
        }
        return result;
    } catch (error: any) {
        console.error(`❌ [Tool] ${name} failed:`, error.message);
        return {
            content: [{ type: "text", text: `Tool execution failed: ${error.message}` }],
            isError: true,
        };
    }
};
