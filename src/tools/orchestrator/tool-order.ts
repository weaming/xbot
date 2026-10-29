/**
 * 工具调用顺序编排：`_order` 参数的 schema 注入、解析与批次规划。
 *
 * 规则（与系统提示词同一口径）：
 *   1. 全批都没有 `_order` → 整批并发，与引入本机制前完全一致。
 *   2. 有 `_order` → 按 order 升序分组，组内并行、组间串行。
 *   3. 只有一部分写了 → 串行链先跑完，剩下的再并发。
 *   4. 某一阶段失败 → 该阶段已发出的调用不可能撤回，全部跑完、全部回报；
 *      其后的阶段与尾部并发组一律不执行、不回报。
 *
 * 规则 4 要求被跳过的调用**不出现在历史里**：上游对 tool_calls 与 tool 结果
 * 是成对校验的，单边缺失直接 400。故这里同时提供截断 assistant 消息的工具，
 * 由落盘方在拿到实际执行集合后调用。
 */

import type { ToolCall } from "../../types/tool-call.js";
import type { ChatMessage } from "../../types/session.js";

/** 顺序字段名。带下划线前缀，避免与工具自身参数撞名。 */
const TOOL_ORDER_FIELD = "_order";

const ORDER_PARAM_SCHEMA = {
    type: "integer",
    description:
        "执行顺序，可选。同一批里需要严格先后时填写：按此值升序分阶段执行，相同值的调用并行；"
        + "未填写 `_order` 的调用在这条串行链之后并行。任一阶段失败，其后阶段与未排序调用都不再执行。",
};

export interface PlannedToolCall {
    call: ToolCall;
    /** 在本批 calls 里的下标，用于按原顺序还原消息。 */
    index: number;
}

export interface ToolExecutionPlan {
    /**
     * 带 `_order` 的调用，已按 order 升序分组：组内并行（同值），组间串行。
     * 每组内部按原下标排序，便于调用方按稳定顺序入列。
     */
    stages: PlannedToolCall[][];
    /** 没写 `_order` 的调用：有串行链时排在链后并发，无链时整批并发。 */
    parallel: PlannedToolCall[];
}

/** 读取调用参数里的 `_order`；容忍模型把整数写成数字字符串。 */
function readToolOrder(args: unknown): number | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    const raw = (args as Record<string, unknown>)[TOOL_ORDER_FIELD];
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === "string" && raw.trim() !== "") {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** 剥掉 `_order` 再交给工具：它是调度指令，不是工具自己的参数。 */
export function stripToolOrder<T>(args: T): T {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    if (!Object.hasOwn(args as Record<string, unknown>, TOOL_ORDER_FIELD)) return args;
    const { [TOOL_ORDER_FIELD]: _order, ...rest } = args as Record<string, unknown>;
    return rest as T;
}

/** 把一批调用拆成「串行链」与「并发组」。 */
export function planToolExecution(calls: ToolCall[]): ToolExecutionPlan {
    const byOrder = new Map<number, PlannedToolCall[]>();
    const parallel: PlannedToolCall[] = [];

    calls.forEach((call, index) => {
        const order = readToolOrder(call.args);
        if (order === undefined) {
            parallel.push({ call, index });
            return;
        }
        const stage = byOrder.get(order);
        if (stage) stage.push({ call, index });
        else byOrder.set(order, [{ call, index }]);
    });

    const stages = [...byOrder.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, stage]) => stage.sort((left, right) => left.index - right.index));
    return { stages, parallel };
}

const orderParamCache = new WeakMap<object, any>();

/**
 * 给工具参数 schema 追加 `_order`。
 *
 * 只对对象型参数生效：custom 工具（apply_patch 的自由文本形态）没有 schema，
 * 自然也不支持顺序声明，执行时按「无 `_order`」处理。
 */
export function withOrderParam(parameters: any): any {
    if (!parameters || typeof parameters !== "object" || parameters.type !== "object") return parameters;

    const cached = orderParamCache.get(parameters);
    if (cached) return cached;

    const properties = parameters.properties && typeof parameters.properties === "object"
        ? parameters.properties
        : {};
    if (Object.hasOwn(properties, TOOL_ORDER_FIELD)) return parameters;

    const injected = {
        ...parameters,
        properties: { ...properties, [TOOL_ORDER_FIELD]: ORDER_PARAM_SCHEMA },
    };
    orderParamCache.set(parameters, injected);
    return injected;
}

function isToolCallOutputItem(item: any): boolean {
    return item?.type === "function_call" || item?.type === "custom_tool_call";
}

/**
 * 把 assistant 消息里的工具调用裁到「实际执行的集合」。
 *
 * 失败跳过的调用必须连同 `response_output` 里的调用项一起删除：Responses 协议下
 * `response_output` 会整段回放，只删 tool_calls 等于没删。无裁剪时返回原对象。
 */
export function truncateAssistantToolCalls(
    message: ChatMessage,
    keptCallIds: ReadonlySet<string>,
): ChatMessage {
    const calls: any[] = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : [];
    const outputItems: any[] = Array.isArray((message as any).response_output) ? (message as any).response_output : [];

    const keptCalls = calls.filter(call => typeof call?.id === "string" && keptCallIds.has(call.id));
    const keptOutput = outputItems.filter(item => {
        if (!isToolCallOutputItem(item)) return true;
        const callId = item?.call_id ?? item?.id;
        return typeof callId !== "string" || keptCallIds.has(callId);
    });

    if (keptCalls.length === calls.length && keptOutput.length === outputItems.length) return message;
    return {
        ...message,
        ...(calls.length > 0 ? { tool_calls: keptCalls } : {}),
        ...(outputItems.length > 0 ? { response_output: keptOutput } : {}),
    } as ChatMessage;
}
