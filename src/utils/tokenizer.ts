/**
 * 真实分词器（DeepSeek V4，HF tokenizer.json）：token 计数的事实来源。
 *
 * - 懒加载：首次用到时才读取词表（约 100ms），不进 TUI 启动路径；
 * - 缓存：`StoredChatMessage` 内容不可变，按消息 id 记账，判定只算新增消息；
 * - 回退：原生模块/词表不可用、或模型不是 DeepSeek 系（各家 tokenizer 不同）时，
 *   退回 `token-estimator.ts` 的启发式估算，保证调用方永远拿得到值。
 *
 * 异步是硬约束：`tokenizers` 的 encode 返回 Promise，所以 token 计数链路整体是 async。
 */

import fs from "node:fs";
import path from "node:path";
import tokenizerFile from "../../assets/deepseek-v4-tokenizer.tokjson" with { type: "file" };
import type { Tokenizer } from "tokenizers";
import type { ChatMessage, ConversationTurn, StoredChatMessage } from "../types/session.js";
import { estimateTextTokens } from "./token-estimator.js";

/** 单条消息的结构开销（role / 分隔符），真实分词只数内容，这部分按常数补。 */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** 单条 tool_call 的结构开销（type / 字段名）。 */
const TOOL_CALL_OVERHEAD_TOKENS = 10;

let loading: Promise<Tokenizer | null> | undefined;
/** 已精确统计过的消息（内容不可变的 StoredChatMessage 按 id 记账）。 */
const messageCache = new Map<string, number>();

/** 关闭真分词（诊断/测试用）：`XBOT_TOKENIZER=off`。 */
function tokenizerDisabled(): boolean {
    const mode = (process.env.XBOT_TOKENIZER ?? "").trim().toLowerCase();
    return mode === "off" || mode === "0" || mode === "false";
}

/** 真分词只对 DeepSeek 系精确：其它 provider 应该带自己的 tokenizer 或退回估算。 */
export function supportsRealTokenizer(model?: string): boolean {
    if (!model) return true;
    return model.toLowerCase().includes("deepseek");
}

/** 词表随 bundle 一起分发：相对路径按 bundle 目录解析（file loader 在构建后给的是相对路径）。 */
function resolveTokenizerFile(): string {
    return path.isAbsolute(tokenizerFile) ? tokenizerFile : path.resolve(import.meta.dir, tokenizerFile);
}

/** 懒加载分词器；失败只警告一次，之后永久走回退路径。 */
export function loadTokenizer(): Promise<Tokenizer | null> {
    loading ??= loadTokenizerOnce();
    return loading;
}

/**
 * 加载 tokenizers 原生模块。
 * 单文件分发时启动器把 .node 解到外部目录并告知路径，此时优先用该路径；
 * 否则走普通包解析（开发态与 bundle 态）。
 */
async function loadNativeModule(): Promise<typeof import("tokenizers")> {
    const nativeDir = process.env.XBOT_NATIVE_DIR;
    if (nativeDir) {
        const nativePath = path.join(nativeDir, "tokenizers.node");
        if (fs.existsSync(nativePath)) {
            const { createRequire } = await import("node:module");
            const require = createRequire(import.meta.url);
            return require(nativePath) as typeof import("tokenizers");
        }
    }
    return import("tokenizers");
}

function loadTokenizerOnce(): Promise<Tokenizer | null> {
    return (async () => {
        try {
            const { Tokenizer } = await loadNativeModule();
            // 单文件分发时启动器把词表经 fd 注入，直接从内存解析，不落盘
            const inline = readTokenizerFromFd();
            if (inline) return Tokenizer.fromString(inline);

            const file = resolveTokenizerFile();
            if (!fs.existsSync(file)) throw new Error(`词表文件不存在: ${file}`);
            return Tokenizer.fromFile(file);
        } catch (error) {
            console.warn("⚠️ [tokenizer] 加载失败，回退启发式估算:", (error as Error)?.message ?? error);
            return null;
        }
    })();
}

/** 从启动器注入的 fd 读取词表 JSON；未注入时返回 null。 */
function readTokenizerFromFd(): string | null {
    const raw = process.env.XBOT_TOKENIZER_FD;
    if (!raw) return null;
    const fd = Number(raw);
    if (!Number.isInteger(fd) || fd < 3) return null;

    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(1 << 16);
    for (;;) {
        let read: number;
        try {
            read = fs.readSync(fd, buffer, 0, buffer.length, null);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
            throw error;
        }
        if (read === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** 文本的精确 token 数；分词器不可用或模型不匹配时回退启发式估算。 */
export async function countTextTokens(text: string, model?: string): Promise<number> {
    if (!text) return 0;
    if (tokenizerDisabled() || !supportsRealTokenizer(model)) return estimateTextTokens(text);

    const tokenizer = await loadTokenizer();
    if (!tokenizer) return estimateTextTokens(text);

    // tokenizers 的 encode 返回 Promise<Encoding>（类型声明是同步签名，运行时是异步）；
    // Bun 下拿 ids 要走 getIds()（napi 对象的 getter 属性读不到）
    const encoded = (await tokenizer.encode(text)) as unknown as {
        ids?: number[];
        getIds?: () => number[];
    };
    const ids = encoded?.ids ?? encoded?.getIds?.();
    return Array.isArray(ids) ? ids.length : estimateTextTokens(text);
}

/** 单条消息的精确 token 数（内容 + tool_calls 参数 + 结构开销）。 */
async function countMessageTokens(
    message: ChatMessage | StoredChatMessage,
    model?: string,
): Promise<number> {
    const id = "id" in message ? message.id : undefined;
    const cached = id ? messageCache.get(id) : undefined;
    if (cached !== undefined) return cached;

    let tokens = MESSAGE_OVERHEAD_TOKENS;
    if (typeof message.content === "string") tokens += await countTextTokens(message.content, model);
    if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            tokens += TOOL_CALL_OVERHEAD_TOKENS;
            if (call.function?.name) tokens += await countTextTokens(call.function.name, model);
            if (call.function?.arguments) tokens += await countTextTokens(call.function.arguments, model);
        }
    }

    if (id) messageCache.set(id, tokens);
    return tokens;
}

/** 一组消息的精确 token 数。 */
export async function countMessagesTokens(
    messages: Array<ChatMessage | StoredChatMessage>,
    model?: string,
): Promise<number> {
    let total = 0;
    for (const message of messages) total += await countMessageTokens(message, model);
    return total;
}

/** 一组回合的精确 token 数（跳过 failed 回合，与上下文口径一致）。 */
export async function countTurnsTokens(turns: ConversationTurn[], model?: string): Promise<number> {
    let total = 0;
    for (const turn of turns) {
        if (turn.status === "failed") continue;
        total += await countMessagesTokens(turn.messages, model);
    }
    return total;
}
