import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getSocketPath } from "../control/paths.js";
import { encodeFrame, splitFrames, type PeerFrame } from "../control/protocol.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { getResponsesBaselineFile } from "../utils/state-paths.js";
import {
    formatTable,
    parseSessionArgs,
    resolveSessionIdFrom,
    runSessionCli,
    SessionCliError,
    type SessionListRow,
} from "./session.js";

let tmpDir: string;
let previousStateDir: string | undefined;
const servers: net.Server[] = [];

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-session-cli-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function run(argv: string[], stdinText = ""): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, {
        write: (text) => chunks.push(text),
        readStdin: async () => stdinText,
    });
    return chunks.join("");
}

/** 造一个只认 who / deliver 的假会话服务端；用于验证 send 的投递与结果等待。 */
function startFakePeer(
    sessionId: string,
    options: { busy?: boolean; resultText?: string; replyWithResult?: boolean; resultOk?: boolean } = {},
): Promise<void> {
    const socketPath = getSocketPath(sessionId);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
                if (frame.type === "who") {
                    socket.write(encodeFrame({
                        type: "who",
                        id: frame.id,
                        info: { pid: process.pid, instanceId: "fake", sessionId, busy: false, pending: 0 },
                    }));
                    continue;
                }
                if (frame.type !== "deliver") continue;
                if (options.busy) {
                    socket.write(encodeFrame({ type: "ack", id: frame.id, ok: false, error: "busy" }));
                    continue;
                }
                socket.write(encodeFrame({ type: "ack", id: frame.id, ok: true }));
                if (options.replyWithResult === false) continue;
                socket.write(encodeFrame({
                    type: "result",
                    result: {
                        msgId: frame.message.id,
                        ok: options.resultOk ?? true,
                        text: options.resultText ?? "已完成",
                        stopReason: "stop",
                        ...(options.resultOk === false ? { error: "上游 500" } : {}),
                    },
                }));
            }
        });
    });
    servers.push(server);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
    });
}

describe("parseSessionArgs", () => {
    test("无子命令时输出用法", () => {
        expect(parseSessionArgs([])).toEqual({ kind: "help" });
        expect(parseSessionArgs(["help"])).toEqual({ kind: "help" });
    });

    test("list 支持 --all / --json", () => {
        expect(parseSessionArgs(["list", "--all", "--json"])).toEqual({ kind: "list", all: true, json: true });
        expect(() => parseSessionArgs(["list", "--bogus"])).toThrow("list 不支持参数");
    });

    test("show 解析轮数与预览开关", () => {
        expect(parseSessionArgs(["show", "abc", "--turns", "5", "--full", "--json"])).toEqual({
            kind: "show",
            id: "abc",
            turns: 5,
            all: false,
            full: true,
            json: true,
        });
        expect(parseSessionArgs(["show", "abc", "--turns=2"])).toMatchObject({ turns: 2 });
        expect(() => parseSessionArgs(["show"])).toThrow("zbot session show");
    });

    test("new / rename / archive / delete 的参数形态", () => {
        expect(parseSessionArgs(["new", "--title", "标题", "--cwd", "/tmp"])).toEqual({
            kind: "new",
            title: "标题",
            cwd: "/tmp",
            json: false,
        });
        expect(parseSessionArgs(["rename", "abc", "新", "标题"])).toEqual({ kind: "rename", id: "abc", title: "新 标题", json: false });
        expect(parseSessionArgs(["rename", "abc", "--", "修复 --json 输出"])).toMatchObject({ title: "修复 --json 输出" });
        expect(parseSessionArgs(["archive", "abc"])).toEqual({ kind: "archive", id: "abc", json: false });
        expect(parseSessionArgs(["archive", "abc", "--json"])).toEqual({ kind: "archive", id: "abc", json: true });
        expect(parseSessionArgs(["rm", "abc"])).toEqual({ kind: "delete", id: "abc", json: false });
        expect(() => parseSessionArgs(["rename", "abc"])).toThrow("rename 需要新标题");
        expect(() => parseSessionArgs(["archive"])).toThrow("zbot session archive");
    });

    test("send 解析等待窗口", () => {
        expect(parseSessionArgs(["send", "abc", "帮我", "看看"])).toEqual({
            kind: "send",
            id: "abc",
            text: "帮我 看看",
            waitSeconds: undefined,
            json: false,
        });
        expect(parseSessionArgs(["send", "abc", "hi", "--wait"])).toMatchObject({ waitSeconds: 300 });
        expect(parseSessionArgs(["send", "abc", "hi", "--wait=12"])).toMatchObject({ waitSeconds: 12 });
    });

    test("未知子命令给出用法", () => {
        expect(() => parseSessionArgs(["nope"])).toThrow("未知子命令");
    });
});

