import type { ChatMessage, StoredChatMessage } from '../types/session.js';

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

/** 估算单条 ChatMessage 的 Token 占用。 */
export function estimateMessageTokens(message: ChatMessage | StoredChatMessage): number {
    let tokens = 4;
    if (typeof message.content === 'string') {
        tokens += estimateTextTokens(message.content);
    }
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
