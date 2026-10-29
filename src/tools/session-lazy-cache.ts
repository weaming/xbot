/**
 * 会话级 lazy MCP 临时启用表：MCP 配置 lazy: true 的 server 在模型不支持
 * tool_search 时默认不下发，用户在 /mcp 里按会话临时启用后才进入工具定义。
 *
 * 事实源仍是会话事件（lazy_mcp_changed），这里只是按会话的内存缓存，
 * 由宿主在激活/重放会话时喂入，让工具下发与 token 预算两条同步路径都能读到。
 */

const enabledServers = new Map<string, string[]>();

/** 覆盖该会话的临时启用集（空数组 = 全部回到默认不下发）。 */
export function updateLazyServersCache(sessionId: string, servers: string[]): void {
    if (servers.length === 0) {
        enabledServers.delete(sessionId);
        return;
    }
    enabledServers.set(sessionId, [...new Set(servers)]);
}

/** 该会话临时启用的 lazy server；没有时返回空数组。 */
export function readLazyServersCache(sessionId?: string): string[] {
    if (!sessionId) return [];
    return enabledServers.get(sessionId) ?? [];
}

/** 会话释放/删除时摘掉缓存，避免按 sessionId 无限增长。 */
export function clearLazyServersCache(sessionId: string): void {
    enabledServers.delete(sessionId);
}
