
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { createUlid } from './ulid.js';

function nowISO() {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' }).replace('T', ' ');
}

/**
 * console 时间戳标记：TUI 的日志重定向自己会写 ISO 时间戳，接管时打上此标记，
 * 这里的 patch 便跳过，避免同一行出现两个时间戳（ISO + 本地时间）。
 */
export const CONSOLE_TIMESTAMP_MARK = Symbol.for("xbot.consoleTimestamped");

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

/** 给 console 输出加本地时间戳前缀；已被接管（标记存在）时跳过，重复调用幂等。 */
export function applyConsoleTimestamps(target: Console = console): void {
    const marked = target as unknown as Record<symbol, unknown>;
    if (marked[CONSOLE_TIMESTAMP_MARK]) return;
    marked[CONSOLE_TIMESTAMP_MARK] = true;

    const log = target.log.bind(target);
    const warn = target.warn.bind(target);
    const error = target.error.bind(target);
    target.log = (...args: any[]) => log(`[${nowISO()}]`, ...args);
    target.warn = (...args: any[]) => warn(`[${nowISO()}]`, ...args);
    target.error = (...args: any[]) => error(`[${nowISO()}]`, ...args);
}

applyConsoleTimestamps();

/**
 * LLM 交换日志目录：脱离 cwd，固定到 XBOT_STATE_DIR（默认 ~/.xbot）。
 * 旧位置 `cwd/logs/llm-api.log` 不再写入新数据。
 */
function resolveLogDir(): string {
    const stateRoot = process.env.XBOT_STATE_DIR
        ? path.resolve(process.env.XBOT_STATE_DIR)
        : path.join(os.homedir(), '.xbot');
    return path.join(stateRoot, 'logs');
}

function resolveLogFiles(): { logDir: string; exchangeFile: string } {
    const logDir = resolveLogDir();
    return {
        logDir,
        exchangeFile: path.join(logDir, 'llm-exchange.jsonl'),
    };
}

/** 主日志写失败时的兜底路径，避免 cwd 或 XBOT_STATE_DIR 切换后丢排查线索。 */
function getFallbackLogFile(): string {
    return path.join(os.homedir(), '.xbot', 'logs', 'llm-exchange.fallback.jsonl');
}

export type LLMRequestKind = 'user_request' | 'tool_response' | 'context_compaction' | 'cli_request' | 'turn_resume' | 'peer_request';

export interface LLMUsageLogEntry {
    timestamp: string;
    caller: string;
    session_id?: string;
    context_epoch_id?: string;
    request_kind?: LLMRequestKind;
    model: string;
    prompt_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    input_chars: number;
    output_chars: number;
    duration_ms: number;
    token_usage_source: 'provider' | 'character_estimate' | 'unavailable';
    /** usage 口径：accumulated_delta 表示上游只给会话累计，数值已差分成本请求新增（见 chat-orchestrator）。 */
    token_usage_semantics?: 'provider' | 'accumulated_delta';
    system_hash?: string;
    tools_hash?: string;
}

/**
 * 显式 truncate 主 LLM exchange 日志。仅当 XBOT_RESET_LLM_LOG=1 时生效，
 * 避免误调用清空排查线索。
 */
export function resetLLMExchangeLog(): boolean {
    if (process.env.XBOT_RESET_LLM_LOG !== "1") return false;
    const { logDir, exchangeFile } = resolveLogFiles();
    try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(exchangeFile, '');
        return true;
    } catch (e) {
        console.error("Failed to reset LLM exchange log:", e);
        return false;
    }
}

interface AIInteractionLogEntry {
    timestamp: string;
    type: string;
    content: any;
    schemaVersion: number;
}

export interface LLMExchangeMeta {
    requestId?: string;
    parentRequestId?: string;
    /** 该请求 messages 中已在日志记录过的条数；仅记录其后新增部分。 */
    prevMessageCount?: number;
    /** 会话 id：提供时按 session 分离写入 sessions/http/<id>.jsonl。 */
    sessionId?: string;
    /** RESPONSE 时附加的用量统计（原 llm-usage 行的信息，合并进 exchange）。 */
    usage?: LLMUsageLogEntry;
}

