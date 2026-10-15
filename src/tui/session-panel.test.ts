import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_SPINNER } from "./session-marker.js";
import { SessionPanel, type SessionPanelActions, type SessionPanelItem, type SessionPanelOptions } from "./session-panel.js";

const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_R = "\x12";
const CTRL_X = "\x18";
const CTRL_A = "\x01";
const CTRL_U = "\x15";
const BACKSPACE = "\x7f";
const DOWN = "\x1b[B";

const ITEMS: SessionPanelItem[] = [
    { sessionId: "01AAA111", title: "修复 tui tabs 管理", messageCount: 12, updatedAt: new Date().toISOString(), busy: false, active: true },
    { sessionId: "01BBB222", title: "docker 部署排查", messageCount: 3, updatedAt: new Date(Date.now() - 3600_000).toISOString(), busy: true, active: false },
    { sessionId: "01CCC333", title: "回测脚本优化", messageCount: 0, updatedAt: new Date(Date.now() - 86_400_000).toISOString(), archived: true, busy: false, active: false },
];

function makePanel(
    items: SessionPanelItem[] = ITEMS,
    options: SessionPanelOptions = {},
): { panel: SessionPanel; calls: string[]; actions: SessionPanelActions } {
    const calls: string[] = [];
    const actions: SessionPanelActions = {
        select: (id) => calls.push(`select:${id}`),
        rename: (id) => calls.push(`rename:${id}`),
        remove: (id) => calls.push(`remove:${id}`),
        archive: (id) => calls.push(`archive:${id}`),
        unarchive: (id) => calls.push(`unarchive:${id}`),
        close: () => calls.push("close"),
    };
    return { panel: new SessionPanel(items, actions, options), calls, actions };
}

