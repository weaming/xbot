/**
 * 数据操作工具：read_json / write_json / edit_json / read_csv / write_csv / run_jq
 * JSON 工具为 core（配置/数据读写），CSV/jq 工具为 data 标签（数据处理）。
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { ok, err } from "./tool-interface.js";
import { resolvePath } from "./path-utils.js";
import { getWorkspaceRoot } from "../utils/runtime-paths.js";

// ─── JSON key-path helpers ────────────────────────────────────────────────────

function getByKeyPath(data: any, keyPath: string): { found: boolean; value: any } {
    const parts = keyPath.split(".");
    let current = data;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") {
            return { found: false, value: undefined };
        }
        const index = parseInt(part, 10);
        current = !isNaN(index) && Array.isArray(current) ? current[index] : current[part];
    }
    return current === undefined ? { found: false, value: undefined } : { found: true, value: current };
}

function setByKeyPath(data: any, keyPath: string, value: any): void {
    const parts = keyPath.split(".");
    const lastKey = parts.pop()!;
    let target = data;
    for (const part of parts) {
        if (target[part] === undefined || typeof target[part] !== "object") {
            target[part] = {};
        }
        target = target[part];
    }
    target[lastKey] = value;
}

function deleteByKeyPath(data: any, keyPath: string): boolean {
    const parts = keyPath.split(".");
    const lastKey = parts.pop()!;
    let target = data;
    for (const part of parts) {
        if (target[part] === undefined) return false;
        target = target[part];
    }
    if (!(lastKey in target)) return false;
    delete target[lastKey];
    return true;
}

// ─── read_json ────────────────────────────────────────────────────────────────

export const readJsonTool: ExecutableTool = {
    name: "read_json",
    description: "读取 JSON 文件，支持按点分路径提取字段（如 user.name、items.0.id）。",
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "JSON 文件路径" },
            key_path: { type: "string", description: "点分路径提取字段（可选），如 server.port 或 users.0.name" },
        },
        required: ["path"],
    },
    execute: async (args: { path: string; key_path?: string }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.path);
        if (!fs.existsSync(resolved)) return err(`文件不存在：${resolved}`);

        let data: any;
        try {
            data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
        } catch (e: any) {
            return err(`JSON 解析失败：${e.message}`);
        }

        if (!args.key_path) {
            return ok(JSON.stringify(data, null, 2));
        }

        const { found, value } = getByKeyPath(data, args.key_path);
        if (!found) return err(`路径不存在：${args.key_path}`);

        return ok(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    },
};

// ─── write_json ───────────────────────────────────────────────────────────────

export const writeJsonTool: ExecutableTool = {
    name: "write_json",
    description: "写入 JSON 文件（覆盖）。目录不存在时自动创建。",
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "JSON 文件路径" },
            value: { description: "写入的 JSON 值（对象、数组或基本类型）" },
            indent: { type: "number", description: "缩进空格数，默认 2" },
        },
        required: ["path", "value"],
    },
    execute: async (args: { path: string; value: any; indent?: number }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.path);

        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        const content = JSON.stringify(args.value, null, args.indent ?? 2);
        fs.writeFileSync(resolved, content, "utf-8");

        return ok(`✅ 已写入：${resolved}（${Buffer.byteLength(content, "utf-8")} bytes）`);
    },
};

// ─── edit_json ────────────────────────────────────────────────────────────────

export const editJsonTool: ExecutableTool = {
    name: "edit_json",
    description: "按点分路径 set 或 delete JSON 字段，自动格式化保存。",
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "JSON 文件路径" },
            key_path: { type: "string", description: "点分路径，如 server.port 或 users.0.name" },
            value: { description: "新值（operation=set 时必填）" },
            operation: { type: "string", enum: ["set", "delete"], description: "操作类型，默认 set" },
            indent: { type: "number", description: "缩进空格数，默认 2" },
        },
        required: ["path", "key_path"],
    },
    execute: async (args: {
        path: string;
        key_path: string;
        value?: any;
        operation?: "set" | "delete";
        indent?: number;
    }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.path);
        if (!fs.existsSync(resolved)) return err(`文件不存在：${resolved}`);

        let data: any;
        try {
            data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
        } catch (e: any) {
            return err(`JSON 解析失败：${e.message}`);
        }

        const operation = args.operation ?? "set";

        if (operation === "delete") {
            if (!deleteByKeyPath(data, args.key_path)) {
                return err(`路径不存在：${args.key_path}`);
            }
        } else {
            if (args.value === undefined) return err("set 操作需提供 value");
            setByKeyPath(data, args.key_path, args.value);
        }

        const content = JSON.stringify(data, null, args.indent ?? 2);
        fs.writeFileSync(resolved, content, "utf-8");

        return ok(`✅ 已${operation === "delete" ? "删除" : "更新"} ${args.key_path}：${resolved}`);
    },
};

// ─── CSV parsing helpers ──────────────────────────────────────────────────────

function parseCSVToObjects(content: string, delimiter: string): Record<string, string>[] {
    const records: string[][] = [];
    let fields: string[] = [];
    let field = "";
    let isInQuotes = false;

    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (character === '"') {
            if (isInQuotes && content[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                isInQuotes = !isInQuotes;
            }
            continue;
        }

        if (!isInQuotes && content.startsWith(delimiter, index)) {
            fields.push(field);
            field = "";
            index += delimiter.length - 1;
            continue;
        }

        if (!isInQuotes && (character === "\n" || character === "\r")) {
            if (character === "\r" && content[index + 1] === "\n") index += 1;
            fields.push(field);
            if (!(fields.length === 1 && fields[0].trim() === "")) records.push(fields);
            fields = [];
            field = "";
            continue;
        }

        field += character;
    }

    fields.push(field);
    if (!(fields.length === 1 && fields[0].trim() === "")) records.push(fields);
    if (records.length < 2) return [];

    const [headers, ...dataRows] = records;
    return dataRows.map((values) => {
        return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
    });
}

function objectsToCSV(records: Record<string, any>[], delimiter: string): string {
    if (records.length === 0) return "";
    const headers = Object.keys(records[0]);

    const escapeField = (value: any): string => {
        const str = value === null || value === undefined ? "" : String(value);
        if (str.includes(delimiter) || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    return [
        headers.map(escapeField).join(delimiter),
        ...records.map(r => headers.map(h => escapeField(r[h])).join(delimiter)),
    ].join("\n");
}

// ─── read_csv ─────────────────────────────────────────────────────────────────

export const readCsvTool: ExecutableTool = {
    name: "read_csv",
    description: "读取 CSV/TSV 文件，返回 JSON 对象（每行一条）。支持分页、等值过滤和列选择。",
    tags: ["data"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "CSV 文件路径" },
            delimiter: { type: "string", description: "分隔符，默认 ," },
            offset: { type: "number", description: "起始行（1-based，不含标题行），默认 1" },
            limit: { type: "number", description: "最多返回行数" },
            filter: { type: "object", description: "字段等值过滤，如 {\"status\": \"active\"}" },
            fields: { type: "array", items: { type: "string" }, description: "只返回指定列名" },
        },
        required: ["path"],
    },
    execute: async (args: {
        path: string;
        delimiter?: string;
        offset?: number;
        limit?: number;
        filter?: Record<string, string>;
        fields?: string[];
    }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.path);
        if (!fs.existsSync(resolved)) return err(`文件不存在：${resolved}`);

        const delimiter = args.delimiter ?? ",";
        let records = parseCSVToObjects(fs.readFileSync(resolved, "utf-8"), delimiter);

        if (args.filter) {
            records = records.filter(r =>
                Object.entries(args.filter!).every(([k, v]) => r[k] === String(v))
            );
        }

        const start = (args.offset ?? 1) - 1;
        const sliced = args.limit ? records.slice(start, start + args.limit) : records.slice(start);

        const projected = args.fields
            ? sliced.map(r => Object.fromEntries(args.fields!.map(f => [f, r[f]])))
            : sliced;

        const total = records.length;
        const rangeNote = args.limit || args.offset
            ? `[行 ${start + 1}-${start + projected.length} / 共 ${total} 行]`
            : `[共 ${total} 行]`;

        return ok(projected.map(r => JSON.stringify(r)).join("\n") + "\n" + rangeNote);
    },
};

// ─── write_csv ────────────────────────────────────────────────────────────────

export const writeCsvTool: ExecutableTool = {
    name: "write_csv",
    description: "将 JSON 对象数组写入 CSV 文件，自动生成标题行。目录不存在时自动创建。",
    tags: ["data"],
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "CSV 文件路径" },
            records: { type: "array", description: "对象数组，每个对象对应一行" },
            delimiter: { type: "string", description: "分隔符，默认 ," },
        },
        required: ["path", "records"],
    },
    execute: async (args: {
        path: string;
        records: Record<string, any>[];
        delimiter?: string;
    }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.path);

        if (!Array.isArray(args.records) || args.records.length === 0) {
            return err("records 必须是非空数组");
        }

        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        const content = objectsToCSV(args.records, args.delimiter ?? ",");
        fs.writeFileSync(resolved, content, "utf-8");

        return ok(`✅ 已写入：${resolved}（${args.records.length} 行）`);
    },
};

// ─── time parsing for run_jq ──────────────────────────────────────────────────

/**
 * 解析相对时间（"7d", "24h", "30m"）或绝对时间字符串，返回 epoch 秒
 */
