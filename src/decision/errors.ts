/**
 * 决策客户端的错误类型。
 *
 * 统一把 HTTP 状态、错误码与可重试性暴露给上层路由逻辑，
 * 避免调用方解析各家的错误响应体格式。
 */

/** 服务端返回的错误体形状（OpenAI 风格）。 */
interface ApiErrorBody {
    error?: {
        message?: string;
        type?: string;
        code?: string | null;
    };
}

export class DecisionError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly retriable: boolean;

    constructor(message: string, status: number, code?: string, retriable = false) {
        super(message);
        this.name = "DecisionError";
        this.status = status;
        this.code = code;
        this.retriable = retriable;
    }
}

/** 是否应重试：429 / 5xx / 网络错误可重试，4xx（除 429）不重试。 */
export function isRetriableStatus(status: number): boolean {
    return status === 429 || status === 408 || status >= 500;
}

/** 从任意响应体里提取可读的错误信息与 code。 */
export function parseApiError(status: number, body: unknown): { message: string; code?: string } {
    if (body && typeof body === "object") {
        const err = (body as ApiErrorBody).error;
        if (err) {
            return {
                message: err.message ?? `HTTP ${status}`,
                code: err.code ?? err.type,
            };
        }
    }
    if (typeof body === "string" && body.trim()) {
        return { message: body.slice(0, 300) };
    }
    return { message: `HTTP ${status}` };
}

/** 从 429 响应头解析 Retry-After 秒数，缺省回退到给定的退避值。 */
export function parseRetryAfter(headers: Record<string, unknown>, fallbackMs: number): number {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string") {
        const secs = Number(raw);
        if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) return raw * 1000;
    return fallbackMs;
}

