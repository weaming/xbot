import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
    buildSessionBar,
    layoutSessionBar,
    renderSessionTab,
    TAB_WIDTH_CAP,
    type SessionBarStyles,
    type SessionBarTab,
} from "./session-bar.js";

const styles: SessionBarStyles = {
    active: (text) => text,
    inactive: (text) => text,
    overflow: (text) => text,
    add: (text) => text,
};

const TITLES = [
    "修复 tui tabs 管理方式",
    "docker 部署排查",
    "回测脚本优化",
    "为什么账单对不上",
    "重构 mcp-hub 配置加载",
    "图片下载失败",
    "okx 行情接入",
    "session 锁排查",
    "定时任务漏跑",
    "日志轮转配置",
    "代理切换问题",
    "长标题测试用例用于验证截断行为是否正确",
];

function makeTabs(count: number, activeIndex = 0): SessionBarTab[] {
    return Array.from({ length: count }, (_, index) => ({
        sessionId: `01SESSION${String(index).padStart(2, "0")}`,
        title: TITLES[index % TITLES.length],
        messageCount: index + 1,
        busy: index === 1,
        active: index === activeIndex,
    }));
}

function plain(line: string): string {
    return stripTerminalSequences(line);
}

describe("会话条布局", () => {
    test("80 列下按上限估可见数并等分宽度", () => {
        const { count, tabWidth } = layoutSessionBar(12, 80);

        expect(count).toBe(3);
        expect(tabWidth).toBe(TAB_WIDTH_CAP);
    });

    test("会话少于可用位时全部显示且等宽不拉伸超过上限", () => {
        const { count, tabWidth } = layoutSessionBar(2, 200);

        expect(count).toBe(2);
        expect(tabWidth).toBe(TAB_WIDTH_CAP);
    });

    test("宽度不足时退化为只显示新建按钮", () => {
        expect(layoutSessionBar(5, 8).count).toBe(0);
    });
});

describe("会话条渲染", () => {
    test("始终单行且不超过终端宽度", () => {
        for (const width of [40, 80, 120, 200]) {
            const bar = buildSessionBar(makeTabs(12), width, styles);

            expect(bar.line).not.toContain("\n");
            expect(visibleWidth(plain(bar.line))).toBeLessThanOrEqual(width);
        }
    });

    test("可见 tab 等宽（含中文标题）且带序号", () => {
        const tabWidth = 18;
        const rendered = makeTabs(6).map((tab, index) => renderSessionTab(tab, tabWidth, "⠋", index + 1));

        expect(new Set(rendered.map((text) => visibleWidth(text)))).toEqual(new Set([tabWidth]));
        expect(plain(rendered[0])).toContain(" 1 ");
        expect(plain(rendered[5])).toContain(" 6 ");
    });

    test("第 10 个及以后的 tab 用 · 占位（⌃1..9 只覆盖前 9 个）", () => {
        const tab = { sessionId: "01A", title: "长标题", messageCount: 0, busy: false, active: false };

        expect(plain(renderSessionTab(tab, 18, "⠋", 9))).toContain(" 9 ");
        expect(plain(renderSessionTab(tab, 18, "⠋", 10))).toContain(" · ");
    });

    test("标题按显示列截断，中文不会被撑破", () => {
        const tab = { sessionId: "01A", title: "修复 tui tabs 管理方式", messageCount: 12, busy: false, active: true };
        const text = renderSessionTab(tab, 20, "⠋", 1);

        expect(visibleWidth(text)).toBe(20);
        expect(plain(text)).toContain("修复");
    });

    test("任务会话的标题前带 ⚑，且不撑破等宽排版", () => {
        const job = { sessionId: "01A", title: "跑测试", messageCount: 0, busy: false, active: true, origin: "job" as const };
        const text = renderSessionTab(job, 18, "⠋", 1);

        expect(visibleWidth(text)).toBe(18);
        expect(plain(text)).toContain("⚑ 跑测试");
        // 交互终端建的会话不标记：常态不该逐行占宽
        const user = { sessionId: "01B", title: "跑测试", messageCount: 0, busy: false, active: false, origin: "user" as const };
        expect(plain(renderSessionTab(user, 18, "⠋", 2))).not.toContain("⚑");
    });

    test("运行中优先于选中：当前会话生成时同样显示转圈帧", () => {
        const busyActive = { sessionId: "01A", title: "运行中", messageCount: 0, busy: true, active: true };
        const idleActive = { sessionId: "01B", title: "空闲", messageCount: 0, busy: false, active: true };

        expect(plain(renderSessionTab(busyActive, 20, "◓", 1))).toContain("◓");
        expect(plain(renderSessionTab(idleActive, 20, "◓", 2))).toContain("●");
    });

    test("以当前会话为中心开窗，两侧用 ‹N / N› 表示折叠数量", () => {
        const tabs = makeTabs(12, 7);
        const bar = buildSessionBar(tabs, 80, styles);

        expect(bar.visibleIds).toEqual(tabs.slice(6, 9).map((tab) => tab.sessionId));
        expect(bar.hiddenLeft).toBe(6);
        expect(bar.hiddenRight).toBe(3);
        expect(plain(bar.line)).toContain("‹6");
        expect(plain(bar.line)).toContain("3›");
    });

    test("当前会话在首位时窗口贴左，不出现左侧折叠计数", () => {
        const bar = buildSessionBar(makeTabs(12, 0), 80, styles);

        expect(bar.hiddenLeft).toBe(0);
        expect(bar.hiddenRight).toBe(9);
        expect(plain(bar.line)).not.toContain("‹");
    });

    test("无会话时只渲染新建按钮", () => {
        const bar = buildSessionBar([], 80, styles);

        expect(bar.count).toBe(0);
        expect(bar.visibleIds).toEqual([]);
        expect(plain(bar.line)).toBe(" [+]");
    });

    test("tab 携带可点击的 OSC 8 会话链接", () => {
        const bar = buildSessionBar(makeTabs(2), 120, styles);

        expect(bar.line).toContain("zbot://session/");
        expect(bar.line).toContain("zbot://new");
    });
});
