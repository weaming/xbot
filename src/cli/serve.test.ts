import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseServeArgs, resolveServeToken } from "./serve.js";

describe("parseServeArgs", () => {
    test("缺省监听回环与默认端口", () => {
        const args = parseServeArgs(["serve"]);

        expect(args.bind).toBe("127.0.0.1");
        expect(args.port).toBe(8787);
        expect(args.cwd).toBe(process.cwd());
    });

    test("显式参数覆盖且 cwd 展开为绝对路径", () => {
        const args = parseServeArgs(["serve", "--port", "9000", "--bind", "0.0.0.0", "--cwd", "~", "--token", "abc"]);

        expect(args.port).toBe(9000);
        expect(args.bind).toBe("0.0.0.0");
        expect(args.token).toBe("abc");
        expect(args.cwd.startsWith("/")).toBe(true);
    });

    test("端口越界或未知参数直接报错", () => {
        expect(() => parseServeArgs(["serve", "--port", "70000"])).toThrow("--port 必须在 0-65535 之间");
        expect(() => parseServeArgs(["serve", "--nope"])).toThrow("未知参数");
        expect(() => parseServeArgs(["serve", "--cwd"])).toThrow("--cwd 需要路径");
    });
});

describe("resolveServeToken 优先级", () => {
    let stateDir: string;
    let savedEnv: string | undefined;
    let savedToken: string | undefined;

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-serve-token-"));
        savedEnv = process.env.ZBOT_STATE_DIR;
        savedToken = process.env.ZBOT_SERVE_TOKEN;
        process.env.ZBOT_STATE_DIR = stateDir;
        delete process.env.ZBOT_SERVE_TOKEN;
    });

    afterEach(() => {
        fs.rmSync(stateDir, { recursive: true, force: true });
        if (savedEnv === undefined) delete process.env.ZBOT_STATE_DIR;
        else process.env.ZBOT_STATE_DIR = savedEnv;
        if (savedToken === undefined) delete process.env.ZBOT_SERVE_TOKEN;
        else process.env.ZBOT_SERVE_TOKEN = savedToken;
    });

    test("参数优先于环境变量", () => {
        process.env.ZBOT_SERVE_TOKEN = "from-env";

        expect(resolveServeToken("from-arg")).toBe("from-arg");
    });

    test("环境变量优先于文件", () => {
        fs.mkdirSync(path.join(stateDir, "serve"), { recursive: true });
        fs.writeFileSync(path.join(stateDir, "serve", "token"), "from-file\n");
        process.env.ZBOT_SERVE_TOKEN = "from-env";

        expect(resolveServeToken()).toBe("from-env");
    });

    test("无配置时生成并落盘，二次调用复用同一令牌", () => {
        const first = resolveServeToken();
        const second = resolveServeToken();

        expect(first).toHaveLength(48);
        expect(second).toBe(first);
        expect(fs.readFileSync(path.join(stateDir, "serve", "token"), "utf8").trim()).toBe(first);
        expect(fs.statSync(path.join(stateDir, "serve", "token")).mode & 0o777).toBe(0o600);
    });
});
