/**
 * 会话命令行：让其他 AI 或用户直接增删查改 ~/.zbot/sessions 下的会话。
 *
 * 与 TUI 并存时的安全边界：
 * - 读操作（list / show）只读事件日志，任何时刻可执行；
 * - 写操作（new / rename / archive / unarchive / delete）要求目标会话未被任何实例持有
 *   （控制 socket 无监听者），并在会话锁内落盘，避免与运行中的 TUI 双写事件序列；
 * - send 是唯一需要"有实例持有"的操作：它通过控制 socket 投递给运行中的会话。
 *
 * 输出默认人类可读，`--json` 给结构化数据（供其他 AI 解析）。
 */

import fs from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { EventLog } from "../events/event-log.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { SessionReplay } from "../events/session-replay.js";
import { summarizeEvents } from "../tui/agent-summary.js";
import { abbreviatePath } from "../tui/session-row.js";
import { padColumns, truncatePlain } from "../tui/panel-text.js";
import { sortSessions, type SessionOrderItem } from "../utils/session-order.js";
import { formatRelativeTime } from "../utils/time.js";
import { createUlid } from "../utils/ulid.js";
import { resolveCwdInput } from "../utils/runtime-paths.js";
import { acquireSessionLock, isSessionLockedByOtherSync } from "../utils/session-lock.js";
import { removeSessionArtifacts } from "../events/session-cleanup.js";
import { listOwnership, probeOwnership, type PeerOwnership } from "../control/registry.js";
import { getSocketPath } from "../control/paths.js";
import { PeerConnection } from "../control/client.js";
import { createPeerMessage, type PeerResult } from "../control/protocol.js";
import type { TuiSessionSummary } from "../tui/agent-types.js";
import type { StoredChatMessage } from "../types/session.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { UserContent } from "../types/image.js";

/** show 默认展示的轮数：够看上下文，又不至于刷屏。 */
const DEFAULT_SHOW_TURNS = 3;
/** 非 --full 时单条消息的预览列宽。 */
const MESSAGE_PREVIEW_COLUMNS = 200;
/** 列表列宽上限：宽字符按显示列计，避免中文标题把表格拉歪。 */
const TITLE_COLUMNS = 40;
const CWD_COLUMNS = 28;
/** send --wait 的默认等待上限。 */
const DEFAULT_WAIT_SECONDS = 300;
/** 会话标题长度上限，与 TUI 的 renameSession 保持一致。 */
const MAX_TITLE_LENGTH = 200;

const eventLog = new EventLog();
const replay = new SessionReplay(eventLog);

const SESSION_CLI_USAGE = [
    "用法：zbot session <子命令> [参数]",
    "",
    "  list [--all] [--json]                     列出会话（默认不含归档）",
    "  show <id> [--turns N|--all] [--full] [--json]",
    "                                            查看会话与消息（默认最近 3 轮）",
    "  new [--title 标题] [--cwd 目录] [--json]  新建会话",
    "  rename <id> <标题>                        重命名会话",
    "  archive <id> / unarchive <id>             归档 / 取消归档",
    "  delete <id>                               彻底删除会话的全部落盘数据",
    "  send <id> <文本> [--wait[=秒]] [--json]   向运行中的会话投递消息",
    "",
    "id 支持完整 id、唯一前缀或末几位；写操作要求会话未被其他实例持有。",
].join("\n");

/** 列表行：摘要 + 归属（socket 探测结果）；排序键与摘要同源，供 sortSessions 使用。 */
export interface SessionRow extends SessionOrderItem {
    summary: TuiSessionSummary;
    ownership?: PeerOwnership;
    /** 真实创建时间（首条事件 ts）。 */
    createdAt?: string;
}

interface ListCommand {
    kind: "list";
    all: boolean;
    json: boolean;
}

interface ShowCommand {
    kind: "show";
    id: string;
    turns: number;
    all: boolean;
    full: boolean;
    json: boolean;
}

interface NewCommand {
    kind: "new";
    title?: string;
    cwd?: string;
    json: boolean;
}

interface RenameCommand {
    kind: "rename";
    id: string;
    title: string;
}

interface ArchiveCommand {
    kind: "archive" | "unarchive";
    id: string;
}

interface DeleteCommand {
    kind: "delete";
    id: string;
}

