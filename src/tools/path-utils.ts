import * as path from "path";
import { getToolCwd } from "../utils/runtime-paths.js";

/** 将绝对路径或相对路径解析为实际路径；相对路径以工具工作目录为基准。 */
export function resolvePath(inputPath: string, cwdRoot?: string): string {
    const base = path.isAbsolute(inputPath)
        ? inputPath
        : path.join(cwdRoot || getToolCwd(), inputPath);
    return path.resolve(base);
}
