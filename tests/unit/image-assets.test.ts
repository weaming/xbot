import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
    createImageAsset,
    materializeDeepSeekImageMessages,
    materializeImageMessages,
    resolveDeepSeekFilesAPI,
    uploadDeepSeekFile,
} from "../../src/utils/image-assets.js";
import { toolContentToImageContent } from "../../src/tools/tool-interface.js";
import { toUserContent } from "../../src/types/image.js";
import { createTestImageFile, TEST_IMAGE_BYTES } from "./image-fixture.js";

describe("image assets", () => {
    let stateDir: string;
    let previousStateDir: string | undefined;
    let previousFilesAPI: string | undefined;

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-image-assets-"));
        previousStateDir = process.env.XBOT_STATE_DIR;
        previousFilesAPI = process.env.DEEPSEEK_FILES_API;
        process.env.XBOT_STATE_DIR = stateDir;
    });

    afterEach(() => {
        if (previousStateDir === undefined) delete process.env.XBOT_STATE_DIR;
        else process.env.XBOT_STATE_DIR = previousStateDir;
        if (previousFilesAPI === undefined) delete process.env.DEEPSEEK_FILES_API;
        else process.env.DEEPSEEK_FILES_API = previousFilesAPI;
        fs.rmSync(stateDir, { recursive: true, force: true });
    });

    test("落盘时保留原始图片格式与字节", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        const asset = await createImageAsset(original, "test-image.png");

        expect(asset.mimeType).toBe("image/png");
        expect(asset.sizeBytes).toBe(original.length);
        expect(fs.existsSync(asset.path)).toBe(true);
        expect(fs.readFileSync(asset.path).subarray(0, 8)).toEqual(TEST_IMAGE_BYTES.subarray(0, 8));
        expect(fs.readFileSync(asset.path)).toEqual(original);
        expect(asset.path).not.toBe(originalPath);
    });

    test("工具图片优先固化 base64，不依赖外部文件路径", () => {
        const imageContent = toolContentToImageContent([{
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/png",
            path: "/missing/external/image.png",
        }]);

        expect(imageContent).toHaveLength(1);
        expect(imageContent[0]).toMatchObject({
            type: "image_data",
            image: {
                data: "aGVsbG8=",
                mimeType: "image/png",
            },
        });
    });

    test("官方 DeepSeek 地址自动推导 Files API", () => {
        expect(resolveDeepSeekFilesAPI("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/files");
        expect(resolveDeepSeekFilesAPI("https://api.deepseek.com")).toBe("https://api.deepseek.com/files");
        expect(resolveDeepSeekFilesAPI("https://gateway.example.com/v1")).toBe("https://api.deepseek.com/files");
    });

    test("历史图片文件不存在时降级为文本，不阻断请求", async () => {
        const missingPath = path.join(stateDir, "deleted.png");
        await expect(materializeImageMessages([{
            role: "user",
            content: [{
                type: "image_asset",
                image: {
                    id: "deleted-image",
                    path: missingPath,
                    filename: "deleted.png",
                    mimeType: "image/png",
                    sizeBytes: 10,
                },
            }],
        }])).resolves.toEqual([{
            role: "user",
            content: [{ type: "text", text: `[图片文件不可用：${missingPath}]` }],
        }]);
    });

    test("Files API 上传使用原始 multipart 请求并设置七天有效期", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        let requestBody = Buffer.alloc(0);
        let requestHeaders: Record<string, string | string[] | undefined> = {};

        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            requestHeaders = request.headers;
            request.on("data", chunk => chunks.push(Buffer.from(chunk)));
            request.on("end", () => {
                requestBody = Buffer.concat(chunks);
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ id: "file-api-test" }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法获取测试 Files API 地址");
            process.env.DEEPSEEK_FILES_API = `http://127.0.0.1:${address.port}/files`;

            await expect(uploadDeepSeekFile(originalPath)).resolves.toBe("file-api-test");
            expect(requestHeaders.authorization).toBeUndefined();
            expect(requestHeaders["content-type"]).toContain("multipart/form-data; boundary=");
            expect(requestBody.toString()).toContain('name="purpose"');
            expect(requestBody.toString()).toContain("user_data");
            expect(requestBody.toString()).toContain('name="expires_after[anchor]"');
            expect(requestBody.toString()).toContain("created_at");
            expect(requestBody.toString()).toContain('name="expires_after[seconds]"');
            expect(requestBody.toString()).toContain("604800");
            expect(requestBody.includes(original)).toBe(true);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test("DeepSeek 本地图片继续使用 image_url，不上传 Files API", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        const image = {
            id: "img-test-files-api",
            path: originalPath,
            filename: "test-image.png",
            mimeType: "image/png" as const,
            sizeBytes: original.length,
        };
        const uploadedPaths: string[] = [];
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "分析图片" },
                    { type: "image_asset", image },
                ],
            },
        ];

        const materialized = await materializeDeepSeekImageMessages(messages, async asset => {
            uploadedPaths.push(asset.path);
            return "file-test-1";
        });

        expect(uploadedPaths).toEqual([]);
        expect(materialized[0].content).toEqual([
            { type: "text", text: "分析图片" },
            {
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${original.toString("base64")}`,
                    detail: "original",
                },
            },
        ]);
    });

    test("外部图片引用直接物化为 image_url，不读取本地文件", async () => {
        const image = {
            url: "https://example.com/photo.jpg",
            filename: "photo.jpg",
            mimeType: "image/jpeg",
        };
        const messages = [{
            role: "user",
            content: toUserContent({ text: "分析这张图", images: [image] }),
        }];

        await expect(materializeImageMessages(messages)).resolves.toEqual([{
            role: "user",
            content: [
                { type: "text", text: "分析这张图" },
                {
                    type: "image_url",
                    image_url: { url: image.url },
                },
            ],
        }]);
    });

    test("DeepSeek 外链尺寸合规时保留原链接", async () => {
        const original = TEST_IMAGE_BYTES;
        const server = createServer((_request, response) => {
            response.setHeader("Content-Type", "image/png");
            response.end(original);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法获取图片测试服务器地址");
            const image = {
                url: `http://127.0.0.1:${address.port}/image.jpg`,
                filename: "image.jpg",
                mimeType: "image/png",
            };
            const messages = [{
                role: "user",
                content: toUserContent({ text: "分析这张图", images: [image] }),
            }];
            await expect(materializeDeepSeekImageMessages(messages, async () => {
                throw new Error("尺寸合规的外链图片不应上传");
            })).resolves.toEqual([{
                role: "user",
                content: [
                    { type: "text", text: "分析这张图" },
                    { type: "image_url", image_url: { url: image.url } },
                ],
            }]);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test("工具返回的内存图片在 DeepSeek 请求中上传为文件", async () => {
        const uploaded: Array<{ data: string; filename: string; mimeType: string }> = [];
        const messages = [{
            role: "user",
            content: [
                { type: "text", text: "分析工具图片" },
                {
                    type: "image_data",
                    image: {
                        id: "tool-image-data",
                        data: TEST_IMAGE_BYTES.toString("base64"),
                        filename: "result.png",
                        mimeType: "image/png",
                    },
                },
            ],
        }];

        await expect(materializeDeepSeekImageMessages(messages, async image => {
            if (!("data" in image)) throw new Error("测试图片应为内存数据");
            uploaded.push({ data: image.data, filename: image.filename, mimeType: image.mimeType });
            return "file-tool-image";
        })).resolves.toEqual([{
            role: "user",
            content: [
                { type: "text", text: "分析工具图片" },
                { type: "file", file_id: "file-tool-image" },
            ],
        }]);
        expect(uploaded).toEqual([{
            data: TEST_IMAGE_BYTES.toString("base64"),
            filename: "result.png",
            mimeType: "image/png",
        }]);
    });
});
