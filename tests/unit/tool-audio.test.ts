import { describe, expect, test } from "bun:test";
import { toolContentToAudioContent } from "../../src/tools/tool-interface.js";
import { expandToolMediaMessages } from "../../src/tools/orchestrator/messages.js";
import { supportsAudioInput } from "../../src/tools/orchestrator/turn-request.js";
import type { ChatMessage } from "../../src/types/session.js";

const WAV_BASE64 = "UklGRg==";
const MP3_BASE64 = "SUQz";

describe("toolContentToAudioContent", () => {
    test("提取 wav 与 mp3，忽略其他容器", () => {
        const content = [
            { type: "audio", mimeType: "audio/wav", data: WAV_BASE64 },
            { type: "audio", mimeType: "audio/mpeg", data: MP3_BASE64 },
            { type: "audio", mimeType: "audio/ogg", data: "b2dn" },
            { type: "audio", mimeType: "audio/flac", data: "ZmxhYw==" },
            { type: "text", text: "[audio audio/wav base64_chars=8]" },
        ];

        expect(toolContentToAudioContent(content)).toEqual([
            { data: WAV_BASE64, format: "wav" },
            { data: MP3_BASE64, format: "mp3" },
        ]);
    });

    test("缺少 data 的音频块被跳过", () => {
        expect(toolContentToAudioContent([{ type: "audio", mimeType: "audio/wav" }])).toEqual([]);
    });
});

describe("expandToolMediaMessages 音频门控", () => {
    const toolMessage = (): ChatMessage => ({
        role: "tool",
        tool_call_id: "call_1",
        name: "read_media_file",
        content: "[audio audio/wav base64_chars=8]",
        audioContent: [{ data: WAV_BASE64, format: "wav" }],
    });

    test("allowAudio 开启时提升为带 input_audio 的 user 消息", () => {
        const expanded = expandToolMediaMessages([toolMessage()], { allowAudio: true });

        expect(expanded).toHaveLength(2);
        expect(expanded[0]).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            name: "read_media_file",
            content: "[audio audio/wav base64_chars=8]",
        });
        expect(expanded[1]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "工具返回了音频，请结合工具结果分析音频内容。" },
                { type: "input_audio", input_audio: { data: WAV_BASE64, format: "wav" } },
            ],
        });
    });

    test("allowAudio 关闭时音频不外发，只保留文本占位符", () => {
        const expanded = expandToolMediaMessages([toolMessage()], { allowAudio: false });

        expect(expanded).toHaveLength(1);
        expect(expanded[0]).not.toHaveProperty("audioContent");
        expect(JSON.stringify(expanded[0])).not.toContain("input_audio");
    });

    test("图片与音频同时存在时合并进同一条 user 消息，提示语同时提到两者", () => {
        const message: ChatMessage = {
            role: "tool",
            tool_call_id: "call_2",
            content: "mixed",
            imageContent: [{ type: "image_asset", image: { id: "img_1" } as any }],
            audioContent: [{ data: WAV_BASE64, format: "wav" }],
        };

        const expanded = expandToolMediaMessages([message], { allowAudio: true });

        expect(expanded).toHaveLength(2);
        const mediaMessage = expanded[1] as { role: string; content: any[] };
        expect(mediaMessage.role).toBe("user");
        expect(mediaMessage.content[0].text).toBe("工具返回了图片与音频，请结合工具结果分析这些内容。");
        expect(mediaMessage.content.some((part) => part.type === "input_audio")).toBe(true);
    });
});

describe("supportsAudioInput", () => {
    test("音频模型开启，DeepSeek 与普通模型关闭", () => {
        expect(supportsAudioInput("gpt-audio-1.5", "https://api.openai.com/v1")).toBe(true);
        expect(supportsAudioInput("gpt-4o-audio-preview", "https://api.openai.com/v1")).toBe(true);
        expect(supportsAudioInput("deepseek-chat", "https://api.deepseek.com")).toBe(false);
        expect(supportsAudioInput("deepseek-flash", "https://api.deepseek.com")).toBe(false);
        expect(supportsAudioInput("gpt-4o", "https://api.openai.com/v1")).toBe(false);
    });
});

