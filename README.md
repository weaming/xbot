# zbot

zbot 是一个基于 Bun 的终端 AI 助手，提供 TUI 界面。

## 安装

需要先安装 [Bun](https://bun.sh/)：

```sh
git clone https://github.com/weaming/zbot.git
cd zbot
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
mkdir -p ~/.zbot
cp env.example ~/.zbot/env
vi ~/.zbot/env
```

填写 `OPENAI_MODEL`。旧的 `OPENAI_*` 配置按 Chat Completions 使用；云端服务填写 `OPENAI_API_KEY`，本地或局域网服务可省略密钥。兼容接口可按需调整 `OPENAI_BASE_URL`。

Responses API 和 Chat Completions 可使用各自的 `OPENAI_RESPONSES_*` 与 `OPENAI_CHAT_*` 配置。DeepSeek 两种协议的 Base URL 都是 `https://api.deepseek.com`。配置多个协议或模型后，在 TUI 输入 `/model` 可为当前会话选择模型。

## 使用

```sh
~/.bun/bin/zbot
```

会话也可以在命令行里增删查改（供其他 AI 或脚本调用）：

```sh
~/.bun/bin/zbot session list
~/.bun/bin/zbot session show <id>
~/.bun/bin/zbot session send <id> "跑一下测试" --wait
```

也可以常驻成无 UI 宿主，用 HTTP 发布任务、SSE 订阅进度：

```sh
~/.bun/bin/zbot serve --port 8787 --cwd ~/src/project
```

```sh
TOKEN=$(cat ~/.zbot/serve/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"title":"跑测试"}' http://127.0.0.1:8787/sessions
curl -sN -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/sessions/<id>/events?since=0"
```

文档：[会话命令行](docs/session-cli.md)、[serve 接口](docs/serve-api.md)、[MCP 多服务配置](docs/mcp.md)、[TUI 链接与终端交互](docs/tui-links.md)。
