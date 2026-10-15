export interface SessionOrderItem {
    sessionId: string;
    updatedAt?: string;
    archived?: boolean;
}

/** 按会话状态和最近更新时间排序，未落盘的新会话优先。 */
export function sortSessions<T extends SessionOrderItem>(sessions: T[]): T[] {
    return [...sessions].sort(compareSessions);
}

function compareSessions(left: SessionOrderItem, right: SessionOrderItem): number {
    const archivedOrder = Number(Boolean(left.archived)) - Number(Boolean(right.archived));
    if (archivedOrder !== 0) return archivedOrder;

    const leftUpdatedAt = left.updatedAt ?? "";
    const rightUpdatedAt = right.updatedAt ?? "";
    if (!leftUpdatedAt && rightUpdatedAt) return -1;
    if (leftUpdatedAt && !rightUpdatedAt) return 1;

    const updatedOrder = rightUpdatedAt.localeCompare(leftUpdatedAt);
    if (updatedOrder !== 0) return updatedOrder;

    return right.sessionId.localeCompare(left.sessionId);
}
