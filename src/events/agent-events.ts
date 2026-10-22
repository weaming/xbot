/**
 * Agent 事件（持久化，事实源）：append-only 事件日志的条目。
 * Session 状态是其投影——重放事件序列可确定性重建任意时间点状态。
 *
 * 回合内容仍以 turn_message（每条完整消息一次，保留 provider 专有字段）为准，
 * 位置由 turn_segment_start（段起始边界）给出；回合收尾用一条 turn_commit 元信息事件以
 * seq 列表指向它们，避免把同一份内容在终态事件里再存一遍。
 */

import type { ChatMessage } from "../types/session.js";
import type { UsageInfo } from "../types/chat.js";
import type { ImageInputRef, UserMessageInput } from "../types/image.js";
import type { ChatModelSelection } from "../types/chat-model.js";

export type AgentEventType =
    | "session_created"
    | "user_message"
    | "peer_message"
    | "peer_result"
    | "turn_message"
    | "turn_segment_start"
    | "turn_commit"
    | "context_compacted"
    | "standalone_turn"
    | "usage_recorded"
    | "session_archived"
    | "session_unarchived"
    | "session_renamed"
    | "model_selected";

/** 用户消息附带的图片引用。 */
export type UserImageRef = ImageInputRef;

export interface AgentEventPayloads {
    session_created: { cwd: string };
    /**
     * 用户消息事实源。turnId 把同一回合的增量消息归组；trigger 区分用户输入与执行中
     * 并入的 pending 消息。
     */
    user_message: {
        text: string;
        images?: UserImageRef[];
        turnId: string;
        /** peer：另一个会话发来的消息或它回传的结果，时间线上按会话卡片渲染。 */
        trigger: "user" | "pending" | "peer";
    };
    /**
     * 会话间消息事实源（UI 时间线专用）：入站请求、出站消息、结果回传各一条。
     * 不参与 Session 投影——会话间对话是展示与驱动来源，模型上下文由 user_message 承载。
     */
    peer_message: {
        msgId: string;
        direction: "in" | "out";
        /** 对端会话 id。 */
        peerId: string;
        /** 对端展示名快照（会话可能被重命名或删除）。 */
        peerTitle?: string;
        text: string;
        /** 本轮是否期望结果（入站消息携带）。 */
        expectResult?: boolean;
        /** 在回应哪条消息。 */
        replyTo?: string;
        createdAt: string;
    };
    /** 会话间结果事实源（UI 时间线专用）：对方回合的产出回传，或等待失败。 */
    peer_result: {
        /** 关联的请求消息 id。 */
        msgId: string;
        /** 产出这条结果的对端会话。 */
        peerId: string;
        peerTitle?: string;
        /** 对方回合是否正常完成。 */
        ok: boolean;
        /** 结果确定丢失（对方进程退出或等待超时）。 */
        lost?: boolean;
        text: string;
        stopReason?: string;
        createdAt: string;
    };
    /**
     * 回合内每条**完整**消息定稿即落盘（不含流式 delta），让强杀/崩溃也能恢复现场。
     * 保留 provider 专有字段（reasoning_details、tool_call 的 thought_signature 等），
     * 重放时直接回传，避免请求格式错误。同一 turnId 的 turn_commit 出现后即视为终态。
     */
    turn_message: { turnId: string; message: ChatMessage };
    /**
     * 回合内的段边界（时间线分段）：每段**开始**时落一条，seq 即该段的起始时间。
     * 群消息按 seq 与段边界比较，就能在重放时插到与实时一致的段位。
     */
    turn_segment_start: { turnId: string; kind: "reasoning" | "text" | "tool" | "user" };
    /**
     * 回合终态元信息：只存关系（events 指向底层事件 seq）与收尾事实，不重复内容。
     * events 按时间线顺序列出本回合的 turn_message / turn_segment_start。
     */
    turn_commit: {
        turnId: string;
        events: number[];
        userMessages: Array<string | UserMessageInput>;
        stopReason: string;
        usage: UsageInfo;
        interrupted: boolean;
        /** provider/orchestrator 抛错时填入，便于事后排查 429/502/length/error。 */
        error?: string;
    };
    context_compacted: {
        compactedContext: string;
        instruction?: string;
        /** 保留段起始消息 id，供当前进程定位。 */
        keepFromMessageId?: string;
        /** 持久化位置，避免重放时重新生成的消息 id 使边界失效。 */
        keepFromPosition?: { turnIndex: number; messageIndex: number };
        usage?: UsageInfo;
    };
    /**
     * 不经编排器的独立回合投影源。
     * injected：自动注入的上下文（群聊状态更新）标记 —— 不是用户活动，会话排序时不计入更新时间。
     */
    standalone_turn: { messages: ChatMessage[]; injected?: boolean };
    usage_recorded: { usage: UsageInfo };
    session_archived: {};
    /** 取消归档：与 session_archived 成对，末态决定会话是否归档。 */
    session_unarchived: {};
    /** 用户双击 tab 重命名会话标题（tab 显示优先于首条用户消息）。 */
    session_renamed: { title: string };
    /** 会话固定使用的协议与模型。 */
    model_selected: ChatModelSelection;
}

export type AgentEvent = {
    [T in AgentEventType]: {
        seq: number;
        ts: string;
        sessionId: string;
        type: T;
        payload: AgentEventPayloads[T];
    };
}[AgentEventType];
