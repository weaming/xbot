export type ChatApiProtocol = "responses" | "chat_completions";

export interface ChatModelSelection {
    protocol: ChatApiProtocol;
    model: string;
}
