/** 轻量 UI 原语：沿用 shadcn 的视觉契约，但不引入 Radix —— 组件少而可控。 */

import {
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type Ref,
    type TextareaHTMLAttributes,
} from "react";
import { cn } from "../lib/utils";

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
    default: "border-border bg-panel hover:bg-col text-fg",
    primary: "border-accent bg-accent hover:opacity-90 text-accent-fg",
    danger: "border-bad text-bad hover:bg-bad/10",
    ghost: "border-transparent bg-transparent hover:bg-col text-muted",
};

export function Button({
    variant = "default",
    className,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
    return (
        <button
            className={cn(
                "inline-flex items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-sm transition",
                "disabled:cursor-default disabled:opacity-50",
                BUTTON_VARIANTS[variant],
                className,
            )}
            {...props}
        />
    );
}

const FIELD =
    // 移动端 16px：iOS Safari 对小于 16px 的输入框会在聚焦时强制放大页面
    "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-base text-fg outline-none focus:border-accent sm:text-sm";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={cn(FIELD, className)} {...props} />;
}

export function Textarea({
    className,
    ref,
    ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
    return <textarea ref={ref} className={cn(FIELD, "min-h-[64px] resize-y", className)} {...props} />;
}

/**
 * 右上角的「⋯」菜单：窄屏把次要动作收起来，正片内容才能吃满屏幕。
 *
 * 不做焦点陷阱（里面只有动作按钮），点面板外或按 Esc 收起；
 * Esc 用捕获阶段并掐断冒泡，否则卡片自己的 Esc 会跟着把详情关掉。
 */
export function OverflowMenu({
    children,
    className,
    triggerClassName,
    label = "⋯",
}: {
    children: ReactNode;
    className?: string;
    /** 触发按钮自己的样式（头部里要跟标题同高） */
    triggerClassName?: string;
    label?: string;
}) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (wrapRef.current?.contains(event.target as Node)) return;
            setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown, { capture: true });
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown, { capture: true });
        };
    }, [open]);

    return (
        <div ref={wrapRef} className={cn("relative shrink-0", className)}>
            <Button
                variant="ghost"
                aria-label="更多操作"
                aria-expanded={open}
                className={triggerClassName}
                onClick={() => setOpen(!open)}
            >
                {label}
            </Button>
            {open && (
                // 菜单项直接传 <Button>：统一拉成整行左对齐，免得每个调用点都写一遍 className
                <div
                    role="menu"
                    onClick={() => setOpen(false)}
                    className="absolute top-full right-0 z-30 mt-1 flex w-44 flex-col gap-0.5 rounded-lg border border-border bg-panel p-1 shadow-lg [&>button]:w-full [&>button]:justify-start"
                >
                    {children}
                </div>
            )}
        </div>
    );
}

/** 原生 dialog：自带焦点圈闭与 Esc 关闭，比自造 modal 少一半代码。 */
export function Dialog({
    open,
    title,
    onClose,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            className="stable-scroll max-h-[85dvh] w-[min(560px,94vw)] overflow-y-auto rounded-xl border border-border bg-panel p-4 text-fg backdrop:bg-black/40"
        >
            <h2 className="mb-3 text-base font-semibold">{title}</h2>
            {children}
        </dialog>
    );
}

/**
 * 紧凑分段控件：用来取代占一整行的 tab 栏。
 * 放在头部里只占按钮的宽度，省下的一行留给会话历史。
 */
export function Segmented<T extends string>({
    options,
    value,
    onChange,
}: {
    options: Array<{ key: T; label: string; count?: number }>;
    value: T;
    onChange: (key: T) => void;
}) {
    return (
        // 高度与标题一致（h-9）：同一行里三块东西不能高矮不齐
        <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
            {options.map(option => (
                <button
                    key={option.key}
                    type="button"
                    onClick={() => onChange(option.key)}
                    className={cn(
                        "flex h-full items-center rounded px-1.5 text-xs transition",
                        option.key === value ? "bg-accent/15 text-accent" : "text-muted hover:text-fg",
                    )}
                >
                    {option.label}
                    {(option.count ?? 0) > 0 && <span className="ml-1 text-[10px]">{option.count}</span>}
                </button>
            ))}
        </div>
    );
}

/**
 * 字段容器：标签一行 + 内容。opt 动作（如「清空」）放标签行右侧，
 * 不跟内容一起换行，免得挤成一团或和上方的胶囊重叠。
 *
 * 注意用 div 而不是 label：内容里有按钮组时，点 label 的空白会把点击
 * 转发给第一个按钮，表现为「点空白也切换选中」。
 */
export function Field({
    label,
    action,
    children,
}: {
    label: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs text-muted">{label}</span>
                {action && <span className="ml-auto shrink-0">{action}</span>}
            </div>
            {children}
        </div>
    );
}