interface SendCommand {
    kind: "send";
    id: string;
    text: string;
    /** undefined 表示不等待结果（异步投递）。 */
    waitSeconds?: number;
    json: boolean;
}

export type SessionCommand =
    | { kind: "help" }
    | ListCommand
    | ShowCommand
    | NewCommand
    | RenameCommand
    | ArchiveCommand
    | DeleteCommand
    | SendCommand;

export interface SessionCliIO {
    /** 标准输出：默认写 process.stdout。 */
    write?: (text: string) => void;
    /** 读取 stdin（send 未给文本时用）；默认读到 EOF。 */
    readStdin?: () => Promise<string>;
}

// ── 参数解析 ──────────────────────────────────────────────────

export function isSessionCliInvocation(argv: string[]): boolean {
    return argv[0] === "session" || argv[0] === "sessions";
}

export function parseSessionArgs(argv: string[]): SessionCommand {
    const [command, ...rest] = argv;
    switch (command) {
        case undefined:
        case "help":
        case "-h":
        case "--help":
            return { kind: "help" };
        case "list":
        case "ls":
            return parseListArgs(rest);
        case "show":
        case "cat":
            return parseShowArgs(rest);
        case "new":
            return parseNewArgs(rest);
        case "rename":
            return parseRenameArgs(rest);
        case "archive":
            return { kind: "archive", id: requireSingleId(rest, "archive") };
        case "unarchive":
            return { kind: "unarchive", id: requireSingleId(rest, "unarchive") };
        case "delete":
        case "rm":
            return { kind: "delete", id: requireSingleId(rest, "delete") };
        case "send":
            return parseSendArgs(rest);
        default:
            throw new Error(`未知子命令：${command}\n\n${SESSION_CLI_USAGE}`);
    }
}

function parseListArgs(args: string[]): ListCommand {
    const command: ListCommand = { kind: "list", all: false, json: false };
    for (const arg of args) {
        if (arg === "--all" || arg === "-a") command.all = true;
        else if (arg === "--json") command.json = true;
        else throw new Error(`list 不支持参数：${arg}`);
    }
    return command;
}

function parseShowArgs(args: string[]): ShowCommand {
    const command: ShowCommand = { kind: "show", id: "", turns: DEFAULT_SHOW_TURNS, all: false, full: false, json: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") command.json = true;
        else if (arg === "--full") command.full = true;
        else if (arg === "--all" || arg === "-a") command.all = true;
        else if (arg === "--turns") {
            command.turns = parsePositiveInt(args[index + 1], "--turns");
            index += 1;
        } else if (arg.startsWith("--turns=")) {
            command.turns = parsePositiveInt(arg.slice("--turns=".length), "--turns");
        } else if (arg.startsWith("-")) {
            throw new Error(`show 不支持参数：${arg}`);
        } else if (command.id) {
            throw new Error("show 只接受一个会话 id");
        } else {
            command.id = arg;
        }
    }
    if (!command.id) throw new Error("用法：zbot session show <id> [--turns N|--all] [--full] [--json]");
    return command;
}

function parseNewArgs(args: string[]): NewCommand {
    const command: NewCommand = { kind: "new", json: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") command.json = true;
        else if (arg === "--title") {
            command.title = requireValue(args[index + 1], "--title");
            index += 1;
        } else if (arg.startsWith("--title=")) {
            command.title = requireValue(arg.slice("--title=".length), "--title");
        } else if (arg === "--cwd") {
            command.cwd = requireValue(args[index + 1], "--cwd");
            index += 1;
        } else if (arg.startsWith("--cwd=")) {
            command.cwd = requireValue(arg.slice("--cwd=".length), "--cwd");
        } else {
            throw new Error(`new 不支持参数：${arg}`);
        }
    }
    return command;
}

function parseRenameArgs(args: string[]): RenameCommand {
    const [id, ...titleParts] = args;
    if (!id || id.startsWith("-")) throw new Error("用法：zbot session rename <id> <标题>");
    const title = titleParts.join(" ").trim();
    if (!title) throw new Error("rename 需要新标题");
    return { kind: "rename", id, title };
}

