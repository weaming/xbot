import { normalizeToolContent } from "../tools/tool-interface.js";

import type { ExecutableTool } from "../tools/tool-interface.js";

export interface RemoteToolDefinition {
    name: string;
    description?: string;
    inputSchema: any;
}

export interface RemoteToolCallResult {
    content: any[];
    isError?: boolean;
}

export interface ParsedToolMetadata {
    source: string;
    tags: string[];
    cleanDesc: string;
}

export function sanitizeToolArgs(args: any): any {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
        return args;
    }

    const cleaned = { ...args };
    for (const key of Object.keys(cleaned)) {
        if (key.startsWith("__")) {
            delete cleaned[key];
        }
    }
    return cleaned;
}

export function parseToolMetadataFromDescription(desc: string | undefined): ParsedToolMetadata {
    const match = desc?.match(/^\[source:([^\]]+)\] \[tags:([^\]]*)\] /);
    if (!match) {
        return { source: "", tags: [], cleanDesc: desc || "" };
    }

    return {
        source: match[1],
        tags: match[2] ? match[2].split(",").filter(Boolean) : [],
        cleanDesc: desc!.replace(/^\[source:[^\]]+\] \[tags:[^\]]*\] /, ""),
    };
}

export function createProxyTool(options: {
    toolDef: RemoteToolDefinition;
    tags: string[];
    source?: string;
    fromServer?: string;
    executeRemote: (args: any, signal?: AbortSignal) => Promise<RemoteToolCallResult>;
}): ExecutableTool {
    const proxyTool: ExecutableTool = {
        name: options.toolDef.name,
        description: options.toolDef.description,
        tags: options.tags,
        source: options.source,
        fromServer: options.fromServer,
        inputSchema: options.toolDef.inputSchema,
        execute: async (args: any, signal?: AbortSignal) => {
            try {
                const result = await options.executeRemote(sanitizeToolArgs(args), signal);
                return {
                    content: normalizeToolContent(result.content as any[]),
                    isError: !!result.isError,
                };
            } catch (error: any) {
                if (error?.name === "AbortError") {
                    throw error;
                }

                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `External tool error: ${message}` }],
                    isError: true,
                };
            }
        },
    };

    // 代码探索输出是精确定位依据，需完整保留（如 Sandbox__codegraph_explore / codegraph_files）
    if (options.toolDef.name.includes("codegraph_")) {
        proxyTool.contextPolicy = { mode: "full" };
    }

    return proxyTool;
}

export function buildProxyToolFromRemoteDefinition(options: {
    toolDef: RemoteToolDefinition;
    serverName: string;
    executeRemote: (args: any, signal?: AbortSignal) => Promise<RemoteToolCallResult>;
}): ExecutableTool {
    const metadata = parseToolMetadataFromDescription(options.toolDef.description);
    return createProxyTool({
        toolDef: {
            ...options.toolDef,
            description: metadata.cleanDesc,
        },
        tags: metadata.tags,
        source: metadata.source || undefined,
        fromServer: options.serverName,
        executeRemote: options.executeRemote,
    });
}

export function summarizeAddedToolsByNamePrefix(
    addedToolNames: string[],
): string {
    const grouped: Record<string, string[]> = {};

    for (const toolName of addedToolNames) {
        const [prefix] = toolName.split("__", 1);
        if (!grouped[prefix]) {
            grouped[prefix] = [];
        }
        grouped[prefix].push(toolName);
    }

    return Object.entries(grouped)
        .map(([prefix, names]) => `${prefix}(${names.length})`)
        .join(", ");
}
