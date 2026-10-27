import { describe, expect, test } from 'bun:test';
import { toolCatalog } from '../../src/tools/tool-catalog.js';

describe('tool registry', () => {
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
});
