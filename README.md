# xbot

xbot 是一个基于 Bun 的终端 AI 助手，提供 TUI 界面。

## 安装

需要先安装 [Bun](https://bun.sh/)：

```sh
git clone https://github.com/weaming/xbot.git
cd xbot
bun install
make build-pack
```

产物是单个可执行文件，运行时借用系统 bun。

| 目标 | 产物 | 说明 |
| --- | --- | --- |
| `make build-pack` | 5.4 MB | 需要目标机有 bun |
| `make build-cli` | 66 MB | 内嵌 bun 运行时，无需安装 |

## 配置

```sh
mkdir -p ~/.xbot
cp env.example ~/.xbot/env
vi ~/.xbot/env
```

填写 `OPENAI_MODEL`。旧的 `OPENAI_*` 配置按 Chat Completions 使用；云端服务填写 `OPENAI_API_KEY`，本地或局域网服务可省略密钥。兼容接口可按需调整 `OPENAI_BASE_URL`。

Responses API 和 Chat Completions 可使用各自的 `OPENAI_RESPONSES_*` 与 `OPENAI_CHAT_*` 配置。DeepSeek 两种协议的 Base URL 都是 `https://api.deepseek.com`。配置多个协议或模型后，在 TUI 输入 `/model` 可为当前会话选择模型。

## 使用

```sh
~/.bun/bin/xbot
```

文档：[MCP 多服务配置](docs/mcp.md)、[TUI 链接与终端交互](docs/tui-links.md)。
