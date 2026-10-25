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
      content: materialized.content.map((part: any) => part.type === "text"
        ? { type: "input_text", text: part.text }
        : responseImagePart(part)),
    });
  }

  return result;
}

/** 把工具结果中的图片补成请求专用的用户多模态消息。 */
export function expandToolImageMessages(messages: ChatMessage[]): ChatMessage[] {
  const expanded: ChatMessage[] = [];
  const pendingImages: ToolImageContent[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    expanded.push({
      role: "user",
      content: [
        { type: "text", text: "工具返回了图片，请结合工具结果分析图片内容。" },
        ...pendingImages,
      ],
    });
    pendingImages.length = 0;
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      flushImages();
      expanded.push(message);
      continue;
    }

    if (message.imageContent && message.imageContent.length > 0) {
      pendingImages.push(...message.imageContent);
      const { imageContent: _imageContent, ...toolMessage } = message;
      expanded.push(toolMessage as ChatMessage);
    } else {
      expanded.push(message);
    }
  }
  flushImages();
  return expanded;
}

export function stripResponsesMetadata(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant" || !Array.isArray(message.response_output)) return message;
    const { response_output: _responseOutput, ...chatMessage } = message;
    return chatMessage as ChatMessage;
  });
}

/** Chat Completions 请求不能包含仅有思考内容的空助手消息。 */
export function filterEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => message.role !== "assistant"
    || Boolean(message.content)
    || Boolean(message.tool_calls?.length));
}
