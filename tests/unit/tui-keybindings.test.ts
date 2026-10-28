/**
 * 全局快捷键单测：用假 host 驱动键位表，验证分支与副作用。
 * 注意：pi-tui 的 `matchesKey` 比较的是终端原始序列，不是 `Key.xxx` 描述符，
 * 因此这里统一用真实转义序列（legacy 控制字符 / kitty CSI-u）。
 */

import { describe, expect, test } from "bun:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { bindGlobalKeys, type GlobalKeyHost } from "../../src/tui/keybindings.js";

/** 常用按键的原始序列。 */
const K = {
    ctrlP: "\x10",
    superP: "\x1b[112;9u",
    ctrlT: "\x14",
    ctrlN: "\x0e",
    ctrlD: "\x04",
    ctrlX: "\x18",
    ctrlC: "\x03",
    ctrlB: "\x02",
    ctrlO: "\x0f",
    ctrlU: "\x15",
    ctrlRightBracket: "\x1d",
    f1: "\x1bOP",
    esc: "\x1b",
    altUp: "\x1b[1;3A",
    altBackspace: "\x1b\x7f",
    /** kitty CSI-u：Ctrl+2 */
    ctrl2: "\x1b[50;5u",
} as const;

interface Setup {
    calls: string[];
    send: (data: string) => unknown;
    runConfirm: () => void;
}

function setup(overrides: Partial<GlobalKeyHost> = {}): Setup {
    const calls: string[] = [];
    let confirmRun: (() => void) | undefined;

    const host: GlobalKeyHost = {
        handlePanelInput: () => false,
        isRenaming: () => false,
        cancelRename: () => calls.push("cancelRename"),
        openSessionPanel: () => calls.push("openSessionPanel"),
        openTodoPanel: () => calls.push("openTodoPanel"),
        openShortcutPanel: () => calls.push("openShortcutPanel"),
        continueCurrent: () => calls.push("continueCurrent"),
        editorText: () => "",
        pendingCount: () => 0,
        pendingIndex: () => 0,
        setPendingIndex: (index) => calls.push(`setPendingIndex:${index}`),
        renderPending: () => calls.push("renderPending"),
        deletePending: (index) => calls.push(`deletePending:${index}`),
        isDetailed: () => false,
        scrollPage: (direction) => calls.push(`scrollPage:${direction}`),
        requestExitWithConfirm: (label) => calls.push(`requestExitWithConfirm:${label}`),
        newSession: () => calls.push("newSession"),
        requestConfirm: (label, run) => {
            calls.push(`requestConfirm:${label}`);
            confirmRun = run;
        },
        requireSession: () => true,
        deleteCurrentSession: () => calls.push("deleteCurrentSession"),
        selectSessionTab: (index) => calls.push(`selectSessionTab:${index}`),
        renameCurrentSession: () => calls.push("renameCurrentSession"),
        toggleDetailed: () => calls.push("toggleDetailed"),
        switchSession: (delta, includeArchived) => calls.push(`switchSession:${delta}:${includeArchived}`),
        isInterruptible: () => false,
        detachCurrentWork: () => {
            calls.push("detachCurrentWork");
            return false;
        },
        isCurrentBusy: () => false,
        abortCurrent: () => calls.push("abortCurrent"),
        flash: (text) => calls.push(`flash:${text}`),
        ...overrides,
    };

    const listeners: Array<(data: string) => unknown> = [];
    bindGlobalKeys({ addInputListener: (cb: (data: string) => unknown) => { listeners.push(cb); } } as any, host);

    return {
        calls,
        send: (data: string) => listeners[0](data),
        runConfirm: () => confirmRun?.(),
    };
}

