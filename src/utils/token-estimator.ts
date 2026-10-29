import type { ChatMessage, StoredChatMessage } from '../types/session.js';

/**
 * 图片/音频无法在本地精确分词，按上游常见的视觉/音频档位估值。
 * 宁可估高：低估会让判定漏过阈值，直接以上游 400 结束。
 */
const IMAGE_TOKENS_ESTIMATE = 1_100;
const AUDIO_TOKENS_ESTIMATE = 1_500;

/** 估算纯文本的 Token 数，兼顾中英文、代码与标点。 */
export function estimateTextTokens(text: string): number {
    if (!text) return 0;

    let cjkCount = 0;
    let otherCount = 0;

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0xf900 && code <= 0xfaff)
        ) {
            cjkCount++;
        } else {
            otherCount++;
        }
    }

    return Math.max(1, Math.ceil(cjkCount * 1.2 + otherCount / 3.5));
}

/** 多模态本地元数据的固定估值（图片/音频不含可分词文本）。 */
export function estimateMediaTokens(message: ChatMessage | StoredChatMessage): number {
    const media = message as { imageContent?: unknown; audioContent?: unknown };
    const images = Array.isArray(media.imageContent) ? media.imageContent.length : 0;
    const audios = Array.isArray(media.audioContent) ? media.audioContent.length : 0;
    return images * IMAGE_TOKENS_ESTIMATE + audios * AUDIO_TOKENS_ESTIMATE;
}

/** 消息内容拆成「可分词文本 + 媒体块数量」：user 消息带图时 content 是数组，不能只按 string 数。 */
export interface ContentParts {
    texts: string[];
    images: number;
    audios: number;
}

export function splitContentParts(content: unknown): ContentParts {
    if (typeof content === 'string') return { texts: [content], images: 0, audios: 0 };
    if (!Array.isArray(content)) return { texts: [], images: 0, audios: 0 };

    const parts: ContentParts = { texts: [], images: 0, audios: 0 };
    for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block?.text === 'string') {
            parts.texts.push(block.text);
        } else if (block?.type === 'image_url' || block?.type === 'image_asset') {
            parts.images += 1;
        } else if (block?.type === 'input_audio') {
            parts.audios += 1;
        }
    }
    return parts;
}

/** 媒体块（内容数组里的图片/音频）的固定估值。 */
export function estimateContentMediaTokens(parts: ContentParts): number {
    return parts.images * IMAGE_TOKENS_ESTIMATE + parts.audios * AUDIO_TOKENS_ESTIMATE;
}

/** 上行会带上的思维链文本：assistant 消息的 reasoning_content 不属于 content，但同样计费。 */
export function getReasoningContent(message: ChatMessage | StoredChatMessage): string {
    if (message.role !== 'assistant') return '';
    const reasoning = (message as { reasoning_content?: unknown }).reasoning_content;
    return typeof reasoning === 'string' ? reasoning : '';
}

/** 估算单条 ChatMessage 的 Token 占用。 */
export function estimateMessageTokens(message: ChatMessage | StoredChatMessage): number {
    let tokens = 4;
    const parts = splitContentParts(message.content);
    for (const text of parts.texts) {
        tokens += estimateTextTokens(text);
    }
    tokens += estimateContentMediaTokens(parts);
    const reasoning = getReasoningContent(message);
    if (reasoning) tokens += estimateTextTokens(reasoning);
    tokens += estimateMediaTokens(message);
    if ('tool_calls' in message && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            tokens += 10;
            if (toolCall.function?.name) tokens += estimateTextTokens(toolCall.function.name);
            if (toolCall.function?.arguments) tokens += estimateTextTokens(toolCall.function.arguments);
            if (toolCall.custom?.name) tokens += estimateTextTokens(toolCall.custom.name);
            if (typeof toolCall.custom?.input === "string") tokens += estimateTextTokens(toolCall.custom.input);
        }
    }
    return tokens;
}
