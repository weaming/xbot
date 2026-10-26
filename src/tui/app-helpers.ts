/**
 * ChatApp 的无状态辅助函数（不依赖 this，可独立测试与复用）。
 */

import { spawn } from "node:child_process";

import type { AssistantTimelineItem } from "./store.js";
import { isFileMutationTool } from "./tool-block-display.js";

/** 用系统默认程序打开外部链接（http/https/mailto），失败仅记录不阻塞 TUI。 */
export function openExternalUrl(rawUrl: string): void {
    const url = rawUrl.trim();
    if (!/^(https?:|mailto:)/i.test(url)) return;

    const args: [string, string[]] = process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]];
    const child = spawn(args[0], args[1], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
        console.warn("[TUI] open url failed:", err.message, url);
    });
    child.unref();
}

/** 从 timeline 的 startIndex 起，收集连续的、已成功完成的文件修改类工具块。 */
export function collectCollapsedFileBlocks(
    timeline: AssistantTimelineItem[],
    startIndex: number,
): Array<{ name?: string; args?: string; result?: string; isError?: boolean; durationMs?: number }> {
    const first = timeline[startIndex];
    if (
        first?.type !== "tool"
        || !isFileMutationTool(first.block.name)
        || first.block.result === undefined
        || first.block.isError
    ) return [];

    const blocks = [{
        name: first.block.name,
        args: first.block.args,
        result: first.block.result,
        isError: first.block.isError,
        ...(first.block.durationMs === undefined ? {} : { durationMs: first.block.durationMs }),
    }];
    for (let index = startIndex + 1; index < timeline.length; index++) {
        const item = timeline[index];
        if (
            item.type !== "tool"
            || !isFileMutationTool(item.block.name)
            || item.block.result === undefined
            || item.block.isError
        ) break;
        blocks.push({
            name: item.block.name,
            args: item.block.args,
            result: item.block.result,
            isError: item.block.isError,
            ...(item.block.durationMs === undefined ? {} : { durationMs: item.block.durationMs }),
        });
    }
    return blocks;
}
