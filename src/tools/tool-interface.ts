import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createToolImageAsset } from "../utils/image-assets.js";
import type { ImageAssetContent, ImageDataContent } from "../types/image.js";
import type { ToolResultPolicy } from "../types/session.js";

export type ToolImageContent = ImageAssetContent | ImageDataContent;

export interface ToolContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    path?: string;
    [key: string]: any;
}

export interface ToolExecutionResult {
    content: ToolContentBlock[];
    isError?: boolean;
    contextPolicy?: ToolResultPolicy;
    _fullHistory?: any[]; // OpenAI-orchestrator 返回完整对话历史（可选）
}

export interface ToolExecutionOutput {
    content: string;
    imageContent?: ToolImageContent[];
    contextPolicy?: ToolResultPolicy;
}

export type ToolExecutionResponse = string | ToolExecutionOutput;

export interface ExecutableTool {
    name: string;
    description?: string;
    tags?: string[];
    source?: string;
    inputSchema: any;
    execute: (args: any, signal?: AbortSignal) => Promise<ToolExecutionResult>;
    /** 来源 MCP server 名（同步时用于按 server 清理过期工具） */
    fromServer?: string;
    /** 内部标记：MCP 配置 defer=true；仅 Responses tool_search 请求会投影为 defer_loading。 */
    deferLoading?: boolean;
    /** 工具级默认策略：结果要求完整保留时声明（如读文件、补丁、代码探索），执行结果可覆盖。 */
    contextPolicy?: ToolResultPolicy;
    /**
     * 会话级工具：默认不下发给模型，只有调用方按会话显式请求时才注入。
     */
    sessionScoped?: boolean;
}

export function ok(text: string): ToolExecutionResult {
    return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolExecutionResult {
    return { content: [{ type: "text", text }], isError: true };
}

export function normalizeToolContent(content: any): ToolContentBlock[] {
    if (!Array.isArray(content)) return [];

    return content.map((item) => {
        if (!item || typeof item !== "object") {
            return { type: "text", text: String(item ?? "") };
        }

        const block: ToolContentBlock = { ...item };
        if (!block.type) {
            if (typeof block.text === "string") {
                block.type = "text";
            } else {
                return { type: "text", text: JSON.stringify(item) };
            }
        }

        return block;
    });
}

/** @public */
export function toolContentToText(content: ToolContentBlock[]): string {
    return normalizeToolContent(content)
        .map((block) => {
            if (block.type === "text") return String(block.text ?? "");
            if (block.type === "image" || block.type === "audio" || block.type === "blob") {
                const mimeType = block.mimeType || "application/octet-stream";
                const size = typeof block.data === "string" ? block.data.length : 0;
                return `[${block.type} ${mimeType} base64_chars=${size}]`;
            }
            if (typeof block.text === "string") return block.text;
            return JSON.stringify(block);
        })
        .filter(Boolean)
        .join("\n");
}

export function toolResultToText(result: ToolExecutionResult): string {
    return toolContentToText(result.content);
}

/** 将工具返回的图片转换为可在后续模型请求中恢复的图片引用。 */
export async function toolContentToImageContent(content: ToolContentBlock[], sessionId?: string): Promise<ToolImageContent[]> {
    const images = await Promise.all(normalizeToolContent(content).map(async (block, index): Promise<ToolImageContent[]> => {
        if (block.type !== "image") return [];
        if (typeof block.data === "string" && block.mimeType?.startsWith("image/")) {
            const filename = block.path ? path.basename(block.path) : `tool-image-${index + 1}`;
            const image = await createToolImageAsset(Buffer.from(block.data, "base64"), filename, block.mimeType, sessionId);
            return [{ type: "image_asset", image } satisfies ImageAssetContent];
        }

        if (block.path && block.mimeType && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(block.mimeType)) {
            try {
                const input = await fs.promises.readFile(block.path);
                const image = await createToolImageAsset(input, path.basename(block.path), block.mimeType, sessionId);
                return [{ type: "image_asset", image } satisfies ImageAssetContent];
            } catch (error: any) {
                if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
            }
            return [{
                type: "image_asset" as const,
                image: {
                    id: `tool_path_${createHash("sha256").update(block.path).digest("hex").slice(0, 20)}`,
                    path: block.path,
                    filename: path.basename(block.path),
                    mimeType: block.mimeType,
                    sizeBytes: 0,
                },
            } satisfies ImageAssetContent];
        }

        return [];
    }));
    return images.flat();
}

const JSON_COMPACTION_TOOL_KEYWORDS = [
    'longport',
    'jin10',
    'news',
    'weather',
    'qweather',
    'caiyun',
    'amap',
    'okx',
    'quote',
    'calendar',
];

/** 仅压缩结构化数据查询工具的 JSON 输出，保留文件与命令工具的原始文本格式。 */
export function canCompactJsonToolOutput(toolName: string): boolean {
    const normalizedToolName = toolName.toLowerCase();
    return JSON_COMPACTION_TOOL_KEYWORDS.some((keyword) => normalizedToolName.includes(keyword));
}

/** 对白名单工具的完整 JSON 对象或数组进行无损紧凑序列化，其他文本保持原样。 */
export function compactJsonToolOutput(text: string, toolName: string): string {
    if (!canCompactJsonToolOutput(toolName)) return text;
    try {
        const value = JSON.parse(text);
        if (!Array.isArray(value) && (value === null || typeof value !== 'object')) {
            return text;
        }
        return JSON.stringify(value);
    } catch {
        return text;
    }
}
