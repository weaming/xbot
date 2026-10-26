# zbot TUI 链接点击与 Ghostty 终端交互

zbot TUI（`@earendil-works/pi-tui` 全屏 TUI）中链接的渲染、点击与终端交互机制，
以及 Ghostty 下"可点击 / hover 高亮"行为的研究结论。2026-09 实测整理。

## 结论速览

- **渲染正常**：Ghostty 被 pi-tui 能力检测识别为 OSC 8 终端，正文/思考区 Markdown 链接均以可点击超链接输出。
- **曾出现的"点击无反应"根因**：点击回调只处理 `zbot://session/...`（会话 Tab），普通 `http(s)`/`mailto` 链接被吞掉。2026-09 已修复（应用内打开外链）。
- **限制结论**：SGR 鼠标协议无 Cmd 位（仅 Shift/Alt/Ctrl），Ghostty 在 mouse capture 下虽把 Cmd+Click 事件转发给应用，但 Cmd 修饰信息无处编码、随转发丢失，TUI 无法从点击事件本身识别 Cmd；zbot 改用 macOS 原生查询（`CGEventSourceFlagsState`）实现 Cmd+Click 门控（见"通道三"）。**Cmd+hover 高亮**仍不可达成（pi-tui 无 hover 命中/重绘逻辑）。
- **推荐手势（macOS）**：TUI 内**按住 Cmd + 单击**打开链接（原生查询门控，与 Ghostty 一致）；单击无 Cmd 时提示不误触。会话 Tab 仍单击切换。非 macOS 平台保持单击打开。

## 渲染与点击链路

- pi-tui 能力检测（`terminal-image.js#detectCapabilities`）：`TERM_PROGRAM=ghostty` 或 `GHOSTTY_RESOURCES_DIR` 存在 → `{ hyperlinks: true }`。
- Markdown 组件：`hyperlinks=true` 时链接用 OSC 8 包裹（`hyperlink(styledLink, href)`），不内联打印 URL；否则 fallback 为 `文本 (url)`。
- 会话 Tab：`wrapTabLink` 生成 OSC 8 `zbot://session/<id>`。
- 点击处理：SGR 鼠标事件 → `TuiAltScreen` 按列命中 OSC 8 → `openUrl` 回调 → `ChatApp.handleOpenUrl`。

相关代码（`zbot/src/tui/app.ts`）：

- `TAB_LINK_PREFIX = "zbot://session/"`、`wrapTabLink`
- `handleOpenUrl`：`zbot://` 前缀切会话；外链在 macOS 上要求按住 Cmd（`cmd-modifier.ts` 原生查询门控），其他平台直接 `openExternalUrl`
- `openExternalUrl`：平台系统打开（macOS `open` / Linux `xdg-open` / Windows `start`），scheme 白名单 `http/https/mailto`，`detached + unref` 不阻塞 TUI，失败仅记日志
- `cmd-modifier.ts`：bun:ffi 调 CoreGraphics `CGEventSourceFlagsState` 查询 Cmd 按住状态（详见"通道三"）
- 主题：`theme.ts` 的 `markdownTheme.link/linkUrl`（正文青色下划线）；思考区统一灰色无下划线

## Ghostty 原生链接机制（普通 shell，无 mouse capture）

- `link-url` 默认开启：URL/OSC 8 链接在按住 **Cmd（macOS）/ Ctrl（Linux）** 时检测。
- hover 高亮（下划线 + 左下角 URL 预览）只在按住该修饰键时出现；原因是"按需检测"较昂贵（Ghostty 讨论 #10726）。
- 无法配置去掉修饰键：`mouse-binding` 尚无 `open-url` 类动作；社区提议的 `link-url-modifier`（含 `none`）未合入主干（讨论 #4917）。
- macOS 点击链接走 `NSWorkspace`（1.2.0 起）。

## 全屏 TUI（mouse capture）下的规则

zbot 是全屏 TUI，必然开启终端鼠标报告（`?1000/1002/1004/1006`），此后：

1. 所有鼠标事件发给应用；Ghostty **不再**自行选择文本、打开链接或绘制 hover 高亮。
2. macOS 下 **Cmd+Click 在 mouse-reporting 转发时与普通单击不可区分**：SGR 鼠标协议只有 Shift/Alt/Ctrl 位，没有 Super/Cmd 位，Cmd 无处编码（#13060 probe 实测到达应用的点击与普通单击字节相同；#13073 据此请求 Ghostty 让 Cmd 像 Shift 一样参与绕过，未实现）→ 应用无法识别 Cmd。
3. **Shift 是 Ghostty 唯一硬编码的 mouse-capture 绕过键**：按住 Shift 的鼠标操作不发给应用，交回 Ghostty 原生处理（选择文本、打开链接）。Cmd/Ctrl **刻意不参与绕过**——维护者明确此为设计意图，为了把 Cmd/Ctrl+Click 留给应用捕获（#13073 回复）；但 SGR 无 Cmd 位，Cmd 信息在转发中丢失，应用捕获到的与普通单击不可区分（Ctrl 有真实位，可被应用真正捕获）。重映射绕过键在 #3848 排队。
   - 因此 `Shift+Cmd+Click` 打开链接、`Shift+Cmd+hover` 显示原生高亮与预览，与普通终端体验一致。
   - pi 官方文档（pi.dev terminal-setup）同结论：fullscreen 模式下 Ghostty 不显示 hover 下划线/URL 预览，按住 Shift+Cmd（macOS）/ Shift+Ctrl（Linux）走原生 link 处理。
4. Ctrl+Click 在 mouse capture 下仍可打开链接（Ctrl 在协议里有真实位），但行为取决于应用是否处理。

