import type { ExecutableTool } from "./tool-interface.js";

export interface SyncRemoteToolsResult {
    added: string[];
    removed: string[];
    skipped: string[];
}

export class ToolCatalog {
    private readonly localTools = new Map<string, ExecutableTool>();
    private readonly remoteToolsByServer = new Map<string, Map<string, ExecutableTool>>();
    private readonly reservedNames = new Set<string>();

    reserveNames(names: string[]): void {
        for (const name of names) {
            this.reservedNames.add(name);
        }
    }

    registerLocalTools(tools: ExecutableTool[]): void {
        for (const tool of tools) {
            this.localTools.set(tool.name, tool);
        }
    }

    getTool(name: string): ExecutableTool | undefined {
        return this.localTools.get(name) ?? this.getRemoteTool(name);
    }

    hasTool(name: string): boolean {
        return this.getTool(name) !== undefined;
    }

    listLocalTools(): ExecutableTool[] {
        return [...this.localTools.values()];
    }

    listRemoteTools(): ExecutableTool[] {
        return [...this.remoteToolsByServer.values()].flatMap((serverTools) => [...serverTools.values()]);
    }

    listAllTools(): ExecutableTool[] {
        return [...this.listLocalTools(), ...this.listRemoteTools()]
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    syncRemoteTools(serverName: string, tools: ExecutableTool[]): SyncRemoteToolsResult {
        const currentTools = this.remoteToolsByServer.get(serverName) ?? new Map<string, ExecutableTool>();
        const nextTools = new Map<string, ExecutableTool>();

        const added: string[] = [];
        const skipped: string[] = [];

        for (const tool of tools) {
            if (this.reservedNames.has(tool.name) || this.localTools.has(tool.name)) {
                skipped.push(tool.name);
                continue;
            }

            const owner = this.getRemoteToolOwner(tool.name);
            if (owner && owner !== serverName) {
                skipped.push(tool.name);
                continue;
            }

            nextTools.set(tool.name, tool);
            if (!currentTools.has(tool.name)) {
                added.push(tool.name);
            }
        }

        const removed = [...currentTools.keys()].filter((name) => !nextTools.has(name));
        this.remoteToolsByServer.set(serverName, nextTools);

        return { added, removed, skipped };
    }

    removeRemoteServer(serverName: string): string[] {
        const existing = this.remoteToolsByServer.get(serverName);
        if (!existing) return [];
        this.remoteToolsByServer.delete(serverName);
        return [...existing.keys()];
    }

    private getRemoteTool(name: string): ExecutableTool | undefined {
        for (const serverTools of this.remoteToolsByServer.values()) {
            const tool = serverTools.get(name);
            if (tool) {
                return tool;
            }
        }
        return undefined;
    }

    private getRemoteToolOwner(name: string): string | null {
        for (const [serverName, serverTools] of this.remoteToolsByServer.entries()) {
            if (serverTools.has(name)) {
                return serverName;
            }
        }
        return null;
    }
}

export const toolCatalog = new ToolCatalog();
