/**
 * PendingQueue 的队列语义：入队、消费、越界收敛、窗口化。
 * 这些规则原本散在 app.ts 的渲染、按键、消费三条路径里，现在集中验证。
 */

import { describe, expect, test } from "bun:test";
import { PendingQueue } from "../../src/tui/pending-queue.js";

const SESSION = "sess-a";
const identity = (message: string | { text: string }) => typeof message === "string" ? message : message.text;

describe("PendingQueue 基本队列", () => {
    test("入队后选中最新一条", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push(SESSION, "b");

        expect(queue.messages(SESSION)).toEqual(["a", "b"]);
        expect(queue.index(SESSION)).toBe(1);
        expect(queue.count(SESSION)).toBe(2);
    });

    test("不同会话互不影响", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push("sess-b", "b");

        expect(queue.messages(SESSION)).toEqual(["a"]);
        expect(queue.messages("sess-b")).toEqual(["b"]);
    });

    test("未指定会话落在根队列，与具体会话隔离", () => {
        const queue = new PendingQueue();
        queue.push(null, "root");

        expect(queue.messages(null)).toEqual(["root"]);
        expect(queue.messages(SESSION)).toEqual([]);
    });

    test("清空后 count 归零且索引复位", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.clear(SESSION);

        expect(queue.count(SESSION)).toBe(0);
        expect(queue.index(SESSION)).toBe(0);
    });
});

describe("PendingQueue 索引收敛", () => {
    test("setIndex 自动夹到合法区间", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push(SESSION, "b");

        queue.setIndex(SESSION, 99);
        expect(queue.index(SESSION)).toBe(1);

        queue.setIndex(SESSION, -5);
        expect(queue.index(SESSION)).toBe(0);
    });

    test("空队列时 setIndex 恒为 0", () => {
        const queue = new PendingQueue();
        queue.setIndex(SESSION, 3);
        expect(queue.index(SESSION)).toBe(0);
    });

    test("删除末项后索引不越界", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push(SESSION, "b");

        expect(queue.removeAt(SESSION, 1)).toBe(true);
        expect(queue.messages(SESSION)).toEqual(["a"]);
        expect(queue.index(SESSION)).toBe(0);
    });

    test("删除越界下标返回 false 且不改内容", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");

        expect(queue.removeAt(SESSION, 5)).toBe(false);
        expect(queue.messages(SESSION)).toEqual(["a"]);
    });
});

describe("PendingQueue 消费", () => {
    test("drain 取走全部并复位索引", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push(SESSION, "b");

        expect(queue.drain(SESSION)).toEqual(["a", "b"]);
        expect(queue.count(SESSION)).toBe(0);
        expect(queue.index(SESSION)).toBe(0);
    });

    test("空队列 drain 返回空数组", () => {
        const queue = new PendingQueue();
        expect(queue.drain(SESSION)).toEqual([]);
    });

    test("drain 是原子的：取完立刻再取为空", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");

        queue.drain(SESSION);
        expect(queue.drain(SESSION)).toEqual([]);
    });

    test("adoptRoot 把根队列搬到目标会话并清空根", () => {
        const queue = new PendingQueue();
        queue.push(null, "root-1");
        queue.push(SESSION, "own");

        queue.adoptRoot(SESSION);

        expect(queue.messages(null)).toEqual([]);
        expect(queue.messages(SESSION)).toEqual(["root-1", "own"]);
        expect(queue.index(SESSION)).toBe(1);
    });

    test("adoptRoot 在根为空时不制造条目", () => {
        const queue = new PendingQueue();
        queue.adoptRoot(SESSION);
        expect(queue.count(SESSION)).toBe(0);
    });
});

describe("PendingQueue 窗口化视图", () => {
    test("条目少于上限时全部显示", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, "a");
        queue.push(SESSION, "b");

        const view = queue.window(SESSION, 5, identity);
        expect(view.map(item => item.text)).toEqual(["a", "b"]);
        expect(view.map(item => item.ordinal)).toEqual([1, 2]);
    });

    test("超出上限时围绕选中项居中", () => {
        const queue = new PendingQueue();
        for (let i = 0; i < 8; i += 1) queue.push(SESSION, `m${i}`);
        queue.setIndex(SESSION, 5);

        const view = queue.window(SESSION, 5, identity);
        expect(view).toHaveLength(5);
        expect(view[0]!.text).toBe("m3");
        expect(view.at(-1)!.text).toBe("m7");
        expect(view.find(item => item.selected)!.text).toBe("m5");
    });

    test("选中首项时窗口贴住开头", () => {
        const queue = new PendingQueue();
        for (let i = 0; i < 8; i += 1) queue.push(SESSION, `m${i}`);
        queue.setIndex(SESSION, 0);

        const view = queue.window(SESSION, 3, identity);
        expect(view.map(item => item.text)).toEqual(["m0", "m1", "m2"]);
    });

    test("选中末项时窗口贴住结尾", () => {
        const queue = new PendingQueue();
        for (let i = 0; i < 8; i += 1) queue.push(SESSION, `m${i}`);

        const view = queue.window(SESSION, 3, identity);
        expect(view.map(item => item.text)).toEqual(["m5", "m6", "m7"]);
        expect(view.at(-1)!.selected).toBe(true);
    });

    test("空队列窗口为空", () => {
        const queue = new PendingQueue();
        expect(queue.window(SESSION, 5, identity)).toEqual([]);
    });

    test("带图片的消息按 toText 投影成文本", () => {
        const queue = new PendingQueue();
        queue.push(SESSION, { text: "看图", images: [{ path: "/tmp/a.png" }] });

        expect(queue.window(SESSION, 5, identity)[0]!.text).toBe("看图");
    });
});
