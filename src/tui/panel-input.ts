/**
 * 浮层面板的鼠标输入解析：SGR 滚轮序列 → 滚动行数与鼠标坐标（0-based）。
 * 浮层聚焦时 TuiAltScreen 不消费滚轮事件，会透传给 ChatApp 的全局输入监听，
 * 再由 ChatApp 按坐标过滤（面板外滚动不动面板）后交给面板的 handleInput。
 */

/** 一次滚轮事件滚动的行数。 */
const WHEEL_LINES = 3;

export interface WheelEvent {
    /** 滚动行数（向上为负）。 */
    delta: number;
    /** 鼠标列（0-based）。 */
    x: number;
    /** 鼠标行（0-based）。 */
    y: number;
}

/** 解析 SGR 鼠标滚轮序列（含坐标）；非滚轮事件返回 undefined。 */
export function parseWheelEvent(data: string): WheelEvent | undefined {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
    if (match) {
        const button = Number.parseInt(match[1], 10);
        const direction = button & 3;
        if ((button & 64) === 0 || (direction !== 0 && direction !== 1)) return undefined;
        return {
            delta: direction === 0 ? -WHEEL_LINES : WHEEL_LINES,
            x: Number.parseInt(match[2], 10) - 1,
            y: Number.parseInt(match[3], 10) - 1,
        };
    }

    // X10 编码（ESC [ M Cb Cx Cy，各字节 +32）：部分终端 / tmux 在未启用 SGR 时使用
    if (data.length === 6 && data.startsWith("\x1b[M")) {
        const button = data.charCodeAt(3) - 32;
        const direction = button & 3;
        if ((button & 64) === 0 || (direction !== 0 && direction !== 1)) return undefined;
        return {
            delta: direction === 0 ? -WHEEL_LINES : WHEEL_LINES,
            x: data.charCodeAt(4) - 33,
            y: data.charCodeAt(5) - 33,
        };
    }

    return undefined;
}

/** 解析滚轮滚动行数；非滚轮事件返回 undefined。 */
export function parseWheelDelta(data: string): number | undefined {
    return parseWheelEvent(data)?.delta;
}
