import * as path from "path";
import { formatToolArguments } from "../utils/tool-progress.js";
import { getToolCwd } from "../utils/runtime-paths.js";
import { CUSTOM_ANSWER_PREFIX, questionLabel } from "../utils/user-question.js";
import { theme } from "./theme.js";
import {
    isRecord,
    type AskUserDigest,
    type AskUserQA,
    type CollapsedToolBlock,
    type EditFileDiff,
    type EditFileDiffLine,
} from "./tool-block-model.js";
import {
    getPatchToolTag,
    isApplyPatchTool,
    isAskUserTool,
    isBashTool,
    isFileMutationTool,
    isTodoTool,
    parseFileBlock,
    parseAskUserBlock,
    removeDiffFences,
} from "./tool-block-parse.js";

/** 展示用路径：位于当前工作目录下的绝对路径转为相对路径，其余路径保持原样。 */
export function displayPath(filePath: string, cwd: string = getToolCwd()): string {
    if (!path.isAbsolute(filePath)) return filePath;
    const relative = path.relative(cwd, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
    return relative;
}

/** 将工具参数转换为工具块中适合阅读的单行文本。 */
export function formatToolBlockArgs(toolName: string, args?: string): string {
    const rawArgs = args ?? "";
    const normalizedArgs = rawArgs.trim();
    if (!normalizedArgs || normalizedArgs === "{}" || normalizedArgs === "[]") return "";
    if (!isBashTool(toolName)) return rawArgs;

    let parsedArgs: unknown;
    try {
        parsedArgs = JSON.parse(normalizedArgs);
    } catch {
        return rawArgs;
    }

    if (!isRecord(parsedArgs)) return rawArgs;

    const command = typeof parsedArgs.command === "string"
        ? parsedArgs.command
        : Array.isArray(parsedArgs.commands) && parsedArgs.commands.every((item) => typeof item === "string")
            ? parsedArgs.commands.join(" | ")
            : undefined;
    if (!command) return rawArgs;

    const otherArgs = { ...parsedArgs };
    delete otherArgs.command;
    delete otherArgs.commands;
    // 默认值（false）时省略 enable_proxy，避免噪音
    if (otherArgs.enable_proxy === false) {
        delete otherArgs.enable_proxy;
    }

    const prefix = formatToolArguments(otherArgs);
    return [prefix, command.trim()].filter(Boolean).join(" ");
}

/** 折叠态正文占位符。 */
const COLLAPSED_TEXT_PLACEHOLDER = "...";

/** 折叠态需要隐藏 text 正文字段的工具。 */
const COLLAPSED_LONG_TEXT_TOOLS = new Set(["session_send"]);

/** 折叠态参数行：普通工具走常规格式化，正文类工具只把 text 换成占位符。 */
export function formatCollapsedToolArgs(toolName: string, args?: string): string {
    const rawArgs = args ?? "";
    if (COLLAPSED_LONG_TEXT_TOOLS.has(toolName)) {
        const collapsedArgs = shortenTextArg(rawArgs);
        if (collapsedArgs !== undefined) return collapsedArgs;
    }
    return formatToolBlockArgs(toolName, rawArgs);
}

/** 把 text 字段换成占位符并按 name=value 排版；参数不是合法 JSON 时返回 undefined 交给常规渲染。 */
function shortenTextArg(rawArgs: string): string | undefined {
    let parsedArgs: unknown;
    try {
        parsedArgs = JSON.parse(rawArgs.trim());
    } catch {
        return undefined;
    }
    if (!isRecord(parsedArgs)) return undefined;

    const collapsedArgs = Object.fromEntries(
        Object.entries(parsedArgs).map(([key, value]) => [
            key,
            key === "text" && typeof value === "string" ? COLLAPSED_TEXT_PLACEHOLDER : value,
        ]),
    );
    return formatToolArguments(collapsedArgs);
}

/** 渲染非展开模式的工具摘要；特殊工具交给专用渲染器处理。 */
export function renderCollapsedToolBlock(block: CollapsedToolBlock): string {
    const digest = isAskUserTool(block.name) ? parseAskUserBlock(block) : undefined;
    if (digest) return renderAskUserBlock(digest);

    if (isFileMutationTool(block.name) && block.result !== undefined) {
        return renderCollapsedFileBlocks([block]);
    }

    const status = block.result === undefined
        ? ""
        : block.isError
            ? ` ${theme.statusBad("❌")}`
            : ` ${theme.statusOk("✅")}`;
    const lines = [theme.tool(`🔧 ${block.name}`) + status];
    const argsText = formatCollapsedToolArgs(block.name, block.args);
    if (argsText) lines.push(theme.toolArgs(argsText));
    return lines.join("\n");
}

/** 渲染展开模式的工具块；文件变更工具（edit_file / write_file）无需显示参数。 */
export function renderExpandedToolBlock(block: CollapsedToolBlock): string {
    const digest = isAskUserTool(block.name) ? parseAskUserBlock(block) : undefined;
    if (digest) return renderAskUserBlock(digest);

    if (isFileMutationTool(block.name) && block.result !== undefined) {
        return renderCollapsedFileBlocks([block]);
    }

    const lines = [theme.tool(`🔧 ${block.name}`)];
    const formattedArgs = formatToolBlockArgs(block.name, block.args);
    if (formattedArgs) {
        lines.push(theme.toolArgs(formattedArgs));
    }
    if (block.result !== undefined) {
        lines.push(renderToolBlockResult(block.name, block.result, block.isError, block.args));
    }
    return lines.join("\n");
}

/** 将 bash / Shell__bash 等 shell 工具的结果转为终端可读的纯文本或带样式的文本。 */
function formatBashToolResult(result: string, isError = false): string {
    const trimmed = result.trim();
    if (!trimmed) return "";

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return isError ? theme.toolError(result) : theme.toolResult(result);
    }

    if (typeof parsed === "string") {
        return isError ? theme.toolError(parsed) : theme.toolResult(parsed);
    }

    if (isRecord(parsed)) {
        if (parsed.background === true && typeof parsed.task_id === "string") {
            const status = typeof parsed.status === "string" ? parsed.status : "running";
            const command = typeof parsed.command === "string" ? parsed.command : "";
            const message = typeof parsed.message === "string" ? parsed.message : "可使用 /tasks 查看和管理";
            const statusLabel = status === "running" ? "运行中" : status;
            return [
                theme.statusOk(`↗ 后台任务 ${parsed.task_id} · ${statusLabel}`),
                ...(command ? [theme.toolArgs(command)] : []),
                theme.dim(message),
            ].join("\n");
        }

        const stdout = typeof parsed.stdout === "string" ? parsed.stdout.trim() : "";
        const stderr = typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";
        const output = typeof parsed.output === "string" ? parsed.output.trim() : "";
        const error = typeof parsed.error === "string" ? parsed.error.trim() : "";

        const parts: string[] = [];
        if (stderr) {
            parts.push(theme.toolError(stderr));
        }
        if (stdout) {
            parts.push(theme.toolResult(stdout));
        }
        if (output) {
            parts.push(isError ? theme.toolError(output) : theme.toolResult(output));
        }
        if (error) {
            parts.push(theme.toolError(error));
        }

        if (parts.length > 0) {
            return parts.join("\n");
        }
    }

    return isError ? theme.toolError(result) : theme.toolResult(result);
}

