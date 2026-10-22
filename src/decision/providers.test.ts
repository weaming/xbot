/**
 * provider 工厂的模型解析测试（不发起网络请求）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createLiquid, createTypeSafe, LIQUID_MODEL_ENV } from "./providers.js";

const KEY = "test-key";

afterEach(() => {
    delete process.env[LIQUID_MODEL_ENV];
    delete process.env.TYPESAFE_MODEL;
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
