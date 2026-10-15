/** 会话 id → 文件名安全形式（事件日志/锁/快照统一口径）。 */
export function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
}
