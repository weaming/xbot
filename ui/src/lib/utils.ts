import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 className：后写的 Tailwind 类覆盖前面的同类属性。 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
