/**
 * System One 风格决策模型的公共类型。
 *
 * 决策模型与聊天模型的关键差异：输入是 state + 一组带类型的 question，
 * 输出是每个问题的标定概率，不做自回归生成（output tokens 恒为 0）。
 */

/** 问题类型：choice 从命名选项中选一个，score 落在有序档位，noul 是概率化的 yes/no。 */
/** noul 的判定说明：分别描述什么算 yes、什么算 no。 */
interface NoulCriteria {
    true: string;
    false: string;
}

/** 单个问题的定义。criteria 的形态随 type 变化。 */
interface Question {
    type: "choice";
    instructions: string;
    /** 选项名 -> 描述（描述可为 null）；2-255 个选项。 */
    criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
    type: "score";
    instructions: string;
    /** 由低到高的档位描述；2-10 个档位。 */
    criteria: string[];
}

export interface NoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: NoulCriteria;
}

export type AnyQuestion = Question | ScoreQuestion | NoulQuestion;

/** 一批命名问题。key 即答案的 key。 */
export type QuestionMap = Record<string, AnyQuestion>;

/** choice 答案：命中的选项、每个选项的概率、以及归一化的置信度。 */
export interface ChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

/** score 答案：概率加权得分可落在档位之间，legend 给出档位文字。 */
export interface ScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}

/** noul 答案：yes 的概率。 */
export interface NoulAnswer {
    type: "noul";
    noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerMap = Record<string, Answer>;

/** 一次决策调用的用量与费用。output_tokens 恒为 0；cost 在服务端为该模型定价时给出。 */
export interface DecisionUsage {
    input_tokens: number;
    output_tokens: number;
    cost?: number;
}

/** 归一化后的决策结果。 */
export interface DecisionResult {
    /** 实际应答的模型 id（服务端可能回显完整版本名）。 */
    model: string;
    answers: AnswerMap;
    usage: DecisionUsage;
    /** 端到端耗时（毫秒），由客户端测量。 */
    latencyMs: number;
    /** 请求命中过的重试次数，0 表示一次成功。 */
    retries: number;
}

/** state 允许纯文本、结构化 JSON，或图文混排的 OpenAI 风格片段。 */
export type DecisionState =
    | string
    | Record<string, unknown>
    | unknown[]
    | null;

/** 图片输入：base64 data URL 或显式的 content_type + base64 组合。 */
export type ImageInput =
    | string
    | { content_type: string; base64: string };

/** 发起一次决策调用的参数。 */
export interface DecisionRequest {
    state?: DecisionState;
    questions: QuestionMap;
    /** 最多 8 张图片，仅支持图像输入的模型可用。 */
    images?: ImageInput[];
    /** 覆盖 provider 默认模型。 */
    model?: string;
    /** 单次调用超时（毫秒），覆盖 provider 默认值。 */
    timeoutMs?: number;
}

