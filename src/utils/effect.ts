/**
 * Effect 与 Promise 世界的桥：内核内部用 Effect 表达并发与生命周期，
 * 对外导出的 API 一律保持 Promise/同步形态，调用方无需感知。
 */

import { Cause, Effect, Exit } from "effect";

const ABORT_MESSAGE = "The operation was aborted";

/** 统一的中断异常：调用方按 `name === "AbortError"` 判定中止。 */
export function abortError(message: string = ABORT_MESSAGE): Error {
    return new DOMException(message, "AbortError");
}

/**
 * 把 AbortSignal 接到 Effect 中断：signal 触发即中断当前 fiber。
 * 监听器在 fiber 结束时自动摘除，调用方不必再手动 removeEventListener。
 */
export function interruptOnAbort(signal?: AbortSignal): Effect.Effect<never> {
    if (!signal) return Effect.never;

    return Effect.callback<never>((resume) => {
        const onAbort = (): void => resume(Effect.interrupt);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
}

/** 跑 Effect：成功取值，中断还原成 AbortError，其余失败抛出原始异常。 */
export async function runPromiseOrAbort<A, E>(
    program: Effect.Effect<A, E>,
    message?: string,
): Promise<A> {
    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) throw abortError(message);
    throw Cause.squash(exit.cause);
}

/**
 * 不阻止进程退出的等待：后台 watchdog 用它计时，
 * 与原来的 `setTimeout(...).unref()` 行为一致（中断即清定时器）。
 */
export function sleepUnref(ms: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), ms);
        timer.unref?.();
        return Effect.sync(() => clearTimeout(timer));
    });
}

/**
 * signal 触发时执行一段同步动作（杀进程这类清理），然后正常结束。
 * 与 `interruptOnAbort` 的区别：这里不中断 fiber —— 中断会连带撤销同一 race 里的其他分支。
 */
export function whenAborted(signal: AbortSignal | undefined, action: () => void): Effect.Effect<void> {
    if (!signal) return Effect.never;

    return Effect.callback<void>((resume) => {
        const onAbort = (): void => {
            action();
            resume(Effect.void);
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
}
