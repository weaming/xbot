# 配置

## 环境变量

首次运行前，在 `~/.xbot/env` 配置模型服务：

```dotenv
# Shared fallback settings
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name

# Independent Responses API profile
OPENAI_RESPONSES_API_KEY=
OPENAI_RESPONSES_BASE_URL=
OPENAI_RESPONSES_MODEL=
OPENAI_RESPONSES_MODELS=

# Independent Chat Completions profile
OPENAI_CHAT_API_KEY=
OPENAI_CHAT_BASE_URL=
OPENAI_CHAT_MODEL=
OPENAI_CHAT_MODELS=
```

云端服务需要填写 `OPENAI_API_KEY`。如果 `OPENAI_BASE_URL` 指向本机或局域网地址，可以留空或省略密钥。

两种协议可分别设置 API Key、Base URL 和模型。`OPENAI_RESPONSES_*` 与 `OPENAI_CHAT_*` 会覆盖对应协议的共享 `OPENAI_*` 值；未填写时回退到共享值，兼容现有配置。`*_MODEL` 设置默认模型，`*_MODELS` 可用逗号配置多个可切换模型；默认模型也会出现在候选列表中。

只配置一套专属协议时会自动使用该配置；两套都配置时，初始默认协议根据 `OPENAI_MODEL` 前缀判断（`gpt`/`codex` 使用 Responses API，其余默认 Chat Completions）。也可以在 TUI 中通过 `/model` 选择协议和模型。DeepSeek 支持两种协议，两者 Base URL 均为 `https://api.deepseek.com`（不带 `/v1`）；兼容服务需实现所选协议。

TUI 中只需输入 `/model`，再依次选择协议、模型，以及是否设为默认（默认选“否”）。当前选择会保存到该会话，重新打开会话时自动恢复；选择“是”会同时更新默认模型，供没有单独设置模型的会话使用。只有一个可选组合时，命令会提示配置多个协议或模型。默认模型保存在 TUI 状态目录的 `model-preferences.json`。

可从仓库根目录的 `env.example` 复制模板。也可以通过 `XBOT_ENV_FILE` 指定其他文件路径。不要把真实密钥提交到仓库。

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
