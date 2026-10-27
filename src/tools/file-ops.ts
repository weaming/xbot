/**
 * Internal filesystem tools aligned with the official MCP filesystem server.
 */

import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch } from "diff";
import type { ExecutableTool, ToolContentBlock, ToolExecutionResult } from "./tool-interface.js";
import { ok, err } from "./tool-interface.js";
import { getToolCwd } from "../utils/runtime-paths.js";
import { resolvePath } from "./path-utils.js";

type FileEdit = {
    oldText: string;
    newText: string;
};

function validatePath(inputPath: string, cwdRoot?: string): string {
    return resolvePath(inputPath, cwdRoot);
}

function requireExistingFile(inputPath: string, cwdRoot?: string): string {
    const resolved = validatePath(inputPath, cwdRoot);
    if (!fs.existsSync(resolved)) throw new Error(`No such file or directory: ${inputPath}`);
    if (fs.statSync(resolved).isDirectory()) throw new Error(`Path is a directory: ${inputPath}`);
    return resolved;
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

function createUnifiedDiff(original: string, updated: string, label: string): string {
    const patch = createTwoFilesPatch(label, label, original, updated, "", "", { context: 3 });
    return `\`\`\`diff\n${patch}\`\`\``;
}

function atomicWrite(resolvedPath: string, content: string): void {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const tempPath = path.join(
        path.dirname(resolvedPath),
        `.${path.basename(resolvedPath)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );

    try {
        fs.writeFileSync(tempPath, content, "utf-8");
        fs.renameSync(tempPath, resolvedPath);
    } finally {
        if (fs.existsSync(tempPath)) {
            fs.rmSync(tempPath, { force: true });
        }
    }
}

function applyEditOnce(content: string, oldText: string, newText: string): string {
    const normalizedOld = normalizeLineEndings(oldText);
    const normalizedNew = normalizeLineEndings(newText);

    if (content.includes(normalizedOld)) {
        return content.replace(normalizedOld, normalizedNew);
    }

    const oldLines = normalizedOld.split("\n");
    const contentLines = content.split("\n");

    for (let start = 0; start <= contentLines.length - oldLines.length; start += 1) {
        const window = contentLines.slice(start, start + oldLines.length);
        const isMatch = oldLines.every((expected, index) => expected.trim() === (window[index] || "").trim());
        if (!isMatch) continue;

        const originalIndent = (window[0] || "").match(/^\s*/)?.[0] || "";
        const replacement = normalizedNew.split("\n").map((line, index) => {
            if (index === 0) return originalIndent + line.trimStart();

            const oldIndent = (oldLines[index] || "").match(/^\s*/)?.[0] || "";
            const newIndent = line.match(/^\s*/)?.[0] || "";
            const relativeIndent = Math.max(0, newIndent.length - oldIndent.length);
            return originalIndent + " ".repeat(relativeIndent) + line.trimStart();
        });

        contentLines.splice(start, oldLines.length, ...replacement);
        return contentLines.join("\n");
    }

    throw new Error(`Could not find exact match for edit:\n${oldText}`);
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

async function executeWriteFile(
    args: { path: string; content: string },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");
    if (args.content === undefined) return err("Missing required argument: content");

    try {
        const cwdRoot = getToolCwd();
        const resolved = validatePath(args.path, cwdRoot);
        atomicWrite(resolved, args.content);
        return ok(`Successfully wrote to ${args.path}`);
    } catch (error: any) {
        return err(error.message);
    }
}

async function executeEditFile(
    args: { path: string; edits: FileEdit[]; dryRun?: boolean },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");
    if (!Array.isArray(args.edits) || args.edits.length === 0) return err("At least one edit must be provided");

    try {
        const cwdRoot = getToolCwd();
        const resolved = requireExistingFile(args.path, cwdRoot);
        const original = normalizeLineEndings(fs.readFileSync(resolved, "utf-8"));
        let updated = original;

        for (const edit of args.edits) {
            if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
                throw new Error("Each edit must include oldText and newText");
            }
            updated = applyEditOnce(updated, edit.oldText, edit.newText);
        }

        const diffText = createUnifiedDiff(original, updated, args.path);
        if (!args.dryRun) {
            atomicWrite(resolved, updated);
        }

        return ok(`Edited file successfully: ${path.relative(cwdRoot, resolved)}\nReplacements: ${args.edits.length}\n\n${diffText}`);
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

export const writeFileTool: ExecutableTool = {
    name: "write_file",
    description: "Create a new file or completely overwrite an existing file with new content.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
    },
    execute: executeWriteFile,
};

export const editFileTool: ExecutableTool = {
    name: "edit_file",
    description: "Make line-based edits to a text file and return a git-style diff.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "File to edit" },
            edits: {
                type: "array",
                description: "List of edit operations",
                items: {
                    type: "object",
                    properties: {
                        oldText: { type: "string", description: "Text to search for - must match exactly" },
                        newText: { type: "string", description: "Text to replace with" },
                    },
                    required: ["oldText", "newText"],
                },
            },
            dryRun: { type: "boolean", description: "Preview changes using git-style diff format", default: false },
        },
        required: ["path", "edits"],
    },
    execute: executeEditFile,
    // diff 补丁要求精确完整
    contextPolicy: { mode: "full" },
};

export const FILE_OPS_TOOLS: ExecutableTool[] = [
    readMediaFileTool,
    writeFileTool,
    editFileTool,
];
