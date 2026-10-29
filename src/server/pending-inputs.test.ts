import { describe, expect, test } from "bun:test";
import {
    clearInputs,
    enqueueInput,
    joinInputs,
    pendingStats,
    takeInputs,
} from "./pending-inputs.js";

describe("待发输入队列", () => {
    test("按模式分开放，取走即清空且不重复消费", () => {
        const sessionId = "sess-request-vs-turn";
        enqueueInput(sessionId, "看下日志", "request");
        enqueueInput(sessionId, "顺便跑测试", "request");
        enqueueInput(sessionId, "下轮再说", "turn");

        expect(pendingStats(sessionId)).toEqual({ request: 2, turn: 1 });
        expect(takeInputs(sessionId, "request")).toEqual(["看下日志", "顺便跑测试"]);
        expect(takeInputs(sessionId, "request")).toBeUndefined();
        expect(pendingStats(sessionId)).toEqual({ request: 0, turn: 1 });

        clearInputs(sessionId);
        expect(pendingStats(sessionId)).toEqual({ request: 0, turn: 0 });
    });

    test("空白输入不入队", () => {
        const sessionId = "sess-blank-input";
        enqueueInput(sessionId, "   \n ", "request");

        expect(pendingStats(sessionId)).toEqual({ request: 0, turn: 0 });
    });

    test("多条排队输入合成一段，不拆成多个回合", () => {
        expect(joinInputs(["第一句", "第二句"])).toBe("第一句\n\n第二句");
    });
});