describe("全局快捷键", () => {
    test("面板打开时独占键盘输入，不再触发全局键", () => {
        const { calls, send } = setup({ handlePanelInput: () => true });

        expect(send(K.ctrlT)).toEqual({ consume: true });
        expect(calls).not.toContain("openTodoPanel");
    });

    test("面板打开时将 Kitty 长按重复事件交给面板，松开事件不触发面板", () => {
        const received: string[] = [];
        const { send } = setup({ handlePanelInput: data => { received.push(data); return true; } });

        setKittyProtocolActive(true);
        try {
            const downRepeat = "\x1b[1;1:2B";
            const downRelease = "\x1b[1;1:3B";

            expect(send(downRepeat)).toEqual({ consume: true });
            expect(send(downRelease)).toBeUndefined();
            expect(received).toEqual([downRepeat]);
        } finally {
            setKittyProtocolActive(false);
        }
    });

    test("面板 / 会话 / 清单快捷键", () => {
        const { calls, send } = setup();

        send(K.ctrlP);
        send(K.superP);
        send(K.ctrlT);
        send(K.f1);
        send(K.ctrlN);

        expect(calls).toContain("openSessionPanel");
        expect(calls).toContain("openTodoPanel");
        expect(calls).toContain("openShortcutPanel");
        expect(calls).toContain("newSession");
    });

    test("Ctrl+D 请求退出确认", () => {
        const { calls, send } = setup();

        expect(send(K.ctrlD)).toEqual({ consume: true });
        expect(calls).toContain("requestExitWithConfirm:⌃D");
    });

    test("Ctrl+X：输入框为空才触发二次确认，确认后删除会话", () => {
        const empty = setup();
        empty.send(K.ctrlX);
        expect(empty.calls).toContain("requestConfirm:⌃X");
        empty.runConfirm();
        expect(empty.calls).toContain("deleteCurrentSession");

        const typing = setup({ editorText: () => "正在输入" });
        expect(typing.send(K.ctrlX)).toBeUndefined();
        expect(typing.calls).not.toContain("requestConfirm:⌃X");
    });

    test("Ctrl+C：空闲放行并提示，忙碌时中止", () => {
        const idle = setup();
        expect(idle.send(K.ctrlC)).toBeUndefined();
        expect(idle.calls).toContain("flash:⌃D 退出");

        const busy = setup({ isInterruptible: () => true });
        expect(busy.send(K.ctrlC)).toEqual({ consume: true });
        expect(busy.calls).toContain("abortCurrent");
    });

    test("Ctrl+B：有后台工作时消费，没有时交回输入框", () => {
        const waiting = setup({ detachCurrentWork: () => true });
        expect(waiting.send(K.ctrlB)).toEqual({ consume: true });

        const idle = setup();
        expect(idle.send(K.ctrlB)).toBeUndefined();
        expect(idle.calls).toContain("detachCurrentWork");
    });

    test("Ctrl+1..9 选中对应会话 tab", () => {
        const { calls, send } = setup();

        send(K.ctrl2);
        expect(calls).toContain("selectSessionTab:1");
    });

    test("重命名态：Esc 取消重命名，其它全局键放行给输入框", () => {
        const { calls, send } = setup({ isRenaming: () => true });

        expect(send(K.ctrlT)).toBeUndefined();
        expect(calls).not.toContain("openTodoPanel");

        expect(send(K.esc)).toEqual({ consume: true });
        expect(calls).toContain("cancelRename");
    });

    test("Esc 忙碌时中止生成", () => {
        const { calls, send } = setup({ isCurrentBusy: () => true });

        expect(send(K.esc)).toEqual({ consume: true });
        expect(calls).toContain("abortCurrent");
    });

    test("pending 队列导航：⌥↑ / ⌥Backspace", () => {
        const { calls, send } = setup({
            pendingCount: () => 3,
            pendingIndex: () => 0,
        });

        send(K.altUp);
        expect(calls).toContain("setPendingIndex:2");
        expect(calls).toContain("renderPending");

        send(K.altBackspace);
        expect(calls).toContain("deletePending:0");
    });

    test("展开模式翻页与会话切换", () => {
        const { calls, send } = setup({ isDetailed: () => true });

        send(K.ctrlU);
        expect(calls).toContain("scrollPage:-1");

        send(K.ctrlRightBracket);
        expect(calls).toContain("switchSession:1:undefined");
    });
});
