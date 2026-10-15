import type { ExecutableTool } from "./tool-interface.js";
import type { ToolUsageEntry } from "./tool-usage-store.js";

/** @public */
export const TOOL_PAGE_SIZE = 10;

/** 每次使用折算的"保鲜期"：高频工具即使上次使用时间更早也保持靠前 */
const COUNT_BONUS_MS = 12 * 60 * 60 * 1000;

export interface ToolSummaryEntry {
    name: string;
    tags: string[];
    source?: string;
}

/** @public */
export function isAlwaysShown(tool: ExecutableTool): boolean {
    return !tool.tags || tool.tags.length === 0 || tool.tags.includes("core");
}

export function getAllRegisteredTags(tools: ExecutableTool[]): string[] {
    const tags = new Set<string>();
    for (const tool of tools) {
        for (const tag of tool.tags || []) {
            if (tag !== "core") {
                tags.add(tag);
            }
        }
    }
    return [...tags].sort();
}

export function getAllRegisteredSources(tools: ExecutableTool[]): string[] {
    const sources = new Set<string>();
    for (const tool of tools) {
        if (tool.source && tool.source !== "local") {
            sources.add(tool.source);
        }
    }
    return [...sources].sort();
}

export function getTopToolsByLRU(
    tools: ExecutableTool[],
    usageByToolName: ReadonlyMap<string, ToolUsageEntry>,
    pageSize: number = TOOL_PAGE_SIZE,
): ExecutableTool[] {
    return tools
        .filter((tool) => !isAlwaysShown(tool) && tool.name !== "use_skill")
        .map((tool) => ({ tool, usage: usageByToolName.get(tool.name) }))
        .sort((left, right) => {
            const leftScore = (left.usage?.lastUsed ?? 0) + (left.usage?.count ?? 0) * COUNT_BONUS_MS;
            const rightScore = (right.usage?.lastUsed ?? 0) + (right.usage?.count ?? 0) * COUNT_BONUS_MS;
            return rightScore - leftScore;
        })
        .slice(0, pageSize)
        .map((item) => item.tool);
}

export function getVisibleTools(options: {
    allTools: ExecutableTool[];
    useSkillTool: ExecutableTool;
    searchTool: ExecutableTool;
    usageByToolName: ReadonlyMap<string, ToolUsageEntry>;
    pageSize?: number;
    includeLruTools?: boolean;
}): ExecutableTool[] {
    // 会话级工具默认不下发，由调用方按会话显式注入（getOpenAIToolDefinitions 的 extraToolNames）
    const available = options.allTools.filter((tool) => !tool.sessionScoped);
    const alwaysShown = available.filter(
        (tool) => isAlwaysShown(tool) && tool.name !== "use_skill" && tool.name !== "search_tools",
    );

    return [
        options.useSkillTool,
        options.searchTool,
        ...alwaysShown,
        ...(options.includeLruTools === false
            ? []
            : getTopToolsByLRU(available, options.usageByToolName, options.pageSize)),
    ];
}

export function buildToolSummary(
    allTools: ExecutableTool[],
    visibleTools: ExecutableTool[],
): ToolSummaryEntry[] {
    const includedNames = new Set(visibleTools.map((tool) => tool.name));
    return allTools
        .filter((tool) => !includedNames.has(tool.name))
        .map((tool) => ({
            name: tool.name,
            tags: tool.tags || [],
            source: tool.source,
        }));
}
