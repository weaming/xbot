# 配置

## 环境变量

首次运行前，在 `~/.xbot/.env` 配置模型服务：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name
```

云端服务需要填写 `OPENAI_API_KEY`。如果 `OPENAI_BASE_URL` 指向本机或局域网地址，可以留空或省略密钥。

可从仓库根目录的 `.env.example` 复制模板。也可以通过 `XBOT_ENV_FILE` 指定其他文件路径。不要把真实密钥提交到仓库。

可选项：

| 变量 | 用途 |
| --- | --- |
| `XBOT_MEMORY_USER_ID` | 记忆用户标识，默认 `0` |
| `NETWORK_PROXY` | 网络和命令行工具使用的代理；TUI 会将容器默认代理地址调整为 `http://localhost:7890` |
| `OPENAI_PROXY` | 模型 API 请求使用的代理 |

TUI 的 MCP 服务列表由 `~/.xbot/mcp-servers.yaml` 管理。详见 [MCP 服务配置](mcp.md)。

## 配置和数据目录

默认情况下，xbot 将环境文件、MCP 配置、会话、日志和 OAuth 凭据保存在 `~/.xbot/`。MCP OAuth 凭据保存在 `~/.xbot/mcp-auth/`，应按敏感信息保护。

可用 `XBOT_MCP_SERVERS_FILE` 指定 MCP 配置文件。可用 `XBOT_ENV_FILE` 指定环境文件。

## 构建独立命令

安装 Bun 和项目依赖后，在仓库根目录运行：

```fish
bun install
make build-cli
```

命令会构建独立可执行文件 `xbot`，默认写入 `~/.bun/bin/xbot`。确保该目录在 `PATH` 中即可直接运行 `xbot`。可通过 `XBOT_TUI_BIN` 覆盖输出路径：

```fish
set -x XBOT_TUI_BIN "$HOME/.local/bin/xbot"
make build-cli
```
