/**
 * apply_patch 的上游形态适配。
 *
 * 补丁是多行、语法密集的文本：作为 JSON 函数参数下发时，每个换行、引号、反斜杠都要转义，
 * 模型在长度压力下最容易在这里产出坏 JSON（参数截断或被转义成字面量）。OpenAI 的官方答案
 * 是 custom（freeform）工具：模型直接输出补丁原文，不经过 JSON；DeepSeek 只有 function 工具，
 * 只能在定义上加固（明确要求 JSON 字符串与转义写法）；其余模型保持原样。
 */

import { isDeepSeekEndpoint } from "../../pricing/deepseek.js";
import { isApplyPatchTool } from "../tool-kinds.js";

/** 工具形态：custom 自由文本 / function 加固 / off 完全不动。 */
export type ApplyPatchToolMode = "custom" | "function" | "off";

/** 手动覆盖判定：custom / function / off。 */
const APPLY_PATCH_MODE_ENV = "APPLY_PATCH_MODE";

const MODE_OVERRIDES: ReadonlySet<string> = new Set(["custom", "function", "off"]);

/**
 * 解析当前上游该用哪种形态：gpt-* 走 custom，DeepSeek 留在 function 上加固，其余不处理。
 * env 命中时优先于模型判定，出问题可一键回到 function 或彻底关闭。
 */
export function resolveApplyPatchToolMode(
    input: { model: string; baseURL?: string },
    env: NodeJS.ProcessEnv = process.env,
): ApplyPatchToolMode {
    const override = (env[APPLY_PATCH_MODE_ENV] ?? "").trim().toLowerCase();
    if (MODE_OVERRIDES.has(override)) return override as ApplyPatchToolMode;

    if (isDeepSeekEndpoint(input.model, input.baseURL)) return "function";
    if (input.model.toLowerCase().includes("gpt-")) return "custom";
    return "off";
}

/** custom 工具的描述尾巴：补丁要裸输出，不能被 JSON 或代码块围栏包住。 */
const FREEFORM_DESCRIPTION_TAIL =
    "\n\n直接输出补丁原文：以 `*** Begin Patch` 开头、`*** End Patch` 结尾。"
    + "不要包成 JSON、不要加代码块围栏、不要附带解释。";

/** function 工具的描述尾巴：明确 JSON 字符串与转义写法。 */
const JSON_STRING_DESCRIPTION_TAIL =
    "\n\n调用本工具必须输出 JSON 对象 {\"patch\": \"<完整补丁文本>\"}："
    + "patch 里的换行写作 \\n、双引号写作 \\\"，不要输出 JSON 之外的任何内容。";

/** patch 参数描述尾巴：单点强调它是一整个 JSON 字符串。 */
const JSON_STRING_PATCH_PARAMETER_TAIL = "补丁全文，作为 JSON 字符串传递：换行写作 \\n。";

/** 追加说明尾巴；已经带过的不再追加，保证重复适配幂等。 */
function appendOnce(text: string, tail: string): string {
    return text.endsWith(tail) ? text : `${text}${tail}`;
}

function customToolDefinition(tool: any, name: string): any {
    const description = tool.function?.description ?? tool.description;
    return {
        type: "custom" as const,
        name,
        // 空描述时尾巴是唯一告诉模型「输出裸补丁」的线索，所以缺描述也要加；已带过则不重复加
        description: appendOnce(typeof description === "string" ? description : "", FREEFORM_DESCRIPTION_TAIL),
        format: { type: "text" as const },
        // defer_loading 由调用方按 tool_search 能力决定，形态转换不能顺手丢掉它
        ...(tool.deferLoading === true ? { deferLoading: true } : {}),
    };
}

function chatCompletionsCustomTool(tool: any): any {
    const { type: _type, name, description, format, deferLoading } = tool;
    return {
        type: "custom",
        ...(deferLoading === true ? { deferLoading: true } : {}),
        custom: {
            name,
            ...(description ? { description } : {}),
            ...(format ? { format } : {}),
        },
    };
}

function hardenedFunctionDefinition(tool: any): any {
    const fn = tool.function ?? {};
    const parameters = fn.parameters ?? {};
    const properties = parameters.properties ?? {};
    const patchProperty = properties.patch ?? { type: "string" };
    const description = typeof fn.description === "string" ? fn.description : "";
    const patchDescription = typeof patchProperty.description === "string" ? patchProperty.description : "";

    return {
        ...tool,
        function: {
            ...fn,
            description: appendOnce(description, JSON_STRING_DESCRIPTION_TAIL),
            parameters: {
                ...parameters,
                properties: {
                    ...properties,
                    patch: {
                        ...patchProperty,
                        description: appendOnce(patchDescription, JSON_STRING_PATCH_PARAMETER_TAIL),
                    },
                },
            },
        },
    };
}

/**
 * 按上游协议改写 apply_patch 的工具定义；其余工具原样返回。
 * Responses 的 custom 工具是扁平形状，Chat Completions 的 custom 工具包在 `custom` 里。
 */
export function adaptToolsForUpstream(
    tools: any[],
    options: { mode: ApplyPatchToolMode; protocol: "responses" | "chat_completions" },
): any[] {
    if (options.mode === "off") return tools;

    return tools.map(tool => {
        // 只认 function 与扁平 custom 两种入参；Chat Completions 的嵌套 custom 读不到名字，
        // 原样返回（再适配即 no-op）。prepareRequest 每次都用注册表里的原始定义，不依赖这条路径。
        const name = tool?.function?.name ?? tool?.name;
        if (typeof name !== "string" || !isApplyPatchTool(name)) return tool;

        if (options.mode === "function") {
            return tool?.type === "custom" ? tool : hardenedFunctionDefinition(tool);
        }

        // 入参可能是 function 形状，也可能是已经转换过的扁平 custom：两种都能直接读描述与 deferLoading
        const flat = customToolDefinition(tool, name);
        return options.protocol === "chat_completions" ? chatCompletionsCustomTool(flat) : flat;
    });
}
