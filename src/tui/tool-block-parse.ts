/**
 * 工具块解析层：工具名判定、文件变更 diff 解析。
 * 只做纯函数解析，不依赖主题与渲染，便于单独测试。
 */
import { CUSTOM_ANSWER_PREFIX } from "../utils/user-question.js";
import { getPatchToolTag, isApplyPatchTool, isFileMutationTool } from "../tools/tool-kinds.js";
import {
    isRecord,
    type AskUserDigest,
    type AskUserPrompt,
    type AskUserQA,
    type EditFileDiff,
    type EditFileDiffLine,
} from "./tool-block-model.js";

// 工具类别判定与发送前适配共用一套口径，这里只做转发
export { getPatchToolTag, isApplyPatchTool, isFileMutationTool };

/** 判断是否为本地或远程 bash / shell 工具。 */
export function isBashTool(toolName: string): boolean {
    const normalizedName = toolName.toLowerCase();
    return (
        normalizedName === "bash"
        || normalizedName === "shell"
        || normalizedName === "execute_shell"
        || normalizedName.endsWith("__bash")
        || normalizedName.endsWith("__fish")
        || normalizedName.endsWith("__zsh")
        || normalizedName.endsWith("__sh")
        || normalizedName.endsWith("__shell")
    );
}

/** 判断是否为 todo 任务清单工具。 */
export function isTodoTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return normalized === "todo" || normalized.endsWith("__todo") || normalized.endsWith(":todo");
}

/** 判断是否为用户提问工具（ask_user 及其本地 / MCP 命名变体）。 */
export function isAskUserTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "ask_user"
        || normalized.endsWith("__ask_user")
        || normalized.endsWith(":ask_user")
    );
}

/** 按工具名分派到对应的文件变更解析器。 */
export function parseFileBlock(block: { name?: string; args?: string; result?: string; isError?: boolean }): EditFileDiff[] {
    if (!block.result || block.isError) return [];
    const name = (block.name ?? "edit_file").toLowerCase();
    if (name === "write_file" || name === "write_files" || name.endsWith("__write_file") || name.endsWith("__write_files")) {
        return parseWriteFileBlock(block);
    }
    if (name === "apply_patch" || name.endsWith("__apply_patch")) {
        return parseApplyPatchBlock(block);
    }
    return parseEditFileResult(block.result);
}

/** 解析 write_file 参数中的整文件内容为全 added 的 diff。 */
function parseWriteFileBlock(block: { name?: string; args?: string; result?: string }): EditFileDiff[] {
    const rawArgs = block.args ?? "";
    let path = "";
    let content: string | undefined;

    try {
        const parsed = JSON.parse(rawArgs);
        if (isRecord(parsed)) {
            if (typeof parsed.path === "string") path = parsed.path;
            if (typeof parsed.content === "string") content = parsed.content;
        }
    } catch {
        // 忽略非 JSON 参数
    }

    if (!path && block.result) {
        const match = block.result.match(/Successfully wrote to (.+)/i);
        if (match?.[1]) {
            path = match[1].trim();
        }
    }

    if (!path) return [];

    const lines: EditFileDiffLine[] = [];
    if (content !== undefined) {
        const rawLines = content === "" ? [] : content.split(/\r\n|\r|\n/);
        for (let index = 0; index < rawLines.length; index++) {
            lines.push({
                type: "added",
                lineNumber: index + 1,
                text: rawLines[index],
            });
        }
    }

    return [{
        path,
        action: "write",
        additions: lines.length,
        removals: 0,
        lines,
    }];
}

/** 解析 apply_patch 参数中的 patch 文本，失败时回退结果摘要。 */
function parseApplyPatchBlock(block: { name?: string; args?: string; result?: string }): EditFileDiff[] {
    const rawArgs = block.args ?? "";
    let patch = "";

    try {
        const parsed = JSON.parse(rawArgs);
        if (isRecord(parsed)) {
            if (typeof parsed.patch === "string") {
                patch = parsed.patch;
            }
        } else if (typeof parsed === "string") {
            patch = parsed;
        }
    } catch {
        if (rawArgs.includes("*** Begin Patch") || rawArgs.includes("*** Update File:") || rawArgs.includes("*** Add File:")) {
            patch = rawArgs;
        }
    }

    if (patch) {
        const diffs = parseApplyPatchText(patch);
        if (diffs.length > 0) return diffs;
    }

    if (block.result) {
        return parseApplyPatchSummary(block.result);
    }

    return [];
}

