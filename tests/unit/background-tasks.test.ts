import { afterEach, expect, test } from "bun:test";
import { backgroundTaskManager } from "../../src/tools/background-tasks.js";
import { backgroundTaskTool } from "../../src/tools/background-task-tool.js";

const shellPath = "/bin/bash";

function shellOptions(command: string, sessionId: string, timeoutSeconds = 10, autoBackgroundOnTimeout = false) {
    return {
        command,
        cwd: process.cwd(),
        env: process.env,
        shellPath,
        sessionId,
        timeoutSeconds,
        autoBackgroundOnTimeout,
    };
}

afterEach(() => {
    backgroundTaskManager.stopAll();
});

test("Ctrl+B 可将前台 shell 转为后台任务并回收输出", async () => {
    const sessionId = `background-test-${Date.now()}`;
    const handle = backgroundTaskManager.startShell(shellOptions("printf before; sleep 0.1; printf after", sessionId));

    expect(backgroundTaskManager.detachForeground(sessionId)).toBe(1);
    const detached = await handle.promise;
    expect(detached.kind).toBe("detached");
    if (detached.kind !== "detached") return;

    const completed = await backgroundTaskManager.wait(detached.task.id, 2_000, sessionId);
    expect(completed?.status).toBe("completed");
    expect(completed?.stdout).toContain("before");
    expect(completed?.stdout).toContain("after");
});

test("后台任务可以被终止", async () => {
    const sessionId = `background-stop-test-${Date.now()}`;
    const handle = backgroundTaskManager.startShell(shellOptions("sleep 10", sessionId));

    expect(backgroundTaskManager.detachForeground(sessionId)).toBe(1);
    const detached = await handle.promise;
    if (detached.kind !== "detached") return;

    expect(backgroundTaskManager.stop(detached.task.id, sessionId)).toBe(true);
    const stopped = await backgroundTaskManager.wait(detached.task.id, 2_000, sessionId);
    expect(stopped?.status).toBe("stopped");
});

test("默认超时可以自动转为后台任务", async () => {
    const sessionId = `background-timeout-test-${Date.now()}`;
    const handle = backgroundTaskManager.startShell(shellOptions("sleep 1", sessionId, 0.05, true));

    const detached = await handle.promise;
    expect(detached.kind).toBe("detached");
    if (detached.kind !== "detached") return;
    expect(detached.task.reason).toBe("timeout");

    expect(backgroundTaskManager.stop(detached.task.id, sessionId)).toBe(true);
    const stopped = await backgroundTaskManager.wait(detached.task.id, 2_000, sessionId);
    expect(stopped?.status).toBe("stopped");
});

test("background_task 工具支持查询和终止任务", async () => {
    const sessionId = `background-tool-test-${Date.now()}`;
    const handle = backgroundTaskManager.startShell(shellOptions("sleep 10", sessionId));
    expect(backgroundTaskManager.detachForeground(sessionId)).toBe(1);
    const detached = await handle.promise;
    if (detached.kind !== "detached") return;

    const status = await backgroundTaskTool.execute({
        action: "status",
        task_id: detached.task.id,
        __sessionId: sessionId,
    });
    expect(status.isError).toBeUndefined();
    expect(status.content[0].text).toContain('"status": "running"');

    const stopped = await backgroundTaskTool.execute({
        action: "stop",
        task_id: detached.task.id,
        __sessionId: sessionId,
    });
    expect(stopped.isError).toBeUndefined();
    await backgroundTaskManager.wait(detached.task.id, 2_000, sessionId);
});

