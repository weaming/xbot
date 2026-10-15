/**
 * 浮层面板的滚动键统一处理：↑↓ 与 j/k 滚动一行，PgUp / PgDn / ⌃U / ⌃D 翻页，滚轮滚动。
 * 三个面板共用同一份键位，避免行为漂移；调用方决定滚动落点，并可按场景关闭 jk / ⌃U
 * （会话面板里 j/k 用于搜索输入、⌃U 用于清空搜索）。
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { parseWheelDelta } from "./panel-input.js";

export interface PanelScrollOptions {
    /** 翻页行数（通常为面板一次可见的行数）。 */
    pageSize: number;
    /** 执行滚动（负值向上）。 */
    scrollBy(delta: number): void;
    /** 是否支持 j / k 滚动（默认支持）。 */
    vimKeys?: boolean;
    /** 是否支持 ⌃U 上翻页（默认支持）。 */
    ctrlU?: boolean;
}

/** 命中滚动键则执行并返回 true；未命中返回 false，由调用方继续处理。 */
export function handlePanelScroll(data: string, options: PanelScrollOptions): boolean {
    const { pageSize, scrollBy } = options;
    const vimKeys = options.vimKeys ?? true;
    const ctrlU = options.ctrlU ?? true;

    const wheel = parseWheelDelta(data);
    if (wheel !== undefined) {
        scrollBy(wheel);
        return true;
    }
    if (matchesKey(data, Key.up) || (vimKeys && data === "k")) {
        scrollBy(-1);
        return true;
    }
    if (matchesKey(data, Key.down) || (vimKeys && data === "j")) {
        scrollBy(1);
        return true;
    }
    if (matchesKey(data, Key.pageUp) || (ctrlU && matchesKey(data, Key.ctrl("u")))) {
        scrollBy(-pageSize);
        return true;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
        scrollBy(pageSize);
        return true;
    }
    return false;
}
