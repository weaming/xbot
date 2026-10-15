# xbot

xbot 是一个基于 Bun 的终端 AI 助手，提供 TUI 界面。

## 安装

需要先安装 [Bun](https://bun.sh/)：

```sh
git clone https://github.com/weaming/xbot.git
cd xbot
bun install
make build-cli
```

## 配置

```sh
mkdir -p ~/.xbot
cp env.example ~/.xbot/env
vi ~/.xbot/env
```

填写 `OPENAI_MODEL`。使用云端服务时填写 `OPENAI_API_KEY`；本地或局域网服务可省略密钥。兼容接口可按需调整 `OPENAI_BASE_URL`。

## 使用

```sh
~/.bun/bin/xbot
```

MCP 多服务配置见 [docs/mcp.md](docs/mcp.md)。
