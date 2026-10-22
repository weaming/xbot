import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { EventLog } from "./event-log.js";
import { SessionReplay, createEmptySession } from "./session-replay.js";
import type { ChatMessage } from "../types/session.js";
import type { UsageInfo } from "../types/chat.js";
import { getSessionContextHistory } from "../utils/conversation-history.js";

let tmpDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-events-"));
    // 隔离会话存储：宿主环境可能注入 XBOT_STATE_DIR/TUI_CWD，统一指向临时目录避免写到真实会话目录。
    savedEnv = {
        WORKSPACE: process.env.WORKSPACE,
        XBOT_STATE_DIR: process.env.XBOT_STATE_DIR,
        TUI_CWD: process.env.TUI_CWD,
    };
    process.env.XBOT_STATE_DIR = tmpDir;
    delete process.env.TUI_CWD;
    process.env.WORKSPACE = tmpDir;
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

function usage(): UsageInfo {
    return { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 };
}

let turnCounter = 0;

/** 落盘一个完整回合：user_message + turn_message（逐条）+ turn_commit。 */
async function appendTurn(
    log: EventLog,
    sessionId: string,
    payload: {
        turnId?: string;
        userMessages?: string[];
        messages?: ChatMessage[];
        stopReason?: string;
        usage?: UsageInfo;
        interrupted?: boolean;
    },
): Promise<string> {
    turnCounter += 1;
    const turnId = payload.turnId ?? `T${turnCounter}`;
    for (const text of payload.userMessages ?? []) {
        await log.append(sessionId, "user_message", { text, turnId });
    }
    const seqs: number[] = [];
    for (const message of payload.messages ?? []) {
        const event = await log.append(sessionId, "turn_message", { turnId, message });
        seqs.push(event.seq);
    }
    await log.append(sessionId, "turn_commit", {
        turnId,
        events: seqs,
        userMessages: payload.userMessages ?? [],
        stopReason: payload.stopReason ?? "stop",
        usage: payload.usage ?? usage(),
        interrupted: payload.interrupted === true,
    });
    return turnId;
}