/** 将工具结果转为终端文本；对文件变更工具和 Shell 工具做针对性格式化。 */
export function renderToolBlockResult(toolName: string, result: string, isError = false, args?: string): string {
    if (isBashTool(toolName)) {
        return formatBashToolResult(result, isError);
    }

    if (isError || !isFileMutationTool(toolName)) return isError ? theme.toolError(result) : theme.toolResult(result);

    const files = parseFileBlock({ name: toolName, args, result, isError });
    if (files.length === 0) return theme.toolResult(removeDiffFences(result));
    const toolTag = getPatchToolTag(toolName);
    return renderEditFileOutput(files, false, toolTag);
}

/** 将多个已完成的文件变更工具块（edit_file/write_file）合并为统一的变更摘要。 */
export function renderCollapsedFileBlocks(
    blocks: Array<{ name?: string; args?: string; result?: string; isError?: boolean }>,
): string {
    const files = blocks.flatMap((block) => parseFileBlock(block));
    const errors = blocks.filter((block) => block.result !== undefined && block.isError);

    if (files.length === 0 && errors.length > 0) {
        return `${theme.tool("🔧")} ${theme.toolError(errors[0].result ?? "")}`;
    }
    if (files.length === 0) {
        const toolName = blocks[0]?.name ?? "edit_file";
        return theme.tool(`🔧 ${toolName}`);
    }

    const isPatch = blocks.length > 0 && blocks.every((b) => isApplyPatchTool(b.name ?? ""));
    const toolTag = isPatch ? getPatchToolTag(blocks[0]?.name ?? "apply_patch") : undefined;
    return renderEditFileOutput(files, true, toolTag);
}

/** 保持向后兼容的别名，转调 renderCollapsedFileBlocks。 */
export function renderCollapsedEditFileBlocks(
    blocks: Array<{ name?: string; args?: string; result?: string; isError?: boolean }>,
): string {
    return renderCollapsedFileBlocks(blocks);
}

/** 渲染多文件变更：摘要行 + 每文件的子标题与 diff 行。 */
function renderEditFileOutput(files: EditFileDiff[], includeIcon: boolean, toolTag?: string): string {
    const displayFiles = files.map((file) => ({
        ...file,
        path: displayPath(file.path),
        oldPath: file.oldPath === undefined ? undefined : displayPath(file.oldPath),
    }));
    const additions = displayFiles.reduce((total, file) => total + file.additions, 0);
    const removals = displayFiles.reduce((total, file) => total + file.removals, 0);
    const summary = getEditFileSummary(displayFiles);
    const summaryText = toolTag ? `${summary} [${toolTag}]` : summary;
    const lines = [renderEditSummary(summaryText, additions, removals)];

    if (displayFiles.length === 1) {
        lines.push(...renderEditDiffLines(displayFiles[0].lines));
    } else {
        for (const file of displayFiles) {
            lines.push(renderFileSubHeader(file));
            lines.push(...renderEditDiffLines(file.lines));
        }
    }

    if (includeIcon) lines[0] = `${theme.tool("🔧")} ${lines[0]}`;
    return lines.join("\n");
}

