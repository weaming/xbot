import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
    readJsonTool,
    writeJsonTool,
    editJsonTool,
    readCsvTool,
    writeCsvTool,
    runJqTool,
} from "../../src/tools/data-ops.js";
import { useTmpWorkspace, type TmpWorkspace } from "./test-env.js";

let tmpDir: string;
let savedTuiCwd: string | undefined;
let workspace: TmpWorkspace;

beforeEach(() => {
    workspace = useTmpWorkspace("xbot-data-ops-test-");
    tmpDir = workspace.dir;
    // getToolCwd 优先 TUI_CWD；宿主环境注入时会导致相对路径解析到外部目录，须清除。
    savedTuiCwd = process.env.TUI_CWD;
    delete process.env.TUI_CWD;
});

afterEach(() => {
    if (savedTuiCwd === undefined) {
        delete process.env.TUI_CWD;
    } else {
        process.env.TUI_CWD = savedTuiCwd;
    }
    workspace.cleanup();
});

function resultText(result: any): string {
    return result.content[0].text;
}

function isError(result: any): boolean {
    return result.isError === true;
}

function writeTemp(relPath: string, content: string): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
}

function hasBinary(name: string): boolean {
    try {
        execSync(`which ${name}`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

// ─── read_json ────────────────────────────────────────────────────────────────

describe("read_json", () => {
    test("读取完整 JSON", async () => {
        writeTemp("config.json", JSON.stringify({ a: 1, b: { c: 2 } }));
        const result = await readJsonTool.execute({ path: "config.json" });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain('"a": 1');
        expect(resultText(result)).toContain('"c": 2');
    });

    test("按 key_path 提取嵌套字段", async () => {
        writeTemp("config.json", JSON.stringify({ server: { port: 8080, host: "localhost" } }));
        const result = await readJsonTool.execute({ path: "config.json", key_path: "server.port" });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toBe("8080");
    });

    test("按 key_path 提取数组元素", async () => {
        writeTemp("data.json", JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }));
        const result = await readJsonTool.execute({ path: "data.json", key_path: "items.1.id" });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toBe("2");
    });

    test("key_path 不存在返回错误", async () => {
        writeTemp("config.json", JSON.stringify({ a: 1 }));
        const result = await readJsonTool.execute({ path: "config.json", key_path: "b.c" });
        expect(isError(result)).toBe(true);
        expect(resultText(result)).toContain("路径不存在");
    });

    test("无效 JSON 返回错误", async () => {
        writeTemp("bad.json", "{ not json }");
        const result = await readJsonTool.execute({ path: "bad.json" });
        expect(isError(result)).toBe(true);
        expect(resultText(result)).toContain("JSON 解析失败");
    });

    test("文件不存在返回错误", async () => {
        const result = await readJsonTool.execute({ path: "none.json" });
        expect(isError(result)).toBe(true);
    });

    test("允许读取允许目录外的 JSON", async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-data-outside-test-"));
        const outsideFile = path.join(outsideDir, "outside.json");
        fs.writeFileSync(outsideFile, JSON.stringify({ accessible: true }));

        try {
            const result = await readJsonTool.execute({ path: outsideFile });
            expect(isError(result)).toBe(false);
            expect(JSON.parse(resultText(result))).toEqual({ accessible: true });
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    test("允许通过外部符号链接读取", async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-data-ops-outside-test-"));
        fs.writeFileSync(path.join(outsideDir, "secret.json"), '{"secret":true}');
        fs.symlinkSync(outsideDir, path.join(tmpDir, "outside-link"));

        try {
            const result = await readJsonTool.execute({ path: "outside-link/secret.json" });
            expect(isError(result)).toBe(false);
            expect(JSON.parse(resultText(result))).toEqual({ secret: true });
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });
});

// ─── write_json ───────────────────────────────────────────────────────────────

describe("write_json", () => {
    test("写入对象", async () => {
        const result = await writeJsonTool.execute({ path: "out.json", value: { x: 1 } });
        expect(isError(result)).toBe(false);
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "out.json"), "utf-8"));
        expect(saved.x).toBe(1);
    });

    test("写入数组", async () => {
        await writeJsonTool.execute({ path: "arr.json", value: [1, 2, 3] });
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "arr.json"), "utf-8"));
        expect(saved).toEqual([1, 2, 3]);
    });

    test("自定义缩进", async () => {
        await writeJsonTool.execute({ path: "indented.json", value: { a: 1 }, indent: 4 });
        const content = fs.readFileSync(path.join(tmpDir, "indented.json"), "utf-8");
        expect(content).toContain("    ");
    });

    test("自动创建目录", async () => {
        await writeJsonTool.execute({ path: "nested/dir/file.json", value: {} });
        expect(fs.existsSync(path.join(tmpDir, "nested/dir/file.json"))).toBe(true);
    });

    // 文件工具不限制目录访问：`..` 只做路径解析，不当作越权。
    test("相对路径可穿越到上级目录", async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-data-write-outside-"));
        try {
            process.env.TUI_CWD = path.join(outsideDir, "inner");
            const result = await writeJsonTool.execute({ path: "../escaped.json", value: { ok: true } });

            expect(isError(result)).toBe(false);
            const escaped = path.join(outsideDir, "escaped.json");
            expect(JSON.parse(fs.readFileSync(escaped, "utf-8"))).toEqual({ ok: true });
        } finally {
            process.env.TUI_CWD = tmpDir;
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });
});

