/**
 * provider 工厂的模型解析测试（不发起网络请求）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLiquid, createTypeSafe, LIQUID_MODEL_ENV } from "./providers.js";

const KEY = "test-key";

/** 宿主 shell 常导出这些变量；快照后清空，避免"默认值"断言被真实配置覆盖。 */
const MODEL_ENVS = [LIQUID_MODEL_ENV, "TYPESAFE_MODEL", "JEVSTYLE_MODEL", "MERCURY_MODEL"] as const;
let savedModels: Record<string, string | undefined> = {};

beforeEach(() => {
    savedModels = {};
    for (const name of MODEL_ENVS) {
        savedModels[name] = process.env[name];
        delete process.env[name];
    }
});

afterEach(() => {
    for (const name of MODEL_ENVS) {
        const saved = savedModels[name];
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
    }
});

/** 读取 provider 实际使用的模型名。 */
function modelOf(provider: { decide: unknown }): unknown {
    return (provider as unknown as { model: string }).model;
}

describe("模型名解析", () => {
    test("未设置时用 provider 默认值", () => {
        expect(modelOf(createLiquid({ apiKey: KEY }))).toBe("d1");
    });

    test("LIQUID_MODEL 覆盖 Liquid 默认值", () => {
        process.env[LIQUID_MODEL_ENV] = "d1-ultra";
        expect(modelOf(createLiquid({ apiKey: KEY }))).toBe("d1-ultra");
    });

    test("显式参数优先于环境变量", () => {
        process.env[LIQUID_MODEL_ENV] = "d1-ultra";
        expect(modelOf(createLiquid({ apiKey: KEY, model: "d1" }))).toBe("d1");
    });

    test("空白环境变量视为未设置", () => {
        process.env[LIQUID_MODEL_ENV] = "   ";
        expect(modelOf(createLiquid({ apiKey: KEY }))).toBe("d1");
    });

    test("各 provider 的环境变量互不影响", () => {
        process.env[LIQUID_MODEL_ENV] = "d1-ultra";
        // TYPESAFE_MODEL 未设置，不应被 LIQUID_MODEL 影响
        expect(modelOf(createTypeSafe({ apiKey: KEY }))).toBe("jev-latest");
    });
});
