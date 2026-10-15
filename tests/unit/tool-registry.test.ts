import { describe, expect, test } from 'bun:test';
import { filterToolsBySearch, serializeSearchToolResults } from '../../src/tools/tool-registry.js';
import { toolCatalog } from '../../src/tools/tool-catalog.js';

const tools = [
    { name: 'LongPortPrivate__stock_positions', source: 'longport', tags: ['finance'], inputSchema: {}, execute: async () => ({ content: [] }) },
    { name: 'LongPortPrivate__account_balance', source: 'longport', tags: ['finance'], inputSchema: {}, execute: async () => ({ content: [] }) },
    { name: 'mcphub__qweather_weather', source: 'local', tags: ['travel'], inputSchema: {}, execute: async () => ({ content: [] }) },
];

describe('search_tools filtering', () => {
    test('matches any name keyword', () => {
        const matches = filterToolsBySearch(tools, {
            keywords: ['stock_positions', 'account_balance'],
        });

        expect(matches.map((tool) => tool.name)).toEqual([
            'LongPortPrivate__stock_positions',
            'LongPortPrivate__account_balance',
        ]);
    });

    test('searches source, tags, and descriptions with keywords', () => {
        const matches = filterToolsBySearch([
            ...tools,
            {
                name: 'special_tool',
                source: 'custom',
                tags: ['utility'],
                description: '查询小红书点点会话',
                inputSchema: {},
                execute: async () => ({ content: [] }),
            },
        ], { keywords: ['点点会话'] });

        expect(matches.map((tool) => tool.name)).toEqual(['special_tool']);
    });

    test('unions multiple keywords', () => {
        const matches = filterToolsBySearch(tools, {
            keywords: ['stock_positions', 'qweather'],
        });

        expect(matches.map((tool) => tool.name)).toEqual([
            'LongPortPrivate__stock_positions',
            'mcphub__qweather_weather',
        ]);
    });

    test('serializes matching tools as callable schemas', () => {
        const result = JSON.parse(serializeSearchToolResults(tools));

        expect(result.count).toBe(3);
        expect(result.tools).toHaveLength(3);
        expect(result.tools[0]).toEqual({
            type: 'function',
            function: {
                name: 'LongPortPrivate__stock_positions',
                description: '',
                parameters: {},
            },
        });
        expect(result.extraTools).toBeUndefined();
    });

    test('executeMcpTool 回退到工具级 contextPolicy 声明', async () => {
        const { executeMcpTool } = await import('../../src/tools/tool-registry.js');
        const toolName = 'zz_test_full_context_tool';
        toolCatalog.registerLocalTools([{
            name: toolName,
            inputSchema: { type: 'object', properties: {} },
            contextPolicy: { mode: 'full' },
            execute: async () => ({ content: [{ type: 'text', text: 'full' }] }),
        }]);

        const result = await executeMcpTool(toolName, {});

        expect(result.content).toEqual([{ type: 'text', text: 'full' }]);
        expect(result.contextPolicy).toEqual({ mode: 'full' });
    });

    test('执行结果显式 contextPolicy 优先于工具级声明', async () => {
        const { executeMcpTool } = await import('../../src/tools/tool-registry.js');
        const toolName = 'zz_test_override_context_tool';
        toolCatalog.registerLocalTools([{
            name: toolName,
            inputSchema: { type: 'object', properties: {} },
            contextPolicy: { mode: 'full' },
            execute: async () => ({
                content: [{ type: 'text', text: 'adaptive' }],
                contextPolicy: { mode: 'adaptive' },
            }),
        }]);

        const result = await executeMcpTool(toolName, {});

        expect(result.contextPolicy).toEqual({ mode: 'adaptive' });
    });

    test('读文件与补丁类本地工具声明 contextPolicy full', async () => {
        const { readTextFileTool, editFileTool } = await import('../../src/tools/file-ops.js');

        expect(readTextFileTool.contextPolicy).toEqual({ mode: 'full' });
        expect(editFileTool.contextPolicy).toEqual({ mode: 'full' });
    });
});
