
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
export const CONSOLE_TIMESTAMP_MARK = Symbol.for("zbot.consoleTimestamped");

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
 * LLM 交换日志目录：脱离 cwd，固定到 ZBOT_STATE_DIR（默认 ~/.zbot）。
 * 旧位置 `cwd/logs/llm-api.log` 不再写入新数据。
 */
function resolveLogDir(): string {
    const stateRoot = process.env.ZBOT_STATE_DIR
        ? path.resolve(process.env.ZBOT_STATE_DIR)
        : path.join(os.homedir(), '.zbot');
    return path.join(stateRoot, 'logs');
}

function resolveLogFiles(): { logDir: string; exchangeFile: string } {
    const logDir = resolveLogDir();
    return {
        logDir,
        exchangeFile: path.join(logDir, 'llm-exchange.jsonl'),
    };
}

/** 主日志写失败时的兜底路径，避免 cwd 或 ZBOT_STATE_DIR 切换后丢排查线索。 */
function getFallbackLogFile(): string {
    return path.join(os.homedir(), '.zbot', 'logs', 'llm-exchange.fallback.jsonl');
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

interface AIInteractionLogEntry {
    timestamp: string;
    type: string;
    content: any;
    schemaVersion: number;
}

export interface LLMExchangeMeta {
    requestId?: string;
    parentRequestId?: string;
    /** 无 sessionId 时的手工链起点：历史中已记录过的条数，仅记录其后新增部分。 */
    prevMessageCount?: number;
    /** 会话 id：提供时按 session 分离写入 sessions/http/<id>.jsonl。 */
    sessionId?: string;
    /** RESPONSE 时附加的用量统计（原 llm-usage 行的信息，合并进 exchange）。 */
    usage?: LLMUsageLogEntry;
}

/** 与 resolveLogDir 同源（无 ZBOT_STATE_DIR 时默认 ~/.zbot），避免回退容器只读路径。 */
function resolveSessionsDir(...parts: string[]): string {
    const stateRoot = process.env.ZBOT_STATE_DIR
        ? path.resolve(process.env.ZBOT_STATE_DIR)
        : path.join(os.homedir(), '.zbot');
    return path.join(stateRoot, 'sessions', ...parts);
}

/** 会话维度的 LLM 交换日志文件（sessions/http/ 下，删除会话时一起清理）。 */
export function getSessionExchangeLogFile(sessionId: string): string {
    return path.join(resolveSessionsDir("http"), `${sessionId}.jsonl`);
}

/** 进程内缓存：tools 全量仅在变化时写入日志，未变化只写 hash。 */
let lastLoggedToolsHash: string | undefined;

/** 历史载体字段名：responses 协议用 input，chat_completions 用 messages。 */
type HistoryField = "input" | "messages";

interface SessionChainState {
    lastRequestId: string | null;
    historyField: HistoryField;
    /** 已落盘的历史总条数（不是本条记录写入的增量条数）。 */
    historyCount: number;
}

/** 尾部续链的初始读取窗口：只需最后一条 REQUEST，避免启动时解析整个文件。 */
const CHAIN_TAIL_BYTES = 4 * 1024 * 1024;

/** RESPONSE 中与 REQUEST 重复的回显字段（上游原样返回全套 tools，单条可达数百 KB）。 */
const RESPONSE_ECHO_FIELDS = ["tools", "instructions"];

/** 会话级请求链状态：同 session 跨 sendMessage 成链、messages 持续增量。 */
const sessionChains = new Map<string, SessionChainState>();

/** 按协议取历史载体：responses 用 input，chat_completions 用 messages。 */
function pickHistory(content: any): { field: HistoryField; items: any[] } {
    if (Array.isArray(content?.input)) return { field: "input", items: content.input };
    if (Array.isArray(content?.messages)) return { field: "messages", items: content.messages };
    return { field: "messages", items: [] };
}

/** 丢弃 RESPONSE 里与请求重复的回显字段。 */
function omitResponseEcho(content: any): any {
    if (!content || typeof content !== "object") return content;
    const rest: Record<string, unknown> = { ...content };
    for (const key of RESPONSE_ECHO_FIELDS) delete rest[key];
    return rest;
}

/** 解析一行 REQUEST 的链信息；非 REQUEST 或损坏行返回 null。 */
function parseChainEntry(line: string): SessionChainState | null {
    if (!line.includes('"REQUEST"')) return null;
    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return null; // 截断或损坏行。
    }
    if (entry?.type !== 'REQUEST') return null;

    const c = entry.content ?? {};
    const { field, items } = pickHistory(c);
    return {
        lastRequestId: typeof c.requestId === 'string' ? c.requestId : null,
        // 旧格式没有 historyField/historyCount：其 input/messages 是全量快照，长度即总数。
        historyField: c.historyField === 'input' || c.historyField === 'messages' ? c.historyField : field,
        historyCount: typeof c.historyCount === 'number' ? c.historyCount : items.length,
    };
}

