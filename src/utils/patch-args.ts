/**
 * apply_patch 参数形态的唯一实现。
 *
 * 同一份补丁在两种工具形态下来回搬：custom 工具给的是裸文本（input），
 * function 工具给的是 JSON 字符串（arguments）。包裹与解包只在这里做，
 * 避免各模块各写一遍导致口径漂移。
 */

/** apply_patch 家族的唯一参数名：custom 工具的裸文本在执行层按 {patch} 传入。 */
const PATCH_ARG_NAME = "patch";

/** 裸补丁文本 → function 调用的参数 JSON。 */
export function patchArgumentsJson(input: string): string {
    return JSON.stringify({ [PATCH_ARG_NAME]: input });
}

/**
 * function 调用的参数 → 裸补丁文本。
 *
 * 参数不是 JSON 对象时按「网关把 custom 调用降级成 function_call」处理：整段原文就是补丁，
 * 让内容至少能到达服务端校验。以 `{` 开头却解析失败的是截断/损坏的 JSON，此时返回空补丁，
 * 否则 `{"patch":"` 这截前缀会混进补丁污染上下文。
 */
export function patchFromArguments(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;

    const text = raw.trim();
    if (!text) return undefined;
    if (!text.startsWith("{")) return raw;

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed[PATCH_ARG_NAME] === "string" ? parsed[PATCH_ARG_NAME] : "";
    } catch {
        return "";
    }
}
