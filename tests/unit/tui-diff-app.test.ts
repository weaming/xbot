/**
 * 端到端（App 层）：驱动真实 ChatApp 的事件流，验证改动详情在回合结束后收起、
 * 按 ⌃T 后又重新展开。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { tuiStub } from "./tui-stub.js";
import { isolateModelEnv } from "./test-env.js";

/** 可渲染的组件替身：让 messagesContainer.render() 产出真实文本。 */
class RenderableContainer {
    children: any[] = [];
    addChild(child: any) { this.children.push(child); }
    clear() { this.children = []; }
    render(width: number): string[] { return this.children.flatMap(child => child.render(width)); }
    invalidate() {}
}

mock.module("@earendil-works/pi-tui", () => ({
    ...tuiStub,
    Container: RenderableContainer,
    Text: class {
        constructor(private text = "") {}
        setText(text: string) { this.text = text; }
        getText() { return this.text; }
        render() { return [this.text]; }
        invalidate() {}
    },
    Spacer: class {
        constructor(private readonly height = 1) {}
        render() { return Array.from({ length: this.height }, () => ""); }
        invalidate() {}
    },
    Markdown: class {
        constructor(private readonly text = "") {}
        render() { return [this.text]; }
        invalidate() {}
    },
}));

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => ({ content: "stub", toolCalls: 0, messages: [] }),
}));

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");

const DIFF_RESULT = [
    "```diff",
    "--- sample.txt",
    "+++ sample.txt",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    "```",
].join("\n");

let tmpDir: string;
let originalStateDir: string | undefined;
let restoreModelEnv: () => void;

beforeEach(() => {
    restoreModelEnv = isolateModelEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-diff-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    restoreModelEnv();
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

function makeApp() {
    const agent = {
        listSessions: async () => [],
        readSessionEvents: async () => [],
        createSession: async () => ({ sessionId: "sess-diff" }),
        getSessionCwd: async () => tmpDir,
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        detachPeerWaits: () => 0,
        takePeerResults: () => [],
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        isSessionBusy: () => false,
        isSessionLockedByOther: () => false,
        claimSession: async () => ({ ok: true as const }),
        releaseSession: () => {},
        isSessionClaimed: () => true,
        claimedSessionIds: () => ["sess-diff"],
        probeSession: async () => ({ state: "mine" as const }),
        listSessionOwnership: async () => new Map(),
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        getSystemPrompt: async () => "",
        getInstanceNetworkStats: () => ({}),
        appendPeerMessage: async () => {},
    };
    const store = new ChatStore();
    store.setSessions([{ sessionId: "sess-diff", messageCount: 0, title: "改动会话" }]);
    store.setCurrentSession("sess-diff");
    const app = new ChatApp(agent as any, store);
    return { app: app as any, store };
}

/** 渲染消息区纯文本。 */
function messagesText(app: any): string {
    return stripTerminalSequences(app.messagesContainer.render(120).join("\n"));
}

describe("改动详情在 App 层的收起", () => {
    test("回合结束后收起，⌃T 打开后重新展开", () => {
        const { app, store } = makeApp();
        const send = (event: any) => store.applyEvent(1, "sess-diff", event);

        // 回合阶段由宿主在 onEvent 里维护：这里手动对齐，模拟真实运行态
        app.setSessionPhase("sess-diff", "tool", "edit_file");
        send({ type: "turn_start", iteration: 1 });
        send({
            type: "tool_start",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            args: {},
            mode: "serial",
        });
        send({
            type: "tool_result",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            summary: DIFF_RESULT,
            isError: false,
            durationMs: 12,
        });
        app.syncMessages();

        expect(messagesText(app)).toContain("+ new line");

        send({ type: "message_end", content: "完成", stopReason: "end_turn" });
        app.clearSessionPhase("sess-diff");
        app.syncMessages();

        const finished = messagesText(app);
        expect(finished).toContain("Edited sample.txt (+1 -1)");
        expect(finished).not.toContain("+ new line");

        app.toggleDiffDetail();
        expect(messagesText(app)).toContain("+ new line");

        app.toggleDiffDetail();
        expect(messagesText(app)).not.toContain("+ new line");
    }); 

    test("漏掉 message_end 时，回合收尾的兜底仍会让详情收起", () => {
        const { app, store } = makeApp();
        app.setSessionPhase("sess-diff", "tool", "edit_file");
        store.applyEvent(1, "sess-diff", { type: "turn_start", iteration: 1 });
        store.applyEvent(1, "sess-diff", {
            type: "tool_start",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            args: {},
            mode: "serial",
        });
        store.applyEvent(1, "sess-diff", {
            type: "tool_result",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            summary: DIFF_RESULT,
            isError: false,
            durationMs: 12,
        });
        app.syncMessages();
        expect(messagesText(app)).toContain("+ new line");

        // 事件里没有 message_end：只靠回合收尾与阶段清理兜底
        app.clearSessionPhase("sess-diff");
        store.finishStreaming("sess-diff");
        app.syncMessages();

        expect(messagesText(app)).not.toContain("+ new line");
        expect(messagesText(app)).toContain("Edited sample.txt (+1 -1)");
    });
});
