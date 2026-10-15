import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    buildConversationHistory,
    buildExtraToolsSection,
    buildSystemPrompt,
    formatChatProviderError,
    getOrCreateSessionSystemPrompt,
    validateChatApiSettings,
} from "../../src/services/chat-runtime.js";
import { setEmbeddedWorkspaceIdentity } from "../../src/skills/base-skill.js";
import { skillRegistry } from "../../src/skills/skill-registry.js";
import { appendCompletedTurn, getSessionContextHistory } from "../../src/utils/conversation-history.js";
import type { Session } from "../../src/types/session.js";
import { useTmpWorkspace, type TmpWorkspace } from "./test-env.js";
import { DEFAULT_MEMORY_USER_ID, getUserMemoryFilePath, getUserMemoriesDir } from "../../src/utils/runtime-paths.js";
import { getTodayDateString } from "../../src/utils/time.js";
import { toolCatalog } from "../../src/tools/tool-catalog.js";

let tmpDir: string;
let workspace: TmpWorkspace;

async function resetSkillRegistryToEmptyWorkspace(): Promise<void> {
    const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-chat-runtime-empty-"));
    process.env.WORKSPACE = emptyWorkspace;
    await skillRegistry.load();
    fs.rmSync(emptyWorkspace, { recursive: true, force: true });
}

function expectNextRequestToReusePrefix(completedTranscript: any[], nextRequest: any[]): void {
    expect(JSON.stringify(nextRequest.slice(0, completedTranscript.length))).toBe(JSON.stringify(completedTranscript));
}

beforeEach(async () => {
    workspace = useTmpWorkspace("xbot-chat-runtime-test-");
    tmpDir = workspace.dir;
    await resetSkillRegistryToEmptyWorkspace();
    process.env.WORKSPACE = tmpDir;
});

afterEach(async () => {
    await resetSkillRegistryToEmptyWorkspace();
    workspace.cleanup();
});

