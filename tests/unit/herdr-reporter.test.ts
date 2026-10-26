/** herdr 上报器单元测试：覆盖环境探测、参数生成、去重与 seq 递增。 */

import { afterEach, describe, expect, test } from "bun:test";
import { HerdrReporter, readHerdrContext } from "../../src/tui/herdr-reporter.js";

const CONTEXT = { binPath: "/usr/local/bin/herdr", paneId: "w1:p1" };

function collectRunner(): { calls: string[][]; runner: (binPath: string, args: string[]) => void } {
    const calls: string[][] = [];
    const runner = (_binPath: string, args: string[]) => {
        calls.push(args);
    };
    return { calls, runner };
}

describe("readHerdrContext", () => {
    const saved = {
        env: process.env.HERDR_ENV,
        binPath: process.env.HERDR_BIN_PATH,
        paneId: process.env.HERDR_PANE_ID,
    };

    afterEach(() => {
        if (saved.env === undefined) delete process.env.HERDR_ENV;
        else process.env.HERDR_ENV = saved.env;
        if (saved.binPath === undefined) delete process.env.HERDR_BIN_PATH;
        else process.env.HERDR_BIN_PATH = saved.binPath;
        if (saved.paneId === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = saved.paneId;
    });

    test("不在 herdr 内时返回 undefined", () => {
        delete process.env.HERDR_ENV;
        expect(readHerdrContext()).toBeUndefined();
    });

    test("HERDR_ENV=1 但缺 pane id 时返回 undefined", () => {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
        delete process.env.HERDR_PANE_ID;
        expect(readHerdrContext()).toBeUndefined();
    });

    test("环境变量齐全时返回上下文", () => {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
        process.env.HERDR_PANE_ID = "w1:p1";
        expect(readHerdrContext()).toEqual(CONTEXT);
    });
});

describe("HerdrReporter", () => {
    test("无 herdr 上下文时 report/release 均为 no-op", () => {
        const { calls, runner } = collectRunner();
        const reporter = new HerdrReporter(undefined, runner);
        reporter.report("working");
        reporter.report("idle");
        reporter.release();
        expect(calls).toEqual([]);
    });

    test("report 生成 report-agent 参数并递增 seq", () => {
        const { calls, runner } = collectRunner();
        const reporter = new HerdrReporter(CONTEXT, runner);
        reporter.report("working");
        reporter.report("idle");
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual([
            "pane", "report-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--state", "working", "--seq", "0",
        ]);
        expect(calls[1]).toEqual([
            "pane", "report-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--state", "idle", "--seq", "1",
        ]);
    });

    test("状态未变化且无 message 时跳过上报", () => {
        const { calls, runner } = collectRunner();
        const reporter = new HerdrReporter(CONTEXT, runner);
        reporter.report("working");
        reporter.report("working");
        expect(calls).toHaveLength(1);
    });

    test("带 message 时重复状态仍上报（阻塞信息更新）", () => {
        const { calls, runner } = collectRunner();
        const reporter = new HerdrReporter(CONTEXT, runner);
        reporter.report("blocked", "provider 配置无效");
        reporter.report("blocked", "provider 配置无效");
        // 带 message 的上报不参与去重（阻塞信息变化也算更新）。
        expect(calls).toHaveLength(2);
        for (const args of calls) {
            expect(args.slice(-2)).toEqual(["--message", "provider 配置无效"]);
        }
    });

    test("release 发送 release-agent 并继续递增 seq", () => {
        const { calls, runner } = collectRunner();
        const reporter = new HerdrReporter(CONTEXT, runner);
        reporter.report("working");
        reporter.release();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual([
            "pane", "release-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--seq", "1",
        ]);
    });

    test("supported 反映上下文是否存在", () => {
        expect(new HerdrReporter(CONTEXT, () => {}).supported).toBe(true);
        expect(new HerdrReporter(undefined, () => {}).supported).toBe(false);
    });
});
