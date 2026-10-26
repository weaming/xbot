/**
 * 远端 MCP 服务的 OAuth 客户端（授权码 + PKCE）
 *
 * 流程：RFC 9728 资源元数据发现 → RFC 8414 授权服务器发现 →
 * RFC 7591 动态客户端注册（未配置静态 clientId 时）→ 授权码 + PKCE →
 * 令牌落盘复用（含 refresh_token 自动续期）。
 *
 * 回调按 RFC 8252 原生应用约定监听 127.0.0.1 的随机或固定端口；
 * 凭据默认存于 $ZBOT_STATE_DIR/mcp-auth/<server>.json（0600）。
 */

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { auth } from "@modelcontextprotocol/client";

import type {
    AuthResult,
    OAuthClientInformationContext,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    StoredOAuthClientInformation,
    StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ResolvedMcpOAuthConfig } from "./config.js";

/** 回调路径：http://127.0.0.1:<port>/callback?code=... */
const OAUTH_CALLBACK_PATH = "/callback";

const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

export interface McpOAuthLogEvent {
    server: string;
    text: string;
    /** 需要用户打开完成授权的链接 */
    url?: string;
    level: "info" | "warn" | "error";
}

export interface McpOAuthClientOptions extends Omit<ResolvedMcpOAuthConfig, "clientName"> {
    serverName: string;
    serverUrl: string;
    /** 授权页展示的客户端名称，默认 zbot-<server> */
    clientName?: string;
    /** 授权链接就绪 / 流程进展通知（TUI 侧展示，日志兜底） */
    onEvent?: (event: McpOAuthLogEvent) => void;
}

/** 落盘结构：与 SDK 的 OAuthClientProvider 生命周期一一对应 */
interface OAuthStoreData {
    server?: string;
    serverUrl?: string;
    /** 上次使用的回环回调端口，复用可保持 redirect_uri 不变 */
    callbackPort?: number;
    clientInformation?: StoredOAuthClientInformation;
    tokens?: StoredOAuthTokens;
    codeVerifier?: string;
    discoveryState?: OAuthDiscoveryState;
    resourceUrl?: string;
}

/** 解析默认凭据文件：$ZBOT_STATE_DIR/mcp-auth/<server>.json */
export function resolveOAuthStorePath(serverName: string): string {
    const stateRoot = process.env.ZBOT_STATE_DIR || path.join(os.homedir(), ".zbot");
    const safeName = serverName.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(stateRoot, "mcp-auth", `${safeName}.json`);
}

/** 单文件凭据存储：0600 权限，原子写入 */
class OAuthStore {
    constructor(readonly file: string) {}

    read(): OAuthStoreData {
        try {
            if (!fs.existsSync(this.file)) return {};
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            // 文件损坏时按空凭据处理，重新走注册与授权
            return {};
        }
    }

