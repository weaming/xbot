export type ToolResultMode = 'adaptive' | 'full';

export interface ToolResultPolicy {
    mode: ToolResultMode;
}

// OpenAI-compatible message types
import type { UserContent } from './image.js';

/** @public */
export type ChatMessage =
    | { role: 'user'; content: UserContent }
    | { role: 'assistant'; content: string | null; tool_calls?: any[]; [key: string]: any }
    | {
        role: 'tool';
        tool_call_id: string;
        content: string;
        name?: string;
        contextPolicy?: ToolResultPolicy;
        [key: string]: any;
    }
    | { role: 'system'; content: string };

/** 持久化消息附带本地元数据；发送给 LLM 前会被剥离。 */
export type StoredChatMessage = ChatMessage & {
    id: string;
    createdAt: string;
    /** 工具结果是否要求完整保留（本地元数据，发送给模型前剥离）。 */
    contextPolicy?: ToolResultPolicy;
};

/** 一次用户交互的完整消息序列，工具调用与结果按原始顺序保存。 */
export interface ConversationTurn {
    id: string;
    messages: StoredChatMessage[];
    status: 'completed' | 'interrupted' | 'failed';
}

type ContextChangeReason = 'session_start' | 'hard_trim' | 'compact';

interface ContextState {
    startedAt: string;
    reason: ContextChangeReason;
    sourceUserTurnCount: number;
    retainedUserTurnCount: number;
    compactedAt?: string;
    compactInstruction?: string;
}

export interface Session {
    sessionId: string; // ULID，会话唯一标识
    /** 会话绑定的工作目录：新会话取创建时当前工具目录；旧数据无记录时以 workspace 为默认。恢复/切换会话时作为工具执行与路径渲染基准。 */
    cwd: string;
    /** 会话标题：显式重命名优先，否则取首条用户消息；tab 展示用。 */
    title?: string;
    contextEpochId: string; // 当前上下文代际，用于区分压缩和硬裁剪后的缓存前缀
    /** 首次请求生成后缓存，后续请求复用同一份 system prompt。 */
    cachedSystemPrompt?: string;
    cachedSystemPromptIncludesMemory?: boolean;
    /** 每日记忆缓存所属 userid；旧缓存缺省按默认 userid 处理。 */
    cachedSystemPromptUserId?: number;
    /** system prompt 缓存生成时的会话绑定目录；与 cwd 不一致时需重建（PWD 随会话绑定）。 */
    cachedSystemPromptCwd?: string;
    /** system prompt 缓存生成时的技能与工具目录指纹；运行时上下文变化后自动重建。 */
    cachedSystemPromptRuntimeFingerprint?: string;
    turns: ConversationTurn[];
    compactedContext?: string;
    /** 压缩截止的 turn：它之前的回合全部折叠进 compactedContext。 */
    compactedThroughTurnId?: string;
    /**
     * 保留段起始消息 id（消息级边界）。
     * 正常按完整 turn 切分时它就是保留段首个 turn 的第一条消息；
     * 单个 turn 超过保留预算时会在 turn 内切分，此时它落在 turn 中间。
     */
    compactedKeepFromMessageId?: string;
    contextState: ContextState;
    totalUserTurnCount: number;
    hardTrimCount: number;
    compactCount: number;
    /** 最近一次 provider 请求返回的输入 token，用于下一次自动压缩预判。 */
    lastPromptTokens?: number;
    createdAt?: string; // 会话创建时间（上海时区 ISO 字符串）
    updatedAt?: string; // 最近一次持久化相关变更时间
    archivedAt?: string; // 会话归档时间（上海时区 ISO 字符串）
    sentSkillsMtime?: Record<string, number>; // skill name -> mtime when last injected into system prompt
    activeSkill?: string; // 用户通过 /use 命令主动激活的技能名
}