/** 从尾部反向找最后一条可解析的 REQUEST；窗口不够（单行超窗口）时按倍数放大。 */
function readChainFromTail(fd: number, size: number): SessionChainState | null {
    let win = Math.min(size, CHAIN_TAIL_BYTES);
    while (true) {
        const from = Math.max(0, size - win - 1); // 多读 1 字节用于判断首行是否完整
        const len = size - from;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        const lines = buf.toString('utf8').split('\n');
        // 窗口起点不在行首时首段是半行，丢弃。
        const start = from === 0 ? 0 : 1;
        for (let i = lines.length - 1; i >= start; i--) {
            const state = parseChainEntry(lines[i]);
            if (state) return state;
        }
        if (from === 0) return null;
        win = Math.min(size, win * 4);
    }
}

/** 惰性加载会话链：重启后从该会话日志尾部续链（最后一条 REQUEST 的 id 与历史总数）。 */
function loadSessionChain(sessionId: string): SessionChainState {
    const key = sessionId;
    const existing = sessionChains.get(key);
    if (existing) return existing;

    let state: SessionChainState = { lastRequestId: null, historyField: "messages", historyCount: 0 };
    try {
        const fd = fs.openSync(getSessionExchangeLogFile(sessionId), 'r');
        try {
            state = readChainFromTail(fd, fs.fstatSync(fd).size) ?? state;
        } finally {
            fs.closeSync(fd);
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
 *  - 历史（input 或 messages）只写相对上一请求新增的部分，另记 historyCount 供尾部续链；
 *  - tools 仅在内容变化时写全量，否则只写 toolsHash。
 * RESPONSE 丢弃上游回显的 tools/instructions，其余原样记录。
 * 主路径写失败时兜底到 fallback 文件，避免数据丢失。
 */
export function recordLLMExchange(type: "REQUEST" | "RESPONSE", content: any, meta: LLMExchangeMeta = {}): void {
    if (type === "REQUEST") {
        const chain = meta.sessionId
            ? loadSessionChain(meta.sessionId)
            : {
                lastRequestId: meta.parentRequestId ?? null,
                historyField: pickHistory(content).field,
                historyCount: meta.prevMessageCount ?? 0,
            };
        const requestId = meta.requestId ?? createUlid();
        const { field, items } = pickHistory(content);
        // 协议切换或上下文压缩导致条数回退时整块重写，避免漏记。
        const prevCount = field === chain.historyField && chain.historyCount <= items.length ? chain.historyCount : 0;
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
            [field]: items.slice(prevCount),
            historyField: field,
            historyBase: prevCount,
            historyCount: items.length,
            toolsHash,
            tools: toolsChanged ? tools : undefined,
        };
        chain.lastRequestId = requestId;
        chain.historyField = field;
        chain.historyCount = items.length;
        if (meta.sessionId) sessionChains.set(meta.sessionId, chain);
    } else if (type === "RESPONSE") {
        const requestId = meta.requestId ?? (meta.sessionId ? loadSessionChain(meta.sessionId).lastRequestId : undefined);
        content = omitResponseEcho(content);
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
