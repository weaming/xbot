/**
 * MCP 客户端配置解析与加载器
 * 支持加载 ~/.zbot/mcp-servers.yaml
 * 支持 ${VAR} 环境变量插值、requiredEnv 条件检查、tools filter 规则与 OAuth 认证
 */

import fs from "fs";
import os from "os";
import path from "path";
import * as yaml from "js-yaml";

import type { ToolFilterConfig } from "./filter.js";

type McpProtocolVersion = "2026-07-28" | "2025-11-25";

export type McpTransportType = "stdio" | "http" | "streamable-http" | "sse";

/** 远端 MCP 服务的 OAuth 客户端设置（授权码 + PKCE，回调走 127.0.0.1 回环） */
interface McpOAuthConfig {
    /** 预注册客户端 ID；缺省走 RFC 7591 动态客户端注册 */
    clientId?: string;
    /** 预注册客户端密钥；缺省按公共客户端（token_endpoint_auth_method=none）处理 */
    clientSecret?: string;
    /** 请求的 scope（空格分隔）；缺省用资源元数据 scopes_supported */
    scope?: string;
    /** 回调监听端口；缺省自动选择并记入凭据文件，下次复用 */
    callbackPort?: number;
    /** 授权等待超时（秒），默认 600 */
    authTimeoutSec?: number;
    /** 凭据文件路径，默认 $ZBOT_STATE_DIR/mcp-auth/<name>.json */
    storePath?: string;
    /** 授权页展示的客户端名称，默认 zbot-<name> */
    clientName?: string;
}

export interface McpServerConfig extends ToolFilterConfig {
    name: string;
    type: McpTransportType;
    url?: string;
    serverUrl?: string;
    protocolVersion?: McpProtocolVersion;
    legacy?: boolean;
    /** OAuth 认证：true 走默认设置，对象形式可定制客户端与回调 */
    oauth?: boolean | McpOAuthConfig;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    tags?: string[];
    source?: string;
    /** 启用 Responses tool_search 时，将该 MCP server 的工具声明为延迟加载。 */
    defer?: boolean;
    requiredEnv?: string[];
    disabled?: boolean;
}

interface McpConfigRoot {
    servers?: McpServerConfig[];
    mcpServers?: Record<string, Omit<McpServerConfig, "name"> & { name?: string }>;
}

export const DEFAULT_TUI_MCP_CONFIG_FILE = path.join(os.homedir(), ".zbot", "mcp-servers.yaml");

export function resolvePathWithTilde(inputPath: string): string {
    if (inputPath === "~") return os.homedir();
    if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
    return inputPath;
}

export function interpolateEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] || "");
}

export function interpolateConfig(config: McpServerConfig): McpServerConfig {
    const result: McpServerConfig = { ...config };

    if (result.url) result.url = interpolateEnvVars(result.url);
    if (result.serverUrl) result.serverUrl = interpolateEnvVars(result.serverUrl);
    if (result.command) result.command = interpolateEnvVars(resolvePathWithTilde(result.command));
    if (result.cwd) result.cwd = interpolateEnvVars(resolvePathWithTilde(result.cwd));
    if (result.args) result.args = result.args.map(interpolateEnvVars);

    if (result.headers) {
        const interpolated: Record<string, string> = {};
        for (const [key, val] of Object.entries(result.headers)) {
            interpolated[key] = interpolateEnvVars(val);
        }
        result.headers = interpolated;
    }

    if (result.env) {
        const interpolated: Record<string, string> = {};
        for (const [key, val] of Object.entries(result.env)) {
            interpolated[key] = interpolateEnvVars(val);
        }
        result.env = interpolated;
    }

    if (result.oauth && typeof result.oauth === "object") {
        const oauth: McpOAuthConfig = { ...result.oauth };
        if (oauth.clientId) oauth.clientId = interpolateEnvVars(oauth.clientId);
        if (oauth.clientSecret) oauth.clientSecret = interpolateEnvVars(oauth.clientSecret);
        if (oauth.scope) oauth.scope = interpolateEnvVars(oauth.scope);
        if (oauth.storePath) oauth.storePath = resolvePathWithTilde(interpolateEnvVars(oauth.storePath));
        result.oauth = oauth;
    }

    return result;
}

/** 归一化后的 OAuth 设置（已填默认值），仅用于远端传输 */
export interface ResolvedMcpOAuthConfig extends McpOAuthConfig {
    clientName: string;
}

/** 已提示过 oauth 配置无效的 server（stdio 传输），避免每次状态查询重复告警 */
const warnedIgnoredOAuth = new Set<string>();

/**
 * 解析 server 的 OAuth 设置：未启用或 stdio 传输时返回 null
 */
