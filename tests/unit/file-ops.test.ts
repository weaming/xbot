import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
    readMediaFileTool,
    writeFileTool,
    editFileTool,
} from "../../src/tools/file-ops.js";
import { toolResultToText } from "../../src/tools/tool-interface.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let tmpDir: string;
let stateDir: TmpStateDir;

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-file-ops-test-");
    tmpDir = stateDir.dir;
    process.env.TUI_CWD = tmpDir;
});

afterEach(() => {
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
    test("read_media_file returns binary block and readable text fallback", async () => {
        writeTemp("pixel.png", Buffer.from("not-a-real-png"));

        const result = await readMediaFileTool.execute({ path: "pixel.png" });

        expect(isError(result)).toBe(false);
        expect(result.content[0].type).toBe("image");
        expect(result.content[0].mimeType).toBe("image/png");
        expect(result.content[0].path).toBe(path.join(tmpDir, "pixel.png"));
        expect(resultText(result)).toContain("base64_chars=");
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

});
