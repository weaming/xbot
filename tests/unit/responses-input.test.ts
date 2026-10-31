import { describe, expect, test } from "bun:test";
import { repairResponsesFunctionCallItemIds } from "../../src/tools/orchestrator/responses-input.js";

describe("Responses input repair", () => {
  test("replaces an invalid function_call item ID and preserves its call ID", () => {
    const call = {
      type: "function_call",
      id: "call_nf6z7KGHANvp7uUZb1WhPzpx",
      call_id: "call_nf6z7KGHANvp7uUZb1WhPzpx",
    };

    const [repaired] = repairResponsesFunctionCallItemIds([call]);

    expect(repaired.id).toMatch(/^fc/);
    expect(repaired.call_id).toBe(call.call_id);
    expect(repaired).not.toBe(call);
  });

  test("preserves valid function_call IDs and unrelated items", () => {
    const call = { type: "function_call", id: "fc_original", call_id: "call_original" };
    const message = { type: "message", id: "msg_original" };

    const repaired = repairResponsesFunctionCallItemIds([call, message]);

    expect(repaired).toEqual([call, message]);
    expect(repaired[0]).toBe(call);
    expect(repaired[1]).toBe(message);
  });

  test("removes output status without modifying the original item", () => {
    const call = { type: "function_call", id: "fc_original", status: "completed" };

    const [repaired] = repairResponsesFunctionCallItemIds([call]);

    expect(repaired).toEqual({ type: "function_call", id: "fc_original" });
    expect(repaired).not.toBe(call);
    expect(call.status).toBe("completed");
  });

  test("preserves required hosted tool statuses during replay", () => {
    const hostedItems = [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["nginx"] } },
      { type: "file_search_call", id: "fs_1", status: "completed", queries: ["nginx"] },
      { type: "code_interpreter_call", id: "ci_1", status: "completed", code: "print(1)" },
      { type: "image_generation_call", id: "ig_1", status: "completed", result: "image" },
      { type: "tool_search_call", id: "ts_1", status: "completed", call_id: "call_1" },
    ];

    const repaired = repairResponsesFunctionCallItemIds(hostedItems);

    expect(repaired).toEqual(hostedItems);
    repaired.forEach((item, index) => expect(item).toBe(hostedItems[index]));
  });
});
