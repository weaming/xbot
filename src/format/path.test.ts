import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { abbreviatePath, truncatePath } from "./path.js";

describe("abbreviatePath", () => {
    test("home 前缀缩写为 ~，home 本体缩写为单个 ~", () => {
        expect(abbreviatePath("/Users/garden/src/zbot", "/Users/garden")).toBe("~/src/zbot");
        expect(abbreviatePath("/Users/garden", "/Users/garden")).toBe("~");
    });

    test("无 home 或非 home 路径原样返回，尾部分隔符被去掉", () => {
        expect(abbreviatePath("/opt/work/", undefined)).toBe("/opt/work");
        expect(abbreviatePath("/var/log", "/Users/garden")).toBe("/var/log");
    });

    test("超宽时保留尾部并在目录边界断开", () => {
        const short = abbreviatePath("/Users/garden/src/very/deep/project", "/Users/garden", 18);

        expect(visibleWidth(short)).toBeLessThanOrEqual(18);
        expect(short.startsWith("…")).toBe(true);
        expect(short.endsWith("project")).toBe(true);
        expect(short).toContain("/");
    });

    test("空路径返回空串", () => {
        expect(abbreviatePath("", "/Users/garden")).toBe("");
    });
});

describe("truncatePath", () => {
    test("不超宽时原样返回", () => {
        expect(truncatePath("/var/log", 40)).toBe("/var/log");
    });

    test("超宽时以省略号起头并保留尾部", () => {
        const short = truncatePath("~/src/very/deep/project", 12);

        expect(visibleWidth(short)).toBeLessThanOrEqual(12);
        expect(short.startsWith("…")).toBe(true);
    });
});
