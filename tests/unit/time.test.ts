import { describe, expect, test } from "bun:test";
import { formatElapsedDuration } from "../../src/utils/time.js";

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
