/**
 * 管理仍在运行的 shell 后台任务，供 bash 工具和 TUI 快捷键共用。
 */

import { spawn, type ChildProcess } from "node:child_process";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 8_000;
const TASK_RETENTION_MS = 10 * 60 * 1_000;
const MAX_BACKGROUND_TIMEOUT_SECONDS = 2 * 60 * 60;

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";

interface ShellProcessOptions {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    shellPath: string;
    sessionId?: string;
    timeoutSeconds: number;
    autoBackgroundOnTimeout: boolean;
    backgroundTimeoutSeconds?: number;
    signal?: AbortSignal;
}

interface ShellCompletedResult {
    kind: "completed" | "timed_out" | "aborted";
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signalName: NodeJS.Signals | null;
    timeoutSeconds?: number;
}

interface ShellDetachedResult {
    kind: "detached";
    task: BackgroundTaskSummary;
}

type ShellForegroundResult = ShellCompletedResult | ShellDetachedResult;

export interface BackgroundTaskSummary {
    id: string;
    sessionId?: string;
    command: string;
    cwd: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    reason?: "manual" | "timeout" | "stopped";
    stdout?: string;
    stderr?: string;
    outputTruncated?: boolean;
}

interface BackgroundTaskRecord {
    summary: BackgroundTaskSummary;
    child: ChildProcess;
    pgid?: number;
    stdoutChunks: Buffer[];
    stderrChunks: Buffer[];
    stdoutBytes: number;
    stderrBytes: number;
    outputTruncated: boolean;
    stopRequested: boolean;
    timeoutTimer?: ReturnType<typeof setTimeout>;
    resolveDone: (summary: BackgroundTaskSummary) => void;
    done: Promise<BackgroundTaskSummary>;
}

interface ForegroundShellRun {
    sessionId?: string;
    detach(reason?: "manual" | "timeout"): boolean;
}

interface ShellProcessHandle {
    promise: Promise<ShellForegroundResult>;
    detach(reason?: "manual" | "timeout"): boolean;
}

function trimOutput(value: string): string {
    if (value.length <= MAX_OUTPUT_PREVIEW_CHARS) return value;
    return `…${value.slice(-MAX_OUTPUT_PREVIEW_CHARS)}`;
}

function nowISO(): string {
    return new Date().toISOString();
}

function killProcessGroup(pgid: number | undefined, child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
    if (!pgid) return;
    try {
        process.kill(-pgid, signal);
    } catch (error: any) {
        if (error?.code !== "ESRCH") {
            try {
                child.kill(signal);
            } catch {
                // 子进程已经退出时无需重复处理。
            }
        }
    }
}

class BackgroundTaskManager {
    private readonly tasks = new Map<string, BackgroundTaskRecord>();
    private readonly foregroundRuns = new Set<ForegroundShellRun>();
    private readonly completionListeners = new Set<(task: BackgroundTaskSummary) => void>();
    private nextTaskId = 1;

    onTaskCompleted(listener: (task: BackgroundTaskSummary) => void): () => void {
        this.completionListeners.add(listener);
        return () => this.completionListeners.delete(listener);
    }