describe("audioContent 落盘", () => {
    test("写入回合历史时剔除内联 base64，避免快照膨胀", async () => {
        const { appendCompletedTurn } = await import("../../src/utils/conversation-history.js");

        const session: any = {
            id: "s1", model: "m", cwd: "/tmp",
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: {
                startedAt: "2026-01-01T00:00:00+08:00",
                reason: "session_start",
                sourceUserTurnCount: 0,
                retainedUserTurnCount: 0,
            },
            totalUserTurnCount: 0, hardTrimCount: 0, compactCount: 0,
        };
        const toolMessage = {
            role: "tool" as const,
            tool_call_id: "call_1",
            name: "read_media_file",
            content: "[audio audio/wav base64_chars=8]",
            audioContent: [{ data: "UklGRg==", format: "wav" as const }],
        };

        appendCompletedTurn(session, ["听一下"], [toolMessage], true);

        const stored = JSON.stringify(session.turns);
        expect(stored).not.toContain("audioContent");
        expect(stored).not.toContain("UklGRg==");
        expect(stored).toContain("[audio audio/wav base64_chars=8]");
    });
});

describe("supportsAudioInput 的 TOOL_AUDIO_INPUT 覆盖", () => {
    const withEnv = (value: string | undefined, run: () => void) => {
        const previous = process.env.TOOL_AUDIO_INPUT;
        if (value === undefined) delete process.env.TOOL_AUDIO_INPUT;
        else process.env.TOOL_AUDIO_INPUT = value;
        try {
            run();
        } finally {
            if (previous === undefined) delete process.env.TOOL_AUDIO_INPUT;
            else process.env.TOOL_AUDIO_INPUT = previous;
        }
    };

    test("on 强制开启非音频模型的音频上行", () => {
        withEnv("on", () => {
            expect(supportsAudioInput("gpt-4o", "https://api.openai.com/v1")).toBe(true);
        });
    });

    test("off 强制关闭音频模型的音频上行", () => {
        withEnv("off", () => {
            expect(supportsAudioInput("gpt-audio-1.5", "https://api.openai.com/v1")).toBe(false);
        });
    });

    test("DeepSeek 端点不受 on 覆盖影响", () => {
        withEnv("on", () => {
            expect(supportsAudioInput("deepseek-chat", "https://api.deepseek.com")).toBe(false);
        });
    });
});

describe("turn_message 事件落盘", () => {
    test("onTurnMessage 收到原对象（run-turn 靠对象身份去重，中间层不得复制）", async () => {
        const { executeWithChat } = await import("../../src/tools/chat-orchestrator.js");
        const persisted: any[] = [];
        let requestCount = 0;
        const client = {
            baseURL: "http://test.invalid",
            create: async () => {
                requestCount++;
                return requestCount === 1
                    ? {
                        choices: [{
                            message: {
                                role: "assistant",
                                tool_calls: [{
                                    id: "call_audio",
                                    type: "function",
                                    function: { name: "read_media_file", arguments: "{}" },
                                }],
                            },
                        }],
                    }
                    : { choices: [{ message: { role: "assistant", content: "好了" } }] };
            },
        };

        const result = await executeWithChat({
            query: "听",
            client,
            model: "gpt-audio-1.5",
            executeTool: async () => ({
                content: "[audio audio/wav base64_chars=8]",
                audioContent: [{ data: "UklGRg==", format: "wav" as const }],
            }),
            onTurnMessage: (message: any) => {
                persisted.push(message);
            },
        });

        const persistedTool = persisted.find((message) => message.role === "tool");
        const turnTool = result.messages.find((message: any) => message.role === "tool");
        expect(persistedTool).toBeDefined();
        // 同一引用：一旦这里改成副本，run-turn 的 includes 去重会恒为 false 并重复落盘
        expect(persistedTool).toBe(turnTool);
        // 中间层不再剔除，剔除由唯一落盘口 persistTurnMessage 负责
        expect(persistedTool.audioContent).toEqual([{ data: "UklGRg==", format: "wav" }]);
    });
});
