/**
 * 决策 provider 抽象。
 *
 * 所有 System One 兼容端点（Liquid / TypeSafe / Mercury / jevstyle）
 * 请求与响应结构相同，差异仅在 base URL、模型名与鉴权方式，
 * 因此由基类统一实现重试、退避与错误归一化。
 */

import axios, { AxiosError, type AxiosInstance } from "axios";
import { DecisionError, isRetriableStatus, parseApiError, parseRetryAfter } from "./errors.js";
import type { DecisionRequest, DecisionResult } from "./types.js";

export interface ProviderOptions {
    /** 端点根地址，例如 https://api.liquid.ai */
    baseUrl: string;
    apiKey: string;
    /** 默认模型 id。 */
    model: string;
    /** 单次请求超时，默认 30s。 */
    timeoutMs?: number;
    /** 失败重试次数（不含首次），默认 2。 */
    maxRetries?: number;
    /** 退避基数，指数增长；默认 800ms。 */
    backoffMs?: number;
    /** 自定义请求头。 */
    headers?: Record<string, string>;
    /** 注入自定义 axios 实例（测试用）。 */
    http?: AxiosInstance;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 800;

/** System One 请求体（各 provider 一致）。 */
interface SystemOneBody {
    model: string;
    state?: unknown;
    questions: unknown;
    images?: unknown;
}

/** System One 响应体。 */
interface SystemOneResponse {
    model?: string;
    answers?: Record<string, unknown>;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
    };
}

export class DecisionProvider {
    readonly name: string;
    protected readonly baseUrl: string;
    protected readonly apiKey: string;
    protected readonly model: string;
    protected readonly timeoutMs: number;
    protected readonly maxRetries: number;
    protected readonly backoffMs: number;
    protected readonly http: AxiosInstance;
    protected readonly extraHeaders: Record<string, string>;

    constructor(name: string, options: ProviderOptions) {
        this.name = name;
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
        this.http = options.http ?? axios.create();
        this.extraHeaders = options.headers ?? {};
    }

    /** 决策端点路径；少数 provider 路径不同，可覆盖。 */
    protected endpointPath(): string {
        return "/decisions/v1/systemone";
    }

    /** 组装鉴权头；非 Bearer 的 provider 可覆盖。 */
    protected authHeaders(): Record<string, string> {
        return { Authorization: `Bearer ${this.apiKey}` };
    }

    /**
     * 发起一次决策调用。
     *
     * 可重试错误（429/5xx/网络）按指数退避重试，429 优先遵循 Retry-After；
     * 不可重试错误（401/404/422）立即抛出。
     */
    async decide(request: DecisionRequest): Promise<DecisionResult> {
        const model = request.model ?? this.model;
        const body: SystemOneBody = {
            model,
            questions: request.questions,
        };
        if (request.state !== undefined && request.state !== null) body.state = request.state;
        if (request.images?.length) body.images = request.images;

        const timeout = request.timeoutMs ?? this.timeoutMs;
        const url = `${this.baseUrl}${this.endpointPath()}`;
        const startedAt = Date.now();

        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const resp = await this.http.post<SystemOneResponse>(url, body, {
                    headers: {
                        "Content-Type": "application/json",
                        ...this.authHeaders(),
                        ...this.extraHeaders,
                    },
                    timeout,
                    validateStatus: () => true,
                });

                if (resp.status >= 200 && resp.status < 300) {
                    return this.normalize(resp.data, model, Date.now() - startedAt, attempt);
                }

                const { message, code } = parseApiError(resp.status, resp.data);
                const err = new DecisionError(
                    `[${this.name}] ${message}`,
                    resp.status,
                    code,
                    isRetriableStatus(resp.status),
                );
                if (!err.retriable || attempt === this.maxRetries) throw err;

                lastError = err;
                const wait = resp.status === 429
                    ? parseRetryAfter(resp.headers as Record<string, unknown>, this.backoffMs * 2 ** attempt)
                    : this.backoffMs * 2 ** attempt;
                await sleep(wait);
            } catch (error) {
                if (error instanceof DecisionError) throw error;
                const wrapped = toNetworkError(this.name, error);
                if (!wrapped.retriable || attempt === this.maxRetries) throw wrapped;
                lastError = wrapped;
                await sleep(this.backoffMs * 2 ** attempt);
            }
        }
        throw lastError instanceof Error ? lastError : new DecisionError(`[${this.name}] 重试耗尽`, 0);
    }

    /** 把原始响应归一化为 DecisionResult，并做最小必要校验。 */
    private normalize(data: SystemOneResponse, fallbackModel: string, latencyMs: number, retries: number): DecisionResult {
        if (!data || typeof data !== "object") {
            throw new DecisionError(`[${this.name}] 响应体不是对象`, 0);
        }
        if (!data.answers || typeof data.answers !== "object") {
            throw new DecisionError(`[${this.name}] 响应缺少 answers 字段`, 0);
        }
        const usage = data.usage ?? {};
        return {
            model: data.model ?? fallbackModel,
            answers: data.answers as DecisionResult["answers"],
            usage: {
                input_tokens: usage.input_tokens ?? 0,
                output_tokens: usage.output_tokens ?? 0,
                cost: usage.cost,
            },
            latencyMs,
            retries,
        };
    }
}

/** 把 axios 网络错误转成可读的 DecisionError。 */
function toNetworkError(name: string, error: unknown): DecisionError {
    if (axios.isAxiosError(error)) {
        const axErr = error as AxiosError;
        const code = axErr.code ?? "network_error";
        const status = axErr.response?.status ?? 0;
        const isTimeout = code === "ECONNABORTED" || code === "ETIMEDOUT";
        return new DecisionError(
            `[${name}] ${isTimeout ? "请求超时" : axErr.message}`,
            status,
            code,
            isTimeout || status === 0,
        );
    }
    return new DecisionError(`[${name}] ${(error as Error)?.message ?? "未知错误"}`, 0, undefined, true);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
