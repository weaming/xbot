/**
 * 输入框组件：左侧 ❯ 提示符（前缀占 2 列，渲染宽度相应缩减）。
 * 负责 bracketed paste 汇总、会话级 paste 缓存、补全弹窗探测与 Enter 提交。
 */

import {
    Editor,
    getKeybindings,
    Key,
    matchesKey,
    stripTerminalSequences,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { PasteAssembler, SessionPasteStore } from "./paste-assembler.js";
import { isValidSlashCommand } from "./slash-commands.js";
import { theme } from "./theme.js";
import type { ImageAssetRef } from "../types/image.js";
import { createImageAsset } from "../utils/image-assets.js";
import { readMacOSClipboardImage } from "../utils/macos-clipboard.js";

function isPromptBorder(line: string): boolean {
    const clean = stripTerminalSequences(line).trim();
    if (!clean.includes("─")) return false;
    if (/^[─\s]+$/.test(clean)) return true;
    if (/^─+\s*[↑↓]\s*\d+\s+more\s+─+$/.test(clean)) return true;
    return false;
}

/** 判断当前平台用于图片粘贴的快捷键。 */
export function isClipboardPasteKey(data: string, platform: string = process.platform): boolean {
    const pasteKey = platform === "darwin" ? Key.super("v") : Key.ctrl("v");
    return matchesKey(data, pasteKey);
}

export class PromptEditor extends Editor {
    /** 汇总分片/交错到达的 bracketed paste，保证编辑器只收到完整序列。 */
    private readonly pasteAssembler = new PasteAssembler();
    /** 会话级 paste 缓存：marker 内容绑定会话，切回时恢复展开正确。 */
    private readonly sessionPastes = new SessionPasteStore();
    private sessionId: string | null = null;
    private imageAttachments: ImageAssetRef[] = [];
    private readonly sessionImages = new Map<string, ImageAssetRef[]>();

    /** 带图片的提交回调；无图片时仍走同一条回调。 */
    onSubmitWithImages?: (text: string, images: ImageAssetRef[]) => void;
    /** 图片附件变化时通知宿主保存草稿。 */
    onImagesChanged?: () => void;

    private autocompleteVisible = false;
    private isCompact = false;
    private isReadOnly = false;
    private renaming = false;

    /** 会话标题重命名输入模式：前缀 ✎ 提示；回车提交仍走 onSubmit。 */
    setRenaming(renaming: boolean): void {
        if (this.renaming === renaming) return;
        this.renaming = renaming;
        this.tui.requestRender();
    }

    setCompact(isCompact: boolean): void {
        this.isCompact = isCompact;
    }

    setReadOnly(isReadOnly: boolean): void {
        if (this.isReadOnly === isReadOnly) return;
        this.isReadOnly = isReadOnly;
        this.tui.requestRender();
    }

    /** 切换会话上下文：切走保存本会话 paste 缓存，切入恢复（保持 marker 展开正确）。 */
    setSessionContext(sessionId: string | null): void {
        if (this.sessionId === sessionId) return;
        if (this.sessionId) {
            const editor = this as unknown as { pastes?: Map<number, string> };
            this.sessionPastes.save(this.sessionId, editor.pastes);
            this.sessionImages.set(this.sessionId, [...this.imageAttachments]);
        }
        this.sessionId = sessionId;
        if (sessionId) {
            const editor = this as unknown as { pastes?: Map<number, string>; pasteCounter: number };
            const counter = { value: editor.pasteCounter };
            if (this.sessionPastes.restore(sessionId, editor.pastes, counter)) {
                editor.pasteCounter = counter.value;
            }
            this.imageAttachments = [...(this.sessionImages.get(sessionId) ?? [])];
        } else {
            this.imageAttachments = [];
        }
        this.onImagesChanged?.();
        this.tui.requestRender();
    }

    /** 会话删除/归档时清理其 paste 缓存。 */
    clearSessionPastes(sessionId: string): void {
        this.sessionPastes.clear(sessionId);
        this.sessionImages.delete(sessionId);
    }

    getImageAttachments(): ImageAssetRef[] {
        return [...this.imageAttachments];
    }

    setImageAttachments(images: ImageAssetRef[]): void {
        this.imageAttachments = [...images];
        this.onImagesChanged?.();
        this.tui.requestRender();
    }

    takeImageAttachments(): ImageAssetRef[] {
        const images = this.getImageAttachments();
        this.imageAttachments = [];
        this.onImagesChanged?.();
        return images;
    }

    /**
     * 展开某会话草稿里的 paste marker 为原文：草稿落盘用。
     * 重启后内存里没有 pastes 缓存，只有 marker 的话内容就还原不出来了。
     */
    expandSessionDraft(sessionId: string, text: string): string {
        if (!text.includes("[paste #")) return text;
        const editor = this as unknown as { pastes?: Map<number, string> };
        const pastes = sessionId === this.sessionId ? editor.pastes : this.sessionPastes.get(sessionId);
        if (!pastes || pastes.size === 0) return text;
        return text.replace(/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g, (match, id: string) =>
            pastes.get(Number(id)) ?? match);
    }

    /**
     * setText 本身会清空库的 pastes Map；若恢复的草稿含 marker（跨会话），
     * 需把该会话缓存的 paste 内容灌回 Map 与计数器，保证提交展开正确。
     */
    override setText(text: string): void {
        super.setText(text);
        if (this.sessionId && text.includes("[paste #")) {
            const editor = this as unknown as { pastes?: Map<number, string>; pasteCounter: number };
            const counter = { value: editor.pasteCounter };
            if (this.sessionPastes.restore(this.sessionId, editor.pastes, counter)) {
                editor.pasteCounter = counter.value;
            }
        }
    }

    render(width: number): string[] {
        const lines = super.render(Math.max(width - 2, 20));
        if (this.isCompact) {
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                if (isPromptBorder(lines[index])) return [lines[index] + "  "];
            }
            return [];
        }

        // 探测补全弹窗（弹窗行渲染在下边框之后，从后往前找；边框是整行横线，避免误判内容行）
        let borderIndex = -1;
        for (let index = lines.length - 1; index >= 0; index--) {
            if (isPromptBorder(lines[index])) {
                borderIndex = index;
                break;
            }
        }
        this.autocompleteVisible = borderIndex >= 0
            && lines.slice(borderIndex + 1).some(line => stripTerminalSequences(line).trim().length > 0);

        let firstContent = true;
        const isValidCommand = isValidSlashCommand(this.getExpandedText());
        const result = lines.map((line, index) => {
            // 边框行由整行横线组成；空内容行（strip 后为空格）不得误判，
            // 内容中偶发的 ─ 字符（如下划线装饰）也不再被当作边框。
            const isBorder = isPromptBorder(line);
            if (isBorder) return line + "  ";  // 横线从列 0 起，补到全宽
            const prefix = firstContent ? (this.renaming ? theme.commandText("✎ ") : theme.user("❯ ")) : "  ";
            firstContent = false;
            const isEditorContent = borderIndex < 0 || index < borderIndex;
            if (this.isReadOnly && isEditorContent && this.getText().length === 0) {
                const placeholder = theme.dim("已归档会话");
                const padding = " ".repeat(Math.max(0, visibleWidth(line) - visibleWidth(placeholder)));
                return prefix + placeholder + padding;
            }
            let content = isValidCommand && isEditorContent ? theme.commandText(line) : line;
            if (firstContent === false && index === 0 && this.imageAttachments.length > 0) {
                const labels = this.imageAttachments.map(image => `🖼 ${image.filename}`).join("  ");
                content += ` ${theme.dim(labels)}`;
            }
            return prefix + content;
        });

        return result;
    }

    handleInput(data: string): void {
        if (this.isReadOnly) return;
        for (const sequence of this.pasteAssembler.push(data)) {
            this.handleInputSequence(sequence);
        }
    }

    private handleInputSequence(data: string): void {
        if (isClipboardPasteKey(data)) {
            const clipboardImage = readMacOSClipboardImage();
            if (clipboardImage) {
                void this.attachClipboardImage(clipboardImage);
                return;
            }
        }

        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            // 补全弹窗激活时 ↑/↓ 用于移动选中项（super 的 select 分支），不调整光标
            if (this.autocompleteVisible) {
                super.handleInput(data);
                return;
            }

            const editor = this as unknown as {
                state: { lines: string[]; cursorLine: number; cursorCol: number };
                moveCursor: (deltaLine: number, deltaCol: number) => void;
                setCursorCol: (col: number) => void;
            };
            const { lines, cursorLine, cursorCol } = editor.state;
            const hasContent = lines.length > 1 || (lines[0]?.length ?? 0) > 0;
            const hasMultipleLines = lines.length > 1;
            const lastLineIndex = lines.length - 1;
            const isAtEnd = cursorLine === lastLineIndex && cursorCol >= (lines[lastLineIndex]?.length ?? 0);

            // 输入框有内容，且光标不在末尾，且有多行时：上下箭头在多行之间移动光标
            if (hasContent && !isAtEnd && hasMultipleLines) {
                const delta = matchesKey(data, Key.up) ? -1 : 1;
                editor.moveCursor(delta, 0);
                this.tui.requestRender();
                return;
            }

            super.handleInput(data);
            // 历史浏览时把光标移到整段文字末尾（库默认 ↑ 时光标在行首）
            const historyLastLineIndex = editor.state.lines.length - 1;
            const cursorLineDelta = historyLastLineIndex - editor.state.cursorLine;
            editor.moveCursor(cursorLineDelta, 0);
            editor.setCursorCol(editor.state.lines[historyLastLineIndex]?.length ?? 0);
            return;
        }
        if (matchesKey(data, Key.enter)) {
            if (this.autocompleteVisible) {
                // 弹窗激活：Enter = 填入（super 的 tab 分支，不发送）
                super.handleInput(data);
                return;
            }
            // 非弹窗：Enter = 提交（绕过库内 tab 分支对 enter 的误吞）
            const text = this.getExpandedText().trim();
            if (text || this.imageAttachments.length > 0) {
                // 诊断：记录提交内容特征，排查粘贴内容丢失/错位（tui.log）。
                const markerResidue = (text.match(/\[paste #\d+/g) ?? []).length;
                console.log(
                    `[TUI] submit text length=${text.length} `
                    + `pasteMarkerResidue=${markerResidue} lines=${text.split("\n").length}`,
                );
                const images = this.takeImageAttachments();
                this.setText("");
                this.onSubmitWithImages?.(text, images);
                if (!this.onSubmitWithImages) this.onSubmit?.(text);
            }
            return;
        }
        const kb = getKeybindings();
        const killDelete =
            kb.matches(data, "tui.editor.deleteToLineStart")
            || kb.matches(data, "tui.editor.deleteToLineEnd")
            || kb.matches(data, "tui.editor.deleteWordBackward")
            || kb.matches(data, "tui.editor.deleteWordForward");
        super.handleInput(data);
        // kill 类删除（Ctrl+U/K/W 等）后库内不会像 backspace 那样同步补全弹窗：
        // 输入被清空、或命令前缀 / 被删掉时，命令提示仍停留在删除前的匹配项上。
        if (killDelete) this.reconcileAutocompleteAfterKillDelete();
    }

    private async attachClipboardImage(data: Buffer): Promise<void> {
        const tui = this.tui as unknown as { flash?: (text: string) => void };
        try {
            const image = await createImageAsset(data, "clipboard.jpg");
            this.imageAttachments.push(image);
            this.onImagesChanged?.();
            this.tui.requestRender();
            tui.flash?.(`🖼 已粘贴图片（${Math.round(image.sizeBytes / 1024)} KiB）`);
        } catch (error: any) {
            tui.flash?.(`⚠️ 图片粘贴失败：${error?.message ?? error}`);
        }
    }

    /** 兜底：输入清空 / 脱离命令语境后收起残留的命令提示弹窗，仍在命令内则异步重查收敛匹配。 */
    private reconcileAutocompleteAfterKillDelete(): void {
        const editor = this as unknown as {
            autocompleteState: string | null;
            cancelAutocomplete: () => void;
            updateAutocomplete: () => void;
        };
        if (!editor.autocompleteState) return;
        const text = this.getText();
        if (text === "" || !text.trimStart().startsWith("/")) {
            editor.cancelAutocomplete();
        } else {
            editor.updateAutocomplete();
        }
        this.tui.requestRender();
    }

    /** 恢复持久化的输入历史（Editor 的 history 为私有字段，类型逃逸设置）。 */
    setHistory(entries: string[]): void {
        const editor = this as unknown as {
            history: string[];
            historyIndex: number;
            historyDraft: unknown;
        };
        editor.history = [...entries];
        editor.historyIndex = -1;
        editor.historyDraft = null;
    }
}
