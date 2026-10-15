const MAX_BASH_PROGRESS_CHARS = 1800;
const MAX_TOOL_ARGUMENT_CHARS = 200;
const MAX_TOOL_ARGUMENT_PREVIEW_CHARS = 120;

export function isShellCommandTool(toolName: string): boolean {
    const normalizedName = toolName.toLowerCase();
    return normalizedName === "bash"
        || normalizedName === "fish"
        || normalizedName.endsWith("__bash")
        || normalizedName.endsWith("__fish");
}

function isHostShellTool(toolName: string): boolean {
    const normalizedName = toolName.toLowerCase();
    return normalizedName.endsWith("__bash") || normalizedName.endsWith("__fish");
}

function getShellCommands(argumentsValue: any): string[] {
    if (Array.isArray(argumentsValue?.commands)) {
        return argumentsValue.commands.filter((command: unknown): command is string => typeof command === "string");
    }
    if (typeof argumentsValue?.command === "string") {
        return [argumentsValue.command];
    }
    return [];
}

export function formatToolProgress(toolName: string, argumentsValue: any): string {
    if (isShellCommandTool(toolName)) {
        const commands = getShellCommands(argumentsValue);
        if (commands.length === 0) return toolName;

        const content = isHostShellTool(toolName)
            ? `$ ${commands.join(" | ")}`
            : commands.map((command) => `$ ${command}`).join("\n");
        const truncatedContent = content.length > MAX_BASH_PROGRESS_CHARS
            ? `${content.slice(0, MAX_BASH_PROGRESS_CHARS)}...`
            : content;
        return `${toolName}\n${truncatedContent}`;
    }

    // 非 shell 工具：参数非空时以 name=value 摘要显示，空参数只显示工具名
    return formatBuiltinToolProgress(toolName, argumentsValue);
}

function hasToolArguments(argumentsValue: any): boolean {
    if (argumentsValue === null || argumentsValue === undefined) return false;
    if (typeof argumentsValue === "string") return argumentsValue.length > 0;
    if (Array.isArray(argumentsValue)) return argumentsValue.length > 0;
    if (typeof argumentsValue === "object") return Object.keys(argumentsValue).length > 0;
    return true;
}

function formatToolArgumentValue(value: any): string {
    if (typeof value === "string") {
        if (value.length > MAX_TOOL_ARGUMENT_CHARS) {
            const preview = value.slice(0, MAX_TOOL_ARGUMENT_PREVIEW_CHARS).replaceAll("`", "\\`");
            return `\`${preview}…\` (共 ${value.length} 字符)`;
        }
        if (value.length === 0 || /\s/.test(value)) {
            return `\`${value.replaceAll("`", "\\`")}\``;
        }
        return value;
    }

    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object") {
        const json = JSON.stringify(value);
        if (json.length > MAX_TOOL_ARGUMENT_CHARS) {
            return `\`${json.slice(0, MAX_TOOL_ARGUMENT_PREVIEW_CHARS)}…\` (共 ${json.length} 字符)`;
        }
        return json;
    }
    return String(value);
}

export function formatToolArguments(argumentsValue: any): string {
    if (!hasToolArguments(argumentsValue)) return "";

    if (typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
        return formatToolArgumentValue(argumentsValue);
    }

    return Object.entries(argumentsValue)
        .map(([name, value]) => `${name}=${formatToolArgumentValue(value)}`)
        .join(" ");
}

export function formatBuiltinToolProgress(toolName: string, argumentsValue: any): string {
    const formattedArguments = formatToolArguments(argumentsValue);
    return formattedArguments ? `${toolName} ${formattedArguments}` : toolName;
}

export function formatAccumulatedToolProgress(toolName: string, argumentsValues: any[]): string {
    if (!isShellCommandTool(toolName)) return toolName;

    const content = argumentsValues
        .map((argumentsValue) => {
            const commands = getShellCommands(argumentsValue);
            if (commands.length === 0) return "";

            return isHostShellTool(toolName)
                ? `$ ${commands.join(" | ")}`
                : commands.map((command) => `$ ${command}`).join("\n");
        })
        .filter(Boolean)
        .join("\n");

    if (!content) return toolName;

    const truncatedContent = content.length > MAX_BASH_PROGRESS_CHARS
        ? `${content.slice(0, MAX_BASH_PROGRESS_CHARS)}...`
        : content;
    return `${toolName}\n${truncatedContent}`;
}