describe("EventLog", () => {
    it("重放压缩边界时按持久化位置恢复保留消息", async () => {
        const log = new EventLog();
        const sessionId = "sess-compact-position";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await appendTurn(log, sessionId, { userMessages: ["旧问题"], messages: [{ role: "assistant", content: "旧回答" }] });
        await appendTurn(log, sessionId, { userMessages: ["保留问题"], messages: [{ role: "assistant", content: "保留回答" }] });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "摘要",
            keepFromMessageId: "重启前的消息 ID",
            keepFromPosition: { turnIndex: 1, messageIndex: 1 },
        });
        await appendTurn(log, sessionId, { userMessages: ["新问题"], messages: [{ role: "assistant", content: "新回答" }] });

        const replay = new SessionReplay(log);
        const first = await replay.replayTo(sessionId);
        const second = await replay.replayTo(sessionId);
        const expected = ["<conversation_summary", "已确认上述历史上下文", "保留回答", "新问题", "新回答"];
        for (const { session } of [first, second]) {
            const contents = getSessionContextHistory(session).map(message => String(message.content));
            expect(contents).toHaveLength(expected.length);
            for (const [index, prefix] of expected.entries()) {
                expect(contents[index]).toContain(prefix);
            }
            expect(contents.join("\n")).not.toContain("旧问题");
        }
    });

    it("旧压缩事件的消息 ID 失效时保留压缩后的回合", async () => {
        const log = new EventLog();
        const sessionId = "sess-compact-legacy";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await appendTurn(log, sessionId, { userMessages: ["旧问题"], messages: [{ role: "assistant", content: "旧回答" }] });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "摘要",
            keepFromMessageId: "已失效的消息 ID",
        });
        await appendTurn(log, sessionId, { userMessages: ["新问题"], messages: [{ role: "assistant", content: "新回答" }] });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        const contents = getSessionContextHistory(session).map(message => String(message.content));
        expect(contents).toHaveLength(4);
        expect(contents[2]).toBe("新问题");
        expect(contents[3]).toBe("新回答");
    });

    it("append seq 递增，read 支持 fromSeq/limit", async () => {
        const log = new EventLog();
        const sessionId = "sess-1";

        const first = await log.append(sessionId, "session_created", {});
        const second = await log.append(sessionId, "user_message", { text: "hi", turnId: "T1", trigger: "user" });
        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);

        const all = await log.read(sessionId);
        expect(all).toHaveLength(2);
        expect(all[1].payload).toEqual({ text: "hi", turnId: "T1", trigger: "user" });

        const tail = await log.read(sessionId, 2);
        expect(tail).toHaveLength(1);
        expect(tail[0].seq).toBe(2);
    });

    it("重放重建 Session（turn_commit → appendCompletedTurn 投影）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-2";

        await log.append(sessionId, "session_created", {});
        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["hi"],
            messages: [{ role: "assistant", content: "hello" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.lastSeq).toBe(4);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "hi" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant", content: "hello" });
    });

    it("interrupted 回合物化为 interrupted turn，同时保留在日志", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-3";

        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["hi"],
            messages: [{ role: "assistant", content: "partial" } as ChatMessage],
            stopReason: "aborted",
            usage: usage(),
            interrupted: true,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "hi" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant", content: "partial" });
        expect((await log.read(sessionId))).toHaveLength(3);
    });

    it("快照 + 增量重放（回合闭合的第 100 个事件写快照）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-4";

        // session_created + 33 个完整回合（每回合 3 事件）= 100 个事件，第 100 个正好是 turn_commit
        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 33; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `T${index}`,
                userMessages: [`msg-${index}`],
                messages: [{ role: "assistant", content: `reply-${index}` } as ChatMessage],
            });
        }

        const snapshotSession = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, snapshotSession);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", "sess-4.snapshot.json"))).toBe(true);

        await appendTurn(log, sessionId, {
            turnId: "T-final",
            userMessages: ["final"],
            messages: [{ role: "assistant", content: "done" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.lastSeq).toBe(103);
        expect(result.session.turns).toHaveLength(34);
        expect(result.session.turns.at(-1)?.messages[1]).toMatchObject({ role: "assistant", content: "done" });
    });

    it("turn 进行中（最后事件为 user_message）不写快照，避免该用户消息被排除在重放之外", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-mid-turn";

        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 98; index += 1) {
            await log.append(sessionId, "user_message", { text: `msg-${index}`, turnId: "T-pending", trigger: "user" });
        }
        // 第 100 个事件是 user_message：请求已发出但 turn_commit 未落盘
        await log.append(sessionId, "user_message", { text: "进行中", turnId: "T-pending", trigger: "user" });

        const session = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, session);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", "sess-mid-turn.snapshot.json"))).toBe(false);

        // 进程被强杀：仅剩 user_message，重放时物化为 interrupted 回合，上下文不丢
        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages).toHaveLength(99);
        expect(result.session.turns[0].messages.at(-1)).toMatchObject({ role: "user", content: "进行中" });
    });

    it("孤儿 user_message 在后续回合前按顺序物化，且不被后续 turn_commit 吞掉", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-orphan";

        await log.append(sessionId, "session_created", {});
        // 第一轮：user_message 落盘后进程被强杀，turn_commit 缺失
        await log.append(sessionId, "user_message", { text: "崩溃前的消息", turnId: "T1", trigger: "user" });
        // 重启后继续对话
        await appendTurn(log, sessionId, {
            turnId: "T2",
            userMessages: ["新消息"],
            messages: [{ role: "assistant", content: "回复" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        // 孤儿消息按发生顺序排在新回合之前，不丢失也不重复
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages.map(message => (message as any).content)).toEqual(["崩溃前的消息"]);
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages.map(message => (message as any).content)).toEqual(["新消息", "回复"]);
    });

    it("执行中并入的 pending 消息（出现在 messages）不重复物化", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-pending";

        await log.append(sessionId, "user_message", { text: "第一问", turnId: "T1" });
        await log.append(sessionId, "user_message", { text: "补充问题", turnId: "T1", trigger: "pending" });
        const seqs: number[] = [];
        for (const message of [
            { role: "user", content: "补充问题" } as ChatMessage,
            { role: "assistant", content: "合并回复" } as ChatMessage,
        ]) {
            seqs.push((await log.append(sessionId, "turn_message", { turnId: "T1", message })).seq);
        }
        await log.append(sessionId, "turn_commit", {
            turnId: "T1",
            events: seqs,
            userMessages: ["第一问"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].messages.map(message => (message as any).content)).toEqual([
            "第一问",
            "补充问题",
            "合并回复",
        ]);
    });

    it("turn_message 是内容唯一来源，终态只存关系", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-turnmsg";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "tool", tool_call_id: "c1", name: "bash", content: "结果" } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: "最终答案" } as ChatMessage,
        });
        await log.append(sessionId, "turn_commit", {
            turnId: "T1",
            events: [3, 4, 5],
            userMessages: ["查行情"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("completed");
        // user + 终态三条：增量不重复投影
        expect(result.session.turns[0].messages).toHaveLength(4);
    });

    it("未闭合的 turn_message 物化为 interrupted 回合（只有 call 也保留）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-turnmsg-abort";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "查行情" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant" });
    });

    it("续跑回合（userMessages 为空）投影为无用户消息的 turn，工具消息紧跟上一条 assistant", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-resume";

        await log.append(sessionId, "session_created", {});
        // T1 未闭合：只有用户消息与 call
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });
        // T2 续跑：无 user_message，从补跑工具开始
        await log.append(sessionId, "turn_message", {
            turnId: "T2",
            message: { role: "tool", tool_call_id: "c1", name: "bash", content: "重跑结果" } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T2",
            message: { role: "assistant", content: "完成" } as ChatMessage,
        });
        await log.append(sessionId, "turn_commit", {
            turnId: "T2",
            events: [4, 5],
            userMessages: [],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages).toHaveLength(2);
        expect(result.session.turns[1].messages.map(message => message.role)).toEqual(["tool", "assistant"]);
        expect(result.session.totalUserTurnCount).toBe(1);
    });

    it("损坏尾行不影响后续 seq", async () => {
        const log = new EventLog();
        const sessionId = "sess-corrupt-tail";
        await log.append(sessionId, "session_created", {});
        const filePath = path.join(tmpDir, "sessions", "events", "sess-corrupt-tail.jsonl");
        fs.appendFileSync(filePath, '{"seq":999,"broken\\n', "utf8");

        const next = await log.append(sessionId, "user_message", { text: "after", turnId: "T1", trigger: "user" });
        expect(next.seq).toBe(2);
    });

    it("并发追加保持 seq 唯一递增", async () => {
        const log = new EventLog();
        const sessionId = "sess-concurrent";
        const events = await Promise.all(
            Array.from({ length: 10 }, (_, index) => log.append(sessionId, "user_message", { text: String(index), turnId: "T1", trigger: "user" })),
        );
        expect(events.map(event => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    });

    it("损坏行容错：跳过坏行不阻断读取", async () => {
        const log = new EventLog();
        const sessionId = "sess-5";
        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "hi", turnId: "T1", trigger: "user" });

        const filePath = path.join(tmpDir, "sessions", "events", "sess-5.jsonl");
        const text = fs.readFileSync(filePath, "utf8");
        fs.writeFileSync(filePath, text + '{"seq":999,"broken\n', "utf8");

        const events = await log.read(sessionId);
        expect(events).toHaveLength(2);
        expect(events[1].payload).toEqual({ text: "hi", turnId: "T1", trigger: "user" });
    });

    it("truncate 截断到目标 seq，后续事件作废", async () => {
        const log = new EventLog();
        const sessionId = "sess-6";
        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "first", turnId: "T1", trigger: "user" });
        await appendTurn(log, sessionId, {
            turnId: "T1",
            messages: [{ role: "assistant", content: "one" } as ChatMessage],
        });
        await log.append(sessionId, "user_message", { text: "second", turnId: "T2", trigger: "user" });

        await log.truncate(sessionId, 2);
        expect(await log.lastSeq(sessionId)).toBe(2);
        const events = await log.read(sessionId);
        expect(events).toHaveLength(2);

        const next = await log.append(sessionId, "user_message", { text: "rewritten", turnId: "T1", trigger: "user" });
        expect(next.seq).toBe(3);
    });
});

