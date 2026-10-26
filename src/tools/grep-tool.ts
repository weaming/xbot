/**
 * grep 工具：基于 ripgrep 的文件内容搜索
 * 调用逻辑参考 sst/opencode 的 grep 实现（MIT）：rg --json 输出、退出码语义、结果分组格式
 * 差异：流式解析并按 limit 提前终止子进程，输出路径相对搜索目录
 */

import { spawn } from "child_process";
import * as fs from "fs";
import path from "path";
import readline from "readline";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { ok, err } from "./tool-interface.js";
import { resolvePath } from "./path-utils.js";
import { getToolCwd } from "../utils/runtime-paths.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_LINE_TEXT_CHARS = 2000;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

type MatchRow = {
    path: string;
    lineNumber: number;
    text: string;
};

type GrepRunResult = {
    matches: MatchRow[];
    truncated: boolean;
    exitCode: number;
    stderr: string;
};

/** rg 二进制解析：环境变量覆盖 → PATH。 */
export function resolveRgBinary(): string {
    if (process.env.RG_BIN) return process.env.RG_BIN;
    return "rg";
}

/** 解析 rg --json 输出的一行；非 match 类型或格式异常返回 null */
function parseMatchLine(line: string): MatchRow | null {
    if (line.length > 0 && Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) return null;

    let json: any;
    try {
        json = JSON.parse(line);
    } catch {
        return null;
    }

    if (!json || typeof json !== "object" || json.type !== "match") return null;

    const data = json.data;
    const rawPath = typeof data?.path === "string" ? data.path : data?.path?.text;
    const rawText = typeof data?.lines === "string" ? data.lines : data?.lines?.text;
    if (typeof rawPath !== "string" || typeof rawText !== "string") return null;

    return {
        path: rawPath.replace(/^(?:\.[\\/])+/, ""),
        lineNumber: Number(data.line_number) || 0,
        text: rawText,
    };
}

/** 流式执行 rg：收集匹配，达到 limit 即终止子进程，避免大仓库全量输出 */
function runGrep(
    binary: string,
    rgArgs: string[],
    searchPath: string,
    limit: number,
    signal?: AbortSignal,
): Promise<GrepRunResult> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(binary, rgArgs, { cwd: searchPath, stdio: ["ignore", "pipe", "pipe"] });
        const matches: MatchRow[] = [];
        const stderrChunks: Buffer[] = [];
        let stderrBytes = 0;
        let truncated = false;
        let settled = false;

        const finish = (exitCode: number) => {
            if (settled) return;
            settled = true;
            resolvePromise({
                matches,
                truncated,
                exitCode,
                stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
            });
        };

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stderr.on("data", (chunk: Buffer) => {
            if (stderrBytes >= MAX_STDERR_BYTES) return;
            const remain = MAX_STDERR_BYTES - stderrBytes;
            stderrChunks.push(chunk.subarray(0, remain));
            stderrBytes += remain;
        });

        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            if (matches.length >= limit) {
                truncated = true;
                child.kill();
                return;
            }
            const match = parseMatchLine(line);
            if (match) matches.push({ ...match, path: path.resolve(searchPath, match.path) });
        });

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            rejectPromise(error);
        });

        child.on("close", (code) => {
            signal?.removeEventListener("abort", onAbort);
            finish(code ?? 0);
        });
    });
}

/** 截断超长匹配行，避免 minified 文件刷屏 */
function formatLineText(text: string): string {
    const trimmed = text.trimEnd();
    return trimmed.length > MAX_LINE_TEXT_CHARS ? `${trimmed.slice(0, MAX_LINE_TEXT_CHARS)}...` : trimmed;
}

/** 输出格式：文件分组 + 行号缩进，路径相对当前 cwd 根（对齐 opencode 的展示） */
function formatMatches(
    matches: MatchRow[],
    cwdRoot: string,
    limit: number,
    truncated: boolean,
): string {
    if (matches.length === 0) return "No matches found";

    const lines = [`Found ${matches.length} matches`];
    let currentFile = "";
    for (const match of matches) {
        const relPath = path.relative(cwdRoot, match.path);
        if (relPath !== currentFile) {
            if (currentFile !== "") lines.push("");
            currentFile = relPath;
            lines.push(`${relPath}:`);
        }
        lines.push(`  Line ${match.lineNumber}: ${formatLineText(match.text)}`);
    }
    if (truncated) {
        lines.push("", `(已截断，仅显示前 ${limit} 条匹配)`);
    }
    return lines.join("\n");
}

async function executeGrep(
    args: { cwd?: string; pattern?: string; path?: string; include?: string; limit?: number },
    signal?: AbortSignal,
): Promise<ToolExecutionResult> {
    if (!args.cwd) return err("Missing required argument: cwd");
    if (!args.pattern) return err("Missing required argument: pattern");

    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cwdRoot = resolvePath(args.cwd, getToolCwd());
    if (!fs.existsSync(cwdRoot) || !fs.statSync(cwdRoot).isDirectory()) {
        return err(`Invalid cwd: ${args.cwd}`);
    }

    let searchPath = cwdRoot;
    if (args.path) {
        searchPath = resolvePath(args.path, cwdRoot);
    }

    const rgArgs = [
        "--no-config",
        "--json",
        "--hidden",
        "--no-messages",
        ...(args.include ? [`--glob=${args.include}`] : []),
        "--glob=!**/.git/**",
        "--",
        args.pattern,
        ".",
    ];

    const binary = resolveRgBinary();
    let result: GrepRunResult;
    try {
        result = await runGrep(binary, rgArgs, searchPath, limit, signal);
    } catch (error: any) {
        if (error.code === "ENOENT") {
            return err(`ripgrep binary not found: ${binary}. Set RG_BIN to the rg path or install ripgrep`);
        }
        return err(`grep 执行失败: ${error.message}`);
    }

    // rg 退出码：0=有匹配，1=无匹配，2=正则或参数错误
    if (!result.truncated && result.exitCode === 1) return ok("No matches found");
    if (result.exitCode === 2) {
        return err(`Invalid regex pattern: ${result.stderr || "unknown error"}`);
    }

    return ok(formatMatches(result.matches, cwdRoot, limit, result.truncated));
}

const grepSchema = {
    type: "object",
    properties: {
        cwd: { type: "string", description: "搜索工作目录，相对当前目录解析" },
        pattern: { type: "string", description: "正则表达式，用于搜索文件内容" },
        path: { type: "string", description: "要搜索的子目录（相对 cwd），默认为 cwd" },
        include: {
            type: "string",
            description: '文件过滤 glob，例如 "*.ts" 或 "*.{ts,tsx}"，只搜索匹配的文件',
        },
        limit: { type: "number", description: "最多返回的匹配条数（默认 200，最大 1000）" },
    },
    required: ["cwd", "pattern"],
};

export const grepFileTool: ExecutableTool = {
    name: "grep",
    description: "用正则表达式在指定 cwd 中搜索文件内容，返回文件路径、行号和匹配行；支持 path、include 和 limit",
    tags: ["core", "filesystem"],
    inputSchema: grepSchema,
    execute: executeGrep,
};
