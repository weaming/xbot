import { describe, expect, test } from "bun:test";
import { sortSessions, type SessionOrderItem } from "./session-order.js";

describe("会话排序", () => {
    test("未归档会话在前，组内按更新时间倒序，新会话置顶", () => {
        const sessions: SessionOrderItem[] = [
            { sessionId: "archived-new", updatedAt: "2026-08-29T12:00:00.000Z", archived: true },
            { sessionId: "active-old", updatedAt: "2026-08-29T10:00:00.000Z" },
            { sessionId: "new-session" },
            { sessionId: "archived-old", updatedAt: "2026-08-29T09:00:00.000Z", archived: true },
            { sessionId: "active-new", updatedAt: "2026-08-29T11:00:00.000Z" },
        ];

        expect(sortSessions(sessions).map(session => session.sessionId)).toEqual([
            "new-session",
            "active-new",
            "active-old",
            "archived-new",
            "archived-old",
        ]);
    });
});
