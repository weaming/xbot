import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSessionRow, planSessionRows, type SessionRow } from "./session-row.js";

const row = (partial: Partial<SessionRow> = {}): SessionRow => ({
    marker: "○",
    title: "修复 tui tabs 管理",
    rounds: "12轮",
    time: "刚刚",
    ...partial,
});

/** 子串在行内的起始显示列（找不到返回 -1），用于断言"列对齐"。 */
function startOf(line: string, needle: string): number {
    const index = line.indexOf(needle);
    return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

/** 按面板的渲染方式拼整批行：统一列宽 + 逐行分段拼装。 */
function renderAll(rows: SessionRow[], width: number, selectedIndex = 0): string[] {
    const plan = planSessionRows(rows, width);
    return rows.map((row, index) => {
        const { head, detail } = composeSessionRow(row, plan, width, index === selectedIndex);
        return head + detail;
    });
}

describe("planSessionRows", () => {
    test("标题列取本批自然宽度（不拉满），避免副列被推远", () => {
        const plan = planSessionRows([row(), row({ title: "短" })], 100);

        expect(plan.title).toBe(visibleWidth("修复 tui tabs 管理"));
    });

    test("宽度不足时先丢弃工作目录列，再压缩标题", () => {
        const rows = [
            row({ cwd: "~/src/infra/deploy", status: "本实例 · 等待 2" }),
            row({ marker: "◐", title: "docker 部署排查", rounds: "3轮", time: "1小时前", cwd: "~/src/zbot" }),
        ];

        expect(planSessionRows(rows, 120).cwd).toBeGreaterThan(0);
        expect(planSessionRows(rows, 60).cwd).toBe(0);
    });
});

describe("composeSessionRow", () => {
    test("整批行同一列起点一致（轮数右对齐、时间与目录左对齐）", () => {
        const rows = [
            row({ cwd: "~/src/zbot", status: "本实例 · 等待 2" }),
            row({ marker: "✕", title: "回测脚本优化", rounds: "0轮", time: "1天前", cwd: "~/quant/backtest", status: "未认领 · 已归档" }),
            row({ marker: "●", title: "docker", rounds: "128轮", time: "12小时前", cwd: "~", status: "运行中" }),
        ];
        const lines = renderAll(rows, 100);

        // 轮数右对齐：个位数与三位数的 "轮" 落在同一列
        expect(new Set(lines.map(line => startOf(line, "轮"))).size).toBe(1);
        // 时间列与目录列左对齐：起点逐行相同
        const timeStarts = [startOf(lines[0], "刚刚"), startOf(lines[1], "1天前"), startOf(lines[2], "12小时前")];
        expect(new Set(timeStarts).size).toBe(1);
        const cwdStarts = [startOf(lines[0], "~/src/zbot"), startOf(lines[1], "~/quant/backtest"), startOf(lines[2], "~ ")];
        expect(new Set(cwdStarts).size).toBe(1);
    });

    test("行宽不超过可用宽度，窄屏按优先级保留标题与状态", () => {
        const rows = [row({ cwd: "~/src/zbot", status: "本实例 · 等待 2" })];

        for (const width of [100, 80, 60, 44]) {
            for (const line of renderAll(rows, width)) {
                expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            }
        }
        // 80 列：目录与状态都能放下
        expect(renderAll(rows, 80)[0]).toContain("本实例 · 等待 2");
        // 44 列：先丢目录列，状态随之有更多空间
        const narrow = renderAll(rows, 44)[0];
        expect(narrow).not.toContain("~/src/zbot");
        expect(narrow).toContain("修复 tui tabs 管理");
        // 30 列：状态可用宽度低于下限，整块不画而不是留个省略号
        const tiny = renderAll(rows, 30)[0];
        expect(tiny).not.toContain("本实例");
        expect(visibleWidth(tiny)).toBeLessThanOrEqual(30);
        // 22 列：连时间列都要丢掉，不允许只切半个时间（"刚"/"1天"）
        const cramped = renderAll(rows, 22)[0];
        expect(cramped).not.toContain("刚刚");
        expect(cramped).not.toContain("本实例");
        expect(visibleWidth(cramped)).toBeLessThanOrEqual(22);
    });

    test("部分行没有工作目录时用空白占位，状态列仍与其他行对齐", () => {
        const rows = [
            row({ cwd: "~/src/zbot", status: "本实例 · 等待 2" }),
            row({ title: "新建会话", cwd: undefined, status: "未认领" }),
        ];
        const plan = planSessionRows(rows, 90);
        const lines = renderAll(rows, 90);

        // 目录列确实显示（本批有会话带目录），缺失行不能把后面的状态列左移
        expect(plan.cwd).toBeGreaterThan(0);
        expect(startOf(lines[0], "本实例")).toBe(startOf(lines[1], "未认领"));
    });

    test("目录列被收缩时保留尾部目录名并断在斜杠上", () => {
        const rows = [row({ cwd: "~/src/infra/deploy", status: "本实例 · 等待 2" })];
        const line = renderAll(rows, 70)[0];

        expect(line).toContain("…/");
        expect(line).toContain("deploy");
    });

    test("选中行带指针并整段着色，未选中行无指针", () => {
        const rows = [row(), row({ marker: "✕", title: "回测脚本优化" })];
        const lines = renderAll(rows, 80, 1);

        expect(lines[1].startsWith("→ ")).toBe(true);
        expect(lines[0].startsWith("  ")).toBe(true);
    });

    test("状态列吃剩余空间并截断，不会把行撑宽", () => {
        const plan = planSessionRows([row({ status: "PID 4321 · 忙 · 处理中 3" })], 60);
        const { head, detail } = composeSessionRow(row({ status: "PID 4321 · 忙 · 处理中 3" }), plan, 60, false);

        expect(visibleWidth(head + detail)).toBeLessThanOrEqual(60);
    });
});