function parseSendArgs(args: string[]): SendCommand {
    const command: SendCommand = { kind: "send", id: "", text: "", json: false };
    const textParts: string[] = [];
    for (const arg of args) {
        if (arg === "--json") command.json = true;
        else if (arg === "--wait") command.waitSeconds = DEFAULT_WAIT_SECONDS;
        else if (arg === "--no-wait") command.waitSeconds = undefined;
        else if (arg.startsWith("--wait=")) command.waitSeconds = parsePositiveInt(arg.slice("--wait=".length), "--wait");
        else if (!command.id) {
            if (arg.startsWith("-")) throw new Error(`send 需要会话 id，收到参数：${arg}`);
            command.id = arg;
        } else textParts.push(arg);
    }
    if (!command.id) throw new Error("用法：zbot session send <id> <文本> [--wait[=秒]]");
    command.text = textParts.join(" ").trim();
    return command;
}

function requireSingleId(args: string[], command: string): string {
    const id = args[0];
    if (!id || id.startsWith("-")) throw new Error(`用法：zbot session ${command} <id>`);
    if (args.length > 1) throw new Error(`${command} 只接受一个会话 id`);
    return id;
}

function requireValue(value: string | undefined, flag: string): string {
    if (!value || value.startsWith("-")) throw new Error(`${flag} 需要取值`);
    return value;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} 需要正整数`);
    return parsed;
}

// ── 入口 ─────────────────────────────────────────────────────

export async function runSessionCli(argv: string[], io: SessionCliIO = {}): Promise<void> {
    const command = parseSessionArgs(argv);
    const write = io.write ?? ((text: string) => { process.stdout.write(text); });
    switch (command.kind) {
        case "help":
            write(`${SESSION_CLI_USAGE}\n`);
            return;
        case "list":
            return runList(command, write);
        case "show":
            return runShow(command, write);
        case "new":
            return runNew(command, write);
        case "rename":
            return runRename(command, write);
        case "archive":
        case "unarchive":
            return runArchive(command, write);
        case "delete":
            return runDelete(command, write);
        case "send":
            return runSend(command, write, io.readStdin ?? readStdin);
    }
}

async function runList(command: ListCommand, write: (text: string) => void): Promise<void> {
    const savedIds = listSavedSessionIds();
    const ownership = await listOwnership(savedIds);
    const rows: SessionRow[] = [];
    for (const sessionId of savedIds) {
        const meta = await readSessionMeta(sessionId);
        if (!meta) continue;
        const { summary } = meta;
        rows.push({
            sessionId,
            ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
            ...(summary.archived ? { archived: true } : {}),
            summary,
            ownership: ownership.get(sessionId),
            ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
        });
    }
    const visible = sortSessions(rows).filter(row => command.all || !row.summary.archived);

    if (command.json) {
        write(`${JSON.stringify(visible.map(toJsonRow), null, 2)}\n`);
        return;
    }
    if (visible.length === 0) {
        write("（没有会话）\n");
        return;
    }
    write(`${formatTable(visible).join("\n")}\n`);
}

async function runShow(command: ShowCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const [meta, replayed, ownership] = await Promise.all([
        readSessionMeta(sessionId),
        replay.replayTo(sessionId),
        probeOwnership(sessionId),
    ]);
    const summary = meta?.summary;
    const { session } = replayed;
    const turns = command.all ? session.turns : session.turns.slice(-command.turns);
    const startIndex = session.turns.length - turns.length;
    // 标题口径与 TUI 一致：显式重命名优先，否则取首条用户消息（session.title 只记重命名）
    const title = summary?.title ?? session.title;

    if (command.json) {
        write(`${JSON.stringify({
            sessionId,
            title,
            cwd: session.cwd,
            ...toJsonOwnership(ownership),
            archived: summary?.archived === true,
            totalTurns: session.turns.length,
            createdAt: meta?.createdAt,
            updatedAt: summary?.updatedAt,
            modelSelection: session.modelSelection,
            lastPromptTokens: session.lastPromptTokens,
            compactCount: session.compactCount,
            turns: turns.map((turn, index) => ({
                index: startIndex + index + 1,
                id: turn.id,
                status: turn.status,
                messages: turn.messages,
            })),
        }, null, 2)}\n`);
        return;
    }

    const lines = [
        `会话   ${sessionId}`,
        `标题   ${title ?? "（未命名）"}`,
        `目录   ${abbreviatePath(session.cwd, process.env.HOME, CWD_COLUMNS)}`,
        `状态   ${describeOwnership(ownership)}${summary?.archived ? " · 已归档" : ""}`,
        `轮数   ${session.turns.length}（压缩 ${session.compactCount} 次）`,
        `更新   ${formatTimestamp(summary?.updatedAt)}`,
        `创建   ${formatTimestamp(meta?.createdAt)}`,
    ];
    if (session.modelSelection) lines.push(`模型   ${formatModel(session.modelSelection)}`);
    if (session.lastPromptTokens) lines.push(`上下文 最近一次输入 ${session.lastPromptTokens} tokens`);

    lines.push("", `消息（${describeTurnRange(startIndex, session.turns.length)}）`);
    turns.forEach((turn, index) => {
        lines.push(...renderTurn(turn, startIndex + index + 1, command.full));
    });
    write(`${lines.join("\n")}\n`);
}

async function runNew(command: NewCommand, write: (text: string) => void): Promise<void> {
    const cwd = command.cwd ? resolveCwdInput(command.cwd, process.cwd()) : process.cwd();
    if (!isDirectory(cwd)) throw new Error(`cwd 不是已存在的目录：${cwd}`);
    const title = command.title ? cleanTitle(command.title) : undefined;

    const sessionId = createUlid();
    await eventLog.append(sessionId, "session_created", { cwd });
    if (title) await eventLog.append(sessionId, "session_renamed", { title });

    if (command.json) {
        write(`${JSON.stringify({ sessionId, cwd, title }, null, 2)}\n`);
        return;
    }
    write(`已创建会话 ${sessionId}（${abbreviatePath(cwd, process.env.HOME, CWD_COLUMNS)}）${title ? `「${title}」` : ""}\n`);
}

async function runRename(command: RenameCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    await assertSessionFree(sessionId);
    const title = cleanTitle(command.title);
    await withSessionLock(sessionId, async () => {
        await eventLog.append(sessionId, "session_renamed", { title });
    });
    write(`已重命名 ${shortId(sessionId)} → ${title}\n`);
}

async function runArchive(command: ArchiveCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    await assertSessionFree(sessionId);
    await withSessionLock(sessionId, async () => {
        await eventLog.append(
            sessionId,
            command.kind === "archive" ? "session_archived" : "session_unarchived",
            {},
        );
    });
    write(`${command.kind === "archive" ? "已归档" : "已取消归档"} ${shortId(sessionId)}\n`);
}

async function runDelete(command: DeleteCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    await assertSessionFree(sessionId);

    const meta = await readSessionMeta(sessionId);
    await withSessionLock(sessionId, async () => {
        await removeSessionArtifacts(sessionId);
    });
    write(`已删除 ${shortId(sessionId)}（${meta?.summary.messageCount ?? 0} 轮）\n`);
}

async function runSend(
    command: SendCommand,
    write: (text: string) => void,
    readStdinText: () => Promise<string>,
): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const text = command.text || (await readStdinText()).trim();
    if (!text) throw new Error("send 需要消息正文");

    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        throw new Error(
            `会话 ${shortId(sessionId)} 没有运行中的实例持有，投递无法执行；先在 TUI 里打开该会话，或用 session new 新建`,
        );
    }

    let settleResult: (result: PeerResult) => void = () => undefined;
    const resultPromise = new Promise<PeerResult>((resolve) => {
        settleResult = resolve;
    });
    const message = createPeerMessage({
        from: `cli-${process.pid}`,
        to: sessionId,
        text,
        ...(command.waitSeconds === undefined ? {} : { expectResult: true }),
    });
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: (result) => settleResult(result),
    });

    try {
        const reply = await connection.deliver(message);
        if (reply.type !== "ack") throw new Error(`会话 ${shortId(sessionId)} 返回了非预期应答`);
        if (!reply.ok) throw new Error(describeAckError(sessionId, reply.error));

        if (command.waitSeconds === undefined) {
            if (command.json) write(`${JSON.stringify({ sessionId, msgId: message.id, delivered: true }, null, 2)}\n`);
            else write(`已投递到 ${shortId(sessionId)}（${message.id}）\n`);
            return;
        }

        const result = await withTimeout(resultPromise, command.waitSeconds * 1000, sessionId);
        if (command.json) {
            write(`${JSON.stringify({ sessionId, ...result }, null, 2)}\n`);
            return;
        }
        if (!result.ok) {
            throw new Error(result.error ?? `会话 ${shortId(sessionId)} 执行失败：${result.stopReason}`);
        }
        write(result.text ? `${result.text}\n` : "（对方回合没有输出）\n");
    } finally {
        connection.close();
    }
}

// ── 会话数据读取 ─────────────────────────────────────────────

/** 会话摘要 + 真实创建时间（取首条事件 ts；Session.createdAt 是重放时刻，不能代表创建时间）。 */
async function readSessionMeta(
    sessionId: string,
): Promise<{ summary: TuiSessionSummary; createdAt?: string } | null> {
    const events = await eventLog.read(sessionId);
    if (events.length === 0) return null;
    return { summary: summarizeEvents(sessionId, events), ...(events[0] ? { createdAt: events[0].ts } : {}) };
}

/** 把用户输入的 id 补全：优先精确匹配，其次唯一前缀，再次唯一后缀（工具里惯用末几位）。 */
export function resolveSessionIdFrom(input: string, savedIds: string[]): string {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("需要会话 id");
    if (savedIds.includes(trimmed)) return trimmed;

    const prefix = savedIds.filter(sessionId => sessionId.startsWith(trimmed));
    if (prefix.length === 1) return prefix[0]!;
    const suffix = savedIds.filter(sessionId => sessionId.endsWith(trimmed));
    if (suffix.length === 1) return suffix[0]!;

    const candidates = prefix.length > 1 ? prefix : suffix;
    if (candidates.length > 1) {
        throw new Error(`会话 ${trimmed} 匹配到多个候选：${candidates.map(shortId).join(" ")}，请写更长的 id`);
    }
    throw new Error(`会话不存在：${trimmed}`);
}

async function resolveSessionId(input: string): Promise<string> {
    return resolveSessionIdFrom(input, listSavedSessionIds());
}

function toJsonRow(row: SessionRow): Record<string, unknown> {
    const { summary } = row;
    return {
        sessionId: summary.sessionId,
        title: summary.title,
        cwd: summary.cwd,
        turns: summary.messageCount,
        createdAt: row.createdAt,
        updatedAt: summary.updatedAt,
        archived: summary.archived === true,
        ...(summary.archived ? { status: "archived" } : toJsonOwnership(row.ownership)),
        modelSelection: summary.modelSelection,
    };
}

/** 归属的机器可读形态（`--json` 用），人读文案见 describeOwnership。 */
function toJsonOwnership(ownership?: PeerOwnership): { status: string; holderPid?: number; busy?: boolean } {
    if (!ownership || ownership.state === "free") return { status: "idle" };
    if (ownership.state === "mine") return { status: "mine", holderPid: process.pid };
    const info = ownership.info;
    return { status: "held", ...(info ? { holderPid: info.pid, busy: info.busy } : {}) };
}

// ── 展示 ─────────────────────────────────────────────────────

const TABLE_HEADERS = ["状态", "ID", "轮数", "更新", "目录", "标题"];

export function formatTable(rows: SessionRow[]): string[] {
    const body = rows.map(row => [
        row.summary.archived ? "已归档" : describeOwnership(row.ownership),
        shortId(row.summary.sessionId),
        `${row.summary.messageCount}轮`,
        formatRelativeTime(row.summary.updatedAt),
        abbreviatePath(row.summary.cwd ?? "", process.env.HOME, CWD_COLUMNS) || "-",
        truncatePlain(row.summary.title ?? "-", TITLE_COLUMNS) || "-",
    ]);
    const widths = TABLE_HEADERS.map((header, column) => Math.max(
        visibleWidth(header),
        ...body.map(cells => visibleWidth(cells[column] ?? "")),
    ));
    const joinRow = (cells: string[]) => cells
        .map((cell, column) => padColumns(cell, widths[column] ?? 0))
        .join("  ")
        .trimEnd();
    return [joinRow(TABLE_HEADERS), ...body.map(joinRow)];
}

function renderTurn(turn: { status: string; messages: StoredChatMessage[] }, index: number, full: boolean): string[] {
    const createdAt = turn.messages[0]?.createdAt;
    const lines = [`── #${index} ${turn.status}${createdAt ? ` ${formatDateTime(createdAt)}` : ""}`];
    if (turn.messages.length === 0) lines.push("  （空回合）");
    for (const message of turn.messages) lines.push(...renderMessage(message, full));
    return lines;
}