describe("chat runtime", () => {
    test("keeps the completed request transcript as the next request's byte-identical prefix", () => {
        const session: Session = {
            sessionId: "01J00000000000000000000000",
            cwd: path.resolve(tmpDir),
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: { startedAt: "2026-01-01T00:00:00+08:00", reason: "session_start", sourceUserTurnCount: 0, retainedUserTurnCount: 0 },
            totalUserTurnCount: 0,
            hardTrimCount: 0,
            compactCount: 0,
        };
        const systemMessage = { role: "system", content: "stable system prompt" };
        const assistantMessage = {
            role: "assistant" as const,
            content: "",
            reasoning_content: "reasoning",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "tool", arguments: "{}" } }],
        };
        const toolMessage = { role: "tool" as const, tool_call_id: "call_1", name: "tool", content: "result" };
        const finalMessage = { role: "assistant" as const, content: "answer", reasoning_content: "final reasoning" };
        appendCompletedTurn(session, ["first question"], [assistantMessage, toolMessage, finalMessage], true);

        const completedTranscript = [systemMessage, { role: "user", content: "first question" }, assistantMessage, toolMessage, finalMessage];
        const nextRequest = [systemMessage, ...getSessionContextHistory(session), { role: "user", content: "second question" }];

        expectNextRequestToReusePrefix(completedTranscript, nextRequest);
    });

    test("buildConversationHistory preserves session history and appends pending messages before the query", () => {
        const history = buildConversationHistory(
            {
                turns: [{
                    id: "t1",
                    status: "completed",
                    messages: [{ id: "m1", createdAt: "2026-01-01T00:00:00+08:00", role: "assistant", content: "already there" }],
                }],
            } as any,
            ["first", "second"],
        );

        expect(history).toEqual([
            { role: "assistant", content: "already there" },
            { role: "user", content: "first" },
        ]);
    });

    test("buildSystemPrompt includes identity, active skill, and updated skill listing", async () => {
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "你是测试身份。", "utf-8");
        const skillDir = path.join(tmpDir, "skills", "alpha");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            `---
name: alpha
description: Alpha skill
---
Alpha prompt body`,
            "utf-8",
        );

        await skillRegistry.load();

        const result = buildSystemPrompt({
            activeSkillName: "alpha",
            sentSkillsMtime: {},
            extraToolsPreface: "测试工具前言",
        });

        expect(result.systemPrompt).toContain("你是测试身份");
        expect(result.systemPrompt).toContain("## 当前激活技能：alpha");
        expect(result.systemPrompt).toContain("Alpha prompt body");
        expect(result.systemPrompt).toContain("## 可用技能");
        expect(result.systemPrompt).toContain("Alpha skill");
        expect(result.updatedSkillListing).toBe(true);
        expect(result.nextSentSkillsMtime?.alpha).toBeDefined();
        expect(result.systemPrompt.indexOf("你是测试身份")).toBeLessThan(result.systemPrompt.indexOf("## 可用技能"));
        expect(result.systemPrompt.indexOf("## 可用技能")).toBeLessThan(result.systemPrompt.indexOf("<!-- 核心记忆"));
        expect(result.systemPrompt.indexOf("<!-- 核心记忆")).toBeLessThan(result.systemPrompt.indexOf("<!-- 昨日记忆"));
        expect(result.systemPrompt.indexOf("<!-- 今日记忆")).toBeLessThan(result.systemPrompt.indexOf("## 当前激活技能：alpha"));
        // 工具调用规则动态段位于末尾
        expect(result.systemPrompt.indexOf("## 工具调用规则")).toBeGreaterThan(result.systemPrompt.indexOf("## 当前激活技能：alpha"));
    });

    test("buildSystemPrompt appends the optional extra identity file", () => {
        const identityFile = path.join(tmpDir, "tui-AGENTS.md");
        const extraIdentityFile = path.join(tmpDir, "user-AGENTS.md");
        fs.writeFileSync(identityFile, "TUI 身份", "utf-8");
        fs.writeFileSync(extraIdentityFile, "用户级补充规则", "utf-8");

        const previousIdentityFile = process.env.XBOT_IDENTITY_FILE;
        const previousExtraIdentityFile = process.env.XBOT_EXTRA_IDENTITY_FILE;
        process.env.XBOT_IDENTITY_FILE = identityFile;
        process.env.XBOT_EXTRA_IDENTITY_FILE = extraIdentityFile;

        try {
            const result = buildSystemPrompt({ includeMemory: false, includeDailyMemory: false });
            expect(result.systemPrompt.indexOf("TUI 身份")).toBeGreaterThanOrEqual(0);
            expect(result.systemPrompt.indexOf("用户级补充规则")).toBeGreaterThan(result.systemPrompt.indexOf("TUI 身份"));
        } finally {
            if (previousIdentityFile === undefined) delete process.env.XBOT_IDENTITY_FILE;
            else process.env.XBOT_IDENTITY_FILE = previousIdentityFile;
            if (previousExtraIdentityFile === undefined) delete process.env.XBOT_EXTRA_IDENTITY_FILE;
            else process.env.XBOT_EXTRA_IDENTITY_FILE = previousExtraIdentityFile;
        }
    });

    test("buildSystemPrompt uses the embedded identity before the optional extra file", () => {
        const extraIdentityFile = path.join(tmpDir, "user-AGENTS.md");
        fs.writeFileSync(extraIdentityFile, "用户级补充规则", "utf-8");
        const previousExtraIdentityFile = process.env.XBOT_EXTRA_IDENTITY_FILE;
        const previousTuiCwd = process.env.TUI_CWD;
        process.env.XBOT_EXTRA_IDENTITY_FILE = extraIdentityFile;
        process.env.TUI_CWD = "/tmp/tui-working-directory";
        setEmbeddedWorkspaceIdentity("内置 TUI 身份\n当前目录（pwd）：{{TUI_CWD}}");

        try {
            const result = buildSystemPrompt({ includeMemory: false, includeDailyMemory: false });
            expect(result.systemPrompt.indexOf("内置 TUI 身份")).toBeGreaterThanOrEqual(0);
            expect(result.systemPrompt).toContain("当前目录（pwd）：/tmp/tui-working-directory");
            expect(result.systemPrompt.indexOf("用户级补充规则")).toBeGreaterThan(result.systemPrompt.indexOf("内置 TUI 身份"));
        } finally {
            setEmbeddedWorkspaceIdentity();
            if (previousExtraIdentityFile === undefined) delete process.env.XBOT_EXTRA_IDENTITY_FILE;
            else process.env.XBOT_EXTRA_IDENTITY_FILE = previousExtraIdentityFile;
            if (previousTuiCwd === undefined) delete process.env.TUI_CWD;
            else process.env.TUI_CWD = previousTuiCwd;
        }
    });

    test("tool calling rule section enables discovered tool injection", () => {
        const result = buildSystemPrompt();
        expect(result.systemPrompt).toContain("不得臆想或假设工具存在");
        expect(result.systemPrompt).toContain("可直接调用当前 tools 参数中声明的工具");
        expect(result.systemPrompt).toContain("先调用 search_tools 搜索它");
        expect(result.systemPrompt).toContain("搜索到的工具会加入可用列表");
    });

    test("buildSystemPrompt always includes the complete skill listing", async () => {
        const skillDir = path.join(tmpDir, "skills", "beta");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            `---
name: beta
description: Beta skill
---
Beta prompt body`,
            "utf-8",
        );

        await skillRegistry.load();

        const first = buildSystemPrompt({
            sentSkillsMtime: {},
        });
        const second = buildSystemPrompt({
            sentSkillsMtime: first.nextSentSkillsMtime,
        });

        expect(first.updatedSkillListing).toBe(true);
        expect(second.updatedSkillListing).toBe(true);
        expect(second.systemPrompt).toContain("## 可用技能");
        expect(second.systemPrompt).toContain("- beta: Beta skill");
    });

    test("can omit daily memory for stateless CLI tasks", () => {
        const memoriesDir = getUserMemoriesDir(DEFAULT_MEMORY_USER_ID);
        fs.mkdirSync(memoriesDir, { recursive: true });
        fs.writeFileSync(path.join(memoriesDir, "2026-08-04.md"), "不应注入的每日记忆", "utf-8");

        const result = buildSystemPrompt({ includeDailyMemory: false });

        expect(result.systemPrompt).not.toContain("<!-- 昨日记忆");
        expect(result.systemPrompt).not.toContain("<!-- 今日记忆");
        expect(result.systemPrompt).not.toContain("不应注入的每日记忆");
    });

    test("daily memory uses an isolated neutral default user id", () => {
        const defaultMemoryDir = getUserMemoriesDir(DEFAULT_MEMORY_USER_ID);
        const otherMemoryDir = getUserMemoriesDir(7);
        fs.mkdirSync(defaultMemoryDir, { recursive: true });
        fs.mkdirSync(otherMemoryDir, { recursive: true });

        const today = getTodayDateString();
        fs.writeFileSync(path.join(defaultMemoryDir, `${today}.md`), "默认用户记忆", "utf-8");
        fs.writeFileSync(path.join(otherMemoryDir, `${today}.md`), "其他用户记忆", "utf-8");

        const result = buildSystemPrompt({ userId: DEFAULT_MEMORY_USER_ID });

        expect(result.systemPrompt).toContain("默认用户记忆");
        expect(result.systemPrompt).not.toContain("其他用户记忆");
        expect(defaultMemoryDir).toBe(path.join(tmpDir, "memories", "0"));
    });

    test("core memory is isolated by userid", () => {
        fs.mkdirSync(getUserMemoriesDir(DEFAULT_MEMORY_USER_ID), { recursive: true });
        fs.mkdirSync(getUserMemoriesDir(7), { recursive: true });
        fs.writeFileSync(getUserMemoryFilePath(DEFAULT_MEMORY_USER_ID), "默认用户核心记忆", "utf-8");
        fs.writeFileSync(getUserMemoryFilePath(7), "其他用户核心记忆", "utf-8");

        const result = buildSystemPrompt({ userId: DEFAULT_MEMORY_USER_ID });

        expect(result.systemPrompt).toContain("默认用户核心记忆");
        expect(result.systemPrompt).not.toContain("其他用户核心记忆");
    });

    test("buildSystemPrompt sorts the skill listing by name", async () => {
        for (const skillName of ["zeta", "alpha"]) {
            const skillDir = path.join(tmpDir, "skills", skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(
                path.join(skillDir, "SKILL.md"),
                `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\nbody`,
                "utf-8",
            );
        }
        await skillRegistry.load();

        const result = buildSystemPrompt({ sentSkillsMtime: {} });

        expect(result.systemPrompt.indexOf("- alpha: alpha skill")).toBeLessThan(
            result.systemPrompt.indexOf("- zeta: zeta skill"),
        );
    });

    test("每个 session 缓存 system prompt", () => {
        const session: {
            cachedSystemPrompt?: string;
            activeSkill?: string;
            sentSkillsMtime?: Record<string, number>;
        } = {
            activeSkill: undefined,
            sentSkillsMtime: {},
        };

        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "初始 TUI 规则", "utf-8");
        const initialPrompt = getOrCreateSessionSystemPrompt(session);
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "更新后的 TUI 规则", "utf-8");
        const laterPrompt = getOrCreateSessionSystemPrompt(session);

        expect(laterPrompt).toBe(initialPrompt);
        expect(session.cachedSystemPrompt).toBe(initialPrompt);
    });

    test("技能集合变化后重建 session system prompt 缓存", async () => {
        const skillPath = path.join(tmpDir, "skills", "reloadable", "SKILL.md");
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, "---\nname: reloadable\ndescription: 初始描述\n---\n初始指令", "utf-8");
        await skillRegistry.load();

        const session = {
            cwd: tmpDir,
            activeSkill: "reloadable",
            sentSkillsMtime: {},
        } as any;
        const initialPrompt = getOrCreateSessionSystemPrompt(session, { includeMemory: false });

        fs.writeFileSync(skillPath, "---\nname: reloadable\ndescription: 更新描述\n---\n更新指令", "utf-8");
        fs.utimesSync(skillPath, new Date(), new Date(Date.now() + 1_000));
        await skillRegistry.load();

        const reloadedPrompt = getOrCreateSessionSystemPrompt(session, { includeMemory: false });
        expect(reloadedPrompt).not.toBe(initialPrompt);
        expect(reloadedPrompt).toContain("更新描述");
        expect(reloadedPrompt).toContain("更新指令");
    });

    test("工具目录变化后重建 session system prompt 缓存", () => {
        const session = {
            cwd: tmpDir,
            activeSkill: undefined,
            sentSkillsMtime: {},
        } as any;
        const initialPrompt = getOrCreateSessionSystemPrompt(session, { includeMemory: false });
        const remoteToolName = "reload_runtime_test_tool";

        toolCatalog.syncRemoteTools("reload-runtime-test", [{
            name: remoteToolName,
            description: "用于验证重载的测试工具",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ content: [] }),
        }]);

        try {
            const reloadedPrompt = getOrCreateSessionSystemPrompt(session, { includeMemory: false });
            expect(reloadedPrompt).not.toBe(initialPrompt);
            expect(reloadedPrompt).toContain(remoteToolName);
        } finally {
            toolCatalog.removeRemoteServer("reload-runtime-test");
        }
    });

    test("guides tool discovery toward precise multi-keyword searches", () => {
        const section = buildExtraToolsSection("测试");

        expect(section).toContain("传入独立的 keywords 列表");
        expect(section).toContain("不要写成 [\"hello world\"]");
    });
});