    write(patch: Partial<OAuthStoreData>): void {
        const data = { ...this.read(), ...patch };
        for (const key of Object.keys(patch) as (keyof OAuthStoreData)[]) {
            if (patch[key] === undefined) delete data[key];
        }

        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
}

/**
 * 回环回调服务：等待授权服务器重定向过来的 code / iss 参数
 */
export class OAuthCallbackServer {
    private pending: { resolve: (params: URLSearchParams) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
    /** 用户比客户端更早回调时的暂存，等待方接手后立即消费 */
    private buffered: URLSearchParams | null = null;

    private constructor(readonly port: number, private readonly server: http.Server) {}

    static async start(preferredPort?: number): Promise<OAuthCallbackServer> {
        const server = http.createServer();
        let port: number;
        try {
            port = await listen(server, preferredPort);
        } catch (error: any) {
            if (error?.code !== "EADDRINUSE" || !preferredPort) throw error;
            port = await listen(server, 0);
        }

        const instance = new OAuthCallbackServer(port, server);
        server.on("request", (req, res) => instance.handleRequest(req, res));
        // 回调服务不阻止进程退出：等待期间由超时定时器维持事件循环
        server.unref();
        return instance;
    }

    get redirectUrl(): string {
        return `http://127.0.0.1:${this.port}${OAUTH_CALLBACK_PATH}`;
    }

    get isWaiting(): boolean {
        return this.pending !== null;
    }

    /** 等待回调参数；超时或授权失败时 reject */
    waitForCallback(timeoutMs: number = DEFAULT_AUTH_TIMEOUT_MS): Promise<URLSearchParams> {
        if (this.buffered) {
            const params = this.buffered;
            this.buffered = null;
            return Promise.resolve(params);
        }

        this.cancelPending(new Error("授权流程被新的等待请求取代"));

        return new Promise<URLSearchParams>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending = null;
                reject(new Error(`等待浏览器授权超时（${Math.round(timeoutMs / 1000)}s）`));
            }, timeoutMs);
            this.pending = { resolve, reject, timer };
        });
    }

    cancelPending(error: Error = new Error("授权已取消")): void {
        if (!this.pending) return;
        const { reject, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        reject(error);
    }

    async close(): Promise<void> {
        this.cancelPending(new Error("OAuth 回调服务已关闭"));
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
        if (url.pathname !== OAUTH_CALLBACK_PATH) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
            return;
        }

        const params = url.searchParams;
        const error = params.get("error");
        if (error) {
            const description = params.get("error_description");
            const detail = description ? `${error}: ${description}` : error;
            this.deliver(null, new Error(`授权被拒绝：${detail}`));
            res.writeHead(400, HTML_HEADERS).end(renderPage("授权失败", detail));
            return;
        }

        if (!params.get("code")) {
            const message = "回调缺少 code 参数";
            this.deliver(null, new Error(message));
            res.writeHead(400, HTML_HEADERS).end(renderPage("授权失败", message));
            return;
        }

        this.deliver(params, null);
        res.writeHead(200, HTML_HEADERS).end(renderPage("授权成功", "已完成授权，可以关闭此页面并回到 zbot。"));
    }

    /** 回调参数交给等待方；无人等待时暂存，等下一个等待方接手 */
    private deliver(params: URLSearchParams | null, error: Error | null): void {
        if (!this.pending) {
            if (params) this.buffered = params;
            return;
        }

        const { resolve, reject, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(params!);
    }
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function renderPage(title: string, message: string): string {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
        `<div style="text-align:center"><h2>${title}</h2><p style="color:#666">${message}</p></div></body></html>`;
}

function listen(server: http.Server, port: number | undefined): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
            server.removeListener("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            const address = server.address();
            resolve(address && typeof address === "object" ? address.port : (port ?? 0));
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port ?? 0, "127.0.0.1");
    });
}

/**
 * OAuthClientProvider 实现：状态全部落到单文件，可跨进程复用
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
    private authorizationUrl: URL | null = null;

    constructor(
        private readonly options: {
            store: OAuthStore;
            redirectUrl: string;
            clientName: string;
            scope?: string;
            clientId?: string;
            clientSecret?: string;
            onRedirect?: (url: URL) => void;
        },
    ) {}

    get redirectUrl(): string {
        return this.options.redirectUrl;
    }

    /** 最近一次生成的授权链接（等待用户点击期间可见） */
    get pendingAuthorizationUrl(): string | undefined {
        return this.authorizationUrl?.toString();
    }

    get clientMetadata(): OAuthClientMetadata {
        const { clientName, scope, clientSecret, redirectUrl } = this.options;
        return {
            redirect_uris: [redirectUrl],
            client_name: clientName,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: clientSecret ? "client_secret_basic" : "none",
            ...(scope ? { scope } : {}),
        };
    }

    clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
        const { clientId, clientSecret } = this.options;
        if (clientId) {
            return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
        }

        const stored = this.options.store.read().clientInformation;
        if (!stored) return undefined;
        if (ctx?.issuer && stored.issuer && stored.issuer !== ctx.issuer) return undefined;
        return stored;
    }

    saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
        this.options.store.write({ clientInformation });
    }

    tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
        const tokens = this.options.store.read().tokens;
        if (!tokens) return undefined;
        if (ctx?.issuer && tokens.issuer && tokens.issuer !== ctx.issuer) return undefined;
        return tokens;
    }

    saveTokens(tokens: StoredOAuthTokens): void {
        this.options.store.write({ tokens });
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.options.store.write({ codeVerifier });
    }

    codeVerifier(): string {
        const verifier = this.options.store.read().codeVerifier;
        if (!verifier) throw new Error("缺少 PKCE code verifier，请重新发起授权");
        return verifier;
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.options.store.write({ discoveryState: state });
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.options.store.read().discoveryState;
    }

    saveResourceUrl(resourceUrl: string): void {
        this.options.store.write({ resourceUrl });
    }

    resourceUrl(): string | undefined {
        return this.options.store.read().resourceUrl;
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.authorizationUrl = authorizationUrl;
        this.options.onRedirect?.(authorizationUrl);
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        const patch: Partial<OAuthStoreData> = {};
        if (scope === "all" || scope === "client") patch.clientInformation = undefined;
        if (scope === "all" || scope === "tokens") patch.tokens = undefined;
        if (scope === "all" || scope === "verifier") patch.codeVerifier = undefined;
        if (scope === "all" || scope === "discovery") patch.discoveryState = undefined;
        this.options.store.write(patch);
    }
}

