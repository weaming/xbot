import type { ChatApiProtocol } from "../types/chat-model.js";

export type ReasoningProvider = "openai" | "deepseek" | "codex_responses";

export interface ReasoningEffortRequest {
    protocol: ChatApiProtocol;
    provider: ReasoningProvider;
    effort?: string;
    configuredEfforts?: string[];
}

export function buildReasoningEffortParams(input: ReasoningEffortRequest): Record<string, unknown> {
    const effort = input.effort?.trim().toLowerCase();
    if (!effort || effort === "auto") return {};
    const parsedConfiguredEfforts = input.configuredEfforts?.map(value => value.trim().toLowerCase()).filter(Boolean);
    const configuredEfforts = parsedConfiguredEfforts?.length ? parsedConfiguredEfforts : undefined;
    if (configuredEfforts && !configuredEfforts.includes(effort)) {
        throw new Error(`思考强度 ${input.effort} 不在配置的可选值中：${configuredEfforts.join(", ")}`);
    }
    const effortChoices = getReasoningEffortChoices(input.protocol, input.provider);
    if (!configuredEfforts && !effortChoices.includes(effort)) {
        throw new Error(`不支持的思考强度: ${input.effort}`);
    }

    if (input.provider === "deepseek") {
        return buildDeepSeekParams(input.protocol, effort);
    }
    if (input.provider === "codex_responses") {
        return { reasoning: { effort } };
    }

    return input.protocol === "responses"
        ? { reasoning: { effort } }
        : { reasoning_effort: effort };
}

export function getReasoningEffortChoices(
    protocol: ChatApiProtocol,
    provider: ReasoningProvider,
    configuredEfforts?: string[],
): string[] {
    if (configuredEfforts?.length) {
        return [...new Set(configuredEfforts
            .map(value => value.trim().toLowerCase())
            .filter(value => value && value !== "auto"))];
    }
    if (provider === "deepseek") {
        return ["none", "low", "high", "max"];
    }
    if (provider === "codex_responses") {
        return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    }
    if (protocol === "responses") {
        return ["none", "minimal", "low", "medium", "high", "xhigh"];
    }
    return ["none", "minimal", "low", "medium", "high", "xhigh"];
}

export function getReasoningProvider(
    protocol: ChatApiProtocol,
    model: string,
    apiBase: string,
): ReasoningProvider {
    const modelName = model.toLowerCase();
    let endpoint: URL | undefined;
    try {
        endpoint = new URL(apiBase);
    } catch {
        endpoint = undefined;
    }

    if (modelName.includes("deepseek") || endpoint?.hostname === "api.deepseek.com") return "deepseek";
    if (protocol === "responses" && endpoint?.port === "3060") return "codex_responses";
    return "openai";
}

function buildDeepSeekParams(protocol: ChatApiProtocol, effort: string): Record<string, unknown> {
    if (protocol === "responses") {
        return { reasoning: { effort } };
    }

    if (effort === "none") return { reasoning_effort: effort };
    return {
        thinking: { type: "enabled" },
        reasoning_effort: effort,
    };
}
