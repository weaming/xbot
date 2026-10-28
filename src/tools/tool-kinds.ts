/**
 * 工具语义判定：按工具名识别 patch / 文件变更等类别。
 *
 * 发送前适配（orchestrator）与展示层（tui）共用同一口径，
 * 新增判定只加在这里，避免两处识别逻辑漂移。
 */

/** 判断是否为 apply_patch / codex patch 工具。 */
export function isApplyPatchTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "apply_patch"
        || normalized.endsWith("__apply_patch")
        || normalized.endsWith(":apply_patch")
        || normalized.includes("apply_patch")
    );
}

/** apply_patch 家族的唯一参数名：custom 工具的裸文本在执行层按 {patch} 传入。 */
const PATCH_ARG_NAME = "patch";

/** 裸补丁文本 → function 调用的参数 JSON，与历史消息保持同形。 */
export function patchArgumentsJson(input: string): string {
    return JSON.stringify({ [PATCH_ARG_NAME]: input });
}

/**
 * function 调用的参数 → 裸补丁文本。
 * 参数不是合法 JSON 时按「网关把 custom 调用降级成 function_call」处理：整段原文当补丁，
 * 让补丁内容至少能到达服务端校验，而不是静默变成空补丁。
 */
export function patchFromArguments(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed[PATCH_ARG_NAME] !== "string") return "";
        return parsed[PATCH_ARG_NAME];
    } catch {
        return raw;
    }
}

/** 判断是否为文件变更工具（edit_file / write_file / apply_patch 等）。 */
export function isFileMutationTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "edit_file"
        || normalized === "write_file"
        || normalized === "write_files"
        || normalized.endsWith("__edit_file")
        || normalized.endsWith("__write_file")
        || normalized.endsWith("__write_files")
        || normalized.endsWith(":edit_file")
        || normalized.endsWith(":write_file")
        || isApplyPatchTool(toolName)
    );
}

/** 获取 patch 工具的显示标识标签。 */
export function getPatchToolTag(toolName: string): string | undefined {
    if (!isApplyPatchTool(toolName)) return undefined;
    return toolName.toLowerCase().includes("codex") ? "codex:apply_patch" : "apply_patch";
}
