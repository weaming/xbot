/**
 * MCP 子命令用法：放在 mcp 层，cli 层的总帮助直接复用这份文本。
 * 只导出字符串，不 import 任何模块（TUI 入口会静态依赖 cli/help → 这里）。
 */

export const MCP_CLI_USAGE = [
    "用法：zbot mcp <子命令> [参数]",
    "",
    "  list [--json]                                列出已配置的 MCP 服务",
    "  add <名称> --url <URL> [--header KEY=VALUE]  添加 HTTP 服务",
    "  add <名称> [--env KEY=VALUE] [--cwd 目录] -- <命令> [参数...]",
    "                                               添加 stdio 服务",
    "  remove <名称>                                移除服务",
    "",
    "配置文件默认 ~/.zbot/mcp-servers.yaml，可用 ZBOT_MCP_SERVERS_FILE 指定。",
].join("\n");
