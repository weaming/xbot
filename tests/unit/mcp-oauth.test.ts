import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { useTmpWorkspace } from "./test-env.js";

import { interpolateConfig, resolveMcpOAuthConfig } from "../../src/mcp/config.js";
import { McpOAuthClient, OAuthCallbackServer, resolveOAuthStorePath } from "../../src/mcp/oauth.js";

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("mcp oauth config", () => {
    test("resolveMcpOAuthConfig：未配置 / stdio 返回 null，启用时补默认客户端名", () => {
        expect(resolveMcpOAuthConfig({ name: "a", type: "http" })).toBeNull();
        expect(resolveMcpOAuthConfig({ name: "a", type: "stdio", oauth: true })).toBeNull();

        const resolved = resolveMcpOAuthConfig({ name: "alphaxiv", type: "http", oauth: true });
        expect(resolved).toEqual({ clientName: "xbot-alphaxiv" });

        const custom = resolveMcpOAuthConfig({
            name: "alphaxiv",
            type: "http",
            oauth: { clientId: "cid", scope: "email profile", callbackPort: 45236, clientName: "custom" },
        });
        expect(custom).toMatchObject({ clientId: "cid", scope: "email profile", callbackPort: 45236, clientName: "custom" });
    });

    test("interpolateConfig 展开 oauth 中的环境变量与波浪号", () => {
        process.env.TEST_MCP_OAUTH_SECRET = "s3cret";
        const config = interpolateConfig({
            name: "a",
            type: "http",
            oauth: { clientId: "cid-${TEST_MCP_OAUTH_SECRET}", storePath: "~/oauth.json" },
        });
        delete process.env.TEST_MCP_OAUTH_SECRET;

        expect(config.oauth).toMatchObject({
            clientId: "cid-s3cret",
            storePath: path.join(os.homedir(), "oauth.json"),
        });
    });

    test("resolveOAuthStorePath 落在 XBOT_STATE_DIR/mcp-auth 下", () => {
        const workspace = useTmpWorkspace("xbot-oauth-path-");
        try {
            expect(resolveOAuthStorePath("my server/1")).toBe(path.join(workspace.dir, "mcp-auth", "my_server_1.json"));
        } finally {
            workspace.cleanup();
        }
    });
});

describe("mcp oauth callback server", () => {
    test("等待回调：拿到 code / iss，未知路径 404", async () => {
        const server = await OAuthCallbackServer.start();
        try {
            expect(server.redirectUrl).toBe(`http://127.0.0.1:${server.port}/callback`);

            const waiting = server.waitForCallback(5_000);
            const res = await fetch(`${server.redirectUrl}?code=abc&iss=https%3A%2F%2Fas.example`);
            expect(res.status).toBe(200);

            const params = await waiting;
            expect(params.get("code")).toBe("abc");
            expect(params.get("iss")).toBe("https://as.example");

            const notFound = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
            expect(notFound.status).toBe(404);
        } finally {
            await server.close();
        }
    });

    test("回调早于等待时先暂存，后续等待立即命中", async () => {
        const server = await OAuthCallbackServer.start();
        try {
            await fetch(`${server.redirectUrl}?code=early`);
            const params = await server.waitForCallback(1_000);
            expect(params.get("code")).toBe("early");
        } finally {
            await server.close();
        }
    });

    test("授权失败回调 reject，超时 reject", async () => {
        const server = await OAuthCallbackServer.start();
        try {
            // 先挂上 catch，避免回调 reject 时无处理程序
            const failing = server.waitForCallback(5_000).then(() => null, (error: Error) => error);
            await fetch(`${server.redirectUrl}?error=access_denied&error_description=nope`);
            expect((await failing)?.message).toContain("access_denied");

            await expect(server.waitForCallback(30)).rejects.toThrow("超时");
        } finally {
            await server.close();
        }
    });

    test("端口被占用时回退到随机端口", async () => {
        const first = await OAuthCallbackServer.start();
        try {
            const second = await OAuthCallbackServer.start(first.port);
            try {
                expect(second.port).not.toBe(first.port);
            } finally {
                await second.close();
            }
        } finally {
            await first.close();
        }
    });
});

describe("mcp oauth client", () => {
    test("凭据落盘复用：clientMetadata、tokens、issuer 隔离、invalidate", async () => {
        const dir = tmpDir("xbot-oauth-store-");
        const storePath = path.join(dir, "alphaxiv.json");
        const client = await McpOAuthClient.create({
            serverName: "alphaxiv",
            serverUrl: "https://api.alphaxiv.org/mcp/v1",
            storePath,
        });

        try {
            expect(client.redirectUrl).toBe(`http://127.0.0.1:${new URL(client.redirectUrl).port}/callback`);
            expect(client.hasStoredTokens()).toBe(false);

            const provider = client.provider;
            expect(provider.clientMetadata).toMatchObject({
                redirect_uris: [client.redirectUrl],
                client_name: "xbot-alphaxiv",
                grant_types: ["authorization_code", "refresh_token"],
                token_endpoint_auth_method: "none",
            });

            provider.saveTokens({ access_token: "at-1", token_type: "Bearer", issuer: "https://api.alphaxiv.org/auth" });
            provider.saveClientInformation({ client_id: "cid", issuer: "https://api.alphaxiv.org/auth" });
            expect(provider.tokens()?.access_token).toBe("at-1");
            expect(provider.clientInformation()?.client_id).toBe("cid");

            // issuer 不一致视为不可用，触发重新授权 / 注册
            expect(provider.tokens({ issuer: "https://other.example" })).toBeUndefined();
            expect(provider.clientInformation({ issuer: "https://other.example" })).toBeUndefined();

            // 凭据文件权限 0600
            expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);

            // 新进程（新实例）读到同一份凭据
            const reopened = await McpOAuthClient.create({
                serverName: "alphaxiv",
                serverUrl: "https://api.alphaxiv.org/mcp/v1",
                storePath,
                callbackPort: client.callbackPort,
            });
            try {
                expect(reopened.hasStoredTokens()).toBe(true);
                expect(reopened.provider.tokens()?.access_token).toBe("at-1");
            } finally {
                await reopened.close();
            }

            provider.invalidateCredentials("all");
            expect(provider.tokens()).toBeUndefined();
            expect(provider.clientInformation()).toBeUndefined();
        } finally {
            await client.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("静态 clientId 直接作为客户端凭据，回调端口复用失败时清除注册信息", async () => {
        const dir = tmpDir("xbot-oauth-static-");
        const storePath = path.join(dir, "static.json");

        const first = await McpOAuthClient.create({
            serverName: "static",
            serverUrl: "https://example.com/mcp",
            storePath,
            clientId: "pre-registered",
            clientSecret: "sec",
        });
        const port = new URL(first.redirectUrl).port;
        try {
            expect(first.provider.clientInformation()).toEqual({ client_id: "pre-registered", client_secret: "sec" });
            expect(first.provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_basic");
            first.provider.saveClientInformation({ client_id: "dynamic" });
        } finally {
            await first.close();
        }

        // 端口被占：回退随机端口 → 已注册的 redirect_uri 失效，须重新注册
        const blocker = await OAuthCallbackServer.start(Number(port));
        const second = await McpOAuthClient.create({
            serverName: "static",
            serverUrl: "https://example.com/mcp",
            storePath,
            callbackPort: Number(port),
        });
        try {
            expect(second.callbackPort).not.toBe(Number(port));
            expect(second.provider.clientInformation()).toBeUndefined();
        } finally {
            await second.close();
            await blocker.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