/** 逐行解析 Codex patch 文本为按文件分组的 diff。 */
function parseApplyPatchText(patch: string): EditFileDiff[] {
    const lines = cleanPatchLines(patch);
    const files: EditFileDiff[] = [];
    let currentFile: EditFileDiff | null = null;
    let oldLineNumber = 1;
    let newLineNumber = 1;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();

        if (trimmed === "*** Begin Patch" || trimmed === "*** End Patch" || trimmed.startsWith("*** Environment ID:")) {
            continue;
        }

        if (trimmed.startsWith("*** Add File:")) {
            if (currentFile) files.push(currentFile);
            const filePath = trimmed.replace("*** Add File:", "").trim();
            currentFile = {
                path: filePath,
                action: "write",
                additions: 0,
                removals: 0,
                lines: [],
            };
            newLineNumber = 1;
            continue;
        }

        if (trimmed.startsWith("*** Delete File:")) {
            if (currentFile) files.push(currentFile);
            const filePath = trimmed.replace("*** Delete File:", "").trim();
            currentFile = {
                path: filePath,
                action: "delete",
                additions: 0,
                removals: 0,
                lines: [],
            };
            continue;
        }

        if (trimmed.startsWith("*** Update File:")) {
            if (currentFile) files.push(currentFile);
            const filePath = trimmed.replace("*** Update File:", "").trim();
            currentFile = {
                path: filePath,
                action: "edit",
                additions: 0,
                removals: 0,
                lines: [],
            };
            oldLineNumber = 1;
            newLineNumber = 1;
            continue;
        }

        if (trimmed.startsWith("*** Move to:") && currentFile) {
            const movePath = trimmed.replace("*** Move to:", "").trim();
            if (movePath) {
                currentFile.oldPath = currentFile.path;
                currentFile.path = movePath;
            }
            continue;
        }

        if (trimmed === "*** End of File" || trimmed.startsWith("@@")) {
            continue;
        }

        if (!currentFile) continue;

        if (currentFile.action === "write") {
            if (line.startsWith("+")) {
                currentFile.lines.push({
                    type: "added",
                    lineNumber: newLineNumber++,
                    text: line.slice(1),
                });
                currentFile.additions++;
            }
        } else {
            if (line.startsWith("+")) {
                currentFile.lines.push({
                    type: "added",
                    lineNumber: newLineNumber++,
                    text: line.slice(1),
                });
                currentFile.additions++;
            } else if (line.startsWith("-")) {
                currentFile.lines.push({
                    type: "removed",
                    lineNumber: oldLineNumber++,
                    text: line.slice(1),
                });
                currentFile.removals++;
            } else if (line.startsWith(" ")) {
                currentFile.lines.push({
                    type: "context",
                    lineNumber: newLineNumber++,
                    text: line.slice(1),
                });
                oldLineNumber++;
            }
        }
    }

    if (currentFile) {
        files.push(currentFile);
    }

    return files;
}

/** 去掉 heredoc 包裹（`<<EOF ... EOF`），其余原样返回。 */
function cleanPatchLines(patchText: string): string[] {
    const rawLines = patchText.split(/\r\n|\r|\n/);
    if (rawLines.length >= 4) {
        const first = rawLines[0].trim();
        const last = rawLines[rawLines.length - 1].trim();
        if (
            (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"')
            && last.endsWith("EOF")
        ) {
            return rawLines.slice(1, -1);
        }
    }
    return rawLines;
}

/** 解析 `A path` / `M path` / `D path` 形式的 patch 结果摘要。 */
function parseApplyPatchSummary(result: string): EditFileDiff[] {
    const lines = result.split(/\r\n|\r|\n/);
    const files: EditFileDiff[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^[AMD]\s+(.+)$/);
        if (match) {
            files.push({
                path: match[1].trim(),
                action: trimmed.startsWith("A ") ? "write" : trimmed.startsWith("D ") ? "delete" : "edit",
                additions: 0,
                removals: 0,
                lines: [],
            });
        }
    }
    return files;
}

/** 解析标准 unified diff 文本为按文件分组的 diff。 */
function parseEditFileResult(result: string): EditFileDiff[] {
    const lines = removeDiffFences(result).split(/\r\n|\r|\n/);
    const files: EditFileDiff[] = [];
    let index = 0;

    while (index < lines.length - 1) {
        if (!lines[index].startsWith("--- ") || !lines[index + 1].startsWith("+++ ")) {
            index++;
            continue;
        }

        const file: EditFileDiff = {
            path: parseDiffPath(lines[index + 1]),
            additions: 0,
            removals: 0,
            lines: [],
        };
        let oldLineNumber = 0;
        let newLineNumber = 0;
        let hasHunk = false;
        index += 2;

        while (index < lines.length) {
            if (isDiffFileHeader(lines, index)) break;

            const hunk = lines[index].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunk) {
                oldLineNumber = Number(hunk[1]);
                newLineNumber = Number(hunk[2]);
                hasHunk = true;
                index++;
                continue;
            }

            if (hasHunk && lines[index].startsWith(" ")) {
                file.lines.push({ type: "context", lineNumber: newLineNumber, text: lines[index].slice(1) });
                oldLineNumber++;
                newLineNumber++;
            } else if (hasHunk && lines[index].startsWith("-")) {
                file.lines.push({ type: "removed", lineNumber: oldLineNumber, text: lines[index].slice(1) });
                file.removals++;
                oldLineNumber++;
            } else if (hasHunk && lines[index].startsWith("+")) {
                file.lines.push({ type: "added", lineNumber: newLineNumber, text: lines[index].slice(1) });
                file.additions++;
                newLineNumber++;
            }
            index++;
        }

        files.push(file);
    }

    return files;
}