// ─── edit_json ────────────────────────────────────────────────────────────────

describe("edit_json", () => {
    test("set 更新顶层字段", async () => {
        writeTemp("config.json", JSON.stringify({ port: 3000, debug: false }));
        const result = await editJsonTool.execute({ path: "config.json", key_path: "port", value: 8080 });
        expect(isError(result)).toBe(false);
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
        expect(saved.port).toBe(8080);
        expect(saved.debug).toBe(false);
    });

    test("set 更新嵌套字段", async () => {
        writeTemp("config.json", JSON.stringify({ server: { host: "localhost", port: 3000 } }));
        await editJsonTool.execute({ path: "config.json", key_path: "server.port", value: 9000 });
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
        expect(saved.server.port).toBe(9000);
        expect(saved.server.host).toBe("localhost");
    });

    test("set 创建不存在的嵌套路径", async () => {
        writeTemp("config.json", JSON.stringify({}));
        await editJsonTool.execute({ path: "config.json", key_path: "a.b.c", value: 42 });
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
        expect(saved.a.b.c).toBe(42);
    });

    test("delete 删除字段", async () => {
        writeTemp("config.json", JSON.stringify({ keep: 1, remove: 2 }));
        const result = await editJsonTool.execute({
            path: "config.json",
            key_path: "remove",
            operation: "delete",
        });
        expect(isError(result)).toBe(false);
        const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
        expect("remove" in saved).toBe(false);
        expect(saved.keep).toBe(1);
    });

    test("delete 路径不存在返回错误", async () => {
        writeTemp("config.json", JSON.stringify({ a: 1 }));
        const result = await editJsonTool.execute({
            path: "config.json",
            key_path: "nonexistent",
            operation: "delete",
        });
        expect(isError(result)).toBe(true);
    });

    test("set 不提供 value 返回错误", async () => {
        writeTemp("config.json", JSON.stringify({ a: 1 }));
        const result = await editJsonTool.execute({ path: "config.json", key_path: "a" });
        expect(isError(result)).toBe(true);
        expect(resultText(result)).toContain("value");
    });
});

// ─── read_csv ─────────────────────────────────────────────────────────────────

describe("read_csv", () => {
    beforeEach(() => {
        writeTemp("data.csv", "id,name,status\n1,Alice,active\n2,Bob,inactive\n3,Carol,active");
    });

    test("读取全部行", async () => {
        const result = await readCsvTool.execute({ path: "data.csv" });
        expect(isError(result)).toBe(false);
        const text = resultText(result);
        expect(text).toContain('"name":"Alice"');
        expect(text).toContain('"name":"Bob"');
        expect(text).toContain("共 3 行");
    });

    test("等值过滤", async () => {
        const result = await readCsvTool.execute({ path: "data.csv", filter: { status: "active" } });
        const text = resultText(result);
        expect(text).toContain("Alice");
        expect(text).toContain("Carol");
        expect(text).not.toContain("Bob");
    });

    test("列选择", async () => {
        const result = await readCsvTool.execute({ path: "data.csv", fields: ["id", "name"] });
        const text = resultText(result);
        expect(text).toContain('"id"');
        expect(text).toContain('"name"');
        expect(text).not.toContain('"status"');
    });

    test("分页 offset + limit", async () => {
        const result = await readCsvTool.execute({ path: "data.csv", offset: 2, limit: 1 });
        const text = resultText(result);
        expect(text).toContain("Bob");
        expect(text).not.toContain("Alice");
        expect(text).toContain("行 2-2");
    });

    test("带引号的字段", async () => {
        writeTemp("quoted.csv", 'id,note\n1,"hello, world"\n2,"she said ""hi"""');
        const result = await readCsvTool.execute({ path: "quoted.csv" });
        const text = resultText(result);
        expect(text).toContain("hello, world");
        // JSONL 输出中双引号被转义为 \"
        expect(text).toContain('she said \\"hi\\"');
    });

    test("读取带换行的引号字段", async () => {
        writeTemp("notes.csv", "id,note\n1,\"第一行\n第二行\"\n");

        const result = await readCsvTool.execute({ path: "notes.csv" });

        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain('"note":"第一行\\n第二行"');
    });

    test("TSV 支持自定义分隔符", async () => {
        writeTemp("data.tsv", "id\tname\n1\tAlice");
        const result = await readCsvTool.execute({ path: "data.tsv", delimiter: "\t" });
        const text = resultText(result);
        expect(text).toContain("Alice");
    });

    test("文件不存在返回错误", async () => {
        const result = await readCsvTool.execute({ path: "none.csv" });
        expect(isError(result)).toBe(true);
    });
});

