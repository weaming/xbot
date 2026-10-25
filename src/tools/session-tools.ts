/**
 * 会话间工具：开子会话、发消息、查状态。
 *
 * 会话级下发（sessionScoped）：注入条件是「有会话上下文 + 进程已装配控制通道」。
 * 会话运行期间持有权不可能被释放（归档/删除/协商释放都要求空闲），所以无须再判断是否已认领；
 * 没有会话上下文时根本不注入。
 *
 * 任务不是独立实体，全部通过消息表达：下发 = 发一条消息，交付 = 对方回合结束时自动回传的结果。
 * 结果默认异步回传（对方一轮结束后由宿主驱动下一轮），`wait_seconds` 时改为前台阻塞等待。
 */

import {
    formatResultText,
    MAX_SPAWNED_SESSIONS,
    PeerSendFailure,
    type SessionControl,
} from "../control/channel.js";
import { describeOwnership } from "../control/registry.js";
import { getPeerResultHistory, getSessionControl, getSessionDirectory } from "../control/runtime.js";
import { err, ok, type ExecutableTool, type ToolExecutionResult } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";

const SESSION_TOOL_NAMES = ["session_spawn", "session_send", "session_status", "session_close"];

/** `wait_seconds` 的上限：别让一次工具调用把回合占死太久。 */
const MAX_WAIT_SECONDS = 600;

interface SessionSpawnArgs {
    title?: string;
    auto_close?: boolean;
    __sessionId?: string;
}

interface SessionSendArgs {
    session?: string;
    text?: string;
    expect_result?: boolean;
    wait_seconds?: number;
    reply_to?: string;
    __sessionId?: string;
}

interface SessionStatusArgs {
    session?: string;
    include_result?: boolean;
    __sessionId?: string;
}

interface SessionCloseArgs {
    session?: string;
    __sessionId?: string;
}

const sessionSpawnTool: ExecutableTool = {
    name: "session_spawn",
    description: [
        "开一个子会话并与之协作：子会话立即创建、由本实例持有，并出现在用户的会话条里。",
        "返回的 sessionId 用 session_send 派活（expect_result=true 时结果会自动回传）。",
        "auto_close=true 时，本实例内 session_send 派发的首个 expect_result=true 任务完成并回传后自动归档；历史保留。",
        "跨进程 session_send 暂不自动关闭（结果推送尚无可靠 ACK），需用 session_close 手动归档。",
        `派生的子会话数有上限（${MAX_SPAWNED_SESSIONS} 个），到上限后要先让用户清理。`,
        "默认不自动回收；用完可用 session_close 归档（保留历史），或提示用户删除（⌃X）。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            title: { type: "string", description: "子会话标题（便于用户辨认；省略则由首条消息推导）" },
            auto_close: {
                type: "boolean",
                description: "本实例内 session_send 的首个期望结果回传后自动归档（保留历史）；跨进程发送不会自动关闭；默认 false",
            },
        },
    },
    execute: async (args: SessionSpawnArgs) => {
        const control = getSessionControl();
        const from = args.__sessionId;
        if (!control) return err("会话间通信未启用");
        if (!from) return err("session_spawn 需要会话上下文（缺少 __sessionId）");

        const title = (args.title ?? "").trim();
        let result;
        try {
            result = await control.spawnSession(from, title || undefined, { autoClose: args.auto_close === true });
        } catch (error) {
            return err(`派生会话失败：${(error as Error)?.message ?? error}`);
        }
        if (!result.ok) return err(result.error);

        return ok(
            [
                `已派生并接管会话 ${shortId(result.sessionId)}`,
                `完整 id：${result.sessionId}`,
                ...(args.auto_close ? ["任务完成回传后会自动归档（保留历史）。"] : []),
                `用 session_send(session="${result.sessionId}", text=…, expect_result=true) 派活。`,
            ].join("\n"),
        );
    },
};

