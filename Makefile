BUN ?= bun
ZBOT_TUI_BIN ?= $(HOME)/.bun/bin/zbot
GO ?= go
BUNPACK_DIR = bunpack
BUNPACK = $(CURDIR)/.cache/bunpack

# 瘦身版：7MB 单文件，运行时借用系统 bun
build-pack:
	mkdir -p $(dir $(BUNPACK))
	$(GO) build -C $(BUNPACK_DIR) -trimpath -ldflags "-s -w" -o $(BUNPACK) .
	$(BUNPACK) build src/tui/main.ts -out $(ZBOT_TUI_BIN) -name zbot \
		-inline .tokjson

build-cli:
	$(BUN) run build
	mkdir -p "$(dir $(ZBOT_TUI_BIN))"
	$(BUN) build dist-bundle/main.js --compile --no-compile-autoload-dotenv --outfile="$(ZBOT_TUI_BIN)"

# ---- serve（Web 任务看板）----

PORT ?= 8787
CWD ?= $(CURDIR)

UI_SRC = $(shell find ui/src -type f 2>/dev/null) \
	ui/index.html ui/package.json ui/vite.config.ts ui/tsconfig.json
UI_BUNDLE = src/server/.ui-dist/index.html

# UI 是独立工程，产物以文本内联进二进制；源文件没变就跳过重建
$(UI_BUNDLE): $(UI_SRC)
	cd ui && $(BUN) install --silent && $(BUN) run build

# 源码模式：bun 直接跑 TS，只需保证 UI 产物是最新的
serve: $(UI_BUNDLE)
	$(BUN) src/tui/main.ts serve --port $(PORT) --cwd $(CWD)

# 打包模式：全量构建（tsgo + bun build）后跑 dist-bundle
dist-bundle/main.js: $(UI_BUNDLE) $(shell find src -name '*.ts' 2>/dev/null) build.mjs package.json
	$(BUN) run build

serve-prod: dist-bundle/main.js
	$(BUN) dist-bundle/main.js serve --port $(PORT) --cwd $(CWD)

# 前端 HMR：改 UI 不用重启后端
dev-ui:
	ZBOT_SERVE_URL=http://127.0.0.1:$(PORT) $(BUN) run dev:ui

.PHONY: serve serve-prod dev-ui