/** 渲染多文件变更中每个文件的子标题（删除 / 重命名 / 新建 / 普通编辑）。 */
function renderFileSubHeader(file: EditFileDiff): string {
    if (file.action === "delete") {
        return [
            theme.tool("  └ "),
            theme.toolDiffDeleted(`~~${file.path}~~`),
        ].join("");
    }
    if (file.oldPath) {
        return [
            theme.tool("  └ "),
            theme.toolDiffAdded("[renamed]"),
            theme.tool(` ${file.oldPath} → ${file.path} (`),
            theme.toolDiffAdded(`+${file.additions}`),
            theme.tool(" "),
            theme.toolDiffRemoved(`-${file.removals}`),
            theme.tool(")"),
        ].join("");
    }
    if (file.action === "write") {
        return [
            theme.tool("  └ "),
            theme.toolDiffAdded("New"),
            theme.tool(` ${file.path} (`),
            theme.toolDiffAdded(`+${file.additions}`),
            theme.tool(" "),
            theme.toolDiffRemoved(`-${file.removals}`),
            theme.tool(")"),
        ].join("");
    }
    return renderEditSummary(`  └ ${file.path}`, file.additions, file.removals);
}

/** 生成变更摘要文案（单文件精确动作，多文件按动作归并）。 */
function getEditFileSummary(files: EditFileDiff[]): string {
    if (files.length === 1) {
        const first = files[0];
        if (first.oldPath) return `Renamed ${first.oldPath} → ${first.path}`;
        if (first.action === "write") return `Wrote ${first.path}`;
        if (first.action === "delete") return `Deleted ${first.path}`;
        return `Edited ${first.path}`;
    }

    const hasRename = files.some((f) => Boolean(f.oldPath));
    const actions = new Set(files.map((f) => f.action || "edit"));
    if (!hasRename && actions.size === 1) {
        if (actions.has("write")) return `Wrote ${files.length} files`;
        if (actions.has("delete")) return `Deleted ${files.length} files`;
        return `Edited ${files.length} files`;
    }
    return `Updated ${files.length} files`;
}

/** 渲染「标签 (+新增 -删除)」形式的摘要行。 */
function renderEditSummary(label: string, additions: number, removals: number): string {
    return [
        theme.tool(`${label} (`),
        theme.toolDiffAdded(`+${additions}`),
        theme.tool(" "),
        theme.toolDiffRemoved(`-${removals}`),
        theme.tool(")"),
    ].join("");
}

/** 渲染 diff 行：行号右对齐 + 变更标记，按类型着色。 */
function renderEditDiffLines(lines: EditFileDiffLine[]): string[] {
    const lineNumberWidth = Math.max(...lines.map((line) => String(line.lineNumber).length), 1);
    return lines.map((line) => {
        const lineNumber = String(line.lineNumber).padStart(lineNumberWidth);
        const marker = line.type === "context" ? " " : line.type === "added" ? "+" : "-";
        const text = `${lineNumber} ${marker} ${line.text}`;
        if (line.type === "added") return theme.toolDiffAdded(text);
        if (line.type === "removed") return theme.toolDiffRemoved(text);
        return theme.toolResult(text);
    });
}

// ── 用户提问（ask_user） ────────────────────────────────────────────────────

/**
 * 渲染问答块：一问一行 `✓ 1. 标签 · 题干 → 选择`，未作答的题只留题干（`·` 打头）。
 * 本轮由行数与逐题标记体现，标题只报状态。
 * 与提问浮层的逐题回显同构，事后回看事件流时能直接看到「问了什么、答了什么」。
 */
function renderAskUserBlock(digest: AskUserDigest): string {
    const stateText = digest.state === "pending" ? "等待作答" : digest.state === "cancelled" ? "已取消" : "";
    const lines = [theme.question(stateText ? `❓ 提问（${stateText}）` : "❓ 提问")];
    digest.questions.forEach((question, index) => {
        lines.push(renderAskUserQuestion(index, question, digest.state === "answered"));
    });
    return lines.join("\n");
}

/** 单道题的问答行：作答过则补 ` → 选择`（自填内容排在选中项之后）。 */
function renderAskUserQuestion(index: number, question: AskUserQA, isAnswered: boolean): string {
    const choices = [
        ...question.selected,
        ...(question.custom ? [`${CUSTOM_ANSWER_PREFIX}${question.custom}`] : []),
    ];
    const prefix = theme.tool(` ${isAnswered && choices.length > 0 ? "✓" : "·"} ${index + 1}. `);
    const body = theme.toolResult(questionLabel(question));
    if (!isAnswered || choices.length === 0) return prefix + body;
    return [prefix, body, theme.tool(" → "), theme.statusOk(choices.join("、"))].join("");
}

// 对外导出面保持：app.ts / store.ts / 测试实际导入的函数继续从本模块导出
export { isAskUserTool, isFileMutationTool, isTodoTool };
