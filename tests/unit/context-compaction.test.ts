import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 上下文压缩回归用例（对应真实事故：状态栏 69.1k/500k，请求却被 provider 判 1096619 tokens 超窗）：
 * 1. 请求级压缩只改本轮请求，不改 session.turns，因此 lastPromptTokens 变小不能当成「历史变小」，
 *    否则下一回合按未压缩历史重建请求直接 400；
 * 2. 历史已经超窗时压缩请求本身也会超窗，必须分段折叠摘要。
 */

type RunChatQueryImpl = (options: any) => Promise<any>;

let runChatQueryImpl: RunChatQueryImpl = async () => {
    throw new Error("runChatQuery 未在测试中设置");
};

const realChatRuntime = await import("../../src/services/chat-runtime.js");

mock.module("../../src/services/chat-runtime.js", () => {
    return {
        ...realChatRuntime,
        runChatQuery: (options: any) => runChatQueryImpl(options),
    };
});

const { autoCompactIfNeeded } = await import("../../src/services/auto-compact.js");
const { runTurnCore } = await import("../../src/services/run-turn.js");
const { createEmptySession } = await import("../../src/events/session-replay.js");
const { appendCompletedTurn, getSessionContextHistory, replaceWithCompactedContext } = await import(
    "../../src/utils/conversation-history.js"
);
const { shouldAutoCompact, getAutoCompactThreshold, splitTurnsIntoChunks, COMPACT_CHUNK_MIN_TOKENS } = await import(
    "../../src/utils/token-budget.js"
);
const { emptyUsage } = await import("../../src/events/ui-events.js");

const originalContextWindow = process.env.CONTEXT_WINDOW_TOKENS;

/** 造一段估算 token 超过 chunk 预算的长文本。 */
function longText(tokens: number): string {
    return "a".repeat(tokens * 3.5);
}

beforeEach(() => {
    // 收紧窗口，让 chunk 预算只由分段下限决定，用例不必造百万 token 的假历史
    process.env.CONTEXT_WINDOW_TOKENS = "40000";
});

afterEach(() => {
    if (originalContextWindow === undefined) delete process.env.CONTEXT_WINDOW_TOKENS;
    else process.env.CONTEXT_WINDOW_TOKENS = originalContextWindow;
});

afterAll(() => {
    mock.module("../../src/services/chat-runtime.js", () => realChatRuntime);
});

describe("shouldAutoCompact 与 lastPromptTokens 的关系", () => {
    test("本轮请求被请求级压缩后，lastPromptTokens 偏小也不能阻止压缩", async () => {
        const session = createEmptySession("sess-stale-prompt-tokens");
        appendCompletedTurn(
            session,
            ["超长问题"],
            [{ role: "assistant", content: longText(60_000) }],
            true,
        );

        const threshold = getAutoCompactThreshold("deepseek-chat");
        expect(threshold).toBeLessThan(estimate(session));

        // 事故现场：历史远超阈值，但上一个请求因为回合内压缩只上报了 69073
        expect(await shouldAutoCompact(session, { model: "deepseek-chat", lastPromptTokens: 69_073 })).toBe(true);
        // 没有 provider 数值时同样要靠本地估算兜底
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(true);
    });

    test("历史与 provider 数值都低于阈值时不压缩", async () => {
        const session = createEmptySession("sess-small-context");
        appendCompletedTurn(session, ["短问题"], [{ role: "assistant", content: "短回复" }], true);

        const threshold = getAutoCompactThreshold("deepseek-chat");
        expect(await shouldAutoCompact(session, { model: "deepseek-chat", lastPromptTokens: threshold - 1 })).toBe(false);
    });
});

describe("splitTurnsIntoChunks 分段摘要", () => {
    test("按预算切段且保留顺序，单个超大 turn 独占一段", async () => {
        const session = createEmptySession("sess-chunk-split");
        appendCompletedTurn(session, [`u1 ${longText(3_000)}`], [{ role: "assistant", content: "a1" }], true);
        appendCompletedTurn(session, [`u2 ${longText(30_000)}`], [{ role: "assistant", content: "a2" }], true);
        appendCompletedTurn(session, [`u3 ${longText(3_000)}`], [{ role: "assistant", content: "a3" }], true);

        const budget = COMPACT_CHUNK_MIN_TOKENS;
        const chunks = await splitTurnsIntoChunks(session.turns, budget);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.flat()).toEqual(session.turns);
        // 超大 turn 自己成段，不与邻居合并
        const huge = chunks.find(chunk => chunk.length === 1 && chunk[0].id === session.turns[1].id);
        expect(huge).toBeDefined();
    });

    test("空输入返回空段列表", async () => {
        expect(await splitTurnsIntoChunks([], 1000)).toEqual([]);
    });
});

