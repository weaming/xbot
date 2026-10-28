/** 修复历史 Responses 输入中不符合 API 格式的 function_call item ID。 */
export function repairResponsesFunctionCallItemIds(items: any[]): any[] {
  return items.map((item) => {
    if (item?.type !== "function_call" || item.id === undefined) return item;
    if (typeof item.id === "string" && item.id.startsWith("fc")) return item;

    return { ...item, id: `fc_${crypto.randomUUID().replaceAll("-", "")}` };
  });
}
