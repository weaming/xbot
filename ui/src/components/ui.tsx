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
    label = "⋯",
}: {
    children: ReactNode;
    className?: string;
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
            <Button variant="ghost" aria-label="更多操作" aria-expanded={open} onClick={() => setOpen(!open)}>
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

type BadgeTone = "default" | "accent" | "ok" | "warn" | "bad";

const BADGE_TONES: Record<BadgeTone, string> = {
    default: "border-border text-muted",
    accent: "border-accent text-accent",
    ok: "border-ok text-ok",
    warn: "border-warn text-warn",
    bad: "border-bad text-bad",
};

export function Badge({ tone = "default", children }: { tone?: BadgeTone; children: ReactNode }) {
    return (
        <span className={cn("rounded-full border px-2 py-0.5 text-xs leading-tight", BADGE_TONES[tone])}>
            {children}
        </span>
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

export function Tabs<T extends string>({
    tabs,
    active,
    onChange,
}: {
    tabs: Array<{ key: T; label: string; count?: number }>;
    active: T;
    onChange: (key: T) => void;
}) {
    return (
        <div className="flex gap-1 border-b border-border">
            {tabs.map(tab => (
                <button
                    key={tab.key}
                    onClick={() => onChange(tab.key)}
                    className={cn(
                        "-mb-px border-b-2 px-3 py-1.5 text-sm",
                        tab.key === active
                            ? "border-accent text-fg"
                            : "border-transparent text-muted hover:text-fg",
                    )}
                >
                    {tab.label}
                    {tab.count !== undefined && <span className="ml-1 text-xs text-muted">{tab.count}</span>}
                </button>
            ))}
        </div>
    );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">{label}</span>
            {children}
        </label>
    );
}
