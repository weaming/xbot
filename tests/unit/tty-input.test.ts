/**
 * tty 输入队列清理：尾部探针回包必须被读掉，否则会被下一个读 stdin 的进程回显。
 */

import { describe, expect, test } from "bun:test";
import { discardPendingInput, type InputDrainStream } from "../../src/utils/tty-input.js";

/** 假 stdin：resume 时按序吐出预置字节，记录 raw 模式切换与暂停。 */
function fakeStdin(options: {
    isTTY?: boolean;
    isRaw?: boolean;
    chunks?: string[];
}): { stream: InputDrainStream; rawModes: boolean[]; resumeCount: number; pauseCount: number } {
    const chunks = [...(options.chunks ?? [])];
    const state = {
        rawModes: [] as boolean[],
        resumeCount: 0,
        pauseCount: 0,
    };
    const stream: InputDrainStream = {
        isTTY: options.isTTY ?? true,
        isRaw: options.isRaw ?? false,
        setRawMode: mode => {
            state.rawModes.push(mode);
            stream.isRaw = mode;
        },
        on: (_event, listener) => {
            stream.resume = () => {
                state.resumeCount += 1;
                for (const chunk of chunks.splice(0)) listener({ length: chunk.length });
            };
            return undefined;
        },
        off: () => undefined,
        resume: () => undefined,
        pause: () => {
            state.pauseCount += 1;
        },
    };
    return {
        stream,
        get rawModes() {
            return state.rawModes;
        },
        get resumeCount() {
            return state.resumeCount;
        },
        get pauseCount() {
            return state.pauseCount;
        },
    };
}

describe("discardPendingInput", () => {
    test("切 raw 读掉队列里的探针回包，读完复原原 raw 状态", async () => {
        const stdin = fakeStdin({ chunks: ["\x1b[?62;22;52c", "\x1b]11;rgb:2828/2c2c/3434\x1b\\"] });

        const discarded = await discardPendingInput({ stdin: stdin.stream, maxMs: 80, idleMs: 10 });

        // 两段回包共 12 + 25 字节：拿到件数即证明是真的从流里读走并丢弃
        expect(discarded).toBe(37);
        expect(stdin.rawModes).toEqual([true, false]);
        expect(stdin.pauseCount).toBe(1);
    });

    test("原本就在 raw 模式的调用方，排空后仍留在 raw", async () => {
        const stdin = fakeStdin({ isRaw: true });

        await discardPendingInput({ stdin: stdin.stream, maxMs: 30, idleMs: 10 });

        expect(stdin.rawModes).toEqual([true, true]);
    });

    test("非 TTY 不碰 stdin（管道、CI、后台服务都没有队列可排）", async () => {
        const stdin = fakeStdin({ isTTY: false, chunks: ["x"] });

        const discarded = await discardPendingInput({ stdin: stdin.stream });

        expect(discarded).toBe(0);
        expect(stdin.rawModes).toEqual([]);
        expect(stdin.resumeCount).toBe(0);
    });

    test("队列空时等待 idleMs 后返回，不拖到 maxMs", async () => {
        const stdin = fakeStdin({});
        const startedAt = Date.now();

        const discarded = await discardPendingInput({ stdin: stdin.stream, maxMs: 5000, idleMs: 30 });

        expect(discarded).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(1000);
    });
});
