/**
 * MCP 工具过滤与转换规则
 * 支持 includeTools（白名单通配/正则）、excludeTools（黑名单通配/正则）、prefix（前缀）和 rename（重命名）
 */

export interface ToolFilterConfig {
    /** 白名单：仅保留匹配任一 pattern 的工具；未指定或为空则不过滤 */
    includeTools?: string[];
    /** 黑名单：剔除匹配任一 pattern 的工具 */
    excludeTools?: string[];
    /** 名称前缀：为工具添加统一前缀 */
    prefix?: string;
    /** 工具重命名映射：{ [rawName: string]: newName } */
    rename?: Record<string, string>;
}

export interface RawRemoteToolDef {
    name: string;
    description?: string;
    inputSchema: any;
}

export interface FilteredToolDef {
    /** 远程 server 上的原始工具名称，执行 RPC 时必须使用此名称 */
    rawName: string;
    /** 处理后的工具定义（名称可能已重命名或添加前缀） */
    toolDef: RawRemoteToolDef;
}

/**
 * 默认前缀 `<serverName>__`：不同 server 的同名工具在 catalog 里会互相顶掉（后来者被跳过），
 * 加前缀让每个 server 独占自己的命名空间。名字只保留 OpenAI function 允许的字符。
 */
function defaultToolPrefix(serverName?: string): string {
    const name = (serverName ?? "").trim();
    if (!name) return "";
    return `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
}

/**
 * 匹配工具名称与 pattern
 * 支持:
 * 1. 精确匹配: "quote"
 * 2. 通配符 (*, ?): "local_*", "*search*"
 * 3. 正则表达式: "/^local_/i"
 */
export function matchToolPattern(pattern: string, toolName: string): boolean {
    if (!pattern || !toolName) return false;
    const trimmed = pattern.trim();
    if (trimmed === "*" || trimmed === toolName) return true;

    // 正则表达式形式: /pattern/flags
    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
        const lastSlash = trimmed.lastIndexOf("/");
        const regexStr = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1);
        try {
            const regex = new RegExp(regexStr, flags);
            return regex.test(toolName);
        } catch {
            // 格式错误时回退为普通匹配
        }
    }

    // 通配符 Glob (*, ?) 转为正则表达式
    const regexPattern =
        "^" +
        trimmed
            .replace(/([.+^=!:${}()|\[\]\/\\])/g, "\\$1")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
        "$";

    try {
        return new RegExp(regexPattern).test(toolName);
    } catch {
        return trimmed === toolName;
    }
}

/**
 * 执行工具过滤与重命名流水线
 */
export function filterAndTransformTools(
    tools: RawRemoteToolDef[],
    filterConfig?: ToolFilterConfig,
    serverName?: string,
): FilteredToolDef[] {
    const { includeTools, excludeTools, prefix, rename } = filterConfig ?? {};
    // 显式 prefix 覆盖默认前缀；两者都没有（未传 serverName）时保持原名。
    const effectivePrefix = prefix ?? defaultToolPrefix(serverName);
    const results: FilteredToolDef[] = [];

    for (const tool of tools) {
        const rawName = tool.name;

        // 1. 白名单检查（若配置且非空，必须匹配至少一个）
        if (includeTools && includeTools.length > 0) {
            const matched = includeTools.some((pat) => matchToolPattern(pat, rawName));
            if (!matched) continue;
        }

        // 2. 黑名单检查（若匹配任一个则剔除）
        if (excludeTools && excludeTools.length > 0) {
            const excluded = excludeTools.some((pat) => matchToolPattern(pat, rawName));
            if (excluded) continue;
        }

        // 3. 重命名或前缀
        let newName = rawName;
        if (rename && rename[rawName]) {
            newName = rename[rawName];
        } else if (effectivePrefix && !newName.startsWith(effectivePrefix)) {
            newName = `${effectivePrefix}${newName}`;
        }

        results.push({
            rawName,
            toolDef: {
                ...tool,
                name: newName,
            },
        });
    }

    return results;
}
