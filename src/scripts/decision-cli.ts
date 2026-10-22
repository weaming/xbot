/**
 * 决策模型命令行工具。
 *
 * 用法：
 *   bun src/scripts/decision-cli.ts models
 *   LIQUID_MODEL=d1-ultra bun src/scripts/decision-cli.ts ask --provider liquid \
 *       --state "payouts failing" --questions-file q.json
 */

import { readFileSync } from "node:fs";
import { createJevStyle, createLiquid, createMercury, createTypeSafe } from "../decision/providers.js";
import type { DecisionProvider } from "../decision/provider.js";
import { LIQUID_MODEL_ENV } from "../decision/providers.js";
import type { DecisionRequest, DecisionResult, QuestionMap } from "../decision/types.js";

const PROVIDERS = {
    liquid: createLiquid,
    typesafe: createTypeSafe,
    jevstyle: createJevStyle,
    mercury: createMercury,
} as const;

type ProviderName = keyof typeof PROVIDERS;

interface CliArgs {
    command: string;
    provider: ProviderName;
    model?: string;
    state?: string;
    question?: string;
    questionsFile?: string;
    json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { command: argv[0] ?? "help", provider: "liquid", json: false };
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        switch (flag) {
            case "--provider": args.provider = value as ProviderName; i++; break;
            case "--model": args.model = value; i++; break;
            case "--state": args.state = value; i++; break;
            case "--question": args.question = value; i++; break;
            case "--questions-file": args.questionsFile = value; i++; break;
            case "--json": args.json = true; break;
            default:
                if (flag.startsWith("--")) throw new Error(`未知参数：${flag}`);
        }
    }
    return args;
}

function loadQuestions(args: CliArgs): QuestionMap {
    const raw = args.questionsFile
        ? readFileSync(args.questionsFile, "utf8")
        : args.question;
    if (!raw) throw new Error("需要 --question 或 --questions-file 提供问题定义");
    const parsed = JSON.parse(raw);
    // 允许直接传单个问题，缺省 key 为 answer
    if (parsed.type && parsed.instructions) return { answer: parsed };
    return parsed as QuestionMap;
}

/** 让用户明确知道缺了哪个环境变量。 */
function buildProvider(name: ProviderName, model?: string): DecisionProvider {
    const factory = PROVIDERS[name];
    if (!factory) throw new Error(`未知 provider：${name}（可选：${Object.keys(PROVIDERS).join(", ")}）`);
    return factory(model ? { model } : {});
}

async function cmdModels(args: CliArgs): Promise<void> {
    const provider = buildProvider(args.provider, args.model);
    // 决策模型列表端点各 provider 可能不同，这里只做可用性探活
    const result = await provider.decide({
        state: "ping",
        questions: { alive: { type: "noul", instructions: "Is this a health check?" } },
    });
    console.log(JSON.stringify({ provider: provider.name, reachable: true, model: result.model }, null, 2));
}

async function cmdAsk(args: CliArgs): Promise<void> {
    const provider = buildProvider(args.provider, args.model);
    const request: DecisionRequest = { state: args.state, questions: loadQuestions(args) };
    const result = await provider.decide(request);
    printResult(result, args.json);
}

function printResult(result: DecisionResult, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(`模型: ${result.model}  延迟: ${result.latencyMs}ms`);
    console.log(`用量: ${JSON.stringify(result.usage)}`);
    console.log(`答案: ${JSON.stringify(result.answers, null, 2)}`);
}

function printHelp(): void {
    console.log(`决策模型客户端

用法:
  decision-cli models [--provider liquid]
  decision-cli ask    --provider liquid --state "..." --questions-file q.json

模型优先级: --model > 各 provider 的 <PROVIDER>_MODEL（如 ${LIQUID_MODEL_ENV}）> provider 默认值
provider: ${Object.keys(PROVIDERS).join(" | ")}
密钥环境变量: LIQUID_API_KEY / TYPESAFE_API_KEY / JEVSTYLE_API_KEY / OPENROUTER_API_KEY`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    switch (args.command) {
        case "models": await cmdModels(args); break;
        case "ask": await cmdAsk(args); break;
        default: printHelp(); break;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
