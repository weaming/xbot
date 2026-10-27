/**
 * 协议消息转换：把内部 ChatMessage 物化成各协议要求的上游输入形态。
 *
 * 三处容易出错的差异集中在这里：
 *   - Responses 用 input_image / function_call_output，Chat Completions 用 image_url
 *   - 工具返回的图片要补成紧随其后的用户多模态消息（Chat Completions 无工具内图片）
 *   - Responses 专属字段（response_output）在切换到 Chat Completions 前必须剥离
 */

import type { ChatMessage } from "../../types/session.js";
import type { ToolImageContent } from "../tool-interface.js";
import type { InputAudioContent } from "../../types/audio.js";
import { materializeImageMessages } from "../../utils/image-assets.js";

function responseImagePart(part: any): any {
  return {
    type: "input_image",
    image_url: part.image_url?.url,
    detail: part.image_url?.detail ?? "original",
  };
}

export async function materializeResponsesInput(messages: ChatMessage[]): Promise<any[]> {
  const materializedUsers = await materializeImageMessages(messages);
  const result: any[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const materialized = materializedUsers[index] as any;

    if (message.role === "tool") {
      const output: any[] = [{ type: "input_text", text: message.content }];
      if (message.imageContent && message.imageContent.length > 0) {
        const imageMessage = await materializeImageMessages([{
          role: "user",
          content: [
            { type: "text", text: "" },
            ...message.imageContent,
          ],
        } as ChatMessage]);
        for (const part of (imageMessage[0] as any).content.slice(1)) {
          if (part.type === "image_url") {
            output.push(responseImagePart(part));
          } else if (part.type === "text" && part.text) {
            output.push({ type: "input_text", text: part.text });
          }
        }
      }
      result.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output,
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.response_output)) {
      result.push(...message.response_output);
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        result.push({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        result.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? "{}",
          status: "completed",
        });
      }
      continue;
    }

    if (message.role === "system") {
      result.push({ role: "system", content: message.content });
      continue;
    }

    if (typeof materialized.content === "string") {
      result.push({ role: "user", content: materialized.content });
      continue;
    }

    result.push({
      role: "user",
      content: materialized.content.map((part: any) => {
        if (part.type === "text") return { type: "input_text", text: part.text };
        if (part.type === "image_url") return responseImagePart(part);
        // 其余块类型（将来的 user 音频等）原样透传，避免被当成图片构造成 input_image
        return part;
      }),
    });
  }

  return result;
}

/**
 * 把工具结果中的图片/音频补成请求专用的用户多模态消息。
 *
 * Chat Completions 的工具消息只能承载文本，图片走 image_url、音频走 input_audio，
 * 因此都提升为紧随其后的 user 消息。音频是否注入由 allowAudio 控制：只有明确支持
 * input_audio 的端点才开，其他端点（如 DeepSeek）会因未知内容块返回 400。
 */
export function expandToolMediaMessages(
    messages: ChatMessage[],
    options: { allowAudio?: boolean } = {},
): ChatMessage[] {
    const expanded: ChatMessage[] = [];
    const pendingMedia: Array<ToolImageContent | InputAudioContent> = [];
    const flushMedia = () => {
        if (pendingMedia.length === 0) return;

        const hasImage = pendingMedia.some((part) => part.type !== "input_audio");
        const hasAudio = pendingMedia.some((part) => part.type === "input_audio");
        expanded.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: hasImage && hasAudio
                        ? "工具返回了图片与音频，请结合工具结果分析这些内容。"
                        : hasImage
                            ? "工具返回了图片，请结合工具结果分析图片内容。"
                            : "工具返回了音频，请结合工具结果分析音频内容。",
                },
                ...pendingMedia,
            ],
        });
        pendingMedia.length = 0;
    };

    for (const message of messages) {
        if (message.role !== "tool") {
            flushMedia();
            expanded.push(message);
            continue;
        }

        // 是否注入音频由 allowAudio 决定；但字段本身是本地元数据，任何情况下都不能上行
        const hasLocalMedia = message.imageContent !== undefined || message.audioContent !== undefined;
        if (!hasLocalMedia) {
            expanded.push(message);
            continue;
        }

        const images = message.imageContent ?? [];
        const audios = options.allowAudio ? (message.audioContent ?? []) : [];
        pendingMedia.push(
            ...images,
            ...audios.map((audio) => ({ type: "input_audio" as const, input_audio: audio })),
        );

        const {
            imageContent: _imageContent,
            audioContent: _audioContent,
            ...toolMessage
        } = message;
        expanded.push(toolMessage as ChatMessage);
    }
    flushMedia();
    return expanded;
}

export function stripResponsesMetadata(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant") return message;
    if (!Array.isArray(message.response_output) && !message.citations) return message;
    // response_output 与 citations 都是本地保存的渲染事实，不上行
    const { response_output: _responseOutput, citations: _citations, ...chatMessage } = message;
    return chatMessage as ChatMessage;
  });
}

/** Chat Completions 请求不能包含仅有思考内容的空助手消息。 */
export function filterEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => message.role !== "assistant"
    || Boolean(message.content)
    || Boolean(message.tool_calls?.length));
}
