import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { restoreEnv } from "./test-env.js";

/** 构造一个技能目录（Claude Codex 结构：SKILL.md frontmatter + body + 可带伴生文件）。 */
function makeSkill(skillDir: string, name: string, description: string, extraYaml = ""): void {
    const dir = path.join(skillDir, name);
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "helper.sh"), "#!/bin/sh\necho helper\n");
    fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n${extraYaml}---\n\n# ${name}\n\n技能正文。\n`,
    );
}

describe("skill registry multi-source loading", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-skill-state-"));
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-skill-ws-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-skill-home-"));
    const userSkillsDir = path.join(stateDir, "skills");
    const wsSkillsDir = path.join(wsDir, "skills");
    const agentsSkillsDir = path.join(homeDir, ".agents", "skills");

    let previousStateDir: string | undefined;
    let previousWorkspace: string | undefined;
    let previousHome: string | undefined;
    let previousTuiPlatform: string | undefined;

    beforeEach(() => {
        previousStateDir = process.env.XBOT_STATE_DIR;
        previousWorkspace = process.env.WORKSPACE;
        previousHome = process.env.HOME;
        previousTuiPlatform = process.env.TUI_PLATFORM;
    });

    afterEach(() => {
        restoreEnv("XBOT_STATE_DIR", previousStateDir);
        restoreEnv("WORKSPACE", previousWorkspace);
        restoreEnv("HOME", previousHome);
        restoreEnv("TUI_PLATFORM", previousTuiPlatform);
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.rmSync(wsDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
    });

    test("loads skills from user dir with priority over workspace dir", async () => {
        makeSkill(userSkillsDir, "alpha", "user-alpha");
        makeSkill(userSkillsDir, "beta", "user-beta");
        makeSkill(wsSkillsDir, "alpha", "ws-alpha"); // 同名：应被用户级覆盖
        makeSkill(wsSkillsDir, "gamma", "ws-gamma");

        process.env.XBOT_STATE_DIR = stateDir;
        process.env.WORKSPACE = wsDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.getSkillNames().sort()).toEqual(["alpha", "beta", "gamma"]);
        expect(registry.getSkillMeta("alpha")?.description).toBe("user-alpha");
        expect(registry.getSkillDir("alpha")).toBe(path.join(userSkillsDir, "alpha"));
        expect(registry.getSkillDir("beta")).toBe(path.join(userSkillsDir, "beta"));
        expect(registry.getSkillDir("gamma")).toBe(path.join(wsSkillsDir, "gamma"));
    });

    test("loads ~/.agents/skills in TUI and keeps local skills first", async () => {
        makeSkill(userSkillsDir, "local", "local-skill");
        makeSkill(agentsSkillsDir, "shared", "shared-skill");
        makeSkill(wsSkillsDir, "workspace", "workspace-skill");

        process.env.HOME = homeDir;
        process.env.TUI_PLATFORM = "test";
        process.env.XBOT_STATE_DIR = stateDir;
        process.env.WORKSPACE = wsDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.getSkillNames().sort()).toEqual(["local", "shared", "workspace"]);
        expect(registry.getSkillDir("shared")).toBe(path.join(agentsSkillsDir, "shared"));
    });

    test("handles claude-codex style frontmatter with extra fields", async () => {
        makeSkill(userSkillsDir, "alpha", "user-alpha", "allowed-tools:\n  - Bash(git *)\nmodel: sonnet\n");

        process.env.XBOT_STATE_DIR = stateDir;
        process.env.WORKSPACE = wsDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.hasSkill("alpha")).toBe(true);
        // 额外 yaml 字段不阻塞解析，正文完整保留
        expect(registry.getSkill("alpha")?.getSystemPrompt()).toContain("技能正文");
    });

    test("dir name fallback when frontmatter lacks name", async () => {
        const dir = path.join(userSkillsDir, "bare");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: no name field\n---\n# Bare\n");

        process.env.XBOT_STATE_DIR = stateDir;
        process.env.WORKSPACE = wsDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.hasSkill("bare")).toBe(true);
        expect(registry.getSkillMeta("bare")?.description).toBe("no name field");
    });

    test("empty registry when no skill dir exists", async () => {
        process.env.XBOT_STATE_DIR = path.join(stateDir, "empty");
        process.env.WORKSPACE = wsDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.getSkillNames()).toEqual([]);
        expect(registry.buildSkillListing()).toContain("- 暂无可用技能");
    });
});
