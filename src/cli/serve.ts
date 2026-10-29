/**
 * serve 入口：无 UI 的长驻宿主，把会话能力暴露成 HTTP + SSE。
 *
 * 与 TUI 并列：两者各自在进程内组装同一个 host，互不依赖、互不要求对方运行。
 * 这里只做装配（参数、令牌、生命周期），接口语义全部在 server/ 与 host/。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { initializeSessionHostRuntime, LocalSessionHost } from "../host/session-host.js";
import { startHttpServer, type HttpServerHandle } from "../server/http-server.js";
import { getStateDir, setStartupToolCwd } from "../utils/runtime-paths.js";

const DEFAULT_PORT = 8787;
const DEFAULT_BIND = "127.0.0.1";
const TOKEN_BYTES = 24;

export interface ServeArgs {
    port: number;
    bind: string;
    cwd: string;
    token?: string;
}

function expandHome(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

export function parseServeArgs(argv: string[]): ServeArgs {
    // 与 tui/main.ts 的分流字面量保持一致：改一处必须改另一处
    if (argv[0] !== "serve") throw new Error("parseServeArgs 需要以 serve 作为首个参数");

    const args: ServeArgs = {
        port: DEFAULT_PORT,
        bind: DEFAULT_BIND,
        cwd: process.cwd(),
    };

    for (let index = 1; index < argv.length; index += 1) {
        const value = argv[index + 1];
        switch (argv[index]) {
            case "--port": {
                if (!value) throw new Error("--port 需要端口号");
                const port = Number.parseInt(value, 10);
                if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error("--port 必须在 0-65535 之间");
                args.port = port;
                index += 1;
                break;
            }
            case "--bind":
                if (!value) throw new Error("--bind 需要地址");
                args.bind = value;
                index += 1;
                break;
            case "--cwd":
                if (!value) throw new Error("--cwd 需要路径");
                args.cwd = path.resolve(expandHome(value));
                index += 1;
                break;
            case "--token":
                if (!value) throw new Error("--token 需要令牌");
                args.token = value;
                index += 1;
                break;
            default:
                throw new Error(`未知参数：${argv[index]}`);
        }
    }

    return args;
}

/** 令牌文件：与其它宿主状态同目录，首次启动自动生成，便于本机客户端反复使用。 */
function serveTokenFile(): string {
    return getStateDir("serve", "token");
}

/**
 * 令牌优先级：命令行 > 环境变量 > 本地文件 > 新生成。
 * 自动生成后落盘（0600），避免每次重启都要求客户端换令牌。
 */
export function resolveServeToken(explicit?: string): string {
    const fromArg = explicit?.trim();
    if (fromArg) return fromArg;

    const fromEnv = process.env.ZBOT_SERVE_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const file = serveTokenFile();
    try {
        const saved = fs.readFileSync(file, "utf8").trim();
        if (saved) return saved;
    } catch {
        // 首次启动：下面生成
    }

    const token = randomBytes(TOKEN_BYTES).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
}

/** 收尾超时：MCP stdio 句柄或残留定时器可能让进程挂住，超时后强制退出。 */
const SHUTDOWN_FORCE_EXIT_MS = 8_000;

/** 让已写入 stdout/stderr 的内容先刷出去（写入回调触发即表示已交给内核），再结束进程。 */
async function flushStdio(): Promise<void> {
    await Promise.all([
        new Promise<void>(resolve => process.stdout.write("", () => resolve())),
        new Promise<void>(resolve => process.stderr.write("", () => resolve())),
    ]);
}

async function shutdown(
    server: HttpServerHandle,
    host: LocalSessionHost,
    reason: string,
    exitCode = 0,
): Promise<void> {
    process.stderr.write(`zbot serve 正在停止（${reason}）…\n`);
    const forceExit = setTimeout(() => {
        process.stderr.write("zbot serve 收尾超时，强制退出\n");
        process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();

    try {
        try {
            // 先断连接再关宿主：SSE 订阅者不能在下游已经销毁后还收到回调
            await server.stop();
            await host.close();
        } catch (error) {
            exitCode = 1;
            process.stderr.write(`zbot serve 停止失败：${(error as Error)?.message ?? error}\n`);
        }
        await flushStdio();
    } catch {
        // stdio 已断开（EPIPE 等）：不再尝试写，但必须继续退出，否则进程永远停不下来
    } finally {
        clearTimeout(forceExit);
        // 收尾完成即退出：残留句柄（MCP stdio 等）不该让进程挂着
        process.exit(exitCode);
    }
}

export async function runServe(argv: string[]): Promise<void> {
    const args = parseServeArgs(argv);
    const token = resolveServeToken(args.token);

    // 启动信息走 stderr：stdout 留给需要管道化的机器输出。
    process.stderr.write(`zbot serve 启动中（cwd=${args.cwd}）\n`);

    // 工作目录是任务基准：工具层（TUI_CWD / startupToolCwd）与新会话默认值必须同一口径。
    process.chdir(args.cwd);
    process.env.TUI_CWD = args.cwd;
    setStartupToolCwd(args.cwd);

    const runtimeReady = initializeSessionHostRuntime();
    const host = new LocalSessionHost(runtimeReady, { startupCwd: args.cwd });
    await runtimeReady;

    const server = startHttpServer({ host, port: args.port, bind: args.bind, token });
    process.stderr.write(`zbot serve 已就绪 ${server.url}\n`);
    process.stderr.write(`访问令牌：${token}\n`);

    // 长驻服务：单次漏处理的 rejection 不该带走服务；未捕获异常则视为状态不可信，走收尾退出。
    // 处理器在 runtimeReady 之后注册：启动期没有需要清理的资源，此时收到信号直接退出即可。
    let stopping = false;
    const stop = (reason: string, exitCode = 0): void => {
        if (stopping) return;
        stopping = true;
        void shutdown(server, host, reason, exitCode);
    };
    process.on("unhandledRejection", reason => {
        console.error("[serve] 未处理的 Promise 拒绝:", reason);
    });
    process.on("uncaughtException", error => {
        console.error("[serve] 未捕获异常:", error);
        // 非 0 退出码：让 systemd/docker 的失败重启策略能识别这次是崩溃而不是正常停止
        stop("uncaughtException", 1);
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => stop(signal));
    }

    // 长驻：生命周期由信号或致命异常驱动，这里只是不让函数返回
    await new Promise<void>(() => {});
}