describe("resolveSessionIdFrom", () => {
    const ids = ["01ABCDEF1111", "01ABCDEF2222", "01ZZZZZZ3333"];

    test("精确 / 唯一前缀 / 唯一后缀都能命中", () => {
        expect(resolveSessionIdFrom("01ABCDEF1111", ids)).toBe("01ABCDEF1111");
        expect(resolveSessionIdFrom("01ZZZ", ids)).toBe("01ZZZZZZ3333");
        expect(resolveSessionIdFrom("F2222", ids)).toBe("01ABCDEF2222");
    });

    test("歧义与缺失都报错", () => {
        expect(() => resolveSessionIdFrom("01ABCDEF", ids)).toThrow("匹配到多个候选");
        expect(() => resolveSessionIdFrom("deadbeef", ids)).toThrow("会话不存在");
    });

    test("前缀与后缀各命中不同会话时也算歧义", () => {
        expect(() => resolveSessionIdFrom("AB", ["AB111111", "222222AB"])).toThrow("匹配到多个候选");
    });
});

describe("formatTable", () => {
    test("按显示列对齐，中文标题不挤歪副列", () => {
        const rows: SessionListRow[] = [
            {
                sessionId: "01ABCDEF1111",
                summary: { sessionId: "01ABCDEF1111", title: "中文标题", messageCount: 3, cwd: "/tmp/a", updatedAt: "2026-10-27T10:00:00.000Z" },
                ownership: { state: "free" },
            },
            {
                sessionId: "01ABCDEF2222",
                summary: { sessionId: "01ABCDEF2222", title: "abc", messageCount: 12, archived: true },
            },
        ];
        const [header, first, second] = formatTable(rows);
        expect(header).toContain("状态");
        // 归属文案复用 registry.describeOwnership，避免 CLI 与 TUI 两套措辞
        expect(first).toContain("未认领");
        expect(first).toContain("中文标题");
        expect(second).toContain("已归档");
        // ID 列的显示起点一致，说明列宽按显示宽度而非码元数对齐
        expect(visibleWidth(first!.slice(0, first!.indexOf("CDEF"))))
            .toBe(visibleWidth(second!.slice(0, second!.indexOf("CDEF"))));
    });
});

