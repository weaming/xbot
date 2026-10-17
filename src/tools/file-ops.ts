/**
 * Internal filesystem tools aligned with the official MCP filesystem server.
 */

import { execFile as execFileCallback } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { createTwoFilesPatch } from "diff";
import type { ExecutableTool, ToolContentBlock, ToolExecutionResult } from "./tool-interface.js";
import { ok, err } from "./tool-interface.js";
import { getToolCwd } from "../utils/runtime-paths.js";
import { resolvePath } from "./path-utils.js";
import { grepFileTool, resolveRgBinary } from "./grep-tool.js";

const execFileAsync = promisify(execFileCallback);

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

function requireExistingDirectory(inputPath: string, cwdRoot?: string): string {
    const resolved = validatePath(inputPath, cwdRoot);
    if (!fs.existsSync(resolved)) throw new Error(`No such file or directory: ${inputPath}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Path is not a directory: ${inputPath}`);
    return resolved;
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

function splitTextLines(content: string): string[] {
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

function headLines(content: string, count: number): string {
    return splitTextLines(content).slice(0, count).join("\n");
}

function tailLines(content: string, count: number): string {
    return splitTextLines(content).slice(-count).join("\n");
}

function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    if (bytes <= 0) return "0 B";

    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return unitIndex === 0 ? `${Math.round(value)} ${units[unitIndex]}` : `${value.toFixed(2)} ${units[unitIndex]}`;
}

function compareNames(left: string, right: string): number {
    return left.toLowerCase().localeCompare(right.toLowerCase());
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
}

function toPosix(relPath: string): string {
    return relPath.split(path.sep).join("/");
}

function matchesPattern(relPath: string, pattern: string): boolean {
    const normalized = toPosix(relPath);
    const regex = globToRegExp(pattern);
    const basename = path.posix.basename(normalized);

    if (regex.test(normalized)) return true;
    if (!pattern.includes("/") && regex.test(basename)) return true;
    return false;
}

function shouldExclude(relPath: string, excludePatterns: string[], isDirectory: boolean): boolean {
    return excludePatterns.some((pattern) => {
        if (matchesPattern(relPath, pattern)) return true;
        if (isDirectory && matchesPattern(`${toPosix(relPath)}/child`, `${pattern}/**`)) return true;
        return false;
    });
}

/** 用 jsdiff 的 LCS 算法生成标准 unified diff，避免逐行同位对比导致插入/删除错位 */
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

async function executeCat(
    args: {
        path?: string;
        paths?: string[];
        head?: number;
        tail?: number;
        offset?: number;
        limit?: number;
    },
): Promise<ToolExecutionResult> {
    if (args.paths !== undefined) {
        return executeReadMultipleFiles(args as { paths: string[] });
    }
    return executeReadTextFile(args as { path: string; head?: number; tail?: number; offset?: number; limit?: number });
}

async function executeReadTextFile(
    args: {
        path: string;
        head?: number;
        tail?: number;
        offset?: number;
        limit?: number;
    },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");
    if (args.head !== undefined && args.tail !== undefined) {
        return err("Cannot specify both head and tail parameters simultaneously");
    }
    if (args.offset !== undefined && (args.head !== undefined || args.tail !== undefined)) {
        return err("Cannot specify offset/limit together with head/tail");
    }

    try {
        const cwdRoot = getToolCwd();
        const resolved = requireExistingFile(args.path, cwdRoot);
        const content = fs.readFileSync(resolved, "utf-8");

        if (args.head !== undefined) return ok(headLines(content, args.head));
        if (args.tail !== undefined) return ok(tailLines(content, args.tail));
        if (args.offset !== undefined) {
            const lines = splitTextLines(content);
            const start = Math.max(0, args.offset - 1);
            const end = args.limit !== undefined ? start + args.limit : undefined;
            return ok(lines.slice(start, end).join("\n"));
        }
        return ok(content);
    } catch (error: any) {
        return err(error.message);
    }
}

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

async function executeReadMultipleFiles(
    args: { paths: string[] },
): Promise<ToolExecutionResult> {
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
        return err("At least one file path must be provided");
    }

    const cwdRoot = getToolCwd();
    const results = args.paths.map((filePath) => {
        try {
            const resolved = requireExistingFile(filePath, cwdRoot);
            const content = fs.readFileSync(resolved, "utf-8");
            return `${path.relative(cwdRoot, resolved)}:\n${content}\n`;
        } catch (error: any) {
            return `${filePath}: Error - ${error.message}`;
        }
    });

    return ok(results.join("\n---\n"));
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

async function executeCreateDirectory(
    args: { path: string },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");

    try {
        const cwdRoot = getToolCwd();
        const resolved = validatePath(args.path, cwdRoot);
        fs.mkdirSync(resolved, { recursive: true });
        return ok(`Successfully created directory ${args.path}`);
    } catch (error: any) {
        return err(error.message);
    }
}

async function executeListDirectory(
    args: { path: string; sortBy?: "name" | "size" },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");

    try {
        const cwdRoot = getToolCwd();
        const resolved = requireExistingDirectory(args.path, cwdRoot);
        const entries = fs.readdirSync(resolved).map((entry) => {
            const full = path.join(resolved, entry);
            const stats = fs.lstatSync(full);
            return {
                name: entry,
                isDirectory: stats.isDirectory(),
                isSymbolicLink: stats.isSymbolicLink(),
                size: stats.size,
            };
        });

        const sorted = [...entries].sort((left, right) => {
            if (args.sortBy === "size") return right.size - left.size;
            return compareNames(left.name, right.name);
        });

        const lines = sorted.map((entry) =>
            `${entry.isSymbolicLink ? "[SYMLINK]" : entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${entry.isDirectory || entry.isSymbolicLink ? "" : formatSize(entry.size).padStart(10)}`
        );

        const totalFiles = entries.filter((entry) => !entry.isDirectory && !entry.isSymbolicLink).length;
        const totalDirs = entries.filter((entry) => entry.isDirectory).length;
        const totalSize = entries
            .filter((entry) => !entry.isDirectory && !entry.isSymbolicLink)
            .reduce((sum, entry) => sum + entry.size, 0);

        lines.push("", `Total: ${totalFiles} files, ${totalDirs} directories`, `Combined size: ${formatSize(totalSize)}`);
        return ok(lines.join("\n"));
    } catch (error: any) {
        return err(error.message);
    }
}

interface DirectoryTreeEntry {
    name: string;
    fullPath: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}

const DEFAULT_TREE_EXCLUDES = [".git", "node_modules"];

function buildDirectoryTree(
    currentPath: string,
    rootPath: string,
    excludePatterns: string[],
    prefix = "",
): string[] {
    const entries = fs.readdirSync(currentPath)
        .sort(compareNames)
        .flatMap<DirectoryTreeEntry>((name) => {
            const fullPath = path.join(currentPath, name);
            const stats = fs.lstatSync(fullPath);
            const isDirectory = stats.isDirectory();
            const relativePath = toPosix(path.relative(rootPath, fullPath));
            if (shouldExclude(relativePath, excludePatterns, isDirectory)) return [];

            return [{
                name,
                fullPath,
                isDirectory,
                isSymbolicLink: stats.isSymbolicLink(),
            }];
        });

    return entries.flatMap((entry, index) => {
        const isLast = index === entries.length - 1;
        const branch = isLast ? "└── " : "├── ";
        const suffix = entry.isDirectory ? "/" : entry.isSymbolicLink ? "@" : "";
        const lines = [`${prefix}${branch}${entry.name}${suffix}`];

        if (entry.isDirectory) {
            const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
            lines.push(...buildDirectoryTree(entry.fullPath, rootPath, excludePatterns, childPrefix));
        }

        return lines;
    });
}

async function executeDirectoryTree(
    args: { path: string; excludePatterns?: string[] },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");
    if (args.excludePatterns !== undefined && !Array.isArray(args.excludePatterns)) {
        return err("excludePatterns must be an array");
    }

    try {
        const cwdRoot = getToolCwd();
        const resolved = requireExistingDirectory(args.path, cwdRoot);
        const excludePatterns = [...DEFAULT_TREE_EXCLUDES, ...(args.excludePatterns || [])];
        const tree = buildDirectoryTree(resolved, resolved, excludePatterns);
        return ok([".", ...tree].join("\n"));
    } catch (error: any) {
        return err(error.message);
    }
}

async function executeMoveFile(
    args: { source: string; destination: string },
): Promise<ToolExecutionResult> {
    if (!args.source || !args.destination) return err("Missing required arguments: source and destination");

    try {
        const cwdRoot = getToolCwd();
        const sourcePath = validatePath(args.source, cwdRoot);
        const destinationPath = validatePath(args.destination, cwdRoot);
        if (!fs.existsSync(sourcePath)) throw new Error(`No such file or directory: ${args.source}`);
        if (fs.existsSync(destinationPath)) throw new Error(`Destination already exists: ${args.destination}`);
        if (!fs.existsSync(path.dirname(destinationPath))) {
            throw new Error(`No such file or directory: ${path.dirname(destinationPath)}`);
        }
        fs.renameSync(sourcePath, destinationPath);
        return ok(`Successfully moved ${args.source} to ${args.destination}`);
    } catch (error: any) {
        return err(error.message);
    }
}

async function executeSearchFiles(
    args: { path: string; pattern: string; excludePatterns?: string[] },
): Promise<ToolExecutionResult> {
    if (!args.path || !args.pattern) return err("Missing required arguments: path and pattern");
    if (args.excludePatterns !== undefined && !Array.isArray(args.excludePatterns)) {
        return err("excludePatterns must be an array");
    }

    try {
        const cwdRoot = getToolCwd();
        const rootPath = requireExistingDirectory(args.path, cwdRoot);
        // rg 的 glob 规则是最后一个匹配的胜出，exclude 必须放在 pattern 之后
        const rgArgs = [
            "--no-config",
            "--files",
            `--glob=${args.pattern}`,
            ...(args.excludePatterns ?? []).map((exclude) => `--glob=!${exclude}`),
            ".",
        ];
        const { stdout } = await execFileAsync(resolveRgBinary(), rgArgs, { cwd: rootPath });
        const matches = stdout
            .split("\n")
            .filter(Boolean)
            .map((relativePath) => path.relative(cwdRoot, path.resolve(rootPath, relativePath)))
            .sort();
        return ok(matches.length > 0 ? matches.join("\n") : "No matches found");
    } catch (error: any) {
        if (error.code === 1) return ok("No matches found");
        if (error.code === "ENOENT") {
            return err("ripgrep binary not found. Set RG_BIN to the rg path or install ripgrep");
        }
        return err(error.message);
    }
}

async function executeGetFileInfo(
    args: { path: string },
): Promise<ToolExecutionResult> {
    if (!args.path) return err("Missing required argument: path");

    try {
        const cwdRoot = getToolCwd();
        const resolved = validatePath(args.path, cwdRoot);
        if (!fs.existsSync(resolved)) throw new Error(`No such file or directory: ${args.path}`);

        const stats = fs.statSync(resolved);
        const lines = [
            `size: ${stats.size}`,
            `created: ${stats.birthtime.toISOString()}`,
            `modified: ${stats.mtime.toISOString()}`,
            `accessed: ${stats.atime.toISOString()}`,
            `isDirectory: ${stats.isDirectory()}`,
            `isFile: ${stats.isFile()}`,
            `permissions: ${stats.mode.toString(8).slice(-3)}`,
        ];

        return ok(lines.join("\n"));
    } catch (error: any) {
        return err(error.message);
    }
}

const catSchema = {
    type: "object",
    properties: {
        path: { type: "string", description: "File path" },
        paths: {
            type: "array",
            description: "Array of file paths to read simultaneously (cannot be used with path)",
            items: { type: "string" },
        },
        head: { type: "number", description: "If provided, returns only the first N lines of the file" },
        tail: { type: "number", description: "If provided, returns only the last N lines of the file" },
        offset: { type: "number", description: "1-based line offset to start reading from (with limit for paging)" },
        limit: { type: "number", description: "Maximum number of lines to read (with offset for paging)" },
    },
};

const readMediaFileSchema = {
    type: "object",
    properties: {
        path: { type: "string", description: "File path" },
    },
    required: ["path"],
};

const directoryPathSchema = {
    type: "object",
    properties: {
        path: { type: "string", description: "Directory path" },
    },
    required: ["path"],
};

export const readTextFileTool: ExecutableTool = {
    name: "cat",
    description: "Read the complete contents of one or more files as text. Supports head/tail for partial read, offset/limit for line paging.",
    tags: ["core", "filesystem"],
    inputSchema: catSchema,
    execute: executeCat,
    // 文件全文是后续编辑的直接依据，截断会破坏任务连续性
    contextPolicy: { mode: "full" },
};

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

export const createDirectoryTool: ExecutableTool = {
    name: "mkdir",
    description: "Create a new directory or ensure a directory exists.",
    tags: ["core", "filesystem"],
    inputSchema: directoryPathSchema,
    execute: executeCreateDirectory,
};

export const listDirectoryTool: ExecutableTool = {
    name: "ls",
    description: "Get a detailed listing of all files and directories in a specified path, with file sizes and summary statistics.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Directory path" },
            sortBy: { type: "string", enum: ["name", "size"], default: "name", description: "Sort entries by name or size" },
        },
        required: ["path"],
    },
    execute: executeListDirectory,
};

