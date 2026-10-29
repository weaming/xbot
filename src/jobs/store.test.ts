import { describe, expect, test } from "bun:test";
import { JobStore } from "./store.js";
import { JobConflictError, JobInvalidTransitionError } from "./types.js";

/** 可控时钟：租约过期这类用例必须能推进时间。 */
function makeStore(): { store: JobStore; advance: (ms: number) => void } {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new JobStore({ path: ":memory:", now: () => now });
    return {
        store,
        advance: (ms: number) => {
            now = new Date(now.getTime() + ms);
        },
    };
}

function createJob(
    store: JobStore,
    overrides: { workspace?: string; priority?: number; key?: string; autoStart?: boolean } = {},
) {
    return store.create({
        source: "test",
        ...(overrides.key ? { idempotencyKey: overrides.key } : {}),
        input: {
            prompt: "跑测试",
            workspace: overrides.workspace ?? "/tmp/ws",
            ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
            // 测试关注调度本身：显式授权执行（产品默认是 false，等用户点「开始」）
            autoStart: overrides.autoStart ?? true,
        },
    });
}

describe("JobStore 创建与幂等", () => {
    test("新建返回 queued 并落 job_created 事件", () => {
        const { store } = makeStore();
        const outcome = createJob(store);

        expect(outcome.created).toBe(true);
        expect(outcome.job.state).toBe("queued");
        expect(outcome.job.attempts).toBe(0);
        expect(store.eventsSince(0).map(event => event.type)).toEqual(["job_created"]);
    });

    test("同 source 同 key 幂等命中，返回既有 job 且不新建", () => {
        const { store } = makeStore();
        const first = createJob(store, { key: "k1" });
        const second = createJob(store, { key: "k1" });

        expect(second.created).toBe(false);
        expect(second.job.id).toBe(first.job.id);
        expect(store.list().length).toBe(1);
    });

    test("不同 source 可用同一个 key", () => {
        const { store } = makeStore();
        createJob(store, { key: "k1" });
        const other = store.create({
            source: "other",
            idempotencyKey: "k1",
            input: { prompt: "跑测试", workspace: "/tmp/ws" },
        });

        expect(other.created).toBe(true);
        expect(store.list().length).toBe(2);
    });

    test("空 key 当作没有 key，连续提交各自新建", () => {
        const { store } = makeStore();
        expect(createJob(store, { key: "   " }).created).toBe(true);
        expect(createJob(store, { key: "   " }).created).toBe(true);
        expect(store.list().length).toBe(2);
    });
});

describe("JobStore 队列领取", () => {
    test("优先级高的先领，同优先级按创建时间 FIFO", () => {
        const { store } = makeStore();
        const low = createJob(store, { priority: 0 }).job;
        const high = createJob(store, { priority: 10 }).job;
        const mid = createJob(store, { priority: 5 }).job;

        const blocked = new Set<string>();
        expect(store.claimNext("w1", 30_000, blocked)?.id).toBe(high.id);
        expect(store.claimNext("w1", 30_000, blocked)?.id).toBe(mid.id);
        expect(store.claimNext("w1", 30_000, blocked)?.id).toBe(low.id);
    });

    test("跳过被阻塞的 workspace（同目录串行）", () => {
        const { store } = makeStore();
        createJob(store, { workspace: "/tmp/a" });
        const b = createJob(store, { workspace: "/tmp/b" });

        const claimed = store.claimNext("w1", 30_000, new Set(["/tmp/a"]));

        expect(claimed?.id).toBe(b.job.id);
    });

    test("领取后置 leased、attempts+1、写入租约", () => {
        const { store } = makeStore();
        const created = createJob(store).job;
        const claimed = store.claimNext("worker-1", 30_000, new Set());

        expect(claimed?.state).toBe("leased");
        expect(claimed?.attempts).toBe(1);
        expect(claimed?.leaseOwner).toBe("worker-1");
        expect(claimed?.leaseUntil).toBeDefined();
        expect(store.eventsSince(0).map(event => event.type)).toEqual(["job_created", "job_attempt"]);
        expect(store.get(created.id)?.state).toBe("leased");
    });

    test("没有可领的任务时返回 undefined", () => {
        const { store } = makeStore();
        expect(store.claimNext("w1", 30_000, new Set())).toBeUndefined();
    });
});

