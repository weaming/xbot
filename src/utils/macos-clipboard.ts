import { execFileSync } from "node:child_process";

const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isPng(data: Buffer): boolean {
    return data.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.equals(data.subarray(0, PNG_SIGNATURE.length));
}

/** 读取 macOS 剪贴板中的图片；文字剪贴板返回 undefined。 */
export function readMacOSClipboardImage(
    readClipboard: () => Buffer = () => execFileSync("pbpaste", ["-Prefer", "png"], { maxBuffer: MAX_CLIPBOARD_BYTES }),
): Buffer | undefined {
    if (process.platform !== "darwin") return undefined;

    try {
        const data = readClipboard();
        return isPng(data) ? data : undefined;
    } catch {
        return undefined;
    }
}

