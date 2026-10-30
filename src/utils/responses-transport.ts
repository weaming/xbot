/** 判断 Responses 是否使用 WebSocket。 */
export function isResponsesWebSocketEnabled(value = process.env.OPENAI_RESPONSES_WEBSOCKET, model?: string): boolean {
    return value === undefined ? isGptModel(model) : ["true", "1"].includes(value.trim().toLowerCase());
}

/** 是否允许上游保存 Responses。 */
export function isResponsesStoreEnabled(value = process.env.OPENAI_RESPONSES_STORE): boolean {
    return value !== undefined && ["true", "1"].includes(value.trim().toLowerCase());
}

export function isGptModel(model?: string): boolean {
    return /^(?:openai\/)?gpt-/i.test(model?.trim() ?? "");
}

/** 返回状态栏中的协议名称。 */
export function protocolStatusLabel(protocol: string | undefined, model?: string): string {
    if (protocol !== "responses") return "Chat";
    return isResponsesWebSocketEnabled(undefined, model) ? "Responses in WS" : "Responses";
}
