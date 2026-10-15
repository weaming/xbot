import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { ToolUsageStore } from "../../src/tools/tool-usage-store.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-tool-usage-store-test-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tool usage store", () => {
    test("persists and reloads recorded usage with lastUsed and count", async () => {
        const lruFile = path.join(tmpDir, "state", "tool-lru.json");
        const store = new ToolUsageStore(lruFile);

        store.recordUsage("read_file");
        await (store as any).save();

        const reloaded = new ToolUsageStore(lruFile);
        reloaded.load();

        expect(fs.existsSync(lruFile)).toBe(true);
        expect(reloaded.getUsageMap().get("read_file")).toEqual({
            lastUsed: expect.any(Number),
            count: 1,
        });
    });

    test("recordUsage increments count for repeated uses", () => {
        const store = new ToolUsageStore(path.join(tmpDir, "state", "tool-lru.json"));

        store.recordUsage("read_file");
        store.recordUsage("read_file");
        store.recordUsage("read_file");

        expect(store.getUsageMap().get("read_file")).toEqual({
            lastUsed: expect.any(Number),
            count: 3,
        });
    });

    test("loads legacy numeric format with count 1", () => {
        const lruFile = path.join(tmpDir, "state", "tool-lru.json");
        fs.mkdirSync(path.dirname(lruFile), { recursive: true });
        fs.writeFileSync(lruFile, JSON.stringify({ old_tool: 1234567890 }), "utf-8");

        const store = new ToolUsageStore(lruFile);
        store.load();

        expect(store.getUsageMap().get("old_tool")).toEqual({ lastUsed: 1234567890, count: 1 });
    });
});