describe("JobStore 状态迁移", () => {
    test("合法迁移链 queued → leased → running → succeeded", () => {
        const { store } = makeStore();
        const job = createJob(store).job;
        store.claimNext("w1", 30_000, new Set());

        store.transition(job.id, "running");
        const done = store.transition(job.id, "succeeded", {
            result: { text: "完成", aborted: false, eventSeq: 7 },
        });

        expect(done.state).toBe("succeeded");
        expect(done.result?.text).toBe("完成");
        expect(done.finishedAt).toBeDefined();
        // 终态必须清空租约，否则过期扫描会把它判成 lost
        expect(done.leaseOwner).toBeUndefined();
        expect(done.leaseUntil).toBeUndefined();
    });

    test("非法迁移抛错且不落盘", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        expect(() => store.transition(job.id, "running")).toThrow(JobInvalidTransitionError);
        expect(store.get(job.id)?.state).toBe("queued");
    });

    test("终态不可再迁移", () => {
        const { store } = makeStore();
        const job = createJob(store).job;
        store.claimNext("w1", 30_000, new Set());
        store.transition(job.id, "running");
        store.transition(job.id, "failed", { error: "炸了" });

        expect(() => store.transition(job.id, "running")).toThrow(JobInvalidTransitionError);
    });
});

describe("JobStore 租约", () => {
    test("续租成功；换 owner 后失败", () => {
        const { store } = makeStore();
        const job = createJob(store).job;
        store.claimNext("w1", 30_000, new Set());

        expect(store.renewLease(job.id, "w1", 30_000)).toBe(true);
        expect(store.renewLease(job.id, "w2", 30_000)).toBe(false);
    });

    test("租约过期标 lost", () => {
        const { store, advance } = makeStore();
        const job = createJob(store).job;
        store.claimNext("w1", 1_000, new Set());

        advance(2_000);
        const expired = store.expireLeases();

        expect(expired.map(item => item.id)).toEqual([job.id]);
        expect(store.get(job.id)?.state).toBe("lost");
        expect(store.get(job.id)?.error).toContain("租约过期");
    });

    test("未过期的租约不被清理", () => {
        const { store, advance } = makeStore();
        createJob(store);
        store.claimNext("w1", 30_000, new Set());

        advance(1_000);
        expect(store.expireLeases()).toEqual([]);
    });
});

describe("JobStore 事件流", () => {
    test("eventsSince 按游标增量返回，可只取某个 job", () => {
        const { store } = makeStore();
        const first = createJob(store).job;
        const second = createJob(store).job;

        const all = store.eventsSince(0);
        expect(all.length).toBe(2);
        expect(store.eventsSince(all[0]!.seq).length).toBe(1);
        expect(store.eventsSince(0, { jobId: second.id }).map(event => event.jobId)).toEqual([second.id]);
        expect(new Set(all.map(event => event.seq)).size).toBe(all.length);
        expect(first.id).not.toBe(second.id);
    });

    test("subscribe 收到新增事件，取消后不再收到", () => {
        const { store } = makeStore();
        const seen: string[] = [];
        const unsubscribe = store.subscribe(event => seen.push(event.type));

        const job = createJob(store).job;
        expect(seen).toEqual(["job_created"]);

        unsubscribe();
        store.claimNext("w1", 30_000, new Set());
        expect(seen).toEqual(["job_created"]);
        expect(job.state).toBe("queued");
    });
});

