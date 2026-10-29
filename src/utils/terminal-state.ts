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
 * - 鼠标上报四连 + `?1006`：关掉 SGR 鼠标模式，否则鼠标一动就往 shell 灌坐标
 * - `CSI ? 2004 l`：关 bracketed paste
 * - `CSI ? 25 h`：恢复光标
 * 刻意不含 `?1049l`：正常路径已由 `tui.stop()` 切回主屏，重复切缓冲有风险。
 */
const TERMINAL_RESET_SEQUENCE =
    "\x1b[<u\x1b[>4;0m\x1b[?7h\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l\x1b[?2004l\x1b[?25h";

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
