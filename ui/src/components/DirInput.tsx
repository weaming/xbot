/**
 * 工作目录输入：边输边给候选目录。
 *
 * 键盘约定：↑/↓ 选、Enter 确认（原样填入，与看到的一致，不补尾斜杠）、
 * Tab 补全第一个并补 `/` 方便逐级往下钻、Esc 收起。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

export function DirInput({
    value,
    onChange,
    placeholder,
    autoFocus,
    onSubmit,
}: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    /** 挂载即聚焦：从"只读展示"切到编辑态时用，省得用户再点一次 */
    autoFocus?: boolean;
    /** 回车确认：交出最终值（不含补全用的尾斜杠），由调用方决定提交还是继续编辑 */
    onSubmit?: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useState<string[]>([]);
    const [active, setActive] = useState(0);
    const wrapRef = useRef<HTMLDivElement>(null);

    // 防抖查询：每次按键都打后端没必要
    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => {
            void api
                .listDirs(value)
                .then(list => {
                    setOptions(list);
                    setActive(0);
                })
                .catch(() => setOptions([]));
        }, 120);
        return () => clearTimeout(timer);
    }, [value, open]);

    // 点外面收起
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [open]);

    /** appendSlash 只给 Tab 补全用：那是"往下一级走"，回车是"就选这个目录"。 */
    const pick = (target: string, keepOpen: boolean, appendSlash = true) => {
        onChange(appendSlash && !target.endsWith("/") ? `${target}/` : target);
        setOpen(keepOpen);
    };

    return (
        <div ref={wrapRef} className="relative">
            <input
                value={value}
                placeholder={placeholder}
                autoFocus={autoFocus}
                onChange={event => {
                    onChange(event.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={event => {
                    if (event.key === "ArrowDown") {
                        if (options.length === 0) return;
                        event.preventDefault();
                        setActive(current => (current + 1) % options.length);
                        return;
                    }
                    if (event.key === "ArrowUp") {
                        if (options.length === 0) return;
                        event.preventDefault();
                        setActive(current => (current - 1 + options.length) % options.length);
                        return;
                    }
                    if (event.key === "Tab") {
                        if (!open || options.length === 0) return;
                        event.preventDefault();
                        pick(options[0]!, true);
                        return;
                    }
                    if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (open && options.length > 0) {
                            // 补全态：采用当前候选（与看到的一致，不补尾斜杠），留在编辑态；
                            // 列表收起后已经是编辑态，再按一次 Enter 才确认退出
                            onChange(options[active] ?? options[0]!);
                            setOpen(false);
                            return;
                        }
                        onSubmit?.(value);
                        return;
                    }
                    if (event.key === "Escape") {
                        setOpen(false);
                    }
                }}
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-base text-fg outline-none focus:border-accent sm:text-sm"
            />
            {open && options.length > 0 && (
                <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg">
                    {options.map((option, index) => (
                        <li key={option}>
                            <button
                                type="button"
                                onMouseDown={event => {
                                    event.preventDefault();
                                    pick(option, true);
                                }}
                                onMouseEnter={() => setActive(index)}
                                className={cn(
                                    "block w-full truncate px-2.5 py-1 text-left text-sm",
                                    index === active ? "bg-col text-fg" : "text-muted hover:bg-col",
                                )}
                            >
                                {option}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
