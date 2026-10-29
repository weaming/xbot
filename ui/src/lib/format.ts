/** 展示用格式化：只改显示，不改数据。 */

/** home 前缀缩成 `~`，避免界面上拉一长串用户名路径。 */
export function abbreviateHome(path: string, home: string): string {
    if (!path || !home) return path;
    const trimmed = path.replace(/\/+$/, "");
    if (trimmed === home.replace(/\/+$/, "")) return "~";
    if (trimmed.startsWith(`${home.replace(/\/+$/, "")}/`)) {
        return `~${trimmed.slice(home.replace(/\/+$/, "").length)}`;
    }
    return path;
}