const sessionSendTool: ExecutableTool = {
    name: "session_send",
    description: [
        "给另一个会话发消息：可以让它做一件事、与它讨论，或回答它发来的消息。",
        "expect_result=true 表示你在等它这轮的产出：它会自动把回合结束时的最终输出回传给你，",
        "结果会作为新消息回到你这里（你空闲时会直接继续一轮），所以不要等待、也不要反复轮询。",
        `wait_seconds>0 时本次调用就地等待对方这轮的结果（隐含 expect_result，最长 ${MAX_WAIT_SECONDS} 秒）：`,
        "命中即作为本次工具结果返回，超时先返回提示、结果到了仍会自动继续一轮。",
        "等待期间用户可以按 ⌃B 把等待放入后台，你会立刻拿到提示、继续做别的。",
        "对方未认领或正在执行时本调用会直接失败——把错误告诉用户，稍后再试即可。",
        "回应别人的消息时用 reply_to 填那条消息的 id。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "目标会话 id（可用末几位；session_status 可列出）" },
            text: { type: "string", description: "消息正文" },
            expect_result: {
                type: "boolean",
                description: "是否等待对方的产出作为结果回传（默认 false，纯通知/讨论用 false）",
            },
            wait_seconds: {
                type: "number",
                description: [
                    "就地等待对方本轮结果的最长秒数（默认 0 = 发完即返回）。",
                    `>0 时隐含 expect_result，命中即返回结果文本；超时先返回提示，结果到达后仍会自动继续。上限 ${MAX_WAIT_SECONDS} 秒。`,
                ].join(""),
            },
            reply_to: { type: "string", description: "在回应哪条消息的 id（回信时填）" },
        },
        required: ["session", "text"],
    },
    execute: async (args: SessionSendArgs, signal?: AbortSignal) => {
        const control = getSessionControl();
        const from = args.__sessionId;
        if (!control) return err("会话间通信未启用");
        if (!from) return err("session_send 需要会话上下文（缺少 __sessionId）");

        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填目标会话 id，可用末几位");
        const text = (args.text ?? "").trim();
        if (!text) return err("text 必填");

        const resolved = await resolveSessionId(target);
        if (!resolved.ok) return err(resolved.error);

        const waitSeconds = normalizeWaitSeconds(args.wait_seconds);
        const expectResult = args.expect_result === true || waitSeconds > 0;

        try {
            const message = await control.send(from, resolved.sessionId, text, {
                ...(expectResult ? { expectResult: true } : {}),
                ...(args.reply_to ? { replyTo: args.reply_to } : {}),
            });
            const sent = `已发送到会话 ${shortId(resolved.sessionId)}（msgId=${message.id}）`;
            if (waitSeconds === 0) {
                return ok(`${sent}${expectResult ? "，结果稍后自动回传" : ""}`);
            }

            const outcome = await control.waitForResult(message.id, Math.round(waitSeconds * 1000), signal);
            if (outcome.ok) return ok(formatResultText(resolved.sessionId, outcome.result));
            if (outcome.reason === "timeout") {
                return ok(`${sent}，等待 ${waitSeconds}s 未见结果；结果到达后会自动继续，不要重复发送`);
            }
            if (outcome.reason === "none") {
                return ok(`${sent}，结果已就绪，会在后续自动附加`);
            }
            if (outcome.reason === "detached") {
                return ok(`${sent}，等待已由用户放入后台：先继续手头的事，结果到达后会自动继续一轮`);
            }
            if (outcome.reason === "aborted") return err(`${sent}，但等待结果被中止`);
            return err(`${sent}，但结果已丢失（会话 ${shortId(resolved.sessionId)} 不可达），不要重复发送`);
        } catch (error) {
            if (error instanceof PeerSendFailure) return err(error.message);
            return err(`发送到会话 ${shortId(resolved.sessionId)} 失败：${(error as Error)?.message ?? error}`);
        }
    },
};

/** 归一化 `wait_seconds`：非法或不大于 0 视为不等待，超上限按上限截断。 */
function normalizeWaitSeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, MAX_WAIT_SECONDS);
}

const sessionStatusTool: ExecutableTool = {
    name: "session_status",
    description: [
        "查看会话状态：省略 session 时列出全部会话及其归属、忙闲与等待中的结果；",
        "指定 session 时给出该会话的详情，include_result 时附上它最近收到的会话间结果原文。",
        "用于确认对方在不在、忙不忙，以及回顾对方回合的产出。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "会话 id；省略则列出全部会话" },
            include_result: {
                type: "boolean",
                description: "同时返回该会话最近收到的会话间结果原文（默认 false）",
            },
        },
    },
    execute: async (args: SessionStatusArgs) => {
        const control = getSessionControl();
        if (!control) return err("会话间通信未启用");
        const caller = args.__sessionId;

        const target = (args.session ?? "").trim();
        if (!target) return describeAll(control, caller, args.include_result === true);
        if (target === caller || (caller ?? "").endsWith(target)) {
            return describeOne(control, caller ?? target, caller, args.include_result === true);
        }

        const resolved = await resolveSessionId(target);
        if (!resolved.ok) return err(resolved.error);
        return describeOne(control, resolved.sessionId, caller, args.include_result === true);
    },
};

const sessionCloseTool: ExecutableTool = {
    name: "session_close",
    description: [
        "关闭本实例用 session_spawn 派生且仍由本实例持有的空闲子会话。",
        "关闭会归档并释放会话，不删除历史；不能关闭普通用户会话、其他实例持有的会话或正在执行的会话。",
        "若 session_spawn 使用 auto_close=true，本实例内 session_send 的首个 expect_result=true 任务回传后会自动完成此操作；跨进程任务需手动关闭。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "session_spawn 返回的完整 id 或末几位 id" },
        },
        required: ["session"],
    },
    execute: async (args: SessionCloseArgs) => {
        const control = getSessionControl();
        if (!control) return err("会话间通信未启用");
        if (!args.__sessionId) return err("session_close 需要会话上下文（缺少 __sessionId）");

        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填 session_spawn 返回的会话 id");
        const resolved = await resolveSessionId(target);
        if (!resolved.ok) return err(resolved.error);

        const result = await control.closeSpawnedSession(resolved.sessionId);
        if (!result.ok) return err(result.error);
        return ok(`已归档并关闭子会话 ${shortId(resolved.sessionId)}；历史保留，可从会话面板重新打开。`);
    },
};

