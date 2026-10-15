/**
 * 会话归属注册表：归属探测（connect 即真相）、inode 保护的释放、残留 socket 清理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import net from "net";
import { encodeFrame, splitFrames, type PeerFrame } from "../../src/control/protocol.js";
import { ensureControlDir, getSocketPath, listSocketSessionIds } from "../../src/control/paths.js";
import {
    cleanupStaleSockets,
    describeOwnership,
    forgetBound,
    isLocallyBound,
    locallyBoundSessionIds,
    probeOwnership,
    registerBound,
    releaseSocketFile,
} from "../../src/control/registry.js";
import { useTmpWorkspace, type TmpWorkspace } from "./test-env.js";

let workspace: TmpWorkspace;

beforeEach(() => {
    workspace = useTmpWorkspace("xbot-control-registry-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    workspace.cleanup();
});

/** 在指定路径起一个假监听：answeringWho 决定它是否回应 who 握手。 */
function listenFake(sessionId: string, answeringWho: boolean): Promise<net.Server> {
    const socketPath = getSocketPath(sessionId);
    ensureControlDir();

    const server = net.createServer((socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
                if (!answeringWho || frame.type !== "who") continue;
                socket.write(
                    encodeFrame({
                        type: "who",
                        id: frame.id,
                        info: {
                            pid: 1,
                            instanceId: "foreign",
                            sessionId,
                            title: "外来会话",
                            busy: true,
                            pending: 0,
                        },
                    }),
                );
            }
        });
        socket.on("error", () => undefined);
    });

    return new Promise<net.Server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve(server));
    });
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

describe("路径与本地表", () => {
    test("socket 路径按 sessionId 归一到 sessions/control", () => {
        expect(getSocketPath("s1")).toBe(`${workspace.dir}/sessions/control/s1.sock`);
    });

    test("本地表决定 mine，缺省为 free", async () => {
        expect(await probeOwnership("s1", 100)).toEqual({ state: "free" });

        fs.mkdirSync(`${workspace.dir}/sessions/control`, { recursive: true });
        const file = getSocketPath("s1");
        fs.writeFileSync(file, "");
        registerBound("s1", file, fs.statSync(file).ino);

        expect(isLocallyBound("s1")).toBe(true);
        expect(await probeOwnership("s1", 100)).toEqual({ state: "mine" });
    });
});

describe("归属探测", () => {
    test("无人监听（文件不存在）判定 free", async () => {
        expect(await probeOwnership("s-missing", 100)).toEqual({ state: "free" });
    });

    test("残留普通文件判定 free，可被清理", async () => {
        fs.mkdirSync(`${workspace.dir}/sessions/control`, { recursive: true });
        fs.writeFileSync(getSocketPath("s-stale"), "");

        expect(await probeOwnership("s-stale", 100)).toEqual({ state: "free" });
        expect(await cleanupStaleSockets(100)).toEqual(["s-stale"]);
        expect(fs.existsSync(getSocketPath("s-stale"))).toBe(false);
    });

    test("有监听且回应 who：返回 other 与实时身份", async () => {
        const server = await listenFake("s-foreign", true);
        try {
            const ownership = await probeOwnership("s-foreign", 200);
            expect(ownership.state).toBe("other");
            expect(ownership.state === "other" && ownership.info?.pid).toBe(1);
            expect(ownership.state === "other" && ownership.info?.busy).toBe(true);
        } finally {
            await closeServer(server);
            fs.rmSync(getSocketPath("s-foreign"), { force: true });
        }
    });

    test("有监听但不回应 who：仍判 other 且无 info（绝不清理）", async () => {
        const server = await listenFake("s-mute", false);
        try {
            expect(await probeOwnership("s-mute", 100)).toEqual({ state: "other" });
            expect(await cleanupStaleSockets(100)).toEqual([]);
            expect(fs.existsSync(getSocketPath("s-mute"))).toBe(true);
        } finally {
            await closeServer(server);
            fs.rmSync(getSocketPath("s-mute"), { force: true });
        }
    });

    test("listSocketSessionIds 只列出 .sock 文件", async () => {
        fs.mkdirSync(`${workspace.dir}/sessions/control`, { recursive: true });
        fs.writeFileSync(getSocketPath("a"), "");
        fs.writeFileSync(`${workspace.dir}/sessions/control/note.txt`, "");

        expect(listSocketSessionIds()).toEqual(["a"]);
    });
});

describe("socket 文件释放的 inode 保护", () => {
    test("文件仍是自己 bind 的那个时删除", () => {
        fs.mkdirSync(`${workspace.dir}/sessions/control`, { recursive: true });
        const file = getSocketPath("s1");
        fs.writeFileSync(file, "");
        registerBound("s1", file, fs.statSync(file).ino);

        releaseSocketFile("s1");
        expect(fs.existsSync(file)).toBe(false);
        expect(isLocallyBound("s1")).toBe(false);
    });

    test("文件已被他人重建时不删除", () => {
        fs.mkdirSync(`${workspace.dir}/sessions/control`, { recursive: true });
        const file = getSocketPath("s1");
        fs.writeFileSync(file, "");
        registerBound("s1", file, fs.statSync(file).ino);

        // 模拟：别人 unlink 后重建了同名 socket
        fs.rmSync(file);
        fs.writeFileSync(file, "someone-else");
        const foreignIno = fs.statSync(file).ino;

        releaseSocketFile("s1");
        expect(isLocallyBound("s1")).toBe(false);
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).ino).toBe(foreignIno);
    });
});

describe("describeOwnership", () => {
    test("三种状态文案", () => {
        expect(describeOwnership("s1", { state: "mine" })).toBe("本实例");
        expect(describeOwnership("s1", { state: "free" })).toBe("未认领");
        expect(describeOwnership("s1", { state: "other" })).toBe("其他实例（无应答）");
        expect(
            describeOwnership("s1", {
                state: "other",
                info: { pid: 42, instanceId: "x", sessionId: "s1", busy: false, pending: 0 },
            }),
        ).toBe("PID 42 · 空闲");
        expect(
            describeOwnership("s1", {
                state: "other",
                info: { pid: 42, instanceId: "x", sessionId: "s1", busy: true, pending: 3 },
            }),
        ).toBe("PID 42 · 忙");
    });
});

describe("协议帧", () => {
    test("切分缓冲：只吐出完整帧", () => {
        const frames: PeerFrame[] = [
            { type: "ping", id: "1" },
            { type: "pong", id: "2" },
        ];
        const text = frames.map(encodeFrame).join("") + '{"type":"ping"';

        const first = splitFrames(text);
        expect(first.frames).toEqual(frames);
        expect(first.rest).toBe('{"type":"ping"');

        const second = splitFrames(`${first.rest},"id":"3"}\n`);
        expect(second.frames).toEqual([{ type: "ping", id: "3" }]);
        expect(second.rest).toBe("");
    });

    test("非法行被忽略而不是抛错", () => {
        const { frames, rest } = splitFrames("not json\n\n123\n");
        expect(frames).toEqual([]);
        expect(rest).toBe("");
    });
});
