import * as fs from "fs";
import * as path from "path";
import { getSrcRoot, getToolCwd, getWorkspaceRoot } from "../utils/runtime-paths.js";

function isWithinDirectory(targetPath: string, directoryPath: string): boolean {
    return targetPath === directoryPath || targetPath.startsWith(directoryPath + path.sep);
}

function safeRealpath(directoryPath: string): string | null {
    try {
        return fs.realpathSync(directoryPath);
    } catch {
        return null;
    }
}

function getRealExistingAncestor(targetPath: string): string | null {
    let currentPath = targetPath;
    while (!fs.existsSync(currentPath)) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) return null;
        currentPath = parentPath;
    }

    return fs.realpathSync(currentPath);
}

/**
 * 解析并验证路径，拒绝通过符号链接离开允许目录的访问。
 * 允许目录：workspace 根 + src 根（workspace 下的宿主机源码挂载点）。
 * 相对路径以 cwdRoot 为基准（src 下 git 仓库根或 workspace 根）。
 */
export function resolveSafePath(inputPath: string, cwdRoot?: string): string | null {
    const roots = [getWorkspaceRoot(), getSrcRoot(), getToolCwd()];
    const realRoots = roots.map(safeRealpath).filter((real): real is string => real !== null);

    const base = path.isAbsolute(inputPath)
        ? inputPath
        : path.join(cwdRoot || getToolCwd(), inputPath);
    const resolved = path.resolve(base);

    if (!roots.some((root) => isWithinDirectory(resolved, root))) return null;

    const realAncestor = getRealExistingAncestor(resolved);
    if (!realAncestor || !realRoots.some((realRoot) => isWithinDirectory(realAncestor, realRoot))) return null;

    return resolved;
}
