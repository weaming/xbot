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
});
