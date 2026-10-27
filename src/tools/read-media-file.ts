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

function imageMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    };
    return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
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
        const mimeType = imageMimeType(path.extname(resolved));
        const type = mimeType.startsWith("image/")
            ? "image"
            : mimeType.startsWith("audio/")
                ? "audio"
                : "blob";
        const content: ToolContentBlock = {
            type,
            data: fs.readFileSync(resolved).toString("base64"),
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
