import { todoTool } from "./todo-tool.js";
import { getUseSkillTool, getUseSkillToolWithFreshSchema } from "./use-skill.js";
import { executeShellTool } from "./execute-shell.js";
import { backgroundTaskTool } from "./background-task-tool.js";
import { ghTool } from "./gh-tool.js";
import { url2mdTool } from "./url2md-tool.js";
import { jobCommentTool } from "./job-comment-tool.js";
import { cwdTool } from "./cwd-tool.js";
import { readMediaFileTool } from "./read-media-file.js";
import { toolResultToText } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";
import { formatToolDef } from "./tool-schema.js";
import { readLazyServersCache } from "./session-lazy-cache.js";

import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
export type { ToolExecutionResult };

const coreTools: ExecutableTool[] = [
    todoTool,
    readMediaFileTool,
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
    jobCommentTool,
];

toolCatalog.reserveNames(["use_skill"]);
toolCatalog.registerLocalTools(localRegisteredTools);

export interface ToolDefinitionOptions {
    /** 任务级 MCP 白名单：只保留这些 server 的工具（undefined 表示不限制）。 */
    mcpServers?: string[];
    /** 接入端是否支持 tool_search：不支持时 lazy server 的工具默认不下发。 */
    toolSearch?: boolean;
    /** 本会话在 /mcp 临时启用的 lazy server；缺省按会话缓存取。 */
    sessionId?: string;
    lazyServers?: string[];
}

/**
 * 所有非会话工具始终下发；会话工具仅在对应会话显式启用时下发。
 * lazy 工具只在支持 tool_search、或该 server 被本会话临时启用时下发。
 */
export const getOpenAIToolDefinitions = (
    extraToolNames: string[] = [],
    options: ToolDefinitionOptions = {},
) => {
    // 空数组 = 一个都不允许；undefined = 不限制。两者必须区分开
    const allowedServers = options.mcpServers ? new Set(options.mcpServers) : undefined;
    const lazyServers = new Set(options.lazyServers ?? readLazyServersCache(options.sessionId));
    const tools = toolCatalog.listAllTools().filter((tool) => {
        if (tool.sessionScoped && !extraToolNames.includes(tool.name)) return false;
        // 任务勾选了 MCP 白名单时，未列出的 server 的工具一律不下发
        if (allowedServers && tool.fromServer && !allowedServers.has(tool.fromServer)) return false;
        // 模型不支持 tool_search 时，lazy server 的工具默认不进定义（/mcp 可临时启用）
        if (tool.lazy && !options.toolSearch && !lazyServers.has(tool.fromServer ?? "")) return false;
        return true;
    });
    return [getUseSkillToolDef(), ...tools].map(formatToolDef);
};

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
