/**
 * 标签输入：逗号即提交，退格删整个胶囊。
 *
 * 不用逗号分隔的纯文本输入：用户看不出「这是一组标签」，
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

    const commit = (raw: string, rest: string[] = []) => {
        const tag = raw.trim();
        const next = tag && !value.includes(tag) && !rest.includes(tag) ? [...rest, tag] : rest;
        if (next.length !== rest.length || next.length > 0) onChange(next);
        setDraft("");
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
                    // 输入中/英文逗号：把逗号前的都变成胶囊，最后一段留在输入框
                    if (!/[,，]/.test(text)) {
                        setDraft(text);
                        return;
                    }
                    const parts = text.split(/[,，]/);
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
