/**
 * 会话间消息渲染回归测试：头部形态、分支选择与 Markdown 真实渲染。
 *
 * 注意：Bun 的 `mock.module` 在同一进程内全局生效，全量跑时 pi-tui 可能是其他文件的 stub
 * （stub 的 Markdown.render 返回空数组）。因此分两层断言：
 * - 纯函数与组件结构：对 mock 无感，任何情况下都跑；
 * - 真实渲染输出：用 skipIf 仅在 pi-tui 为真实现时跑（单跑本文件时）。
 */

import { describe, expect, test } from "bun:test";
import { Markdown } from "@earendil-works/pi-tui";
import { PeerMessageView, renderPeerPlain } from "../../src/tui/peer-message.js";
import type { PeerContent } from "../../src/tui/peer-message.js";
import { markdownTheme, theme } from "../../src/tui/theme.js";
import type { PeerMeta } from "../../src/tui/store-types.js";

const ANSI = /\x1b\[[0-9;]*m/g;

/** pi-tui 是否为真实现（非 stub）。 */
const hasRealMarkdown = new Markdown("**x**", 0, 0, markdownTheme).render(20).length > 0;

function plain(text: string): string {
    return text.replace(ANSI, "");
}

function peerMessage(text: string, peer: Partial<PeerMeta> = {}): PeerContent {
    return {
        text,
        peer: {
            direction: "in",
            msgId: "msg-1",
            peerId: "01M21GZH0SMW7FTB1X0HQKEPDE",
            ...peer,
        },
    };
}

/** 取 PeerMessageView 的子组件（对 mock 无感）。 */
function childrenOf(view: PeerMessageView): Array<{ constructor: { name: string } }> {
    return (view as unknown as { root: { children: Array<{ constructor: { name: string } }> } }).root.children;
}

describe("会话间消息纯文本形态", () => {
    test("头部与正文同一行，不截断、不折叠", () => {
        const text = renderPeerPlain(peerMessage("第一行\n第二行"));

        expect(plain(text)).toContain("💬 ");
        expect(text).toContain("第一行\n第二行");
        // 头部行内形态带尾随分隔
        expect(plain(text)).toMatch(/: 第一行/);
    });

    test("入站用 ←、出站用 →", () => {
        expect(plain(renderPeerPlain(peerMessage("hi", { direction: "in" })))).toStartWith("← ");
        expect(plain(renderPeerPlain(peerMessage("hi", { direction: "out" })))).toStartWith("→ ");
    });

    test("有标题时「标题 …短id」，无标题时只显示短 id", () => {
        const withTitle = plain(renderPeerPlain(peerMessage("hi", { peerTitle: "重构会话通信" })));

        expect(withTitle).toContain("重构会话通信");
        expect(withTitle).toContain("…0HQKEPDE");

        const withoutTitle = plain(renderPeerPlain(peerMessage("hi", { peerTitle: "   " })));

        expect(withoutTitle).toContain("0HQKEPDE");
        expect(withoutTitle).not.toContain("…");
    });

    test("短 id 不超过 20 字符时原样显示", () => {
        expect(plain(renderPeerPlain(peerMessage("hi", { peerId: "abc123" })))).toContain("abc123");
    });

    test("期望结果与结果状态各自成标记", () => {
        expect(plain(renderPeerPlain(peerMessage("hi", { expectResult: true })))).toContain("期望结果");
        expect(plain(renderPeerPlain(peerMessage("hi")))).not.toContain("期望结果");

        expect(plain(renderPeerPlain(peerMessage("done", { isResult: true, ok: true })))).toContain("结果");
        expect(plain(renderPeerPlain(peerMessage("oops", { isResult: true, ok: false }))))
            .toContain("结果（未完成）");
        expect(plain(renderPeerPlain(peerMessage("gone", { isResult: true, lost: true }))))
            .toContain("结果丢失");
    });

    test("失败或丢失的结果整体置灰，成功结果与普通消息不置灰", () => {
        expect(renderPeerPlain(peerMessage("oops", { isResult: true, ok: false }))).toContain("\x1b[90moops");
        expect(renderPeerPlain(peerMessage("done", { isResult: true, ok: true }))).not.toContain("\x1b[90mdone");
        expect(renderPeerPlain(peerMessage("普通一句话"))).not.toContain("\x1b[90m普通");
    });
});

describe("PeerMessageView 渲染分支", () => {
    test("顶部有一行背景 padding", () => {
        const children = childrenOf(new PeerMessageView(peerMessage("hi")));
        const padding = children[0] as { render: (width: number) => string[] };
        const line = padding.render(10)[0];

        expect(line).toContain("\x1b[48;5;236m");
        expect(plain(line).trim()).toBe("");
    });

    test("纯文本消息：背景 padding + 单行 Text，含全文", () => {
        const view = new PeerMessageView(peerMessage("第一行\n第二行"));
        const children = childrenOf(view);

        expect(children).toHaveLength(2);
        expect(children[1].constructor.name).toBe("Text");
        // stub 的 Container.render 返回空数组，真实现的 Text 才有 getText：两条路径都取到内容
        const textChild = children[1] as { getText?: () => string };
        const content = typeof textChild.getText === "function"
            ? textChild.getText()
            : view.render(60).join("\n");
        expect(plain(content)).toContain("第二行");
    });

    test("含 Markdown：背景 padding + 头部 Text + Markdown 正文", () => {
        const children = childrenOf(new PeerMessageView(peerMessage("**重点** 内容")));

        expect(children).toHaveLength(3);
        expect(children[1].constructor.name).toBe("Text");
        expect(children[2].constructor.name).toBe("Markdown");
    });

    test("独占一行的头部不带尾随分隔", () => {
        const view = new PeerMessageView(peerMessage("**重点**"));
        const head = childrenOf(view)[1] as { getText?: () => string };
        const rendered = typeof head.getText === "function" ? head.getText() : view.render(60).join("\n");

        expect(plain(rendered).trimEnd()).not.toEndWith(":");
    });

    test("内容变化后重建为 Markdown 块", () => {
        const view = new PeerMessageView(peerMessage("普通一句话"));

        expect(childrenOf(view)).toHaveLength(2);

        view.setMessage(peerMessage("**重点**"));
        expect(childrenOf(view)).toHaveLength(3);
        expect(childrenOf(view)[2].constructor.name).toBe("Markdown");
    });

    test("同一消息对象重复 setMessage 不重建（流式重绘不抖动）", () => {
        const message = peerMessage("**重点**");
        const view = new PeerMessageView(message);
        const children = childrenOf(view);

        view.setMessage(message);
        expect(childrenOf(view)).toBe(children);
    });
});

describe("会话间消息背景色", () => {
    test("复用群消息素色背景，不区分方向", () => {
        expect(theme.chatBackground("x")).toContain("\x1b[48;5;236m");
        expect(theme.chatBackground("y")).toContain("\x1b[48;5;236m");
    });

    test("背景色在 ANSI RESET 之后补回，避免内嵌前景色清掉背景", () => {
        expect(theme.chatBackground("\x1b[90m正文\x1b[0m")).toMatch(/\x1b\[0m\x1b\[48;5;236m/);
    });
});

describe("会话间消息 Markdown 真实渲染", () => {
    test.skipIf(!hasRealMarkdown)("粗体渲染为 ANSI 粗体且不出现裸 **", () => {
        const output = new PeerMessageView(peerMessage("**重点** 内容")).render(60).join("\n");

        expect(output).toContain("\x1b[1m");
        expect(plain(output)).toContain("重点 内容");
        expect(plain(output)).not.toContain("**");
        // 头部与正文分成多行，且头部携带对端信息
        expect(output.split("\n").length).toBeGreaterThan(1);
        expect(plain(output)).toContain("💬");
    });

    test.skipIf(!hasRealMarkdown)("渲染结果带背景色", () => {
        const output = new PeerMessageView(peerMessage("**重点**", { direction: "out" })).render(60).join("\n");

        expect(output).toContain("\x1b[48;5;236m");
    });

    test.skipIf(!hasRealMarkdown)("失败结果的正文置灰", () => {
        const output = new PeerMessageView(
            peerMessage("**失败** 原因", { isResult: true, ok: false }),
        ).render(60).join("\n");

        expect(output).toContain("\x1b[90m");
    });
});
