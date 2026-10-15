/**
 * 为模型提供后台 shell 任务的查询、等待和终止能力。
 */

import { backgroundTaskManager } from "./background-tasks.js";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";

const MAX_WAIT_SECONDS = 600;

function result(value: unknown): ToolExecutionResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolExecutionResult {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
    };
}

export const backgroundTaskTool: ExecutableTool = {
    name: "background_task",
    description: "管理由 bash 放入后台的长时命令：列出任务、查看状态、等待完成或终止任务。",
    tags: ["core", "code"],
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["list", "status", "wait", "stop"],
                description: "操作：list 列出任务；status 查看任务；wait 等待完成；stop 终止任务",
            },
            task_id: {
                type: "string",
                description: "后台任务 ID，例如 task_1；list 时不需要",
            },
            wait_seconds: {
                type: "integer",
                minimum: 1,
                maximum: MAX_WAIT_SECONDS,
                description: `wait 最多等待多少秒，默认 10 秒，上限 ${MAX_WAIT_SECONDS} 秒`,
            },
        },
        required: ["action"],
    },
    execute: async (
        args: { action?: string; task_id?: string; wait_seconds?: number; __sessionId?: string },
        signal?: AbortSignal,
    ): Promise<ToolExecutionResult> => {
        const action = args.action?.trim().toLowerCase();
        const sessionId = args.__sessionId;

        if (action === "list") {
            return result({ tasks: backgroundTaskManager.list(sessionId) });
        }
        if (!args.task_id?.trim()) return failure("task_id 必填");

        const taskId = args.task_id.trim();
        if (action === "status") {
            const task = backgroundTaskManager.get(taskId, sessionId);
            return task ? result(task) : failure(`后台任务不存在或不属于当前会话：${taskId}`);
        }
        if (action === "wait") {
            const waitSeconds = typeof args.wait_seconds === "number" && Number.isFinite(args.wait_seconds)
                ? Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.round(args.wait_seconds)))
                : 10;
            const task = await backgroundTaskManager.wait(taskId, waitSeconds * 1_000, sessionId, signal);
            return task ? result(task) : failure(`后台任务不存在或不属于当前会话：${taskId}`);
        }
        if (action === "stop") {
            const stopped = backgroundTaskManager.stop(taskId, sessionId);
            if (!stopped) {
                const task = backgroundTaskManager.get(taskId, sessionId);
                return task ? result(task) : failure(`后台任务不存在、已结束或不属于当前会话：${taskId}`);
            }
            return result(backgroundTaskManager.get(taskId, sessionId));
        }

        return failure(`不支持的后台任务操作：${args.action || "（空）"}，可用 list/status/wait/stop`);
    },
};