/** 判断该行是否为下一个文件的 diff 头（`--- ` 紧跟 `+++ `）。 */
function isDiffFileHeader(lines: string[], index: number): boolean {
    return lines[index].startsWith("--- ") && lines[index + 1]?.startsWith("+++ ") === true;
}

/** 从 `+++ ` 行提取文件路径（去掉时间戳列）。 */
function parseDiffPath(line: string): string {
    return line.slice(4).split("\t", 1)[0].trim();
}

// ── ask_user 问答 ───────────────────────────────────────────────────────────

/** 工具结果里的取消口径（与 tools/ask-user-tool.ts 的 formatAnswer 一致）。 */
const ASK_USER_CANCEL_MARK = "取消了这次提问";
/** 题干与选择之间的分隔符。 */
const ANSWER_SEPARATOR = " → ";
/** 未作答的占位文本。 */
const NO_ANSWER_TEXT = "（未作答）";

/**
 * 解析 `ask_user` 工具块为问答展示数据：题干取自参数（模型提问时的原样），
 * 作答从结果文本里还原（工具只回文本，逐题按「序号 + 题干」锚定，题干含箭头也不会切错）。
 *
 * 参数不是可用的题目（缺 questions、非法 JSON）或结果格式不认识时返回 undefined，
 * 交回通用工具块渲染 —— 宁可显示原文，也不要错行。
 */
export function parseAskUserBlock(
    block: { name?: string; args?: string; result?: string; isError?: boolean },
): AskUserDigest | undefined {
    if (block.isError) return undefined;
    const prompts = parseAskUserPrompts(block.args);
    if (prompts.length === 0) return undefined;

    const questions: AskUserQA[] = prompts.map(prompt => ({ ...prompt, selected: [] }));
    if (block.result === undefined) return { questions, state: "pending" };
    if (block.result.includes(ASK_USER_CANCEL_MARK)) return { questions, state: "cancelled" };

    const answered = parseAskUserAnswers(block.result, questions);
    return answered ? { questions: answered, state: "answered" } : undefined;
}

/** 从参数里取题干；选项不参与展示，参数异常或题目缺失时返回空数组。 */
function parseAskUserPrompts(rawArgs?: string): AskUserPrompt[] {
    if (!rawArgs) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArgs);
    } catch {
        return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return [];

    const prompts: AskUserPrompt[] = [];
    for (const item of parsed.questions) {
        if (!isRecord(item) || typeof item.question !== "string" || !item.question) continue;
        prompts.push({
            header: typeof item.header === "string" ? item.header : "",
            question: item.question,
            multiSelect: item.multiSelect === true,
        });
    }
    return prompts;
}

/** 逐题还原作答：一道都锚不上（结果不是我们认识的格式）时返回 undefined。 */
function parseAskUserAnswers(result: string, questions: AskUserQA[]): AskUserQA[] | undefined {
    const answerParts = new Map<number, string>();
    for (const line of result.split(/\r\n|\r|\n/)) {
        const match = /^(\d+)\.\s(.*)$/.exec(line.trim());
        if (!match) continue;

        const index = Number.parseInt(match[1]!, 10) - 1;
        if (index < 0 || index >= questions.length || answerParts.has(index)) continue;
        answerParts.set(index, match[2]!);
    }
    if (answerParts.size === 0) return undefined;

    return questions.map((question, index) => {
        const line = answerParts.get(index);
        const { selected, custom } = splitAnswerPart(line === undefined ? "" : extractAnswerPart(line, question));
        return { ...question, selected, ...(custom ? { custom } : {}) };
    });
}

/** 从 `题干[（多选）] → 选择` 里切出选择段：先按题干锚定，锚不上退到最后一个箭头之后。 */
function extractAnswerPart(line: string, question: AskUserPrompt): string {
    const head = `${question.question}${question.multiSelect ? "（多选）" : ""}`;
    if (line.startsWith(head)) return line.slice(head.length).replace(/^\s*→\s*/, "").trim();

    const arrow = line.lastIndexOf(ANSWER_SEPARATOR);
    return arrow >= 0 ? line.slice(arrow + ANSWER_SEPARATOR.length).trim() : "";
}

/** 选择段 → 选中项与自填内容：自填一定在末尾（见 formatAnswer 的拼接顺序）。 */
function splitAnswerPart(part: string): { selected: string[]; custom?: string } {
    if (!part || part === NO_ANSWER_TEXT) return { selected: [] };

    const pieces = part.split("、");
    const customIndex = pieces.findIndex(piece => piece.startsWith(CUSTOM_ANSWER_PREFIX));
    if (customIndex < 0) return { selected: pieces.filter(Boolean) };
    return {
        selected: pieces.slice(0, customIndex).filter(Boolean),
        custom: pieces.slice(customIndex).join("、").slice(CUSTOM_ANSWER_PREFIX.length),
    };
}

/** 去掉 ```diff 围栏，保留原始 diff 文本。 */
export function removeDiffFences(result: string): string {
    const lines = result.split(/\r\n|\r|\n/);
    if (!lines.some((line) => line.trim() === "```diff")) return result;

    return lines
        .filter((line) => line.trim() !== "```diff" && line.trim() !== "```")
        .join("\n");
}