/** 与 resolveLogDir 同源（无 XBOT_STATE_DIR 时默认 ~/.xbot），避免回退容器只读路径。 */
function resolveSessionsDir(...parts: string[]): string {
    const stateRoot = process.env.XBOT_STATE_DIR
        ? path.resolve(process.env.XBOT_STATE_DIR)
        : path.join(os.homedir(), '.xbot');
    return path.join(stateRoot, 'sessions', ...parts);
}

/** 会话维度的 LLM 交换日志文件（sessions/http/ 下，删除会话时一起清理）。 */
export function getSessionExchangeLogFile(sessionId: string): string {
    return path.join(resolveSessionsDir("http"), `${sessionId}.jsonl`);
}

/** 进程内缓存：tools 全量仅在变化时写入日志，未变化只写 hash。 */
let lastLoggedToolsHash: string | undefined;

interface SessionChainState {
    lastRequestId: string | null;
    prevMessageCount: number;
}

/** 会话级请求链状态：同 session 跨 sendMessage 成链、messages 持续增量。 */
const sessionChains = new Map<string, SessionChainState>();

/** 惰性加载会话链：重启后从该会话日志尾部续链（最后一条 REQUEST 的 id 与累计条数）。 */
function loadSessionChain(sessionId: string): SessionChainState {
    const key = sessionId;
    const existing = sessionChains.get(key);
    if (existing) return existing;

    const state: SessionChainState = { lastRequestId: null, prevMessageCount: 0 };
    try {
        const file = getSessionExchangeLogFile(sessionId);
        if (fs.existsSync(file)) {
            for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    const c = entry?.content;
                    if (entry?.type === 'REQUEST' && typeof c?.requestId === 'string') {
                        state.lastRequestId = c.requestId;
                        state.prevMessageCount += (c.messages ?? []).length;
                    }
                } catch {
                    // 损坏行跳过。
                }
            }
        }
    } catch {
        // 文件不存在视为新会话。
    }
    sessionChains.set(key, state);
    return state;
}

function hashOf(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/** 将一次 AI 交互编码为单行 JSONL 记录。 */
export function formatAIInteractionLogEntry(type: string, content: any): string {
    const entry: AIInteractionLogEntry = {
        timestamp: new Date().toISOString(),
        type,
        content,
        schemaVersion: 1,
    };

    return JSON.stringify(entry, function (key, value) {
        if (typeof value !== "string") return value;
        const separator = value.indexOf(";base64,");
        if (value.startsWith("data:image/") && separator > 5) {
            return `[${value.slice(5, separator)} base64_chars=${value.length - separator - 8}]`;
        }
        if (key === "data" && typeof this?.mimeType === "string" && this.mimeType.startsWith("image/")) {
            return `[${this.mimeType} base64_chars=${value.length}]`;
        }
        return value;
    });
}

/**
 * 记录一次 LLM 协议交换。REQUEST 为链式增量记录：
 *  - requestId + parentRequestId 形成会话内的请求链（同轮重试也成链）；
 *  - messages 只写相对上一请求新增的部分；
 *  - tools 仅在内容变化时写全量，否则只写 toolsHash。
 * 主路径写失败时兜底到 fallback 文件，避免数据丢失。
 */
export function recordLLMExchange(type: "REQUEST" | "RESPONSE", content: any, meta: LLMExchangeMeta = {}): void {
    if (type === "REQUEST") {
        const chain = meta.sessionId
            ? loadSessionChain(meta.sessionId)
            : { lastRequestId: meta.parentRequestId ?? null, prevMessageCount: meta.prevMessageCount ?? 0 };
        const requestId = meta.requestId ?? createUlid();
        const messages = Array.isArray(content?.messages) ? content.messages : [];
        const prevCount = Math.min(chain.prevMessageCount, messages.length);
        const tools = Array.isArray(content?.tools) ? content.tools : [];
        const toolsHash = hashOf(tools);
        const toolsChanged = toolsHash !== lastLoggedToolsHash;
        if (toolsChanged) {
            lastLoggedToolsHash = toolsHash;
        }
        content = {
            ...content,
            requestId,
            ...(chain.lastRequestId ? { parentRequestId: chain.lastRequestId } : {}),
            messages: messages.slice(prevCount),
            toolsHash,
            tools: toolsChanged ? tools : undefined,
        };
        chain.lastRequestId = requestId;
        chain.prevMessageCount = messages.length;
        if (meta.sessionId) sessionChains.set(meta.sessionId, chain);
    } else if (type === "RESPONSE") {
        const requestId = meta.requestId ?? (meta.sessionId ? loadSessionChain(meta.sessionId).lastRequestId : undefined);
        if (requestId) {
            content = { ...content, requestId, ...(meta.usage ? { usage: meta.usage } : {}) };
        }
    }

    const line = `${formatAIInteractionLogEntry(type, content)}\n`;
    const { logDir, exchangeFile } = resolveLogFiles();
    const fallbackFile = getFallbackLogFile();
    const targetFile = meta.sessionId ? getSessionExchangeLogFile(meta.sessionId) : exchangeFile;
    try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.appendFileSync(targetFile, line, 'utf8');
    } catch (primaryError) {
        try {
            fs.mkdirSync(path.dirname(fallbackFile), { recursive: true });
            fs.appendFileSync(fallbackFile, line, 'utf8');
        } catch (fallbackError) {
            _error(`[LLM_EXCHANGE_LOG] ${type} entry write failed: primary (${(primaryError as Error).message})`
                + ` and fallback (${(fallbackError as Error).message}); entry dropped.`);
        }
    }
}

