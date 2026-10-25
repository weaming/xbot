/**
 * 出站台账：一条出站消息只应有一个状态，迁移必须显式且不可回退。
 *
 * 这组测试针对的是早前散落在三个容器（expectations / queue / stash）里的
 * 状态，那些缺陷无法用接口测试稳定复现，只能在这里逐条守住。
 */

import { describe, expect, test } from "bun:test";
import { OutboxLedger } from "../../src/control/outbox-ledger.js";
import type { PeerMessage, PeerResult } from "../../src/control/protocol.js";

function ledger(): OutboxLedger {
    return new OutboxLedger({ maxQueuedPerSession: 3, maxStashed: 3 });
}

function message(msgId: string, requester = "from", target = "to"): PeerMessage {
    return { id: msgId, from: requester, to: target, text: "hi", createdAt: new Date().toISOString() } as PeerMessage;
}

function result(msgId: string): PeerResult {
    return { msgId, ok: true, text: "done", stopReason: "stop" } as PeerResult;
}

function addAwaiting(outbox: OutboxLedger, msgId: string, requester = "from", target = "to") {
    return outbox.addAwaiting({ msgId, requester, target, message: message(msgId, requester, target) });
}

describe("状态迁移", () => {
    test("登记后处于 awaiting", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        expect(outbox.awaitingCount("from")).toBe(1);
        expect(outbox.queuedCount("from")).toBe(0);
    });

    test("重复登记同一条消息是幂等的", () => {
        const outbox = ledger();
        const first = addAwaiting(outbox, "m1");
        const second = addAwaiting(outbox, "m1");
        expect(second).toBe(first);
        expect(outbox.awaitingCount("from")).toBe(1);
    });

    test("结果到达后从 awaiting 变成 queued", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        outbox.settle("m1", "结果文本");

        expect(outbox.awaitingCount("from")).toBe(0);
        expect(outbox.queuedCount("from")).toBe(1);
        expect(outbox.takeQueued("from")).toEqual(["结果文本"]);
        // 取走即清
        expect(outbox.queuedCount("from")).toBe(0);
    });

    test("同一结果重复回传不会重复入队", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        expect(outbox.settle("m1", "第一次")).not.toBeNull();
        expect(outbox.settle("m1", "第二次")).toBeNull();
        expect(outbox.takeQueued("from")).toEqual(["第一次"]);
    });

    test("从未登记的消息回传结果为 null，不产生条目", () => {
        const outbox = ledger();
        expect(outbox.settle("unknown", "x")).toBeNull();
        expect(outbox.size).toBe(0);
    });

    test("已有前台等待者时直接兑现，不入队", () => {
        const outbox = ledger();
        const entry = addAwaiting(outbox, "m1");
        let outcome: unknown;
        entry.waiter = (value) => { outcome = value; };

        const settled = outbox.settle("m1", "文本");
        expect(settled?.waiter).toBeDefined();
        expect(outbox.queuedCount("from")).toBe(0);
        expect(outbox.size).toBe(0);
        expect(outcome).toBeUndefined();
    });
});

