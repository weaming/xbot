import { expect, test } from "bun:test";
import { collectResponsesStream } from "./responses-stream.js";

test("Codex 限额和未知扩展事件不阻断响应", async () => {
  async function* events(): AsyncIterable<any> {
    yield { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 25 } } };
    yield { type: "codex.future_event" };
    yield { type: "response.output_text.delta", delta: "完成" };
    yield { type: "response.completed", response: { id: "resp_1", output: [] } };
  }

  const emitted: unknown[] = [];
  const response = await collectResponsesStream(events(), event => emitted.push(event));

  expect(emitted).toEqual([{ type: "text_delta", delta: "完成" }]);
  expect(response.output[0].content[0].text).toBe("完成");
});
