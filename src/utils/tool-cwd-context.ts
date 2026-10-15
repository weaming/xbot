/**
 * 工具执行的工作目录上下文：工具调用链上按会话绑定 cwd，
 * 避免多会话并发执行工具时互相覆盖进程级 TUI_CWD。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const toolCwdStorage = new AsyncLocalStorage<{ cwd: string }>();

/** 在指定 cwd 上下文中执行回调（promise 异步链内同样生效）。 */
export function runWithToolCwd<T>(cwd: string, fn: () => T): T {
    return toolCwdStorage.run({ cwd }, fn);
}

/** 读取当前异步链绑定的工具 cwd；无绑定时返回 undefined（调用方回退进程级目录）。 */
export function getAsyncToolCwd(): string | undefined {
    return toolCwdStorage.getStore()?.cwd;
}
