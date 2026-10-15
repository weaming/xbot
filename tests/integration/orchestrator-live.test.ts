import { test, expect, describe } from "bun:test";
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";

/** 从 cwd 向上查找第一个存在的 .env（bun 下 import.meta.url 为相对路径，不能据此定位文件）。 */
function findEnvFile(): string | undefined {
    let dir = process.cwd();
    while (true) {
        const candidate = path.join(dir, ".env");
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

const envFile = findEnvFile();
// 集成测试以项目 .env 为权威源：即使 shell 已导出同名变量也覆盖，
// 避免残留/不完整的 OPENAI_* 导致测试被误跳过。
if (envFile) dotenv.config({ path: envFile, override: true });

const { createChatClient, executeWithChat } = await import("../../src/tools/chat-orchestrator.js");

/** 无真实 API 凭据时整块跳过。 */
const hasLiveApi = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);
const missingLiveApiKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL"]
    .filter(name => !process.env[name])
    .join(", ");
console.log(
    `[integration] ${hasLiveApi
        ? `真实 API 测试已启用（dotenv 源: ${envFile ?? "(环境变量)"}）`
        : `跳过真实 API 测试：缺少 ${missingLiveApiKeys || "(未知)"}（dotenv 源: ${envFile ?? "(未找到 .env)"}）`}`,
);

/** 真实 LLM API 集成测试：依赖 OPENAI_API_KEY / OPENAI_BASE_URL，仅在有凭据时运行。 */
describe.skipIf(!hasLiveApi)("Chat Orchestrator live API", () => {
    test("tool call 往返：模型返回工具调用并拿到结果", async () => {
        let apiBase = process.env.OPENAI_BASE_URL!;
        const model = process.env.OPENAI_MODEL;

        // 本地测试时转换 host.docker.internal
        if (apiBase.includes("host.docker.internal")) {
            apiBase = apiBase.replace("host.docker.internal", "localhost");
        }

        const client = createChatClient(process.env.OPENAI_API_KEY!, apiBase);

        const mockTool = {
            type: "function",
            function: {
                name: "get_current_time",
                description: "获取当前时间",
                parameters: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
        };

        const result = await executeWithChat({
            query: "现在几点了？请调用工具获取时间。",
            client,
            model,
            tools: [mockTool],
            executeTool: async (_name, _args) => {
                return JSON.stringify({ time: new Date().toISOString() });
            },
            onToolCall: (name, args, mode) => {
                console.log(`${mode === "parallel" ? "⚡" : "🔧"} [Tool Call] ${name}:`, args);
            },
            onToolResult: (name, result) => {
                console.log(`[Tool Result] ${name}:`, result);
            },
        });

        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        console.log(`[Result] ${result.content}`);
    }, 30000);
});
