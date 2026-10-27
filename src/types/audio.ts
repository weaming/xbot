/**
 * 工具返回音频的上行载体。
 *
 * OpenAI Chat Completions 的 `input_audio` 内容块只接受 `wav` 与 `mp3`，
 * 其他容器（ogg/flac/aac/webm）无法直接上行，只能保留文本占位符。
 */

export type AudioFormat = "wav" | "mp3";

export interface AudioContent {
    /** base64 编码的音频字节（不含 data: 前缀）。 */
    data: string;
    format: AudioFormat;
}

/** OpenAI Chat Completions 的 `input_audio` 上行内容块。 */
export interface InputAudioContent {
    type: "input_audio";
    input_audio: AudioContent;
}

/** mime type → OpenAI 可接受的音频格式；未命中即不支持直接上行。 */
export const AUDIO_MIME_TO_FORMAT: Record<string, AudioFormat> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
};