describe("过期与迟到结果", () => {
    test("超时/丢失后保留有限期 expired tombstone，且只能过期一次", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");

        expect(outbox.expire("m1")).not.toBeNull();
        expect(outbox.expire("m1")).toBeNull();
        expect(outbox.awaitingCount("from")).toBe(0);
        expect(outbox.size).toBe(1);
    });

    test("迟到结果从 expired 进入 queued 并显式标记 late", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        outbox.expire("m1");

        const settled = outbox.settle("m1", late => late ? "迟到结果" : "正常结果");
        expect(settled?.late).toBe(true);
        expect(outbox.queuedCount("from")).toBe(1);
        expect(outbox.takeQueued("from")).toEqual(["迟到结果"]);
    });

    test("迟到 tombstone 有数量上限", () => {
        const outbox = new OutboxLedger({ maxQueuedPerSession: 3, maxStashed: 3, maxExpired: 1 });
        addAwaiting(outbox, "m1");
        addAwaiting(outbox, "m2");
        outbox.expire("m1");
        outbox.expire("m2");

        expect(outbox.settle("m1", "too old")).toBeNull();
        expect(outbox.settle("m2", late => late ? "recoverable" : "normal")?.late).toBe(true);
        expect(outbox.takeQueued("from")).toEqual(["recoverable"]);
    });

    test("TTL 到期后迟到结果被拒绝并清理 tombstone", () => {
        const outbox = new OutboxLedger({ maxQueuedPerSession: 3, maxStashed: 3, lateResultTtlMs: 0 });
        addAwaiting(outbox, "m1");
        outbox.expire("m1");

        expect(outbox.settle("m1", "too late")).toBeNull();
        expect(outbox.size).toBe(0);
    });

    test("已入队的消息不能再被放弃（状态不可回退）", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        outbox.settle("m1", "文本");

        expect(outbox.expire("m1")).toBeNull();
        expect(outbox.queuedCount("from")).toBe(1);
    });

    test("放弃时把等待者取出以便兑现", () => {
        const outbox = ledger();
        const entry = addAwaiting(outbox, "m1");
        entry.waiter = () => {};

        const expired = outbox.expire("m1");
        expect(expired?.waiter).not.toBeNull();
        expect(entry.waiter).toBeNull();
    });
});

describe("会话隔离与限幅", () => {
    test("计数按会话隔离", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1", "a");
        addAwaiting(outbox, "m2", "b");

        expect(outbox.awaitingCount("a")).toBe(1);
        expect(outbox.awaitingCount("b")).toBe(1);
        expect(outbox.awaitingCount("c")).toBe(0);
    });

    test("取走结果不影响其他会话", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1", "a");
        addAwaiting(outbox, "m2", "b");
        outbox.settle("m1", "给 a");
        outbox.settle("m2", "给 b");

        expect(outbox.takeQueued("a")).toEqual(["给 a"]);
        expect(outbox.queuedCount("b")).toBe(1);
    });

    test("待附加队列按会话限幅，超出丢弃最早的一条", () => {
        const outbox = new OutboxLedger({ maxQueuedPerSession: 2, maxStashed: 3 });
        for (const id of ["m1", "m2", "m3"]) {
            addAwaiting(outbox, id);
            outbox.settle(id, id);
        }

        // 上限 2：最早的 m1 被挤掉
        expect(outbox.takeQueued("from")).toEqual(["m2", "m3"]);
    });
});

describe("暂存", () => {
    test("暂存后可按 msgId 取回", () => {
        const outbox = ledger();
        outbox.stashResult(result("m1"));

        expect(outbox.takeStashed(["m1"])).toEqual({ done: [result("m1")], pending: [] });
        // 取走即清
        expect(outbox.takeStashed(["m1"])).toEqual({ done: [], pending: ["m1"] });
    });

    test("暂存有上限，超出淘汰最老的一条", () => {
        const outbox = new OutboxLedger({ maxQueuedPerSession: 2, maxStashed: 2 });
        for (const id of ["m1", "m2", "m3"]) outbox.stashResult(result(id));

        expect(outbox.takeStashed(["m1"])).toEqual({ done: [], pending: ["m1"] });
        expect(outbox.takeStashed(["m2", "m3"])).toEqual({ done: [result("m2"), result("m3")], pending: [] });
    });
});

describe("清理", () => {
    test("clear 后不残留任何条目与暂存", () => {
        const outbox = ledger();
        addAwaiting(outbox, "m1");
        outbox.stashResult(result("m2"));

        outbox.clear();

        expect(outbox.size).toBe(0);
        expect(outbox.awaitingCount("from")).toBe(0);
        expect(outbox.takeStashed(["m2"])).toEqual({ done: [], pending: ["m2"] });
    });
});
