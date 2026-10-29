import fs from "fs";
import os from "os";
import path from "path";
import embeddedIdentity from "./AGENTS.md" with { type: "text" };
import { setEmbeddedIdentity } from "../skills/base-skill.js";
import { getTuiSessionLogFile, getTuiStartupLogFile } from "../utils/tui-state-paths.js";
import { CONSOLE_TIMESTAMP_MARK } from "../utils/logger.js";
import { setStartupToolCwd } from "../utils/runtime-paths.js";

const DEFAULT_HOST_STATE_DIR = path.join(os.homedir(), ".zbot");
const DEFAULT_HOST_SRC_ROOT = "src";
const CONTAINER_PATH_PREFIX = "/app/";
function expandHome(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

function isContainerPath(value: string | undefined): boolean {
    return !value || value.startsWith(CONTAINER_PATH_PREFIX);
}

function resolveHostSrcRoot(): string {
    const configuredSrcRoot = process.env.TUI_SRC_ROOT || process.env.SRC_ROOT;
    if (configuredSrcRoot && !isContainerPath(configuredSrcRoot)) {
        return path.resolve(expandHome(configuredSrcRoot));
    }

    return path.join(os.homedir(), DEFAULT_HOST_SRC_ROOT);
}

function rewriteContainerServicesForHost(): void {
    if (!process.env.MCP_HUB_URL || process.env.MCP_HUB_URL.includes("://mcp-hub:")) {
        process.env.MCP_HUB_URL = "http://127.0.0.1:3010/mcp";
    }
    if (!process.env.NETWORK_PROXY || process.env.NETWORK_PROXY.includes("host.docker.internal")) {
        process.env.NETWORK_PROXY = "http://localhost:7890";
    }
}

function formatLogArgument(argument: unknown): string {
    if (argument instanceof Error) return argument.stack || argument.message;
    if (typeof argument === "string") return argument;

    try {
        return JSON.stringify(argument);
    } catch {
        return String(argument);
    }
}

let currentLogFile: string | null = null;
let startupCwd = "";

/** TUI 启动时的 cwd：新会话默认工作目录的固定基准，不随会话切换而变化。 */
export function getStartupCwd(): string {
    return startupCwd || process.cwd();
}

/** 将 agent 和 MCP 的后台日志写入文件，避免破坏 TUI 的终端绘制。 */
export function redirectLogsToFile(): () => void {
    currentLogFile = getTuiStartupLogFile();
    const original = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
    };
    const writeLog = (...args: unknown[]): void => {
        try {
            if (!currentLogFile) return;
            fs.mkdirSync(path.dirname(currentLogFile), { recursive: true });
            fs.appendFileSync(
                currentLogFile,
                `${new Date().toISOString()} ${args.map(formatLogArgument).join(" ")}\n`,
                "utf8",
            );
        } catch {
            // 日志写入失败不应影响 TUI。
        }
    };

    console.log = writeLog;
    console.info = writeLog;
    console.warn = writeLog;
    console.error = writeLog;
    console.debug = writeLog;
    // 标记：行首 ISO 时间戳已由 writeLog 提供，logger 的 console patch 不要再叠加本地时间
    (console as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK] = true;

    return () => {
        currentLogFile = null;
        console.log = original.log;
        console.info = original.info;
        console.warn = original.warn;
        console.error = original.error;
        console.debug = original.debug;
        delete (console as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK];
    };
}

/** 会话就绪后把日志目标切到该会话的文件；日志按 session 分离存储。 */
export function setLogSession(sessionId: string): void {
    if (currentLogFile) {
        currentLogFile = getTuiSessionLogFile(sessionId);
    }
}

/** 将本地工具依赖的路径和宿主服务地址切换为 TUI 所在环境。 */
export function configureHostEnvironment(): void {
    const stateDir = DEFAULT_HOST_STATE_DIR;
    const srcRoot = resolveHostSrcRoot();
    fs.mkdirSync(stateDir, { recursive: true });

    process.env.SRC_ROOT = srcRoot;
    process.env.ZBOT_STATE_DIR = stateDir;
    setEmbeddedIdentity(embeddedIdentity);
    process.env.ZBOT_EXTRA_IDENTITY_FILE = path.join(os.homedir(), ".zbot", "AGENTS.md");
    process.env.TUI_PLATFORM = `${process.platform} ${process.arch}`;
    process.env.TUI_CWD = process.cwd();
    // 固化启动目录：TUI_CWD 之后会随会话切换被改写，新建会话仍须以启动目录为初始值。
    startupCwd = process.cwd();
    // 同一份固化值也交给工具层：旧会话缺 cwd 时不能继承当前选中会话的目录。
    setStartupToolCwd(process.cwd());
    process.env.TUI_SRC_ROOT = srcRoot;
    rewriteContainerServicesForHost();
}