interface UsageTotals {
    requestCount: number;
    promptTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    completionTokens: number;
    totalTokens: number;
}

function hongKongDate(timestamp: string): string {
    const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function previousHongKongDate(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function readUsageTotals(date: string): UsageTotals {
    const totals: UsageTotals = {
        requestCount: 0,
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    };

    // usage 统计已合并进 exchange 的 RESPONSE 记录：扫全局日志 + 各 session 文件。
    const exchangeFiles: string[] = [];
    const globalFile = resolveLogFiles().exchangeFile;
    if (fs.existsSync(globalFile)) exchangeFiles.push(globalFile);
    exchangeFiles.push(...collectExchangeFiles());

    for (const file of exchangeFiles) {
        for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
            if (!line) continue;

            try {
                const entry = JSON.parse(line);
                const usage = entry?.content?.usage;
                if (entry?.type !== 'RESPONSE' || !usage || !usage.timestamp) continue;
                if (hongKongDate(usage.timestamp) !== date) continue;

                totals.requestCount += 1;
                totals.promptTokens += usage.prompt_tokens || 0;
                totals.cacheHitTokens += usage.cache_hit_tokens || 0;
                totals.cacheMissTokens += usage.cache_miss_tokens || 0;
                totals.completionTokens += usage.completion_tokens || 0;
                totals.totalTokens += usage.total_tokens || 0;
            } catch {
                // 损坏行跳过。
            }
        }
    }

    return totals;
}

/** exchange 文件按会话隔离保存。 */
function collectExchangeFiles(): string[] {
    const files: string[] = [];
    const pushJsonl = (dir: string): void => {
        try {
            for (const name of fs.readdirSync(dir)) {
                if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
            }
        } catch {
            // 目录不存在时跳过。
        }
    };

    const sessionsDir = resolveSessionsDir();
    pushJsonl(path.join(sessionsDir, 'http'));
    try {
        for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'http') {
                pushJsonl(path.join(sessionsDir, entry.name, 'http'));
            }
        }
    } catch {
        // sessions 目录不存在时仅统计全局日志。
    }
    return files;
}

function logUsageTotals(scope: 'hourly' | 'daily', date: string): void {
    const totals = readUsageTotals(date);
    console.log(
        `[LLM_USAGE] scope=${scope} date=${date} requests=${totals.requestCount}`
        + ` prompt_tokens=${totals.promptTokens} cache_hit_tokens=${totals.cacheHitTokens}`
        + ` cache_miss_tokens=${totals.cacheMissTokens} completion_tokens=${totals.completionTokens}`
        + ` total_tokens=${totals.totalTokens}`,
    );
}

/** 每小时 05 分输出当日累计，次日 00:05 输出前一天总量。 */
export function startLLMUsageReporter(): void {
    let lastReportKey = '';

    const reportIfDue = (): void => {
        const now = new Date();
        const date = hongKongDate(now.toISOString());
        const minute = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Hong_Kong',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(now);

        if (!minute.endsWith(':05')) return;

        const reportKey = `${date} ${minute}`;
        if (reportKey === lastReportKey) return;
        lastReportKey = reportKey;

        if (minute.startsWith('00:')) {
            logUsageTotals('daily', previousHongKongDate(date));
            return;
        }

        logUsageTotals('hourly', date);
    };

    reportIfDue();
    setInterval(reportIfDue, 60_000).unref();
}
