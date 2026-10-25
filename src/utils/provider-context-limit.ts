/** 识别 provider 明确返回的 HTTP 400 输入超窗错误，并读取实际窗口上限。 */
export function getPromptTooLongLimit(error: unknown): number | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const explicitStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const isBadRequest = Number.isFinite(explicitStatus)
        ? explicitStatus === 400
        : /(?:^\s*400\b|\bHTTP\s+400\b)/i.test(message);
    if (!isBadRequest) return undefined;

    const match = message.match(/prompt is too long:\s*([\d,]+)\s*tokens\s*>\s*([\d,]+)\s*maximum/i);
    if (!match) return undefined;
    const requested = Number(match[1]!.replaceAll(",", ""));
    const maximum = Number(match[2]!.replaceAll(",", ""));
    return Number.isSafeInteger(requested) && Number.isSafeInteger(maximum)
        && requested > maximum && maximum > 0 ? maximum : undefined;
}

/** 仅识别上游明确拒绝空 assistant 消息的 HTTP 400。 */
export function isInvalidAssistantMessageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const isBadRequest = Number.isFinite(status)
        ? status === 400
        : /(?:^\s*400\b|\bHTTP\s+400\b)/i.test(message);
    return isBadRequest && /Invalid assistant message:\s*content or tool_calls must be set/i.test(message);
}
