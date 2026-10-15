export interface ChunkMeta {
    content: string;
    hierarchy: {
        h1?: string;
        h2?: string;
        h3?: string;
        h4?: string;
    };
    filePath: string;
    timestamp: string;
}

export function parseMarkdownChunks(content: string, filePath: string): ChunkMeta[] {
    const lines = content.split('\n');
    const chunks: ChunkMeta[] = [];

    const hierarchy: Record<string, string | undefined> = {
        h1: undefined,
        h2: undefined,
        h3: undefined,
        h4: undefined,
    };

    let currentContent: string[] = [];

    const flushChunk = () => {
        const text = currentContent.join('\n').trim();
        if (text.length > 0) {
            chunks.push({
                content: text,
                hierarchy: { ...hierarchy },
                filePath,
                timestamp: new Date().toISOString(),
            });
        }
        currentContent = [];
    };

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);

        if (headingMatch) {
            flushChunk();

            const level = headingMatch[1].length;
            const title = headingMatch[2].trim();

            // Clear deeper levels
            for (let i = level + 1; i <= 4; i++) {
                hierarchy[`h${i}` as keyof typeof hierarchy] = undefined;
            }
            hierarchy[`h${level}` as keyof typeof hierarchy] = title;
        } else {
            currentContent.push(line);
        }
    }

    flushChunk();
    return chunks;
}
