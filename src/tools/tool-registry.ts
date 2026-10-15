import { todoTool } from "./todo-tool.js";
import { getUseSkillTool, getUseSkillToolWithFreshSchema } from "./use-skill.js";
import { executeShellTool } from "./execute-shell.js";
import { backgroundTaskTool } from "./background-task-tool.js";
import { ghTool } from "./gh-tool.js";
import { url2mdTool } from "./url2md-tool.js";
import { FILE_OPS_TOOLS } from "./file-ops.js";
import { DATA_OPS_TOOLS } from "./data-ops.js";
import { toolResultToText } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";
import { formatToolDef } from "./tool-schema.js";
import { buildToolSummary, getVisibleTools } from "./tool-visibility.js";
import { toolUsageStore } from "./tool-usage-store.js";

import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
export type { ExecutableTool, ToolExecutionResult };

// 1. 本地核心工具（始终包含，不受 TOOL_PAGE_SIZE 限制）
const coreTools: ExecutableTool[] = [
    todoTool,
    ...FILE_OPS_TOOLS,
    ...DATA_OPS_TOOLS,
    backgroundTaskTool,
];

// use_skill 用于执行（延迟初始化，避免 init() 前被调用）
let useSkillToolInstance: ExecutableTool | null = null;
function getUseSkillToolCached(): ExecutableTool {
  if (!useSkillToolInstance) {
    useSkillToolInstance = getUseSkillTool();
  }
  return useSkillToolInstance;
}

// 用于发送给 LLM 的工具定义（每次获取时刷新 schema）
const getUseSkillToolDef = () => getUseSkillToolWithFreshSchema();

const localRegisteredTools: ExecutableTool[] = [
  ...coreTools,
  executeShellTool,
  ghTool,
  url2mdTool,
];

toolCatalog.reserveNames(["use_skill", "search_tools"]);
toolCatalog.registerLocalTools(localRegisteredTools);

export interface SearchToolsArgs {
  keywords?: string[];
}

function normalizeSearchKeywords(args: SearchToolsArgs): string[] {
  return (args.keywords ?? [])
    .filter((keyword): keyword is string => typeof keyword === "string")
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

function getSearchableToolText(tool: ExecutableTool): string {
  return [tool.name, tool.source, ...(tool.tags ?? []), tool.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterToolsBySearch(
  tools: ExecutableTool[],
  args: SearchToolsArgs,
): ExecutableTool[] {
  const keywords = normalizeSearchKeywords(args);

  return tools.filter((tool) => {
    return keywords.length === 0 || keywords.some((keyword) => getSearchableToolText(tool).includes(keyword));
  });
}

export function serializeSearchToolResults(tools: ExecutableTool[]): string {
  return JSON.stringify({
    count: tools.length,
    tools: tools.map(formatToolDef),
  });
}

const searchToolBase: ExecutableTool = {
  name: "search_tools",
  description: "传入独立关键词列表；例如 [\"hello\", \"world\"]，不要写成 [\"hello world\"]。任一关键词匹配工具名、来源、标签或描述时，返回对应工具的完整可调用 schema",
  tags: ["core"],
  inputSchema: {},
  execute: async (args: SearchToolsArgs): Promise<ToolExecutionResult> => {
    // 避免循环依赖，使用动态 import
    const { syncToolsIfStale } = await import("../mcp/client-manager.js");
    await syncToolsIfStale();

    const keywords = normalizeSearchKeywords(args);
    // 会话级工具不出现在搜索结果里：它们只在会话显式启用后由 getOpenAIToolDefinitions 注入
    const results = filterToolsBySearch(
      toolCatalog.listAllTools().filter((tool) => !tool.sessionScoped),
      args,
    );

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `没有找到匹配的工具（keywords=${keywords.join(",") || "*"}）` }],
      };
    }

    return {
      content: [{
        type: "text",
        text: serializeSearchToolResults(results),
      }],
    };
  },
};

// 动态生成 search_tools 的 inputSchema
function getSearchToolWithFreshSchema(): ExecutableTool {
  return {
    ...searchToolBase,
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "独立关键词列表，例如 [\"hello\", \"world\"]；不要把多个词合并成 [\"hello world\"]。任一关键词命中即返回完整工具 schema",
        },
      },
      required: ["keywords"],
    },
  };
}

// 当前消息可见的工具集（use_skill / search_tools 用 fresh schema，其余来自核心工具和可选 LRU 工具页）
function getVisibleToolsForRequest(includeLruTools: boolean = true): ExecutableTool[] {
  return getVisibleTools({
    allTools: toolCatalog.listAllTools(),
    useSkillTool: getUseSkillToolDef(),
    searchTool: getSearchToolWithFreshSchema(),
    usageByToolName: toolUsageStore.getUsageMap(),
    includeLruTools,
  });
}

// 2. 工具定义（发给 LLM）
// extraToolNames：按会话显式追加的会话级工具（默认不下发，见 ExecutableTool.sessionScoped）
export const getOpenAIToolDefinitions = (includeLruTools: boolean = true, extraToolNames: string[] = []) => {
  const visible = getVisibleToolsForRequest(includeLruTools);
  if (extraToolNames.length === 0) return visible.map(formatToolDef);

  const visibleNames = new Set(visible.map((tool) => tool.name));
  const extra = toolCatalog.listAllTools()
    .filter((tool) => extraToolNames.includes(tool.name) && !visibleNames.has(tool.name));
  return [...visible, ...extra].map(formatToolDef);
};

export const getOpenAIToolDefinitionsByNames = (names: string[]) =>
  toolCatalog.listAllTools().filter(t => names.includes(t.name)).map(formatToolDef);

export function isBuiltinTool(name: string): boolean {
  return name === "use_skill"
    || name === "search_tools"
    || toolCatalog.listLocalTools().some((tool) => tool.name === name);
}

/** 获取所有已注册工具的稳定摘要，供 system prompt 构建完整工具列表。 */
export const getAllToolSummary = (): Array<{ name: string; tags: string[]; source?: string }> =>
  toolCatalog.listAllTools()
    .map((tool) => ({ name: tool.name, tags: [...(tool.tags ?? [])].sort(), source: tool.source }))
    .sort((left, right) => {
      const sourceOrder = (left.source || 'local').localeCompare(right.source || 'local');
      return sourceOrder !== 0 ? sourceOrder : left.name.localeCompare(right.name);
    });

// 3. 工具数量校验
const validateToolLimits = () => {
  const tools = getOpenAIToolDefinitions();
  if (tools.length > 100) {
    console.warn(`🚨 TOOL LIMIT WARNING: ${tools.length} tools, exceeding 100!`);
  }
};

setTimeout(validateToolLimits, 5000);

// 4. 工具执行
export const executeMcpTool = async (name: string, args: any, signal?: AbortSignal): Promise<ToolExecutionResult> => {
  // use_skill / search_tools 特殊处理，不走 catalog 查找
  let tool =
    name === "use_skill" ? getUseSkillToolCached() :
    name === "search_tools" ? searchToolBase :
    toolCatalog.getTool(name);

  if (!tool) {
    console.warn(`❌ [Tool] Unknown: ${name}`);
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    toolUsageStore.recordUsage(name);
    const result = await tool.execute(args, signal);
    if (result.isError) {
      console.warn(`⚠️ [Tool] ${name} returned error`);
    } else {
      const preview = (toolResultToText(result) || "empty").slice(0, 100);
      console.log(`✅ [Tool] ${name} success: ${preview}${preview.length >= 100 ? "..." : ""}`);
    }
    // 工具未显式声明策略时，回退到工具级默认声明（读文件/补丁/代码探索需完整输出）
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
