/**
 * 任务状态的中文标签与配色：看板卡片和详情头部共用，避免同一状态在两处显示不一致。
 *
 * 「排队中」只在真的等调度器领取时才有意义：新建的卡片尚未授权执行（autoStart 未开），
 * 显示「未开始」——否则一眼看去像在排队，实际什么都不会发生。
 */

import type { Job, JobState } from "./types";

export type StateTone = "default" | "accent" | "ok" | "warn" | "bad";

export const STATE_TONE: Record<JobState, StateTone> = {
    queued: "default",
    leased: "accent",
    running: "accent",
    succeeded: "ok",
    failed: "bad",
    lost: "bad",
    cancelled: "warn",
    interfered: "warn",
};

const STATE_LABEL: Record<JobState, string> = {
    queued: "排队中",
    leased: "运行中",
    running: "运行中",
    succeeded: "完成",
    failed: "异常",
    lost: "异常",
    interfered: "异常",
    cancelled: "已取消",
};

/** 状态文案：排队中的任务要区分"已授权等调度"与"还没授权执行"。 */
export function stateLabel(job: Pick<Job, "state" | "input">): string {
    if (job.state === "queued" && job.input.autoStart !== true) return "未开始";
    return STATE_LABEL[job.state];
}
