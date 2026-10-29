/**
 * 会话级 MCP 选中集：决定这次会话下发哪些 MCP 服务器的工具。
 *
 * 规则很窄，只有一条：**选中就下发，没选中就不下发**。配置里的 `lazy` 只决定
 * 「新建会话时默认选不选它」，执行期不再参与判断，也不看接入端是否支持 tool_search。
 *
 * 事实源仍是会话事件（lazy_mcp_changed），这里只是按会话的内存缓存，
 * 由宿主在激活/重放会话时喂入，让工具下发与 token 预算两条同步路径都能读到。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const selectionBySession = new Map<string, string[]>();

/**
 * 回合内的选中集快照。中途增删只落事件、改缓存，不影响正在跑的回合 ——
 * 工具定义在一回合的多个请求之间必须稳定，否则同一回合里工具集突然变化，
 * 前缀缓存失效、模型也可能看到一半工具。
 */
const turnSnapshot = new AsyncLocalStorage<{ selection: string[] | undefined }>();

/** 覆盖该会话的选中集（空数组 = 一个都不选中，仍算已初始化）。 */
export function updateMcpSelection(sessionId: string, servers: string[]): void {
    selectionBySession.set(sessionId, [...new Set(servers)]);
}

/** 该会话的选中集；没初始化过返回 undefined（调用方据此决定"不限制"还是"空集"）。 */
export function readMcpSelection(sessionId?: string): string[] | undefined {
    if (!sessionId) return undefined;
    return selectionBySession.get(sessionId);
}

/** 会话释放/删除时摘掉缓存，避免按 sessionId 无限增长。 */
export function clearMcpSelection(sessionId: string): void {
    selectionBySession.delete(sessionId);
}

/** 回合开始时快照：本回合的所有请求共用这份，增删从下一回合起生效。 */
export function runWithMcpSelectionSnapshot<T>(selection: string[] | undefined, run: () => T): T {
    return turnSnapshot.run({ selection }, run);
}

/** 当前回合的快照；不在回合里返回 undefined（≠ 空集）。 */
export function readTurnMcpSelectionSnapshot(): string[] | undefined {
    return turnSnapshot.getStore()?.selection;
}
