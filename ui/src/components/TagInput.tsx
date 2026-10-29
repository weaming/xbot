/**
 * 标签输入：空格或回车即提交，退格删整个胶囊。
 *
 * 不用分隔符的纯文本输入：用户看不出「这是一组标签」，
 * 也不方便单独删掉某个。
 */

import { useState } from "react";
import { cn } from "../lib/utils";

export function TagInput({
    value,
    onChange,
    placeholder,
}: {
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
}) {
    const [draft, setDraft] = useState("");

    /** 把输入框里的内容变成一个胶囊：已有标签必须保留，否则回车会把前面的一起抹掉。 */
    const commit = (raw: string) => {
        setDraft("");
        const tag = raw.trim();
        if (!tag || value.includes(tag)) return;
        onChange([...value, tag]);
    };

    return (
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 focus-within:border-accent">
            {value.map(tag => (
                <span
                    key={tag}
                    className="flex items-center gap-1 rounded-full bg-col px-2 py-0.5 text-xs text-fg"
                >
                    {tag}
                    <button
                        type="button"
                        aria-label={`删除标签 ${tag}`}
                        onClick={() => onChange(value.filter(item => item !== tag))}
                        className="text-muted hover:text-bad"
                    >
                        ×
                    </button>
                </span>
            ))}
            <input
                value={draft}
                placeholder={value.length === 0 ? placeholder : ""}
                onChange={event => {
                    const text = event.target.value;
                    // 空格触发：空格前的都变成胶囊，空格后剩下的留在输入框继续敲
                    if (!/\s/.test(text)) {
                        setDraft(text);
                        return;
                    }
                    const parts = text.split(/\s+/);
                    const tail = parts.pop() ?? "";
                    let next = [...value];
                    for (const part of parts) {
                        const tag = part.trim();
                        if (tag && !next.includes(tag)) next.push(tag);
                    }
                    onChange(next);
                    setDraft(tail);
                }}
                onKeyDown={event => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commit(draft);
                        return;
                    }
                    // 输入框为空时退格删掉最后一个胶囊
                    if (event.key === "Backspace" && !draft && value.length > 0) {
                        event.preventDefault();
                        onChange(value.slice(0, -1));
                    }
                }}
                onBlur={() => commit(draft)}
                className={cn("min-w-[70px] flex-1 bg-transparent text-sm text-fg outline-none")}
            />
        </div>
    );
}