describe("autoCompactIfNeeded 分段折叠摘要", () => {
    test("正常阈值触发的压缩只发一次请求（前缀缓存可命中）", async () => {
        // 收紧窗口使阈值/预算都变小数：阈值 9446、单次预算约 10036
        process.env.CONTEXT_WINDOW_TOKENS = "20000";
        const session = createEmptySession("sess-single-request-compact");
        appendCompletedTurn(session, ["开头问题"], [{ role: "assistant", content: longText(4_800) }], true);
        appendCompletedTurn(session, ["尾部问题"], [{ role: "assistant", content: "短回复" }], true);

        // 确实越过阈值，但历史总长仍在单次请求的预算内
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(true);

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: "SUMMARY", toolCalls: 0, messages: [] };
        };

        const result = await autoCompactIfNeeded(session, { model: "deepseek-chat" });

        expect(result.wasCompacted).toBe(true);
        expect(histories).toHaveLength(1);
        // 单次请求：历史原样作为前缀发出（无摘要注入），待压缩范围内的回合全部进摘要
        expect(JSON.stringify(histories[0])).toContain("开头问题");
        expect(JSON.stringify(histories[0])).toContain("尾部问题");
        expect(JSON.stringify(histories[0])).not.toContain("conversation_summary");

        // 压缩后上下文 = 摘要 + 保留段：保留预算内留下最后一条消息，其余全部折叠
        const contextAfter = getSessionContextHistory(session);
        expect(contextAfter).toHaveLength(3);
        expect(JSON.stringify(contextAfter)).toContain("SUMMARY");
        expect(JSON.stringify(contextAfter)).toContain("短回复");
        expect(JSON.stringify(contextAfter)).not.toContain("开头问题");
        expect(JSON.stringify(contextAfter)).not.toContain("尾部问题");
        // 保留段起点是消息级边界，落在最后一条消息上
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[1]!.id);
    });

    test("优先按完整 turn 保留：预算够时切点落在 turn 边界", async () => {
        process.env.CONTEXT_WINDOW_TOKENS = "20000";
        const session = createEmptySession("sess-keep-turns");
        for (let index = 1; index <= 4; index++) {
            appendCompletedTurn(session, [`问题 ${index}`], [{ role: "assistant", content: longText(5_000) }], true);
        }

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: "SUMMARY", toolCalls: 0, messages: [] };
        };

        const result = await autoCompactIfNeeded(session, { model: "deepseek-chat" });
        expect(result.wasCompacted).toBe(true);

        // 尾部 3 个 turn 合计已过 12k 保留预算，切点落在 turn 边界：保留段从 turn2 的第一条消息开始
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);
        expect(session.compactedThroughTurnId).toBe(session.turns[0]!.id);
        expect(JSON.stringify(histories.at(-1))).toContain("问题 1");
        expect(JSON.stringify(histories.at(-1))).not.toContain("问题 2");

        // 上下文 = 摘要 + 确认 + 保留的 3 个完整 turn（6 条消息）
        const context = getSessionContextHistory(session);
        expect(context).toHaveLength(8);
        expect(JSON.stringify(context)).toContain("SUMMARY");
        expect(JSON.stringify(context)).not.toContain("问题 1");
        expect(JSON.stringify(context)).toContain("问题 2");
        expect(JSON.stringify(context)).toContain("问题 4");

        // 压缩之后新产生的回合仍会进上下文
        appendCompletedTurn(session, ["新问题"], [{ role: "assistant", content: "新回复" }], true);
        const after = getSessionContextHistory(session);
        expect(after).toHaveLength(10);
        expect(JSON.stringify(after)).toContain("新问题");
    });

    test("连续压缩：上次保留段会被下次压缩一起吸收", async () => {
        process.env.CONTEXT_WINDOW_TOKENS = "20000";
        const session = createEmptySession("sess-absorb-tail");
        for (let index = 1; index <= 4; index++) {
            appendCompletedTurn(session, [`问题 ${index}`], [{ role: "assistant", content: longText(5_000) }], true);
        }

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: `SUMMARY_${histories.length}`, toolCalls: 0, messages: [] };
        };

        await autoCompactIfNeeded(session, { model: "deepseek-chat" });
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);

        appendCompletedTurn(session, ["问题 5"], [{ role: "assistant", content: longText(5_000) }], true);
        appendCompletedTurn(session, ["问题 6"], [{ role: "assistant", content: longText(5_000) }], true);
        await autoCompactIfNeeded(session, { model: "deepseek-chat" });

        // 第二次压缩从上次保留段起点开始：上次留下的 turn2 也进了摘要，随后被新的保留段取代
        const secondRound = histories.slice(1).map(history => JSON.stringify(history)).join("");
        expect(secondRound).toContain("conversation_summary");
        expect(secondRound).toContain("SUMMARY_1");
        expect(secondRound).toContain("问题 2");
        expect(secondRound).not.toContain("问题 6");
        expect(session.compactedKeepFromMessageId).toBe(session.turns[3]!.messages[0]!.id);
    });

    test("历史超窗时按段折叠，摘要前缀逐段传递", async () => {
        const session = createEmptySession("sess-chunked-compact");
        for (let index = 1; index <= 3; index++) {
            appendCompletedTurn(
                session,
                [`问题 ${index}`],
                [{ role: "assistant", content: longText(20_000) }],
                true,
            );
        }

        const histories: any[][] = [];
        let round = 0;
        runChatQueryImpl = async options => {
            round += 1;
            histories.push(options.history);
            options.onEvent?.({
                type: "usage",
                usage: { ...emptyUsage(), model: "test", promptTokens: 100, totalTokens: 100, requestCount: 1 },
            });
            return { content: `SUMMARY_${round}`, toolCalls: 0, messages: [] };
        };

        const result = await autoCompactIfNeeded(session, { model: "deepseek-chat" });

        expect(result.wasCompacted).toBe(true);
        expect(histories.length).toBeGreaterThan(1);
        // 首段没有旧摘要；后续每段都把上一段摘要作为前缀带上（折叠）
        expect(JSON.stringify(histories[0])).not.toContain("conversation_summary");
        expect(JSON.stringify(histories[1])).toContain("SUMMARY_1");
        expect(JSON.stringify(histories[1])).toContain("conversation_summary");
        // 终态写入最后一段摘要；尾部大 turn 自身超过保留预算，在它内部细切
        expect(session.compactedContext).toBe(`SUMMARY_${round}`);
        expect(session.compactedKeepFromMessageId).toBe(session.turns[2]!.messages[1]!.id);
        expect(session.compactedThroughTurnId).toBe(session.turns[1]!.id);
        const contextAfter = getSessionContextHistory(session);
        expect(JSON.stringify(contextAfter)).toContain(`SUMMARY_${round}`);
        expect(contextAfter).toHaveLength(3);
        expect(session.compactCount).toBe(1);
        // 每段 usage 都计入本次压缩
        expect(result.usage?.requestCount).toBe(round);
        expect(result.postTokens).toBeLessThan(result.preTokens ?? 0);
    });

});

