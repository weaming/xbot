/** 图片资产与带图片的用户输入。 */
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

export interface ImageUrlContent {
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
    { type: "text"; text: string } | ImageAssetContent | ImageUrlContent | ImageDataContent
>;

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
