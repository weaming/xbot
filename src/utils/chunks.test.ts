import { describe, it, expect } from "bun:test";
import { parseMarkdownChunks } from "./chunks";

describe("parseMarkdownChunks", () => {
    it("handles simple h2 with content", () => {
        const content = `## Title

Some content here`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h2).toBe("Title");
        expect(chunks[0].content).toBe("Some content here");
    });

    it("handles nested h3 under h2", () => {
        const content = `## Photography

### Camera
sony a7m4`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h2).toBe("Photography");
        expect(chunks[0].hierarchy.h3).toBe("Camera");
        expect(chunks[0].content).toBe("sony a7m4");
    });

    it("handles h2 and h3 as separate chunks", () => {
        const content = `## Photography

### Camera
sony a7m4

### Lens
2470gm2`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(2);
        expect(chunks[0].hierarchy.h3).toBe("Camera");
        expect(chunks[0].content).toBe("sony a7m4");
        expect(chunks[1].hierarchy.h3).toBe("Lens");
        expect(chunks[1].content).toBe("2470gm2");
    });

    it("handles h1 > h2 > h3 nesting", () => {
        const content = `# A

## B

### C
content`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h1).toBe("A");
        expect(chunks[0].hierarchy.h2).toBe("B");
        expect(chunks[0].hierarchy.h3).toBe("C");
        expect(chunks[0].content).toBe("content");
    });

    it("handles h1 > h2 > h3 > back to h2", () => {
        const content = `# A

## B

### C
content

## D
content2`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(2);
        expect(chunks[0].hierarchy.h1).toBe("A");
        expect(chunks[0].hierarchy.h2).toBe("B");
        expect(chunks[0].hierarchy.h3).toBe("C");
        expect(chunks[1].hierarchy.h1).toBe("A");
        expect(chunks[1].hierarchy.h2).toBe("D");
    });

    it("handles content without any headings", () => {
        const content = `Just some plain content

More content here`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h1).toBeUndefined();
        expect(chunks[0].content).toBe("Just some plain content\n\nMore content here");
    });

    it("handles multiline content under heading", () => {
        const content = `## Title

Line one

Line two

Line three`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe("Line one\n\nLine two\n\nLine three");
    });

    it("handles h4 heading", () => {
        const content = `# A

## B

### C

#### D
content`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h4).toBe("D");
        expect(chunks[0].content).toBe("content");
    });

    it("handles heading with trailing empty lines", () => {
        const content = `## Title



## Next
real content`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks).toHaveLength(1);
        expect(chunks[0].hierarchy.h2).toBe("Next");
        expect(chunks[0].content).toBe("real content");
    });

    it("preserves filePath in all chunks", () => {
        const content = `## A

### B
content`;

        const chunks = parseMarkdownChunks(content, "/path/to/MEMORY.md");

        expect(chunks[0].filePath).toBe("/path/to/MEMORY.md");
    });

    it("adds timestamp to all chunks", () => {
        const content = `## A

content`;

        const chunks = parseMarkdownChunks(content, "/path/test.md");

        expect(chunks[0].timestamp).toBeDefined();
        expect(new Date(chunks[0].timestamp).getTime()).toBeGreaterThan(0);
    });
});