export const directoryTreeTool: ExecutableTool = {
    name: "tree",
    description: "Get a compact recursive tree view of files and directories, excluding .git and node_modules by default.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Starting directory" },
            excludePatterns: {
                type: "array",
                description: "Exclude any patterns",
                items: { type: "string" },
                default: [],
            },
        },
        required: ["path"],
    },
    execute: executeDirectoryTree,
};

export const moveFileTool: ExecutableTool = {
    name: "mv",
    description: "Move or rename files and directories.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            source: { type: "string", description: "Source path" },
            destination: { type: "string", description: "Destination path" },
        },
        required: ["source", "destination"],
    },
    execute: executeMoveFile,
};

export const searchFilesTool: ExecutableTool = {
    name: "find",
    description: "Recursively search for files and directories matching a glob pattern.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Starting directory" },
            pattern: { type: "string", description: "Glob-style search pattern" },
            excludePatterns: {
                type: "array",
                description: "Exclude any patterns",
                items: { type: "string" },
                default: [],
            },
        },
        required: ["path", "pattern"],
    },
    execute: executeSearchFiles,
};

export const getFileInfoTool: ExecutableTool = {
    name: "stat",
    description: "Retrieve detailed metadata about a file or directory.",
    tags: ["core", "filesystem"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "File or directory path" },
        },
        required: ["path"],
    },
    execute: executeGetFileInfo,
};

export const FILE_OPS_TOOLS: ExecutableTool[] = [
    readTextFileTool,
    readMediaFileTool,
    writeFileTool,
    editFileTool,
    createDirectoryTool,
    listDirectoryTool,
    directoryTreeTool,
    moveFileTool,
    searchFilesTool,
    getFileInfoTool,
    grepFileTool,
];
