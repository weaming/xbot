/**
 * bun:ffi 最小类型声明（zbot TUI 仅在 bun 运行时加载，node 服务不会 import 本模块链）。
 * 完整类型见 https://bun.sh/docs/api/ffi。
 */
declare module "bun:ffi" {
    export const FFIType: {
        void: number;
        ptr: number;
        i8: number;
        u8: number;
        i16: number;
        u16: number;
        i32: number;
        u32: number;
        i64: number;
        u64: number;
        f32: number;
        f64: number;
        bool: number;
        char: number;
        cstring: number;
        [key: string]: number;
    };

    export function dlopen(
        path: string,
        symbols: Record<string, { args: number[]; returns: number }>,
    ): { symbols: Record<string, (...args: never[]) => never> };
}