function renderMessage(message: StoredChatMessage, full: boolean): string[] {
    switch (message.role) {
        case "user":
            return [`user: ${formatBody(userText(message.content), full)}`];
        case "assistant": {
            const lines: string[] = [];
            if (message.content) lines.push(`assistant: ${formatBody(message.content, full)}`);
            for (const call of message.tool_calls ?? []) {
                const name = call?.function?.name ?? call?.name ?? "tool";
                const args = call?.function?.arguments ?? "";
                lines.push(`  ⤷ ${name}(${formatBody(String(args), full)})`);
            }
            return lines.length > 0 ? lines : ["assistant:（空）"];
        }
        case "tool":
            return [`tool[${message.name ?? message.tool_call_id}]: ${formatBody(message.content, full)}`];
        case "system":
            return [`system: ${formatBody(message.content, full)}`];
    }
}

function formatBody(text: string, full: boolean): string {
    if (!text) return "（空）";
    if (!full) return truncatePlain(text, MESSAGE_PREVIEW_COLUMNS);
    return text.replace(/\n/g, "\n  ");
}

function userText(content: UserContent): string {
    if (typeof content === "string") return content;
    return (content ?? [])
        .map(part => {
            if (part.type === "text") return part.text;
            if (part.type === "input_audio") return "[音频]";
            return "[图片]";
        })
        .join(" ");
}

