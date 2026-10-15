BUN ?= bun
XBOT_TUI_BIN ?= $(HOME)/.bun/bin/xbot

build-cli:
	$(BUN) run build
	mkdir -p "$(dir $(XBOT_TUI_BIN))"
	$(BUN) build dist-bundle/main.js --compile --no-compile-autoload-dotenv --outfile="$(XBOT_TUI_BIN)"