describe("standalone_turn replay", () => {
    it("standalone_turn 投影为独立 completed turn", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-standalone";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "standalone_turn", {
            messages: [
                { role: "user", content: "[图片提问] 分析 (ID: img_1)" } as ChatMessage,
                { role: "assistant", content: "[图片分析结果] (ID: img_1) 一只猫" } as ChatMessage,
            ],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        const turn = result.session.turns[0];
        expect(turn.status).toBe("completed");
        expect(turn.messages.map((m) => m.content)).toEqual([
            "[图片提问] 分析 (ID: img_1)",
            "[图片分析结果] (ID: img_1) 一只猫",
        ]);
    });

    it("standalone_turn 与普通回合交错重放保持一致", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-mixed";

        await log.append(sessionId, "session_created", {});
        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["你好"],
            messages: [{ role: "assistant", content: "你好！" } as ChatMessage],
        });
        await log.append(sessionId, "standalone_turn", {
            messages: [
                { role: "user", content: "[图片提问] (ID: img_2)" } as ChatMessage,
                { role: "assistant", content: "[图片分析结果] (ID: img_2) 内容" } as ChatMessage,
            ],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages[1].content).toContain("img_2");
    });
});

describe("会话 cwd 持久化", () => {
    const commitPayload = {
        turnId: "T-cwd",
        events: [],
        userMessages: ["hi"],
        stopReason: "stop",
        usage: usage(),
        interrupted: false,
    };

    it("appendAgentEvent 自动补的 session_created 记录会话 cwd，重放可恢复", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-1";
        const session = { ...createEmptySession(sessionId), cwd: "/proj/alpha" };

        await replay.appendAgentEvent(session, "turn_commit", commitPayload);

        const events = await log.read(sessionId);
        expect(events[0].type).toBe("session_created");
        expect(events[0].payload).toEqual({ cwd: "/proj/alpha" });

        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe("/proj/alpha");
    });

    it("session.cwd 缺失时用当前工具目录补齐", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-2";
        const session = createEmptySession(sessionId);

        await replay.appendAgentEvent(session, "turn_commit", commitPayload);

        const events = await log.read(sessionId);
        expect(events[0].type).toBe("session_created");
        expect(events[0].payload).toEqual({ cwd: path.resolve(tmpDir) });
        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe(path.resolve(tmpDir));
    });

    it("旧事件无 cwd 时归一到当前工具目录，不阻塞重放", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-3";

        await log.append(sessionId, "session_created", {} as never);
        await log.append(sessionId, "turn_commit", commitPayload);

        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe(path.resolve(tmpDir));
        expect(result.session.turns).toHaveLength(1);
    });
});
