import { describe, expect, test } from 'bun:test';
import {
    appendInterruptedTurn,
    appendCompletedTurn,
    flattenTurns,
    getSessionContextHistory,
    getSessionHistory,
    repairEmptyAssistantHistory,
    replaceWithCompactedContext,
} from '../../src/utils/conversation-history.js';
import type { ChatMessage, ConversationTurn, Session, StoredChatMessage } from '../../src/types/session.js';
import { projectChatMessagesForPrompt } from '../../src/utils/tool-result-context.js';

/** 测试专用：扁平消息按 user 消息分组为 turn（模拟旧布局的会话）。 */
function createSession(history: ChatMessage[] = []): Session {
    const turns: ConversationTurn[] = [];
    for (const [index, message] of history.entries()) {
        const stored = { ...message, id: `msg-${index}`, createdAt: '2026-01-01T00:00:00+08:00' } as StoredChatMessage;
        const last = turns.at(-1);
        if (!last || message.role === 'user') {
            turns.push({ id: `turn-${turns.length}`, status: 'completed', messages: [stored] });
        } else {
            last.messages.push(stored);
        }
    }
    return {
        sessionId: '01J00000000000000000000000',
        contextEpochId: '01J00000000000000000000001',
        turns,
        contextState: {
            startedAt: '2026-01-01T00:00:00+08:00',
            reason: 'session_start',
            sourceUserTurnCount: 0,
            retainedUserTurnCount: 0,
        },
        totalUserTurnCount: history.filter((message) => message.role === 'user').length,
        hardTrimCount: 0,
        compactCount: 0,
    };
}

function expectNextRequestToReusePrefix(completedTranscript: ChatMessage[], nextRequest: ChatMessage[]): void {
    expect(JSON.stringify(nextRequest.slice(0, completedTranscript.length))).toBe(JSON.stringify(completedTranscript));
}

