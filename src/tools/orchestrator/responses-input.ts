/** 清理可选的输出状态，并修复历史 Responses 工具调用 item ID。 */
export function repairResponsesFunctionCallItemIds(items: any[]): any[] {
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const hasStatus = Object.hasOwn(item, "status")
      && ["function_call", "custom_tool_call", "message", "reasoning"].includes(item.type);
    const hasInvalidFunctionCallId = item.type === "function_call" && item.id !== undefined
      && (typeof item.id !== "string" || !item.id.startsWith("fc"));
    const hasInvalidCustomCallId = item.type === "custom_tool_call" && item.id !== undefined
      && (typeof item.id !== "string" || !item.id.startsWith("ctc"));
    if (!hasStatus && !hasInvalidFunctionCallId && !hasInvalidCustomCallId) return item;

    const inputItem = { ...item };
    delete inputItem.status;
    if (hasInvalidFunctionCallId) inputItem.id = `fc_${newItemIdSuffix()}`;
    if (hasInvalidCustomCallId) inputItem.id = `ctc_${newItemIdSuffix()}`;
    return inputItem;
  });
}

function newItemIdSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