describe("system prompt PWD 与会话绑定目录一致", () => {
    const identityTemplate = "## 当前环境\n- 当前目录（`PWD`）：`{{TUI_CWD}}`\n- 工作区：`{{TUI_WORKSPACE}}`";

    function makeSession(cwd: string) {
        return {
            sessionId: "01J00000000000000000000000",
            cwd,
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: { startedAt: "2026-01-01T00:00:00+08:00", reason: "session_start" as const, sourceUserTurnCount: 0, retainedUserTurnCount: 0 },
            totalUserTurnCount: 0,
            hardTrimCount: 0,
            compactCount: 0,
        };
    }

    beforeEach(() => {
        setEmbeddedWorkspaceIdentity(identityTemplate);
        process.env.TUI_CWD = "/global/activated/cwd";
    });

    afterEach(() => {
        setEmbeddedWorkspaceIdentity(undefined);
        delete process.env.TUI_CWD;
    });

    test("PWD 取自各会话绑定 cwd，不被全局 TUI_CWD 污染", () => {
        const sessionA = makeSession("/sessions/a");
        const sessionB = makeSession("/sessions/b");

        const promptA = getOrCreateSessionSystemPrompt(sessionA, { includeMemory: false });
        expect(promptA).toContain("/sessions/a");
        expect(promptA).not.toContain("/global/activated/cwd");

        const promptB = getOrCreateSessionSystemPrompt(sessionB, { includeMemory: false });
        expect(promptB).toContain("/sessions/b");
        expect(promptA).toContain("/sessions/a");
        expect(sessionA.cachedSystemPromptCwd).toBe("/sessions/a");
        expect(sessionB.cachedSystemPromptCwd).toBe("/sessions/b");
    });

    test("缓存命中不随全局 TUI_CWD 变化失效", () => {
        const sessionA = makeSession("/sessions/a");
        const first = getOrCreateSessionSystemPrompt(sessionA, { includeMemory: false });

        process.env.TUI_CWD = "/switched/to/other";
        expect(getOrCreateSessionSystemPrompt(sessionA, { includeMemory: false })).toBe(first);
        expect(first).toContain("/sessions/a");
    });

    test("cwd 与缓存记录不一致时重建 prompt", () => {
        const sessionA = makeSession("/sessions/a");
        // 模拟旧版遗留的错误缓存：PWD 按全局 TUI_CWD 固化、未记录 cwd
        sessionA.cachedSystemPrompt = "旧缓存 PWD=/global/activated/cwd";
        sessionA.cachedSystemPromptIncludesMemory = false;

        const rebuilt = getOrCreateSessionSystemPrompt(sessionA, { includeMemory: false });
        expect(rebuilt).not.toContain("/global/activated/cwd");
        expect(rebuilt).toContain("/sessions/a");
        expect(sessionA.cachedSystemPromptCwd).toBe("/sessions/a");

        // 重建后再次调用命中缓存
        expect(getOrCreateSessionSystemPrompt(sessionA, { includeMemory: false })).toBe(rebuilt);
    });
});

