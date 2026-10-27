import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { readMediaFileTool } from "../../src/tools/file-ops.js";
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
});
