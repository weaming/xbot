import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 className：后写的 Tailwind 类覆盖前面的同类属性。 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}

/**
 * 不可撤销操作的统一确认入口，`false` 表示用户点了取消。
 *
 * 规则：删数据、把任务交给调度器跑起来、丢掉本机状态——界面上撤不回来的，
 * 点了先问一句；能撤销的（归档/取消归档、拖拽换列、就地编辑）不打扰。
 * 用原生 confirm：手机上就是系统弹窗，比自绘对话框稳，也不占额外交互面积。
 */
export function confirmAction(message: string): boolean {
    return window.confirm(message);
}

/**
 * 幂等键：`crypto.randomUUID` 只在安全上下文（https 或 localhost）才有，
 * 手机用 http 打开局域网 IP 时它是 undefined——这里给出形状一致的 UUID v4。
 */
export function newIdempotencyKey(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        // getRandomValues 不受安全上下文限制，优先用它
        crypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    // 打上 v4 的版本位与变体位，与服务端预期的 uuid 形状一致
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 复制文本：非安全上下文没有 `navigator.clipboard`，
 * 退回临时 textarea + execCommand，至少让手机上的「复制」不是死按钮。
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 权限被拒：继续走兜底
    }

    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}
