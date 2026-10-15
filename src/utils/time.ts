const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface ShanghaiDateRange {
    start: Date;
    end: Date;
}

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
 * 获取上海时区的日期字符串
 * 格式: YYYY-MM-DD
 */
export const getTodayDateString = (date: Date = new Date()): string => {
    return getShanghaiISOString(date).split('T')[0];
};

export const getDateStringOffsetDays = (offsetDays: number, date: Date = new Date()): string => {
    const shifted = new Date(date.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    return getTodayDateString(shifted);
};

/** 解析 ISO 8601 时间戳；无效值返回 undefined。 */
export const parseIsoTimestamp = (value?: string): Date | undefined => {
    if (!value) return undefined;

    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
};

/** 返回上海时区某个自然日对应的半开时间区间。 */
export const getShanghaiDateRange = (date: string): ShanghaiDateRange => {
    const start = parseIsoTimestamp(`${date}T00:00:00+08:00`);
    if (!start || getTodayDateString(start) !== date) {
        throw new Error(`Invalid Shanghai date: ${date}`);
    }

    return {
        start,
        end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    };
};

/** 判断 ISO 时间戳是否落在给定的上海自然日区间内。 */
export const isTimestampInRange = (value: string | undefined, range: ShanghaiDateRange): boolean => {
    const timestamp = parseIsoTimestamp(value);
    return timestamp !== undefined && timestamp >= range.start && timestamp < range.end;
};

/**
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

/** 返回香港时区的时间字符串，格式 HH:mm:ss */
export const nowHKTime = (): string =>
    new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Hong_Kong',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

/** 返回香港时区的日期时间字符串，格式 YYYY/MM/DD HH:mm:ss */
export const nowHKDateTime = (): string =>
    new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
