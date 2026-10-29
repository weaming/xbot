/**
 * markdown 渲染块：AI 输出、评论、任务结果共用。
 *
 * 自带外层卡片（否则长文本直接摊在面板上，和周围元素分不开），
 * 右上角常驻复制按钮 —— 复制的是**原始 markdown**，不是渲染后的文本。
 */

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";

export function MarkdownBlock({ content, className }: { content: string; className?: string }) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            // 剪贴板不可用（非安全上下文）时静默失败，不打断阅读
        }
    };

    return (
        <div className={cn("group relative rounded-lg border border-border bg-panel", className)}>
            <div className="markdown max-w-full p-3 pr-14 text-sm break-words">
                <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
            <button
                type="button"
                onClick={() => void copy()}
                // 点击区要看得见：透明背景的小按钮，用户会以为"只有文字可点"，
                // 点偏了就是没反应。给一圈描边 + hover 底色，命中范围与视觉一致
                className="absolute top-1.5 right-1.5 z-10 rounded-md border border-transparent px-2 py-1 text-xs text-muted opacity-70 transition hover:border-border hover:bg-col hover:text-fg hover:opacity-100"
            >
                {copied ? "已复制" : "复制"}
            </button>
        </div>
    );
}
