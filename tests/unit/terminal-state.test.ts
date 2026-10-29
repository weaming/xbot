import { describe, expect, test } from "bun:test";
import { installTerminalExitGuard, resetTerminalModes } from "../../src/utils/terminal-state.js";

describe("resetTerminalModes", () => {
    test("TTY 下复位键盘协议、鼠标上报、自动换行、bracketed paste 与光标", () => {
        const written: string[] = [];

        resetTerminalModes({ isTTY: true, write: text => written.push(text) });

        expect(written).toEqual([
            "\x1b[<u"        // 弹出 kitty 键盘协议栈
            + "\x1b[>4;0m"   // 关 modifyOtherKeys
            + "\x1b[?7h"     // 恢复自动换行
            + "\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l" // 关鼠标上报
            + "\x1b[?2004l"  // 关 bracketed paste
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
