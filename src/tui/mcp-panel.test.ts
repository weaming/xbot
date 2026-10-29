import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { McpServerStatus } from "../mcp/client-manager.js";
import { McpPanel } from "./mcp-panel.js";

const SPACE = " ";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

const SERVERS: McpServerStatus[] = [
    { name: "mcp-hub", type: "http", target: "http://127.0.0.1:3010/mcp", protocol: "2026-07-28", status: "connected", toolNames: ["a", "b"], lazy: true },
    { name: "browser-bridge", type: "http", target: "http://127.0.0.1:1234/mcp", protocol: "2026-07-28", status: "connected", toolNames: ["c"] },
];

function makePanel(options: {
    toolSearch?: boolean;
    enabled?: string[];
    servers?: McpServerStatus[];
    visibleRows?: number;
} = {}) {
    const toggles: string[][] = [];
    const panel = new McpPanel({
        servers: options.servers ?? SERVERS,
        enabled: options.enabled ?? [],
        toolSearch: options.toolSearch ?? false,
        visibleRows: options.visibleRows ?? 8,
        close: () => toggles.push(["close"]),
        toggle: servers => toggles.push(servers),
    });
    return { panel, toggles };
}

function text(panel: McpPanel): string {
    return stripTerminalSequences(panel.render(80).join("\n"));
}

describe("McpPanel", () => {
    test("选中项用 ☑ 标出，未选中用 ☐；lazy 服务单独标注", () => {
        const { panel } = makePanel({ enabled: ["mcp-hub"], visibleRows: 20 });

        const rendered = text(panel);
        expect(rendered).toContain("☑");
        expect(rendered).toContain("☐");
        expect(rendered).toContain("· lazy");
        expect(rendered).toContain("选中即下发");
    });

    test("空格切换 lazy server，把整份启用集回调出去", () => {
        const { panel, toggles } = makePanel();

        panel.handleInput(SPACE);
        expect(toggles).toEqual([["mcp-hub"]]);
        expect(panel.enabledServers()).toEqual(["mcp-hub"]);

        panel.handleInput(SPACE);
        expect(toggles).toEqual([["mcp-hub"], []]);
        expect(panel.enabledServers()).toEqual([]);
    });

    test("非 lazy server 也能切换：选中集才是下发判据", () => {
        const { panel, toggles } = makePanel({ enabled: ["browser-bridge", "mcp-hub"] });

        panel.handleInput(DOWN);
        panel.handleInput(SPACE);

        expect(toggles).toEqual([["mcp-hub"]]);
    });

    test("支持 tool_search 时照样可以按空格切换（与下发判定无关）", () => {
        const { panel, toggles } = makePanel({ toolSearch: true, enabled: ["mcp-hub"] });

        const rendered = text(panel);
        expect(rendered).toContain("选中即下发");

        panel.handleInput(SPACE);
        expect(panel.enabledServers()).toEqual([]);
        expect(toggles).toEqual([[]]);
    });

    test("Esc 关闭面板", () => {
        const { panel, toggles } = makePanel();

        panel.handleInput(ESCAPE);

        expect(toggles).toEqual([["close"]]);
    });

    test("选中项详情保留目标、协议、错误、OAuth 链接与工具清单", () => {
        const broken: McpServerStatus[] = [
            {
                name: "rea",
                type: "stdio",
                target: "npx rea",
                protocol: "legacy",
                status: "error",
                error: "spawn ENOENT",
                toolNames: [],
            },
            {
                name: "remote",
                type: "http",
                target: "http://127.0.0.1:8088/mcp",
                protocol: "2026-07-28",
                status: "authorizing",
                toolNames: ["lookup"],
                oauth: { authorizationUrl: "https://auth.test/authorize?x=1", hasTokens: false },
            },
        ];
        const { panel } = makePanel({ servers: broken });

        const first = text(panel);
        expect(first).toContain("目标 npx rea");
        expect(first).toContain("错误 spawn ENOENT");

        panel.handleInput(DOWN);
        const second = text(panel);
        expect(second).toContain("OAuth 待授权 https://auth.test/authorize?x=1");
        expect(second).toContain("工具 lookup");
    });

    test("光标在边界处不回绕，空列表不崩", () => {
        const single = makePanel({ servers: [SERVERS[0]!] });
        single.panel.handleInput(SPACE);
        single.panel.handleInput(DOWN);
        single.panel.handleInput(SPACE);
        expect(single.toggles).toEqual([["mcp-hub"], []]);

        const empty = makePanel({ servers: [] });
        expect(text(empty.panel)).toContain("未配置或未连接任何 MCP 服务");
        empty.panel.handleInput(SPACE);
        expect(empty.toggles).toEqual([]);
    });

    test("任何宽度与可见行数下都不超出内容行预算（详情换行也不能撑破浮窗）", () => {
        const many: McpServerStatus[] = Array.from({ length: 20 }, (_, index) => ({
            name: `server-${index}`,
            type: "http",
            target: "http://127.0.0.1:8088/very/long/path/that/keeps/going/for/a/while/mcp",
            protocol: "2026-07-28",
            status: index === 0 ? "error" : "connected",
            error: index === 0 ? "spawn ENOENT because the command path is far too long to fit one line" : undefined,
            toolNames: Array.from({ length: 30 }, (_, toolIndex) => `tool_${toolIndex}`),
            oauth: { authorizationUrl: "https://auth.test/authorize?client_id=abc&scope=read+write", hasTokens: false },
        }));

        for (const visibleRows of [6, 12]) {
            const { panel } = makePanel({ servers: many, visibleRows });
            for (const width of [24, 40, 50, 80, 112]) {
                const rows = panel.render(width);
                expect(rows.length).toBeLessThanOrEqual(visibleRows);
                expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
            }
        }
    });
});
