/** 会话图片：`<img>` 不能带 Authorization，先用 useAssetUrl 换成 blob URL。 */

import { useAssetUrl } from "../lib/use-asset";

export function AssetImage({ id, alt, className }: { id: string; alt?: string; className?: string }) {
    const url = useAssetUrl(id);
    if (!url) return <span className="rounded border border-border px-2 py-1 text-xs text-muted">图片加载中…</span>;
    return <img src={url} alt={alt ?? ""} className={className} />;
}
