/**
 * DeepSeek 官方模型价格表（单位：元 / 百万 tokens）。
 *
 * 价格按「生效时间」分段（snapshots，升序）：任一时间点取 effectiveFrom ≤ t 的最后一段，
 * 这样历史调用可按其发生时刻复盘，官方调价不会改写旧账。
 *
 * 数据来源：官方「模型 & 价格」页（sourceUrl）；官方页尚未更新而公告已生效的段，
 * 按开放平台公告先补录（段内 sourceUrl 指向公告）。由
 * `bun src/scripts/update-deepseek-pricing.ts` 核对同步，勿手工修改。
 */

/**
 * 价格档位。官方只区分 Flash 与 Pro 两档：
 * vision 系列（deepseek-v4-flash-vision-exp）与 flash 同价，归入 flash 档。
 */
export type DeepSeekModelKey = "flash" | "pro";

export interface DeepSeekPriceBand {
    /** 输入（缓存命中）元/百万 tokens */
    cacheHit: number;
    /** 输入（缓存未命中）元/百万 tokens */
    cacheMiss: number;
    /** 输出元/百万 tokens */
    output: number;
}

interface DeepSeekModelPrices {
    /** 空闲时段（高峰的一半） */
    offpeak: DeepSeekPriceBand;
    /** 高峰时段 */
    peak: DeepSeekPriceBand;
}

/** 某一生效期内各价格档的价格表 */
type DeepSeekModelTable = Record<DeepSeekModelKey, DeepSeekModelPrices>;

/** 一段生效期内的完整模型价格表 */
export interface DeepSeekPriceSnapshot {
    /** 生效时间（北京时间 ISO，含 +08:00）：此刻起（含）使用本段价格 */
    effectiveFrom: string;
    /** 本段价格出处（官方页 or 调价公告） */
    sourceUrl: string;
    models: DeepSeekModelTable;
}

export interface DeepSeekPricingTable {
    sourceUrl: string;
    fetchedAt: string;
    /** 高峰时段规则（北京时间，周一至周五），各段共用 */
    rule: {
        tz: string;
        weekdays: number[];
        /** 半开区间 [开始小时, 结束小时) */
        windows: Array<[number, number]>;
    };
    /** 按生效时间升序，至少一段；早于最早段的时间按最早段近似 */
    snapshots: DeepSeekPriceSnapshot[];
    /** 文档脚注原文（除价格外的计费说明） */
    notes: {
        visionTokens: string;
        discountRule: string;
        proRouting: string;
    };
}

const OFFICIAL_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const CHANGELOG_URL = "https://api-docs.deepseek.com/zh-cn/updates";

export const DEEPSEEK_PRICING: DeepSeekPricingTable = {
    sourceUrl: OFFICIAL_PRICING_URL,
    fetchedAt: "2026-09-10T12:32:09+08:00",
    rule: {
        tz: "Asia/Shanghai",
        weekdays: [1, 2, 3, 4, 5],
        windows: [
            [9, 12],
            [14, 18],
        ],
    },
    snapshots: [
        {
            // 2026-08-13 公告：V4 全系正式版上线并改用峰谷定价，自 08-17 00:00 起生效
            effectiveFrom: "2026-08-17T00:00:00+08:00",
            sourceUrl: CHANGELOG_URL,
            models: {
                flash: {
                    offpeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
                    peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
                },
                pro: {
                    offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
                    peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
                },
            },
        },
        {
            // 2026-09-09 公告：Flash 系列降价，自 09-10 12:00 起生效
            //（官方「模型 & 价格」页此刻仍为旧价，先按公告补录；页面更新后跑同步脚本核对）
            effectiveFrom: "2026-09-10T12:00:00+08:00",
            sourceUrl: CHANGELOG_URL,
            models: {
                flash: {
                    offpeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
                    peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
                },
                // 官方公告未调整 pro 单价（仅称 pro 请求会临时路由到 v4.1-flash 并按 flash 单价计费）
                pro: {
                    offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
                    peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
                },
            },
        },
    ],
    notes: {
        visionTokens:
            "发送给 deepseek-v4-flash-vision-exp 的图片会按其尺寸换算成 token，与文本 token 一并计费（见官方「图像理解：Token 用量」）；该模型与 Flash 同价，归入 flash 档计价。",
        discountRule: "空闲时段价格为高峰时段价格的一半；高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余为空闲时段。",
        proRouting:
            "2026-09-09 公告：V4.1 Flash 上线后至 V4.1 Pro 上线前，对 deepseek-v4-pro 的请求将被路由到 V4.1 Flash 并按 Flash 单价计费（临时策略，未列入价格页）。",
    },
};
