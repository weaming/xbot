import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getSocketPath } from "../control/paths.js";
import { encodeFrame, splitFrames, type PeerFrame } from "../control/protocol.js";
import { listSavedSessionIds } from "../events/session-files.js";
import {
    formatTable,
    parseSessionArgs,
    resolveSessionIdFrom,
    runSessionCli,
    type SessionRow,
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
function startFakePeer(sessionId: string, options: { busy?: boolean; resultText?: string } = {}): Promise<void> {
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
                socket.write(encodeFrame({
                    type: "result",
                    result: {
                        msgId: frame.message.id,
                        ok: true,
                        text: options.resultText ?? "已完成",
                        stopReason: "stop",
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
        expect(parseSessionArgs(["rename", "abc", "新", "标题"])).toEqual({ kind: "rename", id: "abc", title: "新 标题" });
        expect(parseSessionArgs(["archive", "abc"])).toEqual({ kind: "archive", id: "abc" });
        expect(parseSessionArgs(["rm", "abc"])).toEqual({ kind: "delete", id: "abc" });
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
});

describe("formatTable", () => {
    test("按显示列对齐，中文标题不挤歪副列", () => {
        const rows: SessionRow[] = [
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
        expect(first).toContain("空闲");
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
});

describe("协议帧解析", () => {
    test("splitFrames 与 encodeFrame 往返一致", () => {
        const frame: PeerFrame = { type: "ping", id: "p1" };
        expect(splitFrames(encodeFrame(frame)).frames).toEqual([frame]);
    });
});