// ─── write_csv ────────────────────────────────────────────────────────────────

describe("write_csv", () => {
    test("写入并读回", async () => {
        const records = [
            { id: "1", name: "Alice", amount: "100" },
            { id: "2", name: "Bob", amount: "200" },
        ];
        const result = await writeCsvTool.execute({ path: "out.csv", records });
        expect(isError(result)).toBe(false);
        const content = fs.readFileSync(path.join(tmpDir, "out.csv"), "utf-8");
        expect(content).toContain("id,name,amount");
        expect(content).toContain("Alice");
        expect(content).toContain("200");
    });

    test("字段含逗号时自动加引号", async () => {
        const records = [{ note: "hello, world" }];
        await writeCsvTool.execute({ path: "out.csv", records });
        const content = fs.readFileSync(path.join(tmpDir, "out.csv"), "utf-8");
        expect(content).toContain('"hello, world"');
    });

    test("空数组返回错误", async () => {
        const result = await writeCsvTool.execute({ path: "out.csv", records: [] });
        expect(isError(result)).toBe(true);
    });
});

// ─── run_jq ───────────────────────────────────────────────────────────────────

describe("run_jq", () => {
    const hasJq = hasBinary("jq");

    test("基本 filter", async () => {
        if (!hasJq) return;
        writeTemp("data.jsonl", '{"a":1}\n{"a":2}\n{"a":3}');
        const result = await runJqTool.execute({ input_path: "data.jsonl", filter: "select(.a > 1)" });
        expect(isError(result)).toBe(false);
        const text = resultText(result);
        expect(text).toContain('"a": 2');
        expect(text).not.toContain('"a": 1');
    });

    test("字段提取", async () => {
        if (!hasJq) return;
        writeTemp("data.jsonl", '{"id":1,"name":"Alice","extra":"x"}\n{"id":2,"name":"Bob","extra":"y"}');
        const result = await runJqTool.execute({ input_path: "data.jsonl", filter: "{id, name}" });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).not.toContain("extra");
    });

    test("compact 输出", async () => {
        if (!hasJq) return;
        writeTemp("data.json", '{"a":1}');
        const result = await runJqTool.execute({ input_path: "data.json", compact: true });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toBe('{"a":1}');
    });

    test("raw_output 输出字符串", async () => {
        if (!hasJq) return;
        writeTemp("data.json", '{"name":"Alice"}');
        const result = await runJqTool.execute({ input_path: "data.json", filter: ".name", raw_output: true });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toBe("Alice");
    });

    test("time_after 过滤（epoch 秒）", async () => {
        if (!hasJq) return;
        const now = Math.floor(Date.now() / 1000);
        const old = now - 10000;
        const recent = now - 60;
        writeTemp("events.jsonl", `{"ts":${old},"v":1}\n{"ts":${recent},"v":2}`);

        const result = await runJqTool.execute({
            input_path: "events.jsonl",
            time_field: "ts",
            time_after: "1h",
            time_unit: "s",
        });
        expect(isError(result)).toBe(false);
        const text = resultText(result);
        expect(text).toContain('"v": 2');
        expect(text).not.toContain('"v": 1');
    });

    test("time_after 过滤（毫秒）", async () => {
        if (!hasJq) return;
        const now = Date.now();
        const old = now - 10000000;
        const recent = now - 60000;
        writeTemp("events.jsonl", `{"ts":${old},"v":1}\n{"ts":${recent},"v":2}`);

        const result = await runJqTool.execute({
            input_path: "events.jsonl",
            time_field: "ts",
            time_after: "1h",
            time_unit: "ms",
        });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain('"v": 2');
        expect(resultText(result)).not.toContain('"v": 1');
    });

    test("写入 output_path", async () => {
        if (!hasJq) return;
        writeTemp("data.jsonl", '{"a":1}\n{"a":2}');
        const result = await runJqTool.execute({
            input_path: "data.jsonl",
            filter: "select(.a > 1)",
            output_path: "out.jsonl",
        });
        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain("已写入");
        expect(fs.existsSync(path.join(tmpDir, "out.jsonl"))).toBe(true);
    });

    test("无效 filter 返回错误", async () => {
        if (!hasJq) return;
        writeTemp("data.json", "{}");
        const result = await runJqTool.execute({ input_path: "data.json", filter: "invalid(((" });
        expect(isError(result)).toBe(true);
    });

    test("无效时间参数返回错误", async () => {
        writeTemp("data.jsonl", '{"ts":1}');
        const result = await runJqTool.execute({
            input_path: "data.jsonl",
            time_field: "ts",
            time_after: "bad_time",
        });
        expect(isError(result)).toBe(true);
        expect(resultText(result)).toContain("无法解析时间");
    });

    test("路径穿越被拒绝", async () => {
        const result = await runJqTool.execute({ input_path: "../../etc/passwd" });
        expect(isError(result)).toBe(true);
    });
});
