import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    readTextFileTool,
    readMediaFileTool,
    writeFileTool,
    editFileTool,
    createDirectoryTool,
    listDirectoryTool,
    directoryTreeTool,
    moveFileTool,
    searchFilesTool,
    getFileInfoTool,
} from "../../src/tools/file-ops.js";
import { toolResultToText } from "../../src/tools/tool-interface.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let tmpDir: string;
let outsideDir: string;
let stateDir: TmpStateDir;

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-file-ops-test-");
    tmpDir = stateDir.dir;
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-file-ops-outside-test-"));
    process.env.TUI_CWD = tmpDir;
});

afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    delete process.env.TUI_CWD;
    stateDir.cleanup();
});

function resultText(result: any): string {
    return toolResultToText(result);
}

function isError(result: any): boolean {
    return result.isError === true;
}

function writeTemp(relPath: string, content: string | Buffer): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

describe("filesystem tools", () => {
    test("read supports full/head/tail reads", async () => {
        writeTemp("notes.txt", "alpha\nbeta\ngamma\n");

        const fullResult = await readTextFileTool.execute({ path: "notes.txt" });
        const headResult = await readTextFileTool.execute({ path: "notes.txt", head: 2 });
        const tailResult = await readTextFileTool.execute({ path: "notes.txt", tail: 1 });
        const invalidResult = await readTextFileTool.execute({ path: "notes.txt", head: 1, tail: 1 });
        const outsideFile = path.join(outsideDir, "outside.txt");
        fs.writeFileSync(outsideFile, "outside");
        const outsideResult = await readTextFileTool.execute({ path: outsideFile });

        expect(isError(fullResult)).toBe(false);
        expect(resultText(fullResult)).toBe("alpha\nbeta\ngamma\n");
        expect(resultText(headResult)).toBe("alpha\nbeta");
        expect(resultText(tailResult)).toBe("gamma");
        expect(isError(invalidResult)).toBe(true);
        expect(resultText(invalidResult)).toContain("Cannot specify both head and tail");
        expect(isError(outsideResult)).toBe(false);
        expect(resultText(outsideResult)).toBe("outside");
    });

    test("cat supports offset/limit paging", async () => {
        writeTemp("notes.txt", "l1\nl2\nl3\nl4\nl5\n");

        const page = await readTextFileTool.execute({ path: "notes.txt", offset: 2, limit: 2 });
        const fromOffset = await readTextFileTool.execute({ path: "notes.txt", offset: 4 });
        const beyond = await readTextFileTool.execute({ path: "notes.txt", offset: 99 });
        const conflict = await readTextFileTool.execute({ path: "notes.txt", offset: 1, head: 2 });

        expect(isError(page)).toBe(false);
        expect(resultText(page)).toBe("l2\nl3");
        expect(resultText(fromOffset)).toBe("l4\nl5");
        expect(resultText(beyond)).toBe("");
        expect(isError(conflict)).toBe(true);
        expect(resultText(conflict)).toContain("Cannot specify offset/limit together with head/tail");
    });

    test("允许通过当前目录外的符号链接访问文件", async () => {
        fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
        fs.symlinkSync(outsideDir, path.join(tmpDir, "outside-link"));

        const readResult = await readTextFileTool.execute({ path: "outside-link/secret.txt" });
        const treeResult = await directoryTreeTool.execute({ path: "." });
        const listResult = await listDirectoryTool.execute({ path: "." });

        expect(isError(readResult)).toBe(false);
        expect(resultText(readResult)).toBe("secret");
        expect(resultText(treeResult)).toBe(".\n└── outside-link@");
        expect(resultText(listResult)).toContain("[SYMLINK] outside-link");
    });

    test("read_media_file returns binary block and readable text fallback", async () => {
        writeTemp("pixel.png", Buffer.from("not-a-real-png"));

        const result = await readMediaFileTool.execute({ path: "pixel.png" });

        expect(isError(result)).toBe(false);
        expect(result.content[0].type).toBe("image");
        expect(result.content[0].mimeType).toBe("image/png");
        expect(result.content[0].path).toBe(path.join(tmpDir, "pixel.png"));
        expect(resultText(result)).toContain("base64_chars=");
    });

    test("cat supports multiple files via paths", async () => {
        writeTemp("a.txt", "A\n");
        writeTemp("b.txt", "B\n");

        const result = await readTextFileTool.execute({ paths: ["a.txt", "missing.txt", "b.txt"] });

        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain("a.txt:\nA\n");
        expect(resultText(result)).toContain("missing.txt: Error - No such file or directory: missing.txt");
        expect(resultText(result)).toContain("b.txt:\nB\n");
    });

    test("write_file creates and overwrites files", async () => {
        const created = await writeFileTool.execute({ path: "nested/out.txt", content: "first" });
        const updated = await writeFileTool.execute({ path: "nested/out.txt", content: "second" });

        expect(isError(created)).toBe(false);
        expect(isError(updated)).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, "nested/out.txt"), "utf-8")).toBe("second");
    });

    test("edit_file supports dryRun and apply", async () => {
        writeTemp("sample.txt", "alpha\nbeta\n");

        const preview = await editFileTool.execute({
            path: "sample.txt",
            edits: [{ oldText: "beta", newText: "gamma" }],
            dryRun: true,
        });

        expect(isError(preview)).toBe(false);
        expect(resultText(preview)).toContain("-beta");
        expect(resultText(preview)).toContain("+gamma");
        expect(resultText(preview)).toContain("Edited file successfully: sample.txt");
        expect(resultText(preview)).toContain("Replacements: 1");
        expect(fs.readFileSync(path.join(tmpDir, "sample.txt"), "utf-8")).toBe("alpha\nbeta\n");

        const applied = await editFileTool.execute({
            path: "sample.txt",
            edits: [{ oldText: "beta", newText: "gamma" }],
        });

        expect(isError(applied)).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, "sample.txt"), "utf-8")).toBe("alpha\ngamma\n");
    });

    test("create_directory creates nested directories", async () => {
        const result = await createDirectoryTool.execute({ path: "logs/2026/04" });

        expect(isError(result)).toBe(false);
        expect(fs.statSync(path.join(tmpDir, "logs/2026/04")).isDirectory()).toBe(true);
    });

    test("list_directory lists files and directories", async () => {
        fs.mkdirSync(path.join(tmpDir, "pkg"));
        writeTemp("pkg/app.py", "print('ok')\n");
        writeTemp("README.md", "# demo\n");

        const result = await listDirectoryTool.execute({ path: "." });

        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain("[DIR] pkg");
        expect(resultText(result)).toContain("[FILE] README.md");
    });

    test("list_directory allows the TUI process cwd", async () => {
        const tuiCwd = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-cwd-test-"));
        const previousTuiCwd = process.env.TUI_CWD;
        process.env.TUI_CWD = tuiCwd;
        fs.writeFileSync(path.join(tuiCwd, "README.md"), "# tui\n");

        try {
            const result = await listDirectoryTool.execute({ path: "." });

            expect(isError(result)).toBe(false);
            expect(resultText(result)).toContain("[FILE] README.md");
        } finally {
            fs.rmSync(tuiCwd, { recursive: true, force: true });
            if (previousTuiCwd === undefined) {
                delete process.env.TUI_CWD;
            } else {
                process.env.TUI_CWD = previousTuiCwd;
            }
        }
    });

    test("list_directory sorts and summarizes", async () => {
        fs.mkdirSync(path.join(tmpDir, "subdir"));
        writeTemp("small.txt", "a");
        writeTemp("large.txt", "abcd");

        const result = await listDirectoryTool.execute({ path: ".", sortBy: "size" });
        const lines = resultText(result).split("\n");
        const fileLines = lines.filter((line) => line.startsWith("[FILE]"));

        expect(isError(result)).toBe(false);
        expect(fileLines[0]).toContain("large.txt");
        expect(lines.some((line) => line.startsWith("[DIR] subdir"))).toBe(true);
        expect(resultText(result)).toContain("Total: 2 files, 1 directories");
        expect(resultText(result)).toContain("Combined size: 5 B");
    });

    test("directory_tree respects exclude patterns", async () => {
        fs.mkdirSync(path.join(tmpDir, "src"));
        writeTemp("src/keep.py", "print(1)\n");
        writeTemp("src/skip.log", "skip\n");
        fs.mkdirSync(path.join(tmpDir, ".git"));
        fs.mkdirSync(path.join(tmpDir, "node_modules"));

        const result = await directoryTreeTool.execute({ path: ".", excludePatterns: ["*.log"] });

        expect(isError(result)).toBe(false);
        expect(resultText(result)).toBe(".\n└── src/\n    └── keep.py");
    });

    test("move_file moves and renames files", async () => {
        fs.mkdirSync(path.join(tmpDir, "from"));
        fs.mkdirSync(path.join(tmpDir, "to"));
        writeTemp("from/draft.txt", "payload");

        const result = await moveFileTool.execute({ source: "from/draft.txt", destination: "to/final.txt" });

        expect(isError(result)).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "from/draft.txt"))).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, "to/final.txt"), "utf-8")).toBe("payload");
    });

    test("search_files finds nested matches and supports no-match responses", async () => {
        fs.mkdirSync(path.join(tmpDir, "pkg"));
        writeTemp("pkg/app.py", "print('ok')\n");
        writeTemp("README.md", "# demo\n");
        writeTemp("pkg/debug.log", "skip\n");

        const nested = await searchFilesTool.execute({ path: ".", pattern: "**/*.py" });
        const topLevel = await searchFilesTool.execute({ path: ".", pattern: "*.md" });
        const excluded = await searchFilesTool.execute({ path: ".", pattern: "**/*", excludePatterns: ["*.log"] });
        const none = await searchFilesTool.execute({ path: ".", pattern: "*.json" });

        expect(isError(nested)).toBe(false);
        expect(resultText(nested)).toBe("pkg/app.py");
        expect(resultText(topLevel)).toBe("README.md");
        expect(resultText(excluded)).not.toContain("debug.log");
        expect(resultText(none)).toBe("No matches found");
    });

    test("get_file_info returns metadata", async () => {
        writeTemp("info.txt", "abc");

        const result = await getFileInfoTool.execute({ path: "info.txt" });

        expect(isError(result)).toBe(false);
        expect(resultText(result)).toContain("size: 3");
        expect(resultText(result)).toContain("isDirectory: false");
        expect(resultText(result)).toContain("isFile: true");
        expect(resultText(result)).toContain("permissions:");
        expect(resultText(result)).toContain("modified:");
    });

});
