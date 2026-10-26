# MCP 服务

TUI 从 `~/.zbot/mcp-servers.yaml` 读取 MCP 服务配置。没有该文件时不会连接 MCP 服务。示例配置见仓库根目录的 [mcp-servers.example.yaml](../mcp-servers.example.yaml)。

可用命令管理服务：

```sh
zbot mcp list
zbot mcp add local-files --env HOME_DIR=$HOME/src -- npx -y @modelcontextprotocol/server-filesystem
zbot mcp add remote-tools --url https://example.com/mcp --header Authorization='Bearer token'
zbot mcp remove local-files
```

`list` 支持 `--json`。`add` 会写入同一份配置文件；stdio 服务可用 `--env KEY=VALUE` 和 `--cwd`，HTTP 服务可用 `--header KEY=VALUE`。配置文件路径可通过 `ZBOT_MCP_SERVERS_FILE` 指定。

将示例文件复制到配置目录后，按需编辑服务地址、命令和环境变量：

```fish
mkdir -p "$HOME/.zbot"
cp mcp-servers.example.yaml "$HOME/.zbot/mcp-servers.yaml"
```

配置支持 `mcpServers` 映射或 `servers` 列表，可同时配置多个服务。支持 `stdio`、`http`、`streamable-http` 和 `sse` 类型。下面是两个服务的简化示例：

```yaml
mcpServers:
  local-files:
    type: stdio
    command: npx
    args:
      - -y
      - '@modelcontextprotocol/server-filesystem'
      - '${HOME}/src'
  remote-tools:
    type: http
    url: '${MCP_REMOTE_URL}'
    headers:
      Authorization: 'Bearer ${MCP_REMOTE_TOKEN}'
    requiredEnv:
      - MCP_REMOTE_URL
      - MCP_REMOTE_TOKEN
```

字符串字段支持 `${VAR}` 环境变量展开。`requiredEnv` 中任一变量缺失时，该服务会被跳过；建议把令牌放在 `~/.zbot/env`，不要写入公开配置文件。

每个服务还可设置 `disabled`、`includeTools`、`excludeTools`、`prefix`、`rename` 和 `tags` 来控制启用状态、工具筛选、命名和分组。`defer: true` 会在 `OPENAI_RESPONSES_HOSTED_TOOLS` 含 `tool_search` 时，把该 MCP 服务的 Responses 工具定义标记为 `defer_loading: true`，由上游托管的 `tool_search` 按需发现；本地 MCP 执行器仍负责执行实际工具调用。需要 OAuth 的 HTTP 服务可设置 `oauth: true`；授权凭据会写入 `~/.zbot/mcp-auth/`。

工具名默认加 `<服务名>__` 前缀（如服务 `LongPort` 的 `quote` → `LongPort__quote`），因为不同服务的同名工具在目录里会互相顶掉：同名的那一个会被跳过并在日志里提示 `Skipped conflicting tools`，而不是覆盖。`prefix` 可改前缀，`rename` 优先级最高；显式设置 `prefix: ""` 可关闭默认前缀。

托管工具只在 Responses 协议声明，形状保持 OpenAI 官方最小写法（`{"type":"web_search"}`、`{"type":"tool_search"}`）。DeepSeek 兼容端只托管 `web_search`；模型名同时含 `deepseek` 与 `flash` 时（上游会忽略联网搜索）以及其他类型本地直接丢弃，`defer: true` 随之失效。

运行 TUI 后，可使用 `/mcp` 查看 MCP 连接状态。
