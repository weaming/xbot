import { describe, expect, test } from "bun:test";
import { isPrintCliInvocation, parsePrintArgs } from "./print.js";

describe("parsePrintArgs", () => {
    test("routes print flags regardless of position so malformed ordering gets a CLI error", () => {
        expect(isPrintCliInvocation(["--json", "--print", "prompt"])).toBe(true);
        expect(isPrintCliInvocation(["mcp", "status"])).toBe(false);
    });

    test("reads positional prompt and execution options", () => {
        expect(parsePrintArgs([
            "-p", "summarize", "this repo", "--cwd", "./project", "--model", "fast", "--json",
        ])).toEqual({
            prompt: ["summarize", "this repo"],
            cwd: `${process.cwd()}/project`,
            model: "fast",
            json: true,
        });
    });

    test("rejects unknown options and missing values", () => {
        expect(() => parsePrintArgs(["-p", "--unknown"])).toThrow("未知参数");
        expect(() => parsePrintArgs(["-p", "--model"])).toThrow("--model 需要模型名");
        expect(() => parsePrintArgs(["-p", "--model", "--json"])).toThrow("--model 需要模型名");
        expect(() => parsePrintArgs(["--json", "--print", "prompt"])).toThrow("必须是首个参数");
    });
});
