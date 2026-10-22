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
    /**
     * 键位解析委托真实实现：Editor / QuestionPanel 依赖 matches/getKeys 判断按键语义，
     * 空壳会让它们要么吞掉输入、要么在 matches 上抛错。
     */
    KeybindingsManager: realPiTui.KeybindingsManager,
    TUI_KEYBINDINGS: realPiTui.TUI_KEYBINDINGS,
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
    /**
     * 编辑器委托真实实现：按键、光标、折行、CURSOR_MARKER 都由库负责，
     * 只在外面补上 ChatApp 用到的扩展字段。
     * 早前这里是一份"只处理上下历史"的空壳，导致复用它的提问面板测试
     * 拿到一个吞掉所有字符输入的编辑器——替身的保真度必须覆盖被复用到的行为。
     */
    Editor: class extends realPiTui.Editor {
        /** 本仓库在 Editor 上附加的会话级草稿展开入口。 */
        expandSessionDraft(_sessionId: string, text: string) { return text; }
    },
    CombinedAutocompleteProvider: class { constructor(_a: any, _b: any) {} },
};
