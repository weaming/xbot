const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 获取上海时区的 ISO 8601 字符串
 * 格式: YYYY-MM-DDTHH:mm:ss+08:00
 */
export const getShanghaiISOString = (date: Date = new Date()): string => {
    // 将UTC时间转换为上海时间（加8小时）
    const localMs = date.getTime() + SHANGHAI_OFFSET_MS;
    const shanghaiDate = new Date(localMs);

    // 使用 UTC 方法获取各部分（因为已经加上了8小时偏移）
    const year = shanghaiDate.getUTCFullYear();
    const month = String(shanghaiDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shanghaiDate.getUTCDate()).padStart(2, '0');
    let hour = shanghaiDate.getUTCHours();
    const minute = String(shanghaiDate.getUTCMinutes()).padStart(2, '0');
    const second = String(shanghaiDate.getUTCSeconds()).padStart(2, '0');

    // 某些系统或 JavaScript 引擎在处理时区转换时可能返回 24 而不是 0
    // 这里强制修正为 00，确保符合标准的 ISO 8601 格式（小时必须是 00-23）
    if (hour === 24) {
        hour = 0;
    }

    const hourStr = String(hour).padStart(2, '0');

    return `${year}-${month}-${day}T${hourStr}:${minute}:${second}+08:00`;
};

/**
 * 格式化「人类可读的近似耗时」，服务于状态栏等需要稳定宽度的场景
 * （工具块的精确耗时用下面的 formatGoDuration）：
 * 格式化耗时（进位为时分秒，>=60s 时秒取整）：
 * - < 60s: 保留一位小数秒（如 "0.5s", "12.3s", "59.9s"）
 * - >= 60s 且 < 3600s: 进位分秒，秒取整（如 "1m 0s", "1m 23s"）
 * - >= 3600s: 进位时分秒，秒取整（如 "1h 0m 5s", "1h 23m 45s"）
 */
export const formatElapsedDuration = (durationMs: number): string => {
    const totalSeconds = Math.max(0, durationMs / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const totalSecInt = Math.floor(totalSeconds);
    const hours = Math.floor(totalSecInt / 3600);
    const minutes = Math.floor((totalSecInt % 3600) / 60);
    const seconds = totalSecInt % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${seconds}s`;
    }
    return `${minutes}m${seconds}s`;
};

/**
 * Go time.Duration 风格的单段耗时（最小单位毫秒，按需进位到天）：
 * - < 1s: "850ms"
 * - < 1m: "1.234s" / "1s"（小数部分去掉尾随 0）
 * - < 1h: "1m1.234s" / "1m1s"
 * - < 24h: "2h3m4s"
 * - 及以上: "1d2h3m4s"
 */
export const formatGoDuration = (durationMs: number): string => {
    const ms = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
    if (ms < 1000) return `${ms}ms`;

    const totalSeconds = Math.floor(ms / 1000);
    const fractionMs = ms - totalSeconds * 1000;
    const secondsText = fractionMs === 0
        ? String(totalSeconds % 60)
        : `${totalSeconds % 60}.${String(fractionMs).padStart(3, '0').replace(/0+$/, '')}`;

    if (totalSeconds < 60) return `${secondsText}s`;

    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const days = Math.floor(totalSeconds / 86400);
    if (days > 0) return `${days}d${hours}h${minutes}m${secondsText}s`;
    if (hours > 0) return `${hours}h${minutes}m${secondsText}s`;
    return `${minutes}m${secondsText}s`;
};
