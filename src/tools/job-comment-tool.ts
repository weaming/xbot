/**
 * `job_comment`：agent 向当前任务卡写评论。
 *
 * 只在任务执行期间出现在工具列表里（由 chat-runtime 按上下文动态加入），
 * 只作用于当前任务，不接受 jobId —— 避免模型写错卡片。
 */

import { writeJobComment } from "./job-context.js";
import { err, ok, type ExecutableTool } from "./tool-interface.js";

export const jobCommentTool: ExecutableTool = {
    name: "job_comment",
    // 会话工具：只在显式启用（任务执行上下文存在）时下发
    sessionScoped: true,
    description:
        "向当前任务卡添加一条评论，用于汇报进展、给出结论或向人提问。" +
        "只作用于当前任务，不需要也不接受任务 id。任务卡上人和 agent 的评论是同一条时间线。",
    inputSchema: {
        type: "object",
        properties: {
            body: { type: "string", description: "评论正文，支持 markdown" },
        },
        required: ["body"],
    },
    execute: async (args: { body?: string }) => {
        const body = String(args?.body ?? "").trim();
        if (!body) return err("body 必填");

        try {
            writeJobComment(body);
            return ok("评论已添加到任务卡");
        } catch (error) {
            return err((error as Error)?.message ?? String(error));
        }
    },
};
