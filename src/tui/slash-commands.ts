/** TUI 命令与纯文本工具：slash 命令表、会话快捷键、帮助文本、单行截断。 */

import { Key } from "@earendil-works/pi-tui";
import type { SlashCommand } from "@earendil-works/pi-tui";
import { skillRegistry } from "../skills/skill-registry.js";
import { getAgentsSkillsDir, getUserSkillsDir } from "../utils/runtime-paths.js";

export const SLASH_COMMANDS: SlashCommand[] = [
    { name: "new", description: "新建会话" },
    { name: "review", description: "发起 dev-review → 修复循环，通过后暂存并提交" },
    { name: "sessions", description: "打开会话面板（搜索 / 切换 / 管理）" },
    { name: "todo", description: "打开任务清单面板（Ctrl+T）" },
    { name: "tasks", description: "查看或管理后台 shell 任务（list/status/wait/stop）" },
    { name: "ps", description: "列出当前会话正在运行的后台任务" },
    { name: "stop", description: "终止当前会话运行中的后台任务（可指定 id）" },
    { name: "reload", description: "重新加载磁盘技能与 MCP 工具" },
    { name: "keys", description: "显示全部快捷键（Ctrl+/ / F1）" },
    { name: "continue", description: "继续执行未完成的任务" },
    { name: "clear", description: "清空当前会话" },
    { name: "archive", description: "归档当前会话（可在会话面板查看）" },
    { name: "unarchive", description: "取消归档当前会话" },
    { name: "delete", description: "彻底删除当前会话" },
    { name: "close", description: "关闭当前会话（释放持有，数据保留）" },
    { name: "compact", description: "压缩当前会话上下文" },
    { name: "effort", description: "查看或设置当前会话思考强度 [配置档位|auto]" },
    { name: "thinking", description: "查看或设置思考强度 (/effort 别名)" },
    { name: "model", description: "选择当前会话的协议与模型" },
    { name: "reasoning", description: "展开 / 收起思考过程显示" },
    { name: "system", description: "显示当前 system prompt" },
    { name: "skills", description: "显示可用技能" },
    { name: "mcp", description: "显示 MCP 服务状态与工具清单" },
    { name: "help", description: "显示帮助" },
];

/** /review 发送的固定指令：dev-review → 修复循环，通过后再暂存并提交。 */
export const REVIEW_PROMPT = [
    "做 dev-review → fix 循环，直到 review 通过再 commit。",
    "每轮 review 都交给同一个 subagent：跨轮复用，循环结束后 close 它。",
    "被 review 的改动在 review 期间保持 unstaged，每轮 review 完就 stage；review 通过后 commit。",
].join("\n");

export const SESSION_SHORTCUTS = [
    Key.ctrl("1"),
    Key.ctrl("2"),
    Key.ctrl("3"),
    Key.ctrl("4"),
    Key.ctrl("5"),
    Key.ctrl("6"),
    Key.ctrl("7"),
    Key.ctrl("8"),
    Key.ctrl("9"),
];

export const TAB_LINK_PREFIX = "zbot://session/";
/** 会话面板与新建会话的点击目标（由 TUI 内部处理，不交给系统浏览器）。 */
export const SESSION_PANEL_URL = "zbot://sessions";
export const SESSION_NEW_URL = "zbot://new";
export const TODO_PANEL_URL = "zbot://todos";
export const SHORTCUT_PANEL_URL = "zbot://keys";

/** Ctrl+C / Ctrl+D 防误退确认窗口（ms）：窗口内再按一次退出键才真正退出。 */
export const EXIT_CONFIRM_MS = 2_000;

/** 把多行文本折叠为单行预览并按可见宽度截断，保留 ANSI 序列外的换行/控制字符。 */
export function truncateInline(text: string, maxColumns: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= maxColumns) return flat;
    return `${flat.slice(0, Math.max(0, maxColumns - 1))}…`;
}

/** 构建 /skills 帮助文本：列出已加载技能及技能目录位置。 */
export function buildSkillsHelpText(): string {
    const metas = skillRegistry.getAllSkillMetas();
    const lines = metas.length > 0
        ? metas
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((meta) => `  - ${meta.name}: ${meta.description || "（无描述）"}`)
        : ["  （暂无技能）"];
    return [
        "可用技能（会自动扫描并热加载）：",
        ...lines,
        "",
        `技能目录：${getUserSkillsDir()}（用户级，优先） · ${getAgentsSkillsDir()}（共享）`,
        "提示：每个技能为一个子目录，内含 SKILL.md（frontmatter 含 name/description）。",
    ].join("\n");
}

/** 把文本包装成 OSC 8 超链接，点击后由 TUI 的 openUrl 回调处理。 */
export function wrapAppLink(text: string, url: string): string {
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** 将会话 Tab 包装成由 TUI 处理的 OSC 8 超链接。 */
export function wrapTabLink(text: string, sessionId: string): string {
    return wrapAppLink(text, `${TAB_LINK_PREFIX}${encodeURIComponent(sessionId)}`);
}

export function isValidSlashCommand(text: string): boolean {
    const command = text.trimStart().split(/\s+/, 1)[0];
    return SLASH_COMMANDS.some((item) => `/${item.name}` === command);
}

export function buildHelpText(): string {
    return [
        "可用命令：",
        "  /new      新建会话",
        "  /review   发送 dev-review → 修复循环指令（通过后暂存并提交）",
        "  /sessions 打开会话面板（⌘P / ⌃P）",
        "  /todo     打开任务清单面板（⌃T）",
        "  /tasks [list]                  列出当前会话的后台任务",
        "  /tasks status <task_id>        查看任务状态与输出",
        "  /tasks wait <task_id> [秒]     等待任务完成（默认 10 秒）",
        "  /tasks stop <task_id>          终止运行中的任务",
        "  /ps                            列出当前会话运行中的后台任务",
        "  /stop                          终止当前会话所有运行中的后台任务",
        "  /stop <task_id> | all          终止指定任务或当前会话所有运行中任务",
        "  /reload   重新加载磁盘技能与 MCP 工具",
        "  /keys     显示全部快捷键（⌃/ / F1）",
        "  /clear    清空当前会话（事件日志截断重建）",
        "  /archive  归档当前会话（⌘P 面板仍可见）",
        "  /unarchive 取消归档当前会话",
        "  /delete   彻底删除当前会话",
        "  /close    关闭当前会话（释放本实例持有，⌘P 可重新打开）",
        "  /compact  压缩当前会话上下文",
        "  /continue 继续执行未完成的任务（补跑中断的工具，⌥+Enter 快捷触发）",
        "  /effort   查看或修改当前会话思考强度 [配置档位|auto]",
        "  /thinking 思考强度别名",
        "  /model    选择当前会话的协议与模型",
        "  /reasoning 展开 / 收起思考过程显示",
        "  /system   显示当前 system prompt",
        "  /skills   显示可用技能",
        "  /mcp      显示 MCP 服务状态与工具清单",
        "  /help     显示帮助",
    ].join("\n");
}
