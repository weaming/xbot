/**
 * 上游托管工具（web_search 等）的引用来源提取。
 *
 * Responses 把引用挂在 `output[].content[].annotations`，Chat 协议投影成
 * 消息级 `annotations`；同一条消息里按 URL 去重后交给 UI 渲染。
 */

import type { Citation } from "../../types/session.js";

/** 一条消息最多展示的引用数：够看清来源，又不至于把消息撑爆。 */
const MAX_CITATIONS = 12;

function removeOpenAITracking(url: string): string {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("utm_source")) return url;
        parsed.searchParams.delete("utm_source");
        return parsed.toString();
    } catch {
        return url;
    }
}

export function extractCitations(message: any): Citation[] {
    const citations: Citation[] = [];
    const seen = new Set<string>();

    const push = (annotation: any) => {
        const rawUrl = typeof annotation?.url === "string" ? annotation.url.trim() : "";
        const url = rawUrl ? removeOpenAITracking(rawUrl) : "";
        if (!url || seen.has(url)) return;
        seen.add(url);
        citations.push({
            url,
            ...(typeof annotation.title === "string" && annotation.title ? { title: annotation.title } : {}),
            ...(Number.isFinite(annotation.start_index) ? { startIndex: annotation.start_index } : {}),
            ...(Number.isFinite(annotation.end_index) ? { endIndex: annotation.end_index } : {}),
        });
    };

    // 托管搜索的来源：OpenAI 挂在 web_search_call.action.sources，部分兼容端用 results
    const pushSearchItem = (item: any) => {
        for (const list of [item?.action?.sources, item?.action?.results, item?.results]) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                if (typeof entry === "string") push({ url: entry });
                else if (entry && typeof entry === "object") push(entry);
            }
        }
    };

    const output = Array.isArray(message?.response_output) ? message.response_output : [];
    for (const item of output) {
        if (item?.type === "web_search_call") {
            pushSearchItem(item);
            continue;
        }
        if (item?.type !== "message") continue;
        for (const part of item.content ?? []) {
            for (const annotation of part?.annotations ?? []) push(annotation);
        }
    }

    for (const annotation of Array.isArray(message?.annotations) ? message.annotations : []) push(annotation);

    return citations.slice(0, MAX_CITATIONS);
}
