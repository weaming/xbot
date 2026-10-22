/**
 * DeepSeek V4 分词器的纯 JS 实现（HF ByteLevel BPE）。
 *
 * 复刻 tokenizer.json 的处理链：
 *   normalizer(空) → pre_tokenizer(3×Split + ByteLevel) → BPE → added_tokens
 *
 * 与 tokenizers 原生模块逐 token 一致；无需 .node，打包时不落盘。
 * 关键优化：符号用整数 id 建 pair 键，避免字符串拼接；CJK 切分按需启用。
 */

/** tokenizer.json 中本实现用到的字段。 */
export interface TokenizerJSON {
    added_tokens: Array<{ id: number; content: string; special: boolean }>;
    model: { vocab: Record<string, number>; merges: string[] };
}

/** GPT-2 byte-level 的字节 → 字符映射表。 */
const BYTE_TO_CHAR: string[] = (() => {
    const table: string[] = new Array(256);
    let offset = 0;
    for (let byte = 0; byte < 256; byte++) {
        const isPrintable =
            (byte >= 33 && byte <= 126) ||
            (byte >= 161 && byte <= 172) ||
            (byte >= 174 && byte <= 255);
        table[byte] = String.fromCharCode(isPrintable ? byte : 256 + offset);
        if (!isPrintable) offset++;
    }
    return table;
})();

const TEXT_ENCODER = new TextEncoder();

/** 预分词正则，模块级复用（splitIsolated 依赖 lastIndex）。 */
const NUMBER_RE = /\p{N}{1,3}/gu;
const CJK_RE = /[一-龥぀-ゟ゠-ヿ]+/gu;
const SPLIT_RE =
    /[!\x22#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** 按 Isolated 语义切分：匹配段独立成块，其余按原样保留。 */
function splitIsolated(text: string, pattern: RegExp, out: string[]): void {
    let last = 0;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index));
        out.push(match[0]);
        last = match.index + match[0].length;
        if (match[0].length === 0) pattern.lastIndex = pattern.lastIndex + 1;
    }
    if (last < text.length) out.push(text.slice(last));
}

/** 是否含 CJK 字符：纯 ASCII 文本可跳过 CJK 切分。 */
function hasCjk(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0x4e00 && code <= 0x9fa5) return true;
    }
    return false;
}

/** 依次应用三条 Split 规则。 */
function preSplit(text: string): string[] {
    const byNumber: string[] = [];
    splitIsolated(text, NUMBER_RE, byNumber);

    const byCjk: string[] = [];
    if (hasCjk(text)) {
        for (const piece of byNumber) splitIsolated(piece, CJK_RE, byCjk);
    } else {
        for (const piece of byNumber) byCjk.push(piece);
    }

    const bySplit: string[] = [];
    for (const piece of byCjk) splitIsolated(piece, SPLIT_RE, bySplit);
    return bySplit;
}

export class DeepSeekTokenizer {
    private readonly vocab: Record<string, number>;
    private readonly added: Array<{ id: number; content: string }>;
    private readonly rankByPair: Map<number, number>;
    private readonly mergeResult: Map<number, number>;
    private readonly symbolId: Map<string, number>;
    private readonly symbols: string[];

    constructor(json: TokenizerJSON) {
        this.vocab = json.model.vocab;
        this.rankByPair = new Map();
        this.mergeResult = new Map();
        this.symbolId = new Map();
        this.symbols = [];

        for (let i = 0; i < json.model.merges.length; i++) {
            const merge = json.model.merges[i];
            const space = merge.indexOf(" ");
            const left = merge.slice(0, space);
            const right = merge.slice(space + 1);
            const leftId = this.idOf(left);
            const rightId = this.idOf(right);
            const mergedId = this.idOf(left + right);
            const pairKey = leftId * 65536 + rightId;
            this.rankByPair.set(pairKey, i);
            this.mergeResult.set(pairKey, mergedId);
        }

        // added_tokens 按长度降序，保证最长匹配优先
        this.added = json.added_tokens
            .map(token => ({ id: token.id, content: token.content }))
            .sort((a, b) => b.content.length - a.content.length);
    }

    /** 取符号的整数 id，首次出现时登记。 */
    private idOf(symbol: string): number {
        let id = this.symbolId.get(symbol);
        if (id === undefined) {
            id = this.symbols.length;
            this.symbolId.set(symbol, id);
            this.symbols.push(symbol);
        }
        return id;
    }

    /** 编码文本；special token 整体匹配，其余走 BPE。 */
    encode(text: string): number[] {
        const ids: number[] = [];
        let rest = text;

        while (rest.length > 0) {
            let hitAt = -1;
            let hitToken: { id: number; content: string } | null = null;

            for (const token of this.added) {
                const at = rest.indexOf(token.content);
                if (at >= 0 && (hitAt < 0 || at < hitAt)) {
                    hitAt = at;
                    hitToken = token;
                }
            }

            if (hitAt < 0 || hitToken === null) {
                this.encodePlain(rest, ids);
                break;
            }
            if (hitAt > 0) this.encodePlain(rest.slice(0, hitAt), ids);
            ids.push(hitToken.id);
            rest = rest.slice(hitAt + hitToken.content.length);
        }
        return ids;
    }

    /** 普通文本的 BPE 编码。 */
    private encodePlain(text: string, ids: number[]): void {
        if (text.length === 0) return;

        for (const piece of preSplit(text)) {
            const bytes = TEXT_ENCODER.encode(piece);
            if (bytes.length === 0) continue;

            let syms: number[] = [];
            for (let i = 0; i < bytes.length; i++) syms.push(this.idOf(BYTE_TO_CHAR[bytes[i]]));

            // 每轮合并 rank 最小的一对，直到没有可合并项
            while (syms.length > 1) {
                let bestRank = Infinity;
                let bestIndex = -1;
                for (let i = 0; i < syms.length - 1; i++) {
                    const rank = this.rankByPair.get(syms[i] * 65536 + syms[i + 1]);
                    if (rank !== undefined && rank < bestRank) {
                        bestRank = rank;
                        bestIndex = i;
                    }
                }
                if (bestIndex < 0) break;

                const merged = this.mergeResult.get(syms[bestIndex] * 65536 + syms[bestIndex + 1]) as number;
                const next: number[] = [];
                for (let i = 0; i < syms.length; i++) {
                    if (i === bestIndex) {
                        next.push(merged);
                        i++;
                    } else {
                        next.push(syms[i]);
                    }
                }
                syms = next;
            }

            for (const symbol of syms) {
                const id = this.vocab[this.symbols[symbol]];
                if (id !== undefined) ids.push(id);
            }
        }
    }
}