export function resolveMcpOAuthConfig(config: McpServerConfig): ResolvedMcpOAuthConfig | null {
    if (!config.oauth) return null;

    if (config.type === "stdio") {
        if (!warnedIgnoredOAuth.has(config.name)) {
            warnedIgnoredOAuth.add(config.name);
            console.warn(`⚠️ [MCP] Server ${config.name} 的 oauth 配置在 stdio 传输下无效，已忽略`);
        }
        return null;
    }

    const options = config.oauth === true ? {} : config.oauth;
    return {
        ...options,
        clientName: options.clientName || `zbot-${config.name}`,
    };
}

/**
 * 校验 requiredEnv 中的环境变量是否均已设置
 */
export function validateRequiredEnv(config: McpServerConfig): { valid: boolean; missingEnv?: string } {
    if (!config.requiredEnv || config.requiredEnv.length === 0) {
        return { valid: true };
    }

    for (const envVar of config.requiredEnv) {
        const val = process.env[envVar];
        if (!val || val.trim() === "") {
            return { valid: false, missingEnv: envVar };
        }
    }

    return { valid: true };
}

/**
 * 将解析出的 YAML 内容归一化为 McpServerConfig 数组
 */
export function normalizeParsedConfig(parsed: any): McpServerConfig[] {
    if (!parsed) return [];

    if (Array.isArray(parsed)) {
        return parsed.filter((item) => item && typeof item === "object" && item.name);
    }

    if (typeof parsed === "object") {
        if (Array.isArray(parsed.servers)) {
            return parsed.servers.filter((item: any) => item && typeof item === "object" && item.name);
        }

        if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
            const list: McpServerConfig[] = [];
            for (const [name, serverDef] of Object.entries(parsed.mcpServers)) {
                if (serverDef && typeof serverDef === "object") {
                    list.push({
                        ...(serverDef as any),
                        name: (serverDef as any).name || name,
                    });
                }
            }
            return list;
        }

        // key-value 直接映射形式
        const list: McpServerConfig[] = [];
        for (const [name, serverDef] of Object.entries(parsed)) {
            if (serverDef && typeof serverDef === "object" && ((serverDef as any).type || (serverDef as any).command || (serverDef as any).url)) {
                list.push({
                    ...(serverDef as any),
                    name: (serverDef as any).name || name,
                });
            }
        }
        return list;
    }

    return [];
}

export interface LoadMcpConfigOptions {
    /** 显式指定的配置文件路径，不传时依据 mode 自动判定 */
    configPath?: string;
    /** 模式：tui（只读 ~/.zbot/mcp-servers.yaml，无则不连），hub（无配置则默认连 mcp-hub），auto */
    mode?: "tui" | "hub" | "auto";
}

/**
 * 加载并解析 MCP 配置文件
 * - mode === "tui": 若 ~/.zbot/mcp-servers.yaml 不存在，返回空列表（没有则不连）
 * - mode === "hub" / 默认: 若无配置文件，返回连接 mcp-hub 的单服务默认配置
 */
export function loadMcpServersConfig(options: LoadMcpConfigOptions = {}): McpServerConfig[] {
    const explicitFile = options.configPath || process.env.ZBOT_MCP_SERVERS_FILE;
    const targetPath = explicitFile
        ? resolvePathWithTilde(explicitFile)
        : (options.mode === "tui" ? DEFAULT_TUI_MCP_CONFIG_FILE : undefined);

    if (targetPath) {
        if (!fs.existsSync(targetPath)) {
            if (options.mode === "tui") {
                console.log(`ℹ️ [MCP] TUI config file not found: ${targetPath}, skipping MCP connections.`);
                return [];
            }
            console.warn(`⚠️ [MCP] Config file not found: ${targetPath}`);
            return [];
        }

        try {
            const content = fs.readFileSync(targetPath, "utf-8");
            const parsed = yaml.load(content);
            const rawConfigs = normalizeParsedConfig(parsed);

            const configs: McpServerConfig[] = [];
            for (const raw of rawConfigs) {
                if (raw.disabled) {
                    console.log(`ℹ️ [MCP] Server ${raw.name} is disabled, skipping.`);
                    continue;
                }

                const check = validateRequiredEnv(raw);
                if (!check.valid) {
                    console.warn(`⚠️ [MCP] Server ${raw.name} skipped: required env ${check.missingEnv} is missing`);
                    continue;
                }

                configs.push(interpolateConfig(raw));
            }

            return configs;
        } catch (error: any) {
            console.error(`❌ [MCP] Failed to parse config file ${targetPath}: ${error.message}`);
            return [];
        }
    }

    // mode 为 hub 或默认且未显式指定配置文件时的行为（针对容器实例保持连接 mcp-hub）
    if (options.mode === "hub" || !options.mode) {
        const mcpHubUrl = process.env.MCP_HUB_URL || "http://localhost:3010/mcp";
        return [
            {
                name: "mcp-hub",
                type: "http",
                url: mcpHubUrl,
                protocolVersion: "2026-07-28",
            },
        ];
    }

    return [];
}
