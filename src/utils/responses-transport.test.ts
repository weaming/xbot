import { describe, expect, test } from "bun:test";
import { isResponsesStoreEnabled, isResponsesWebSocketEnabled, protocolStatusLabel } from "./responses-transport.js";

describe("Responses WebSocket 开关", () => {
    test("GPT 默认启用 WS，Responses 默认不存储，显式配置优先", () => {
        const previousWebSocket = process.env.OPENAI_RESPONSES_WEBSOCKET;
        const previousStore = process.env.OPENAI_RESPONSES_STORE;
        try {
            delete process.env.OPENAI_RESPONSES_WEBSOCKET;
            delete process.env.OPENAI_RESPONSES_STORE;
            expect(isResponsesWebSocketEnabled(undefined, "gpt-5")).toBe(true);
            expect(isResponsesStoreEnabled()).toBe(false);
            expect(isResponsesWebSocketEnabled(undefined, "openai/gpt-5")).toBe(true);
            expect(isResponsesStoreEnabled(" TrUe ")).toBe(true);
            expect(isResponsesWebSocketEnabled("false", "gpt-5")).toBe(false);
            expect(isResponsesStoreEnabled("0")).toBe(false);
            expect(isResponsesWebSocketEnabled(undefined, "deepseek-v4")).toBe(false);
            expect(isResponsesStoreEnabled("1")).toBe(true);
        } finally {
            if (previousWebSocket === undefined) delete process.env.OPENAI_RESPONSES_WEBSOCKET;
            else process.env.OPENAI_RESPONSES_WEBSOCKET = previousWebSocket;
            if (previousStore === undefined) delete process.env.OPENAI_RESPONSES_STORE;
            else process.env.OPENAI_RESPONSES_STORE = previousStore;
        }
    });
    test("接受 1 和不区分大小写的 true", () => {
        for (const value of ["1", "true", " TrUe "]) {
            expect(isResponsesWebSocketEnabled(value)).toBe(true);
        }
        for (const value of ["", "0", "false", "yes"]) {
            expect(isResponsesWebSocketEnabled(value)).toBe(false);
        }
    });

    test("状态栏按协议和开关显示传输方式", () => {
        const previous = process.env.OPENAI_RESPONSES_WEBSOCKET;
        try {
            process.env.OPENAI_RESPONSES_WEBSOCKET = "1";
            expect(protocolStatusLabel("responses")).toBe("Responses in WS");
            expect(protocolStatusLabel("chat_completions")).toBe("Chat");
            process.env.OPENAI_RESPONSES_WEBSOCKET = "false";
            expect(protocolStatusLabel("responses")).toBe("Responses");
        } finally {
            if (previous === undefined) delete process.env.OPENAI_RESPONSES_WEBSOCKET;
            else process.env.OPENAI_RESPONSES_WEBSOCKET = previous;
        }
    });
});
