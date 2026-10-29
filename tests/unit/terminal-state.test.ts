import { describe, expect, test } from "bun:test";
import {
    drainPendingInput,
    installTerminalExitGuard,
    resetTerminalModes,
    type InputDrainStream,
} from "../../src/utils/terminal-state.js";

describe("resetTerminalModes", () => {
    test("TTY 下复位键盘协议、鼠标/焦点上报、自动换行、同步输出、bracketed paste 与光标", () => {
        const written: string[] = [];

        resetTerminalModes({ isTTY: true, write: text => written.push(text) });

        expect(written).toEqual([
            "\x1b[<u"        // 弹出 kitty 键盘协议栈
            + "\x1b[>4;0m"   // 关 modifyOtherKeys
            + "\x1b[?7h"     // 恢复自动换行
            + "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l" // 关鼠标与焦点上报
            + "\x1b[?2026l"  // 关同步输出
            + "\x1b[?2004l"  // 关 bracketed paste
            + "\x1b[0m"      // 复位颜色属性
            + "\x1b[?25h",   // 恢复光标
        ]);
        // 刻意不含切缓冲序列：正常路径由 tui.stop() 负责
        expect(written[0]).not.toContain("\x1b[?1049l");
    });

    test("非 TTY 不写任何字节（管道、CI 输出不该混进转义序列）", () => {
        const written: string[] = [];

        resetTerminalModes({ isTTY: false, write: text => written.push(text) });

        expect(written).toEqual([]);
    });

    test("终端已关闭时吞掉写入错误", () => {
        expect(() => resetTerminalModes({
            isTTY: true,
            write: () => {
                throw new Error("EPIPE");
            },
        })).not.toThrow();
    });
});

describe("installTerminalExitGuard", () => {
    test("重复安装不会重复挂钩子", () => {
        installTerminalExitGuard();
        const afterFirst = process.listenerCount("exit");

        installTerminalExitGuard();

        expect(process.listenerCount("exit")).toBe(afterFirst);
    });
});

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

describe("drainPendingInput", () => {
    test("切 raw 读掉队列里的探针回包，读完复原原 raw 状态", async () => {
        const stdin = fakeStdin({ chunks: ["\x1b[?62;22;52c", "\x1b]11;rgb:2828/2c2c/3434\x1b\\"] });

        const discarded = await drainPendingInput({ stdin: stdin.stream, maxMs: 80, idleMs: 10 });

        // 两段回包共 12 + 25 字节：拿到件数即证明是真的从流里读走并丢弃
        expect(discarded).toBe(37);
        expect(stdin.rawModes).toEqual([true, false]);
        expect(stdin.pauseCount).toBe(1);
    });

    test("原本就在 raw 模式的调用方，排空后仍留在 raw", async () => {
        const stdin = fakeStdin({ isRaw: true });

        await drainPendingInput({ stdin: stdin.stream, maxMs: 30, idleMs: 10 });

        expect(stdin.rawModes).toEqual([true, true]);
    });

    test("非 TTY 不碰 stdin（管道、CI、后台服务都没有队列可排）", async () => {
        const stdin = fakeStdin({ isTTY: false, chunks: ["x"] });

        const discarded = await drainPendingInput({ stdin: stdin.stream });

        expect(discarded).toBe(0);
        expect(stdin.rawModes).toEqual([]);
        expect(stdin.resumeCount).toBe(0);
    });

    test("队列空时等待 idleMs 后返回，不拖到 maxMs", async () => {
        const stdin = fakeStdin({});
        const startedAt = Date.now();

        const discarded = await drainPendingInput({ stdin: stdin.stream, maxMs: 5000, idleMs: 30 });

        expect(discarded).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(1000);
    });
});
