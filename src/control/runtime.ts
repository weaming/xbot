/**
 * 进程级运行时装配：控制通道单例 + 会话目录。
 * 工具执行（session_send / session_status）通过它访问当前进程的会话事实。
 */

import type { SessionControl } from "./channel.js";

let activeControl: SessionControl | undefined;

/** 由运行时入口（TUI）装配；传 undefined 表示关闭会话间通信。 */
export function setSessionControl(control?: SessionControl): void {
    activeControl = control;
}

export function getSessionControl(): SessionControl | undefined {
    return activeControl;
}

/** 会话目录条目：只暴露工具与 UI 需要的字段。 */
interface SessionDirectoryEntry {
    sessionId: string;
    title?: string;
    archived?: boolean;
}

/** 会话目录：由宿主注入，避免控制层反向依赖 TUI 的会话管理。 */
export interface SessionDirectory {
    list(options?: { includeArchived?: boolean }): Promise<SessionDirectoryEntry[]>;
    /** 重新认领并取消归档一个已关闭会话。 */
    wake?(sessionId: string): Promise<void>;
}

let activeDirectory: SessionDirectory | undefined;

export function setSessionDirectory(directory?: SessionDirectory): void {
    activeDirectory = directory;
}

export function getSessionDirectory(): SessionDirectory | undefined {
    return activeDirectory;
}

/** 一条会话间结果记录：对方回合的产出回传（读自事件日志，供工具回查）。 */
export interface PeerResultRecord {
    /** 产出这条结果的对端会话。 */
    peerId: string;
    peerTitle?: string;
    ok: boolean;
    lost?: boolean;
    late?: boolean;
    text: string;
    stopReason?: string;
    createdAt: string;
}

/** 会话间结果历史：由宿主注入（读事件日志实现），避免工具层直接依赖 TUI 的会话存储。 */
export interface PeerResultHistory {
    /** 按时间正序返回该会话最近收到的结果（最多 limit 条）。 */
    recentResults(sessionId: string, limit: number): Promise<PeerResultRecord[]>;
}

let activePeerHistory: PeerResultHistory | undefined;

export function setPeerResultHistory(history?: PeerResultHistory): void {
    activePeerHistory = history;
}

export function getPeerResultHistory(): PeerResultHistory | undefined {
    return activePeerHistory;
}