/** 列出全部会话：归属 + 忙闲，附本实例的等待/待附加计数。 */
async function describeAll(
    control: SessionControl,
    caller?: string,
    includeResult = false,
): Promise<ToolExecutionResult> {
    const directory = getSessionDirectory();
    if (!directory) return err("当前环境没有会话目录（仅在 TUI 内可用）");

    const entries = await directory.list();
    if (entries.length === 0) return ok("当前没有会话");

    const ownership = await control.listOwnership(entries.map(entry => entry.sessionId));
    const lines = entries.map((entry) => {
        const state = ownership.get(entry.sessionId) ?? { state: "free" as const };
        const marker = state.state === "mine" ? "●" : state.state === "free" ? "○" : "👁";
        const title = entry.title ? `「${entry.title}」` : "";
        const current = entry.sessionId === caller ? " ← 你" : "";
        return `${marker} ${shortId(entry.sessionId)} ${title} ${describeOwnership(entry.sessionId, state)}${current}`;
    });

    const summary = [`会话（本实例 PID ${process.pid}）：`, ...lines];
    if (caller) {
        const awaiting = control.awaitingResults(caller);
        const queued = control.queuedResults(caller);
        summary.push(
            "",
            `等待别人回传的结果：${awaiting} 条 · 已就绪待附加：${queued} 条`,
            `本实例派生的子会话：${control.spawnedCount}/${MAX_SPAWNED_SESSIONS}`,
        );
        if (includeResult) summary.push(...(await recentResultLines(caller)));
    }
    summary.push("", "● 本实例持有 · 👁 其他实例持有 · ○ 未认领");
    return ok(summary.join("\n"));
}

/** 单个会话详情：归属、忙闲、本实例的等待与待附加计数。 */
async function describeOne(
    control: SessionControl,
    sessionId: string,
    caller?: string,
    includeResult = false,
): Promise<ToolExecutionResult> {
    const ownership = await control.probe(sessionId);
    const lines = [
        `会话 ${shortId(sessionId)}`,
        `归属：${describeOwnership(sessionId, ownership)}`,
    ];

    if (ownership.state === "other" && ownership.info) {
        lines.push(`对端标题：${ownership.info.title ?? "（无）"}`);
        lines.push(`处理中：${ownership.info.pending} 条`);
    }
    if (sessionId === caller) {
        lines.push("这是你所在的会话，不能给自己发消息。");
    } else {
        lines.push(`你可以用 session_send(session="${sessionId.slice(-8)}") 给它发消息。`);
    }
    if (includeResult) lines.push(...(await recentResultLines(sessionId)));
    return ok(lines.join("\n"));
}

/** 最近收到的会话间结果原文（include_result 时附带）。 */
async function recentResultLines(sessionId: string): Promise<string[]> {
    const history = getPeerResultHistory();
    if (!history) return ["", "最近结果：本实例未装配结果历史"];

    const latest = (await history.recentResults(sessionId, 1)).at(-1);
    if (!latest) return ["", "最近结果：（无）"];

    const peer = latest.peerTitle
        ? `${shortId(latest.peerId)}「${latest.peerTitle}」`
        : shortId(latest.peerId);
    const status = latest.lost ? "已丢失" : latest.late ? "迟到结果" : latest.ok ? "ok" : "失败";
    return ["", `最近结果（来自 ${peer} · ${latest.createdAt} · ${status}）：`, latest.text];
}

/** 把末几位 id 补全为完整会话 id；匹配不到时用原文（可能是尚未列入目录的会话）。 */
async function resolveSessionId(
    input: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const directory = getSessionDirectory();
    if (!directory) return { ok: true, sessionId: input };

    const entries = await directory.list();
    const exact = entries.find(entry => entry.sessionId === input);
    if (exact) return { ok: true, sessionId: exact.sessionId };

    const matched = entries.filter(entry => entry.sessionId.endsWith(input));
    if (matched.length === 0) {
        // 目录里没有：可能是别的实例刚建的会话，按原样尝试，由通道给出不可达错误
        return { ok: true, sessionId: input };
    }
    if (matched.length > 1) {
        return { ok: false, error: `会话 ${input} 匹配到多个候选，请写更长的 id` };
    }
    return { ok: true, sessionId: matched[0]!.sessionId };
}

function shortId(sessionId: string): string {
    return sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
}

export const SESSION_TOOLS: ExecutableTool[] = [sessionSpawnTool, sessionSendTool, sessionStatusTool, sessionCloseTool];

// 注册到工具目录供 executeMcpTool 查找；sessionScoped 保证默认不下发、不出现在 search_tools 结果里
toolCatalog.registerLocalTools(SESSION_TOOLS);

/**
 * 会话当前可用的会话间工具名。
 * 有会话上下文且进程装配了控制通道就注入：回合运行期间持有权不可能被释放，无须再看是否已认领。
 */
export function getSessionToolNames(sessionId?: string): string[] {
    if (!sessionId) return [];
    return getSessionControl() ? [...SESSION_TOOL_NAMES] : [];
}
