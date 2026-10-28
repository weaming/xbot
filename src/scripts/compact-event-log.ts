/**
 * 事件日志压缩：清除已定稿回合的流式片段（turn_stream_delta）。
 *
 * 旧版本把每个 token 逐条 append 到主日志，而片段在 turn_commit 之后没有任何读取方，
 * 单会话可膨胀到上百 MB。这里按 turnId 判断：已提交的片段丢弃，未闭合回合（崩溃残留）
 * 的片段转存到 <sid>.stream.jsonl，保持与新写入路径一致的恢复能力。
 *
 * 用法：
 *   bun src/scripts/compact-event-log.ts              # 只统计，不写盘
 *   bun src/scripts/compact-event-log.ts --apply      # 实际压缩
 *   bun src/scripts/compact-event-log.ts --dir <dir>  # 指定 events 目录（默认当前状态目录）
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getSessionsDir } from "../utils/runtime-paths.js";

/** 最近被改动的日志视为可能有进程在写，默认跳过。 */
const ACTIVE_WINDOW_MS = 60_000;

interface Options {
    dir: string;
    apply: boolean;
    force: boolean;
}

interface StreamBatch {
    ts: string;
    turnId: string;
    requestIndex: number;
    deltas: unknown[];
}

interface FileStat {
    name: string;
    beforeBytes: number;
    afterBytes: number;
    removed: number;
    salvaged: number;
    skipped?: string;
}

function parseOptions(argv: string[]): Options {
    const options: Options = { dir: getSessionsDir("events"), apply: false, force: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--apply") options.apply = true;
        else if (arg === "--force") options.force = true;
        else if (arg === "--dir") {
            const value = argv[index + 1];
            if (!value) throw new Error("--dir 需要目录参数");
            options.dir = path.resolve(value);
            index += 1;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return options;
}

async function eachLine(filePath: string, onLine: (line: string) => void): Promise<void> {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
        if (line.trim()) onLine(line);
    }
}

/** 第一遍：收集已定稿回合的 turnId。 */
async function collectCommittedTurns(filePath: string): Promise<Set<string>> {
    const committed = new Set<string>();
    await eachLine(filePath, line => {
        if (!line.includes('"turn_commit"')) return;
        try {
            const event = JSON.parse(line) as { type?: string; payload?: { turnId?: string } };
            if (event.type === "turn_commit" && event.payload?.turnId) committed.add(event.payload.turnId);
        } catch {
            // 损坏行原样保留，交给读取侧跳过
        }
    });
    return committed;
}

/** 逐文件压缩；dryRun 时只统计不写盘。 */
async function compactFile(filePath: string, options: Options): Promise<FileStat> {
    const name = path.basename(filePath);
    const beforeBytes = fs.statSync(filePath).size;
    const stat: FileStat = { name, beforeBytes, afterBytes: beforeBytes, removed: 0, salvaged: 0 };

    if (!options.force && Date.now() - fs.statSync(filePath).mtimeMs < ACTIVE_WINDOW_MS) {
        return { ...stat, skipped: "最近 1 分钟内有写入，跳过（--force 可强制）" };
    }

    const committed = await collectCommittedTurns(filePath);
    if (committed.size === 0) return { ...stat, skipped: "没有已定稿回合" };

    const tempPath = `${filePath}.compact.tmp`;
    const streamPath = filePath.replace(/\.jsonl$/, ".stream.jsonl");
    const out = options.apply ? fs.createWriteStream(tempPath, { encoding: "utf8" }) : null;
    const salvaged: string[] = [];
    let batch: StreamBatch | null = null;

    const sealBatch = (): void => {
        if (batch && batch.deltas.length > 0) salvaged.push(JSON.stringify(batch));
        batch = null;
    };

    const write = (text: string): void => {
        if (out) out.write(text);
    };

    await eachLine(filePath, line => {
        if (!line.includes('"turn_stream_delta"')) {
            write(line + "\n");
            return;
        }

        let event: {
            seq?: number;
            ts?: string;
            payload?: { turnId?: string; requestIndex?: number; delta?: unknown };
        };
        try {
            event = JSON.parse(line);
        } catch {
            write(line + "\n");
            return;
        }
        const turnId = event.payload?.turnId;
        if (!turnId || committed.has(turnId)) {
            stat.removed += 1;
            return;
        }

        // 未闭合回合：片段转存到 pending 流文件，按请求聚合成批量行
        const requestIndex = event.payload?.requestIndex ?? 0;
        if (!batch || batch.turnId !== turnId || batch.requestIndex !== requestIndex) {
            sealBatch();
            batch = { ts: event.ts ?? new Date().toISOString(), turnId, requestIndex, deltas: [] };
        }
        batch.deltas.push(event.payload?.delta);
        stat.salvaged += 1;
    });
    sealBatch();

    if (!options.apply || !out) {
        stat.afterBytes = beforeBytes;
        return stat;
    }

    await new Promise<void>((resolve, reject) => {
        out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
    stat.afterBytes = fs.statSync(tempPath).size;
    if (salvaged.length > 0) {
        const existing = fs.existsSync(streamPath) ? fs.readFileSync(streamPath, "utf8") : "";
        const merged = existing + salvaged.map(text => text + "\n").join("");
        fs.writeFileSync(streamPath, merged, "utf8");
    }
    fs.renameSync(tempPath, filePath);
    return stat;
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    if (!fs.existsSync(options.dir)) throw new Error(`目录不存在: ${options.dir}`);

    const files = fs
        .readdirSync(options.dir)
        .filter(name => name.endsWith(".jsonl") && !name.endsWith(".stream.jsonl"))
        .map(name => path.join(options.dir, name));

    console.log(`${options.apply ? "压缩" : "试算（加 --apply 才写盘）"}：${files.length} 个事件日志 @ ${options.dir}`);

    let totalBefore = 0;
    let totalAfter = 0;
    let totalRemoved = 0;
    let totalSalvaged = 0;
    for (const filePath of files) {
        const stat = await compactFile(filePath, options);
        totalBefore += stat.beforeBytes;
        totalAfter += stat.afterBytes;
        totalRemoved += stat.removed;
        totalSalvaged += stat.salvaged;
        if (stat.removed === 0 && !stat.skipped) continue;
        const detail = stat.skipped
            ? `跳过：${stat.skipped}`
            : `${mb(stat.beforeBytes)} → ${mb(stat.afterBytes)}，删 ${stat.removed} 条${stat.salvaged ? `，转存 ${stat.salvaged} 条` : ""}`;
        console.log(`  ${stat.name}: ${detail}`);
    }

    console.log(
        `合计 ${mb(totalBefore)} → ${mb(totalAfter)}（省 ${mb(totalBefore - totalAfter)}），` +
            `删除 ${totalRemoved} 条流式片段，转存 ${totalSalvaged} 条到 pending 文件`,
    );
}

function mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch(error => {
    console.error(`压缩失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
