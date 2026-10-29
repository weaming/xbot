/**
 * 就地编辑：平时是纯文字，点一下才变成输入框。
 *
 * 三处共用同一套规则，避免"标题能 Esc 放弃、描述却不能"这种不一致：
 * - Esc：放弃改动并退出（不会因为卸载输入框时那次 blur 又把改动存下去）
 * - Cmd/Ctrl+Enter：提交
 * - 失焦：提交（点了页面别处默认当接受）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

interface InlineEdit {
    editing: boolean;
    draft: string;
    setDraft: (next: string) => void;
    /** 进入编辑态（草稿重置成当前值） */
    begin: () => void;
    /** 提交并退出（值没变就不写） */
    commit: () => void;
    /** 用给定值提交：输入框自己算出了最终值（如目录候选）时用，免得读到还没落到 state 的旧草稿 */
    commitWith: (value: string) => void;
    /** 放弃改动并退出 */
    cancel: () => void;
    /** 编辑态容器必须展开这些事件：失焦提交、Esc 放弃、Cmd/Ctrl+Enter 提交 */
    editorProps: {
        onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
        onKeyDown: (event: ReactKeyboardEvent) => void;
    };
}

export function useInlineEdit(
    current: string,
    save: (next: string) => void | Promise<void>,
    options: {
        /** 外部身份变化（如切换卡片）时强制退出编辑，即使新旧值恰好相同 */
        resetKey?: string;
        /** 单行输入框：裸 Enter 就是"确认并退出"；多行（编辑器）留给 Cmd/Ctrl+Enter */
        commitOnEnter?: boolean;
    } = {},
): InlineEdit {
    const { resetKey, commitOnEnter = false } = options;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(current);
    /** Esc 退出时置位：卸载输入框会派发一次 blur，别让它把刚放弃的改动又提交上去 */
    const skipBlur = useRef(false);

    useEffect(() => {
        setDraft(current);
        setEditing(false);
        skipBlur.current = false;
    }, [resetKey, current]);

    const begin = useCallback(() => {
        skipBlur.current = false;
        setDraft(current);
        setEditing(true);
    }, [current]);

    const cancel = useCallback(() => {
        skipBlur.current = true;
        setDraft(current);
        setEditing(false);
    }, [current]);

    const commitWith = useCallback((raw: string) => {
        // 提交后组件会卸载，随之而来的那次 blur 不该再提交一遍
        skipBlur.current = true;
        setEditing(false);
        const next = raw.trim();
        if (!next) {
            setDraft(current);
            return;
        }
        if (next !== current) void save(next);
    }, [current, save]);

    const commit = useCallback(() => commitWith(draft), [commitWith, draft]);

    const onBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
        // 焦点还在编辑区内部（点工具栏、点候选目录）就不算"离开"，否则点一下按钮就提交了
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        if (skipBlur.current) {
            skipBlur.current = false;
            return;
        }
        commit();
    }, [commit]);

    const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
        if (event.key === "Escape") {
            // 停掉冒泡：否则 window 上那层 Esc 会顺手把整张卡片关掉
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
        }
        if (event.key !== "Enter") return;
        // 单行输入框里 Enter 天生表示"就这个"；多行编辑器仍然要 Cmd/Ctrl+Enter
        if ((commitOnEnter && !event.shiftKey) || event.metaKey || event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
            commit();
        }
    }, [cancel, commit, commitOnEnter]);

    return { editing, draft, setDraft, begin, commit, commitWith, cancel, editorProps: { onBlur, onKeyDown } };
}
