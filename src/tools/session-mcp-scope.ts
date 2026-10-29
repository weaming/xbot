/**
 * 会话级 MCP 白名单：任务可以勾选「本次只允许哪些 MCP server 的工具」。
 *
 * 只放进程内映射：它描述的是「这次执行」的上下文，进程重启后由任务重新注入，
 * 不落盘也就不需要跟事件日志对齐。
 */

const scopes = new Map<string, string[]>();

/**
 * 设置白名单。
 * - `undefined`：不限制（全部 MCP 工具可见）
 * - `[]`：一个都不允许（deny-all，这是「不用任何 MCP」的表达方式）
 * - 非空数组：只允许列出的 server
 */
export function setSessionMcpScope(sessionId: string, servers?: string[]): void {
    if (servers === undefined) {
        scopes.delete(sessionId);
        return;
    }
    // 空数组也要存下来，删掉就变成「不限制」了，语义正好相反
    scopes.set(sessionId, [...servers]);
}

/** 取白名单；undefined 表示不限制。 */
export function getSessionMcpScope(sessionId?: string): string[] | undefined {
    if (!sessionId) return undefined;
    return scopes.get(sessionId);
}

export function clearSessionMcpScope(sessionId: string): void {
    scopes.delete(sessionId);
}
