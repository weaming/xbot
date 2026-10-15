/** 从磁盘数据补全 Session 缺失字段。 */

import { createUlid } from "./ulid.js";
import { getSessionHistory } from "./conversation-history.js";
import { getToolCwd } from "./runtime-paths.js";
import { getShanghaiISOString } from "./time.js";
import type { Session } from "../types/session.js";

export function normalizeSession(session: Partial<Session> | undefined): Session {
    const normalized = {
        ...(session || {}),
        turns: session?.turns ?? [],
    } as Session;

    const timestamp = getShanghaiISOString();
    if (!normalized.sessionId) normalized.sessionId = createUlid();
    if (!normalized.createdAt) normalized.createdAt = timestamp;
    if (!normalized.updatedAt) normalized.updatedAt = normalized.createdAt;
    if (!normalized.contextEpochId) normalized.contextEpochId = createUlid();
    // cwd 必填不变量：旧存档无记录时以当前 workspace 为默认。
    if (!normalized.cwd) normalized.cwd = getToolCwd();
    if (!normalized.contextState) {
        normalized.contextState = {
            startedAt: normalized.updatedAt,
            reason: 'session_start',
            sourceUserTurnCount: 0,
            retainedUserTurnCount: 0,
        };
    }
    normalized.totalUserTurnCount ??= getSessionHistory(normalized).filter((message) => message.role === 'user').length;
    normalized.hardTrimCount ??= 0;
    normalized.compactCount ??= 0;
    return normalized;
}
