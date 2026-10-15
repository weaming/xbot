import { describe, expect, test } from "bun:test";

import { buildCompactPrompt } from "../../src/utils/compaction-prompt.js";

describe("buildCompactPrompt", () => {
    test("要求省略系统提示已有的信息", () => {
        const prompt = buildCompactPrompt();
        expect(prompt).toContain("系统提示");
        expect(prompt).toContain("一律省略");
        expect(prompt).toContain("只保留对话本身产生的新信息");
        expect(prompt).not.toContain("不要重复、概括、引用或泄露");
    });

    test("无 instruction 时不追加用户要求", () => {
        expect(buildCompactPrompt()).not.toContain("用户特定压缩要求");
    });

    test("有 instruction 时追加用户要求", () => {
        expect(buildCompactPrompt("重点保留待办")).toContain("用户特定压缩要求：重点保留待办");
    });
});
