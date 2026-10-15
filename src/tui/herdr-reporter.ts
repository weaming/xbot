/**
 * herdr 状态上报：xbot TUI 在 herdr（终端复用器）pane 内运行时，
 * 通过 herdr CLI 上报 turn 生命周期状态，让 herdr 侧边栏识别 xbot agent。
 * 非 herdr 环境（无 HERDR_ENV）全部 no-op，不影响本地直接运行。
 *
 * 参考 herdr 文档 "Integrate your own agent"：pane 内进程继承
 * HERDR_ENV / HERDR_PANE_ID / HERDR_BIN_PATH，用 pane report-agent / release-agent
 * 报告语义状态（working/idle/blocked），退出时释放生命周期权威。
 */

import { spawn } from "child_process";

export type HerdrState = "idle" | "working" | "blocked" | "unknown";

export interface HerdrContext {
    binPath: string;
    paneId: string;
}

const AGENT_LABEL = "xbot";
const SOURCE_ID = "custom:xbot";

/** 从 herdr 注入的环境变量读取上下文；不在 herdr 内时返回 undefined。 */
export function readHerdrContext(): HerdrContext | undefined {
    if (process.env.HERDR_ENV !== "1") return undefined;
    const binPath = process.env.HERDR_BIN_PATH?.trim();
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (!binPath || !paneId) return undefined;
    return { binPath, paneId };
}

function defaultRunner(binPath: string, args: string[]): void {
    const child = spawn(binPath, args, { stdio: "ignore" });
    // herdr CLI 缺失或 pane 已关闭时静默，不影响 TUI。
    child.on("error", () => {});
}

export class HerdrReporter {
    private lastState: HerdrState | undefined;
    private seq = 0;

    constructor(
        private readonly context: HerdrContext | undefined,
        private readonly runner: (binPath: string, args: string[]) => void = defaultRunner,
    ) {}

    get supported(): boolean {
        return this.context !== undefined;
    }

    /** 上报 agent 语义状态；状态未变化且无附加信息时跳过，避免每 turn 都 spawn CLI。 */
    report(state: HerdrState, message?: string): void {
        if (!this.context) return;
        if (this.lastState === state && message === undefined) return;
        this.lastState = state;

        const args = [
            "pane", "report-agent", this.context.paneId,
            "--source", SOURCE_ID,
            "--agent", AGENT_LABEL,
            "--state", state,
            "--seq", String(this.seq++),
        ];
        if (message) args.push("--message", message);
        this.runner(this.context.binPath, args);
    }

    /** xbot TUI 退出时释放生命周期权威，herdr 恢复该 pane 的普通进程状态。 */
    release(): void {
        if (!this.context) return;
        this.lastState = undefined;
        this.runner(this.context.binPath, [
            "pane", "release-agent", this.context.paneId,
            "--source", SOURCE_ID,
            "--agent", AGENT_LABEL,
            "--seq", String(this.seq++),
        ]);
    }
}

/** 全局单例：读取当前进程的 herdr 上下文。 */
export const herdrReporter = new HerdrReporter(readHerdrContext());
