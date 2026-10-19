/**
 * 全局快捷键：面板独占、重命名态、会话切换、退出确认等。
 * 只依赖 GlobalKeyHost 暴露的语义操作，不直接摸 ChatApp 内部状态；
 * 键位与分支集中在此，避免散落在 app.ts 的上帝类里。
 */

import {
    isKeyRelease,
    isKeyRepeat,
    isKittyProtocolActive,
    Key,
    matchesKey,
} from "@earendil-works/pi-tui";
import type { TuiAltScreen } from "@earendil-works/pi-tui";
import { SESSION_SHORTCUTS } from "./slash-commands.js";

/** kitty 协议下 release/repeat 事件不触发全局快捷键（一次按键会收到多个事件）。 */
function isKittyRepeatOrRelease(data: string): boolean {
    if (isKittyProtocolActive()) {
        return isKeyRelease(data) || isKeyRepeat(data);
    }

    const match = data.match(/^\x1b\[27;\d+;\d+;(\d)~$/);
    if (!match) return false;
    const eventType = Number(match[1]);
    return eventType === 1 || eventType === 2;
}

/**
 * 快捷键面板的打开键：Ctrl+/（kitty 协议 CSI-u）与 F1。
 * 不匹配 legacy 的 0x1f——它同时等于 Ctrl+-，会遮蔽编辑器的撤销。
 */
function isShortcutPanelKey(data: string): boolean {
    return matchesKey(data, Key.ctrl("/")) || matchesKey(data, Key.f1);
}

/**
 * 全局键位需要的宿主能力。
 * 刻意收窄成语义操作（而不是暴露 ChatApp 全部字段），让键位表可单测。
 */
export interface GlobalKeyHost {
    /** 浮层面板打开时独占键盘输入；返回 true 表示已消费。 */
    handlePanelInput(data: string): boolean;
    /** 是否处于标题重命名态（除 Esc 外不响应全局键）。 */
    isRenaming(): boolean;
    cancelRename(): void;
    openSessionPanel(): void;
    openTodoPanel(): void;
    openShortcutPanel(): void;
    toggleQuestionPanel(): void;
    continueCurrent(): void;
    /** 输入框内容。 */
    editorText(): string;
    /** pending 队列长度与选中索引。 */
    pendingCount(): number;
    pendingIndex(): number;
    setPendingIndex(index: number): void;
    renderPending(): void;
    deletePending(index: number): void;
    isDetailed(): boolean;
    /** 展开模式下翻页（direction: -1 上翻 / 1 下翻）。 */
    scrollPage(direction: number): void;
    requestExitWithConfirm(label: string): void;
    newSession(): void;
    requestConfirm(label: string, run: () => void): void;
    requireSession(): boolean;
    deleteCurrentSession(): void;
    /** Ctrl+1..9：选中会话条上第 N 个可见 tab（0-based）。 */
    selectSessionTab(index: number): void;
    /** ⌘R：重命名当前会话标题。 */
    renameCurrentSession(): void;
    toggleDetailed(): void;
    switchSession(delta: number, includeArchived?: boolean): void;
    /** Ctrl+C 的中止判定：忙碌且未被其他实例锁定。 */
    isInterruptible(): boolean;
    /**
     * ⌃B：优先把当前 shell 命令放入后台，其次把会话间结果等待放入后台。
     * 返回 false 表示没有可放后台的工作，按键交回输入框（那里 ⌃B 是左移一个字符）。
     */
    detachCurrentWork(): boolean;
    /** Esc 的中止判定：忙碌即中止。 */
    isCurrentBusy(): boolean;
    abortCurrent(): void;
    flash(text: string): void;
}

/** 注册全局快捷键监听。 */
export function bindGlobalKeys(tui: TuiAltScreen, host: GlobalKeyHost): void {
    tui.addInputListener((data) => {
        // 调试日志（写文件，避免污染 AltScreen 屏幕）：排查终端重复发送
        // kitty 协议编码的 release(;1~) / repeat(;2~) 事件不触发全局快捷键（一次按键两个事件）
        if (isKittyRepeatOrRelease(data)) return undefined;

        // 浮层面板打开时独占键盘输入；鼠标滚轮只在面板矩形内生效（面板外滚动不动面板）
        if (host.handlePanelInput(data)) return { consume: true };

        if (matchesKey(data, Key.ctrlShift("q"))) {
            host.toggleQuestionPanel();
            return { consume: true };
        }

        // 标题重命名态：除 Esc（取消重命名）外不响应全局快捷键，按键交给输入框
        if (host.isRenaming() && !matchesKey(data, Key.escape)) return undefined;

        // ⌘P / Ctrl+P：打开会话面板（⌘P 为主，Ctrl+P 兼作非 kitty 协议终端兜底）
        if (matchesKey(data, Key.super("p")) || matchesKey(data, Key.ctrl("p"))) {
            host.openSessionPanel();
            return { consume: true };
        }

        // Ctrl+T：切换任务清单面板
        if (matchesKey(data, Key.ctrl("t"))) {
            host.openTodoPanel();
            return { consume: true };
        }

        // Ctrl+/ / F1：打开快捷键面板
        if (isShortcutPanelKey(data)) {
            host.openShortcutPanel();
            return { consume: true };
        }

        // ⌥+Enter：等同于 /continue（kitty CSI-u 与 legacy \x1b\r 均识别）
        if (matchesKey(data, Key.alt("enter"))) {
            host.continueCurrent();
            return { consume: true };
        }

        // ⌃B：优先把运行中的 shell 放入后台，其次把会话间等待放入后台；没有工作就交回输入框
        if (matchesKey(data, Key.ctrl("b")) && host.detachCurrentWork()) return { consume: true };

        // pending 队列导航：输入框为空且队列非空时拦截 ↑/↓/Backspace。
        if (host.editorText() === "" && host.pendingCount() > 0) {
            const count = host.pendingCount();
            if (matchesKey(data, Key.alt("up"))) {
                host.setPendingIndex((host.pendingIndex() - 1 + count) % count);
                host.renderPending();
                return { consume: true };
            }
            if (matchesKey(data, Key.alt("down"))) {
                host.setPendingIndex((host.pendingIndex() + 1) % count);
                host.renderPending();
                return { consume: true };
            }
            if (matchesKey(data, Key.alt("backspace"))) {
                host.deletePending(host.pendingIndex());
                return { consume: true };
            }
        }

        // ⌃O 展开模式：⌃U / ⌃D 翻页（优先于退出与编辑器的删除键）
        if (host.isDetailed() && (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d")))) {
            host.scrollPage(matchesKey(data, Key.ctrl("u")) ? -1 : 1);
            return { consume: true };
        }

        if (matchesKey(data, Key.ctrl("d"))) {
            host.requestExitWithConfirm("⌃D");
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("n"))) {
            host.newSession();
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("x"))) {
            // 输入框有内容时不响应：避免打字中误触删除会话的二次确认，按键交给输入框
            if (host.editorText() !== "") return undefined;
            // 删除会话不可逆：2 秒内再按一次才执行
            host.requestConfirm("⌃X", () => {
                if (host.requireSession()) host.deleteCurrentSession();
            });
            return { consume: true };
        }
        const sessionIndex = SESSION_SHORTCUTS.findIndex((shortcut) => matchesKey(data, shortcut));
        if (sessionIndex >= 0) {
            host.selectSessionTab(sessionIndex);
            return { consume: true };
        }
        if (matchesKey(data, Key.super("r"))) {
            // ⌘R：重命名当前会话标题（⌃R 让给输入框的历史搜索）
            host.renameCurrentSession();
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("o"))) {
            host.toggleDetailed();
            return { consume: true };
        }
        // legacy 终端里 Ctrl+[ 与 ESC 同为 0x1b：排除 Esc，避免按 Esc 时误切会话
        if (matchesKey(data, Key.ctrl(Key.leftbracket)) && !matchesKey(data, Key.escape)) {
            host.switchSession(-1);
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl(Key.rightbracket))) {
            host.switchSession(1);
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrlShift(Key.leftbracket))) {
            host.switchSession(-1, true);
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrlShift(Key.rightbracket))) {
            host.switchSession(1, true);
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("c"))) {
            // 仅用于中止生成；空闲时放行给输入框（选择即复制由终端负责）
            if (host.isInterruptible()) {
                host.abortCurrent();
                return { consume: true };
            }
            // 空闲时放行给编辑器，并提示退出键（选择即复制由终端负责，与 ⌃C 无关）
            host.flash("⌃D 退出");
            return undefined;
        }
        if (matchesKey(data, Key.escape)) {
            // Esc：生成中中止当前 turn；空闲时放行（Editor 处理弹窗取消等）
            if (host.isRenaming()) {
                host.cancelRename();
                return { consume: true };
            }
            if (host.isCurrentBusy()) {
                host.abortCurrent();
                return { consume: true };
            }
            return undefined;
        }
        return undefined;
    });
}