describe('conversation history', () => {
    test('repairEmptyAssistantHistory moves a compacted boundary past removed messages', () => {
        const session = createSession([
            { role: 'user', content: '旧问题' },
            { role: 'assistant', content: null, reasoning_content: '思考' },
            { role: 'user', content: '新问题' },
            { role: 'assistant', content: '答案' },
        ]);
        session.compactedContext = '摘要';
        session.compactedKeepFromMessageId = 'msg-1';

        expect(repairEmptyAssistantHistory(session)).toBe(1);
        expect(session.compactedKeepFromMessageId).toBe('msg-2');
        expect(getSessionContextHistory(session).at(-2)?.content).toBe('新问题');
        expect(repairEmptyAssistantHistory(session)).toBe(0);
    });

    test('flattenTurns strips local metadata and preserves production tool-call fields', () => {
        const productionMessages: ChatMessage[] = [
            { role: 'user', content: '查询持仓和行情' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: '先并行查询持仓和报价。',
                tool_calls: [
                    { index: 0, id: 'call_00_positions', type: 'function', function: { name: 'LongPortPrivate__stock_positions', arguments: '{}' } },
                    { index: 1, id: 'call_01_quote', type: 'function', function: { name: 'LongPort__quote', arguments: '{"symbol":"TSM.US"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_00_positions', name: 'LongPortPrivate__stock_positions', content: '[{"symbol":"TSM.US"}]' },
            { role: 'tool', tool_call_id: 'call_01_quote', name: 'LongPort__quote', content: '{"last_done":"100"}' },
            { role: 'assistant', content: 'TSM 当前报价为 100。', reasoning_content: '根据工具结果回答。' },
        ];

        const turn: ConversationTurn = {
            id: 'turn-1',
            status: 'completed',
            messages: productionMessages.map((message, index) => ({
                ...message,
                id: `msg-${index}`,
                createdAt: '2026-01-01T00:00:00+08:00',
            })),
        };

        expect(flattenTurns([turn])).toEqual(productionMessages);
        expect(turn.messages.every((message) => Boolean(message.id) && Boolean(message.createdAt))).toBe(true);
    });

    test('uses compact summary as user input prefix while keeping full history and tail turns', () => {
        const session = createSession();
        for (let index = 1; index <= 10; index += 1) {
            appendCompletedTurn(session, [`u${index}`], [{ role: 'assistant', content: `a${index}` }], false);
        }
        replaceWithCompactedContext(session, 'summary', { compactedThroughTurnId: session.turns[4].id });
        appendCompletedTurn(session, ['u11'], [{ role: 'assistant', content: 'a11' }], false);

        expect(getSessionHistory(session)).toHaveLength(22);
        const context = getSessionContextHistory(session);
        expect(context[0].role).toBe('user');
        expect(context[0].content).toContain('<conversation_summary');
        expect(context[0].content).toContain('summary');
        expect(context[1]).toEqual({
            role: 'assistant',
            content: '已确认上述历史上下文与关键进展，后续对话将基于此事实基础继续。',
        });
        // 验证压缩截止点之后的保留回合 (u6 ~ u11)
        expect(context.slice(2)).toEqual([
            { role: 'user', content: 'u6' },
            { role: 'assistant', content: 'a6' },
            { role: 'user', content: 'u7' },
            { role: 'assistant', content: 'a7' },
            { role: 'user', content: 'u8' },
            { role: 'assistant', content: 'a8' },
            { role: 'user', content: 'u9' },
            { role: 'assistant', content: 'a9' },
            { role: 'user', content: 'u10' },
            { role: 'assistant', content: 'a10' },
            { role: 'user', content: 'u11' },
            { role: 'assistant', content: 'a11' },
        ]);
    });

    test('maintains prefix cache for appended turns without hard trimming turns', () => {
        const session = createSession();
        for (let index = 1; index <= 60; index += 1) {
            expect(appendCompletedTurn(session, [`u${index}`], [{ role: 'assistant', content: `a${index}` }], false)).toBe(false);
        }
        expect(session.turns).toHaveLength(60);
        expect(getSessionContextHistory(session)).toHaveLength(120);
    });

    test('keeps the compacted context prefix stable after its first new turn', () => {
        const session = createSession();
        appendCompletedTurn(session, ['u1'], [{ role: 'assistant', content: 'a1' }], false);
        replaceWithCompactedContext(session, 'summary');
        appendCompletedTurn(session, ['u2'], [{ role: 'assistant', content: 'a2' }], false);
        const completedTranscript = getSessionContextHistory(session);
        appendCompletedTurn(session, ['u3'], [{ role: 'assistant', content: 'a3' }], false);

        expectNextRequestToReusePrefix(completedTranscript, getSessionContextHistory(session));
    });

    test('migrates legacy history and keeps interrupted turns in full history and LLM context', () => {
        const legacyHistory: ChatMessage[] = [
            { role: 'user', content: 'before restart' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_pending' }] },
        ];
        const session = createSession(legacyHistory);
        session.turns[0].status = 'interrupted';

        expect(getSessionHistory(session)).toEqual(legacyHistory);
        expect(session.turns[0].messages.map((message) => message.id)).toHaveLength(2);
        // 送 LLM 前补齐悬挂的 tool_calls：合成结果紧跟在 assistant 之后
        expect(getSessionContextHistory(session)).toEqual([
            { role: 'user', content: 'before restart' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_pending' }] },
            {
                role: 'tool',
                tool_call_id: 'call_pending',
                name: undefined,
                content: '[工具调用被中断，未返回结果]',
            },
        ]);
    });

    test('skipToolCallIds 让续跑要重跑的调用不补合成结果', () => {
        const session = createSession();
        appendInterruptedTurn(session, ['u1'], [
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] } as ChatMessage,
        ], 'interrupted');

        expect(getSessionContextHistory(session, { skipToolCallIds: new Set(['c1']) })).toEqual([
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        ]);
    });

    test('drops orphan tool messages that have no matching tool_calls', () => {
        const session = createSession();
        appendCompletedTurn(session, ['u1'], [
            { role: 'tool', tool_call_id: 'ghost', content: '孤立结果' } as ChatMessage,
            { role: 'assistant', content: 'a1' } as ChatMessage,
        ], true);

        expect(getSessionContextHistory(session)).toEqual([
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
        ]);
    });

    test('keeps failed turns in daily history and LLM context', () => {
        const session = createSession();
        appendCompletedTurn(session, ['completed'], [{ role: 'assistant', content: 'done' }], false);
        session.turns.push({
            id: '01J00000000000000000000002',
            status: 'failed',
            messages: [{ id: 'fail-msg', createdAt: '2026-01-01T00:00:00+08:00', role: 'user', content: 'failed request' }],
        });

        expect(getSessionHistory(session).map((message) => message.content)).toEqual(['completed', 'done', 'failed request']);
        expect(getSessionContextHistory(session).map((message) => message.content)).toEqual(['completed', 'done', 'failed request']);
    });

    test('appendInterruptedTurn materializes user message with partial tool segments into LLM context', () => {
        const session = createSession();
        const partial: ChatMessage[] = [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'result' },
        ];

        appendInterruptedTurn(session, ['查一下'], partial, 'interrupted');

        expect(session.turns).toHaveLength(1);
        expect(session.turns[0].status).toBe('interrupted');
        expect(session.turns[0].messages.map(({ id, createdAt, ...message }) => message)).toEqual([
            { role: 'user', content: '查一下' },
            ...partial,
        ]);
        expect(session.totalUserTurnCount).toBe(1);
        expect(getSessionContextHistory(session).map((message) => message.content)).toEqual(['查一下', null, 'result']);
    });

    test('appendInterruptedTurn with failed status keeps user message in LLM context', () => {
        const session = createSession();

        appendInterruptedTurn(session, ['failed request'], [], 'failed');

        expect(getSessionHistory(session).map((message) => message.content)).toEqual(['failed request']);
        expect(getSessionContextHistory(session)).toEqual([{ role: 'user', content: 'failed request' }]);
    });

    test('persists a complete tool turn when remote tools are not injected', () => {
        const session = createSession();
        const responseMessages: ChatMessage[] = [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
            { role: 'tool', tool_call_id: 'call_1', name: 'todo', content: '[{}]' },
            { role: 'assistant', content: '完成' },
        ];

        appendCompletedTurn(session, ['查询'], responseMessages, true);

        expect(session.turns).toHaveLength(1);
        expect(session.turns[0].messages.map(({ id, createdAt, ...message }) => message)).toEqual([{ role: 'user', content: '查询' }, ...responseMessages]);
        expect(session.totalUserTurnCount).toBe(1);
    });

    test('persists only the final assistant reply when discovered tools are injected', () => {
        const session = createSession();
        const responseMessages: ChatMessage[] = [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'result' },
            { role: 'assistant', content: '完成' },
        ];

        appendCompletedTurn(session, ['查询'], responseMessages, false);

        expect(session.turns[0].messages.map(({ id, createdAt, ...message }) => message)).toEqual([{ role: 'user', content: '查询' }, { role: 'assistant', content: '完成' }]);
    });

    test('compaction keeps the session id and updates context epoch with tail preservation', () => {
        const history: ChatMessage[] = [];
        for (let index = 1; index <= 10; index += 1) {
            history.push({ role: 'user', content: `u${index}` });
            history.push({ role: 'assistant', content: `a${index}` });
        }
        const session = createSession(history);
        const sessionId = session.sessionId;
        const contextEpochId = session.contextEpochId;

        replaceWithCompactedContext(session, '保留决策', {
            instruction: '保留决策',
            compactedThroughTurnId: session.turns[4].id,
        });

        expect(session.sessionId).toBe(sessionId);
        expect(session.contextEpochId).not.toBe(contextEpochId);
        expect(session.contextState.reason).toBe('compact');
        expect(session.compactCount).toBe(1);
        expect(session.compactedThroughTurnId).toBe(session.turns[4].id);
    });

    test('compaction replaces history while retaining the logical session', () => {
        const session = createSession([
            { role: 'user', content: '原问题' },
            { role: 'assistant', content: '原回复' },
        ]);
        const sessionId = session.sessionId;
        const contextEpochId = session.contextEpochId;

        replaceWithCompactedContext(session, '保留的决策和待办', '保留待办');

        expect(session.sessionId).toBe(sessionId);
        expect(session.contextEpochId).not.toBe(contextEpochId);
        expect(session.turns).toHaveLength(1);
        expect(session.compactedContext).toBe('保留的决策和待办');
        expect(session.compactedThroughTurnId).toBe(session.turns[0].id);
        expect(session.contextState).toMatchObject({
            reason: 'compact',
            sourceUserTurnCount: 1,
            retainedUserTurnCount: 1,
            compactInstruction: '保留待办',
        });
        expect(session.compactCount).toBe(1);
    });

    test('replays large tool results with projection while keeping raw history', () => {
        const session = createSession();
        const hugeResult = 'x'.repeat(50_000);
        const responseMessages: ChatMessage[] = [
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call_big', type: 'function', function: { name: 'big_tool', arguments: '{}' } },
                    { id: 'call_full', type: 'function', function: { name: 'full_tool', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_big', name: 'big_tool', content: hugeResult, contextPolicy: { mode: 'adaptive' } },
            { role: 'tool', tool_call_id: 'call_full', name: 'full_tool', content: hugeResult, contextPolicy: { mode: 'full' } },
            { role: 'assistant', content: 'done' },
        ];

        appendCompletedTurn(session, ['查询'], responseMessages, true);

        // 原始历史保留完整原文与 contextPolicy 本地元数据
        const storedBig = session.turns[0].messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_big',
        );
        expect(storedBig?.content).toBe(hugeResult);
        expect(storedBig?.contextPolicy).toEqual({ mode: 'adaptive' });

        // getSessionHistory（完整历史消费方）不投影且剥离本地元数据
        const history = getSessionHistory(session);
        const historyBig = history.find((message) => message.role === 'tool' && message.tool_call_id === 'call_big');
        expect(historyBig?.content).toBe(hugeResult);
        expect(historyBig).not.toHaveProperty('contextPolicy');

        // 重放进模型上下文：adaptive 投影、full 保留
        const context = getSessionContextHistory(session);
        const contextBig = context.find((message) => message.role === 'tool' && message.tool_call_id === 'call_big');
        const contextFull = context.find((message) => message.role === 'tool' && message.tool_call_id === 'call_full');
        expect(contextBig?.content).toContain('[工具结果已截取');
        expect(contextBig?.content.length).toBeLessThan(hugeResult.length);
        expect(contextFull?.content).toBe(hugeResult);
        // contextPolicy 不能被历史提前消费：投影只在构造请求的那一处做
        // （提前剥掉策略会让同一条 full 消息『本轮全文、下一轮被截取』，上游前缀断裂）
        expect(contextBig).toHaveProperty('contextPolicy', { mode: 'adaptive' });
        expect(contextFull).toHaveProperty('contextPolicy', { mode: 'full' });
    });

    test('同一工具消息跨轮渲染完全一致（前缀缓存回归：full 策略不被提前消费）', () => {
        const session = createSession();
        const hugeResult = 'y'.repeat(50_000);
        const responseMessages: ChatMessage[] = [
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_full', type: 'function', function: { name: 'cat', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call_full', name: 'cat', content: hugeResult, contextPolicy: { mode: 'full' } },
            { role: 'assistant', content: 'done' },
        ];

        // 产出它的那一轮：编排器把新消息（带策略）直接投影成请求
        const currentTurnRequest = projectChatMessagesForPrompt(responseMessages);
        appendCompletedTurn(session, ['读文件'], responseMessages, true);
        // 下一轮：同一条消息来自历史，再做一次同样的投影
        const nextTurnRequest = projectChatMessagesForPrompt(getSessionContextHistory(session));
        const current = currentTurnRequest.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_full',
        );
        const next = nextTurnRequest.find((message) => message.role === 'tool' && message.tool_call_id === 'call_full');

        expect(current?.content).toBe(hugeResult);
        expect(next?.content).toBe(current?.content);
        expect(next).not.toHaveProperty('contextPolicy');
    });
});
