import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getResponsesBaselineFile } from "../../utils/state-paths.js";
import { buildResponsesContinuation, deleteResponsesBaseline, ResponsesBaselineStore, responsesIdentity } from "./responses-baseline.js";

test("保存的基准绑定会话和上游身份，清理后不可恢复", async () => {
  const previous = process.env.ZBOT_STATE_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "zbot-baseline-"));
  process.env.ZBOT_STATE_DIR = dir;
  const sessionId = "test-session";
  const baseline = {
    request: { model: "gpt-5", store: true, input: [{ role: "user", content: "hi" }] },
    responseId: "resp_1",
    output: [{ type: "message", id: "msg_1" }],
  };
  try {
    const store = new ResponsesBaselineStore(sessionId, "identity-a");
    await store.save(baseline);
    expect((await stat(getResponsesBaselineFile(sessionId))).mode & 0o777).toBe(0o600);
    expect(await new ResponsesBaselineStore(sessionId, "identity-a").load()).toEqual(baseline);
    expect(await new ResponsesBaselineStore(sessionId, "identity-b").load()).toBeUndefined();
    expect(responsesIdentity("https://example.com", "key", "org", "project-a"))
      .not.toBe(responsesIdentity("https://example.com", "key", "org", "project-b"));
    const script = 'import { ResponsesBaselineStore } from "./src/tools/orchestrator/responses-baseline.ts"; console.log(JSON.stringify(await new ResponsesBaselineStore(process.env.ZBOT_TEST_SESSION_ID, "identity-a").load()));';
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, ZBOT_TEST_SESSION_ID: sessionId },
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(baseline);

    const next = { role: "user", content: "next" };
    const full = { ...baseline.request, input: [...baseline.request.input, ...baseline.output, next] };
    expect(buildResponsesContinuation(full, baseline)).toEqual({ ...full, previous_response_id: "resp_1", input: [next] });
    expect(buildResponsesContinuation({ ...full, model: "other" }, baseline)).toEqual({ ...full, model: "other" });
    expect(buildResponsesContinuation({ ...full, previous_response_id: "manual" }, baseline)).toEqual({ ...full, previous_response_id: "manual" });

    await deleteResponsesBaseline(sessionId);
    expect(await store.load()).toBeUndefined();
    await store.save({ ...baseline, request: { ...baseline.request, store: false } });
    expect(await store.load()).toBeUndefined();
    await store.save(baseline);
    const expired = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(getResponsesBaselineFile(sessionId), expired, expired);
    expect(await store.load()).toBeUndefined();
    await expect(stat(getResponsesBaselineFile(sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
