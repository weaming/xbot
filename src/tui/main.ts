/**
 * TUI 入口：在当前宿主机进程内启动 agent，并连接 mcp-hub。
 */

import dotenv from "dotenv";
import os from "os";
import path from "path";
import { configureTuiHostEnvironment, redirectTuiLogsToFile } from "./runtime-context.js";
import { herdrReporter } from "./herdr-reporter.js";
import { officialDeepSeekCostYuan } from "../pricing/deepseek.js";
import { isPrintCliInvocation } from "../cli/print.js";
import { isSessionCliInvocation } from "../cli/session.js";
import type { ChatApp } from "./app.js";

const DEFAULT_ENV_FILE = path.join(os.homedir(), ".zbot", "env");

function resolveEnvFile(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

const envFile = resolveEnvFile(process.env.ZBOT_ENV_FILE || DEFAULT_ENV_FILE);
const cliArgs = process.argv.slice(2);
const isSessionCli = isSessionCliInvocation(cliArgs);

/**
 * 会话 CRUD 分支：必须在 dotenv 与 configureTuiHostEnvironment 之前分流 ——
 * 后者会把 ZBOT_STATE_DIR 固定到 ~/.zbot、改写 TUI_CWD 并重定向日志。
 *
 * 收尾只设 exitCode、不调 process.exit：stdout 接管道时写入是异步的，
 * 提前退出会把 `--json`/`--full` 的大段输出截断在 64KiB，`| jq` 直接解析失败。
 */
if (isSessionCli) {
    try {
        const { runSessionCli } = await import("../cli/session.js");
        await runSessionCli(cliArgs.slice(1));
    } catch (error: any) {
        const message = error?.message ?? String(error);
        process.exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
        if (cliArgs.includes("--json")) {
            // 结构化错误也走 stdout，调用方不必解析本地化文案
            process.stdout.write(`${JSON.stringify({
                error: {
                    ...(error?.details ?? {}),
                    code: error?.code ?? "failed",
                    message,
                },
            })}\n`);
        } else {
            process.stderr.write(`${message}\n`);
        }
    }
} else {
    // quiet：不向终端输出 "injected env" 提示，避免启动前污染主 buffer。
    dotenv.config({ path: envFile, quiet: true });
    configureTuiHostEnvironment();
}

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_EXIT_CODES = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
} as const;
const SHUTDOWN_GRACE_PERIOD_MS = 8_000;

/**
 * TUI 全局异常护栏：把 uncaughtException / unhandledRejection 打到 tui.log，
 * 进程不主动退出（用户仍可用 ⌃D 退出）。这些通常是 MCP 重连、定时器回调、
 * 异步工具执行的边界错误，吞掉不会让 TUI 状态机更糟。
 */
function installGlobalErrorGuards(): void {
    process.on("uncaughtException", (err) => {
        console.error("[TUI] uncaughtException:", err?.stack ?? err);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("[TUI] unhandledRejection:", reason);
    });
}

function installShutdownSignalHandlers(app: ChatApp): () => void {
    let shutdownStarted = false;
    let shutdownExitCode = 0;

    const handlers = SHUTDOWN_SIGNALS.map((signal) => {
        const handler = (): void => {
            if (shutdownStarted) {
                app.forceShutdown(shutdownExitCode);
                return;
            }

            shutdownStarted = true;
            shutdownExitCode = SIGNAL_EXIT_CODES[signal];
            const forceTimer = setTimeout(() => app.forceShutdown(shutdownExitCode), SHUTDOWN_GRACE_PERIOD_MS);
            forceTimer.unref();
            void app.shutdown(shutdownExitCode)
                .catch((error) => {
                    console.error(`[TUI] ${signal} 优雅退出失败:`, error);
                    app.forceShutdown(shutdownExitCode);
                })
                .finally(() => clearTimeout(forceTimer));
        };
        process.on(signal, handler);
        return { signal, handler };
    });

    return () => {
        for (const { signal, handler } of handlers) {
            process.removeListener(signal, handler);
        }
    };
}

async function startChatApp(): Promise<void> {
    // 尽早重定向 console：import 阶段（如 ToolLRU 加载日志、MCP 初始化）的输出
    // 也会写入 TUI 日志文件，而不是污染进入 alternate screen 前的主 buffer。
    const restoreConsole = redirectTuiLogsToFile();
    let started = false;
    try {
        const [{ ChatApp }, { LocalTuiAgent, initializeTuiAgentRuntime }, { ChatStore }, chatRuntime] = await Promise.all([
            import("./app.js"),
            import("./agent.js"),
            import("./store.js"),
            import("../services/chat-runtime.js"),
        ]);
        const runtimeReady = initializeTuiAgentRuntime();
        void runtimeReady.catch(() => undefined);
        const providerError = chatRuntime.validateChatApiSettings(chatRuntime.getChatApiSettings());
        const startupMessage = providerError
            ? `⚠️ LLM provider 配置无效：${providerError}\n请检查配置文件：${envFile}`
            : undefined;
        if (providerError) {
            herdrReporter.report("blocked", providerError);
        }
        const chatStore = new ChatStore({
            costFor: (usage, atMs) => officialDeepSeekCostYuan(usage, atMs, chatRuntime.getChatApiSettings()),
        });
        const app = new ChatApp(new LocalTuiAgent(runtimeReady), chatStore);
        const removeSignalHandlers = installShutdownSignalHandlers(app);
        try {
            await app.init(startupMessage);
            await runtimeReady;
        } catch (error) {
            removeSignalHandlers();
            throw error;
        }
        started = true;
        if (!providerError) {
            herdrReporter.report("idle");
        }
    } finally {
        if (!started) restoreConsole();
    }
}

async function main(): Promise<void> {
    if (isPrintCliInvocation(cliArgs)) {
        try {
            const { runPrintCli } = await import("../cli/print.js");
            await runPrintCli(cliArgs);
        } catch (error: any) {
            process.stderr.write(`${error?.message ?? error}\n`);
            process.exitCode = error?.name === "AbortError"
                ? (process.exitCode === 143 ? 143 : 130)
                : (process.exitCode === 143 ? 143 : 1);
        }
        return;
    }

    installGlobalErrorGuards();
    if (cliArgs[0] === "mcp") {
        try {
            const { runMcpCli } = await import("../mcp/cli.js");
            await runMcpCli(cliArgs.slice(1));
        } catch (error: any) {
            process.stderr.write(`❌ ${error?.message ?? error}\n`);
            process.exitCode = 1;
        }
        return;
    }

    // 启动失败（如 mcp-hub 偶发抖动）做一次重试，避免用户手动重启 TUI。
    try {
        await startChatApp();
    } catch (error: any) {
        console.error(`❌ TUI 启动失败: ${error?.message ?? error}，5s 后重试一次...`);
        await new Promise(resolve => setTimeout(resolve, 5_000));
        await startChatApp();
    }
}

// 末尾启动：模块级常量（SHUTDOWN_SIGNALS 等）此时已初始化，main() 不会在 TDZ 里跑
if (!isSessionCli) {
    main().catch((error) => {
        console.error(`💥 TUI main() rejected: ${error?.message ?? error}`);
        process.exit(1);
    });
}