describe("context_compacted 事件重放", () => {
    test("重放恢复保留段边界（消息级）", async () => {
        const { EventLog } = await import("../../src/events/event-log.js");
        const { SessionReplay } = await import("../../src/events/session-replay.js");
        const sessionId = "sess-replay-keep-from";
        const log = new EventLog();
        await log.append(sessionId, "session_created", { cwd: "/tmp" });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "SUMMARY",
            keepFromMessageId: "msg-keep-from",
        });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(session.compactedContext).toBe("SUMMARY");
        // 边界跟着事件走：重启后上下文窗口与压缩时一致，不会把保留段丢掉
        expect(session.compactedKeepFromMessageId).toBe("msg-keep-from");
    });
});

describe("runTurnCore 请求历史在压缩之后构造", () => {
    test("预压缩改写的历史会用在同一回合的请求里", async () => {
        const session = createEmptySession("sess-turn-history");
        appendCompletedTurn(session, ["旧问题"], [{ role: "assistant", content: longText(20_000) }], true);
        const staleHistoryLength = session.turns[0].messages.length;

        let sentHistory: any[] = [];
        runChatQueryImpl = async options => {
            sentHistory = options.history;
            return { content: "ok", toolCalls: 1, messages: [{ role: "assistant", content: "ok" }] };
        };

        const outcome = await runTurnCore({
            session,
            turnId: "turn-1",
            userMessages: ["新问题"],
            query: "新问题",
            systemPrompt: "system",
            buildHistory: () => {
                // 压缩写回后重建历史：只剩摘要前缀 + 本轮用户消息
                const history: any[] = session.compactedContext
                    ? [{ role: "user", content: `<conversation_summary>\n${session.compactedContext}` }]
                    : [];
                return [...history, { role: "user", content: "新问题" }];
            },
            signal: new AbortController().signal,
        }, {
            persistUserMessages: async () => {},
            persistPendingMessage: async () => {},
            persistTurnMessage: async () => 0,
            persistSegmentStart: async () => 0,
            persistTurn: async () => {},
            // 压缩发生在 buildHistory 之前
            autoCompact: async () => {
                replaceWithCompactedContext(session, "SUMMARY", { compactedThroughTurnId: session.turns[0].id });
                return undefined;
            },
        });

        expect(outcome.aborted).toBe(false);
        expect(sentHistory.some(message => String(message.content).includes("SUMMARY"))).toBe(true);
        expect(sentHistory.length).toBeLessThan(staleHistoryLength + 2);
    });
});

function estimate(session: { turns: any[] }): number {
    return session.turns.reduce((total, turn) => {
        return total + turn.messages.reduce((sum: number, message: any) => sum + messageTokens(message), 0);
    }, 0);
}

function messageTokens(message: any): number {
    return Math.ceil(String(message.content ?? "").length / 3.5) + 4;
}
