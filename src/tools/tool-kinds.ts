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