## 应用内实现"Cmd 门控 + hover 高亮"的卡点

若想在 zbot 内复刻"仅 Cmd 可点 + hover 样式变化"：

- **Cmd 门控不可行**：SGR 鼠标事件不含 Cmd 位（协议只有 Shift/Alt/Ctrl），mouse-reporting 转发点击时 Cmd 无处编码，应用收到的事件与普通单击不可区分（#13060 probe 实测；#13073 请求 Cmd 参与绕过未实现）。间接通道（Kitty 键盘协议维护修饰键状态）也不可用：pi-tui 请求的 flags=7，不含 `report_all_keys_as_events`(bit 8)，修饰键单独按下不上报，且依赖终端支持、时序不可靠。
- **hover 高亮需要扩展 pi-tui**：当前只暴露点击回调 `openUrl`，无 hover 事件/链接命中 API；需打补丁（追踪 motion + 整行重渲染插入高亮样式 + 状态栏显示 URL），工作量较大。
  - 事件通道已具备：非 tmux/zellij/screen 环境下 pi-tui 请求 `?1003`（any-event），motion 事件（含 Cmd+hover）会到达 TUI，但 SGR 事件同样无 Cmd 位；tmux 下需额外启用 `?1003`。
  - pi-tui 对 motion 目前只用于滚动条 hover 与拖拽选择，无链接命中/高亮逻辑。
- 可行的妥协门控键：**Ctrl / Alt / Shift**（协议可报告），可精确实现"按住某键才打开、单击不误触"。

## 未来通道与最小改造预案（若 Cmd 能送达）

若 Ghostty/未来协议让 Cmd 修饰信息可达应用，改动集中在 pi-tui 库内、均为加法式；zbot 应用层只改 `handleOpenUrl` 门控一处：

- **通道一（鼠标事件内嵌 Cmd，改动最小，依赖上游）**：`parseSgrMouseEvent` 解析新位 → 点击命中处 `openUrl(url, { cmd })` → zbot 门控。目前无终端实现该位。
- **通道二（键盘状态，现有协议可做）**：`terminal.js` flags 7→15（加 bit 8）→ `keys.js` 维护修饰键按下状态（press/release 区分已具备）→ 点击时查 `isSuperDown()`。风险：Ghostty 的 modifier-only 上报支持与 macOS `flagsChanged` 行为未验证、时序有噪音。
- **通道三（macOS 原生查询，零库/协议改动，已落地）**：点击回调时用 `CGEventSourceFlagsState`（CoreGraphics）查询全局修饰键状态——`kCGEventSourceStateCombinedSessionState(0)` 与 `kCGEventSourceStateHIDSystemState(1)` 均能实时反映 Cmd 按住（CMD 掩码 `0x100000`），无需辅助功能权限。2026-09 实测通过；已落地为 zbot 的 `src/tui/cmd-modifier.ts` + `handleOpenUrl` Cmd 门控（macOS 按住 Cmd 才打开外链，单击 flash 提示）。实现注意：u64 返回为 bigint；bun:ffi 参数类型须用 `i32/u64`（`FFIType.int/int32` 非法）；仅 macOS 本机有效。
- pi-tui 现状有利于改造：鼠标 `button` 字段原样含修饰位（shift=4/alt=8/ctrl=16），键盘链路已建模 `MODIFIERS.super=8`。

## 标准现状：鼠标无 Super 位，键盘有

- **鼠标事件**（xterm X10/SGR 1006/urxvt 1015/pixel 1016，全行业沿用）：修饰键仅 Shift=4 / Meta-Alt=8 / Ctrl=16，无 Super 位；kitty 的 SGR pixel 扩展只加了 bit 8"鼠标离开窗口"标志，未定义 Super。无任何主流终端/标准为鼠标事件编码 Cmd。
- **键盘事件**（Kitty keyboard protocol，Windows Terminal/Ghostty/Rio 等已采纳）：编码 Shift/Alt/Ctrl/Super/Hyper/Meta 全部修饰键，且 `report all keys as events`(bit 8) 支持修饰键单独 press/release 上报。
- 推论：TUI 识别 Cmd 的现实路径是键盘协议状态维护（见上"通道二"），而非等鼠标协议扩展。

## 上游跟踪

- Ghostty：[#13073](https://github.com/ghostty-org/ghostty/discussions/13073)（mouse-reporting 下 Cmd+click 失效；维护者拒绝 Cmd 参与绕过——刻意保留给应用捕获 cmd/ctrl+click；前身 [#13060](https://github.com/ghostty-org/ghostty/discussions/13060)）、[#3848](https://github.com/ghostty-org/ghostty/discussions/3848)（鼠标绑定可重映射）、[#4917](https://github.com/ghostty-org/ghostty/discussions/4917)（去修饰键点击）、[#10726](https://github.com/ghostty-org/ghostty/discussions/10726)（hover 高亮实现成本）。
- pi / pi-tui：[#7930](https://github.com/earendil-works/pi/issues/7930)（全屏 TUI OSC 8 渲染但点击被 mouse tracking 吞）、[#4839](https://github.com/earendil-works/pi/issues/4839)（Markdown 链接 Cmd-clickable）。相关 issue 均已 closed 无后续；`tui-plan.md` 的规范化鼠标事件（`TuiMouseEvent`）无 modifiers/super 字段；pi 的 super 支持仅限键盘（Kitty 协议按键事件）。
- 其它 TUI 库同类问题：opentui [#1380](https://github.com/anomalyco/opentui/issues/1380)（请求暴露 hyperlink 命中/点击 API）。
- 权威文档：pi 官方 terminal-setup（fullscreen 模式链接行为与 Shift 绕过说明）https://pi.dev/docs/latest/terminal-setup
