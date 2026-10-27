/**
 * read_media_file 工具：把图片/音频读成结构化内容块交给会话资源系统。
 */

import * as fs from "fs";
import * as path from "path";
import type { ExecutableTool, ToolContentBlock, ToolExecutionResult } from "./tool-interface.js";
import { err } from "./tool-interface.js";
import { getToolCwd } from "../utils/runtime-paths.js";
import { resolvePath } from "./path-utils.js";

function validatePath(inputPath: string, cwdRoot?: string): string {
    return resolvePath(inputPath, cwdRoot);
}

function requireExistingFile(inputPath: string, cwdRoot?: string): string {
    const resolved = validatePath(inputPath, cwdRoot);
    if (!fs.existsSync(resolved)) throw new Error(`No such file or directory: ${inputPath}`);
    if (fs.statSync(resolved).isDirectory()) throw new Error(`Path is a directory: ${inputPath}`);
    return resolved;
}

/** 扩展名 → mime；不在表内返回 undefined，由调用方明确报错而不是静默产出 blob。 */
function mediaMimeType(ext: string): string | undefined {
    const mimeTypes: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".avif": "image/avif",
        ".heic": "image/heic",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".oga": "audio/ogg",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".opus": "audio/opus",
        ".webm": "audio/webm",
    };
    return mimeTypes[ext.toLowerCase()];
}

const readMediaFileSchema = {
    type: "object",
    properties: {
        path: { type: "string", description: "File path" },
    },
    required: ["path"],
};

async function executeReadMediaFile(
    args: { path: string },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");

    try {
        const cwdRoot = getToolCwd();
        const resolved = requireExistingFile(args.path, cwdRoot);
        const extension = path.extname(resolved).toLowerCase();
        const mimeType = mediaMimeType(extension);
        if (!mimeType) return err(`不支持的文件类型：${extension || "无扩展名"}`);
        const type = mimeType.startsWith("image/") ? "image" : "audio";
        const raw = fs.readFileSync(resolved);
        // 空文件在这里就拦掉：否则会生成 0 字节资产，上游收到 `data:...;base64,` 后 4xx
        if (raw.length === 0) return err(`文件为空：${args.path}`);
        const content: ToolContentBlock = {
            type,
            data: raw.toString("base64"),
            mimeType,
            path: resolved,
        };
        return { content: [content] };
    } catch (error: any) {
        return err(error.message);
    }
}

export const readMediaFileTool: ExecutableTool = {
    name: "read_media_file",
    description: "Read an image or audio file and return base64 data with MIME type.",
    tags: ["core", "filesystem"],
    inputSchema: readMediaFileSchema,
    execute: executeReadMediaFile,
};