describe("会话命令行端到端", () => {
    test("new / list / rename / archive / unarchive / delete 全流程落到磁盘", async () => {
        const created = await run(["new", "--title", "首个会话", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        expect(listSavedSessionIds()).toEqual([sessionId]);

        const listed = JSON.parse(await run(["list", "--json"])) as Array<Record<string, unknown>>;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ sessionId, title: "首个会话", turns: 0, archived: false, status: "idle" });

        await run(["rename", sessionId.slice(-8), "改名后"]);
        const shown = JSON.parse(await run(["show", sessionId.slice(-8), "--json"])) as Record<string, unknown>;
        expect(shown).toMatchObject({ sessionId, title: "改名后", totalTurns: 0 });

        await run(["archive", sessionId]);
        expect(await run(["list", "--json"])).toBe("[]\n");
        expect(JSON.parse(await run(["list", "--all", "--json"])) as unknown[]).toHaveLength(1);

        await run(["unarchive", sessionId]);
        expect(JSON.parse(await run(["list", "--json"])) as unknown[]).toHaveLength(1);

        await run(["delete", sessionId]);
        expect(listSavedSessionIds()).toEqual([]);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`))).toBe(false);
    });

    test("new 拒绝不存在的 cwd", async () => {
        await expect(run(["new", "--cwd", path.join(tmpDir, "missing")])).rejects.toThrow("cwd 不是已存在的目录");
    });

    test("会话未被持有时 send 直接报错", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await expect(run(["send", sessionId, "hi"])).rejects.toThrow("没有运行中的实例持有");
    });

    test("send --wait 拿到运行中会话的回合结果", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { resultText: "做完了" });

        expect(await run(["send", sessionId.slice(-8), "跑一下", "--wait=5"])).toBe("做完了\n");
        const payload = JSON.parse(await run(["send", sessionId, "再跑", "--wait=5", "--json"])) as Record<string, unknown>;
        expect(payload).toMatchObject({ sessionId, ok: true, text: "做完了" });
    });

    test("对方忙时 send 报可读错误", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { busy: true });
        await expect(run(["send", sessionId, "hi", "--wait=5"])).rejects.toThrow("正在执行中");
    });

    test("被持有时的写操作一律拒绝，且不落任何事件", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId);
        const eventFile = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
        const before = fs.readFileSync(eventFile, "utf8");

        for (const argv of [["rename", sessionId, "新标题"], ["archive", sessionId], ["delete", sessionId]]) {
            await expect(run(argv)).rejects.toThrow("正被其他实例持有");
        }
        expect(fs.readFileSync(eventFile, "utf8")).toBe(before);
    });

    test("send --wait 超时：标记已投递并给出独立退出码", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { replyWithResult: false });

        const error = await run(["send", sessionId, "跑一下", "--wait=1"]).catch(error => error);
        expect(error).toBeInstanceOf(SessionCliError);
        expect(error.code).toBe("wait_timeout");
        expect(error.exitCode).toBe(2);
        expect(error.details).toMatchObject({ delivered: true });
        expect(error.message).toContain("不要重复发送");
    });

    test("对方回合失败：结果文本随错误带出", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { resultOk: false, resultText: "半截输出" });

        const error = await run(["send", sessionId, "跑一下", "--wait=5"]).catch(error => error);
        expect(error.code).toBe("peer_failed");
        expect(error.details).toMatchObject({ delivered: true, partialText: "半截输出" });
        // 人类模式（非 --json）也要把部分输出带到 stderr
        expect(error.message).toContain("半截输出");
    });

    test("delete 连带清掉快照、流式旁路、socket 与锁文件", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        const eventsDir = path.join(tmpDir, "sessions", "events");
        const lockFile = path.join(tmpDir, "sessions", "locks", `${sessionId}.lock`);
        const extras = [
            path.join(eventsDir, `${sessionId}.snapshot.json`),
            path.join(eventsDir, `${sessionId}.stream.jsonl`),
            getSocketPath(sessionId),
            lockFile,
        ];
        fs.mkdirSync(path.dirname(extras[2]!), { recursive: true });
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        for (const extra of extras.slice(0, 3)) fs.writeFileSync(extra, "");
        const baselineFile = getResponsesBaselineFile(sessionId);
        fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
        fs.writeFileSync(baselineFile, "{}");
        extras.push(baselineFile);
        // 残留锁（进程已退出）：删除流程应接管并在收尾时清掉
        fs.writeFileSync(lockFile, JSON.stringify({
            pid: 999_999,
            sessionId,
            lockedAt: "2026-10-28T00:00:00+08:00",
            updatedAt: "2026-10-28T00:00:00+08:00",
            ownerId: "stale",
        }));

        await run(["delete", sessionId]);
        expect(extras.filter(extra => fs.existsSync(extra))).toEqual([]);
    });

    test("show --json 键集合稳定：缺省值为 null 而非整键消失", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        const shown = JSON.parse(await run(["show", sessionId, "--json"])) as Record<string, unknown>;

        for (const key of ["title", "cwd", "createdAt", "updatedAt", "modelSelection", "holderPid", "busy"]) {
            expect(Object.prototype.hasOwnProperty.call(shown, key)).toBe(true);
        }
        expect(shown).toMatchObject({ status: "idle", holderPid: null, modelSelection: null });
    });

    test("--full 也剥掉控制序列，未知 role 不抛裸 JS 错误", async () => {
        const sessionId = "01M5ZJTESTROLE000000000001";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        const line = (seq: number, event: Record<string, unknown>) =>
            JSON.stringify({ seq, ts: "2026-10-28T00:00:00.000Z", sessionId, ...event });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), [
            line(1, { type: "session_created", payload: { cwd: tmpDir } }),
            line(2, {
                type: "standalone_turn",
                payload: {
                    messages: [
                        { id: "m1", createdAt: "2026-10-28T00:00:01.000Z", role: "assistant", content: "a\u001b[2Jb" },
                        { id: "m2", createdAt: "2026-10-28T00:00:02.000Z", role: "developer", content: "自定义角色" },
                    ],
                },
            }),
        ].join("\n") + "\n");

        const output = await run(["show", "01M5ZJTESTROLE000000000001", "--all", "--full"]);
        expect(output).not.toContain("\u001b");
        expect(output).toContain("ab");
        expect(output).toContain("developer: 自定义角色");
    });

    test("send 参数：--wait 空格取值与未知开关都报错", () => {
        expect(() => parseSessionArgs(["send", "abc", "hi", "--wait", "300"])).toThrow("--wait=300");
        expect(() => parseSessionArgs(["send", "abc", "hi", "--no-wait"])).toThrow("send 不支持参数");
        expect(parseSessionArgs(["send", "abc", "--", "-开头的正文"])).toMatchObject({ text: "-开头的正文" });
        // --json 现在是 rename 的合法开关；只有未知开关才报错
        expect(parseSessionArgs(["rename", "abc", "新名", "--json"])).toMatchObject({ json: true, title: "新名" });
        expect(() => parseSessionArgs(["rename", "abc", "--bogus"])).toThrow("rename 不支持参数");
    });
});

describe("日志异常与列表完整性", () => {
    test("事件日志读不出有效事件时仍留一行并标注损坏", async () => {
        const sessionId = "01GARBAGE0000000000000001";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), "not-json\n");

        const listed = JSON.parse(await run(["list", "--all", "--json"])) as Array<Record<string, unknown>>;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ sessionId, corrupted: true, turns: 0 });
        expect(await run(["list", "--all"])).toContain("日志损坏");
    });

    test("new --json 无标题时 title 为 null 而非缺键", async () => {
        const created = JSON.parse(await run(["new", "--json"])) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(created, "title")).toBe(true);
        expect(created.title).toBeNull();
    });

    test("show 对损坏日志给出 corrupted 与提示行", async () => {
        const sessionId = "01GARBAGE0000000000000002";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), "not-json\n");

        const shown = JSON.parse(await run(["show", sessionId, "--json"])) as Record<string, unknown>;
        expect(shown).toMatchObject({ sessionId, corrupted: true, totalTurns: 0 });
        expect(typeof shown.updatedAt).toBe("string");
        expect(await run(["show", sessionId])).toContain("日志   损坏");
    });
});

describe("写操作的 --json 契约", () => {
    test("rename / archive / delete 都支持 --json", async () => {
        const { sessionId } = JSON.parse(await run(["new", "--json"])) as { sessionId: string };

        expect(JSON.parse(await run(["rename", sessionId, "新标题", "--json"]))).toMatchObject({
            sessionId,
            action: "rename",
            title: "新标题",
        });
        expect(JSON.parse(await run(["archive", sessionId, "--json"]))).toMatchObject({
            sessionId,
            action: "archive",
            archived: true,
        });
        expect(JSON.parse(await run(["unarchive", sessionId, "--json"]))).toMatchObject({ archived: false });
        expect(JSON.parse(await run(["delete", sessionId, "--json"]))).toMatchObject({
            sessionId,
            action: "delete",
            deleted: true,
        });
    });
});

describe("协议帧解析", () => {
    test("splitFrames 与 encodeFrame 往返一致", () => {
        const frame: PeerFrame = { type: "ping", id: "p1" };
        expect(splitFrames(encodeFrame(frame)).frames).toEqual([frame]);
    });
});
