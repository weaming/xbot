import fs from "node:fs";
import path from "node:path";

export const TEST_IMAGE_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmNQAAAAASUVORK5CYII=",
    "base64",
);

export function createTestImageFile(directory: string): string {
    const imagePath = path.join(directory, "test-image.png");
    fs.writeFileSync(imagePath, TEST_IMAGE_BYTES);
    return imagePath;
}