describe("JobStore 卡片扩展", () => {
    test("新建任务默认不执行：授权（autoStart）后才会被领走", () => {
        const { store } = makeStore();
        const job = createJob(store, { autoStart: false }).job;

        expect(store.claimNext("w1", 30_000, new Set())).toBeUndefined();

        store.updateInput(job.id, { autoStart: true });
        expect(store.claimNext("w1", 30_000, new Set())?.id).toBe(job.id);
    });

    test("updateInput 合并而不是覆盖，属性与原字段共存", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        store.updateInput(job.id, { title: "卡片标题", labels: ["bug"], mcpServers: ["mcp-hub"] });
        const updated = store.get(job.id)!;

        expect(updated.input.title).toBe("卡片标题");
        expect(updated.input.labels).toEqual(["bug"]);
        expect(updated.input.mcpServers).toEqual(["mcp-hub"]);
        expect(updated.input.prompt).toBe("跑测试");
        expect(updated.input.workspace).toBe("/tmp/ws");
    });

    test("改 workspace 同步独立列：同目录串行按新目录判断", () => {
        const { store } = makeStore();
        const job = createJob(store, { workspace: "/tmp/a" }).job;

        store.updateInput(job.id, { workspace: "/tmp/b" });

        expect(store.get(job.id)?.input.workspace).toBe("/tmp/b");
        // 新目录被占用时领不走；旧目录不再挡它
        expect(store.claimNext("w1", 30_000, new Set(["/tmp/b"]))).toBeUndefined();
        expect(store.claimNext("w1", 30_000, new Set(["/tmp/a"]))?.id).toBe(job.id);
    });

    test("会话留档：同一卡片可记录多个执行会话", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        store.addSession(job.id, "s-run", "run", 1);
        store.addSession(job.id, "s-branch", "branch", 0);

        expect(store.listSessions(job.id).map(item => item.sessionId)).toEqual(["s-run", "s-branch"]);
    });

    test("评论增改删：软删除后默认不可见但保留历史", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        const comment = store.addComment({ jobId: job.id, body: "第一条", author: "user" });
        expect(store.listComments(job.id).map(item => item.body)).toEqual(["第一条"]);

        store.updateComment(job.id, comment.id, "改过");
        expect(store.listComments(job.id)[0]?.body).toBe("改过");

        store.deleteComment(job.id, comment.id);
        expect(store.listComments(job.id)).toEqual([]);
        expect(store.listComments(job.id, { includeDeleted: true }).length).toBe(1);
    });

    test("agent 评论记在具体会话上", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        store.addComment({ jobId: job.id, body: "已开始", author: "agent", sessionId: "s1" });

        expect(store.listComments(job.id)[0]).toMatchObject({ author: "agent", sessionId: "s1" });
    });
});

describe("JobStore 归档与删除", () => {
    test("归档后默认列表不返回，恢复后重新出现", () => {
        const { store } = makeStore();
        const job = createJob(store).job;

        store.archiveJob(job.id);
        expect(store.list().length).toBe(0);
        expect(store.list({ includeArchived: true }).length).toBe(1);
        // 状态不受影响：归档只是从看板隐藏
        expect(store.get(job.id)?.state).toBe("queued");

        store.unarchiveJob(job.id);
        expect(store.list().length).toBe(1);
    });

    test("运行中不允许归档或删除", () => {
        const { store } = makeStore();
        const job = createJob(store).job;
        store.claimNext("w1", 30_000, new Set());
        store.transition(job.id, "running");

        expect(() => store.archiveJob(job.id)).toThrow(JobConflictError);
        expect(() => store.deleteJob(job.id)).toThrow(JobConflictError);
        expect(store.get(job.id)?.state).toBe("running");
    });

    test("删除级联清掉评论、执行会话与状态事件", () => {
        const { store } = makeStore();
        const job = createJob(store).job;
        store.addSession(job.id, "s-1", "run", 1);
        store.addComment({ jobId: job.id, body: "备注", author: "user" });

        store.deleteJob(job.id);

        expect(store.get(job.id)).toBeUndefined();
        expect(store.listComments(job.id)).toEqual([]);
        expect(store.listSessions(job.id)).toEqual([]);
        expect(store.eventsSince(0, { jobId: job.id })).toEqual([]);
    });
});