function parseTimeToEpochS(arg: string): number {
    const relMatch = arg.match(/^(\d+)(d|h|m)$/);
    if (relMatch) {
        const n = parseInt(relMatch[1], 10);
        const msMap: Record<string, number> = { d: 86400000, h: 3600000, m: 60000 };
        return Math.floor((Date.now() - n * msMap[relMatch[2]]) / 1000);
    }

    const ts = Date.parse(arg);
    if (!isNaN(ts)) return Math.floor(ts / 1000);

    throw new Error(`无法解析时间参数：${arg}（支持 7d / 24h / 30m / 2026-04-01）`);
}

function buildJqTimePrefix(
    timeField: string,
    timeAfter: string | undefined,
    timeBefore: string | undefined,
    timeUnit: "s" | "ms" | "iso",
): string {
    const conditions: string[] = [];

    if (timeAfter) {
        const epochS = parseTimeToEpochS(timeAfter);
        if (timeUnit === "iso") {
            conditions.push(`.${timeField} >= "${new Date(epochS * 1000).toISOString()}"`);
        } else {
            conditions.push(`.${timeField} >= ${timeUnit === "ms" ? epochS * 1000 : epochS}`);
        }
    }

    if (timeBefore) {
        const epochS = parseTimeToEpochS(timeBefore);
        if (timeUnit === "iso") {
            conditions.push(`.${timeField} <= "${new Date(epochS * 1000).toISOString()}"`);
        } else {
            conditions.push(`.${timeField} <= ${timeUnit === "ms" ? epochS * 1000 : epochS}`);
        }
    }

    return conditions.length > 0 ? `select(${conditions.join(" and ")}) | ` : "";
}

