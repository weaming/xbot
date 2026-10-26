import { describe, expect, test } from "bun:test";
import { formatElapsedDuration, formatGoDuration } from "../../src/utils/time.js";

describe("formatElapsedDuration 耗时格式化", () => {
    test("< 60s 时保留一位小数秒", () => {
        expect(formatElapsedDuration(0)).toBe("0.0s");
        expect(formatElapsedDuration(500)).toBe("0.5s");
        expect(formatElapsedDuration(12345)).toBe("12.3s");
        expect(formatElapsedDuration(59900)).toBe("59.9s");
    });

    test(">= 60s 且 < 3600s 时进位为分秒，秒取整", () => {
        expect(formatElapsedDuration(60000)).toBe("1m0s");
        expect(formatElapsedDuration(65400)).toBe("1m5s");
        expect(formatElapsedDuration(125800)).toBe("2m5s");
        expect(formatElapsedDuration(3599000)).toBe("59m59s");
    });

    test(">= 3600s 时进位为时分秒，秒取整", () => {
        expect(formatElapsedDuration(3600000)).toBe("1h0m0s");
        expect(formatElapsedDuration(3665000)).toBe("1h1m5s");
        expect(formatElapsedDuration(7325000)).toBe("2h2m5s");
    });
});

describe("formatGoDuration Go 风格耗时格式化", () => {
    test("1s 以内用毫秒", () => {
        expect(formatGoDuration(0)).toBe("0ms");
        expect(formatGoDuration(1)).toBe("1ms");
        expect(formatGoDuration(999)).toBe("999ms");
    });

    test("1s 到 1m 用秒，小数部分去掉尾随 0", () => {
        expect(formatGoDuration(1000)).toBe("1s");
        expect(formatGoDuration(1234)).toBe("1.234s");
        expect(formatGoDuration(1500)).toBe("1.5s");
        expect(formatGoDuration(59999)).toBe("59.999s");
    });

    test("1m 与 1h 以上逐级进位", () => {
        expect(formatGoDuration(60000)).toBe("1m0s");
        expect(formatGoDuration(61234)).toBe("1m1.234s");
        expect(formatGoDuration(3600000)).toBe("1h0m0s");
        expect(formatGoDuration(3723400)).toBe("1h2m3.4s");
    });

    test("超过一天用 d 进位", () => {
        expect(formatGoDuration(86400000)).toBe("1d0h0m0s");
        expect(formatGoDuration(90061000)).toBe("1d1h1m1s");
    });

    test("非法与非正值归零", () => {
        expect(formatGoDuration(-5)).toBe("0ms");
        expect(formatGoDuration(Number.NaN)).toBe("0ms");
    });
});