    startShell(options: ShellProcessOptions): ShellProcessHandle {
        const child = spawn(options.shellPath, ["-c", options.command], {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const pgid = child.pid;
        const startedAt = nowISO();
        const foregroundRun: ForegroundShellRun = {
            sessionId: options.sessionId,
            detach: () => false,
        };
        let settled = false;
        let detached = false;
        let timedOut = false;
        let backgroundTask: BackgroundTaskRecord | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let resolveForeground!: (result: ShellForegroundResult) => void;
        let rejectForeground!: (error: Error) => void;

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputTruncated = false;

        const appendOutput = (chunks: Buffer[], chunk: Buffer, currentBytes: number, assign: (value: number) => void): void => {
            if (currentBytes >= MAX_OUTPUT_BYTES) {
                outputTruncated = true;
                return;
            }
            const remain = MAX_OUTPUT_BYTES - currentBytes;
            chunks.push(chunk.subarray(0, remain));
            assign(currentBytes + Math.min(chunk.length, remain));
            if (chunk.length > remain) outputTruncated = true;
        };

        const collectOutput = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");
        const clearForeground = (): void => {
            this.foregroundRuns.delete(foregroundRun);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (options.signal) options.signal.removeEventListener("abort", onAbort);
        };

        const resolveDetached = (reason: "manual" | "timeout"): boolean => {
            if (settled || detached) return false;
            detached = true;
            clearForeground();
            backgroundTask = this.createTask(options, child, pgid, reason, startedAt, stdoutChunks, stderrChunks, stdoutBytes, stderrBytes, outputTruncated);
            resolveForeground({ kind: "detached", task: this.toSummary(backgroundTask, true) });
            return true;
        };
        foregroundRun.detach = resolveDetached;
        this.foregroundRuns.add(foregroundRun);

        const onAbort = (): void => {
            if (detached) return;
            killProcessGroup(pgid, child);
        };

        const finishBackground = (code: number | null, signalName: NodeJS.Signals | null): void => {
            if (!backgroundTask) return;
            if (backgroundTask.summary.status !== "running") return;
            if (backgroundTask.timeoutTimer) clearTimeout(backgroundTask.timeoutTimer);
            const stdout = collectOutput(backgroundTask.stdoutChunks).trim();
            const stderr = collectOutput(backgroundTask.stderrChunks).trim();
            const status = backgroundTask.stopRequested
                ? "stopped"
                : backgroundTask.summary.reason === "timeout"
                    ? "timed_out"
                    : code === 0
                        ? "completed"
                        : "failed";
            backgroundTask.summary = {
                ...backgroundTask.summary,
                status,
                finishedAt: nowISO(),
                exitCode: code,
                signal: signalName,
                ...(stdout ? { stdout: trimOutput(stdout) } : {}),
                ...(stderr ? { stderr: trimOutput(stderr) } : {}),
                ...(backgroundTask.outputTruncated ? { outputTruncated: true } : {}),
            };
            backgroundTask.resolveDone(backgroundTask.summary);
            this.notifyTaskCompleted(this.toSummary(backgroundTask, true));
        };

        child.stdout?.on("data", (chunk: Buffer) => {
            if (backgroundTask) {
                appendOutput(backgroundTask.stdoutChunks, chunk, backgroundTask.stdoutBytes, value => { backgroundTask!.stdoutBytes = value; });
                backgroundTask.outputTruncated ||= outputTruncated;
            } else {
                appendOutput(stdoutChunks, chunk, stdoutBytes, value => { stdoutBytes = value; });
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            if (backgroundTask) {
                appendOutput(backgroundTask.stderrChunks, chunk, backgroundTask.stderrBytes, value => { backgroundTask!.stderrBytes = value; });
                backgroundTask.outputTruncated ||= outputTruncated;
            } else {
                appendOutput(stderrChunks, chunk, stderrBytes, value => { stderrBytes = value; });
            }
        });

        child.once("error", (error) => {
            if (detached) {
                finishBackground(null, null);
                return;
            }
            if (settled) return;
            settled = true;
            clearForeground();
            rejectForeground(error);
        });

        child.once("close", (code, signalName) => {
            if (detached) {
                finishBackground(code, signalName);
                return;
            }
            if (settled) return;
            settled = true;
            clearForeground();
            resolveForeground({
                kind: options.signal?.aborted ? "aborted" : timedOut ? "timed_out" : "completed",
                stdout: collectOutput(stdoutChunks),
                stderr: collectOutput(stderrChunks),
                exitCode: code,
                signalName,
                ...(timedOut ? { timeoutSeconds: options.timeoutSeconds } : {}),
            });
        });

        if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
        const timeoutMs = options.timeoutSeconds * 1_000;
        timeoutTimer = setTimeout(() => {
            timedOut = true;
            if (options.autoBackgroundOnTimeout) {
                resolveDetached("timeout");
                return;
            }
            killProcessGroup(pgid, child);
        }, timeoutMs);

        const promise = new Promise<ShellForegroundResult>((resolve, reject) => {
            resolveForeground = resolve;
            rejectForeground = reject;
        });
        return { promise, detach: reason => foregroundRun.detach(reason) };
    }

    detachForeground(sessionId: string): number {
        let detachedCount = 0;
        for (const run of [...this.foregroundRuns]) {
            if (run.sessionId === sessionId && run.detach("manual")) detachedCount++;
        }
        return detachedCount;
    }

    list(sessionId?: string): BackgroundTaskSummary[] {
        this.prune();
        return [...this.tasks.values()]
            .filter(task => sessionId === undefined || task.summary.sessionId === sessionId)
            .map(task => this.toSummary(task, true));
    }

    get(taskId: string, sessionId?: string): BackgroundTaskSummary | undefined {
        this.prune();
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return undefined;
        return this.toSummary(task, true);
    }

    async wait(taskId: string, timeoutMs: number, sessionId?: string, signal?: AbortSignal): Promise<BackgroundTaskSummary | undefined> {
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return undefined;
        if (task.summary.status !== "running") return this.toSummary(task, true);
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

        return new Promise<BackgroundTaskSummary>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = (): void => {
                if (timer) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = (): void => {
                cleanup();
                reject(new DOMException("The operation was aborted", "AbortError"));
            };
            task.done.then(summary => {
                cleanup();
                resolve(this.toSummary(task, true));
            });
            timer = setTimeout(() => {
                cleanup();
                resolve(this.toSummary(task, true));
            }, timeoutMs);
            timer.unref?.();
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    stop(taskId: string, sessionId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return false;
        if (task.summary.status !== "running") return false;
        task.stopRequested = true;
        task.summary.reason = "stopped";
        killProcessGroup(task.pgid, task.child);
        return true;
    }

    stopAll(): void {
        for (const run of [...this.foregroundRuns]) run.detach("manual");
        for (const task of this.tasks.values()) {
            if (task.summary.status === "running") this.stop(task.summary.id);
        }
    }

    private createTask(
        options: ShellProcessOptions,
        child: ChildProcess,
        pgid: number | undefined,
        reason: "manual" | "timeout",
        startedAt: string,
        stdoutChunks: Buffer[],
        stderrChunks: Buffer[],
        stdoutBytes: number,
        stderrBytes: number,
        outputTruncated: boolean,
    ): BackgroundTaskRecord {
        this.prune();
        const id = `task_${this.nextTaskId++}`;
        let resolveDone!: (summary: BackgroundTaskSummary) => void;
        const done = new Promise<BackgroundTaskSummary>(resolve => { resolveDone = resolve; });
        const summary: BackgroundTaskSummary = {
            id,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            command: options.command,
            cwd: options.cwd,
            status: "running",
            startedAt,
            reason,
        };
        const task: BackgroundTaskRecord = {
            summary,
            child,
            pgid,
            stdoutChunks,
            stderrChunks,
            stdoutBytes,
            stderrBytes,
            outputTruncated,
            stopRequested: false,
            resolveDone,
            done,
        };
        this.tasks.set(id, task);

        const timeoutSeconds = Math.min(
            MAX_BACKGROUND_TIMEOUT_SECONDS,
            Math.max(1, Math.round(options.backgroundTimeoutSeconds ?? 30 * 60)),
        );
        task.timeoutTimer = setTimeout(() => {
            if (task.summary.status !== "running") return;
            task.summary.reason = "timeout";
            killProcessGroup(task.pgid, task.child);
        }, timeoutSeconds * 1_000);
        task.timeoutTimer.unref?.();
        return task;
    }

    private toSummary(task: BackgroundTaskRecord, includeOutput: boolean): BackgroundTaskSummary {
        const stdout = collectTaskOutput(task.stdoutChunks).trim();
        const stderr = collectTaskOutput(task.stderrChunks).trim();
        return {
            ...task.summary,
            ...(includeOutput && stdout ? { stdout: trimOutput(stdout) } : {}),
            ...(includeOutput && stderr ? { stderr: trimOutput(stderr) } : {}),
            ...(task.outputTruncated ? { outputTruncated: true } : {}),
        };
    }

    private notifyTaskCompleted(task: BackgroundTaskSummary): void {
        for (const listener of this.completionListeners) {
            try {
                listener(task);
            } catch (error) {
                console.error("后台任务完成通知失败", error);
            }
        }
    }

    private prune(): void {
        const cutoff = Date.now() - TASK_RETENTION_MS;
        for (const [id, task] of this.tasks) {
            if (task.summary.status !== "running" && task.summary.finishedAt && Date.parse(task.summary.finishedAt) < cutoff) {
                this.tasks.delete(id);
            }
        }
    }
}

function collectTaskOutput(chunks: Buffer[]): string {
    return Buffer.concat(chunks).toString("utf8");
}

export const backgroundTaskManager = new BackgroundTaskManager();

