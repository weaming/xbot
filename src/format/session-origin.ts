/**
 * 会话来源的展示口径：会话条、会话面板与命令行共用，避免同一会话在不同地方标记不一致。
 *
 * 只有 `job`（任务跑出来的会话）会被标记：交互终端开的会话是常态，逐行标出来只是噪声。
 */

import type { SessionOrigin } from "../types/session.js";

/** 任务会话的标题前缀（单列宽符号 U+2691，宽度 1；会话条 tab 只有 20 列，塞不下「任务」两字）。 */
const JOB_ORIGIN_PREFIX = "⚑ ";

/** 标题前缀：非任务会话返回空串。 */
export function originPrefix(origin?: SessionOrigin): string {
    return origin === "job" ? JOB_ORIGIN_PREFIX : "";
}

/** 人类可读来源名（命令行 `show` 与 `list` 的来源列）。 */
export function describeOrigin(origin?: SessionOrigin): string {
    switch (origin) {
        case "web":
            return "网页";
        case "job":
            return "任务";
        case "tool":
            return "工具";
        default:
            // 老会话没有来源字段，语义上等同于交互终端建的
            return "终端";
    }
}
