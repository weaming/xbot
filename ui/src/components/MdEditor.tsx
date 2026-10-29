/**
 * 轻量 markdown 编辑器：textarea + 工具栏 + 预览切换。
 *
 * 刻意不引 TipTap/CodeMirror 这类完整编辑器（几百 KB，还带一堆依赖）——
 * 这里只需要「能插入常见语法 + 看一眼渲染效果」，自己写就够了。
 */

import { useEffect, useRef, useState } from "react";
import { MarkdownBlock } from "./Markdown";
import { cn } from "../lib/utils";

/** 输入区高度上下限：内容再少也要有像样的输入面积，再多则内部滚动。 */
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 480;

export function MdEditor({
    value,
    onChange,
    onCommit,
    placeholder,
    rows = 4,
    onSubmit,
    className,
}: {
    value: string;
    onChange: (next: string) => void;
    /** 失焦时提交（用于属性这类「改完即存」的字段） */
    onCommit?: () => void;
    placeholder?: string;
    rows?: number;
    /** Ctrl/⌘ + Enter 提交（评论用） */
    onSubmit?: () => void;
    className?: string;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const [preview, setPreview] = useState(false);

    /**
     * 高度跟随内容：从渲染态切到编辑态时，不能让长文突然缩成三行。
     * 上限 480px，再长就内部滚动，避免一条超长描述把面板撑到看不见底。
     */
    useEffect(() => {
        if (preview) return;
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        // 用 JS 下限兜住「刚挂载/在 dialog 里尚未布局」时 scrollHeight 为 0 的情况
        el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
    }, [value, preview]);

    /** 用语法包裹选区（粗体、斜体、行内代码、链接）。 */
    const wrap = (before: string, after = before, fallback = "文本") => {
        const el = ref.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const selected = value.slice(start, end) || fallback;
        onChange(`${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`);
        requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(start + before.length, start + before.length + selected.length);
        });
    };

    /** 给选中的每一行加前缀（列表、引用）。 */
    const prefixLines = (prefix: string) => {
        const el = ref.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const block = value.slice(lineStart, end) || "";
        const next = block
            .split("\n")
            .map(line => `${prefix}${line}`)
            .join("\n");
        onChange(`${value.slice(0, lineStart)}${next}${value.slice(end)}`);
        requestAnimationFrame(() => el.focus());
    };

    const tools: Array<{ label: string; title: string; run: () => void }> = [
        { label: "B", title: "加粗", run: () => wrap("**") },
        { label: "I", title: "斜体", run: () => wrap("*") },
        { label: "</>", title: "行内代码", run: () => wrap("`", "`", "code") },
        { label: "•", title: "列表", run: () => prefixLines("- ") },
        { label: "❝", title: "引用", run: () => prefixLines("> ") },
        { label: "🔗", title: "链接", run: () => wrap("[", "](url)", "文本") },
    ];

    return (
        <div
            className={cn(
                "rounded-md border border-border bg-bg focus-within:border-accent",
                className,
            )}
        >
            <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
                {tools.map(tool => (
                    <button
                        key={tool.label}
                        type="button"
                        title={tool.title}
                        // 防止点击工具栏让 textarea 先失焦（会触发 onCommit）
                        onMouseDown={event => event.preventDefault()}
                        onClick={tool.run}
                        className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-col hover:text-fg"
                    >
                        {tool.label}
                    </button>
                ))}
                <span className="flex-1" />
                <button
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => setPreview(!preview)}
                    className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-col hover:text-fg"
                >
                    {preview ? "编辑" : "预览"}
                </button>
            </div>
            {preview ? (
                <div className="p-1">
                    <MarkdownBlock content={value || "*（空）*"} className="border-0 bg-transparent" />
                </div>
            ) : (
                <textarea
                    ref={ref}
                    value={value}
                    rows={rows}
                    placeholder={placeholder}
                    onChange={event => onChange(event.target.value)}
                    onBlur={onCommit}
                    onKeyDown={event => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
                            event.preventDefault();
                            onSubmit();
                        }
                    }}
                    // min-h：内容很少时也要有像样的输入面积，不能缩成一行
                    className="min-h-[96px] w-full resize-y bg-transparent px-2.5 py-2 text-sm text-fg outline-none"
                />
            )}
        </div>
    );
}
