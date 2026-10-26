/**
 * cwd 工具：查看 / 切换当前会话的工作目录。
 *
 * - get（默认）：返回当前目录，HOME 前缀显示为 `~`
 * - set：接受 `~`、相对路径（相对当前目录）与绝对路径，目标必须是已存在的目录
 * - 切换落盘为 session_cwd_changed 事件：恢复会话后仍是新目录，其它工具也一起换基准
 *
 * 宿主（TUI）通过 setSessionCwdHandler 注入真正的落盘与刷新逻辑；
 * 没有会话上下文时（本地 CLI / 单测）退回进程级 TUI_CWD。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { err, ok } from "./tool-interface.js";
import { getToolCwd } from "../utils/runtime-paths.js";

/** 会话 cwd 落盘入口：由宿主注入，工具层不直接触碰事件日志。 */
export type SessionCwdSetter = (sessionId: string, cwd: string) => Promise<void>;

let sessionCwdSetter: SessionCwdSetter | null = null;

/** 注入/清除会话 cwd 落盘入口（TUI 启动时注入，测试可替换）。 */
export function setSessionCwdHandler(setter: SessionCwdSetter | null): void {
    sessionCwdSetter = setter;
}

/** 展示用路径：HOME 前缀替换为 `~`，其余原样。 */
export function formatDisplayPath(target: string, home: string | undefined = process.env.HOME): string {
    if (!home) return target;
    const trimmed = target.replace(/[\\/]+$/, "");
    if (trimmed === home) return "~";
    return trimmed.startsWith(`${home}/`) ? `~${trimmed.slice(home.length)}` : target;
}

/** 解析用户输入：`~` / `~/x` 展开 home，相对路径相对 base 解析。 */
export function resolveCwdInput(input: string, base: string, home: string | undefined = process.env.HOME): string {
    const trimmed = input.trim();
    const homeDir = home || os.homedir();
    if (trimmed === "~") return path.resolve(homeDir);
    if (trimmed.startsWith("~/")) return path.resolve(homeDir, trimmed.slice(2));
    return path.resolve(base, trimmed);
}

/** 解析并校验目标目录：工具与 /cwd 命令共用，避免两处判定与文案漂移。 */
export type ResolvedDir = { cwd: string } | { error: string };

export function resolveExistingDir(input: string, base: string, home?: string): ResolvedDir {
    const target = resolveCwdInput(input, base, home);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(target);
    } catch {
        return { error: `目录不存在：${formatDisplayPath(target, home)}（当前目录 ${formatDisplayPath(base, home)}）` };
    }
    if (!stat.isDirectory()) return { error: `不是目录：${formatDisplayPath(target, home)}` };
    return { cwd: target };
}

export const cwdTool: ExecutableTool = {
    name: "cwd",
    description: [
        "查看或切换当前会话的工作目录（bash、文件读写、grep 等相对路径都以此为基准）。",
        "action=get 查看（返回 HOME 缩写为 ~ 的路径）；action=set 配合 path 切换，支持 ~ 与相对当前目录的路径。",
        "切换会落盘到会话，恢复会话后仍是新目录。",
    ].join(" "),
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["get", "set"],
                description: "get：查看当前工作目录（默认）；set：切换工作目录，需要同时给 path",
            },
            path: {
                type: "string",
                description: "set 的目标目录：支持 ~、相对当前目录的路径与绝对路径",
            },
        },
    },
    execute: async (args: { action?: "get" | "set"; path?: string; __sessionId?: string }): Promise<ToolExecutionResult> => {
        const action = args.action ?? (args.path ? "set" : "get");
        const current = getToolCwd();

        if (action === "get") {
            return ok(formatDisplayPath(current));
        }

        const raw = args.path?.trim();
        if (!raw) return err("set 需要 path：例如 {\"action\":\"set\",\"path\":\"../infra\"}");

        const resolved = resolveExistingDir(raw, current);
        if ("error" in resolved) return err(resolved.error);
        const target = resolved.cwd;

        const sessionId = args.__sessionId;
        if (!sessionId) {
            // 没有会话上下文（本地 CLI / 单测）：只能改进程级目录，且不落盘
            process.env.TUI_CWD = target;
            return ok(`已切换工作目录：${formatDisplayPath(target)}（仅本进程生效，未落盘）`);
        }
        if (!sessionCwdSetter) {
            // 有会话却不落盘会成为"假切换"：恢复后回退，别让模型误以为生效
            return err("当前运行模式不支持切换会话目录（宿主未注入落盘入口）");
        }
        await sessionCwdSetter(sessionId, target);
        return ok(`已切换工作目录：${formatDisplayPath(target)}`);
    },
};
