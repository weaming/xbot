# 决策模型客户端

System One 风格决策模型的 TypeScript 客户端。输入 state + 带类型的问题，输出每个问题的标定概率，不做自回归生成（output tokens 恒为 0）。

## 端点

所有受支持服务共用同一请求/响应结构，仅 base URL 与模型名不同：

| provider | base URL | 默认模型 | 密钥环境变量 | 模型环境变量 |
|---|---|---|---|---|
| `liquid` | `https://api.liquid.ai` | `d1` | `LIQUID_API_KEY` | `LIQUID_MODEL` |
| `typesafe` | `https://api.typesafe.ai` | `jev-latest` | `TYPESAFE_API_KEY` | `TYPESAFE_MODEL` |
| `jevstyle` | `https://api.jevstyle.com` | `jev-style-2b-decision-v3` | `JEVSTYLE_API_KEY` | `JEVSTYLE_MODEL` |
| `mercury` | `https://openrouter.ai` | `inception/mercury-decide:free` | `OPENROUTER_API_KEY` | `MERCURY_MODEL` |

Mercury 走 OpenRouter 的 `/api/alpha/decisions`，其余走 `/decisions/v1/systemone`。

模型名优先级：显式参数 > 该 provider 的模型环境变量 > provider 默认值。

```bash
export LIQUID_MODEL=d1-ultra
```

## 用法

```ts
import { createLiquid } from "./decision/index.js";

// 模型由 LIQUID_MODEL 决定；也可用 { model: "d1-ultra" } 显式覆盖
const d1 = createLiquid();
const result = await d1.decide({
    state: { ticket: "payouts failing 3 days", plan: "pro" },
    questions: {
        team: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: { billing: "Payments", technical: "Bugs", sales: "Pricing" },
        },
        urgent: { type: "noul", instructions: "Does this convey urgency?" },
        severity: { type: "score", instructions: "How bad?", criteria: ["low", "mid", "high"] },
    },
});

result.answers.team;   // { type, choice, probabilities, confidence }
result.usage.cost;     // USD，服务端定价时给出
```

## 命令行

```bash
bun src/scripts/decision-cli.ts models --provider liquid

LIQUID_MODEL=d1-ultra bun src/scripts/decision-cli.ts ask --provider liquid \
    --state "payouts failing" --questions-file q.json
```

问题定义文件格式即 `questions` 字段的内容；只传单个问题时可用 `--question`。

## 约束

- `choice` 需 2-255 个选项，`score` 需 2-10 个档位，单请求最多 128 个问题。
- 图片输入仅 `d1` / `d1-ultra` 支持，最多 8 张、单张 5MB；按 32×32 像素块计费。
- 上下文：`d1` 65,536 tokens，`d1-ultra` 32,768 tokens，文本上限 250KB。
- 一个请求里问多个问题远比分开请求便宜：state 只计费一次。

## 重试

429 / 5xx / 网络错误按指数退避重试，429 优先遵循 `Retry-After`；401 / 404 / 422 立即抛出。默认重试 2 次、退避基数 800ms。
