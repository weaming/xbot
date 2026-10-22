BUN ?= bun
XBOT_TUI_BIN ?= $(HOME)/.bun/bin/xbot
GO ?= go
BUNPACK_DIR = bunpack
BUNPACK = $(CURDIR)/.cache/bunpack

# 瘦身版：7MB 单文件，运行时借用系统 bun。
# js 与词表经 fd 注入不落盘，仅 .node 落盘（napi 的 dlopen 需真实路径）。
build-pack:
	mkdir -p $(dir $(BUNPACK))
	$(GO) build -C $(BUNPACK_DIR) -trimpath -ldflags "-s -w" -o $(BUNPACK) .
	$(BUNPACK) build src/tui/main.ts -out $(XBOT_TUI_BIN) -name xbot \
		-inline .tokjson -native .node -external tokenizers \
		-env .tokjson=XBOT_TOKENIZER_FD -env .node=XBOT_NATIVE_DIR

build-cli:
	$(BUN) run build
	mkdir -p "$(dir $(XBOT_TUI_BIN))"
	$(BUN) build dist-bundle/main.js --compile --no-compile-autoload-dotenv --outfile="$(XBOT_TUI_BIN)"

