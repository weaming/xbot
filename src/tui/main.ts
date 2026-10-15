/**
 * TUI 入口：在当前宿主机进程内启动 agent，并连接 mcp-hub。
 */

import dotenv from "dotenv";
import os from "os";
import path from "path";
import { configureTuiHostEnvironment, redirectTuiLogsToFile } from "./runtime-context.js";
import { herdrReporter } from "./herdr-reporter.js";
import { officialDeepSeekCostYuan } from "../pricing/deepseek.js";

const DEFAULT_ENV_FILE = path.join(os.homedir(), ".xbot", ".env");

function resolveEnvFile(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

const envFile = resolveEnvFile(process.env.XBOT_ENV_FILE || DEFAULT_ENV_FILE);
// quiet：不向终端输出 "injected env" 提示，避免启动前污染主 buffer。
dotenv.config({ path: envFile, quiet: true });
configureTuiHostEnvironment();

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
        await initializeTuiAgentRuntime();
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
        await new ChatApp(new LocalTuiAgent(), chatStore).init(startupMessage);
        started = true;
        if (!providerError) {
            herdrReporter.report("idle");
        }
    } finally {
        if (!started) restoreConsole();
    }
}

async function main(): Promise<void> {
    installGlobalErrorGuards();
    // 启动失败（如 mcp-hub 偶发抖动）做一次重试，避免用户手动重启 TUI。
    try {
        await startChatApp();
    } catch (error: any) {
        console.error(`❌ TUI 启动失败: ${error?.message ?? error}，5s 后重试一次...`);
        await new Promise(resolve => setTimeout(resolve, 5_000));
        await startChatApp();
    }
}

main().catch((error) => {
    console.error(`💥 TUI main() rejected: ${error?.message ?? error}`);
    process.exit(1);
});
