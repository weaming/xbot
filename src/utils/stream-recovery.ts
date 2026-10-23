import type { StreamDelta } from "../types/chat.js";
import type { ChatMessage } from "../types/session.js";

interface PartialToolCall {
    name: string;
    arguments: string;
    thoughtSignature?: string;
}

/** 把流式检查点还原成不可执行的助手消息。 */
export function partialAssistantMessage(
    content: string,
    reasoning: string,
    toolCalls: PartialToolCall[],
): ChatMessage | undefined {
    const callText = toolCalls.map(call => {
        const signature = call.thoughtSignature ? ` thought_signature=${call.thoughtSignature}` : "";
        return `\n\n[未完成的工具调用：${call.name} ${call.arguments}${signature}]`;
    }).join("");
    if (!content && !reasoning && !callText) return undefined;
    return {
        role: "assistant",
        content: content + callText || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
    };
}

/** 每个回合只恢复最后一个尚未定稿的 provider 请求。 */
export class StreamRecovery {
    private requestIndex = -1;
    private content = "";
    private reasoning = "";
    private readonly toolCalls = new Map<number, PartialToolCall>();

    push(requestIndex: number, delta: StreamDelta): void {
        if (requestIndex < this.requestIndex) return;
        if (requestIndex > this.requestIndex) this.reset(requestIndex);

        this.content += delta.text ?? "";
        this.reasoning += delta.reasoning ?? "";
        for (const call of delta.toolCalls ?? []) {
            const current = this.toolCalls.get(call.index) ?? { name: "", arguments: "" };
            if (call.name) current.name = call.name;
            if (call.arguments) current.arguments += call.arguments;
            if (call.thoughtSignature) current.thoughtSignature = call.thoughtSignature;
            this.toolCalls.set(call.index, current);
        }
    }

    clear(): void {
        this.reset(-1);
    }

    message(): ChatMessage | undefined {
        return partialAssistantMessage(this.content, this.reasoning, [...this.toolCalls.values()]);
    }

    private reset(requestIndex: number): void {
        this.requestIndex = requestIndex;
        this.content = "";
        this.reasoning = "";
        this.toolCalls.clear();
    }
}
