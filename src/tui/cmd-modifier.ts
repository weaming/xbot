/**
 * macOS Cmd 键按住状态检测（原生查询方案）。
 *
 * 背景：SGR 鼠标事件无 Cmd 位（仅 Shift/Alt/Ctrl）；Ghostty 在 mouse-reporting 下
 * 会把 Cmd+Click 事件转发给应用，但 Cmd 修饰信息无处编码、随转发丢失，应用收到的
 * 点击与普通单击不可区分。因此在点击回调（mouse release）时主动查询全局修饰键状态：
 * CoreGraphics CGEventSourceFlagsState 无需辅助功能权限即可实时反映 Cmd 是否按住。
 *
 * 仅 darwin 生效；其他平台或加载失败时 isCmdDown() 恒 false。
 */

import { dlopen, FFIType } from "bun:ffi";

/** kCGEventFlagMaskCommand */
const CMD_MASK = 0x100000n;
/** kCGEventSourceStateCombinedSessionState */
const COMBINED_SESSION_STATE = 0;
/** CoreGraphics framework 的 dyld 路径（macOS 全版本一致）。 */
const CG_FRAMEWORK_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";

type FlagsStateFn = (stateId: number) => bigint;

let flagsStateFn: FlagsStateFn | null | undefined;
let loadFailed = false;

function getFlagsStateFn(): FlagsStateFn | null {
    if (loadFailed) return null;
    if (flagsStateFn !== undefined) return flagsStateFn;
    try {
        const lib = dlopen(CG_FRAMEWORK_PATH, {
            CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u64 },
        });
        flagsStateFn = lib.symbols.CGEventSourceFlagsState as unknown as FlagsStateFn;
    } catch (err) {
        loadFailed = true;
        console.warn("[TUI] load CGEventSourceFlagsState failed:", err);
    }
    return flagsStateFn ?? null;
}

/** 当前是否按住 Cmd（macOS）。其他平台恒 false，加载失败也返回 false。 */
export function isCmdDown(): boolean {
    if (process.platform !== "darwin") return false;
    const fn = getFlagsStateFn();
    if (!fn) return false;
    try {
        return (fn(COMBINED_SESSION_STATE) & CMD_MASK) !== 0n;
    } catch {
        return false;
    }
}

/** 是否启用 Cmd 门控（macOS 且原生查询可用）。 */
export function isCmdGateSupported(): boolean {
    return process.platform === "darwin" && getFlagsStateFn() !== null;
}
