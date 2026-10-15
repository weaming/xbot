/** 共享的 pi-tui 测试替身：只实现 ChatApp 真正用到的 API（渲染组件全部空实现）。 */

const realPiTui = await import("@earendil-works/pi-tui");

export const tuiStub: any = {
    ...realPiTui,
    // 渲染组件
    Container: class { children: any[] = []; addChild(c: any) { this.children.push(c); } clear() { this.children = []; } render() { return []; } invalidate() {} },
    Text: class { constructor(private text = "", public padTop = 0, public padBottom = 0) {} setText(text: string) { this.text = text; } getText() { return this.text; } render() { return [this.text]; } invalidate() {} },
    ScrollView: class { constructor(_c: any, _opts: any) {} scrollToEnd() {} invalidate() {} get viewportHeight() { return 20; } },
    Markdown: class { constructor(_t: any, _p: any, _p2: any, _theme: any) {} render() { return []; } invalidate() {} },
    ProcessTerminal: class { columns = 80; rows = 24; start() {} stop() {} write() {} onResize() {} onInput() {} onSignal() {} },
    Spacer: class { constructor(_h: number) {} render() { return []; } invalidate() {} },
    VStack: class { entries: any[] = []; constructor(entries: any[] = []) { this.entries = entries; } render() { return []; } setMinSize(c: any, n: number) { const e = this.entries.find(x => x.component === c); if (e) e.minSize = Math.max(0, Math.floor(n)); } },
    HStack: class { constructor(_e: any[]) {} render() { return []; } },
    // 输入：Key / matchesKey 用真实实现（测试直接传真实转义序列）
    isKittyProtocolActive: () => false,
    setKittyProtocolActive: () => {},
    isKittyRepeatOrRelease: (_data: string) => false,
    isKeyRepeat: (_data: string) => false,
    isKeyRelease: (_data: string) => false,
    KeybindingsManager: class { constructor(_b: any, _m: any) {} },
    setKeybindings: () => {},
    TUI_KEYBINDINGS: {},
    TuiAltScreen: class { columns = 80; rows = 24; inputListeners: any[] = [];
        scrollByCalls: number[] = [];
        terminal = { columns: 80, rows: 24 };
        constructor(_t: any, _s?: any, _l?: any, _o?: any) {}
        setLayoutRoot(_l: any) {} addInputListener(cb: any) { this.inputListeners.push(cb); } setFocus(_c: any) {} start() {} stop(_options?: any) {} requestRender() {}
        scrollBy(lines: number) { this.scrollByCalls.push(lines); }
        handleInput(_d: any) {}
        showOverlay(_c: any, _o?: any) { return { hide() {}, setHidden(_h: boolean) {}, isHidden() { return false; }, focus() {}, unfocus() {}, isFocused() { return false; } }; }
        flashCalls: string[] = [];
        flash(message: string, _durationMs?: number) { this.flashCalls.push(message); }
    },
    Editor: class { private text = ""; onSubmit?: (v: string) => void; onChange?: (v: string) => void;
        history: string[] = []; historyIndex = -1; historyDraft: any = null; disableSubmit = false; isReadOnly = false; borderColor: any = () => "";
        state = { lines: [""], cursorLine: 0, cursorCol: 0 };
        constructor(public tui: any = { requestRender: () => {} }, public theme?: any) {}
        setText(t: string) {
            this.text = t;
            this.state.lines = t.split("\n");
            this.state.cursorLine = this.state.lines.length - 1;
            this.state.cursorCol = (this.state.lines[this.state.cursorLine] || "").length;
        }
        getText() { return this.text; }
        setHistory(h: string[]) { this.history = [...h]; this.historyIndex = -1; }
        addToHistory(t: string) { this.history.push(t); }
        setCursorCol(c: number) { this.state.cursorCol = c; }
        moveCursor(deltaLine: number, _deltaCol: number) {
            this.state.cursorLine = Math.max(0, Math.min(this.state.lines.length - 1, this.state.cursorLine + deltaLine));
        }
        handleInput(data: string) {
            if (data === "up" || data === "\x1b[A") {
                if (this.history.length > 0) {
                    this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
                    this.setText(this.history[this.historyIndex] || "");
                    this.state.cursorLine = 0;
                    this.state.cursorCol = 0;
                }
            } else if (data === "down" || data === "\x1b[B") {
                if (this.historyIndex > 0) {
                    this.historyIndex--;
                    this.setText(this.history[this.historyIndex] || "");
                    this.state.cursorLine = 0;
                    this.state.cursorCol = 0;
                } else if (this.historyIndex === 0) {
                    this.historyIndex = -1;
                    this.setText("");
                }
            }
        }
        setAutocompleteProvider(_p: any) {} setCompact(_v: boolean) {} getExpandedText() { return this.text; } render() { return []; } invalidate() {}
        expandSessionDraft(_sessionId: string, text: string) { return text; }
    },
    CombinedAutocompleteProvider: class { constructor(_a: any, _b: any) {} },
};