/**
 * 单个 MCP 服务的 OAuth 会话：持有 provider、回调服务与等待/换取令牌的流程
 */
export class McpOAuthClient {
    readonly provider: FileOAuthClientProvider;

    private constructor(
        readonly serverName: string,
        readonly serverUrl: URL,
        private readonly options: McpOAuthClientOptions,
        private readonly callbacks: OAuthCallbackServer,
        provider: FileOAuthClientProvider,
    ) {
        this.provider = provider;
    }

    static async create(options: McpOAuthClientOptions): Promise<McpOAuthClient> {
        const store = new OAuthStore(options.storePath || resolveOAuthStorePath(options.serverName));
        const storedPort = store.read().callbackPort;
        const callbacks = await OAuthCallbackServer.start(options.callbackPort ?? storedPort);

        if (storedPort !== undefined && storedPort !== callbacks.port) {
            // redirect_uri 变了：已注册客户端的回调地址失效，须重新注册
            store.write({ clientInformation: undefined });
        }
        store.write({ server: options.serverName, serverUrl: options.serverUrl, callbackPort: callbacks.port });

        const provider = new FileOAuthClientProvider({
            store,
            redirectUrl: callbacks.redirectUrl,
            clientName: options.clientName || `zbot-${options.serverName}`,
            scope: options.scope,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            onRedirect: (url) => {
                options.onEvent?.({
                    server: options.serverName,
                    level: "info",
                    text: "请在浏览器打开以下链接完成授权",
                    url: url.toString(),
                });
            },
        });

        return new McpOAuthClient(options.serverName, new URL(options.serverUrl), options, callbacks, provider);
    }

    get redirectUrl(): string {
        return this.callbacks.redirectUrl;
    }

    /** 回环回调监听端口 */
    get callbackPort(): number {
        return this.callbacks.port;
    }

    get pendingAuthorizationUrl(): string | undefined {
        return this.provider.pendingAuthorizationUrl;
    }

    hasStoredTokens(): boolean {
        return this.provider.tokens() !== undefined;
    }

    /** 授权等待超时（毫秒） */
    get authTimeoutMs(): number {
        return (this.options.authTimeoutSec ?? DEFAULT_AUTH_TIMEOUT_MS / 1000) * 1000;
    }

    /**
     * 走一遍授权流程：有可用令牌时直接 AUTHORIZED，否则返回 REDIRECT 并已触发授权链接
     */
    async authorize(): Promise<AuthResult> {
        return await auth(this.provider, {
            serverUrl: this.serverUrl,
            scope: this.options.scope,
        });
    }

    waitForCallback(timeoutMs: number = this.authTimeoutMs): Promise<URLSearchParams> {
        return this.callbacks.waitForCallback(timeoutMs);
    }

    /** 用回调参数换取令牌（PKCE 校验 + 令牌落盘） */
    async completeAuthorization(params: URLSearchParams): Promise<void> {
        const code = params.get("code");
        if (!code) throw new Error("授权回调缺少 code");

        const result = await auth(this.provider, {
            serverUrl: this.serverUrl,
            authorizationCode: code,
            iss: params.get("iss") ?? undefined,
        });
        if (result !== "AUTHORIZED") throw new Error("授权码换取令牌失败");
    }

    cancelPending(): void {
        this.callbacks.cancelPending();
    }

    async close(): Promise<void> {
        await this.callbacks.close();
    }
}