// ─── run_jq ───────────────────────────────────────────────────────────────────

export const runJqTool: ExecutableTool = {
    name: "run_jq",
    description: "用 jq 处理 JSON/JSONL 文件。支持人性化时间过滤（7d/24h/2026-04-01），可将结果写入文件。",
    tags: ["data"],
    inputSchema: {
        type: "object",
        properties: {
            input_path: { type: "string", description: "输入文件路径（JSON 或 JSONL）" },
            filter: { type: "string", description: "jq 过滤表达式，默认 ." },
            output_path: { type: "string", description: "输出文件路径（可选，不填则返回结果）" },
            raw_output: { type: "boolean", description: "输出原始字符串（-r），默认 false" },
            compact: { type: "boolean", description: "紧凑单行输出（-c），默认 false" },
            time_field: { type: "string", description: "用于时间过滤的字段名" },
            time_after: { type: "string", description: "时间下限：7d / 24h / 30m / 2026-04-01 / 2026-04-01T08:00:00" },
            time_before: { type: "string", description: "时间上限，格式同 time_after" },
            time_unit: {
                type: "string",
                enum: ["s", "ms", "iso"],
                description: "时间字段单位：s=秒（默认）、ms=毫秒、iso=ISO 字符串",
            },
        },
        required: ["input_path"],
    },
    execute: async (args: {
        input_path: string;
        filter?: string;
        output_path?: string;
        raw_output?: boolean;
        compact?: boolean;
        time_field?: string;
        time_after?: string;
        time_before?: string;
        time_unit?: "s" | "ms" | "iso";
    }): Promise<ToolExecutionResult> => {
        const resolved = resolvePath(args.input_path);
        if (!fs.existsSync(resolved)) return err(`文件不存在：${resolved}`);

        let timePrefix = "";
        if (args.time_field) {
            try {
                timePrefix = buildJqTimePrefix(
                    args.time_field,
                    args.time_after,
                    args.time_before,
                    args.time_unit ?? "s",
                );
            } catch (e: any) {
                return err(e.message);
            }
        }

        const userFilter = args.filter ?? ".";
        const fullFilter = timePrefix ? `${timePrefix}${userFilter}` : userFilter;

        const jqArgs: string[] = [];
        if (args.raw_output) jqArgs.push("-r");
        if (args.compact) jqArgs.push("-c");
        jqArgs.push(fullFilter, resolved);

        let output: string;
        try {
            output = execFileSync("jq", jqArgs, {
                cwd: getWorkspaceRoot(),
                encoding: "utf-8",
                maxBuffer: 10 * 1024 * 1024,
            });
        } catch (e: any) {
            return err(`jq 执行失败：${e.stderr || e.message}`);
        }

        if (args.output_path) {
            const outResolved = resolvePath(args.output_path);
            fs.mkdirSync(path.dirname(outResolved), { recursive: true });
            fs.writeFileSync(outResolved, output, "utf-8");
            const lineCount = output.trim() ? output.trim().split("\n").length : 0;
            return ok(`✅ 已写入 ${lineCount} 条：${outResolved}`);
        }

        const lines = output.trim().split("\n");
        const preview = lines.slice(0, 50).join("\n");
        const truncNote = lines.length > 50 ? `\n...(共 ${lines.length} 条，已截断)` : "";
        return ok(preview + truncNote);
    },
};

export const DATA_OPS_TOOLS: ExecutableTool[] = [
    readJsonTool,
    writeJsonTool,
    editJsonTool,
    readCsvTool,
    writeCsvTool,
    runJqTool,
];
