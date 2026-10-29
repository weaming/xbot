/**
 * 终端模式兜底复位。
 *
 * pi-tui 启动时会压入 kitty 键盘协议（`CSI > 7 u`）、开启 bracketed paste、隐藏光标，
 * 正常退出由 `tui.stop()` 还原；强制退出与崩溃路径走不到那里，于是终端被留在
 * kitty 模式里 —— 后续按键都以 `CSI 码;修饰 u` 发出，在命令行里显示成 ^[[108;5u 之类。
 * 这里给进程退出补一刀：未启用 kitty 协议时 pop 是 no-op，重复执行也安全。
 */

import fs from "node:fs";

/**
 * 与 pi-tui 打开的模式一一对应，且都幂等：
 * - `CSI < u`：弹出 kitty 键盘协议栈（`terminal.js` 的 `keyboardProtocolPushed`）
 * - `CSI > 4 ; 0 m`：关 modifyOtherKeys（不支持 kitty 的终端的等价开关）
 * - `CSI ? 7 h`：恢复自动换行（alt screen 会关掉）
 * - 鼠标上报五连（含 `?1004` 焦点上报）：`tui-alt-screen.js` 的 `ENABLE_ALL_MOTION_MOUSE`
 *   会连焦点一起打开，漏掉 `?1004l` 的话切窗口就往日后的 shell 灌 `CSI I` / `CSI O`
 * - `CSI ? 2026 l`：关同步输出，否则半帧退出会让终端一直缓冲、看起来像卡死
 * - `CSI ? 2004 l`：关 bracketed paste
 * - `CSI 0 m` + `CSI ? 25 h`：复位颜色属性、恢复光标
 * 刻意不含 `?1049l`：正常路径已由 `tui.stop()` 切回主屏，重复切缓冲有风险。
 */
const TERMINAL_RESET_SEQUENCE =
    "\x1b[<u\x1b[>4;0m\x1b[?7h"
    + "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l"
    + "\x1b[?2026l\x1b[?2004l\x1b[0m\x1b[?25h";

export interface TerminalResetOptions {
    /** 默认取 `process.stdout.isTTY`；非终端（管道、CI）不发任何字节。 */
    isTTY?: boolean;
    /** 默认直接写 fd 1：退出阶段只有同步写才保证落盘。 */
    write?: (text: string) => void;
}

/** 复位键盘协议栈与鼠标上报、恢复自动换行与光标。 */
export function resetTerminalModes(options: TerminalResetOptions = {}): void {
    if (!(options.isTTY ?? Boolean(process.stdout.isTTY))) return;
    const write = options.write ?? ((text: string): void => {
        fs.writeSync(1, text);
    });
    try {
        write(TERMINAL_RESET_SEQUENCE);
    } catch {
        // 终端已关闭（SSH 断线、窗口被关）：没有可复位的东西
    }
}

let exitGuardInstalled = false;

/** 进程退出兜底：正常返回、`process.exit()`、未捕获异常退出都会触发。 */
export function installTerminalExitGuard(): void {
    if (exitGuardInstalled) return;
    exitGuardInstalled = true;
    process.once("exit", () => resetTerminalModes());
}

/** 排空终端输入队列所需的最小 stdin 接口：抽象出来是为了可测（生产就是 process.stdin）。 */
export interface InputDrainStream {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(mode: boolean): void;
    on(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    off?(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    removeListener?(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    resume?(): void;
    pause?(): void;
}

export interface DrainInputOptions {
    /** 最长总耗时，默认 300ms。 */
    maxMs?: number;
    /** 连续这么久没有新字节就认为队列已空，默认 60ms。 */
    idleMs?: number;
    /** 默认 `process.stdin`。 */
    stdin?: InputDrainStream;
    /** 默认取 `stdin.isTTY`；非终端没有队列可排。 */
    isTTY?: boolean;
}

/**
 * 丢弃 stdin 里已到达但没人读的字节（终端探针回包），返回丢掉的字节数。
 *
 * 终端对 `CSI c`（设备属性）、`OSC 11`（背景色）、`CSI 6n`（光标位置）这类查询的回包
 * 若在程序退出时仍留在输入队列里，shell 恢复后会把它们当输入回显成一串 `^[[?62;22;52c`。
 * 队列在 canonical 模式下要等到换行才可读，所以先切 raw 再读，读完复原。
 */
export async function drainPendingInput(options: DrainInputOptions = {}): Promise<number> {
    const stdin = options.stdin ?? (process.stdin as unknown as InputDrainStream);
    if (!(options.isTTY ?? Boolean(stdin.isTTY))) return 0;

    const maxMs = options.maxMs ?? 300;
    const idleMs = options.idleMs ?? 60;
    const wasRaw = Boolean(stdin.isRaw);
    let lastDataAt = Date.now();
    let discarded = 0;

    const onData = (chunk?: { length?: number }): void => {
        discarded += chunk?.length ?? 0;
        lastDataAt = Date.now();
    };

    try {
        stdin.setRawMode?.(true);
        stdin.on("data", onData);
        stdin.resume?.();
        const deadline = lastDataAt + maxMs;
        while (Date.now() - lastDataAt < idleMs && Date.now() < deadline) {
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(idleMs, 10)));
        }
    } catch {
        // stdin 已关闭（管道断开、SSH 掉线）：没有队列可排
    } finally {
        if (stdin.off) stdin.off("data", onData);
        else stdin.removeListener?.("data", onData);
        stdin.pause?.();
        try {
            stdin.setRawMode?.(wasRaw);
        } catch {
            // 终端已关闭：无人可复原
        }
    }
    return discarded;
}