describe("chat provider settings", () => {
    test("接受有效的 OpenAI 兼容配置", () => {
        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "https://example.com/v1",
            model: "model",
        })).toBeUndefined();
    });

    test("允许省略模型，由服务端选择默认模型", () => {
        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "http://127.0.0.1:3030/v1",
            model: "",
        })).toBeUndefined();
    });

    test("拒绝缺少密钥、模型和非法地址", () => {
        expect(validateChatApiSettings({
            apiKey: "",
            apiBase: "https://example.com/v1",
            model: "model",
        })).toContain("OPENAI_API_KEY");

        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "not-a-url",
            model: "model",
        })).toContain("OPENAI_BASE_URL");

    });

    test("将限流错误转换为可操作提示", () => {
        const error = Object.assign(new Error("Monthly usage limit reached"), { status: 429 });
        const message = formatChatProviderError(error);

        expect(message).toContain("HTTP 429");
        expect(message).toContain("额度已用尽");
        expect(message).toContain("Monthly usage limit reached");
    });

    test("从 provider 原始错误文本识别 HTTP 状态", () => {
        const message = formatChatProviderError("429 Weekly usage limit reached");

        expect(message).toContain("HTTP 429");
        expect(message).toContain("额度已用尽");
    });

    test("为其他 HTTP 错误保留状态码", () => {
        const message = formatChatProviderError(Object.assign(new Error("upstream failure"), { status: 500 }));

        expect(message).toBe("LLM provider 请求失败（HTTP 500）：upstream failure");
    });
});
