/** 展示用格式化：只改显示，不改数据。 */

/**
 * 工具耗时：与 TUI 的 formatGoDuration 同口径（ms → 1.2s → 1m3s → 1h2m3s）。
 * 时间线上只显示用时和状态，所以这里不追求精确到毫秒以下的表达。
 */
export function formatDuration(durationMs: number): string {
    const ms = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
    if (ms < 1000) return `${ms}ms`;

    const totalSeconds = Math.floor(ms / 1000);
    const fractionMs = ms - totalSeconds * 1000;
    const seconds = fractionMs === 0
        ? String(totalSeconds % 60)
        : `${totalSeconds % 60}.${String(fractionMs).padStart(3, "0").replace(/0+$/, "")}`;

    if (totalSeconds < 60) return `${seconds}s`;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const days = Math.floor(totalSeconds / 86400);
    if (days > 0) return `${days}d${hours}h${minutes}m${seconds}s`;
    if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
    return `${minutes}m${seconds}s`;
}

/** home 前缀缩成 `~`，避免界面上拉一长串用户名路径。 */
export function abbreviateHome(path: string, home: string): string {
    if (!path || !home) return path;
    const trimmed = path.replace(/\/+$/, "");
    if (trimmed === home.replace(/\/+$/, "")) return "~";
    if (trimmed.startsWith(`${home.replace(/\/+$/, "")}/`)) {
        return `~${trimmed.slice(home.replace(/\/+$/, "").length)}`;
    }
    return path;
}