describe("会话面板", () => {
    test("初始选中第一个会话并渲染标题", () => {
        const { panel } = makePanel();
        const output = panel.render(70).map(stripTerminalSequences).join("\n");

        expect(panel.getSelectedId()).toBe("01AAA111");
        expect(output).toContain("修复 tui tabs 管理");
        expect(output).toContain("docker 部署排查");
        expect(output).toContain("会话 3 个 · 匹配 3 个");
        expect(panel.render(70).every((line) => visibleWidth(line) <= 70)).toBe(true);
    });

    test("输入关键字模糊过滤，退格与 Ctrl+U 恢复", () => {
        const { panel } = makePanel();

        panel.handleInput("docker");
        expect(panel.getSelectedId()).toBe("01BBB222");
        expect(panel.getQuery()).toBe("docker");

        panel.handleInput(BACKSPACE);
        expect(panel.getQuery()).toBe("docke");

        panel.handleInput(CTRL_U);
        expect(panel.getQuery()).toBe("");
        expect(panel.getSelectedId()).toBe("01AAA111");
    });

    test("无匹配时没有选中项，Enter 不触发切换", () => {
        const { panel, calls } = makePanel();

        panel.handleInput("zzzz");
        expect(panel.getSelectedId()).toBeNull();

        panel.handleInput(ENTER);
        expect(calls).toEqual([]);
    });

    test("方向键切换选中项，Enter 切换会话", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(DOWN);
        expect(panel.getSelectedId()).toBe("01BBB222");

        panel.handleInput(ENTER);
        expect(calls).toEqual(["select:01BBB222"]);
    });

    test("Ctrl+R 直接重命名，Ctrl+A 需二次确认才归档，Esc 关闭", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_R);
        expect(calls).toEqual(["rename:01AAA111"]);

        panel.handleInput(CTRL_A);
        expect(calls).toEqual(["rename:01AAA111"]);
        expect(panel.render(70).map(stripTerminalSequences).join("\n")).toContain("再按 ⌃A 确认归档");

        panel.handleInput(CTRL_A);
        panel.handleInput(ESCAPE);

        expect(calls).toEqual(["rename:01AAA111", "archive:01AAA111", "close"]);
    });

    test("归档与删除的待确认状态互斥，动作需重新确认", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_A);
        panel.handleInput(CTRL_X);
        panel.handleInput(CTRL_A);

        expect(calls).toEqual([]);

        panel.handleInput(CTRL_A);
        expect(calls).toEqual(["archive:01AAA111"]);
    });

    test("Ctrl+X 需二次确认：首次只提示，再按一次才删除", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_X);
        expect(calls).toEqual([]);
        expect(panel.render(70).map(stripTerminalSequences).join("\n")).toContain("再按 ⌃X 确认删除");

        panel.handleInput(CTRL_X);
        expect(calls).toEqual(["remove:01AAA111"]);
    });

    test("待确认删除会被其他动作清除", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_X);
        panel.handleInput(CTRL_R);
        panel.handleInput(CTRL_X);

        expect(calls).toEqual(["rename:01AAA111"]);
    });

    test("确认目标跟随选中会话：切换后需重新确认", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_X);
        panel.handleInput(DOWN);
        panel.handleInput(CTRL_X);
        expect(calls).toEqual([]);

        panel.handleInput(CTRL_X);
        expect(calls).toEqual(["remove:01BBB222"]);
    });

    test("确认窗口到期后清空提示并请求重绘，超时后再按需重新确认", async () => {
        const renders: number[] = [];
        const { panel, calls } = makePanel(ITEMS, { confirmMs: 20, requestRender: () => renders.push(1) });

        panel.handleInput(CTRL_X);
        expect(panel.render(70).map(stripTerminalSequences).join("\n")).toContain("再按 ⌃X 确认删除");

        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(panel.render(70).map(stripTerminalSequences).join("\n")).not.toContain("再按 ⌃X 确认删除");
        expect(renders.length).toBe(1);

        // 超时后旧确认已失效：再按一次只重新 arm，不执行删除
        panel.handleInput(CTRL_X);
        expect(calls).toEqual([]);
    });

    test("dispose 后到期不再触发重绘", async () => {
        const renders: number[] = [];
        const { panel } = makePanel(ITEMS, { confirmMs: 20, requestRender: () => renders.push(1) });

        panel.handleInput(CTRL_A);
        panel.dispose();

        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(renders).toEqual([]);
    });

    test("归档会话标记为 ✕ 并显示归档状态", () => {
        const { panel } = makePanel();
        const output = panel.render(70).map(stripTerminalSequences).join("\n");

        expect(output).toContain("✕ 回测脚本优化");
        expect(output).toContain("已归档");
    });

    test("选中归档会话时 Ctrl+A 直接取消归档，无需二次确认", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(DOWN);
        panel.handleInput(DOWN);
        expect(panel.getSelectedId()).toBe("01CCC333");

        panel.handleInput(CTRL_A);
        expect(calls).toEqual(["unarchive:01CCC333"]);
    });

    test("选中归档会话时 footer 提示取消归档，不提示重命名", () => {
        const { panel } = makePanel();

        panel.handleInput(DOWN);
        panel.handleInput(DOWN);
        const output = panel.render(70).map(stripTerminalSequences).join("\n");

        expect(output).toContain("⌃A 取消归档");
        expect(output).not.toContain("⌃R 重命名");
    });

    test("updateItems 同步选中/运行状态与 spinner 帧", () => {
        const { panel } = makePanel();
        const text = () => panel.render(70).map(stripTerminalSequences).join("\n");

        expect(text()).toContain("● 修复 tui tabs 管理");
        expect(text()).toContain("◐ docker 部署排查");

        panel.updateItems([
            { sessionId: "01AAA111", title: "修复 tui tabs 管理", messageCount: 12, busy: false, active: false },
            { sessionId: "01BBB222", title: "docker 部署排查", messageCount: 3, busy: true, active: true },
        ], "◑");

        expect(text()).toContain("○ 修复 tui tabs 管理");
        expect(text()).toContain("◑ docker 部署排查");
    });

    test("未识别按键不落入搜索框", () => {
        const { panel } = makePanel();

        panel.handleInput("\x1b[5~");
        expect(panel.getQuery()).toBe("");
    });

    test("归属进主列标记、忙闲与待交付数进副列", () => {
        const { panel } = makePanel([
            { sessionId: "01AAA111", title: "本实例空闲", messageCount: 1, busy: false, active: false, ownerState: "mine", owner: "本实例 · 等待 2" },
            { sessionId: "01BBB222", title: "他实例忙", messageCount: 2, busy: false, active: false, ownerState: "other", owner: "PID 4321 · 忙 · 处理中 3" },
            { sessionId: "01CCC333", title: "无人认领", messageCount: 0, busy: false, active: false, ownerState: "free", owner: "未认领" },
        ]);
        const output = panel.render(80).map(stripTerminalSequences).join("\n");

        expect(output).toContain("○ 本实例空闲");
        expect(output).toContain("本实例 · 等待 2");
        expect(output).toContain("◎ 他实例忙");
        expect(output).toContain("PID 4321 · 忙 · 处理中 3");
        expect(output).toContain("◌ 无人认领");
        expect(output).toContain("未认领");
    });

    test("updateItems 仅在归属变化时也重建列表标记", () => {
        const base = { sessionId: "01AAA111", title: "归属会变", messageCount: 1, busy: false, active: false };
        const { panel } = makePanel([{ ...base, ownerState: "mine", owner: "本实例" }]);
        // 副列较长（含 PID / 处理中），用宽终端避免截断掩盖断言
        const text = () => panel.render(120).map(stripTerminalSequences).join("\n");

        expect(text()).toContain("○ 归属会变");

        panel.updateItems([{ ...base, ownerState: "other", owner: "PID 99 · 空闲" }], DEFAULT_SPINNER);
        expect(text()).toContain("◎ 归属会变");
        expect(text()).toContain("PID 99 · 空闲");

        // owner 文案变化（如待交付数 +1）同样要触发重建
        panel.updateItems([{ ...base, ownerState: "other", owner: "PID 99 · 空闲 · 处理中 1" }], DEFAULT_SPINNER);
        expect(text()).toContain("处理中 1");
    });
});
