import { describe, expect, test } from "bun:test";
import { planResume } from "../../src/services/resume-plan.js";
import type { ChatMessage, Session } from "../../src/types/session.js";

function sessionWith(messages: ChatMessage[], status: "completed" | "interrupted" | "failed" = "interrupted"): Pick<Session, "turns"> {
    return { turns: [{ id: "t1", status, messages: messages as any }] };
}

function assistantCall(id: string, args = '{"cmd":"ls"}'): ChatMessage {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "bash", arguments: args } }],
    } as ChatMessage;
}

function toolResult(id: string, content = "out"): ChatMessage {
    return { role: "tool", tool_call_id: id, name: "bash", content } as ChatMessage;
}

describe("planResume", () => {
    test("尾部只有 call：重跑缺失工具并反解析参数", () => {
        const plan = planResume(sessionWith([{ role: "user", content: "查" }, assistantCall("c1")]));
        expect(plan.canResume).toBe(true);
        expect(plan.toolCalls).toEqual([
            { id: "c1", name: "bash", args: { cmd: "ls" }, rawArgs: '{"cmd":"ls"}' },
        ]);
    });

    test("尾部是完整工具结果：不重跑，直接发请求", () => {
        const plan = planResume(sessionWith([
            { role: "user", content: "查" },
            assistantCall("c1"),
            toolResult("c1"),
        ]));
        expect(plan.canResume).toBe(true);
        expect(plan.toolCalls).toEqual([]);
    });

    test("部分结果缺失：只重跑缺失的调用", () => {
        const plan = planResume(sessionWith([
            { role: "user", content: "查" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
                    { id: "c2", type: "function", function: { name: "cat", arguments: '{"path":"a"}' } },
                ],
            } as ChatMessage,
            toolResult("c1"),
        ]));
        expect(plan.canResume).toBe(true);
        expect(plan.toolCalls).toEqual([
            { id: "c2", name: "cat", args: { path: "a" }, rawArgs: '{"path":"a"}' },
        ]);
    });

    test("参数损坏的调用跳过（交给历史修复兜底）", () => {
        const plan = planResume(sessionWith([assistantCall("c1", "{坏 JSON")]));
        expect(plan.canResume).toBe(true);
        expect(plan.toolCalls).toEqual([]);
    });

    test("已完成回合尾部是普通 assistant 文本：没有可续跑点", () => {
        const plan = planResume(sessionWith([
            { role: "user", content: "问" },
            { role: "assistant", content: "答" },
        ], "completed"));
        expect(plan.canResume).toBe(false);
        expect(plan.reason).toBeTruthy();
    });

    test("空会话：没有可续跑点", () => {
        const plan = planResume({ turns: [] });
        expect(plan.canResume).toBe(false);
        expect(plan.reason).toBeTruthy();
    });

    test("上一轮 failed 且工具未完成：可以续跑", () => {
        const plan = planResume(sessionWith([assistantCall("c1")], "failed"));
        expect(plan.canResume).toBe(true);
        expect(plan.toolCalls).toHaveLength(1);
    });

    test("上一轮 failed 且只有用户消息：可以重试请求", () => {
        const plan = planResume(sessionWith([{ role: "user", content: "再查一次" }], "failed"));
        expect(plan).toEqual({ toolCalls: [], canResume: true });
    });

    test("压缩中取消且仅有用户消息时可以续跑", () => {
        const plan = planResume(sessionWith([{ role: "user", content: "继续任务" }]));
        expect(plan).toEqual({ toolCalls: [], canResume: true });
    });
});
