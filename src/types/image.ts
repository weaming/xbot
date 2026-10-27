/** 图片资产与带图片的用户输入。 */
import type { InputAudioContent } from "./audio.js";

export interface ImageAssetRef {
    id: string;
    path: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
}

export interface ImageUrlRef {
    url: string;
    filename: string;
    mimeType?: string;
}

export type ImageInputRef = ImageAssetRef | ImageUrlRef;

export interface TuiDraft {
    text: string;
    images: ImageAssetRef[];
}

export interface UserMessageInput {
    text: string;
    images?: ImageInputRef[];
    trigger?: "user" | "pending" | "peer";
}

export interface ImageAssetContent {
    type: "image_asset";
    image: ImageAssetRef;
}

interface ImageUrlContent {
    type: "image_url";
    image: ImageUrlRef;
}

export interface ImageDataRef {
    id: string;
    data: string;
    filename: string;
    mimeType: string;
}

export interface ImageDataContent {
    type: "image_data";
    image: ImageDataRef;
}

export type UserContent = string | Array<
    | { type: "text"; text: string }
    | ImageAssetContent
    | ImageUrlContent
    | ImageDataContent
    | InputAudioContent
>;

/**
 * OpenAI 与 DeepSeek 视觉共同支持的图片格式。
 * bmp/svg 等容器无法上行，发送会被上游拒绝，因此在提取阶段就过滤掉。
 * 注意不含 image/jpg —— 非标准别名由 normalizeMimeType 归一化成 image/jpeg。
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

export interface DeepSeekFileContent {
    type: "file";
    file_id: string;
}

export function toUserContent(input: UserMessageInput): UserContent {
    if (!input.images || input.images.length === 0) return input.text;
    return [
        { type: "text", text: input.text },
        ...input.images.map(image => "url" in image
            ? { type: "image_url" as const, image }
            : { type: "image_asset" as const, image }),
    ];
}
