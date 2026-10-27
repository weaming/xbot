/** 会话 id → 文件名安全形式（事件日志/锁/快照统一口径）。 */
export function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** 短 id：列表、日志与工具文案里惯用末 8 位。 */
export function shortSessionId(sessionId: string): string {
    return sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
}

/** 会话 id 是否是完整 ULID（Crockford Base32，26 位，去掉 I L O U）。 */
export function isUlid(sessionId: string): boolean {
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId);
}