function describeOwnership(ownership?: PeerOwnership): string {
    if (!ownership || ownership.state === "free") return "空闲";
    if (ownership.state === "mine") return "本实例";
    const info = ownership.info;
    if (!info) return "被占用";
    return `运行中(pid ${info.pid}${info.busy ? " 忙" : ""})`;
}

function describeAckError(sessionId: string, code: string): string {
    switch (code) {
        case "busy":
            return `会话 ${shortId(sessionId)} 正在执行中，请稍后重试`;
        case "unreachable":
            return `会话 ${shortId(sessionId)} 不可达（进程可能刚退出）`;
        default:
            return `会话 ${shortId(sessionId)} 拒绝了消息（${code}）`;
    }
}

function formatTimestamp(iso?: string): string {
    if (!iso) return "（无）";
    return `${formatDateTime(iso)}（${formatRelativeTime(iso)}）`;
}

/** 展示的轮次范围：单轮不写成 `第 13-13 轮`。 */
function describeTurnRange(startIndex: number, total: number): string {
    if (total === 0) return "无";
    if (total - startIndex === 1) return `第 ${total} 轮，共 ${total} 轮`;
    return `第 ${startIndex + 1}-${total} 轮，共 ${total} 轮`;
}

/** 事件时间统一用 UTC ISO 落盘，展示时按本机时区换算，避免同一屏里混着两种时区。 */
function formatDateTime(iso: string): string {
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) return iso;
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
        + ` ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** 模型选择只展示协议与模型名，便于跨会话比较。 */
function formatModel(selection: ChatModelSelection): string {
    return [selection.protocol, selection.model].filter(Boolean).join(" · ") || "（未知）";
}

function shortId(sessionId: string): string {
    return sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
}

// ── 守卫与工具 ────────────────────────────────────────────────

/** 写操作前确认没有实例持有该会话：持有者的内存状态不会跟着事件日志走，双写会让 seq 分叉。 */
async function assertSessionFree(sessionId: string): Promise<void> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        if (isSessionLockedByOtherSync(sessionId)) {
            throw new Error(`会话 ${shortId(sessionId)} 正被其他进程写入，请稍后重试`);
        }
        return;
    }
    const info = ownership.state === "other" ? ownership.info : undefined;
    throw new Error(
        `会话 ${shortId(sessionId)} 正被其他实例持有${info ? `（pid ${info.pid}${info.busy ? "，执行中" : ""}）` : ""}`
        + "，请在那个实例里操作，或先 /close 释放后再试",
    );
}

async function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const lock = await acquireSessionLock(sessionId);
    try {
        return await run();
    } finally {
        await lock.release();
    }
}

function withTimeout(promise: Promise<PeerResult>, timeoutMs: number, sessionId: string): Promise<PeerResult> {
    return new Promise<PeerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`等待会话 ${shortId(sessionId)} 的结果超时（${Math.round(timeoutMs / 1000)}s）`));
        }, timeoutMs);
        timer.unref?.();
        promise.then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function cleanTitle(title: string): string {
    const cleaned = title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!cleaned) throw new Error("标题不能为空");
    return cleaned;
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

async function readStdin(): Promise<string> {
    // 交互式终端下不等 stdin：没有正文时应立刻报用法错误，而不是挂住进程
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
